-- 내신대비 품질 계측 기반 — 요청 조건 저장 + 문항 유형 라벨 (감사 후속 ② P2/P1)
--
-- 왜: 요청 난이도·유형이 진단 JSON(ai_cost_log.metadata)에만 있고 DB 에 없어서
--     "임상형을 요청했을 때 실제로 임상형이 몇 % 나왔나", "상 을 요청했을 때 난이도 3 이
--     몇 % 인가", "검증(P1) 도입 후 폐기율이 얼마인가" 를 잴 수 없다. 측정할 수 없으면
--     이후 프롬프트 수정이 개선인지 증명할 방법이 없다. 여기서 재는 축을 DB 에 심는다.
--
-- 적용 방법 ⚠️ `supabase db push` 를 쓰지 말 것.
--     원격 마이그레이션 이력이 로컬 파일과 어긋나 있어(원격 22건 vs 로컬 44건)
--     push 는 이미 적용된 00017~00035 를 프로덕션에 재실행한다.
--     이 파일은 Supabase 대시보드 SQL Editor 에 붙여넣어 직접 실행한다.
--
-- 안전성: 전부 컬럼 추가(기본 null)라 기존 읽기·쓰기 경로에 영향이 없다. 멱등
--     (`if not exists`)이므로 재실행해도 무해하다.

-- ── 1) user_uploads: 이 생성 요청이 무엇을 요구했는가
alter table public.user_uploads
    -- 사용자가 고른 난이도('하'|'중'|'상'). 미지정이면 null.
    add column if not exists requested_difficulty text,
    -- 사용자가 고른 문항 유형(['지식형','임상형','이미지형'] 중 복수).
    add column if not exists requested_types text[],
    -- 생성 스타일('kmle'|'professor'|'internal').
    add column if not exists generation_style text,
    -- 기출 형식 참고자료로 함께 넘긴 업로드 개수.
    add column if not exists reference_count integer,
    -- 원본 파일 내용 해시. 같은 자료 재업로드 시 문항 복제 여부를 재는 축(P11).
    add column if not exists content_sha256 text,
    -- 사용자에게 전달할 경고(절삭·유형 미달 등). P8 에서 화면에 띄운다.
    add column if not exists notice jsonb;

-- 같은 자료 재업로드를 찾을 때 쓴다(사용자별).
create index if not exists idx_uploads_user_content_sha
    on public.user_uploads (user_id, content_sha256)
    where content_sha256 is not null;

-- 최근 N일 품질 측정 스크립트가 매번 훑는 축.
create index if not exists idx_uploads_created_at
    on public.user_uploads (created_at desc);

-- ── 2) private_questions: 만들어진 문항이 어떤 유형인가
alter table public.private_questions
    -- 저장 시점에 코드가 판정한 실제 유형. 요청 유형과 대조해 '수확률'을 낸다.
    --   image      = 문항에 그림이 붙었다
    --   clinical   = isClinicalVignette() 통과 (환자 도입 + 임상 정보 + 임상형 발문)
    --   knowledge  = 그 외
    add column if not exists kind text,
    -- 세부 발문 유형(진단/치료/검사/기전…). P3·R2 에서 채운다. 지금은 null.
    add column if not exists ask_kind text,
    -- P1 검증 1패스가 매긴 점수(0~1). 검증을 못 돌린 문항은 null.
    add column if not exists verify_score real;

do $$
begin
    alter table public.private_questions
        add constraint private_questions_kind_check
        check (kind is null or kind in ('knowledge', 'clinical', 'image'));
exception
    when duplicate_object then null;
end $$;

create index if not exists idx_private_q_upload_kind
    on public.private_questions (upload_id, kind);

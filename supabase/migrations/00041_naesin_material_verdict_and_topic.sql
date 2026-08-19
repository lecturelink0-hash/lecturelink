-- 내신대비 자료 판정 + 출제 초점 저장 (감사 후속 ② P6/P5)
--
-- 왜(P6): 비의학·기출 자료를 걸러내는 장치가 하나도 없었다. 감사에서 실증된 것:
--     · lecturelink-kakao-profile-v2.png(비의료 이미지)가 학습자료로 업로드됨
--     · 2026년도 제90회 의사 국가시험 1교시.pdf 가 업로드되어 기출 문항 10개가 그대로 재생성됨
--     추천 API 가 도구 호출 강제 + "가장 그럴듯한 값" 지시라 요리책에도 과목명을 붙였다.
--     이제 판정(의학 여부·자료 성격·확신도)을 남겨, 화면이 생성 전에 확인을 받고
--     기출이면 "참고 자료로 옮기기"를 권유한다. **차단은 하지 않는다** — 오탐으로 정상
--     강의록을 막는 쪽이 더 나쁘다. 강제 차단은 R6(콘텐츠 정책 게이트)에서 정한다.
--
-- 왜(P5): 화면의 '단원/주제'와 '핵심 키워드'가 요청에 실리지 않아 출제에 아무 영향이
--     없었다(#228 에서 문구만 "표시용"으로 정직하게 바꿔 둔 상태). 이제 실제로 싣고,
--     무엇을 요청했는지 남겨 "주제를 준 요청이 실제로 그 주제를 다뤘나"를 잴 수 있게 한다.
--
-- 적용 방법 ⚠️ `supabase db push` 를 쓰지 말 것.
--     원격 마이그레이션 이력이 로컬 파일과 어긋나 있어 push 는 이미 적용된 옛 파일을
--     프로덕션에 재실행한다. 이 파일은 Supabase 대시보드 SQL Editor 에 붙여넣어 직접 실행한다.
--
-- 안전성: 전부 컬럼 추가(기본 null)라 기존 읽기·쓰기 경로에 영향이 없다. 멱등
--     (`if not exists`)이므로 재실행해도 무해하다. 코드는 컬럼이 없어도 동작하도록
--     '컬럼 없음'(42703 / PGRST204) 폴백을 갖고 있어 적용 순서가 어긋나도 장애가 없다.

alter table public.user_uploads
    -- 추천 분석(P6)이 의학·보건 자료로 판단했는지. null = 아직 분석 전.
    add column if not exists is_medical boolean,
    -- 자료 성격: lecture | exam | notes | checklist | textbook | other.
    -- 'exam'(기출·족보)이면 화면이 참고 자료로 옮기기를 권유한다.
    add column if not exists material_kind text,
    -- 위 두 판정의 확신도 0~1. 낮으면 화면이 생성 전에 확인을 받는다.
    add column if not exists analyze_confidence real,
    -- 사용자가 지정한 출제 초점(P5). 생성 프롬프트에 실린다.
    add column if not exists requested_topic text,
    add column if not exists requested_keywords text[];

comment on column public.user_uploads.is_medical is
    '추천 분석(P6)의 의학 자료 판정. 차단이 아니라 확인·권유에만 쓴다.';
comment on column public.user_uploads.material_kind is
    '자료 성격(lecture|exam|notes|checklist|textbook|other). exam 은 기출·족보.';
comment on column public.user_uploads.analyze_confidence is
    '판정 확신도 0~1. 0.5 미만이면 화면이 생성 전에 확인을 받는다.';
comment on column public.user_uploads.requested_topic is
    '사용자가 지정한 단원/주제(P5). 생성 프롬프트의 출제 초점으로 쓰인다.';
comment on column public.user_uploads.requested_keywords is
    '사용자가 지정한 핵심 키워드(P5). 생성 프롬프트의 출제 초점으로 쓰인다.';

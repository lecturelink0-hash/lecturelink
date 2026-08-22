-- 00043: 강의자료 청크 저장 + 문항별 출처 (분담표 A8 · 가이드 §4.3·§12.2)
--
-- 분담표가 A8 을 "2단계 전체의 선행 조건" 으로 둔 이유:
--   지금은 생성된 문항이 강의자료 어디에서 나왔는지 아무 데도 적히지 않는다. 그래서
--   가이드가 대외 발표 최소 묶음에 넣은 "근거 충실도"·"자료 외 주장률"은 측정이 어려운
--   게 아니라 **비교할 출처가 저장되지 않아 잴 값 자체가 없다**.
--   또 이것 없이 전문가 검수를 시작하면 검수자가 "근거가 충분한가"를 판정할 때마다
--   강의자료 전체를 뒤져야 해서 검수 시간이 몇 배로 늘어난다.
--
-- 두 가지를 넣는다.
--   ① material_chunks — 자료를 슬라이드/문단 단위로 저장. 검수자가 원문을 바로 연다.
--   ② private_questions.source_refs — 문항마다 파일 해시·페이지·청크 id.
--      가이드 §12.2 가 예상문제 벤치마크 레코드의 필수 필드로 지정한 source_refs 다.
--
-- 구조적 출처(페이지가 실제로 있는가)는 자동 검사, 의미상 출처(그 내용이 근거인가)는
-- 전문가 검증이다. 코드가 하는 것은 전자뿐이며, 그 경계는 lib/ai/source-refs.ts 에 적어 뒀다.

create table if not exists public.material_chunks (
    id             uuid primary key default gen_random_uuid(),
    upload_id      uuid not null references public.user_uploads(id) on delete cascade,
    user_id        uuid not null references public.users(id) on delete cascade,
    -- 자료 안 순번(0-based). 결정론적으로 매겨진다 — 같은 자료를 다시 처리해도 같은 번호여야
    -- 이전에 저장된 문항의 출처가 끊기지 않는다.
    chunk_index    integer not null,
    -- 슬라이드/페이지 번호(1-based).
    page_index     integer not null,
    -- slide_text = 저자가 쓴 본문 / ocr = 그림 속 글자를 기계가 읽은 것.
    -- 출처의 성격이 달라 검수자가 구분할 수 있어야 한다(OCR 은 오독이 섞인다).
    kind           text not null check (kind in ('slide_text', 'ocr')),
    text           text not null,
    char_count     integer not null,
    -- 청크 내용 지문. 자료가 조용히 바뀌었는지 판정한다(가이드 §4.3).
    content_sha    text not null,
    created_at     timestamptz not null default now(),
    unique (upload_id, chunk_index)
);

create index if not exists idx_material_chunks_upload
    on public.material_chunks(upload_id, chunk_index);
-- 문항의 출처 페이지로 원문을 찾는 경로 — 검수 화면이 이 조회를 한다.
create index if not exists idx_material_chunks_page
    on public.material_chunks(upload_id, page_index);

-- 문항별 출처. {fileSha256, pages:[3,4], chunkIds:[...], invalidPages?:[...]}
-- jsonb 로 두는 이유: 검색 계층(A9)이 들어오면 청크 id 외에 top-K·리랭커 정보가 붙는다.
-- 그때마다 컬럼을 늘리면 마이그레이션이 계속 쌓인다.
alter table public.private_questions
    add column if not exists source_refs jsonb;

-- 출처가 없는 문항을 찾는 조회(근거 충실도 검수 대상 선별)가 전체 스캔이 되지 않게.
create index if not exists idx_private_questions_no_source
    on public.private_questions(upload_id)
    where source_refs is null;

-- 사용자는 자기 자료의 청크만 본다. 강의자료 본문이 들어 있으므로 남의 것이 보이면 안 된다.
alter table public.material_chunks enable row level security;

drop policy if exists material_chunks_owner_read on public.material_chunks;
create policy material_chunks_owner_read on public.material_chunks
    for select
    using (auth.uid() = user_id);

drop policy if exists material_chunks_admin_read on public.material_chunks;
create policy material_chunks_admin_read on public.material_chunks
    for select
    using (public.is_admin(auth.uid()));
-- 쓰기는 서비스 롤만 (생성 파이프라인이 admin client 로 넣는다) — 00008 ai_cost_log 와 같은 구조.

comment on table public.material_chunks is
    '강의자료의 슬라이드/문단 단위 원문. 문항 출처 추적과 전문가 근거 검수의 조회 대상 (분담표 A8).';
comment on column public.private_questions.source_refs is
    '문항이 나온 위치 — 파일 해시·페이지·청크 id (가이드 §12.2 source_refs).';

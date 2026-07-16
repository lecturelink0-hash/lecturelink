-- ──────────────────────────────────────────
-- private_question_images — 개인 문제에 연결된 의료 이미지
-- ──────────────────────────────────────────
-- 강의록 PDF 에서 검출·crop 한 의료 이미지(EKG, X-ray, CT, 해부도 등)를
-- Storage(user_uploads 버킷)에 저장하고 생성된 문제에 연결한다.
-- 한 문제에 여러 이미지(EKG+CXR 비교, CT 다중 slice, gross+micro 등)가
-- 가능하도록 1:N 연결 테이블로 둔다.
-- 풀이 화면은 storage_path 로 signed URL 을 만들어 렌더링한다.

create table public.private_question_images (
    id                  uuid primary key default uuid_generate_v4(),
    private_question_id uuid not null references public.private_questions(id) on delete cascade,
    user_id             uuid not null references public.users(id) on delete cascade,
    upload_id           uuid not null references public.user_uploads(id) on delete cascade,
    storage_path        text not null,
    source_page         integer,
    kind                text,
    caption             text,
    sort_order          smallint not null default 0,
    created_at          timestamptz not null default now()
);

create index idx_pq_images_question
    on public.private_question_images(private_question_id, sort_order);
create index idx_pq_images_upload
    on public.private_question_images(upload_id);

comment on table public.private_question_images is
    '개인 문제(private_questions)에 연결된 의료 이미지. Storage(user_uploads 버킷) 경로 참조.';

-- RLS — 본인 것만 (private_questions 정책과 동일 패턴)
alter table public.private_question_images enable row level security;

create policy "pq_images_read_own" on public.private_question_images
    for select using (auth.uid() = user_id);

create policy "pq_images_insert_own" on public.private_question_images
    for insert with check (auth.uid() = user_id);

create policy "pq_images_delete_own" on public.private_question_images
    for delete using (auth.uid() = user_id);

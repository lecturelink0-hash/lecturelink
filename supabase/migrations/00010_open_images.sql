-- ============================================
-- 00010_open_images.sql
--
-- 오픈 라이선스 의료 이미지 풀.
-- 인제스트는 admin 만, 사용은 모든 인증 사용자.
-- 라이선스 자동 표기를 위해 attribution_text/license/original_url 필수.
-- ============================================

do $$ begin
    create type open_image_source as enum (
        'roco_v2',
        'nih_chestxray14',
        'pmc_open_access',
        'wikipedia_commons',
        'manual_upload'
    );
exception when duplicate_object then null; end $$;

do $$ begin
    create type open_image_license as enum (
        'cc0',
        'cc_by',
        'cc_by_sa',
        'public_domain',
        'pmc_oa',
        'nih_open_access'
    );
exception when duplicate_object then null; end $$;

create table if not exists public.open_images (
    id                uuid primary key default uuid_generate_v4(),
    source            open_image_source not null,
    source_id         text not null,                       -- 원본 데이터셋 내 ID
    modality          medical_image_type not null,         -- 기존 enum 재사용
    sub_topic_id      uuid references public.sub_topics(id) on delete set null,
    license           open_image_license not null,
    attribution_text  text not null,                       -- "Smith et al. (2019), PMC1234567" 같은 인용
    original_url      text not null,                       -- 원본 페이지 URL (표기 의무)
    storage_path      text,                                -- Supabase Storage 내 사본 경로 (선택)
    caption           text,
    keywords          text[],
    embedding         vector(1024),
    width_px          integer,
    height_px         integer,
    file_size_bytes   integer,
    ingested_at       timestamptz not null default now(),
    ingested_by       uuid references public.users(id) on delete set null,
    is_active         boolean not null default true,       -- 라이선스 분쟁 시 false 로 즉시 비활성화

    unique (source, source_id)
);

create index if not exists idx_open_images_modality_active
    on public.open_images(modality, is_active)
    where is_active = true;

create index if not exists idx_open_images_sub_topic
    on public.open_images(sub_topic_id)
    where sub_topic_id is not null and is_active = true;

-- pgvector HNSW
create index if not exists idx_open_images_embedding
    on public.open_images
    using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64);

-- RLS
alter table public.open_images enable row level security;

-- 인증된 사용자는 활성 이미지만 read
create policy "open_images_read_active"
    on public.open_images
    for select
    using (auth.role() = 'authenticated' and is_active = true);

-- 쓰기는 admin 전용
create policy "open_images_admin_write"
    on public.open_images
    for all
    using (public.is_admin(auth.uid()))
    with check (public.is_admin(auth.uid()));

-- questions 에 open_image 출처 추적 (FK)
alter table public.questions
    add column if not exists open_image_id uuid references public.open_images(id) on delete set null;

create index if not exists idx_questions_open_image
    on public.questions(open_image_id)
    where open_image_id is not null;

-- 유사 이미지 검색 RPC
create or replace function public.match_open_images(
    query_embedding vector(1024),
    match_threshold float default 0.85,
    match_count int default 5,
    modality_filter medical_image_type default null,
    sub_topic_filter uuid[] default null
)
returns table (
    id uuid,
    similarity float,
    modality medical_image_type,
    sub_topic_id uuid,
    caption text,
    original_url text,
    attribution_text text,
    license open_image_license
)
language sql
stable
as $$
    select
        oi.id,
        1 - (oi.embedding <=> query_embedding) as similarity,
        oi.modality,
        oi.sub_topic_id,
        oi.caption,
        oi.original_url,
        oi.attribution_text,
        oi.license
    from public.open_images oi
    where oi.is_active = true
      and oi.embedding is not null
      and 1 - (oi.embedding <=> query_embedding) >= match_threshold
      and (modality_filter is null or oi.modality = modality_filter)
      and (sub_topic_filter is null or oi.sub_topic_id = any(sub_topic_filter))
    order by oi.embedding <=> query_embedding
    limit match_count;
$$;

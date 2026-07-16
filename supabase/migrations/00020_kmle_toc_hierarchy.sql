-- ====================================================================
-- 00020_kmle_toc_hierarchy.sql
-- 국시 KMLE 목차 반영 — sub_topics 3단계 계층화
--   과목(subjects) > 중주제(sub_topics level=1) > 소주제(sub_topics level=2)
-- ====================================================================

-- sub_topics 에 self-reference parent_id + level
alter table public.sub_topics
  add column if not exists parent_id uuid references public.sub_topics(id) on delete cascade,
  add column if not exists level     smallint not null default 1;

create index if not exists idx_sub_topics_parent on public.sub_topics(parent_id);
create index if not exists idx_sub_topics_subject_level on public.sub_topics(subject_id, level);

-- subjects 에 대분류 카테고리 (예: '내분비 · 알레르기')
alter table public.subjects
  add column if not exists category text;

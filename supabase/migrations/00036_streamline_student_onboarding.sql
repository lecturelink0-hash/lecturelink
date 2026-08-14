-- Keep onboarding focused on the information needed before a student's first session.
alter type public.study_purpose add value if not exists 'cpx';

alter table public.users
  add column if not exists study_purpose_detail text;

alter table public.users
  drop constraint if exists users_study_purpose_detail_length;

alter table public.users
  add constraint users_study_purpose_detail_length
  check (study_purpose_detail is null or char_length(study_purpose_detail) <= 100);

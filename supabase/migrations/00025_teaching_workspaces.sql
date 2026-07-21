create type public.course_status as enum ('draft', 'active', 'archived');
create type public.artifact_type as enum ('formative', 'preview', 'material_review');
create type public.artifact_status as enum ('draft', 'review', 'approved', 'published');
create type public.attempt_status as enum ('in_progress', 'submitted');

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  professor_id uuid not null references public.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  term text,
  status public.course_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.course_members (
  course_id uuid not null references public.courses(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (course_id, student_id)
);

create table public.learning_artifacts (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  created_by uuid not null references public.users(id),
  type public.artifact_type not null,
  title text not null,
  status public.artifact_status not null default 'draft',
  source_name text,
  summary text,
  objectives jsonb not null default '[]'::jsonb,
  content jsonb not null default '{}'::jsonb,
  approved_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.formative_items (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.learning_artifacts(id) on delete cascade,
  position integer not null check (position >= 0),
  stem text not null,
  choices jsonb not null,
  answer_index integer not null check (answer_index >= 0),
  explanation text not null default '',
  objective text not null default '',
  source_pages jsonb not null default '[]'::jsonb,
  cognitive_level text,
  quality_flags jsonb not null default '[]'::jsonb,
  approved boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (artifact_id, position)
);

create table public.artifact_publications (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null unique references public.learning_artifacts(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  published_by uuid not null references public.users(id),
  is_open boolean not null default true,
  published_at timestamptz not null default now()
);

create table public.formative_attempts (
  id uuid primary key default gen_random_uuid(),
  publication_id uuid not null references public.artifact_publications(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  status public.attempt_status not null default 'in_progress',
  score integer,
  total integer,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  unique (publication_id, student_id)
);

create table public.formative_answers (
  attempt_id uuid not null references public.formative_attempts(id) on delete cascade,
  item_id uuid not null references public.formative_items(id) on delete cascade,
  selected_index integer not null,
  is_correct boolean not null,
  answered_at timestamptz not null default now(),
  primary key (attempt_id, item_id)
);

create index idx_courses_professor on public.courses(professor_id);
create index idx_artifacts_course on public.learning_artifacts(course_id, created_at desc);
create index idx_items_artifact on public.formative_items(artifact_id, position);
create index idx_attempts_publication on public.formative_attempts(publication_id, status);

alter table public.courses enable row level security;
alter table public.course_members enable row level security;
alter table public.learning_artifacts enable row level security;
alter table public.formative_items enable row level security;
alter table public.artifact_publications enable row level security;
alter table public.formative_attempts enable row level security;
alter table public.formative_answers enable row level security;

create or replace function public.owns_course(check_course_id uuid, check_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.courses where id=check_course_id and professor_id=check_user_id);
$$;
create or replace function public.is_course_member(check_course_id uuid, check_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.course_members where course_id=check_course_id and student_id=check_user_id);
$$;
create or replace function public.can_access_publication(check_publication_id uuid, check_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path=public as $$
  select exists(select 1 from public.artifact_publications p where p.id=check_publication_id and p.is_open and public.is_course_member(p.course_id,check_user_id));
$$;
revoke all on function public.owns_course(uuid,uuid) from public;
revoke all on function public.is_course_member(uuid,uuid) from public;
grant execute on function public.owns_course(uuid,uuid), public.is_course_member(uuid,uuid) to authenticated, service_role;
revoke all on function public.can_access_publication(uuid,uuid) from public;
grant execute on function public.can_access_publication(uuid,uuid) to authenticated, service_role;

create policy courses_professor_all on public.courses for all to authenticated
  using (professor_id = auth.uid() and public.is_professor())
  with check (professor_id = auth.uid() and public.is_professor());
create policy courses_student_read on public.courses for select to authenticated
  using (public.is_course_member(id));

create policy members_professor_all on public.course_members for all to authenticated
  using (public.owns_course(course_id) and public.is_professor())
  with check (public.owns_course(course_id) and public.is_professor());
create policy members_student_read on public.course_members for select to authenticated using (student_id = auth.uid());

create policy artifacts_professor_all on public.learning_artifacts for all to authenticated
  using (public.owns_course(course_id) and public.is_professor())
  with check (public.owns_course(course_id) and created_by = auth.uid() and public.is_professor());
create policy artifacts_student_published on public.learning_artifacts for select to authenticated
  using (status = 'published' and public.is_course_member(course_id));

create policy items_professor_all on public.formative_items for all to authenticated
  using (exists (select 1 from public.learning_artifacts a join public.courses c on c.id=a.course_id where a.id=artifact_id and c.professor_id=auth.uid()) and public.is_professor())
  with check (exists (select 1 from public.learning_artifacts a join public.courses c on c.id=a.course_id where a.id=artifact_id and c.professor_id=auth.uid()) and public.is_professor());
create policy items_student_approved on public.formative_items for select to authenticated
  using (approved and exists (select 1 from public.learning_artifacts a join public.course_members m on m.course_id=a.course_id where a.id=artifact_id and a.status='published' and m.student_id=auth.uid()));

create policy publications_professor_all on public.artifact_publications for all to authenticated
  using (public.owns_course(course_id) and public.is_professor())
  with check (published_by=auth.uid() and public.owns_course(course_id) and public.is_professor());
create policy publications_student_read on public.artifact_publications for select to authenticated
  using (is_open and public.is_course_member(course_id));

create policy attempts_student_all on public.formative_attempts for all to authenticated
  using (student_id=auth.uid() and public.can_access_publication(publication_id))
  with check (student_id=auth.uid() and public.can_access_publication(publication_id));
create policy attempts_professor_read on public.formative_attempts for select to authenticated
  using (exists (select 1 from public.artifact_publications p join public.courses c on c.id=p.course_id where p.id=publication_id and c.professor_id=auth.uid()) and public.is_professor());
create policy answers_student_all on public.formative_answers for all to authenticated
  using (exists (select 1 from public.formative_attempts a where a.id=attempt_id and a.student_id=auth.uid()))
  with check (exists (select 1 from public.formative_attempts a where a.id=attempt_id and a.student_id=auth.uid()));
create policy answers_professor_read on public.formative_answers for select to authenticated
  using (exists (select 1 from public.formative_attempts a join public.artifact_publications p on p.id=a.publication_id join public.courses c on c.id=p.course_id where a.id=attempt_id and c.professor_id=auth.uid()) and public.is_professor());

create or replace function public.validate_formative_answer()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if not exists (select 1 from public.formative_attempts a join public.artifact_publications p on p.id=a.publication_id join public.formative_items i on i.artifact_id=p.artifact_id where a.id=new.attempt_id and i.id=new.item_id and i.approved)
  then raise exception 'item does not belong to publication' using errcode='23514'; end if;
  return new;
end;
$$;
create trigger trg_validate_formative_answer before insert or update on public.formative_answers for each row execute function public.validate_formative_answer();

create or replace function public.join_course(join_code text)
returns uuid language plpgsql security definer set search_path=public as $$
declare target_id uuid;
begin
  if not public.is_student() then raise exception 'student account required' using errcode='42501'; end if;
  select id into target_id from public.courses where code=upper(trim(join_code)) and status='active';
  if target_id is null then raise exception 'course not found' using errcode='P0002'; end if;
  insert into public.course_members(course_id, student_id) values(target_id, auth.uid()) on conflict do nothing;
  return target_id;
end;
$$;
grant execute on function public.join_course(text) to authenticated;

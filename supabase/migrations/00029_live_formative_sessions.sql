create type public.live_assessment_status as enum ('lobby', 'live', 'ended');

create table public.live_assessment_sessions (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references public.learning_artifacts(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete cascade,
  professor_id uuid not null references public.users(id) on delete cascade,
  title text not null,
  join_code text not null unique check (join_code ~ '^[A-Z0-9]{6}$'),
  status public.live_assessment_status not null default 'lobby',
  question_snapshot jsonb not null,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.live_assessment_participants (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.live_assessment_sessions(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  access_token_hash text not null unique,
  status text not null default 'waiting' check (status in ('waiting','active','submitted','removed')),
  auto_submitted boolean not null default false,
  score integer,
  total integer,
  joined_at timestamptz not null default now(),
  submitted_at timestamptz
);

create table public.live_assessment_answers (
  participant_id uuid not null references public.live_assessment_participants(id) on delete cascade,
  item_id uuid not null,
  selected_index integer not null check (selected_index >= 0),
  is_correct boolean,
  answered_at timestamptz not null default now(),
  primary key (participant_id, item_id)
);

create index idx_live_sessions_professor on public.live_assessment_sessions(professor_id, created_at desc);
create index idx_live_participants_session on public.live_assessment_participants(session_id, status);
create index idx_live_answers_participant on public.live_assessment_answers(participant_id);

alter table public.live_assessment_sessions enable row level security;
alter table public.live_assessment_participants enable row level security;
alter table public.live_assessment_answers enable row level security;

create policy live_sessions_professor on public.live_assessment_sessions for all to authenticated
  using (professor_id = auth.uid() and public.is_professor())
  with check (professor_id = auth.uid() and public.is_professor());
create policy live_participants_professor_read on public.live_assessment_participants for select to authenticated
  using (exists(select 1 from public.live_assessment_sessions s where s.id=session_id and s.professor_id=auth.uid()) and public.is_professor());
create policy live_answers_professor_read on public.live_assessment_answers for select to authenticated
  using (exists(select 1 from public.live_assessment_participants p join public.live_assessment_sessions s on s.id=p.session_id where p.id=participant_id and s.professor_id=auth.uid()) and public.is_professor());

alter publication supabase_realtime add table public.live_assessment_sessions;
alter publication supabase_realtime add table public.live_assessment_participants;
alter publication supabase_realtime add table public.live_assessment_answers;

create or replace function public.finish_live_assessment(target_session uuid)
returns void language plpgsql security definer set search_path=public as $$
declare q jsonb;
begin
  if not exists(select 1 from live_assessment_sessions where id=target_session and professor_id=auth.uid()) then
    raise exception 'not allowed' using errcode='42501';
  end if;
  select question_snapshot into q from live_assessment_sessions where id=target_session for update;
  if (select status from live_assessment_sessions where id=target_session)='ended' then return; end if;
  update live_assessment_sessions set status='ended', ended_at=now() where id=target_session;
  update live_assessment_answers a set is_correct=(a.selected_index=(x.value->>'answerIndex')::int)
    from live_assessment_participants p, jsonb_array_elements(q) x
    where p.session_id=target_session and a.participant_id=p.id and a.item_id=(x.value->>'id')::uuid;
  update live_assessment_participants p set
    status='submitted', auto_submitted=(status<>'submitted'), submitted_at=coalesce(submitted_at,now()),
    total=jsonb_array_length(q), score=(select count(*) from live_assessment_answers a where a.participant_id=p.id and a.is_correct)
    where p.session_id=target_session and p.status<>'removed';
end $$;
revoke all on function public.finish_live_assessment(uuid) from public;
grant execute on function public.finish_live_assessment(uuid) to authenticated, service_role;

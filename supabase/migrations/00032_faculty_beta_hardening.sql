-- Faculty beta hardening: atomic formative saves and public live-session join limits.

-- Internal cron queue: browser clients must never be able to read or mutate it.
alter table public.cohort_score_recalc_queue enable row level security;
revoke all on table public.cohort_score_recalc_queue from public, anon, authenticated;

create table if not exists public.live_assessment_join_limits (
  rate_key text primary key,
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 1 check (attempt_count > 0),
  updated_at timestamptz not null default now()
);

alter table public.live_assessment_join_limits enable row level security;
revoke all on table public.live_assessment_join_limits from public, anon, authenticated;

create or replace function public.consume_live_assessment_join_attempt(
  target_key text,
  window_seconds integer default 60,
  maximum_attempts integer default 10
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed boolean;
begin
  if target_key is null or length(target_key) < 16 then
    return false;
  end if;
  if window_seconds < 1 or maximum_attempts < 1 then
    return false;
  end if;

  insert into public.live_assessment_join_limits as limits (
    rate_key,
    window_started_at,
    attempt_count,
    updated_at
  ) values (target_key, now(), 1, now())
  on conflict (rate_key) do update set
    window_started_at = case
      when limits.window_started_at <= now() - make_interval(secs => window_seconds)
        then now()
      else limits.window_started_at
    end,
    attempt_count = case
      when limits.window_started_at <= now() - make_interval(secs => window_seconds)
        then 1
      else limits.attempt_count + 1
    end,
    updated_at = now()
  returning attempt_count <= maximum_attempts into allowed;

  return allowed;
end;
$$;

revoke all on function public.consume_live_assessment_join_attempt(text, integer, integer) from public;
grant execute on function public.consume_live_assessment_join_attempt(text, integer, integer) to service_role;

create or replace function public.join_live_assessment(
  target_session uuid,
  target_name text,
  target_token_hash text,
  maximum_participants integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  session_status text;
  participant_id uuid;
begin
  -- Locking the session row serializes concurrent joins, so capacity and
  -- duplicate-name checks cannot race each other.
  select status into session_status
  from public.live_assessment_sessions
  where id = target_session
  for update;

  if session_status is null then return jsonb_build_object('error', 'not_found'); end if;
  if session_status <> 'lobby' then return jsonb_build_object('error', 'closed'); end if;
  if maximum_participants < 1 then return jsonb_build_object('error', 'session_full'); end if;
  if (
    select count(*) from public.live_assessment_participants
    where session_id = target_session and status <> 'removed'
  ) >= maximum_participants then
    return jsonb_build_object('error', 'session_full');
  end if;
  if exists (
    select 1 from public.live_assessment_participants
    where session_id = target_session
      and lower(name) = lower(trim(target_name))
      and status <> 'removed'
  ) then
    return jsonb_build_object('error', 'duplicate_name');
  end if;

  insert into public.live_assessment_participants (session_id, name, access_token_hash)
  values (target_session, trim(target_name), target_token_hash)
  returning id into participant_id;
  return jsonb_build_object('participant_id', participant_id);
end;
$$;

revoke all on function public.join_live_assessment(uuid, text, text, integer) from public;
grant execute on function public.join_live_assessment(uuid, text, text, integer) to service_role;

create or replace function public.save_formative_artifact(
  target_artifact uuid,
  target_title text,
  target_items jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if target_title is null or length(trim(target_title)) = 0 then
    raise exception 'title required' using errcode = '22023';
  end if;
  if target_items is null or jsonb_typeof(target_items) <> 'array' or jsonb_array_length(target_items) = 0 then
    raise exception 'items required' using errcode = '22023';
  end if;
  if not exists (
    select 1
    from public.learning_artifacts a
    join public.courses c on c.id = a.course_id
    where a.id = target_artifact and c.professor_id = auth.uid()
  ) then
    raise exception 'artifact not found' using errcode = '42501';
  end if;

  update public.learning_artifacts
  set title = trim(target_title), status = 'approved', approved_at = now()
  where id = target_artifact;

  -- Reordering two existing rows would otherwise collide with the immediate
  -- unique (artifact_id, position) constraint during the upsert.
  update public.formative_items
  set position = position + 1000000
  where artifact_id = target_artifact;

  insert into public.formative_items (
    id, artifact_id, position, stem, choices, answer_index,
    explanation, objective, approved, updated_at
  )
  select
    (item->>'id')::uuid,
    target_artifact,
    ordinality - 1,
    item->>'stem',
    item->'choices',
    (item->>'answerIndex')::integer,
    coalesce(item->>'explanation', ''),
    coalesce(item->>'objective', ''),
    true,
    now()
  from jsonb_array_elements(target_items) with ordinality as entries(item, ordinality)
  on conflict (id) do update set
    position = excluded.position,
    stem = excluded.stem,
    choices = excluded.choices,
    answer_index = excluded.answer_index,
    explanation = excluded.explanation,
    objective = excluded.objective,
    approved = true,
    updated_at = now()
  where formative_items.artifact_id = target_artifact;

  delete from public.formative_items
  where artifact_id = target_artifact
    and id not in (
      select (item->>'id')::uuid
      from jsonb_array_elements(target_items) as entries(item)
    );
end;
$$;

revoke all on function public.save_formative_artifact(uuid, text, jsonb) from public;
grant execute on function public.save_formative_artifact(uuid, text, jsonb) to authenticated, service_role;

create or replace function public.start_live_assessment(target_session uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.live_assessment_sessions
    where id = target_session and professor_id = auth.uid() and status = 'lobby'
  ) then
    raise exception 'session not available' using errcode = '42501';
  end if;

  update public.live_assessment_sessions
  set status = 'live', started_at = now()
  where id = target_session and professor_id = auth.uid() and status = 'lobby';

  update public.live_assessment_participants
  set status = 'active'
  where session_id = target_session and status = 'waiting';
end;
$$;

revoke all on function public.start_live_assessment(uuid) from public;
grant execute on function public.start_live_assessment(uuid) to authenticated, service_role;

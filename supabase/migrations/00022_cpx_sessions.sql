-- CPX 실습: 로그인 사용자별 세션·전사·신체진찰·채점 결과 보관.
-- external_session_id는 CPX patient engine의 opaque ID이며, 브라우저에는 노출하지 않는다.

create table if not exists public.cpx_sessions (
    id                  uuid primary key default gen_random_uuid(),
    user_id             uuid not null references public.users(id) on delete cascade,
    external_session_id text not null unique,
    case_id             text not null,
    persona             jsonb not null default '{}'::jsonb,
    status              text not null default 'active' check (status in ('active', 'ended')),
    result              jsonb,
    started_at          timestamptz not null default now(),
    ended_at            timestamptz,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create table if not exists public.cpx_transcript_events (
    id                  bigint generated always as identity primary key,
    user_id             uuid not null references public.users(id) on delete cascade,
    session_id          uuid not null references public.cpx_sessions(id) on delete cascade,
    role                text not null check (role in ('student', 'patient', 'system')),
    text                text not null,
    t_offset_ms         integer not null check (t_offset_ms >= 0),
    created_at          timestamptz not null default now()
);

create table if not exists public.cpx_physical_exam_events (
    id                  bigint generated always as identity primary key,
    user_id             uuid not null references public.users(id) on delete cascade,
    session_id          uuid not null references public.cpx_sessions(id) on delete cascade,
    button_id           text not null,
    t_offset_ms         integer not null check (t_offset_ms >= 0),
    result              jsonb not null default '{}'::jsonb,
    created_at          timestamptz not null default now()
);

create index if not exists idx_cpx_sessions_user_created
    on public.cpx_sessions(user_id, created_at desc);
create index if not exists idx_cpx_transcript_session_offset
    on public.cpx_transcript_events(session_id, t_offset_ms, id);
create index if not exists idx_cpx_exam_session_offset
    on public.cpx_physical_exam_events(session_id, t_offset_ms, id);

alter table public.cpx_sessions enable row level security;
alter table public.cpx_transcript_events enable row level security;
alter table public.cpx_physical_exam_events enable row level security;

drop policy if exists "cpx_sessions_own" on public.cpx_sessions;
create policy "cpx_sessions_own" on public.cpx_sessions
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "cpx_transcript_events_own" on public.cpx_transcript_events;
create policy "cpx_transcript_events_own" on public.cpx_transcript_events
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "cpx_physical_exam_events_own" on public.cpx_physical_exam_events;
create policy "cpx_physical_exam_events_own" on public.cpx_physical_exam_events
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

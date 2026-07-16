-- ============================================
-- 00008_admin_role_and_cost_cap.sql
--
-- P0-2: users.role 컬럼 + admin 가드용 헬퍼 함수
-- P0-3: ai_cost_log 테이블 + 일일 비용 캡 RPC
-- P0-6: requireQuota 보조 RPC (사전 체크용)
-- Day2-am: payments.subscription_id FK (최소 마이그레이션)
-- ============================================

-- ──────────────────────────────────────────
-- (1) 사용자 역할 (admin / user)
-- ──────────────────────────────────────────
do $$ begin
    create type user_role as enum ('user', 'admin');
exception when duplicate_object then null; end $$;

alter table public.users
    add column if not exists role user_role not null default 'user';

create index if not exists idx_users_role on public.users(role) where role = 'admin';

-- 현재 사용자가 admin 인지 확인
create or replace function public.is_admin(user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select role = 'admin' from public.users where id = user_id), false);
$$;

-- ──────────────────────────────────────────
-- (2) AI 비용 로그 + 일일 캡
-- ──────────────────────────────────────────
create table if not exists public.ai_cost_log (
    id           uuid primary key default uuid_generate_v4(),
    user_id      uuid references public.users(id) on delete set null,
    endpoint     text not null,        -- 'questions.generate', 'uploads.process' 등
    model        text not null,
    cost_usd     numeric(10, 6) not null,
    input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    metadata     jsonb,
    created_at   timestamptz not null default now()
);

create index if not exists idx_ai_cost_log_created_at on public.ai_cost_log(created_at desc);
create index if not exists idx_ai_cost_log_user_date on public.ai_cost_log(user_id, created_at desc);

-- 일일 누적 비용 (UTC 기준 자정)
create or replace function public.daily_ai_cost_usd()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(sum(cost_usd), 0)
    from public.ai_cost_log
    where created_at >= date_trunc('day', now() at time zone 'utc');
$$;

-- 일일 캡 체크 — 환경변수 MAX_DAILY_AI_COST_USD 와 비교는 앱 레이어에서
-- (Postgres 에서 env var 읽는 건 안티패턴이라 RPC 는 누적치만 반환)
create or replace function public.check_daily_cost_within(threshold_usd numeric)
returns table(within_cap boolean, current_usd numeric, threshold numeric)
language sql
stable
security definer
set search_path = public
as $$
    select
        coalesce(sum(cost_usd), 0) < threshold_usd as within_cap,
        coalesce(sum(cost_usd), 0) as current_usd,
        threshold_usd as threshold
    from public.ai_cost_log
    where created_at >= date_trunc('day', now() at time zone 'utc');
$$;

-- RLS — admin 만 조회 가능
alter table public.ai_cost_log enable row level security;

create policy "ai_cost_log_admin_read"
    on public.ai_cost_log
    for select
    using (public.is_admin(auth.uid()));

-- 서비스 롤은 RLS 우회 (admin client 가 insert 함)

-- ──────────────────────────────────────────
-- (3) payments.subscription_id FK (최소)
-- ──────────────────────────────────────────
alter table public.payments
    add column if not exists subscription_id uuid references public.subscriptions(id) on delete set null;

create index if not exists idx_payments_subscription on public.payments(subscription_id);

comment on column public.payments.subscription_id is
    '결제와 연결된 구독 ID. 구독 결제(initial/renewal)만 채워짐. 환불 시 정확한 구독 식별용.';

-- ──────────────────────────────────────────
-- (4) upload_status 에 'queued' 추가 (P1-A9 큐화)
-- ──────────────────────────────────────────
do $$ begin
    alter type upload_status add value if not exists 'queued' before 'processing';
exception when others then null; end $$;

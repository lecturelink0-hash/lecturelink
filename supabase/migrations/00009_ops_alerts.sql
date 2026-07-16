-- ============================================
-- 00009_ops_alerts.sql
--
-- 운영 알림 큐 (webhook 서명 실패, queue dead, cost cap 근접 등)
-- ============================================

do $$ begin
    create type alert_severity as enum ('low', 'medium', 'high', 'critical');
exception when duplicate_object then null; end $$;

create table if not exists public.ops_alerts (
    id          uuid primary key default uuid_generate_v4(),
    severity    alert_severity not null,
    source      text not null,
    message     text not null,
    payload     jsonb,
    resolved_at timestamptz,
    created_at  timestamptz not null default now()
);

create index if not exists idx_ops_alerts_unresolved
    on public.ops_alerts(created_at desc)
    where resolved_at is null;

create index if not exists idx_ops_alerts_severity
    on public.ops_alerts(severity, created_at desc)
    where resolved_at is null;

alter table public.ops_alerts enable row level security;

create policy "ops_alerts_admin_only"
    on public.ops_alerts
    for all
    using (public.is_admin(auth.uid()))
    with check (public.is_admin(auth.uid()));

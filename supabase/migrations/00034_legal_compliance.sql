-- Legal consent evidence and statutory retention controls.

create table public.legal_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  subject_reference text,
  document_type text not null check (document_type in (
    'terms', 'privacy_notice', 'cpx_processing_notice', 'live_assessment_privacy'
  )),
  document_version text not null,
  action text not null check (action in ('accepted', 'acknowledged')),
  source text not null,
  evidence jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  retain_until timestamptz not null default (now() + interval '3 years')
);
create index idx_legal_consents_user on public.legal_consents(user_id, recorded_at desc);
create index idx_legal_consents_retention on public.legal_consents(retain_until);

alter table public.legal_consents enable row level security;
create policy legal_consents_read_own on public.legal_consents for select to authenticated
  using (user_id = auth.uid());

create or replace function public.record_initial_legal_notices()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  terms_version text := nullif(new.raw_user_meta_data->>'terms_version', '');
  privacy_version text := nullif(new.raw_user_meta_data->>'privacy_notice_version', '');
begin
  if terms_version is not null then
    insert into public.legal_consents (
      user_id, subject_reference, document_type, document_version, action, source, evidence
    ) values (
      new.id, new.id::text, 'terms', terms_version, 'accepted',
      coalesce(new.raw_user_meta_data->>'provider', 'email'),
      jsonb_build_object('client_recorded_at', new.raw_user_meta_data->>'terms_accepted_at')
    );
  end if;

  if privacy_version is not null then
    insert into public.legal_consents (
      user_id, subject_reference, document_type, document_version, action, source, evidence
    ) values (
      new.id, new.id::text, 'privacy_notice', privacy_version, 'acknowledged',
      coalesce(new.raw_user_meta_data->>'provider', 'email'),
      jsonb_build_object('client_recorded_at', new.raw_user_meta_data->>'privacy_noticed_at')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_record_legal_notices on auth.users;
create trigger on_auth_user_record_legal_notices
  after insert on auth.users
  for each row execute function public.record_initial_legal_notices();

-- Records isolated from the live account graph. Only service-role code can access them.
create table public.legal_retention_records (
  id uuid primary key default gen_random_uuid(),
  subject_reference uuid not null,
  category text not null check (category in ('payment', 'subscription')),
  source_id uuid not null,
  record jsonb not null,
  created_at timestamptz not null default now(),
  retain_until timestamptz not null,
  unique(category, source_id)
);

create index idx_legal_retention_expiry on public.legal_retention_records(retain_until);
alter table public.legal_retention_records enable row level security;

create or replace function public.archive_account_transaction_records()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.legal_retention_records (
    subject_reference, category, source_id, record, retain_until
  )
  select old.id, 'payment', p.id,
    jsonb_build_object(
      'kind', p.kind, 'status', p.status, 'amount_krw', p.amount_krw,
      'plan_tier', p.plan_tier, 'credit_amount', p.credit_amount,
      'toss_order_id', p.toss_order_id, 'toss_payment_key', p.toss_payment_key,
      'failure_reason', p.failure_reason, 'approved_at', p.approved_at,
      'created_at', p.created_at, 'updated_at', p.updated_at
    ),
    greatest(coalesce(p.approved_at, p.created_at), p.created_at) + interval '5 years'
  from public.payments p where p.user_id = old.id
  on conflict (category, source_id) do nothing;

  insert into public.legal_retention_records (
    subject_reference, category, source_id, record, retain_until
  )
  select old.id, 'subscription', s.id,
    jsonb_build_object(
      'plan_tier', s.plan_tier, 'status', s.status,
      'started_at', s.started_at, 'expires_at', s.expires_at,
      'auto_renew', s.auto_renew, 'payment_provider', s.payment_provider,
      'provider_subscription_id', s.provider_subscription_id,
      'created_at', s.created_at, 'updated_at', s.updated_at
    ),
    coalesce(s.expires_at, s.updated_at, s.created_at) + interval '5 years'
  from public.subscriptions s where s.user_id = old.id
  on conflict (category, source_id) do nothing;

  return old;
end;
$$;

drop trigger if exists before_user_delete_archive_transactions on public.users;
create trigger before_user_delete_archive_transactions
  before delete on public.users
  for each row execute function public.archive_account_transaction_records();

create or replace function public.purge_expired_legal_and_assessment_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.legal_consents where retain_until <= now();
  delete from public.legal_retention_records where retain_until <= now();
  delete from public.live_assessment_sessions
    where coalesce(ended_at, created_at) < now() - interval '1 year';
end;
$$;

revoke all on function public.purge_expired_legal_and_assessment_data() from public;
grant execute on function public.purge_expired_legal_and_assessment_data() to service_role;

select cron.schedule(
  'purge-expired-legal-and-assessment-data',
  '40 18 * * *',
  $$select public.purge_expired_legal_and_assessment_data();$$
);

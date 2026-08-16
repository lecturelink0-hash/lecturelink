-- Store the optional reason and timestamp for a user-requested subscription cancellation.
alter table public.subscriptions
  add column if not exists cancellation_reason text,
  add column if not exists cancelled_at timestamptz;

comment on column public.subscriptions.cancellation_reason is
  'Optional user-selected reason when automatic renewal is cancelled.';

comment on column public.subscriptions.cancelled_at is
  'Timestamp when the user requested automatic renewal cancellation.';

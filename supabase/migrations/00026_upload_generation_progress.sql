-- Durable progress for long-running lecture-note generation.
alter table public.user_uploads
    add column if not exists processing_stage text,
    add column if not exists progress_current integer not null default 0,
    add column if not exists progress_total integer not null default 0,
    add column if not exists completed_question_count integer not null default 0,
    add column if not exists target_question_count integer,
    add column if not exists heartbeat_at timestamptz;

alter table public.private_questions
    add column if not exists generation_slot integer;

create unique index if not exists idx_private_q_upload_generation_slot
    on public.private_questions (upload_id, generation_slot);

delete from public.private_question_images duplicate
using public.private_question_images keeper
where duplicate.private_question_id = keeper.private_question_id
  and duplicate.storage_path = keeper.storage_path
  and duplicate.id > keeper.id;

create unique index if not exists idx_private_q_image_path
    on public.private_question_images (private_question_id, storage_path);

create index if not exists idx_uploads_processing_heartbeat
    on public.user_uploads (heartbeat_at)
    where status in ('queued', 'processing');

-- A dead serverless invocation must not leave the UI polling forever. Active jobs
-- refresh heartbeat_at while extracting, running vision/OCR, and saving batches.
create or replace function public.recover_stuck_upload_generations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    recovered integer;
begin
    update public.user_uploads
    set status = 'failed',
        processing_stage = 'failed',
        error_message = '문항 생성 작업이 중단되었습니다. 다시 시도해주세요. [auto-recovery]',
        heartbeat_at = now()
    where status in ('queued', 'processing')
      and coalesce(heartbeat_at, created_at) < now() - interval '10 minutes';

    get diagnostics recovered = row_count;
    return recovered;
end;
$$;

do $$
begin
    perform cron.unschedule('stuck_upload_recovery');
exception when others then null;
end $$;

select cron.schedule(
    'stuck_upload_recovery',
    '*/5 * * * *',
    $$ select public.recover_stuck_upload_generations(); $$
);

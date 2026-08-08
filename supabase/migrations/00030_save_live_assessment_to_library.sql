alter table public.live_assessment_participants
  add column saved_by uuid references public.users(id) on delete set null,
  add column saved_upload_id uuid references public.user_uploads(id) on delete set null;

alter table public.private_questions
  add column source_image_url text;

create unique index idx_live_participant_saved_upload
  on public.live_assessment_participants(saved_upload_id)
  where saved_upload_id is not null;

create or replace function public.save_live_assessment_to_library(
  target_session uuid,
  target_token_hash text,
  target_user uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  participant_row public.live_assessment_participants%rowtype;
  session_row public.live_assessment_sessions%rowtype;
  new_upload_id uuid;
  question jsonb;
begin
  select * into participant_row
  from public.live_assessment_participants
  where session_id = target_session
    and access_token_hash = target_token_hash
    and status <> 'removed'
  for update;

  if not found then
    raise exception 'participation_not_found' using errcode = 'P0002';
  end if;

  select * into session_row
  from public.live_assessment_sessions
  where id = target_session;

  if session_row.status <> 'ended' then
    raise exception 'assessment_not_ended' using errcode = 'P0001';
  end if;

  if participant_row.saved_by is not null and participant_row.saved_by <> target_user then
    raise exception 'already_claimed' using errcode = '23505';
  end if;

  if participant_row.saved_upload_id is not null then
    return participant_row.saved_upload_id;
  end if;

  insert into public.user_uploads (
    user_id, file_name, file_type, file_size_bytes, storage_path, status, processed_at
  ) values (
    target_user,
    session_row.title,
    'formative/live',
    0,
    'live-assessment/' || participant_row.id::text,
    'completed',
    now()
  ) returning id into new_upload_id;

  for question in select value from jsonb_array_elements(session_row.question_snapshot)
  loop
    insert into public.private_questions (
      user_id, upload_id, stem, choices, answer_index, explanation, concepts, difficulty,
      source_image_url
    ) values (
      target_user,
      new_upload_id,
      question->>'stem',
      question->'choices',
      (question->>'answerIndex')::smallint,
      nullif(question->>'explanation', ''),
      case
        when nullif(question->>'objective', '') is null then '{}'::text[]
        else array[question->>'objective']
      end,
      2,
      nullif(question->>'imageDataUrl', '')
    );
  end loop;

  update public.live_assessment_participants
  set saved_by = target_user, saved_upload_id = new_upload_id
  where id = participant_row.id;

  return new_upload_id;
end;
$$;

revoke all on function public.save_live_assessment_to_library(uuid, text, uuid) from public;
grant execute on function public.save_live_assessment_to_library(uuid, text, uuid) to service_role;

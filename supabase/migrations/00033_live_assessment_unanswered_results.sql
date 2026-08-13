-- Keep unanswered questions separate from wrong answers when a professor ends a live assessment.
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
    total=(select count(*) from live_assessment_answers a where a.participant_id=p.id),
    score=(select count(*) from live_assessment_answers a where a.participant_id=p.id and a.is_correct)
    where p.session_id=target_session and p.status<>'removed';
end $$;

revoke all on function public.finish_live_assessment(uuid) from public;
grant execute on function public.finish_live_assessment(uuid) to authenticated, service_role;

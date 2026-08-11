-- Closed beta: professor selection grants access without administrator review.
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  requested_type text := coalesce(new.raw_user_meta_data->>'requested_account_type', new.raw_user_meta_data->>'account_type', 'student');
begin
  insert into public.users (id, display_name, account_type, faculty_status, faculty_approved_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', new.email),
    case when requested_type = 'professor' then 'professor' else 'student' end::public.account_type,
    case when requested_type = 'professor' then 'approved' else 'not_requested' end::public.faculty_status,
    case when requested_type = 'professor' then now() else null end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Apply the beta policy to applicants already waiting for approval.
update public.users
set account_type = 'professor', faculty_status = 'approved',
    faculty_approved_at = coalesce(faculty_approved_at, now()), faculty_approved_by = null
where faculty_status = 'pending';

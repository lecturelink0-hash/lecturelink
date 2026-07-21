-- Faculty access is an approved privilege, never a self-asserted signup value.
do $$ begin
  create type public.faculty_status as enum ('not_requested', 'pending', 'approved', 'rejected');
exception when duplicate_object then null;
end $$;

alter table public.users
  add column if not exists faculty_status public.faculty_status not null default 'not_requested',
  add column if not exists faculty_approved_at timestamptz,
  add column if not exists faculty_approved_by uuid references public.users(id);

create index if not exists idx_users_faculty_status on public.users(faculty_status);

-- A signup may request faculty access, but every new account starts as student.
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, display_name, account_type, faculty_status)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', new.email),
    'student'::public.account_type,
    case
      when coalesce(new.raw_user_meta_data->>'requested_account_type', new.raw_user_meta_data->>'account_type') = 'professor'
        then 'pending'::public.faculty_status
      else 'not_requested'::public.faculty_status
    end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create or replace function public.is_professor(check_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users
    where id = check_user_id
      and account_type = 'professor'
      and faculty_status = 'approved'
  );
$$;

create or replace function public.is_student(check_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.users where id = check_user_id and account_type = 'student');
$$;

revoke all on function public.is_professor(uuid) from public;
revoke all on function public.is_student(uuid) from public;
grant execute on function public.is_professor(uuid) to authenticated, service_role;
grant execute on function public.is_student(uuid) to authenticated, service_role;

create or replace function public.prevent_account_type_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' and (
    new.account_type is distinct from old.account_type or
    new.faculty_status is distinct from old.faculty_status or
    new.faculty_approved_at is distinct from old.faculty_approved_at or
    new.faculty_approved_by is distinct from old.faculty_approved_by
  ) then
    raise exception 'faculty authorization fields cannot be changed directly' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Existing professor rows are treated as previously approved during rollout.
update public.users
set faculty_status = 'approved', faculty_approved_at = coalesce(faculty_approved_at, now())
where account_type = 'professor' and faculty_status <> 'approved';


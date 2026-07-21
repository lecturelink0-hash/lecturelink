create type public.account_type as enum ('student', 'professor');
alter table public.users add column account_type public.account_type not null default 'student';
create index idx_users_account_type on public.users(account_type);

create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.users (id, display_name, account_type)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', new.email),
    'student'::public.account_type
  );
  return new;
end;
$$;

create or replace function public.prevent_account_type_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' and new.account_type is distinct from old.account_type then
    raise exception 'users.account_type cannot be changed directly' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger trg_prevent_account_type_change
before update on public.users for each row execute function public.prevent_account_type_change();

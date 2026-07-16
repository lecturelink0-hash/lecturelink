-- ============================================
-- 00012_user_privilege_lock.sql
--
-- public.users 의 권한 컬럼(role, plan_tier) 자기 변경 차단.
-- INSERT 와 UPDATE 모두 보호.
--   - UPDATE: 일반 사용자가 role/plan_tier 를 변경할 수 없음.
--   - INSERT: 일반 사용자가 본인 행을 직접 insert 할 때 role 은 'user', plan_tier 는 'free' 만 허용.
--     (handle_new_auth_user 트리거의 기본값과 동일하므로 정상 회원가입은 영향 없음.)
-- service_role (admin client) 은 통과시켜 결제 확정·운영 작업이 동작하도록 함.
--
-- 의존: 00008_admin_role_and_cost_cap.sql 가 users.role 컬럼을 추가해야 함.
-- ============================================

create or replace function public.prevent_user_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
begin
    -- Supabase 의 auth.role() 은 JWT 의 role claim 을 반환.
    -- service_role 키로 호출한 admin client 는 'service_role',
    -- 일반 사용자는 'authenticated'.
    -- auth 스키마가 없는 환경(테스트)에서는 NULL 일 수 있으므로 안전하게 처리.
    begin
        v_role := auth.role();
    exception when others then
        v_role := null;
    end;

    -- service_role 은 그대로 통과 (결제 확정 / 운영 / admin client).
    if v_role = 'service_role' then
        return new;
    end if;

    -- handle_new_auth_user 같은 SECURITY DEFINER 트리거는 auth.role() 이
    -- service_role 이 아닌 값(또는 NULL)을 반환할 수 있으나, 그 경로의
    -- INSERT 는 role/plan_tier 컬럼을 명시하지 않아 DEFAULT 인 'user'/'free'
    -- 가 들어오므로 아래 INSERT 체크를 자연스럽게 통과한다.

    if tg_op = 'INSERT' then
        if new.role is distinct from 'user'::user_role then
            raise exception 'users.role 은 사용자가 직접 설정할 수 없습니다.'
                using errcode = '42501';
        end if;
        if new.plan_tier is distinct from 'free'::plan_tier then
            raise exception 'users.plan_tier 은 사용자가 직접 설정할 수 없습니다.'
                using errcode = '42501';
        end if;
        return new;
    end if;

    -- UPDATE 경로: role / plan_tier 변경 금지.
    -- 단, school_id / grade / current_semester / current_year / onboarded_at /
    -- display_name 등 일반 컬럼 변경은 영향 없음.
    if new.role is distinct from old.role then
        raise exception 'users.role 은 사용자가 직접 변경할 수 없습니다.'
            using errcode = '42501';
    end if;

    if new.plan_tier is distinct from old.plan_tier then
        raise exception 'users.plan_tier 은 사용자가 직접 변경할 수 없습니다.'
            using errcode = '42501';
    end if;

    return new;
end;
$$;

drop trigger if exists trg_prevent_user_privilege_escalation on public.users;
create trigger trg_prevent_user_privilege_escalation
    before insert or update on public.users
    for each row
    execute function public.prevent_user_privilege_escalation();

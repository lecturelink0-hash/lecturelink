-- 00025_default_plan_integrated.sql
-- 런칭 프로모션: 모든 사용자를 '통합형(pro)' 요금제로 제공(결제/카드등록 없이 즉시 이용).
--  1) 신규 가입자 기본 요금제를 free → pro 로 변경
--  2) 권한 잠금 트리거(00012)가 'pro' baseline 자기-insert 를 허용하도록 완화
--     (사용자가 lite/standard 등 임의 상향은 여전히 차단, UPDATE 자기변경도 차단 유지)
--  3) 기존 전체 사용자를 pro 로 일괄 전환(트리거 잠시 비활성화)
-- 되돌리려면: 기본값을 free 로 복귀 + 트리거 INSERT 체크를 'free' 로 되돌림.

-- 1) 신규 가입 기본값 = 통합형(pro)
alter table public.users alter column plan_tier set default 'pro';

-- 2) 권한 잠금 트리거: INSERT 시 baseline 으로 free 또는 pro 만 허용(그 외 자기지정 차단).
create or replace function public.prevent_user_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
begin
    begin
        v_role := auth.role();
    exception when others then
        v_role := null;
    end;

    -- service_role(admin client) 은 그대로 통과.
    if v_role = 'service_role' then
        return new;
    end if;

    if tg_op = 'INSERT' then
        if new.role is distinct from 'user'::user_role then
            raise exception 'users.role 은 사용자가 직접 설정할 수 없습니다.'
                using errcode = '42501';
        end if;
        -- 런칭 프로모션 baseline: free 또는 pro(통합형) 만 자기-insert 허용.
        if new.plan_tier not in ('free'::plan_tier, 'pro'::plan_tier) then
            raise exception 'users.plan_tier 은 사용자가 직접 설정할 수 없습니다.'
                using errcode = '42501';
        end if;
        return new;
    end if;

    -- UPDATE: role / plan_tier 자기변경 금지(변동 없음).
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

-- 3) 기존 사용자 전원 통합형(pro) 전환 — 트리거 잠시 비활성화 후 일괄 UPDATE.
alter table public.users disable trigger trg_prevent_user_privilege_escalation;
update public.users set plan_tier = 'pro' where plan_tier <> 'pro';
alter table public.users enable trigger trg_prevent_user_privilege_escalation;

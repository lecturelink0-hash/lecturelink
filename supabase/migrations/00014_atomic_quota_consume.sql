-- ============================================
-- 00014_atomic_quota_consume.sql
--
-- consume_quota 는 한도 확인 없이 used 를 증가시키므로, 사전 check_user_quota 와
-- 분리된 상태에서 동시 요청이 동일 사용자에 대해 둘 다 사전 체크를 통과한 뒤
-- 동시에 차감되어 한도를 초과할 수 있다.
--
-- consume_quota_checked 는 한 트랜잭션 안에서 usage_quotas 행을 FOR UPDATE 로 잠그고
-- 한도 확인 → 차감을 원자적으로 수행한다. 한도 초과면 ok=false 를 반환하고 used 는
-- 증가시키지 않는다.
--
-- 기존 consume_quota / check_user_quota 는 그대로 유지 — checkQuota 는 UI 표시 등
-- non-enforcing 경로에서 계속 사용 가능.
-- ============================================

create or replace function public.consume_quota_checked(
    p_user_id  uuid,
    p_resource text,             -- 'questions' | 'uploads' | 'images'
    p_amount   integer default 1
)
returns table (
    ok                boolean,
    plan_tier         plan_tier,
    limit_amount      integer,
    used_amount       integer,
    bonus_amount      integer,
    remaining         integer
)
language plpgsql
as $$
declare
    v_quota   public.usage_quotas;
    v_user    public.users;
    v_limit   integer;
    v_used    integer;
    v_bonus   integer;
    v_remain  integer;
    v_period  record;
begin
    select * into v_user from public.users where id = p_user_id;
    if not found then
        return query select false, 'free'::plan_tier, 0, 0, 0, 0;
        return;
    end if;

    select * into v_period from public.current_quota_period();

    -- 행이 없으면 먼저 생성 (race-safe: on conflict do nothing).
    insert into public.usage_quotas (user_id, period_start, period_end)
    values (p_user_id, v_period.period_start, v_period.period_end)
    on conflict (user_id, period_start) do nothing;

    -- 행 잠금 — 동일 사용자에 대한 동시 호출은 여기서 직렬화.
    select * into v_quota
      from public.usage_quotas
     where user_id = p_user_id
       and period_start = v_period.period_start
     for update;

    -- 플랜별 한도
    v_limit := case v_user.plan_tier
        when 'free'     then case p_resource when 'questions' then 50   when 'uploads' then 1  when 'images' then 5   else 0 end
        when 'lite'     then case p_resource when 'questions' then 150  when 'uploads' then 5  when 'images' then 20  else 0 end
        when 'standard' then case p_resource when 'questions' then 400  when 'uploads' then 15 when 'images' then 60  else 0 end
        when 'pro'      then case p_resource when 'questions' then 1000 when 'uploads' then 50 when 'images' then 200 else 0 end
        else 0
    end;

    v_used := case p_resource
        when 'questions' then v_quota.questions_used
        when 'uploads'   then v_quota.uploads_used
        when 'images'    then v_quota.images_used
        else 0 end;
    v_bonus := case p_resource
        when 'questions' then v_quota.bonus_questions
        when 'uploads'   then v_quota.bonus_uploads
        when 'images'    then v_quota.bonus_images
        else 0 end;

    v_remain := (v_limit + v_bonus) - v_used;

    if v_remain < p_amount then
        -- 한도 초과 — used 는 그대로 두고 ok=false 반환.
        return query select
            false,
            v_user.plan_tier,
            v_limit,
            v_used,
            v_bonus,
            greatest(0, v_remain);
        return;
    end if;

    -- 한도 내 → 원자적으로 차감.
    update public.usage_quotas
       set questions_used = case when p_resource = 'questions' then questions_used + p_amount else questions_used end,
           uploads_used   = case when p_resource = 'uploads'   then uploads_used + p_amount   else uploads_used   end,
           images_used    = case when p_resource = 'images'    then images_used + p_amount    else images_used    end,
           updated_at     = now()
     where user_id = p_user_id
       and period_start = v_period.period_start;

    return query select
        true,
        v_user.plan_tier,
        v_limit,
        v_used + p_amount,
        v_bonus,
        greatest(0, v_remain - p_amount);
end;
$$;

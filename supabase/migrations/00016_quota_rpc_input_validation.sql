-- ============================================
-- 00016_quota_rpc_input_validation.sql
--
-- quota / bonus RPC 에 입력 검증 추가.
--   - p_amount: NOT NULL, > 0
--   - p_resource: NOT NULL, in ('questions', 'uploads', 'images')
--
-- 잘못된 입력은 프로그래밍/abuse 오류이므로 SQL state 22023(invalid_parameter_value)
-- 으로 raise exception. 한도 초과는 기존 정책 그대로 consume_quota_checked 에서
-- ok=false 로 반환 (정책 변경 없음).
--
-- 00015 가 EXECUTE 권한을 service_role 로 잠그긴 했지만, 운영 코드(서버)에서도
-- amount=0 / 음수 / 잘못된 resource 가 들어오면 즉시 실패하도록 방어선을 둔다.
-- ============================================

create or replace function public.check_user_quota(
    p_user_id  uuid,
    p_resource text,
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
begin
    if p_amount is null or p_amount <= 0 then
        raise exception 'p_amount must be a positive integer (got %)', p_amount
            using errcode = '22023';
    end if;
    if p_resource is null or p_resource not in ('questions', 'uploads', 'images') then
        raise exception 'invalid p_resource (%): must be one of questions|uploads|images', p_resource
            using errcode = '22023';
    end if;

    select * into v_user from public.users where id = p_user_id;
    if not found then
        return query select false, 'free'::plan_tier, 0, 0, 0, 0;
        return;
    end if;

    v_quota := public.ensure_quota_row(p_user_id);

    v_limit := case v_user.plan_tier
        when 'free'     then case p_resource when 'questions' then 50   when 'uploads' then 1  when 'images' then 5   else 0 end
        when 'lite'     then case p_resource when 'questions' then 150  when 'uploads' then 5  when 'images' then 20  else 0 end
        when 'standard' then case p_resource when 'questions' then 400  when 'uploads' then 15 when 'images' then 60  else 0 end
        when 'pro'      then case p_resource when 'questions' then 1000 when 'uploads' then 50 when 'images' then 200 else 0 end
        else 0
    end;

    v_used  := case p_resource
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

    return query select
        (v_remain >= p_amount) as ok,
        v_user.plan_tier,
        v_limit,
        v_used,
        v_bonus,
        greatest(0, v_remain);
end;
$$;

create or replace function public.consume_quota(
    p_user_id  uuid,
    p_resource text,
    p_amount   integer default 1
)
returns void
language plpgsql
as $$
declare
    v_quota public.usage_quotas;
begin
    if p_amount is null or p_amount <= 0 then
        raise exception 'p_amount must be a positive integer (got %)', p_amount
            using errcode = '22023';
    end if;
    if p_resource is null or p_resource not in ('questions', 'uploads', 'images') then
        raise exception 'invalid p_resource (%): must be one of questions|uploads|images', p_resource
            using errcode = '22023';
    end if;

    v_quota := public.ensure_quota_row(p_user_id);

    update public.usage_quotas
       set questions_used = case when p_resource = 'questions' then questions_used + p_amount else questions_used end,
           uploads_used   = case when p_resource = 'uploads'   then uploads_used + p_amount   else uploads_used   end,
           images_used    = case when p_resource = 'images'    then images_used + p_amount    else images_used    end,
           updated_at     = now()
     where user_id = p_user_id
       and period_start = v_quota.period_start;
end;
$$;

create or replace function public.add_bonus_credits(
    p_user_id  uuid,
    p_resource text,
    p_amount   integer
)
returns void
language plpgsql
as $$
declare
    v_quota public.usage_quotas;
begin
    if p_amount is null or p_amount <= 0 then
        raise exception 'p_amount must be a positive integer (got %)', p_amount
            using errcode = '22023';
    end if;
    if p_resource is null or p_resource not in ('questions', 'uploads', 'images') then
        raise exception 'invalid p_resource (%): must be one of questions|uploads|images', p_resource
            using errcode = '22023';
    end if;

    v_quota := public.ensure_quota_row(p_user_id);

    update public.usage_quotas
       set bonus_questions = case when p_resource = 'questions' then bonus_questions + p_amount else bonus_questions end,
           bonus_uploads   = case when p_resource = 'uploads'   then bonus_uploads + p_amount   else bonus_uploads   end,
           bonus_images    = case when p_resource = 'images'    then bonus_images + p_amount    else bonus_images    end,
           updated_at      = now()
     where user_id = p_user_id
       and period_start = v_quota.period_start;
end;
$$;

create or replace function public.consume_quota_checked(
    p_user_id  uuid,
    p_resource text,
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
    if p_amount is null or p_amount <= 0 then
        raise exception 'p_amount must be a positive integer (got %)', p_amount
            using errcode = '22023';
    end if;
    if p_resource is null or p_resource not in ('questions', 'uploads', 'images') then
        raise exception 'invalid p_resource (%): must be one of questions|uploads|images', p_resource
            using errcode = '22023';
    end if;

    select * into v_user from public.users where id = p_user_id;
    if not found then
        return query select false, 'free'::plan_tier, 0, 0, 0, 0;
        return;
    end if;

    select * into v_period from public.current_quota_period();

    insert into public.usage_quotas (user_id, period_start, period_end)
    values (p_user_id, v_period.period_start, v_period.period_end)
    on conflict (user_id, period_start) do nothing;

    select * into v_quota
      from public.usage_quotas
     where user_id = p_user_id
       and period_start = v_period.period_start
     for update;

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
        return query select
            false,
            v_user.plan_tier,
            v_limit,
            v_used,
            v_bonus,
            greatest(0, v_remain);
        return;
    end if;

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

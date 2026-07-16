-- ============================================
-- 00021_plan_pricing_v2.sql
--
-- 요금제 개편(기획서 기준) — DB 반영분.
--  · plan_tier 에 'unlimited'(통합형 무제한) 추가
--  · 플랜별 월 한도 갱신:
--      내신 대비(lite)     : 문항 500 / 업로드 10 / 이미지 30   (₩7,900)
--      국가고시 대비(standard): 문항 500 / 업로드 5  / 이미지 40   (₩9,900)
--      통합형(pro)         : 문항 2000 / 업로드 100 / 이미지 200  (₩14,900)
--      통합형 무제한(unlimited): 사실상 무제한(999999)            (₩20,900)
--
-- ⚠️ 적용 방법: Supabase SQL Editor(또는 psql)에서 실행. (앱 런타임은 DB 함수를
--    통해 한도를 강제하므로, 이 파일을 적용해야 새 한도/티어가 실제로 반영된다.)
--    함수는 plan_tier 를 ::text 로 비교하므로 ADD VALUE 와 같은 트랜잭션에서도 안전.
--
-- 가격 표시/결제금액(프론트·PLAN_PRICES)은 앱 코드에서 이미 갱신됨.
-- ============================================

-- 1) 새 티어 값 추가 (이미 있으면 무시)
alter type plan_tier add value if not exists 'unlimited';

-- 2) 한도 확인 함수 (표시/비강제 경로)
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
    select * into v_user from public.users where id = p_user_id;
    if not found then
        return query select false, 'free'::plan_tier, 0, 0, 0, 0;
        return;
    end if;

    v_quota := public.ensure_quota_row(p_user_id);

    v_limit := case v_user.plan_tier::text
        when 'free'      then case p_resource when 'questions' then 50     when 'uploads' then 1      when 'images' then 5      else 0 end
        when 'lite'      then case p_resource when 'questions' then 500    when 'uploads' then 10     when 'images' then 30     else 0 end
        when 'standard'  then case p_resource when 'questions' then 500    when 'uploads' then 5      when 'images' then 40     else 0 end
        when 'pro'       then case p_resource when 'questions' then 2000   when 'uploads' then 100    when 'images' then 200    else 0 end
        when 'unlimited' then case p_resource when 'questions' then 999999 when 'uploads' then 999999 when 'images' then 999999 else 0 end
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

-- 3) 원자적 차감 함수 (강제 경로)
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

    v_limit := case v_user.plan_tier::text
        when 'free'      then case p_resource when 'questions' then 50     when 'uploads' then 1      when 'images' then 5      else 0 end
        when 'lite'      then case p_resource when 'questions' then 500    when 'uploads' then 10     when 'images' then 30     else 0 end
        when 'standard'  then case p_resource when 'questions' then 500    when 'uploads' then 5      when 'images' then 40     else 0 end
        when 'pro'       then case p_resource when 'questions' then 2000   when 'uploads' then 100    when 'images' then 200    else 0 end
        when 'unlimited' then case p_resource when 'questions' then 999999 when 'uploads' then 999999 when 'images' then 999999 else 0 end
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

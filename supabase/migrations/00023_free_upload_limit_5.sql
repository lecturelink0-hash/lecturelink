-- 00023_free_upload_limit_5.sql
-- 무료 플랜 월 업로드 한도 1 → 5 상향 (사용자 결정 2026-07-18).
-- check_user_quota / consume_quota_checked 두 함수의 'free' 플랜 uploads 한도만 변경.
-- 나머지 플랜·리소스 한도는 운영 라이브(v2 pricing)와 동일하게 유지.
-- 운영에는 Management API 로 이미 적용됨 — 본 파일은 재현/기록용.

CREATE OR REPLACE FUNCTION public.check_user_quota(p_user_id uuid, p_resource text, p_amount integer DEFAULT 1)
 RETURNS TABLE(ok boolean, plan_tier plan_tier, limit_amount integer, used_amount integer, bonus_amount integer, remaining integer)
 LANGUAGE plpgsql
AS $function$
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
        when 'free'      then case p_resource when 'questions' then 50     when 'uploads' then 5      when 'images' then 5      else 0 end
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
$function$


CREATE OR REPLACE FUNCTION public.consume_quota_checked(p_user_id uuid, p_resource text, p_amount integer DEFAULT 1)
 RETURNS TABLE(ok boolean, plan_tier plan_tier, limit_amount integer, used_amount integer, bonus_amount integer, remaining integer)
 LANGUAGE plpgsql
AS $function$
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
        when 'free'      then case p_resource when 'questions' then 50     when 'uploads' then 5      when 'images' then 5      else 0 end
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
$function$


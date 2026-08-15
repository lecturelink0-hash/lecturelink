-- 00039_question_quota_500_all_paid_tiers.sql
-- 문항 한도 정책 정렬 — 유료 3종 모두 월 500문항 (2026-08-16).
--
-- 요금제 페이지의 통합 플랜 카드는 "월 500문항 생성"으로 안내하는데 DB 한도만
-- 개편 전 값(pro = 2000)으로 남아 있어 사용량 패널에 "13 / 2000" 이 떴다.
-- 낡은 쪽은 안내가 아니라 한도이므로 pro 를 500 으로 맞춘다.
--   free 50 / lite 500 / standard 500 / pro 500 / unlimited 999999
--
-- images 열은 건드리지 않는다: 이미지 문항 별도 한도는 2026-08-14 정책으로 폐지됐고
-- (lib/payment/toss.ts 의 CREDIT_PRICES 주석 참조) 앱 어디에서도 소비되지 않는 사문이다.
-- 한도표를 들고 있는 함수는 check_user_quota / consume_quota_checked 둘뿐이며,
-- 본 파일은 00037 의 본문을 그대로 옮기고 pro-questions 값만 바꾼 것이다.
-- CREATE OR REPLACE 는 기존 GRANT 를 보존한다(00015).
--
-- 되돌리기: 아래 두 함수의 pro questions 값을 500 → 2000 으로 되돌려 다시 실행.

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
    if p_amount is null or p_amount <= 0 then
        raise exception 'p_amount must be a positive integer (got %)', p_amount
            using errcode = '22023';
    end if;
    if p_resource is null or p_resource not in ('questions', 'uploads', 'images', 'cpx_seconds') then
        raise exception 'invalid p_resource (%): must be one of questions|uploads|images|cpx_seconds', p_resource
            using errcode = '22023';
    end if;

    select * into v_user from public.users where id = p_user_id;
    if not found then
        return query select false, 'free'::plan_tier, 0, 0, 0, 0;
        return;
    end if;

    v_quota := public.ensure_quota_row(p_user_id);

    v_limit := case v_user.plan_tier::text
        when 'free'      then case p_resource when 'questions' then 50     when 'uploads' then 5      when 'images' then 5      when 'cpx_seconds' then 720    else 0 end
        when 'lite'      then case p_resource when 'questions' then 500    when 'uploads' then 10     when 'images' then 30     when 'cpx_seconds' then 720    else 0 end
        when 'standard'  then case p_resource when 'questions' then 500    when 'uploads' then 5      when 'images' then 40     when 'cpx_seconds' then 14400  else 0 end
        when 'pro'       then case p_resource when 'questions' then 500    when 'uploads' then 100    when 'images' then 200    when 'cpx_seconds' then 14400  else 0 end
        when 'unlimited' then case p_resource when 'questions' then 999999 when 'uploads' then 999999 when 'images' then 999999 when 'cpx_seconds' then 999999 else 0 end
        else 0
    end;

    v_used  := case p_resource
        when 'questions'   then v_quota.questions_used
        when 'uploads'     then v_quota.uploads_used
        when 'images'      then v_quota.images_used
        when 'cpx_seconds' then v_quota.cpx_seconds_used
        else 0 end;
    v_bonus := case p_resource
        when 'questions'   then v_quota.bonus_questions
        when 'uploads'     then v_quota.bonus_uploads
        when 'images'      then v_quota.bonus_images
        when 'cpx_seconds' then v_quota.bonus_cpx_seconds
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
$function$;

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
    if p_amount is null or p_amount <= 0 then
        raise exception 'p_amount must be a positive integer (got %)', p_amount
            using errcode = '22023';
    end if;
    if p_resource is null or p_resource not in ('questions', 'uploads', 'images', 'cpx_seconds') then
        raise exception 'invalid p_resource (%): must be one of questions|uploads|images|cpx_seconds', p_resource
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

    v_limit := case v_user.plan_tier::text
        when 'free'      then case p_resource when 'questions' then 50     when 'uploads' then 5      when 'images' then 5      when 'cpx_seconds' then 720    else 0 end
        when 'lite'      then case p_resource when 'questions' then 500    when 'uploads' then 10     when 'images' then 30     when 'cpx_seconds' then 720    else 0 end
        when 'standard'  then case p_resource when 'questions' then 500    when 'uploads' then 5      when 'images' then 40     when 'cpx_seconds' then 14400  else 0 end
        when 'pro'       then case p_resource when 'questions' then 500    when 'uploads' then 100    when 'images' then 200    when 'cpx_seconds' then 14400  else 0 end
        when 'unlimited' then case p_resource when 'questions' then 999999 when 'uploads' then 999999 when 'images' then 999999 when 'cpx_seconds' then 999999 else 0 end
        else 0
    end;

    v_used := case p_resource
        when 'questions'   then v_quota.questions_used
        when 'uploads'     then v_quota.uploads_used
        when 'images'      then v_quota.images_used
        when 'cpx_seconds' then v_quota.cpx_seconds_used
        else 0 end;
    v_bonus := case p_resource
        when 'questions'   then v_quota.bonus_questions
        when 'uploads'     then v_quota.bonus_uploads
        when 'images'      then v_quota.bonus_images
        when 'cpx_seconds' then v_quota.bonus_cpx_seconds
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
       set questions_used   = case when p_resource = 'questions'   then questions_used + p_amount   else questions_used   end,
           uploads_used     = case when p_resource = 'uploads'     then uploads_used + p_amount     else uploads_used     end,
           images_used      = case when p_resource = 'images'      then images_used + p_amount      else images_used      end,
           cpx_seconds_used = case when p_resource = 'cpx_seconds' then cpx_seconds_used + p_amount else cpx_seconds_used end,
           updated_at       = now()
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
$function$;

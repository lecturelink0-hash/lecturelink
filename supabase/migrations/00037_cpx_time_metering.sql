-- 00037_cpx_time_metering.sql
-- CPX 이용 시간 차감 정책 1단계 (정책 확정안 v1.0, 2026-08-14).
--
-- 차감 단위를 "완료 횟수"가 아닌 "실제 이용 시간(초)"으로 전환하기 위한 기반:
--   1) usage_quotas 에 cpx_seconds 리소스 추가 (사용량·보너스)
--   2) cpx_sessions 에 하트비트·정산 컬럼 추가
--   3) quota RPC 4종 재작성 — cpx_seconds 분기 + 00023 에서 누락된 00016 입력 검증 복원
--   4) settle_cpx_session: 세션당 정확히 1회만 정산하는 멱등 정산 (60초 미만 무료 취소 반영)
--   5) sweep_stale_cpx_sessions + pg_cron: 하트비트 10분 경과 세션 자동 종료·정산
--
-- 1단계 범위 밖(후속): 일시정지 시간 제외 정산, 무료 취소 1일 3회 캡, 부분 채점 트리거,
-- 이어하기 복원, 선확보(hold) 후 정산. 현재는 일시정지가 없어 생존 시간 ≈ 대화 시간.

-- ───────────── 1. usage_quotas: cpx_seconds 리소스 ─────────────

alter table public.usage_quotas
  add column if not exists cpx_seconds_used integer not null default 0,
  add column if not exists bonus_cpx_seconds integer not null default 0;

-- ───────────── 2. cpx_sessions: 하트비트·정산 컬럼 ─────────────

alter table public.cpx_sessions
  add column if not exists heartbeat_at timestamptz,
  add column if not exists time_limit_seconds integer,
  add column if not exists metered_seconds integer,
  add column if not exists settle_reason text,
  add column if not exists settled_at timestamptz;

alter table public.cpx_sessions
  drop constraint if exists cpx_sessions_settle_reason_check;
alter table public.cpx_sessions
  add constraint cpx_sessions_settle_reason_check
  check (settle_reason is null or settle_reason in ('completed', 'abandoned', 'swept'));

create index if not exists idx_cpx_sessions_active_heartbeat
  on public.cpx_sessions (heartbeat_at)
  where status = 'active';

-- 정책 시행 이전의 기존 세션은 소급 과금하지 않는다: 종료된 세션은 0원 정산으로 마감,
-- 미종료 좀비(탭 닫힘 후 영구 active)도 0원으로 정리해 스윕 대상에서 제외한다.
update public.cpx_sessions
   set settled_at = now(), settle_reason = 'completed', metered_seconds = 0
 where status = 'ended' and settled_at is null;
update public.cpx_sessions
   set status = 'ended', ended_at = coalesce(ended_at, updated_at),
       settled_at = now(), settle_reason = 'swept', metered_seconds = 0
 where status = 'active';

-- ───────────── 3. quota RPC 재작성 (cpx_seconds + 검증 복원) ─────────────
-- 티어별 월 한도(초): free·lite 720 (CPX 체험 1회 = 12분), standard·pro 14400 (240분).
-- 00016 의 p_resource 화이트리스트·p_amount 양수 검증이 00023 재작성에서 누락되어 있었다
-- — 여기서 4종 모두에 복원한다. CREATE OR REPLACE 는 기존 GRANT 를 보존한다(00015).

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
        when 'pro'       then case p_resource when 'questions' then 2000   when 'uploads' then 100    when 'images' then 200    when 'cpx_seconds' then 14400  else 0 end
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
        when 'pro'       then case p_resource when 'questions' then 2000   when 'uploads' then 100    when 'images' then 200    when 'cpx_seconds' then 14400  else 0 end
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

CREATE OR REPLACE FUNCTION public.consume_quota(p_user_id uuid, p_resource text, p_amount integer DEFAULT 1)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
    v_quota public.usage_quotas;
begin
    if p_amount is null or p_amount <= 0 then
        raise exception 'p_amount must be a positive integer (got %)', p_amount
            using errcode = '22023';
    end if;
    if p_resource is null or p_resource not in ('questions', 'uploads', 'images', 'cpx_seconds') then
        raise exception 'invalid p_resource (%): must be one of questions|uploads|images|cpx_seconds', p_resource
            using errcode = '22023';
    end if;

    v_quota := public.ensure_quota_row(p_user_id);

    update public.usage_quotas
       set questions_used   = case when p_resource = 'questions'   then questions_used + p_amount   else questions_used   end,
           uploads_used     = case when p_resource = 'uploads'     then uploads_used + p_amount     else uploads_used     end,
           images_used      = case when p_resource = 'images'      then images_used + p_amount      else images_used      end,
           cpx_seconds_used = case when p_resource = 'cpx_seconds' then cpx_seconds_used + p_amount else cpx_seconds_used end,
           updated_at       = now()
     where user_id = p_user_id
       and period_start = v_quota.period_start;
end;
$function$;

CREATE OR REPLACE FUNCTION public.add_bonus_credits(p_user_id uuid, p_resource text, p_amount integer)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
    v_quota public.usage_quotas;
begin
    if p_amount is null or p_amount <= 0 then
        raise exception 'p_amount must be a positive integer (got %)', p_amount
            using errcode = '22023';
    end if;
    if p_resource is null or p_resource not in ('questions', 'uploads', 'images', 'cpx_seconds') then
        raise exception 'invalid p_resource (%): must be one of questions|uploads|images|cpx_seconds', p_resource
            using errcode = '22023';
    end if;

    v_quota := public.ensure_quota_row(p_user_id);

    update public.usage_quotas
       set bonus_questions   = case when p_resource = 'questions'   then bonus_questions + p_amount   else bonus_questions   end,
           bonus_uploads     = case when p_resource = 'uploads'     then bonus_uploads + p_amount     else bonus_uploads     end,
           bonus_images      = case when p_resource = 'images'      then bonus_images + p_amount      else bonus_images      end,
           bonus_cpx_seconds = case when p_resource = 'cpx_seconds' then bonus_cpx_seconds + p_amount else bonus_cpx_seconds end,
           updated_at        = now()
     where user_id = p_user_id
       and period_start = v_quota.period_start;
end;
$function$;

-- ───────────── 4. 멱등 정산 ─────────────
-- 종료 신호는 클라이언트(/end 미러)와 스윕 양쪽에서 올 수 있으므로 세션당 정확히 1회만
-- 정산한다 (settled_at 가드 + row lock). 차감량은 서버 기록 기준:
--   completed/abandoned → ended_at, swept → 마지막 하트비트 (없으면 started_at).
-- 시작 60초 미만은 무료 취소(차감 0, 정책 4-4 — 1일 3회 캡은 후속 단계).
-- 상한: time_limit_seconds (미기록 세션은 기본 720초).

create or replace function public.settle_cpx_session(p_external_session_id text, p_reason text)
returns table (settled boolean, metered_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_session public.cpx_sessions;
    v_quota   public.usage_quotas;
    v_end     timestamptz;
    v_metered integer;
begin
    if p_reason is null or p_reason not in ('completed', 'abandoned', 'swept') then
        raise exception 'invalid p_reason (%): must be one of completed|abandoned|swept', p_reason
            using errcode = '22023';
    end if;

    select * into v_session
      from public.cpx_sessions
     where external_session_id = p_external_session_id
     for update;
    if not found then
        return query select false, 0;
        return;
    end if;

    if v_session.settled_at is not null then
        -- 이미 정산됨 — 멱등 no-op.
        return query select false, coalesce(v_session.metered_seconds, 0);
        return;
    end if;

    v_end := case
        when p_reason = 'swept' then coalesce(v_session.heartbeat_at, v_session.started_at)
        else coalesce(v_session.ended_at, v_session.heartbeat_at, now())
    end;

    v_metered := greatest(0, floor(extract(epoch from (v_end - v_session.started_at)))::integer);
    v_metered := least(v_metered, coalesce(v_session.time_limit_seconds, 720));
    if v_metered < 60 then
        v_metered := 0;
    end if;

    update public.cpx_sessions
       set status = 'ended',
           ended_at = coalesce(ended_at, v_end),
           metered_seconds = v_metered,
           settle_reason = p_reason,
           settled_at = now(),
           updated_at = now()
     where id = v_session.id;

    if v_metered > 0 then
        -- 사후 정산이므로 한도 검사 없이 가산한다 (한도 임박 세션이 초과 종료되어도
        -- 이미 발생한 이용 시간은 기록되어야 다음 시작 차단이 정확해진다).
        v_quota := public.ensure_quota_row(v_session.user_id);
        update public.usage_quotas
           set cpx_seconds_used = cpx_seconds_used + v_metered,
               updated_at = now()
         where user_id = v_session.user_id
           and period_start = v_quota.period_start;
    end if;

    return query select true, v_metered;
end;
$$;

revoke all on function public.settle_cpx_session(text, text) from public;
revoke all on function public.settle_cpx_session(text, text) from anon;
revoke all on function public.settle_cpx_session(text, text) from authenticated;
grant execute on function public.settle_cpx_session(text, text) to service_role;

-- ───────────── 5. 자동 정리 스윕 ─────────────
-- ① 마지막 하트비트 + 10분(이어하기 창)이 지난 active 세션 → 'swept' 정산 (정책 4-3)
-- ② /end 미러 후 정산 호출이 실패해 ended 인데 미정산인 세션 → 'completed' 백스톱 정산

create or replace function public.sweep_stale_cpx_sessions()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_count integer := 0;
    r record;
begin
    for r in
        select external_session_id
          from public.cpx_sessions
         where (status = 'active'
                and coalesce(heartbeat_at, started_at) < now() - interval '10 minutes')
            or (status = 'ended'
                and settled_at is null
                and coalesce(ended_at, updated_at) < now() - interval '5 minutes')
    loop
        perform public.settle_cpx_session(
            r.external_session_id,
            case when exists (
                select 1 from public.cpx_sessions s
                 where s.external_session_id = r.external_session_id and s.status = 'ended'
            ) then 'completed' else 'swept' end
        );
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

revoke all on function public.sweep_stale_cpx_sessions() from public;
revoke all on function public.sweep_stale_cpx_sessions() from anon;
revoke all on function public.sweep_stale_cpx_sessions() from authenticated;
grant execute on function public.sweep_stale_cpx_sessions() to service_role;

do $$
begin
    perform cron.unschedule('cpx_session_sweep');
exception when others then
    null;
end
$$;

select cron.schedule(
    'cpx_session_sweep',
    '* * * * *',
    $$ select public.sweep_stale_cpx_sessions(); $$
);

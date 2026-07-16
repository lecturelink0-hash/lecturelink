-- ====================================================================
-- 사용량 quota + 결제 인프라
-- ====================================================================

-- ──────────────────────────────────────────
-- 결제 트랜잭션 (Audit log)
-- ──────────────────────────────────────────
create type payment_kind as enum (
    'subscription_initial',  -- 구독 첫 결제
    'subscription_renewal',  -- 구독 갱신
    'credit_questions',      -- 문항 크레딧
    'credit_uploads',        -- 자료 업로드 크레딧
    'credit_images'          -- 이미지 크레딧
);

create type payment_status as enum (
    'pending',    -- 결제 초기화, 사용자 입력 대기
    'approved',   -- 승인 완료
    'failed',     -- 실패
    'cancelled',  -- 취소
    'refunded'    -- 환불
);

create table public.payments (
    id                    uuid primary key default uuid_generate_v4(),
    user_id               uuid not null references public.users(id) on delete cascade,
    kind                  payment_kind not null,
    status                payment_status not null default 'pending',

    -- 결제 정보
    amount_krw            integer not null,
    plan_tier             plan_tier,                    -- 구독 종류 (kind = subscription_*)
    credit_amount         integer,                      -- 크레딧 충전량 (kind = credit_*)

    -- 토스 결제 키
    toss_order_id         text not null unique,         -- 우리가 생성한 주문 ID
    toss_payment_key      text,                         -- 토스가 부여한 결제 키 (승인 후)

    -- 메타
    failure_reason        text,
    raw_response          jsonb,                        -- 토스 응답 전체 저장

    approved_at           timestamptz,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create index idx_payments_user_status on public.payments(user_id, status);
create index idx_payments_toss_order  on public.payments(toss_order_id);

alter table public.payments enable row level security;
create policy "payments_read_own" on public.payments
    for select using (auth.uid() = user_id);

create trigger set_payments_updated_at
    before update on public.payments
    for each row execute function public.set_updated_at();

-- ──────────────────────────────────────────
-- 사용량 quota 체크 함수
--
-- 호출 흐름:
--   AI 호출 전 → check_user_quota(user_id, resource, amount)
--   결과 ok=false 면 402 응답 반환
--   ok=true 면 호출 진행 → 성공 후 consume_quota 로 차감
--
-- 현재 월 quota 정보 자동 생성 (없으면 insert).
-- ──────────────────────────────────────────

-- 사용자의 현재 quota period 시작/종료일
create or replace function public.current_quota_period(p_now timestamptz default now())
returns table (period_start date, period_end date)
language sql
stable
as $$
    select
        date_trunc('month', p_now)::date as period_start,
        (date_trunc('month', p_now) + interval '1 month - 1 day')::date as period_end;
$$;

-- quota 행 lookup-or-create
create or replace function public.ensure_quota_row(p_user_id uuid)
returns public.usage_quotas
language plpgsql
as $$
declare
    v_period record;
    v_row    public.usage_quotas;
begin
    select * into v_period from public.current_quota_period();

    select * into v_row
      from public.usage_quotas
     where user_id = p_user_id
       and period_start = v_period.period_start;

    if not found then
        insert into public.usage_quotas (user_id, period_start, period_end)
        values (p_user_id, v_period.period_start, v_period.period_end)
        on conflict (user_id, period_start) do nothing
        returning * into v_row;

        -- onConflict 발생 시 재조회
        if not found then
            select * into v_row
              from public.usage_quotas
             where user_id = p_user_id
               and period_start = v_period.period_start;
        end if;
    end if;

    return v_row;
end;
$$;

-- 사용량 체크
create or replace function public.check_user_quota(
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
begin
    select * into v_user from public.users where id = p_user_id;
    if not found then
        return query select false, 'free'::plan_tier, 0, 0, 0, 0;
        return;
    end if;

    v_quota := public.ensure_quota_row(p_user_id);

    -- 플랜별 한도
    v_limit := case v_user.plan_tier
        when 'free'     then case p_resource when 'questions' then 50   when 'uploads' then 1  when 'images' then 5   else 0 end
        when 'lite'     then case p_resource when 'questions' then 150  when 'uploads' then 5  when 'images' then 20  else 0 end
        when 'standard' then case p_resource when 'questions' then 400  when 'uploads' then 15 when 'images' then 60  else 0 end
        when 'pro'      then case p_resource when 'questions' then 1000 when 'uploads' then 50 when 'images' then 200 else 0 end
        else 0
    end;

    -- 사용량·보너스 조회
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

-- 사용량 차감
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

-- 크레딧 보너스 추가
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

-- 월간 자동 reset (cron 으로 매월 1일 호출)
-- 현재 월의 quota 행은 ensure_quota_row 가 lazy 생성하므로 별도 reset 불필요.
-- 단, 만료된 보너스 처리: 1개월 이월 후 소멸.
create or replace function public.reset_expired_bonuses()
returns void
language sql
as $$
    -- 이전 달 quota 행의 bonus 를 0 으로 (1개월 이월 정책)
    update public.usage_quotas
       set bonus_questions = 0,
           bonus_uploads   = 0,
           bonus_images    = 0,
           updated_at      = now()
     where period_end < current_date - interval '1 month';
$$;

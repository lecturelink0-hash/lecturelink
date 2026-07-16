-- ============================================
-- 00013_payment_entitlement_tracking.sql
--
-- payments 결제 승인(approved) 후 실제 혜택(users.plan_tier 갱신 / bonus credit 지급)
-- 적용 여부를 추적해 confirm 재호출 시 reconcile 할 수 있게 한다.
--
-- 결제 confirm 라우트는 다음 규칙을 따른다:
--   1. 첫 호출 — Toss 승인 → subscription/credit 적용 → entitlement_granted_at 마킹.
--      마지막 단계 실패 시 ApiException 으로 클라이언트에 실패 응답.
--   2. 재호출 (이미 approved) — entitlement_granted_at 이 NULL 이면
--      누락된 혜택을 재시도하고, 성공 시에만 마킹 + ok 응답.
--      여전히 실패하면 사용자에게 실패 응답.
--
-- 크레딧(bonus) 결제는 add_bonus_credits 호출과 entitlement_granted_at 마킹을
-- 단일 트랜잭션 안에서 실행해야 안전(부분 성공 시 중복 지급 방지). 그래서
-- apply_payment_credit_bonus RPC 를 추가해 confirm 라우트에서 호출하도록 한다.
-- ============================================

alter table public.payments
    add column if not exists entitlement_granted_at timestamptz;

comment on column public.payments.entitlement_granted_at is
    'subscription/credit 혜택이 사용자 계정에 적용된 시각. NULL 이면 미적용/미reconcile 상태.';

-- 운영 reconciliation 쿼리 편의용: approved 인데 entitlement 미적용 결제 빠르게 조회.
create index if not exists idx_payments_entitlement_pending
    on public.payments(approved_at)
    where status = 'approved' and entitlement_granted_at is null;

-- ──────────────────────────────────────────
-- 크레딧 결제 원자 적용 RPC
--
-- 동작:
--   1. payments 행을 FOR UPDATE 로 잠근 뒤 상태 확인.
--   2. 이미 entitlement_granted_at 이 설정되어 있으면 applied=false 반환 (idempotent).
--   3. status='approved' + kind='credit_*' + credit_amount > 0 일 때만 진행.
--   4. add_bonus_credits 호출 → entitlement_granted_at = now() 갱신.
--   5. 두 작업이 동일 트랜잭션에 묶여 부분 성공이 없다.
--
-- 호출자(payments/confirm)는 error 가 나면 throw, applied=false 이면 이미 처리됨으로 간주.
-- ──────────────────────────────────────────
create or replace function public.apply_payment_credit_bonus(p_payment_id uuid)
returns table (
    applied        boolean,
    kind           text,
    credit_amount  integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_payment   public.payments;
    v_resource  text;
    v_now       timestamptz := now();
begin
    select * into v_payment
      from public.payments
     where id = p_payment_id
     for update;

    if not found then
        raise exception 'payment % not found', p_payment_id
            using errcode = 'P0002';
    end if;

    if v_payment.status <> 'approved' then
        raise exception 'payment % is not approved (status=%)',
            p_payment_id, v_payment.status
            using errcode = '22023';
    end if;

    -- 이미 적용된 결제 — 두번째 호출은 no-op
    if v_payment.entitlement_granted_at is not null then
        return query select false, v_payment.kind::text, v_payment.credit_amount;
        return;
    end if;

    if v_payment.kind::text not like 'credit_%' then
        raise exception 'payment % is not a credit kind (%)',
            p_payment_id, v_payment.kind
            using errcode = '22023';
    end if;

    if v_payment.credit_amount is null or v_payment.credit_amount <= 0 then
        raise exception 'payment % has invalid credit_amount (%)',
            p_payment_id, v_payment.credit_amount
            using errcode = '22023';
    end if;

    -- 'credit_questions' → 'questions' 같은 식으로 자른다.
    v_resource := substring(v_payment.kind::text from 8);

    perform public.add_bonus_credits(
        v_payment.user_id,
        v_resource,
        v_payment.credit_amount
    );

    update public.payments
       set entitlement_granted_at = v_now
     where id = p_payment_id;

    return query select true, v_payment.kind::text, v_payment.credit_amount;
end;
$$;

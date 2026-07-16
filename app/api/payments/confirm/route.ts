/**
 * POST /api/payments/confirm
 *
 * 토스 결제 완료 후 successUrl 로 redirect 된 클라이언트가 호출.
 * 토스 confirmPayment API 호출 → DB 상태 업데이트 → 혜택 부여.
 *
 * Body:
 *   { payment_key: string, order_id: string, amount: number }
 *
 * 후속 작업 순서 (구독 결제 기준, fresh 첫 호출):
 *   1. payments.toss_payment_key 선기록 (Toss 호출 trace)
 *   2. Toss confirmPayment (돈 확정)
 *   3. subscriptions insert → id 획득
 *   4. payments update (status=approved + subscription_id + raw_response)
 *   5. entitlement 적용 (users.plan_tier or addBonus)
 *   6. payments.entitlement_granted_at 마킹
 *
 * 정합성 정책:
 *   - 5 단계 실패 시 ok 응답 X (ApiException 500). entitlement_granted_at NULL →
 *     재호출 시 reconcile 시도.
 *   - 이미 status='approved' 인 결제에 재호출이 오면 entitlement_granted_at 검사:
 *       NULL → 누락 entitlement 재시도, 성공 시 마킹.
 *       NOT NULL → already_approved 응답.
 *   - status='pending' 또는 'failed' 인데 토스 승인 흔적(toss_payment_key 또는
 *     subscription_id) 이 남아 있는 경우:
 *       confirm 재호출 대신 getPayment 으로 실제 토스 상태를 조회해 reconcile.
 *       DONE 이면 정상 reconcile 수행, 그 외 상태면 사용자에게 적절한 응답.
 *     → "사용자가 돈을 냈는데 재시도 과정에서 payment 가 failed 로 덮이는 상태" 차단.
 *   - confirmPayment 가 ALREADY_PROCESSED_PAYMENT 로 실패해도 failed 로 덮지 않고
 *     getPayment 으로 실제 상태를 확인해 reconcile.
 *   - 크레딧 결제는 apply_payment_credit_bonus RPC (트랜잭션) 가 add_bonus + 마킹을 묶음.
 *   - 구독 결제의 plan_tier 갱신은 idempotent 라 일반 update 로 충분.
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import {
  confirmPayment,
  getPayment,
  type TossPaymentResponse,
} from '@/lib/payment/toss';
import { reportAlert } from '@/lib/notify/alerts';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
import type { PlanTier } from '@/lib/types/database';

const bodySchema = z.object({
  payment_key: z.string().min(1),
  order_id: z.string().min(1),
  amount: z.number().int().positive(),
});

type AdminClient = ReturnType<typeof createAdminClient>;

interface PaymentRowLike {
  id: string;
  user_id: string;
  kind: string;
  status: string;
  amount_krw: number;
  plan_tier: PlanTier | null;
  credit_amount: number | null;
  toss_order_id: string;
  toss_payment_key: string | null;
  subscription_id: string | null;
  entitlement_granted_at: string | null;
}

function isSubscriptionKind(kind: string): boolean {
  return kind === 'subscription_initial' || kind === 'subscription_renewal';
}

function isCreditKind(kind: string): boolean {
  return kind.startsWith('credit_');
}

/** 결제 row 에 토스 승인 시도 흔적이 남아 있으면 true. */
function hasTossTrace(payment: PaymentRowLike): boolean {
  return Boolean(payment.toss_payment_key) || Boolean(payment.subscription_id);
}

/**
 * subscriptions 행을 insert 하고 payments.subscription_id 를 연결.
 * 이미 연결돼 있으면 no-op 으로 기존 id 반환.
 */
async function ensureSubscription(
  admin: AdminClient,
  payment: PaymentRowLike,
): Promise<string> {
  if (payment.subscription_id) return payment.subscription_id;

  const planTier = payment.plan_tier as PlanTier;
  const now = new Date();
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + 1);

  const { data: sub, error: subErr } = await admin
    .from('subscriptions')
    .insert({
      user_id: payment.user_id,
      plan_tier: planTier,
      status: 'active',
      started_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      auto_renew: true,
      payment_provider: 'tosspayments',
      provider_subscription_id: payment.toss_payment_key ?? payment.toss_order_id,
    })
    .select('id')
    .single();

  if (subErr || !sub) {
    throw new Error(`subscription insert failed: ${subErr?.message ?? 'unknown'}`);
  }

  const subId = (sub as { id: string }).id;

  const { error: linkErr } = await admin
    .from('payments')
    .update({ subscription_id: subId })
    .eq('id', payment.id);

  if (linkErr) {
    throw new Error(`payment subscription_id link failed: ${linkErr.message}`);
  }

  return subId;
}

/**
 * 구독 entitlement 적용: users.plan_tier 갱신 + entitlement_granted_at 마킹.
 * plan_tier 업데이트는 idempotent 라 재호출 시에도 안전.
 */
async function applySubscriptionEntitlement(
  admin: AdminClient,
  payment: PaymentRowLike,
): Promise<void> {
  const planTier = payment.plan_tier as PlanTier;
  const { error: userUpdateErr } = await admin
    .from('users')
    .update({ plan_tier: planTier })
    .eq('id', payment.user_id);

  if (userUpdateErr) {
    throw new Error(`users.plan_tier update failed: ${userUpdateErr.message}`);
  }

  const { error: markErr } = await admin
    .from('payments')
    .update({ entitlement_granted_at: new Date().toISOString() })
    .eq('id', payment.id);

  if (markErr) {
    await reportAlert({
      severity: 'high',
      source: 'payments/confirm',
      message: 'entitlement_granted_at 마킹 실패 — plan_tier 는 이미 적용',
      payload: { paymentId: payment.id, error: markErr.message },
    });
  }
}

/**
 * 크레딧 entitlement 적용: apply_payment_credit_bonus RPC (트랜잭션 안전).
 */
async function applyCreditEntitlement(
  admin: AdminClient,
  paymentId: string,
): Promise<void> {
  const { error } = await admin.rpc('apply_payment_credit_bonus', {
    p_payment_id: paymentId,
  });
  if (error) {
    throw new Error(`apply_payment_credit_bonus failed: ${error.message}`);
  }
}

/**
 * approved 결제의 누락 entitlement 재시도. (status==='approved' 인 경우만 호출.)
 */
async function reconcileApprovedEntitlement(
  admin: AdminClient,
  payment: PaymentRowLike,
): Promise<void> {
  if (isSubscriptionKind(payment.kind)) {
    await ensureSubscription(admin, payment);
    await applySubscriptionEntitlement(admin, payment);
    return;
  }
  if (isCreditKind(payment.kind)) {
    await applyCreditEntitlement(admin, payment.id);
    return;
  }
  await admin
    .from('payments')
    .update({ entitlement_granted_at: new Date().toISOString() })
    .eq('id', payment.id);
}

/**
 * Toss DONE 응답을 기준으로 payments + subscription + entitlement 를 전체 reconcile.
 *
 * 호출 컨텍스트:
 *   - fresh 첫 호출의 confirm 성공 직후
 *   - pending/failed + 토스 trace 가 있어서 getPayment 으로 상태가 DONE 임을 확인한 직후
 *   - confirm 이 ALREADY_PROCESSED_PAYMENT 로 실패했지만 getPayment 으로 DONE 임을 확인한 직후
 *
 * 모든 단계가 idempotent: subscription 은 이미 있으면 재사용, plan_tier 는 같은 값으로 set,
 * apply_payment_credit_bonus 는 entitlement_granted_at NOT NULL 이면 no-op.
 */
async function applyFullReconciliation(
  admin: AdminClient,
  payment: PaymentRowLike,
  tossResp: TossPaymentResponse,
): Promise<{ subscriptionId: string | null }> {
  const isSub = isSubscriptionKind(payment.kind);
  const isCredit = isCreditKind(payment.kind);

  let subscriptionId: string | null = payment.subscription_id;

  if (isSub) {
    subscriptionId = await ensureSubscription(admin, {
      ...payment,
      toss_payment_key: tossResp.paymentKey,
    });
  }

  const { error: payUpdateErr } = await admin
    .from('payments')
    .update({
      status: 'approved',
      toss_payment_key: tossResp.paymentKey,
      approved_at: tossResp.approvedAt ?? new Date().toISOString(),
      raw_response: tossResp as unknown as Record<string, unknown>,
      failure_reason: null,
      ...(subscriptionId ? { subscription_id: subscriptionId } : {}),
    })
    .eq('id', payment.id);

  if (payUpdateErr) {
    await reportAlert({
      severity: 'critical',
      source: 'payments/confirm',
      message: 'payments update 실패 — 토스 DONE 확인됨, entitlement 미적용',
      payload: {
        paymentId: payment.id,
        subscriptionId,
        error: payUpdateErr.message,
      },
    });
    throw new ApiException(
      'payment_persist_failed',
      '결제 상태 저장에 실패했습니다. 잠시 후 다시 시도하세요.',
      500,
    );
  }

  try {
    if (isSub) {
      await applySubscriptionEntitlement(admin, {
        ...payment,
        subscription_id: subscriptionId,
        status: 'approved',
        toss_payment_key: tossResp.paymentKey,
      });
    } else if (isCredit) {
      await applyCreditEntitlement(admin, payment.id);
    } else {
      await admin
        .from('payments')
        .update({ entitlement_granted_at: new Date().toISOString() })
        .eq('id', payment.id);
    }
  } catch (e) {
    await reportAlert({
      severity: 'critical',
      source: 'payments/confirm',
      message: 'entitlement 적용 실패 — 재호출 시 reconcile 가능',
      payload: {
        paymentId: payment.id,
        userId: payment.user_id,
        kind: payment.kind,
        subscriptionId,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    throw new ApiException(
      'entitlement_failed',
      '결제는 승인됐으나 혜택 적용에 실패했습니다. 잠시 후 다시 시도하세요.',
      500,
    );
  }

  return { subscriptionId };
}

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const body = bodySchema.parse(await request.json());

  const admin = createAdminClient();

  // 1) payments 행 조회 + 기본 정합성 확인
  const { data: paymentRaw, error: fetchErr } = await admin
    .from('payments')
    .select('*')
    .eq('toss_order_id', body.order_id)
    .maybeSingle();

  if (fetchErr || !paymentRaw) {
    throw new ApiException('payment_not_found', '결제 정보를 찾을 수 없습니다.', 404);
  }
  const payment = paymentRaw as unknown as PaymentRowLike;

  if (payment.user_id !== session.userId) {
    throw new ApiException('forbidden', '본인 결제만 승인 가능합니다.', 403);
  }
  if (payment.amount_krw !== body.amount) {
    throw new ApiException('amount_mismatch', '결제 금액이 일치하지 않습니다.', 400);
  }

  // 2) 이미 approved 인 결제 — entitlement reconciliation 만 시도
  if (payment.status === 'approved') {
    let reconciled = false;

    if (!payment.entitlement_granted_at) {
      try {
        await reconcileApprovedEntitlement(admin, payment);
        reconciled = true;
      } catch (e) {
        await reportAlert({
          severity: 'critical',
          source: 'payments/confirm',
          message: 'approved 결제의 entitlement reconcile 실패',
          payload: {
            paymentId: payment.id,
            userId: session.userId,
            kind: payment.kind,
            error: e instanceof Error ? e.message : String(e),
          },
        });
        throw new ApiException(
          'entitlement_pending',
          '결제는 승인됐으나 혜택 적용이 진행 중입니다. 잠시 후 다시 시도하거나 운영팀에 문의하세요.',
          500,
        );
      }
    }

    const { data: latest } = await admin
      .from('payments')
      .select('subscription_id, kind, plan_tier, credit_amount, entitlement_granted_at')
      .eq('id', payment.id)
      .single();

    const latestRow = (latest ?? payment) as unknown as PaymentRowLike;
    return ok({
      already_approved: true,
      reconciled,
      payment_id: payment.id,
      subscription_id: latestRow.subscription_id,
      kind: latestRow.kind,
      plan_tier: latestRow.plan_tier,
      credit_amount: latestRow.credit_amount,
    });
  }

  // 3) status 가 pending/failed 인데 토스 승인 흔적이 남아 있는 경우
  //    confirm 재호출 대신 getPayment 으로 실제 상태를 확인해 reconcile.
  //    "확정된 결제를 failed 로 덮어쓰는 사고" 차단.
  if (hasTossTrace(payment)) {
    const tossKey = payment.toss_payment_key ?? body.payment_key;
    let tossResp: TossPaymentResponse;
    try {
      tossResp = await getPayment(tossKey);
    } catch (e) {
      await reportAlert({
        severity: 'critical',
        source: 'payments/confirm',
        message: 'Toss 결제 조회 실패 — 사용자에게 임시 응답',
        payload: {
          paymentId: payment.id,
          userId: session.userId,
          tossKey,
          error: e instanceof Error ? e.message : String(e),
        },
      });
      throw new ApiException(
        'toss_status_unknown',
        '결제 상태를 확인할 수 없습니다. 잠시 후 다시 시도하세요.',
        500,
      );
    }

    if (tossResp.status === 'DONE') {
      const { subscriptionId } = await applyFullReconciliation(
        admin,
        payment,
        tossResp,
      );
      return ok({
        recovered: true,
        payment_id: payment.id,
        subscription_id: subscriptionId,
        kind: payment.kind,
        plan_tier: payment.plan_tier,
        credit_amount: payment.credit_amount,
        approved_at: tossResp.approvedAt ?? new Date().toISOString(),
      });
    }

    if (
      tossResp.status === 'CANCELED' ||
      tossResp.status === 'PARTIAL_CANCELED' ||
      tossResp.status === 'ABORTED' ||
      tossResp.status === 'EXPIRED'
    ) {
      await admin
        .from('payments')
        .update({
          status: 'failed',
          failure_reason: `토스 상태: ${tossResp.status}`,
          raw_response: tossResp as unknown as Record<string, unknown>,
        })
        .eq('id', payment.id);
      throw new ApiException(
        'payment_not_completed',
        `결제가 완료되지 않았습니다 (${tossResp.status}).`,
        400,
      );
    }

    // READY / IN_PROGRESS / WAITING_FOR_DEPOSIT — 아직 진행 중
    throw new ApiException(
      'toss_in_progress',
      `결제가 아직 진행 중입니다 (${tossResp.status}). 잠시 후 다시 시도하세요.`,
      409,
    );
  }

  // 4) 처음 confirm 호출. toss_payment_key 를 먼저 기록해 Toss 시도 흔적 남김.
  //    (다음 재호출이 이 분기 대신 위의 'trace' 분기로 진입하도록 보장.)
  await admin
    .from('payments')
    .update({ toss_payment_key: body.payment_key })
    .eq('id', payment.id);

  let tossResp: TossPaymentResponse;
  try {
    tossResp = await confirmPayment({
      paymentKey: body.payment_key,
      orderId: body.order_id,
      amount: body.amount,
    });
  } catch (error) {
    // ALREADY_PROCESSED_PAYMENT — 토스에서 이미 승인된 결제. failed 로 덮지 않고
    // 실제 상태를 조회해 reconcile.
    const isAlreadyProcessed =
      error instanceof ApiException &&
      error.code === 'toss_ALREADY_PROCESSED_PAYMENT';

    if (isAlreadyProcessed) {
      let lookedUp: TossPaymentResponse;
      try {
        lookedUp = await getPayment(body.payment_key);
      } catch (lookupErr) {
        await reportAlert({
          severity: 'critical',
          source: 'payments/confirm',
          message: 'ALREADY_PROCESSED 후 getPayment 실패',
          payload: {
            paymentId: payment.id,
            userId: session.userId,
            error: lookupErr instanceof Error ? lookupErr.message : String(lookupErr),
          },
        });
        throw new ApiException(
          'toss_status_unknown',
          '결제 상태를 확인할 수 없습니다. 잠시 후 다시 시도하세요.',
          500,
        );
      }

      if (lookedUp.status !== 'DONE') {
        await reportAlert({
          severity: 'high',
          source: 'payments/confirm',
          message: 'ALREADY_PROCESSED 인데 토스 상태가 DONE 아님',
          payload: {
            paymentId: payment.id,
            tossStatus: lookedUp.status,
          },
        });
        throw new ApiException(
          'toss_status_mismatch',
          `결제 상태가 일치하지 않습니다 (${lookedUp.status}).`,
          500,
        );
      }

      const { subscriptionId } = await applyFullReconciliation(
        admin,
        payment,
        lookedUp,
      );
      return ok({
        recovered: true,
        payment_id: payment.id,
        subscription_id: subscriptionId,
        kind: payment.kind,
        plan_tier: payment.plan_tier,
        credit_amount: payment.credit_amount,
        approved_at: lookedUp.approvedAt ?? new Date().toISOString(),
      });
    }

    // 그 외 실패 — payment 를 failed 로 마킹. toss_payment_key 는 audit 용으로 유지.
    await admin
      .from('payments')
      .update({
        status: 'failed',
        failure_reason: error instanceof Error ? error.message : String(error),
      })
      .eq('id', payment.id);
    throw error;
  }

  // 5) Toss confirm 성공 — applyFullReconciliation 으로 일괄 처리.
  const { subscriptionId } = await applyFullReconciliation(
    admin,
    payment,
    tossResp,
  );

  return ok({
    payment_id: payment.id,
    subscription_id: subscriptionId,
    kind: payment.kind,
    plan_tier: payment.plan_tier,
    credit_amount: payment.credit_amount,
    approved_at: tossResp.approvedAt ?? new Date().toISOString(),
  });
});

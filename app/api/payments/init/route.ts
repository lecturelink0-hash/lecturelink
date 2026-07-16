/**
 * POST /api/payments/init
 *
 * 결제 초기화. 토스 위젯이 호출할 orderId·amount·orderName 발급.
 *
 * 클라이언트는 응답값을 받아 토스 SDK 의 `requestPayment` 에 전달.
 *
 * Body:
 *   - 구독: { kind: 'subscription', plan_tier: 'lite'|'standard'|'pro' }
 *   - 크레딧: { kind: 'credit', credit_kind: 'questions'|'images'|'uploads' }
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import {
  generateOrderId,
  PLAN_PRICES,
  CREDIT_PRICES,
  type CreditKind,
} from '@/lib/payment/toss';
import { ok, withErrorHandling } from '@/lib/utils/api';
import type { PlanTier } from '@/lib/types/database';

const bodySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('subscription'),
    plan_tier: z.enum(['lite', 'standard', 'pro']),
  }),
  z.object({
    kind: z.literal('credit'),
    credit_kind: z.enum(['questions', 'images', 'uploads']),
  }),
]);

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const body = bodySchema.parse(await request.json());

  let amount: number;
  let orderName: string;
  let orderIdPrefix: 'sub' | 'cred';
  let dbInsert: Record<string, unknown>;

  if (body.kind === 'subscription') {
    amount = PLAN_PRICES[body.plan_tier as Exclude<PlanTier, 'free'>];
    orderName = `MedAI Learning — ${body.plan_tier.toUpperCase()} 월 구독`;
    orderIdPrefix = 'sub';
    dbInsert = {
      kind: 'subscription_initial',
      plan_tier: body.plan_tier,
      amount_krw: amount,
    };
  } else {
    const credit = CREDIT_PRICES[body.credit_kind as CreditKind];
    amount = credit.price_krw;
    const kindLabel: Record<CreditKind, string> = {
      questions: '문항',
      images: '이미지 문항',
      uploads: '자료 업로드',
    };
    orderName = `${kindLabel[body.credit_kind as CreditKind]} 크레딧 ${credit.amount}회`;
    orderIdPrefix = 'cred';
    dbInsert = {
      kind: `credit_${body.credit_kind}`,
      amount_krw: amount,
      credit_amount: credit.amount,
    };
  }

  const orderId = generateOrderId(orderIdPrefix);

  // payments 행 생성 (pending)
  const admin = createAdminClient();
  const { error: insertErr } = await admin.from('payments').insert({
    ...dbInsert,
    user_id: session.userId,
    toss_order_id: orderId,
    status: 'pending',
  });

  if (insertErr) throw insertErr;

  return ok({
    order_id: orderId,
    amount,
    order_name: orderName,
    customer_email: session.email,
    success_url: `${process.env.NEXT_PUBLIC_APP_URL}/payments/success`,
    fail_url: `${process.env.NEXT_PUBLIC_APP_URL}/payments/fail`,
    client_key: process.env.TOSSPAYMENTS_CLIENT_KEY,
  });
});

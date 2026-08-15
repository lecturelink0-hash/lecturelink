/**
 * POST /api/me/subscription/cancel
 *
 * 자동 갱신 해제. 만료일까지는 사용 가능, 그 후 free 로 다운그레이드.
 * 즉시 환불은 별도 엔드포인트(미구현 — 운영 단계 추가).
 */

import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { createAdminClient } from '@/lib/db/admin';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
import { z } from 'zod';

const cancellationSchema = z.object({
  reason: z.enum([
    'price',
    'low_usage',
    'missing_features',
    'temporary_break',
    'other',
    'prefer_not_to_say',
  ]).optional(),
});

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const { reason } = cancellationSchema.parse(await request.json().catch(() => ({})));
  const supabase = await createServerClient();

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('id, plan_tier, status, auto_renew')
    .eq('user_id', session.userId)
    .eq('status', 'active')
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!sub || sub.plan_tier === 'free') {
    throw new ApiException(
      'no_active_subscription',
      '활성 구독이 없습니다.',
      404,
    );
  }

  if (!sub.auto_renew) {
    return ok({ already_cancelled: true });
  }

  const admin = createAdminClient();
  const cancelledAt = new Date().toISOString();
  const { error } = await admin
    .from('subscriptions')
    .update({
      auto_renew: false,
      cancellation_reason: reason ?? null,
      cancelled_at: cancelledAt,
    })
    .eq('id', sub.id);

  // The essential cancellation action must remain available while the optional
  // feedback migration is waiting to be applied.
  if (error?.code === '42703') {
    const { error: fallbackError } = await admin
      .from('subscriptions')
      .update({ auto_renew: false })
      .eq('id', sub.id);

    if (fallbackError) {
      throw new ApiException('subscription_cancel_failed', '구독 해지 처리에 실패했습니다. 잠시 뒤 다시 시도해 주세요.', 503);
    }

    return ok({ cancelled: true, feedback_pending_migration: true });
  }

  if (error) {
    throw new ApiException('subscription_cancel_failed', '구독 해지 처리에 실패했습니다. 잠시 후 다시 시도해주세요.', 503);
  }

  return ok({ cancelled: true });
});

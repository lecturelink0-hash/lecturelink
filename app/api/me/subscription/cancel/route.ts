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

/**
 * "컬럼이 없다"를 나타내는 오류 코드 — 계층에 따라 다르다. 2026-08-16 프로덕션 실측:
 *
 *   SELECT 에 없는 컬럼      → Postgres 가 판정        → 42703 (undefined_column)
 *   UPDATE 본문에 없는 컬럼  → PostgREST 가 선차단     → PGRST204
 *                              ("Could not find the 'x' column of 'y' in the schema cache")
 *
 * 이 라우트의 실패 지점은 UPDATE 다. 그래서 42703 만 보던 기존 조건은 **한 번도 매칭되지
 * 않았고**, 아래 폴백은 사문이었다 — 마이그레이션 00038 미적용 상태에서 해지 요청은
 * 폴백을 타지 못한 채 503 으로 떨어졌고, auto_renew 가 true 로 남아 자동결제가 계속됐다.
 * 00038 을 적용해도 이 폴백은 남겨 둔다: 부트스트랩 스냅샷으로 세운 새 환경에서
 * 같은 함정이 그대로 재발하기 때문이다.
 */
const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204']);

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
  if (error && MISSING_COLUMN_CODES.has(error.code)) {
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

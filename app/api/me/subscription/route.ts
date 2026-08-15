/**
 * GET /api/me/subscription — 현재 구독 정보 조회
 */

import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling } from '@/lib/utils/api';

export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  const supabase = await createServerClient();

  const subscriptionQuery = supabase
    .from('subscriptions')
    .select('id, plan_tier, status, started_at, expires_at, auto_renew, cancellation_reason, cancelled_at')
    .eq('user_id', session.userId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await subscriptionQuery;

  // Keep the management screen available before the optional cancellation
  // feedback migration has been applied to this environment.
  if (error?.code === '42703') {
    const { data: legacyData, error: legacyError } = await supabase
      .from('subscriptions')
      .select('id, plan_tier, status, started_at, expires_at, auto_renew')
      .eq('user_id', session.userId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (legacyError) throw legacyError;

    return ok({
      subscription: legacyData
        ? { ...legacyData, cancellation_reason: null, cancelled_at: null }
        : null,
      plan_tier: session.profile.planTier,
    });
  }

  if (error) throw error;

  return ok({
    subscription: data,
    plan_tier: session.profile.planTier,
  });
});

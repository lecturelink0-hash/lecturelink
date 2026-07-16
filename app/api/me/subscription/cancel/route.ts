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

export const POST = withErrorHandling(async () => {
  const session = await requireSession();
  const supabase = await createServerClient();

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('id, status, auto_renew')
    .eq('user_id', session.userId)
    .eq('status', 'active')
    .maybeSingle();

  if (!sub) {
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
  await admin
    .from('subscriptions')
    .update({ auto_renew: false })
    .eq('id', sub.id);

  return ok({ cancelled: true });
});

/**
 * GET /api/me/quota — 현재 월 사용량 + 한도 조회
 *
 * UI 의 사용량 게이지·잔여 표시에 사용.
 */

import { requireSession } from '@/lib/auth/session';
import { checkQuota } from '@/lib/quota/check';
import { ok, withErrorHandling } from '@/lib/utils/api';

export const GET = withErrorHandling(async () => {
  const session = await requireSession();

  // 3개 리소스 병렬 조회.
  // amount=1 로 호출 — 본 엔드포인트는 limit/used/bonus/remaining 표시만 사용하므로
  // amount 값은 반환되는 표시값에 영향이 없다. (ok 플래그는 무시한다.)
  // 00016 입력 검증에서 p_amount<=0 은 예외이므로 amount=0 은 사용 불가.
  const [questions, uploads, images] = await Promise.all([
    checkQuota(session.userId, 'questions', 1),
    checkQuota(session.userId, 'uploads', 1),
    checkQuota(session.userId, 'images', 1),
  ]);

  return ok({
    plan_tier: session.profile.planTier,
    // 개발단계 모의고사 티어 해제 여부(클라 잠금 UI 판단용).
    mock_unlocked: process.env.MOCK_UNLOCKED === 'true',
    questions: {
      limit: questions.limit,
      used: questions.used,
      bonus: questions.bonus,
      remaining: questions.remaining,
    },
    uploads: {
      limit: uploads.limit,
      used: uploads.used,
      bonus: uploads.bonus,
      remaining: uploads.remaining,
    },
    images: {
      limit: images.limit,
      used: images.used,
      bonus: images.bonus,
      remaining: images.remaining,
    },
  });
});

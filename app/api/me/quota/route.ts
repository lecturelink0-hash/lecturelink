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
  //
  // images 는 더 이상 조회하지 않는다: 이미지 문항 별도 한도가 2026-08-14 정책으로
  // 폐지되어 앱 어디에서도 차감되지 않고, 이 값을 보여주던 요금제 페이지의 바도 없앴다.
  // 남겨두면 요청마다 쓰지 않는 RPC 왕복이 한 번 더 생긴다.
  const [questions, uploads, cpxSeconds] = await Promise.all([
    checkQuota(session.userId, 'questions', 1),
    checkQuota(session.userId, 'uploads', 1),
    checkQuota(session.userId, 'cpx_seconds', 1),
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
    // CPX 이용 시간(초) — 시간 차감 정책 v1.0. 화면 표시는 분 단위로 환산해 사용할 것.
    cpx_seconds: {
      limit: cpxSeconds.limit,
      used: cpxSeconds.used,
      bonus: cpxSeconds.bonus,
      remaining: cpxSeconds.remaining,
    },
  });
});

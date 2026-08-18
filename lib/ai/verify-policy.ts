/**
 * 검증 결과를 "버릴 것인가"로 바꾸는 정책 — 순수 함수만 둔다.
 *
 * 왜 verify.ts 가 아니라 별도 파일인가: verify.ts 는 Anthropic SDK·Supabase 까지 끌고
 * 오므로 스크립트에서 import 하면 모듈 해석부터 실패한다. 판정 기준은 회귀 검사가
 * 반드시 잡아야 하는 결정(수정 보고서 ② P1)이라, 무거운 의존 없는 잎 모듈에 둬서
 * `npm run check:verify` 가 네트워크·API 키 없이 검사할 수 있게 한다.
 * (같은 이유로 정답 셔플은 kmle-format.ts 에 있다.)
 */

export type VerificationSeverity = 'none' | 'minor' | 'major' | 'critical';

/** private 모드 폐기 기준 점수. 이보다 낮으면 severity 와 무관하게 폐기 후보. */
export const PRIVATE_VERIFY_REJECT_SCORE = 0.6;

/**
 * private(내신) 검증 결과가 폐기 후보인가.
 *
 * 결정(수정 보고서 ② P1): **severity 가 critical/major 이거나 score 가 기준 미만.**
 * 둘은 서로를 보정하지 않는다 — 모델이 major 라고 말하면서 0.8 을 주는 경우가 실제로
 * 있어서, 한쪽만 걸려도 후보로 본다. 기준을 호출부에 흩어 두면 "무엇을 버리기로
 * 했는지"가 코드마다 달라지므로 여기 한 곳에만 둔다.
 */
export function isPrivateVerifyFailure(
  verdict: { severity: VerificationSeverity; score: number },
  rejectScore: number = PRIVATE_VERIFY_REJECT_SCORE,
): boolean {
  if (verdict.severity === 'critical' || verdict.severity === 'major') return true;
  return Number(verdict.score) < rejectScore;
}

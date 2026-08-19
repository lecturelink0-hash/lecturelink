/**
 * "그림 없이도 풀리는가"를 폐기 판정으로 바꾸는 정책 — 순수 함수만 둔다 (P9).
 *
 * 왜 별도 파일인가: blind-solve.ts 는 Anthropic/Gemini SDK 를 끌고 오므로 스크립트에서
 * import 하면 모듈 해석부터 실패한다. verify-policy.ts 와 같은 이유·같은 모양이다 —
 * 판정 기준은 회귀 검사가 반드시 지켜야 하는 결정이라 무거운 의존이 없는 잎 모듈에 둔다.
 *
 * 왜 필요한가 (2026-08-18 감사)
 * ────────────────────────────
 * 이미지형 문항이 그림을 안 봐도 풀리는 문제는 프롬프트의 "가림 검사"(이 이미지를 빼도
 * 풀 수 있는가 자문하라)로 막게 돼 있었다. 그런데 그건 **모델의 자기점검**이라
 * 실물에서 그대로 재발했다("뇌 단면도 … 설명으로 옳은 것은?"). 자기 답을 자기가
 * 채점하는 구조는 통과율이 100 %에 수렴한다. 판정을 실측으로 바꾼다 —
 * 그림을 빼고 실제로 풀려 본다.
 */

/** 블라인드 시도 횟수. 늘리면 오탐은 줄고 비용·지연이 는다. */
export const BLIND_ATTEMPTS = 2;

/**
 * 그림 없이 푼 결과가 "그림이 필요 없는 문항"이라는 증거인가.
 *
 * 결정(수정 보고서 ② P9): **독립 시도 전부가 정답일 때만** 참이다.
 *
 * 왜 전부인가 — 5지선다의 우연 정답률은 20 %다. 1회만 보면 멀쩡한 이미지 문항 5개 중
 * 1개를 찍기로 잃는다. 2회 모두 맞을 확률은 4 %라 폐기 대가(이미지형 부족 생성)에
 * 견줄 만하다. 반대로 "과반"으로 완화하면 3회 중 2회(우연 10 % 이상)가 되어 1회와
 * 크게 다르지 않다 — 전부/일부의 경계를 느슨하게 두면 이 검사는 다시 장식이 된다.
 *
 * 시도가 하나라도 실패(null)하면 판단하지 않는다 — 검증(P1)과 같은 가용성 원칙이다.
 * 못 돌린 검사가 문항을 버리는 근거가 되어서는 안 된다.
 */
export function isBlindSolvable(
  picks: ReadonlyArray<number | null>,
  answerIndex: number,
  attempts: number = BLIND_ATTEMPTS,
): boolean {
  if (picks.length < attempts) return false;
  const used = picks.slice(0, attempts);
  if (used.some((p) => p === null || p === undefined)) return false;
  return used.every((p) => p === answerIndex);
}

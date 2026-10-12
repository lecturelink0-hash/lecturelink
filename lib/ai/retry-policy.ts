/**
 * 429 응답을 "기다려도 풀리지 않는 소진"과 "잠깐 뒤 풀리는 용량 부족"으로 가른다.
 *
 * 크레딧 소진·결제 문제·쿼터 초과는 시간이 지나도 그대로라 재시도하면 시간만 쓴다(실측: Vision 25페이지 207초).
 * 반대로 Gemini 가 할당량 정보 없이 돌려주는 `RESOURCE_EXHAUSTED`("Resource has been exhausted (e.g. check quota).")는
 * 모델 쪽 처리 용량 부족이라 잠시 뒤 풀린다. 2026-10-05~06 에 gemini-2.5-flash 가 크레딧·프로젝트 할당량과 무관하게
 * 이 응답을 몇 시간 동안 섞어 돌려줬는데, 상태값 `RESOURCE_EXHAUSTED` 만 보고 영구 소진으로 분류해 묶음이 재시도 없이
 * 바로 실패했다. 그래서 상태값이 아니라 문구로만 판단한다.
 *
 * 외부 모듈을 불러오지 않는다 — 검사 스크립트(`npm run check:retry`)가 이 파일을 직접 불러온다.
 */

/** 이 문구가 있으면 기다려도 안 풀리는 429 로 본다(소문자 비교). */
export const PERMANENT_429_MARKERS = [
  'credit', // "Your prepayment credits are depleted"
  'prepayment',
  'billing', // "check your plan and billing details", "billing account disabled"
  'quota exceeded', // "Quota exceeded for metric: …"
  'exceeded your current quota',
  'insufficient',
] as const;

/** 429 응답 문구가 크레딧·결제·쿼터 소진을 말하면 true. 할당량 정보가 없는 일시적 용량 부족은 false. */
export function isPermanentQuota429Message(message: string): boolean {
  const msg = String(message ?? '').toLowerCase();
  return PERMANENT_429_MARKERS.some((m) => msg.includes(m));
}

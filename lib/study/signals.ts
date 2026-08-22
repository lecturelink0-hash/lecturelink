/**
 * 학습 신호 수집의 공유 상수 (분담표 A14 · 가이드 §8.1)
 *
 * 클라이언트(측정)와 서버(판정)가 같은 값을 써야 한다. 각자 두면 한쪽만 고쳤을 때
 * "3초 봤는데 안 읽은 것으로 기록됨" 같은 조용한 불일치가 생긴다.
 *
 * 라우트 파일에 두지 않는 이유: Next.js 는 route.ts 의 export 를 정해진 것(GET/POST/
 * dynamic/runtime…)으로 제한한다. 상수를 export 하면 빌드가 거절한다.
 */

/** 해설이 이 시간 이상 화면에 보였으면 읽은 것으로 본다. 스쳐 지나간 것과 구분하는 선. */
export const EXPLANATION_VIEWED_MS = 3000;

/** 누적 노출 시간 상한. 탭을 켜 둔 채 자리를 비운 세션이 몰입도를 왜곡하지 않게. */
export const MAX_EXPLANATION_DWELL_MS = 10 * 60 * 1000;

/** 확신도 척도 — 1(잘 모르겠음) ~ 3(확실함). */
export const CONFIDENCE_MIN = 1;
export const CONFIDENCE_MAX = 3;

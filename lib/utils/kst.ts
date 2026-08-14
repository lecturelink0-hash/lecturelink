/**
 * KST 날짜 유틸 — 학습 기록은 전부 KST 기준으로 집계·표시한다.
 *
 * user_attempts 집계(study-calendar API)가 KST로 그룹핑되므로, 클라이언트의
 * '오늘'·연속 학습(streak)·D-day 계산도 브라우저 로컬 타임존이 아닌 KST를 쓴다.
 * 대시보드·마이페이지·API가 공유하는 단일 구현.
 */

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MS_PER_DAY = 86_400_000;

/** ISO 문자열(또는 Date)을 KST 기준 'YYYY-MM-DD' 키로 변환. */
export function kstDateKey(input: string | Date): string {
  const time = typeof input === 'string' ? new Date(input) : input;
  return new Date(time.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 오늘(KST)의 'YYYY-MM-DD' 키. */
export function kstTodayKey(): string {
  return kstDateKey(new Date());
}

/** 'YYYY-MM-DD' 키를 UTC 자정 ms 로 — 날짜 키 산술 전용(타임존 무관). */
function keyToMs(dateKey: string): number {
  return Date.parse(`${dateKey}T00:00:00Z`);
}

function msToKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 날짜 키를 deltaDays 만큼 이동한 키. */
export function shiftDateKey(dateKey: string, deltaDays: number): string {
  return msToKey(keyToMs(dateKey) + deltaDays * MS_PER_DAY);
}

/** target − base 일수 차 (둘 다 'YYYY-MM-DD'). D-day 계산용. */
export function diffDayKeys(target: string, base: string): number {
  return Math.round((keyToMs(target) - keyToMs(base)) / MS_PER_DAY);
}

/**
 * 활동한 날짜 키 집합에서 오늘(KST) 기준 연속 학습일 수.
 * 오늘 기록이 없으면 어제부터 소급해 센다(오늘 아직 안 풀었어도 streak 유지).
 */
export function calcStreak(activeDateKeys: Iterable<string>, todayKey = kstTodayKey()): number {
  const active = activeDateKeys instanceof Set ? activeDateKeys : new Set(activeDateKeys);
  let cursor = keyToMs(todayKey);
  if (!active.has(msToKey(cursor))) cursor -= MS_PER_DAY;

  let streak = 0;
  while (active.has(msToKey(cursor))) {
    streak += 1;
    cursor -= MS_PER_DAY;
  }
  return streak;
}

/** 초 → "N시간 M분" (한 시간 미만은 "M분", 0이면 "0분"). */
export function formatStudyTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours > 0 ? `${hours}시간 ${remaining}분` : `${remaining}분`;
}

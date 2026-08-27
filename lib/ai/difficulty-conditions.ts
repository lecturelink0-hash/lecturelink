/**
 * 난이도의 조작적 정의를 **셀 수 있는 것**으로 만든다 — 순수 함수만 둔다(잎 모듈, import 없음).
 * 회귀 검사 `npm run check:difficulty`.
 *
 * 왜 필요한가 (2026-08-27 실측, 업로드 effbfdf0 — 난이도 '상' 10문항)
 * ────────────────────────────────────────────────────────────
 * 모델은 10문항 중 7문항에 difficulty 3 을 신고했지만, 실물은 전부 사실 하나를 묻는
 * 재인 문항이었다("가성 동맥류의 기전은?", "수술을 고려하는 직경 기준은?").
 * 사용자 정의의 '상'은 **"3가지 이상의 조건·지식을 결합해야 풀리는 문항"** 이다.
 *
 * 종전 구조의 문제 두 가지:
 *  1. 프롬프트의 '상' 정의가 "비전형·수치 해석·2단계 추론·예외 중 **하나**를 포함"이었다 —
 *     사용자 정의와 반대 방향(하나만 있어도 상). 모델의 3 신고는 그 정의로는 정직했다.
 *  2. 난이도는 숫자 자기신고뿐이라 서버가 대조할 근거가 없었다. "자기 답을 자기가 채점하는
 *     검사는 통과율 100 %로 수렴한다"(블라인드 풀이에서 배운 것) — 숫자 하나가 바로 그것이다.
 *
 * 이제 모델이 **정답을 확정하는 데 결합해야 하는 서로 다른 조건·지식을 목록으로** 신고하고,
 * 서버는 그 목록의 고유 항목 수로 수준을 계산한다. 목록은 숫자보다 꾸며내기 어렵고,
 * 목록을 채우려면 문항 자체가 그 조건들을 담아야 한다.
 */

export type DifficultyLevel = 1 | 2 | 3;

/** 각 수준이 요구하는 "결합해야 하는 조건·지식"의 최소 개수. */
export const CONDITIONS_REQUIRED: Readonly<Record<DifficultyLevel, number>> = { 1: 1, 2: 2, 3: 3 };

/** 비교용 정규화 — 공백·구두점을 지우고 소문자로. */
export function normalizeCondition(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 한 항목이 "조건"으로 셀 만큼 실질이 있는가(정규화 후 4자 이상). */
const MIN_CONDITION_CHARS = 4;

/**
 * 서로 다른 조건·지식의 수.
 *
 *  - 문자열이 아닌 항목·너무 짧은 항목은 세지 않는다.
 *  - 한 항목이 다른 항목에 포함되면(부분 문자열) 같은 조건을 쪼갠 것으로 보고 하나로 센다 —
 *    "혈압 180/100" 과 "혈압 180/100 mmHg 로 상승" 은 한 조건이다.
 */
export function countDistinctConditions(list: unknown): number {
  if (!Array.isArray(list)) return 0;
  const items = list
    .filter((x): x is string => typeof x === 'string')
    .map(normalizeCondition)
    .filter((s) => s.length >= MIN_CONDITION_CHARS);
  // 긴 것부터 보며, 이미 남긴 항목에 포함되는 것은 버린다.
  const kept: string[] = [];
  for (const s of [...items].sort((a, b) => b.length - a.length)) {
    if (kept.some((k) => k.includes(s))) continue;
    kept.push(s);
  }
  return kept.length;
}

/** 조건 수 → 수준(1=재인, 2=적용, 3=분석). */
export function levelFromConditions(count: number): DifficultyLevel {
  if (count >= CONDITIONS_REQUIRED[3]) return 3;
  if (count >= CONDITIONS_REQUIRED[2]) return 2;
  return 1;
}

/**
 * 저장할 난이도. 모델 신고값과 조건 수 기반 수준 중 **낮은 쪽**이다.
 *
 * 신고값을 그대로 쓰면 "3 이라고 적었지만 조건은 하나"인 문항이 상으로 저장된다.
 * 조건 수만 쓰면 목록을 부풀린 문항이 상이 된다. 둘 다 통과해야 상이다.
 */
export function effectiveDifficulty(reported: unknown, conditions: unknown): DifficultyLevel {
  const r = Number(reported);
  const reportedLevel: DifficultyLevel = r >= 3 ? 3 : r >= 2 ? 2 : 1;
  const structural = levelFromConditions(countDistinctConditions(conditions));
  return (Math.min(reportedLevel, structural) as DifficultyLevel);
}

/** 요청 수준을 만족하는가 — 구조(조건 수)로만 판정한다(신고값은 여기서 보지 않는다). */
export function meetsRequestedLevel(conditions: unknown, requested: DifficultyLevel): boolean {
  return countDistinctConditions(conditions) >= CONDITIONS_REQUIRED[requested];
}

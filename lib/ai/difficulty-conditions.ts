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
 * 서버는 그 목록의 고유 항목 수로 수준을 계산한다.
 *
 * 2차 실측(01ae08ab, #269 배포 후): 목록 도입으로 저장 난이도 3 이 9/10 이 됐지만 사람이 읽으면
 * 진짜 3조건은 4/10 이었다 — "금기 약물은?"에도 조건 3개가 적혀 있었다. **목록도 부풀려진다.**
 * 그래서 두 겹을 더 둔다.
 *  · 어휘 대조(anchoring): 발문·선지·해설 어디에도 흔적이 없는 항목은 세지 않는다.
 *  · 독립 판정기(condition-judge.ts): 생성 모델의 목록을 보지 않는 별도 호출이 문항만 보고
 *    조건을 센다. 최종 구조 수준 = min(대조 통과 자기신고 수, 판정기 수).
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

/** 문자열 항목만 남기고 정규화한 뒤, 부분 문자열 중복을 하나로 합친다. */
function distinctNormalized(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
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
  return kept;
}

/**
 * 서로 다른 조건·지식의 수.
 *
 *  - 문자열이 아닌 항목·너무 짧은 항목은 세지 않는다.
 *  - 한 항목이 다른 항목에 포함되면(부분 문자열) 같은 조건을 쪼갠 것으로 보고 하나로 센다 —
 *    "혈압 180/100" 과 "혈압 180/100 mmHg 로 상승" 은 한 조건이다.
 */
export function countDistinctConditions(list: unknown): number {
  return distinctNormalized(list).length;
}

/**
 * 어휘 대조용 토큰. 한글 2자 이상 연속, 라틴 3자 이상, 숫자(소수점·단위 포함).
 * 조사가 붙은 한글 어절("혈압이")은 앞 2자 이상 부분 문자열로 대조하므로 토큰을 잘게 쪼개지 않는다.
 */
const TOKEN_RE = /[가-힣]{2,}|[A-Za-z][A-Za-z-]{2,}|\d+(?:[.,]\d+)?/g;

/** 대조에서 제외할 흔한 말(어느 문항에나 있어 흔적의 증거가 못 된다). */
const STOP_TOKENS = new Set([
  '환자', '경우', '이상', '이하', '관련', '옳은', '것은', '다음', '아래', '위의', '대한', '설명', '진단', '치료',
  '검사', '소견', '기전', '원인', '가장', '적절', '필요', '있다', '없다', '한다', '이다', '되는', '하는', '으로',
  '에서', '조건', '지식', 'the', 'and', 'with', 'for',
]);

/** 조건 한 구절에서 대조 토큰을 뽑는다(소문자, 정지어 제외). */
export function conditionTokens(condition: string): string[] {
  const out = new Set<string>();
  for (const m of String(condition ?? '').toLowerCase().matchAll(TOKEN_RE)) {
    const t = m[0];
    if (STOP_TOKENS.has(t)) continue;
    // 한글 어절은 조사를 떼어 앞 2~4자로도 대조한다("대동맥판막의" → "대동맥판").
    // 잘라낸 앞부분이 정지어("치료가" → "치료")면 넣지 않는다 — 흔적의 증거가 못 된다.
    out.add(t);
    if (/^[가-힣]+$/.test(t) && t.length >= 3) {
      const head = t.slice(0, Math.min(4, t.length - 1));
      if (!STOP_TOKENS.has(head)) out.add(head);
    }
  }
  return [...out];
}

/**
 * 어휘 대조 — 조건 항목이 발문·선지·해설 어디엔가 실제로 있는가.
 *
 * 지문에 제시된 조건은 발문에, 풀이에 필요한 지식은 해설에(정답 근거를 설명하므로)
 * 흔적이 남아야 한다. 어디에도 없는 항목은 목록을 채우려고 지어낸 것으로 보고 세지 않는다.
 * 토큰 하나만 겹쳐도 통과시킨다 — 이 검사는 명백한 창작만 거르는 거친 체이고, 정밀한
 * 판정은 독립 판정기가 한다.
 */
export function isConditionAnchored(condition: string, texts: readonly string[]): boolean {
  const hay = texts.map((t) => String(t ?? '').toLowerCase()).join('\n');
  if (hay.trim().length === 0) return false;
  const tokens = conditionTokens(condition);
  if (tokens.length === 0) return false;
  return tokens.some((t) => hay.includes(t));
}

/** 어휘 대조를 통과한 서로 다른 조건의 수. */
export function countAnchoredConditions(list: unknown, texts: readonly string[]): number {
  if (!Array.isArray(list)) return 0;
  const anchored = list.filter(
    (c): c is string => typeof c === 'string' && isConditionAnchored(c, texts),
  );
  return countDistinctConditions(anchored);
}

/** 조건 수 → 수준(1=재인, 2=적용, 3=분석). */
export function levelFromConditions(count: number): DifficultyLevel {
  if (count >= CONDITIONS_REQUIRED[3]) return 3;
  if (count >= CONDITIONS_REQUIRED[2]) return 2;
  return 1;
}

/**
 * 구조적 조건 수 = min(자기신고(대조 통과) 수, 독립 판정기 수).
 *
 * 판정기가 판정하지 못했으면(null) 자기신고만 쓴다 — 못 돌린 검사가 문항을 깎는 근거가
 * 되어서는 안 된다(검증·블라인드와 같은 가용성 원칙).
 */
export function structuralConditionCount(
  selfReported: unknown,
  texts: readonly string[],
  judgeCount: number | null | undefined,
): number {
  const self = countAnchoredConditions(selfReported, texts);
  if (typeof judgeCount === 'number' && Number.isFinite(judgeCount)) {
    return Math.min(self, Math.max(0, Math.floor(judgeCount)));
  }
  return self;
}

/**
 * 저장할 난이도. 모델 신고값과 구조 수준 중 **낮은 쪽**이다.
 *
 * 신고값을 그대로 쓰면 "3 이라고 적었지만 조건은 하나"인 문항이 상으로 저장된다.
 * 조건 수만 쓰면 목록을 부풀린 문항이 상이 된다. 둘 다 통과해야 상이다.
 * texts·judgeCount 를 주면 어휘 대조·판정기까지 반영한다(생략하면 목록 수만 본다).
 */
export function effectiveDifficulty(
  reported: unknown,
  conditions: unknown,
  texts?: readonly string[],
  judgeCount?: number | null,
): DifficultyLevel {
  const r = Number(reported);
  const reportedLevel: DifficultyLevel = r >= 3 ? 3 : r >= 2 ? 2 : 1;
  const count = texts
    ? structuralConditionCount(conditions, texts, judgeCount)
    : countDistinctConditions(conditions);
  const structural = levelFromConditions(count);
  return (Math.min(reportedLevel, structural) as DifficultyLevel);
}

/** 요청 수준을 만족하는가 — 구조(조건 수)로만 판정한다(신고값은 여기서 보지 않는다). */
export function meetsRequestedLevel(
  conditions: unknown,
  requested: DifficultyLevel,
  texts?: readonly string[],
  judgeCount?: number | null,
): boolean {
  const count = texts
    ? structuralConditionCount(conditions, texts, judgeCount)
    : countDistinctConditions(conditions);
  return count >= CONDITIONS_REQUIRED[requested];
}

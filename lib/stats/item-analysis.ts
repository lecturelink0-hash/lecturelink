/**
 * 문항 통계 (성능지표 가이드 §8.1 · 분담표 A13)
 *
 * 가이드가 요구하는 지표:
 *   문항 정답률 · 선지별 선택률 · 문항 변별도 · point-biserial · KR-20
 *
 * **계산은 지금 가능하고, 의미는 학생이 들어와야 생긴다.** 그래서 표본이 임계 미만이면
 * 값을 감추지 않고 내되 `unstable: true` 로 표시한다. 감추면 "아직 없다"와 "0이다"가
 * 구분되지 않고, 그냥 내면 표본 3명짜리 변별도가 성능 주장으로 새어 나간다.
 *
 * import 를 두지 않는다 — scripts/check-item-stats.mjs 가 별칭 해석 없이 이 파일만 불러
 * 산식 회귀를 잡을 수 있어야 한다.
 */

export interface AttemptRecord {
  userId: string;
  itemId: string;
  selectedIndex: number;
  isCorrect: boolean;
  timeSpentSeconds?: number | null;
  /** 풀이 시점 확신도 1(낮음)~3(높음). null/undefined = 미응답 (분담표 A14). */
  confidence?: number | null;
}

/** 가이드가 권장하는 문항당 최소 표본. 이 밑에서는 변별도가 표본 잡음에 지배된다. */
export const MIN_SAMPLE_PER_ITEM = 30;
/** KR-20 은 고정된 시험 세트에 정의된 값이라 완전 응답자가 필요하다. */
export const MIN_COMPLETE_CASES = 30;
export const MIN_ITEMS_FOR_RELIABILITY = 5;
/**
 * 변별도·point-biserial 의 총점은 사람마다 비교 가능해야 한다. 푼 문항 수가 너무 적은
 * 응답자는 총점이 우연에 좌우되므로 상·하위 구분에서 뺀다.
 */
export const MIN_ITEMS_ANSWERED_FOR_TOTAL = 5;
/** 상·하위 집단 크기 — 고전검사이론의 관례값. */
export const UPPER_LOWER_FRACTION = 0.27;

export interface ChoiceStat {
  index: number;
  count: number;
  share: number;
  isAnswer: boolean;
  /** 아무도 고르지 않은 오답 — 기능하지 않는 선지라 개선 대상이다(가이드 §8.1). */
  dead: boolean;
}

export interface ItemStat {
  itemId: string;
  n: number;
  correct: number;
  /** 경험적 난이도. 전문가 예상 난이도와 구분해서 읽는다. */
  correctRate: number;
  choices: ChoiceStat[];
  deadChoices: number[];
  meanTimeSeconds: number | null;
  /** 상위 27% 정답률 − 하위 27% 정답률. 표본이 모자라면 null. */
  discrimination: number | null;
  /** 문항–총점 상관. 음수면 정답이 틀렸을 가능성을 점검한다(가이드 §8.1). */
  pointBiserial: number | null;
  /** 표본이 임계 미만이면 true — 수치는 내되 성능 주장에 쓰지 않는다. */
  unstable: boolean;
  flags: string[];
}

export interface ReliabilityResult {
  kr20: number | null;
  items: number;
  completeCases: number;
  unstable: boolean;
  note: string;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

/** 모표준편차. 표본표준편차를 쓰면 KR-20 이 관례값과 어긋난다. */
function populationSd(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 응답자별 총점(정답 비율).
 *
 * 왜 원점수가 아니라 비율인가: 사용자마다 푼 문항 집합이 다르다. 원점수를 그대로 쓰면
 * 많이 푼 사람이 무조건 상위 집단에 들어가, 변별도가 '실력'이 아니라 '풀이량'을 잰다.
 */
function totalScores(attempts: AttemptRecord[]): Map<string, { score: number; answered: number }> {
  const byUser = new Map<string, { correct: number; answered: number }>();
  for (const attempt of attempts) {
    const entry = byUser.get(attempt.userId) ?? { correct: 0, answered: 0 };
    entry.answered += 1;
    if (attempt.isCorrect) entry.correct += 1;
    byUser.set(attempt.userId, entry);
  }
  const out = new Map<string, { score: number; answered: number }>();
  for (const [userId, entry] of byUser) {
    out.set(userId, { score: entry.correct / entry.answered, answered: entry.answered });
  }
  return out;
}

export function analyzeItems(
  attempts: AttemptRecord[],
  answerIndexById: Record<string, number>,
  options: { choiceCount?: number; minSample?: number } = {},
): ItemStat[] {
  const choiceCount = options.choiceCount ?? 5;
  const minSample = options.minSample ?? MIN_SAMPLE_PER_ITEM;

  const scores = totalScores(attempts);
  // 총점이 비교 가능한 응답자만 상·하위 구분에 쓴다.
  const eligible = [...scores.entries()].filter(
    ([, v]) => v.answered >= MIN_ITEMS_ANSWERED_FOR_TOTAL,
  );
  eligible.sort((a, b) => b[1].score - a[1].score);
  const groupSize = Math.floor(eligible.length * UPPER_LOWER_FRACTION);
  const upper = new Set(eligible.slice(0, groupSize).map(([id]) => id));
  const lower = new Set(eligible.slice(eligible.length - groupSize).map(([id]) => id));

  const byItem = new Map<string, AttemptRecord[]>();
  for (const attempt of attempts) {
    const list = byItem.get(attempt.itemId);
    if (list) list.push(attempt);
    else byItem.set(attempt.itemId, [attempt]);
  }

  const out: ItemStat[] = [];
  for (const [itemId, records] of byItem) {
    const n = records.length;
    const correct = records.filter((r) => r.isCorrect).length;
    const correctRate = correct / n;
    const answerIndex = answerIndexById[itemId];

    const counts = new Array(choiceCount).fill(0);
    for (const record of records) {
      if (record.selectedIndex >= 0 && record.selectedIndex < choiceCount) {
        counts[record.selectedIndex] += 1;
      }
    }
    const choices: ChoiceStat[] = counts.map((count, index) => ({
      index,
      count,
      share: round(count / n),
      isAnswer: index === answerIndex,
      dead: count === 0 && index !== answerIndex,
    }));
    const deadChoices = choices.filter((c) => c.dead).map((c) => c.index);

    const times = records
      .map((r) => r.timeSpentSeconds)
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0);

    // 변별도 — 상위/하위 집단이 성립할 때만
    let discrimination: number | null = null;
    if (groupSize > 0) {
      const upperRecords = records.filter((r) => upper.has(r.userId));
      const lowerRecords = records.filter((r) => lower.has(r.userId));
      if (upperRecords.length > 0 && lowerRecords.length > 0) {
        const pUpper = upperRecords.filter((r) => r.isCorrect).length / upperRecords.length;
        const pLower = lowerRecords.filter((r) => r.isCorrect).length / lowerRecords.length;
        discrimination = round(pUpper - pLower);
      }
    }

    // point-biserial — 문항 정오와 총점의 상관
    let pointBiserial: number | null = null;
    {
      const usable = records.filter((r) => {
        const s = scores.get(r.userId);
        return s !== undefined && s.answered >= MIN_ITEMS_ANSWERED_FOR_TOTAL;
      });
      const all = usable.map((r) => scores.get(r.userId)!.score);
      const sd = populationSd(all);
      const p = usable.length > 0 ? usable.filter((r) => r.isCorrect).length / usable.length : 0;
      // 전원 정답이거나 전원 오답이면 상관이 정의되지 않는다(분산 0).
      if (sd > 0 && p > 0 && p < 1) {
        const m1 = mean(usable.filter((r) => r.isCorrect).map((r) => scores.get(r.userId)!.score));
        const m0 = mean(usable.filter((r) => !r.isCorrect).map((r) => scores.get(r.userId)!.score));
        pointBiserial = round(((m1 - m0) / sd) * Math.sqrt(p * (1 - p)));
      }
    }

    const flags: string[] = [];
    if (n < minSample) flags.push(`표본 부족(${n} < ${minSample})`);
    if (deadChoices.length > 0) flags.push(`기능하지 않는 선지 ${deadChoices.map((i) => i + 1).join('·')}번`);
    if (pointBiserial !== null && pointBiserial < 0) flags.push('point-biserial 음수 — 정답 오류 점검');
    if (discrimination !== null && discrimination < 0.2) flags.push('변별도 낮음(<0.2)');
    if (correctRate >= 0.95) flags.push('너무 쉬움(정답률 ≥95%)');
    if (correctRate <= 0.2) flags.push('너무 어려움(정답률 ≤20%)');

    out.push({
      itemId,
      n,
      correct,
      correctRate: round(correctRate),
      choices,
      deadChoices,
      meanTimeSeconds: times.length > 0 ? round(mean(times), 1) : null,
      discrimination,
      pointBiserial,
      unstable: n < minSample,
      flags,
    });
  }

  out.sort((a, b) => a.itemId.localeCompare(b.itemId));
  return out;
}

/**
 * KR-20 (시험 세트 신뢰도).
 *
 *   KR-20 = k/(k-1) × (1 − Σ p_i·q_i / σ²_total)
 *
 * 완전 응답자(세트의 모든 문항을 푼 사람)만 쓴다. KR-20 은 고정된 시험에 정의된 값이라,
 * 서로 다른 문항 집합을 푼 사람을 섞으면 σ²_total 이 실력 분산이 아니라 '어떤 문항을
 * 풀었는지'의 분산을 담게 된다.
 *
 * **단일 문항 품질 지표가 아니다**(가이드 §8.1). 세트 전체를 두고 읽는다.
 */
export function computeKr20(
  attempts: AttemptRecord[],
  itemIds: string[],
  options: { minCompleteCases?: number } = {},
): ReliabilityResult {
  const minCases = options.minCompleteCases ?? MIN_COMPLETE_CASES;
  const k = itemIds.length;
  const itemSet = new Set(itemIds);

  const byUser = new Map<string, Map<string, boolean>>();
  for (const attempt of attempts) {
    if (!itemSet.has(attempt.itemId)) continue;
    const entry = byUser.get(attempt.userId) ?? new Map<string, boolean>();
    // 같은 문항을 여러 번 풀었으면 첫 응답만 쓴다 — 재시도는 학습 효과가 섞인다.
    if (!entry.has(attempt.itemId)) entry.set(attempt.itemId, attempt.isCorrect);
    byUser.set(attempt.userId, entry);
  }
  const complete = [...byUser.values()].filter((m) => m.size === k);

  if (k < MIN_ITEMS_FOR_RELIABILITY) {
    return { kr20: null, items: k, completeCases: complete.length, unstable: true,
      note: `문항이 ${k}개뿐이라 세트 신뢰도를 계산하지 않는다(최소 ${MIN_ITEMS_FOR_RELIABILITY}).` };
  }
  if (complete.length < 2) {
    return { kr20: null, items: k, completeCases: complete.length, unstable: true,
      note: '완전 응답자가 2명 미만이라 분산을 낼 수 없다.' };
  }

  const totals = complete.map((m) => [...m.values()].filter(Boolean).length);
  const variance = populationSd(totals) ** 2;
  if (variance === 0) {
    return { kr20: null, items: k, completeCases: complete.length, unstable: true,
      note: '총점 분산이 0이다(모두 같은 점수) — 신뢰도가 정의되지 않는다.' };
  }
  let sumPq = 0;
  for (const itemId of itemIds) {
    const p = complete.filter((m) => m.get(itemId)).length / complete.length;
    sumPq += p * (1 - p);
  }
  const kr20 = (k / (k - 1)) * (1 - sumPq / variance);
  const unstable = complete.length < minCases;
  return {
    kr20: round(kr20),
    items: k,
    completeCases: complete.length,
    unstable,
    note: unstable
      ? `완전 응답자 ${complete.length}명 — 권장 ${minCases}명 미만이라 불안정하다.`
      : '',
  };
}

/**
 * 확신도 보정 — 과신·과소신 (분담표 A14 · 가이드 §8.1 '확신도')
 *
 * 확률 눈금을 쓰지 않는다. 3점 척도를 억지로 확률(33%/66%/90%)에 대응시키면 그 숫자는
 * 우리가 지어낸 것이고, Brier score 처럼 보이는 값이 나와 실제보다 정밀한 척하게 된다.
 * 대신 **확신도 수준별 정답률**을 그대로 낸다 — 해석은 사람이 한다.
 *
 *   과신(overconfidence)  : '확실함'인데 정답률이 낮다 → 무엇을 모르는지 모른다
 *   과소신(underconfidence): '잘 모르겠음'인데 정답률이 높다 → 아는데 자신이 없다
 *
 * 미응답은 분모에서 뺀다. 강제하지 않는 필드라 미응답이 많고, 0 으로 세면 전부 '낮음'이 된다.
 */
export function summarizeConfidence(attempts: AttemptRecord[]): {
  answered: number;
  total: number;
  responseRate: number | null;
  byLevel: Array<{ level: 1 | 2 | 3; n: number; correct: number; correctRate: number }>;
  /** '확실함'(3) 정답률 − '잘 모르겠음'(1) 정답률. 클수록 자기 평가가 잘 맞는다. */
  discriminationGap: number | null;
  /** 확실하다고 한 것 중 틀린 비율. 학습 개입이 가장 급한 지점이다. */
  overconfidentRate: number | null;
  /** 모르겠다고 한 것 중 맞힌 비율. */
  underconfidentRate: number | null;
} {
  const answered = attempts.filter(
    (a) => typeof a.confidence === 'number' && a.confidence >= 1 && a.confidence <= 3,
  );
  const byLevel: Array<{ level: 1 | 2 | 3; n: number; correct: number; correctRate: number }> = [];
  for (const level of [1, 2, 3] as const) {
    const subset = answered.filter((a) => a.confidence === level);
    if (subset.length === 0) continue;
    const correct = subset.filter((a) => a.isCorrect).length;
    byLevel.push({ level, n: subset.length, correct, correctRate: round(correct / subset.length) });
  }
  const high = byLevel.find((b) => b.level === 3);
  const low = byLevel.find((b) => b.level === 1);
  return {
    answered: answered.length,
    total: attempts.length,
    responseRate: attempts.length > 0 ? round(answered.length / attempts.length) : null,
    byLevel,
    discriminationGap: high && low ? round(high.correctRate - low.correctRate) : null,
    overconfidentRate: high ? round(1 - high.correctRate) : null,
    underconfidentRate: low ? round(low.correctRate) : null,
  };
}

/** 보고용 요약. 표본이 모자란 문항이 몇 개인지 함께 낸다 — 평균만 내면 그 사실이 사라진다. */
export function summarizeItemStats(stats: ItemStat[]): {
  items: number;
  stable: number;
  unstable: number;
  meanCorrectRate: number | null;
  meanDiscrimination: number | null;
  negativePointBiserial: number;
  itemsWithDeadChoices: number;
  flagged: number;
} {
  const stable = stats.filter((s) => !s.unstable);
  const discriminations = stable
    .map((s) => s.discrimination)
    .filter((v): v is number => v !== null);
  return {
    items: stats.length,
    stable: stable.length,
    unstable: stats.length - stable.length,
    // 평균은 안정 문항만으로 낸다 — 표본 3명짜리가 평균을 흔들면 안 된다.
    meanCorrectRate: stable.length > 0 ? round(mean(stable.map((s) => s.correctRate))) : null,
    meanDiscrimination: discriminations.length > 0 ? round(mean(discriminations)) : null,
    negativePointBiserial: stats.filter((s) => s.pointBiserial !== null && s.pointBiserial < 0).length,
    itemsWithDeadChoices: stats.filter((s) => s.deadChoices.length > 0).length,
    flagged: stats.filter((s) => s.flags.length > 0).length,
  };
}

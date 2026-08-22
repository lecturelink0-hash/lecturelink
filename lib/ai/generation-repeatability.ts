/**
 * 문항 생성 반복 안정성 — 변동 산식 (성능지표 가이드 §4.2 · 분담표 A3)
 *
 * 가이드 요구: 동일 입력·프롬프트·모델 버전으로 최소 10회 반복하고
 * **스키마 준수, 정답 개념, 핵심 주장, 실행시간**의 변동을 계산한다.
 *
 * ── 생성과 채점은 '안정'의 뜻이 다르다 ────────────────────────────────────────
 * CPX 채점은 temperature=0 이라 같은 전사면 같은 판정이 나와야 한다 — 완전 일치가 목표다.
 * 문항 생성은 그렇지 않다. 같은 자료에서 매번 똑같은 10문항이 나오면 그게 오히려 문제다
 * (재생성이 무의미해지고 중복 방지 장치와 정면으로 부딪힌다).
 *
 * 그래서 두 층으로 나눠 본다.
 *   ① **지켜져야 하는 것(계약)** — 스키마 준수, 요청한 문항 수, 실행 안 중복 없음.
 *      여기서 흔들리면 버그다. 기준을 넘기지 못하면 실패로 본다.
 *   ② **재기만 하는 것(분포)** — 개념 커버리지, 발문 내용 겹침, 난이도 분포, 실행시간,
 *      그리고 KMLE 형식 규격 위반. "얼마나 달라지는가"를 숫자로 남길 뿐 합격/불합격을
 *      매기지 않는다. 모델·프롬프트를 바꿨을 때 이 값들이 어떻게 움직였는지가 회귀 신호다.
 *
 * 형식 규격(F01 "가장 적절한" 금지 등)을 계약에 넣지 않는 이유: 그건 문항 품질 기준이지
 * 자료구조 계약이 아니다. 한데 묶으면 준수율이 문체 규칙에 좌우돼, 정작 화면을 깨뜨리는
 * 자료형·범위 위반이 그 안에 묻힌다. 형식 위반은 저장 경로의 품질 게이트(A4)가 잡는다.
 *
 * 이 파일은 순수 함수만 둔다 — 모델 호출 없이 산식을 검사할 수 있어야
 * scripts/check-generation-repeatability.mjs --selftest 가 CI 에서 돈다.
 */
import { checkQuestionSchema, lexicalSimilarity } from './quality-checks.ts';

export interface GeneratedItem {
  stem?: unknown;
  choices?: unknown;
  answer_index?: unknown;
  explanation?: unknown;
  difficulty?: unknown;
  sub_topic_code?: unknown;
  concepts?: unknown;
}

export interface GenerationRun {
  ok: boolean;
  error?: string | null;
  elapsedMs: number;
  questions: GeneratedItem[];
}

/** 같은 문항으로 볼 발문 유사도. 생성은 표현이 조금씩 달라 완전 일치로는 아무것도 안 잡힌다. */
export const SAME_QUESTION_SIMILARITY = 0.75;

export interface GenerationStability {
  runs: number;
  completed: number;
  completionRate: number | null;
  errors: Record<string, number>;
  contract: {
    schemaValidRuns: number;
    schemaValidRate: number | null;
    violationCodes: Record<string, number>;
    questionsTotal: number;
    violationRate: number | null;
    countExactRuns: number;
    countExactRate: number | null;
    countMin: number | null;
    countMax: number | null;
    withinRunDuplicates: number;
    withinRunDuplicateRate: number | null;
  };
  distribution: {
    /** KMLE 형식 규격 위반 (F01~). 계약이 아니라 품질이라 보고만 한다. */
    formatIssues: number;
    formatIssueRate: number | null;
    formatCodes: Record<string, number>;
    /** 실행 쌍마다 개념 집합 Jaccard — 1 이면 매번 같은 개념만 낸다. */
    conceptJaccardMean: number | null;
    conceptsSeen: number;
    /** 실행 쌍마다 '같은 문항'으로 매칭된 비율 — 높을수록 재생성이 새 문항을 못 만든다. */
    crossRunOverlapMean: number | null;
    difficultyMean: number | null;
    difficultySd: number | null;
    difficultyHistogram: Record<string, number>;
  };
  elapsedMs: {
    count: number;
    p50: number | null;
    p95: number | null;
    mean: number | null;
    max: number | null;
  };
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((ordered.length * p) / 100);
  return ordered[Math.min(Math.max(rank, 1), ordered.length) - 1];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : null;
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function textOf(item: GeneratedItem): string {
  const choices = Array.isArray(item.choices) ? item.choices.map((c) => String(c)) : [];
  return [String(item.stem ?? ''), ...choices].join(' ');
}

function conceptsOf(item: GeneratedItem): string[] {
  const out: string[] = [];
  if (typeof item.sub_topic_code === 'string' && item.sub_topic_code.trim()) {
    out.push(`topic:${item.sub_topic_code.trim()}`);
  }
  if (Array.isArray(item.concepts)) {
    for (const concept of item.concepts) {
      const value = String(concept ?? '').trim();
      if (value) out.push(`concept:${value}`);
    }
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * 두 실행 사이에서 '같은 문항'으로 볼 수 있는 비율.
 * 작은 쪽 실행의 문항 수를 분모로 삼는다 — 문항 수가 다를 때 큰 쪽을 분모로 두면
 * 겹침이 실제보다 낮게 나온다.
 */
function overlapBetween(a: GeneratedItem[], b: GeneratedItem[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const textsB = b.map(textOf);
  const used = new Set<number>();
  let matched = 0;
  for (const item of a) {
    const text = textOf(item);
    let bestIndex = -1;
    let best = 0;
    textsB.forEach((other, index) => {
      if (used.has(index)) return;
      const score = lexicalSimilarity(text, other);
      if (score >= SAME_QUESTION_SIMILARITY && score > best) {
        best = score;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) {
      used.add(bestIndex);
      matched += 1;
    }
  }
  return matched / Math.min(a.length, b.length);
}

/** 한 실행 안에서 서로 너무 닮은 문항 수 — 사용자가 바로 알아채는 결함이다. */
function duplicatesWithin(items: GeneratedItem[]): number {
  const texts = items.map(textOf);
  let duplicates = 0;
  for (let i = 1; i < texts.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (lexicalSimilarity(texts[i], texts[j]) >= SAME_QUESTION_SIMILARITY) {
        duplicates += 1;
        break;
      }
    }
  }
  return duplicates;
}

export function summarizeGenerationRuns(
  runs: GenerationRun[],
  options: { requestedCount: number },
): GenerationStability {
  const ok = runs.filter((r) => r.ok);
  const errors: Record<string, number> = {};
  for (const run of runs) {
    if (run.ok) continue;
    const key = String(run.error ?? 'unknown');
    errors[key] = (errors[key] ?? 0) + 1;
  }

  // ── ① 계약
  const violationCodes: Record<string, number> = {};
  let schemaValidRuns = 0;
  let questionsTotal = 0;
  let violatingQuestions = 0;
  let countExactRuns = 0;
  let withinRunDuplicates = 0;
  const counts: number[] = [];

  const formatCodes: Record<string, number> = {};
  let formatIssues = 0;

  for (const run of ok) {
    let runClean = true;
    for (const question of run.questions) {
      questionsTotal += 1;
      // checkQuestionSchema 는 계약 위반과 형식 위반을 함께 돌려준다. 형식은 'format:' 접두사로
      // 구분되므로 여기서 갈라, 계약 준수율이 문체 규칙에 흔들리지 않게 한다.
      const problems = checkQuestionSchema(question);
      const contractProblems = problems.filter((code) => !code.startsWith('format:'));
      const formatProblems = problems.filter((code) => code.startsWith('format:'));
      if (formatProblems.length > 0) {
        formatIssues += 1;
        for (const code of formatProblems) formatCodes[code] = (formatCodes[code] ?? 0) + 1;
      }
      if (contractProblems.length > 0) {
        violatingQuestions += 1;
        runClean = false;
        for (const code of contractProblems) violationCodes[code] = (violationCodes[code] ?? 0) + 1;
      }
    }
    if (runClean) schemaValidRuns += 1;
    counts.push(run.questions.length);
    if (run.questions.length === options.requestedCount) countExactRuns += 1;
    withinRunDuplicates += duplicatesWithin(run.questions);
  }

  // ── ② 분포
  const conceptSets = ok.map((run) => new Set(run.questions.flatMap(conceptsOf)));
  const conceptsSeen = new Set(conceptSets.flatMap((s) => [...s])).size;
  const jaccards: number[] = [];
  const overlaps: number[] = [];
  for (let i = 0; i < ok.length; i += 1) {
    for (let j = i + 1; j < ok.length; j += 1) {
      jaccards.push(jaccard(conceptSets[i], conceptSets[j]));
      overlaps.push(overlapBetween(ok[i].questions, ok[j].questions));
    }
  }

  const difficulties: number[] = [];
  const difficultyHistogram: Record<string, number> = {};
  for (const run of ok) {
    for (const question of run.questions) {
      const value = Number(question.difficulty);
      if (!Number.isFinite(value)) continue;
      difficulties.push(value);
      const key = String(value);
      difficultyHistogram[key] = (difficultyHistogram[key] ?? 0) + 1;
    }
  }
  const difficultyMean =
    difficulties.length > 0 ? difficulties.reduce((a, b) => a + b, 0) / difficulties.length : null;
  const difficultySd =
    difficultyMean !== null && difficulties.length > 1
      ? Math.sqrt(
          difficulties.reduce((sum, v) => sum + (v - difficultyMean) ** 2, 0) / difficulties.length,
        )
      : difficulties.length > 0
        ? 0
        : null;

  const elapsed = ok.map((r) => r.elapsedMs).filter((v) => Number.isFinite(v));

  const mean = (values: number[]) =>
    values.length > 0 ? round(values.reduce((a, b) => a + b, 0) / values.length) : null;

  return {
    runs: runs.length,
    completed: ok.length,
    completionRate: ratio(ok.length, runs.length),
    errors,
    contract: {
      schemaValidRuns,
      schemaValidRate: ratio(schemaValidRuns, ok.length),
      violationCodes,
      questionsTotal,
      violationRate: ratio(violatingQuestions, questionsTotal),
      countExactRuns,
      countExactRate: ratio(countExactRuns, ok.length),
      countMin: counts.length > 0 ? Math.min(...counts) : null,
      countMax: counts.length > 0 ? Math.max(...counts) : null,
      withinRunDuplicates,
      withinRunDuplicateRate: ratio(withinRunDuplicates, questionsTotal),
    },
    distribution: {
      formatIssues,
      formatIssueRate: ratio(formatIssues, questionsTotal),
      formatCodes,
      conceptJaccardMean: mean(jaccards),
      conceptsSeen,
      crossRunOverlapMean: mean(overlaps),
      difficultyMean: difficultyMean === null ? null : round(difficultyMean, 3),
      difficultySd: difficultySd === null ? null : round(difficultySd, 3),
      difficultyHistogram,
    },
    elapsedMs: {
      count: elapsed.length,
      p50: percentile(elapsed, 50),
      p95: percentile(elapsed, 95),
      mean: mean(elapsed),
      max: elapsed.length > 0 ? Math.max(...elapsed) : null,
    },
  };
}

/**
 * 계약 층만 합격/불합격을 매긴다. 분포 층은 보고 대상이다 —
 * "매번 다른 문항이 나온다"는 결함이 아니라 생성의 정상 동작이다.
 */
export const CONTRACT_THRESHOLDS = {
  completionRate: 1.0,
  schemaValidRate: 1.0,
  countExactRate: 1.0,
  withinRunDuplicateRate: 0,
} as const;

export interface Verdict {
  metric: string;
  value: number | null;
  threshold: number;
  pass: boolean;
  note: string;
}

export function contractVerdicts(stability: GenerationStability): Verdict[] {
  const { contract } = stability;
  return [
    {
      metric: 'completionRate',
      value: stability.completionRate,
      threshold: CONTRACT_THRESHOLDS.completionRate,
      pass: stability.completionRate !== null && stability.completionRate >= 1,
      note: '실행이 하나라도 실패하면 그 조건에서 생성이 불안정하다는 뜻이다.',
    },
    {
      metric: 'schemaValidRate',
      value: contract.schemaValidRate,
      threshold: CONTRACT_THRESHOLDS.schemaValidRate,
      pass: contract.schemaValidRate !== null && contract.schemaValidRate >= 1,
      note: '계약 위반은 화면이 조용히 깨지는 자리다.',
    },
    {
      metric: 'countExactRate',
      value: contract.countExactRate,
      threshold: CONTRACT_THRESHOLDS.countExactRate,
      pass: contract.countExactRate !== null && contract.countExactRate >= 1,
      note: '요청한 문항 수와 다르게 나오면 사용자가 바로 알아챈다.',
    },
    {
      metric: 'withinRunDuplicateRate',
      value: contract.withinRunDuplicateRate,
      threshold: CONTRACT_THRESHOLDS.withinRunDuplicateRate,
      pass: contract.withinRunDuplicateRate !== null && contract.withinRunDuplicateRate <= 0,
      note: '한 번에 받은 문항 안에 같은 문제가 둘 있으면 결함이다.',
    },
  ];
}

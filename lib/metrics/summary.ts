/**
 * 운영 지표 집계 (성능지표 가이드 §4.1 '권장 집계' · 분담표 A2)
 *
 * 가이드가 요구한 집계:
 *   - 기능별 성공률과 실패율
 *   - 평균이 아닌 p50, p95, 가능하면 p99 지연시간
 *   - 문항 1개 및 CPX 10분 세션당 평균 비용
 *   - 오류 코드별 빈도와 재시도 성공률
 *
 * 산식은 CPX 쪽 services/cpx/server/metrics.py 와 의도적으로 같게 맞췄다.
 * 두 대시보드가 다른 방식으로 p95 를 재면 같은 지표 이름이 다른 뜻을 갖는다.
 *
 * 이 파일은 순수 함수만 둔다 — DB 접근 없이 테스트할 수 있어야 산식이 회귀하지 않는다.
 */
import type { RequestMetricRow } from '@/lib/types/database';

export interface LatencyStats {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  mean: number | null;
  max: number | null;
}

export interface FeatureSummary {
  feature: string;
  total: number;
  success: number;
  successRate: number | null;
  failureRate: number | null;
  byStatus: Record<string, number>;
  errorCodes: Record<string, number>;
  latencyMs: LatencyStats;
  successLatencyMs: LatencyStats;
  stageMs: Record<string, LatencyStats>;
  costUsd: number;
  meanCostUsd: number | null;
  schemaChecked: number;
  schemaValid: number;
  schemaValidRate: number | null;
  versions: string[];
  models: string[];
}

export interface RetrySummary {
  failures: number;
  retried: number;
  recovered: number;
  /** 재시도한 실패 중 성공으로 이어진 비율. 재시도가 없으면 null. */
  recoveryRate: number | null;
  /** 실패했는데 재시도조차 없었던 비율 — 사용자가 포기한 지점이다. */
  abandonRate: number | null;
}

export interface RequestsSummary {
  total: number;
  success: number;
  successRate: number | null;
  failureRate: number | null;
  latencyMs: LatencyStats;
  errorCodes: Record<string, number>;
  costUsd: number;
  features: FeatureSummary[];
  retry: RetrySummary;
}

/**
 * nearest-rank 백분위. 보간하지 않으므로 결과는 항상 실제 관측값이다.
 * 표본이 적을 때 보간법은 관측된 적 없는 값을 만들어 낸다.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  if (p <= 0) return ordered[0];
  const rank = Math.ceil((ordered.length * p) / 100);
  return ordered[Math.min(Math.max(rank, 1), ordered.length) - 1];
}

export function latencyStats(values: Array<number | null | undefined>): LatencyStats {
  const clean = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (clean.length === 0) {
    return { count: 0, p50: null, p95: null, p99: null, mean: null, max: null };
  }
  return {
    count: clean.length,
    p50: percentile(clean, 50),
    p95: percentile(clean, 95),
    p99: percentile(clean, 99),
    mean: Math.round((clean.reduce((a, b) => a + b, 0) / clean.length) * 10) / 10,
    max: Math.max(...clean),
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : null;
}

/**
 * 재시도 성공률.
 *
 * 정의: 실패한 요청 뒤 `windowMs` 안에 **같은 사용자가 같은 기능을** 다시 부른 것을 재시도로
 * 본다. 그 재시도가 성공이면 회복으로 센다.
 *
 * 이 정의를 고른 이유: 요청 로그만으로 알 수 있는 것은 "다시 시도했는가"까지다. 사용자가
 * 새로고침을 눌렀는지 자동 재시도였는지는 구분되지 않으므로, 지표 이름을 '재시도 성공률'로
 * 두되 **회복률**로 읽는 것이 정확하다. 재시도조차 없던 실패(abandonRate)를 함께 내는 이유는,
 * 회복률만 보면 "재시도한 사람은 대체로 성공했다"는 착시가 생기기 때문이다.
 */
export function summarizeRetries(rows: RequestMetricRow[], windowMs = 10 * 60 * 1000): RetrySummary {
  const ordered = [...rows].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
  const byKey = new Map<string, RequestMetricRow[]>();
  for (const row of ordered) {
    const key = `${row.user_id ?? 'anon'}|${row.feature}`;
    const list = byKey.get(key);
    if (list) list.push(row);
    else byKey.set(key, [row]);
  }

  let failures = 0;
  let retried = 0;
  let recovered = 0;
  for (const list of byKey.values()) {
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].status === 'success') continue;
      failures += 1;
      const failedAt = new Date(list[i].created_at).getTime();
      const next = list[i + 1];
      if (!next) continue;
      if (new Date(next.created_at).getTime() - failedAt > windowMs) continue;
      retried += 1;
      if (next.status === 'success') recovered += 1;
    }
  }
  return {
    failures,
    retried,
    recovered,
    recoveryRate: ratio(recovered, retried),
    abandonRate: ratio(failures - retried, failures),
  };
}

export function summarizeRequests(rows: RequestMetricRow[]): RequestsSummary {
  const buckets = new Map<string, {
    feature: string;
    total: number;
    success: number;
    byStatus: Record<string, number>;
    errorCodes: Record<string, number>;
    latencies: number[];
    successLatencies: number[];
    stages: Map<string, number[]>;
    costUsd: number;
    schemaChecked: number;
    schemaValid: number;
    versions: Set<string>;
    models: Set<string>;
  }>();
  const errorCodes: Record<string, number> = {};
  let totalCost = 0;

  for (const row of rows) {
    let bucket = buckets.get(row.feature);
    if (!bucket) {
      bucket = {
        feature: row.feature,
        total: 0,
        success: 0,
        byStatus: {},
        errorCodes: {},
        latencies: [],
        successLatencies: [],
        stages: new Map(),
        costUsd: 0,
        schemaChecked: 0,
        schemaValid: 0,
        versions: new Set(),
        models: new Set(),
      };
      buckets.set(row.feature, bucket);
    }
    bucket.total += 1;
    bucket.byStatus[row.status] = (bucket.byStatus[row.status] ?? 0) + 1;
    bucket.latencies.push(row.total_ms);
    if (row.status === 'success') {
      bucket.success += 1;
      // 성공 경로만의 분포. 실패는 즉시 끊기거나(4xx) 타임아웃 상한에 붙어(504)
      // 분포를 양쪽으로 왜곡한다 — 사용자 체감은 성공 경로의 분포다.
      bucket.successLatencies.push(row.total_ms);
    }
    if (row.error_code) {
      bucket.errorCodes[row.error_code] = (bucket.errorCodes[row.error_code] ?? 0) + 1;
      errorCodes[row.error_code] = (errorCodes[row.error_code] ?? 0) + 1;
    }
    for (const [name, ms] of Object.entries(row.stages ?? {})) {
      if (typeof ms !== 'number') continue;
      const list = bucket.stages.get(name);
      if (list) list.push(ms);
      else bucket.stages.set(name, [ms]);
    }
    const cost = Number(row.cost_usd) || 0;
    bucket.costUsd += cost;
    totalCost += cost;
    if (row.schema_valid !== null) {
      bucket.schemaChecked += 1;
      if (row.schema_valid) bucket.schemaValid += 1;
    }
    if (row.version) bucket.versions.add(row.version);
    for (const model of row.models ?? []) bucket.models.add(model);
  }

  const features: FeatureSummary[] = [...buckets.values()]
    .map((bucket) => ({
      feature: bucket.feature,
      total: bucket.total,
      success: bucket.success,
      successRate: ratio(bucket.success, bucket.total),
      failureRate: ratio(bucket.total - bucket.success, bucket.total),
      byStatus: bucket.byStatus,
      errorCodes: sortByCount(bucket.errorCodes),
      latencyMs: latencyStats(bucket.latencies),
      successLatencyMs: latencyStats(bucket.successLatencies),
      stageMs: Object.fromEntries(
        [...bucket.stages.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([name, list]) => [name, latencyStats(list)]),
      ),
      costUsd: round6(bucket.costUsd),
      // 비용이 0인 기능(AI를 안 부르는 조회)은 평균을 내지 않는다 — 0원이 섞이면
      // "요청 하나에 얼마 드는가"의 답이 실제보다 싸게 나온다.
      meanCostUsd: bucket.costUsd > 0 ? round6(bucket.costUsd / bucket.total) : null,
      schemaChecked: bucket.schemaChecked,
      schemaValid: bucket.schemaValid,
      schemaValidRate: ratio(bucket.schemaValid, bucket.schemaChecked),
      versions: [...bucket.versions].sort(),
      models: [...bucket.models].sort(),
    }))
    .sort((a, b) => b.total - a.total);

  const success = features.reduce((sum, f) => sum + f.success, 0);
  return {
    total: rows.length,
    success,
    successRate: ratio(success, rows.length),
    failureRate: ratio(rows.length - success, rows.length),
    latencyMs: latencyStats(rows.map((r) => r.total_ms)),
    errorCodes: sortByCount(errorCodes),
    costUsd: round6(totalCost),
    features,
    retry: summarizeRetries(rows),
  };
}

/**
 * 문항 1개당 원가 (가이드 §4.1).
 * quality.questions 에 그 요청이 실제로 만들어 낸 문항 수가 들어 있다.
 * 요청당이 아니라 산출물당으로 재야 "한 문항에 얼마"라는 질문에 답이 된다.
 */
export function costPerQuestion(rows: RequestMetricRow[]): {
  questions: number;
  costUsd: number;
  perQuestionUsd: number | null;
  requests: number;
} {
  let questions = 0;
  let costUsd = 0;
  let requests = 0;
  for (const row of rows) {
    const count = Number((row.quality as { questions?: unknown } | null)?.questions);
    if (!Number.isFinite(count) || count <= 0) continue;
    questions += count;
    costUsd += Number(row.cost_usd) || 0;
    requests += 1;
  }
  return {
    questions,
    costUsd: round6(costUsd),
    perQuestionUsd: questions > 0 ? round6(costUsd / questions) : null,
    requests,
  };
}

/** 품질 게이트 집계 (분담표 A4) — 스키마 준수율과 중복 문항률. */
export function summarizeQuality(rows: RequestMetricRow[]): {
  checkedRequests: number;
  validRequests: number;
  schemaValidRate: number | null;
  questions: number;
  schemaViolations: number;
  violationRate: number | null;
  duplicates: number;
  duplicateRate: number | null;
} {
  let checkedRequests = 0;
  let validRequests = 0;
  let questions = 0;
  let schemaViolations = 0;
  let duplicates = 0;
  for (const row of rows) {
    if (row.schema_valid === null) continue;
    checkedRequests += 1;
    if (row.schema_valid) validRequests += 1;
    const quality = (row.quality ?? {}) as Record<string, unknown>;
    questions += numberOr0(quality.questions);
    schemaViolations += numberOr0(quality.schemaViolations);
    duplicates += numberOr0(quality.duplicates);
  }
  return {
    checkedRequests,
    validRequests,
    schemaValidRate: ratio(validRequests, checkedRequests),
    questions,
    schemaViolations,
    // 분모는 요청이 아니라 문항이다 — 10문항 중 1개가 위반인 것과 1문항이 위반인 것은 다르다.
    violationRate: ratio(schemaViolations, questions),
    duplicates,
    duplicateRate: ratio(duplicates, questions),
  };
}

function numberOr0(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function sortByCount(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a));
}

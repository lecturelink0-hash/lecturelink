/**
 * 업로드당·문항당 원가 집계 (RAG 실행계획 v1.1 · Phase 0-a · 8장)
 *
 * 정의 (실행계획 8장)
 *   문항당 원가 = 업로드 전체 AI 비용(OCR·Vision·이미지 선별 포함) ÷ 저장된 문항 수
 *   - 헤지에서 진 호출도 실제로 나간 돈이라 포함한다.
 *   - 문항을 하나도 못 만든 업로드는 분모가 0 이라 문항당 원가에서 뺀다(따로 센다).
 *   - docs/ops-metrics.md 3.4 의 요청(request_metrics) 기반 산식은 QStash 경로에서 행이
 *     생기지 않아 이 기준선에 쓰지 않는다.
 *
 * 교차 검증 (G0 '원가 귀속')
 *   ai_cost_log 합계에서 헤지 패자 몫을 뺀 값 ≈ 진단의 cost.pipelineUsd(파이프라인
 *   totalCost). 둘이 ±1% 를 벗어나면 어느 한쪽이 호출을 빠뜨리고 있다는 뜻이다.
 *
 * 잎 모듈 규칙: import 없음. `scripts/report-upload-cost.mjs` 와
 * `scripts/check-upload-cost.mjs` 가 이 파일을 직접 불러온다.
 */

export interface CostLogRow {
  endpoint: string;
  /** numeric 컬럼이라 PostgREST 가 문자열로 돌려줄 수 있다. */
  cost_usd: number | string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  metadata: Record<string, unknown> | null;
  created_at?: string | null;
}

export interface EndpointCost {
  costUsd: number;
  calls: number;
}

export interface UploadCostSummary {
  uploadId: string;
  /** 진단 행을 뺀 ai_cost_log 합계(헤지 패자 포함). */
  totalUsd: number;
  hedgeLoserUsd: number;
  byEndpoint: Record<string, EndpointCost>;
  /** 저장된 문항 수. */
  questions: number;
  /** totalUsd ÷ questions. 문항이 0 이면 null. */
  perQuestionUsd: number | null;
  /** 진단의 파이프라인 totalCost. 진단이 없거나 0-a 이전 실행이면 null. */
  pipelineUsd: number | null;
  /**
   * (totalUsd − hedgeLoserUsd − pipelineUsd) ÷ pipelineUsd.
   * 양수 = ai_cost_log 에만 있는 비용, 음수 = 파이프라인만 센 비용.
   */
  gapRatio: number | null;
  /** 진단의 전체 처리 시간(ms). */
  totalMs: number | null;
}

export interface UploadCostAggregate {
  uploads: number;
  /** 문항이 1개 이상 저장된 업로드 수(문항당 원가의 표본). */
  uploadsWithQuestions: number;
  totalUsd: number;
  totalQuestions: number;
  /** 업로드별 문항당 원가의 중앙값 — 실행계획의 기준선 정의. */
  medianPerQuestionUsd: number | null;
  /** 전체 비용 ÷ 전체 문항(가중 평균). 중앙값과 크게 다르면 소수 업로드가 비용을 끌고 있다. */
  pooledPerQuestionUsd: number | null;
  p95TotalMs: number | null;
  /** 교차 검증 가능한 업로드(진단에 pipelineUsd 가 있는 업로드) 수. */
  gapChecked: number;
  /** 그중 |gapRatio| ≤ tolerance 인 업로드 수. */
  gapWithinTolerance: number;
  gapTolerance: number;
}

export const DIAGNOSTICS_ENDPOINT = 'private.diagnostics';
export const DEFAULT_GAP_TOLERANCE = 0.01;

export function toUsd(value: number | string | null | undefined): number {
  const n = typeof value === 'string' ? Number(value) : value ?? 0;
  return Number.isFinite(n) ? (n as number) : 0;
}

function uploadIdOf(row: CostLogRow): string | null {
  const id = row.metadata?.uploadId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** 정렬된 값의 중앙값. 빈 배열이면 null. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 최근접 순위(nearest-rank) 백분위수. p 는 0~100. 빈 배열이면 null. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/**
 * 같은 업로드의 진단 행이 여럿이면(재시도) 가장 늦은 것을 쓴다.
 * 진단 payload 는 metadata 자체다: { uploadId, timings.totalMs, cost.pipelineUsd, … }.
 */
function latestDiagnostics(rows: CostLogRow[]): Map<string, CostLogRow> {
  const latest = new Map<string, CostLogRow>();
  for (const row of rows) {
    if (row.endpoint !== DIAGNOSTICS_ENDPOINT) continue;
    const id = uploadIdOf(row);
    if (!id) continue;
    const prev = latest.get(id);
    if (!prev || String(row.created_at ?? '') >= String(prev.created_at ?? '')) latest.set(id, row);
  }
  return latest;
}

function pipelineUsdOf(diag: CostLogRow | undefined): number | null {
  const cost = diag?.metadata?.cost as { pipelineUsd?: unknown } | undefined;
  const v = cost?.pipelineUsd;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function totalMsOf(diag: CostLogRow | undefined): number | null {
  const timings = diag?.metadata?.timings as { totalMs?: unknown } | undefined;
  const v = timings?.totalMs;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function summarizeUploadCosts(input: {
  rows: CostLogRow[];
  /** upload_id → 저장된 문항 수. 없는 업로드는 0 으로 본다. */
  questionCounts: Record<string, number>;
  /** 이 목록이 있으면 여기 있는 업로드만 집계한다(행이 하나도 없어도 0 원으로 포함). */
  uploadIds?: string[];
  gapTolerance?: number;
}): { uploads: UploadCostSummary[]; aggregate: UploadCostAggregate } {
  const tolerance = input.gapTolerance ?? DEFAULT_GAP_TOLERANCE;
  const diagnostics = latestDiagnostics(input.rows);
  const byUpload = new Map<string, { total: number; hedge: number; byEndpoint: Record<string, EndpointCost> }>();

  const ensure = (id: string) => {
    let acc = byUpload.get(id);
    if (!acc) {
      acc = { total: 0, hedge: 0, byEndpoint: {} };
      byUpload.set(id, acc);
    }
    return acc;
  };

  const wanted = input.uploadIds ? new Set(input.uploadIds) : null;
  for (const id of input.uploadIds ?? []) ensure(id);

  for (const row of input.rows) {
    if (row.endpoint === DIAGNOSTICS_ENDPOINT) continue;
    const id = uploadIdOf(row);
    if (!id || (wanted && !wanted.has(id))) continue;
    const cost = toUsd(row.cost_usd);
    const acc = ensure(id);
    acc.total += cost;
    if (row.metadata?.hedgeLoser === true) acc.hedge += cost;
    const ep = (acc.byEndpoint[row.endpoint] ??= { costUsd: 0, calls: 0 });
    ep.costUsd += cost;
    ep.calls += 1;
  }
  // 비용 행 없이 진단만 있는 업로드(생성 전 실패 등)도 드러나게 한다.
  for (const id of diagnostics.keys()) {
    if (!wanted || wanted.has(id)) ensure(id);
  }

  const uploads: UploadCostSummary[] = [];
  for (const [uploadId, acc] of byUpload) {
    const questions = Math.max(0, input.questionCounts[uploadId] ?? 0);
    const diag = diagnostics.get(uploadId);
    const pipelineUsd = pipelineUsdOf(diag);
    const comparable = acc.total - acc.hedge;
    const byEndpoint: Record<string, EndpointCost> = {};
    for (const [ep, v] of Object.entries(acc.byEndpoint)) {
      byEndpoint[ep] = { costUsd: roundUsd(v.costUsd), calls: v.calls };
    }
    uploads.push({
      uploadId,
      totalUsd: roundUsd(acc.total),
      hedgeLoserUsd: roundUsd(acc.hedge),
      byEndpoint,
      questions,
      perQuestionUsd: questions > 0 ? acc.total / questions : null,
      pipelineUsd,
      gapRatio:
        pipelineUsd !== null && pipelineUsd > 0 ? (comparable - pipelineUsd) / pipelineUsd : null,
      totalMs: totalMsOf(diag),
    });
  }
  uploads.sort((a, b) => a.uploadId.localeCompare(b.uploadId));

  const withQuestions = uploads.filter((u) => u.perQuestionUsd !== null);
  const totalUsd = uploads.reduce((s, u) => s + u.totalUsd, 0);
  const totalQuestions = uploads.reduce((s, u) => s + u.questions, 0);
  const costOfProducing = withQuestions.reduce((s, u) => s + u.totalUsd, 0);
  const gapChecked = uploads.filter((u) => u.gapRatio !== null);
  const msValues = uploads.map((u) => u.totalMs).filter((v): v is number => v !== null);

  return {
    uploads,
    aggregate: {
      uploads: uploads.length,
      uploadsWithQuestions: withQuestions.length,
      totalUsd: roundUsd(totalUsd),
      totalQuestions,
      medianPerQuestionUsd: median(withQuestions.map((u) => u.perQuestionUsd as number)),
      pooledPerQuestionUsd: totalQuestions > 0 ? costOfProducing / totalQuestions : null,
      p95TotalMs: percentile(msValues, 95),
      gapChecked: gapChecked.length,
      gapWithinTolerance: gapChecked.filter((u) => Math.abs(u.gapRatio as number) <= tolerance)
        .length,
      gapTolerance: tolerance,
    },
  };
}

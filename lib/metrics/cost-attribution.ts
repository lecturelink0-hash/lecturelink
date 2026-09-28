/**
 * 업로드 단위 비용 귀속 컨텍스트 (RAG 실행계획 v1.1 · Phase 0-a · F6)
 *
 * 왜 필요한가
 * ──────────
 * 내신대비 생성 한 번의 AI 비용은 여러 모듈에서 따로 기록된다. `private.*`(생성·판정·
 * 검증·블라인드)는 metadata 에 uploadId 를 싣지만, 추출 단계 — `ocr.claude`·
 * `extract.detect-regions`·`extract.select-images`·`extract.inpaint-text` — 는 자기가
 * 어느 업로드를 처리하는지 모른다. 그래서 ai_cost_log 만으로는 "업로드 1건 = 얼마"를
 * 셀 수 없었고, 실행계획 D2(문항당 원가 ≤ 현행 × 1.5)의 기준선 자체를 잡을 수 없었다.
 *
 * 추출 함수의 시그니처를 전부 고쳐 uploadId 를 내려보내는 대신, request-context.ts 와
 * 같은 방식으로 AsyncLocalStorage 에 매달아 둔다. 생성 진입점이 컨텍스트를 열면 그
 * 안에서 불리는 recordAiCost 는 전부 같은 uploadId 를 자동으로 달게 된다. 컨텍스트가
 * 끝난 뒤 도착하는 늦은 기록(헤지에서 진 호출 등)도 컨텍스트 안에서 만들어진 promise 라
 * 같은 값을 물려받는다.
 *
 * 잎 모듈 규칙: node 내장 모듈 외에는 import 하지 않는다 — 회귀 검사
 * `npm run check:upload-cost` 가 이 파일을 직접 불러온다.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface CostAttribution {
  uploadId: string;
  userId: string | null;
}

export interface EndpointTally {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface AttributedCostSnapshot {
  uploadId: string;
  /** 컨텍스트 안에서 기록된 비용 합계(USD). 헤지에서 진 호출도 실제로 나간 돈이라 포함한다. */
  totalUsd: number;
  /** 그중 헤지에서 진 호출 몫(USD) — 파이프라인 totalCost 는 이것을 빼고 센다. */
  hedgeLoserUsd: number;
  byEndpoint: Record<string, EndpointTally>;
}

interface AttributionState extends CostAttribution {
  byEndpoint: Record<string, EndpointTally>;
  hedgeLoserUsd: number;
}

const storage = new AsyncLocalStorage<AttributionState>();

/** 업로드 1건의 처리 흐름에 비용 귀속 컨텍스트를 연다. */
export function runWithCostAttribution<T>(
  attribution: CostAttribution,
  fn: () => Promise<T>,
): Promise<T> {
  const state: AttributionState = {
    uploadId: attribution.uploadId,
    userId: attribution.userId,
    byEndpoint: {},
    hedgeLoserUsd: 0,
  };
  return storage.run(state, fn);
}

export function currentCostAttribution(): CostAttribution | null {
  const state = storage.getStore();
  return state ? { uploadId: state.uploadId, userId: state.userId } : null;
}

/**
 * 기록할 metadata 에 uploadId 를 붙인다.
 *
 * 호출자가 uploadId 를 직접 넣었으면 그 값을 존중한다 — 컨텍스트와 다른 업로드를 위해
 * 부르는 경우(있다면)를 덮어쓰면 오히려 귀속이 틀어진다.
 */
export function attachUploadId(
  metadata: Record<string, unknown> | null | undefined,
  attribution: CostAttribution | null,
): Record<string, unknown> | null {
  if (!attribution) return metadata ?? null;
  if (metadata && metadata.uploadId !== undefined && metadata.uploadId !== null) {
    return metadata;
  }
  return { ...(metadata ?? {}), uploadId: attribution.uploadId };
}

/**
 * 컨텍스트 합계에 한 건을 더한다. 기록된 행의 uploadId 가 컨텍스트와 다르면 세지 않는다.
 */
export function tallyAttributedCost(input: {
  endpoint: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  metadata: Record<string, unknown> | null;
}): void {
  const state = storage.getStore();
  if (!state) return;
  const rowUpload = input.metadata?.uploadId;
  if (rowUpload !== undefined && rowUpload !== null && rowUpload !== state.uploadId) return;
  const cost = Number.isFinite(input.costUsd) ? input.costUsd : 0;
  const tally = (state.byEndpoint[input.endpoint] ??= {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
  });
  tally.costUsd += cost;
  tally.inputTokens += input.inputTokens || 0;
  tally.outputTokens += input.outputTokens || 0;
  tally.calls += 1;
  if (input.metadata?.hedgeLoser === true) state.hedgeLoserUsd += cost;
}

/** 지금까지 쌓인 합계. 컨텍스트 밖이면 null. */
export function attributedCostSnapshot(): AttributedCostSnapshot | null {
  const state = storage.getStore();
  if (!state) return null;
  const byEndpoint: Record<string, EndpointTally> = {};
  let totalUsd = 0;
  for (const [endpoint, tally] of Object.entries(state.byEndpoint)) {
    byEndpoint[endpoint] = { ...tally, costUsd: roundUsd(tally.costUsd) };
    totalUsd += tally.costUsd;
  }
  return {
    uploadId: state.uploadId,
    totalUsd: roundUsd(totalUsd),
    hedgeLoserUsd: roundUsd(state.hedgeLoserUsd),
    byEndpoint,
  };
}

/** ai_cost_log.cost_usd 가 numeric(10,6) 이라 같은 자릿수로 맞춘다. */
function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

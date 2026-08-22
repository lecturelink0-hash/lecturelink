/**
 * 요청 단위 계측 컨텍스트 (성능지표 가이드 §4.1 · 분담표 A1)
 *
 * 모든 요청에 고유 ID를 부여하고 기능·버전, 단계별 시간, 모델 사용량, 결과 상태와
 * 실패 원인, 품질 게이트 통과 여부를 한 레코드로 모은다.
 *
 * 왜 AsyncLocalStorage 인가: 계측 대상이 라우트 핸들러 안쪽 깊은 곳이다. 예를 들어
 * OCR 소요시간은 lib/extract 안에서, 토큰 사용량은 lib/ai/cost-cap 안에서 생긴다.
 * 이걸 전부 인자로 내려보내려면 호출 경로 전부의 시그니처를 바꿔야 한다 —
 * 계측을 넣자고 서비스 코드를 광범위하게 고치는 것은 비용도 위험도 크다.
 * ALS 는 요청 하나의 실행 흐름에 컨텍스트를 매달아 두므로, 계측이 필요한 지점만
 * `recordStage()` 를 부르면 된다.
 *
 * 계측이 서비스를 방해하지 않아야 한다는 원칙:
 *  - 컨텍스트가 없으면(배치 작업, 테스트) 모든 호출이 조용히 no-op 이다.
 *  - 저장 실패는 삼키고 로그만 남긴다.
 *  - 저장은 next/server 의 after() 로 응답 뒤로 미룬다.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type RequestStatus = 'success' | 'client_error' | 'server_error' | 'timeout';

export interface RequestMetricRecord {
  requestId: string;
  feature: string;
  version: string;
  userId: string | null;
  method: string;
  status: RequestStatus;
  statusCode: number;
  errorCode: string | null;
  totalMs: number;
  stages: Record<string, number>;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  models: string[];
  schemaValid: boolean | null;
  quality: Record<string, unknown> | null;
}

interface MutableContext {
  requestId: string;
  feature: string;
  version: string;
  userId: string | null;
  method: string;
  startedAt: number;
  stages: Record<string, number>;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  models: Set<string>;
  schemaValid: boolean | null;
  quality: Record<string, unknown> | null;
  errorCode: string | null;
}

const storage = new AsyncLocalStorage<MutableContext>();

export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

/** 계측 컨텍스트를 열고 핸들러를 실행한다. 컨텍스트가 이미 있으면 중첩하지 않는다. */
export function runWithRequestContext<T>(
  init: { feature: string; version: string; method: string; userId?: string | null; requestId?: string },
  fn: (context: { requestId: string }) => Promise<T>,
): Promise<T> {
  const existing = storage.getStore();
  if (existing) return fn({ requestId: existing.requestId });
  const context: MutableContext = {
    requestId: init.requestId ?? randomUUID(),
    feature: init.feature,
    version: init.version,
    userId: init.userId ?? null,
    method: init.method,
    startedAt: Date.now(),
    stages: {},
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    models: new Set<string>(),
    schemaValid: null,
    quality: null,
    errorCode: null,
  };
  return storage.run(context, () => fn({ requestId: context.requestId }));
}

/**
 * 단계별 소요시간 누적(ms). 같은 이름이 여러 번 열리면 합산한다 —
 * 배치 3개로 나뉜 생성의 총 생성 시간처럼, 반복 구간은 합이 병목을 더 잘 보여준다.
 */
export function recordStage(name: string, ms: number): void {
  const context = storage.getStore();
  if (!context || !Number.isFinite(ms)) return;
  context.stages[name] = (context.stages[name] ?? 0) + Math.max(0, Math.round(ms));
}

/** 구간을 감싸 소요시간을 자동 기록한다. 예외가 나도 그 시점까지의 시간은 남긴다. */
export async function stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    recordStage(name, Date.now() - started);
  }
}

/** AI 호출의 토큰·비용을 요청 합계에 더한다 (lib/ai/cost-cap 의 recordAiCost 가 부른다). */
export function addAiUsage(input: {
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}): void {
  const context = storage.getStore();
  if (!context) return;
  context.costUsd += Number.isFinite(input.costUsd) ? input.costUsd : 0;
  context.inputTokens += input.inputTokens || 0;
  context.outputTokens += input.outputTokens || 0;
  if (input.model) context.models.add(input.model);
}

/**
 * 품질 게이트 결과 (분담표 A4).
 * valid 가 null 로 남으면 이 요청은 스키마 준수율의 분모에서 빠진다 — 검사하지 않은 것과
 * 검사해서 통과한 것을 같은 칸에 넣으면 준수율이 실제보다 좋게 나온다.
 */
export function recordQuality(valid: boolean, detail?: Record<string, unknown>): void {
  const context = storage.getStore();
  if (!context) return;
  // 한 요청에서 여러 번 불리면(배치별 검사) 하나라도 위반이면 위반이다.
  context.schemaValid = context.schemaValid === false ? false : valid;
  if (!detail) return;
  // 배치가 여러 번이면 수치는 **더한다**. 덮어쓰면 마지막 배치의 문항 수만 남아
  // "10문항 중 위반 1건"이 "3문항 중 위반 1건"으로 보고된다.
  context.quality = mergeQuality(context.quality ?? {}, detail);
}

function mergeQuality(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const previous = merged[key];
    if (typeof value === 'number' && typeof previous === 'number') {
      merged[key] = previous + value;
    } else if (isCountMap(value) && isCountMap(previous)) {
      const counts: Record<string, number> = { ...previous };
      for (const [code, count] of Object.entries(value)) counts[code] = (counts[code] ?? 0) + count;
      merged[key] = counts;
    } else {
      // 임계값·판정 모드 같은 설정값은 배치마다 같으므로 마지막 값으로 둔다.
      merged[key] = value;
    }
  }
  return merged;
}

function isCountMap(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'number')
  );
}

/** 실패 원인을 상태 코드보다 구체적으로 남긴다 — 같은 500 안의 원인 분포가 보여야 고칠 수 있다. */
export function recordErrorCode(code: string): void {
  const context = storage.getStore();
  if (!context) return;
  context.errorCode = code;
}

export function classifyStatus(statusCode: number, errorCode: string | null): RequestStatus {
  if (statusCode === 504 || errorCode === 'timeout' || errorCode === 'generation_timeout') return 'timeout';
  if (statusCode < 400) return 'success';
  if (statusCode < 500) return 'client_error';
  return 'server_error';
}

/** 컨텍스트를 최종 레코드로 확정한다. 컨텍스트가 없으면 null. */
export function finalize(statusCode: number, fallbackErrorCode?: string | null): RequestMetricRecord | null {
  const context = storage.getStore();
  if (!context) return null;
  const errorCode = context.errorCode ?? (statusCode >= 400 ? fallbackErrorCode ?? `http_${statusCode}` : null);
  return {
    requestId: context.requestId,
    feature: context.feature,
    version: context.version,
    userId: context.userId,
    method: context.method,
    status: classifyStatus(statusCode, errorCode),
    statusCode,
    errorCode,
    totalMs: Date.now() - context.startedAt,
    stages: context.stages,
    costUsd: Number(context.costUsd.toFixed(6)),
    inputTokens: context.inputTokens,
    outputTokens: context.outputTokens,
    models: [...context.models].sort(),
    schemaValid: context.schemaValid,
    quality: context.quality,
  };
}

export function setUserId(userId: string | null): void {
  const context = storage.getStore();
  if (context && userId) context.userId = userId;
}

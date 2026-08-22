/**
 * 요청 계측 적재 (분담표 A1)
 *
 * request-context.ts 가 모은 레코드를 request_metrics 로 넣는다.
 * 계측은 서비스보다 뒤에 있어야 하므로:
 *  - 저장은 next/server 의 after() 로 응답을 보낸 뒤에 돈다.
 *  - 실패는 삼키고 로그만 남긴다. 계측 장애가 사용자 요청을 실패시키면 안 된다.
 *  - METRICS_ENABLED=false 로 통째로 끌 수 있다(끄면 1단계 실측이 사라지므로 예외 상황용).
 */
import { createAdminClient } from '@/lib/db/admin';
import { finalize, type RequestMetricRecord } from './request-context';
import { featureFromPath } from './feature';
import { versionForFeature } from '@/lib/ai/versions';

export { featureFromPath, versionForFeature };

export function metricsEnabled(): boolean {
  return process.env.METRICS_ENABLED !== 'false';
}

export async function persist(record: RequestMetricRecord): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from('request_metrics').insert({
    request_id: record.requestId,
    feature: record.feature,
    version: record.version,
    user_id: record.userId,
    method: record.method,
    status: record.status,
    status_code: record.statusCode,
    error_code: record.errorCode,
    total_ms: record.totalMs,
    stages: Object.keys(record.stages).length ? record.stages : null,
    cost_usd: record.costUsd,
    input_tokens: record.inputTokens,
    output_tokens: record.outputTokens,
    models: record.models.length ? record.models : null,
    schema_valid: record.schemaValid,
    quality: record.quality,
  } as never);
  if (error) console.error('[metrics] request_metrics insert 실패:', error.message);
}

/**
 * 응답 상태로 레코드를 확정하고 저장을 예약한다.
 * after() 를 쓸 수 없는 실행 환경(테스트 등)에서는 그 자리에서 await 한다.
 */
export async function finalizeAndPersist(statusCode: number, fallbackErrorCode?: string | null): Promise<void> {
  if (!metricsEnabled()) return;
  const record = finalize(statusCode, fallbackErrorCode);
  if (!record) return;
  try {
    const { after } = await import('next/server');
    after(() => persist(record).catch(() => {}));
  } catch {
    // after() 가 없는 환경(스크립트·테스트)에서는 직접 저장한다.
    await persist(record).catch(() => {});
  }
}

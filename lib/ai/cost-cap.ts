/**
 * AI 일일 비용 캡
 *
 * MAX_DAILY_AI_COST_USD 환경변수와 ai_cost_log 누적치를 비교.
 * 캡 초과 시 CostCapExceededException(402).
 *
 * 사용:
 *   - 진입 가드: await requireDailyCostCap();
 *   - 호출 후 기록: await recordAiCost({ userId, endpoint, model, costUsd, ... });
 */

import { createAdminClient } from '@/lib/db/admin';
import { ApiException, CostCapExceededException } from '@/lib/utils/api';

const DEFAULT_CAP_USD = 100;

function getCapUsd(): number {
  const raw = process.env.MAX_DAILY_AI_COST_USD;
  if (!raw) return DEFAULT_CAP_USD;
  const v = parseFloat(raw);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_CAP_USD;
}

/**
 * 진입 시 호출. 캡 초과 또는 RPC 실패 시 throw (fail-closed).
 *
 * fail-closed 이유: P0 비용 방어가 목적이므로 누적치를 확인할 수 없는 상태에서는
 * AI 호출을 차단해야 한다. RPC 실패가 일시적 문제라면 잠시 후 재시도 시 통과한다.
 */
export async function requireDailyCostCap(): Promise<void> {
  const admin = createAdminClient();
  const cap = getCapUsd();

  const { data, error } = await admin.rpc('check_daily_cost_within', {
    threshold_usd: cap,
  });

  if (error) {
    console.error('[cost-cap] RPC error:', error);
    throw new ApiException(
      'cost_cap_check_failed',
      '비용 한도 확인이 일시적으로 불가합니다. 잠시 후 다시 시도해주세요.',
      503,
    );
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new ApiException(
      'cost_cap_check_failed',
      '비용 한도 확인 결과가 비어 있습니다. 잠시 후 다시 시도해주세요.',
      503,
    );
  }
  if (row.within_cap === false) {
    throw new CostCapExceededException(Number(row.current_usd), cap);
  }
}

/**
 * AI 호출 후 비용 기록.
 */
export async function recordAiCost(input: {
  userId: string | null;
  endpoint: string;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  if (input.costUsd <= 0) return;
  const admin = createAdminClient();
  const { error } = await admin.from('ai_cost_log').insert({
    user_id: input.userId,
    endpoint: input.endpoint,
    model: input.model,
    cost_usd: input.costUsd,
    input_tokens: input.inputTokens,
    output_tokens: input.outputTokens,
    metadata: input.metadata ?? null,
  });
  if (error) {
    console.error('[cost-cap] insert error:', error);
  }
}

/**
 * 현재 일일 누적 비용 조회 (admin 페이지용).
 */
export async function getDailyCostUsd(): Promise<{
  currentUsd: number;
  capUsd: number;
  withinCap: boolean;
}> {
  const admin = createAdminClient();
  const cap = getCapUsd();
  const { data, error } = await admin.rpc('check_daily_cost_within', {
    threshold_usd: cap,
  });
  if (error || !data) return { currentUsd: 0, capUsd: cap, withinCap: true };
  const row = Array.isArray(data) ? data[0] : data;
  return {
    currentUsd: Number(row?.current_usd ?? 0),
    capUsd: cap,
    withinCap: row?.within_cap ?? true,
  };
}

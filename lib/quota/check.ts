/**
 * 사용량 quota 체크·차감 헬퍼
 *
 * 모든 AI 호출 직전에 quota 체크, 호출 후 성공 시 consume.
 * Postgres RPC 로 동시성·정합성 보장.
 */

import { createAdminClient } from '@/lib/db/admin';
import { ApiException } from '@/lib/utils/api';
import type { PlanTier } from '@/lib/types/database';

export type QuotaResource = 'questions' | 'uploads' | 'images';

export interface QuotaCheckResult {
  ok: boolean;
  planTier: PlanTier;
  limit: number;
  used: number;
  bonus: number;
  remaining: number;
}

/**
 * 무제한 모드 — env `QUOTA_UNLIMITED=true` 이면 요금제와 무관하게(무료 포함) 모든
 * 사용량 체크를 통과시키고 차감을 생략한다. 되돌리기: env 에서 제거(또는 false) 후 재시작.
 * (DB 한도 함수는 그대로 두고 앱 레벨에서만 우회 → 언제든 원복 가능.)
 */
export const QUOTA_UNLIMITED_VALUE = 9_999_999;
export function quotaUnlimited(): boolean {
  return process.env.QUOTA_UNLIMITED === 'true';
}
function unlimitedResult(): QuotaCheckResult {
  return {
    ok: true,
    planTier: 'free',
    limit: QUOTA_UNLIMITED_VALUE,
    used: 0,
    bonus: 0,
    remaining: QUOTA_UNLIMITED_VALUE,
  };
}

/**
 * 사용량 확인. ok=false 면 호출자가 throw 하거나 사용자에게 알림.
 */
export async function checkQuota(
  userId: string,
  resource: QuotaResource,
  amount = 1,
): Promise<QuotaCheckResult> {
  if (quotaUnlimited()) return unlimitedResult();
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('check_user_quota', {
    p_user_id: userId,
    p_resource: resource,
    p_amount: amount,
  });
  if (error) throw new Error(`[quota/check] ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return {
      ok: false,
      planTier: 'free',
      limit: 0,
      used: 0,
      bonus: 0,
      remaining: 0,
    };
  }

  return {
    ok: row.ok as boolean,
    planTier: row.plan_tier as PlanTier,
    limit: row.limit_amount as number,
    used: row.used_amount as number,
    bonus: row.bonus_amount as number,
    remaining: row.remaining as number,
  };
}

/**
 * quota 체크 + 미달 시 ApiException(402) 자동 throw.
 * AI 호출 직전 라우트에서 사용.
 */
export async function requireQuota(
  userId: string,
  resource: QuotaResource,
  amount = 1,
): Promise<QuotaCheckResult> {
  const check = await checkQuota(userId, resource, amount);
  if (!check.ok) {
    const resourceName: Record<QuotaResource, string> = {
      questions: '문항',
      uploads: '자료 업로드',
      images: '이미지 문항',
    };
    throw new ApiException(
      'quota_exceeded',
      `${resourceName[resource]} 사용량 한도(${check.limit + check.bonus}) 를 초과했습니다. ` +
        `현재 사용: ${check.used}, 남은 양: ${check.remaining}`,
      402,
      check,
    );
  }
  return check;
}

/**
 * 사용량 차감 (AI 호출 성공 후 호출).
 * 실패해도 throw 하지 않음 — 이미 AI 응답이 손 안에 있는 경로에서는
 * 차감 누락이 호출 실패보다 안전. 큐/결제처럼 차감 실패를 무시하면
 * 정합성이 깨지는 경로에서는 consumeQuotaStrict 를 사용.
 */
export async function consumeQuota(
  userId: string,
  resource: QuotaResource,
  amount = 1,
): Promise<void> {
  if (quotaUnlimited()) return;
  const admin = createAdminClient();
  const { error } = await admin.rpc('consume_quota', {
    p_user_id: userId,
    p_resource: resource,
    p_amount: amount,
  });
  if (error) {
    console.error('[quota/consume] failed:', error.message);
  }
}

/**
 * 사용량 차감 (strict). 실패 시 throw.
 *
 * 사용 시점:
 *   - 차감 누락이 곧 정합성 결함이 되는 경로 (큐 enqueue, 결제 reconciliation 등).
 *   - 호출자가 실패를 명시적으로 처리 (rollback / alert / 사용자 에러 응답) 해야 함.
 *
 * 주의: 이 함수는 한도 확인 없이 used 를 증가시키는 consume_quota RPC 를 호출한다.
 * 동시성 안전한 atomic check+consume 가 필요하면 consumeQuotaCheckedStrict 를 사용하라.
 */
export async function consumeQuotaStrict(
  userId: string,
  resource: QuotaResource,
  amount = 1,
): Promise<void> {
  if (quotaUnlimited()) return;
  const admin = createAdminClient();
  const { error } = await admin.rpc('consume_quota', {
    p_user_id: userId,
    p_resource: resource,
    p_amount: amount,
  });
  if (error) {
    throw new Error(`[quota/consume strict] ${error.message}`);
  }
}

/**
 * 원자적 check+consume.
 *
 * DB 레벨에서 usage_quotas 행을 FOR UPDATE 로 잠그고 한도 확인 → 차감을 한 트랜잭션
 * 안에서 처리. 동일 사용자에 대한 동시 호출은 직렬화되며, 한도 초과 시 used 는
 * 증가하지 않고 ok=false 가 반환된다.
 *
 * 사용 시점:
 *   - requireQuota + consumeQuota 분리 구조에서 race 로 한도 초과 차감이 가능한 경로.
 *   - 예: 업로드 큐 enqueue, 결제 후 reconcile 등 1 회 1 단위 확정 소비.
 *
 * - ok=true:  사용량이 amount 만큼 증가됨.
 * - ok=false: 한도 초과, 차감되지 않음.
 */
export async function consumeQuotaChecked(
  userId: string,
  resource: QuotaResource,
  amount = 1,
): Promise<QuotaCheckResult> {
  if (quotaUnlimited()) return unlimitedResult();
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('consume_quota_checked', {
    p_user_id: userId,
    p_resource: resource,
    p_amount: amount,
  });
  if (error) throw new Error(`[quota/consume_checked] ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    return {
      ok: false,
      planTier: 'free',
      limit: 0,
      used: 0,
      bonus: 0,
      remaining: 0,
    };
  }
  return {
    ok: row.ok as boolean,
    planTier: row.plan_tier as PlanTier,
    limit: row.limit_amount as number,
    used: row.used_amount as number,
    bonus: row.bonus_amount as number,
    remaining: row.remaining as number,
  };
}

/**
 * 원자적 check+consume (strict). 한도 초과 시 ApiException(402) 으로 throw.
 *
 * 호출자가 별도의 사전 requireQuota 를 두지 않아도 안전하게 동시성 정합성이 보장된다.
 */
export async function consumeQuotaCheckedStrict(
  userId: string,
  resource: QuotaResource,
  amount = 1,
): Promise<QuotaCheckResult> {
  const result = await consumeQuotaChecked(userId, resource, amount);
  if (!result.ok) {
    const resourceName: Record<QuotaResource, string> = {
      questions: '문항',
      uploads: '자료 업로드',
      images: '이미지 문항',
    };
    throw new ApiException(
      'quota_exceeded',
      `${resourceName[resource]} 사용량 한도(${result.limit + result.bonus}) 를 초과했습니다. ` +
        `현재 사용: ${result.used}, 남은 양: ${result.remaining}`,
      402,
      result,
    );
  }
  return result;
}

/**
 * 보너스 크레딧 추가 (결제 webhook 에서 호출).
 */
export async function addBonus(
  userId: string,
  resource: QuotaResource,
  amount: number,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.rpc('add_bonus_credits', {
    p_user_id: userId,
    p_resource: resource,
    p_amount: amount,
  });
  if (error) throw new Error(`[quota/bonus] ${error.message}`);
}

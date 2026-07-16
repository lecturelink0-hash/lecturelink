/**
 * 운영 알림 큐 — 최소 구현
 *
 * 현재는 console.error + Supabase ops_alerts 테이블 insert 만.
 * 향후 Slack webhook / 이메일은 별도 worker 가 ops_alerts 를 폴링.
 *
 * 사용:
 *   await reportAlert({
 *     severity: 'high',
 *     source: 'webhook/toss',
 *     message: '서명 검증 실패',
 *     payload: { ... },
 *   });
 */

import { createAdminClient } from '@/lib/db/admin';

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface AlertInput {
  severity: AlertSeverity;
  source: string;
  message: string;
  payload?: Record<string, unknown>;
}

export async function reportAlert(input: AlertInput): Promise<void> {
  const tag = `[alert/${input.severity}/${input.source}]`;
  console.error(tag, input.message, input.payload ?? '');

  try {
    const admin = createAdminClient();
    await admin.from('ops_alerts').insert({
      severity: input.severity,
      source: input.source,
      message: input.message,
      payload: input.payload ?? null,
    });
  } catch (error) {
    // 알림 인프라가 죽어도 호출자를 깨지 말 것
    console.error('[alert] persist failed:', error);
  }
}

/**
 * Supabase Admin 클라이언트 (Service Role)
 *
 * RLS를 우회하는 권한이므로 *반드시 서버 측에서만* 사용.
 * 사용자 세션과 무관하게 모든 데이터에 접근 가능.
 *
 * 용도:
 *  - 백그라운드 작업 (배치 통계, 임베딩 갱신 등)
 *  - 시스템 작업 (사용량 캡 체크, 결제 webhook 처리)
 *  - AI 생성 결과를 풀에 admission
 */

import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/types/database';

let adminClient: ReturnType<typeof createClient<Database>> | undefined;

export function createAdminClient() {
  if (typeof window !== 'undefined') {
    throw new Error(
      '[security] createAdminClient 은 서버에서만 호출 가능합니다.',
    );
  }

  if (adminClient) return adminClient;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      'NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 환경변수가 없습니다.',
    );
  }

  adminClient = createClient<Database>(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return adminClient;
}

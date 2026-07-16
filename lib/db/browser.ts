/**
 * Supabase 브라우저 클라이언트
 *
 * Client Components 에서 사용.
 * RLS 정책에 의해 보호되므로 직접 브라우저에 노출되어도 안전.
 */

import { createBrowserClient as createClient } from '@supabase/ssr';
import type { Database } from '@/lib/types/database';

let browserClient: ReturnType<typeof createClient<Database>> | undefined;

export function createBrowserClient() {
  if (browserClient) return browserClient;

  browserClient = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  return browserClient;
}

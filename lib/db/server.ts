/**
 * Supabase 서버 클라이언트
 *
 * Next.js Server Components / Route Handlers / Server Actions 에서 사용.
 * 사용자 세션 쿠키를 자동으로 전달하므로 RLS가 적용된다.
 */

import { createServerClient as createClient } from '@supabase/ssr';
import type { CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import type { Database } from '@/lib/types/database';

interface CookieToSet {
  name: string;
  value: string;
  options?: CookieOptions;
}

/**
 * @supabase/ssr 0.5.2 의 createServerClient 는 내부적으로
 * `@supabase/supabase-js/dist/module/lib/types` 경로의 GenericSchema 를 import 하는데,
 * 현재 설치된 @supabase/supabase-js 2.106 은 해당 경로를 더 이상 노출하지 않는다.
 * 결과적으로 Database generic 이 제대로 전달되지 않아 .from(...) 결과가 never 가 된다.
 * 명시적으로 SupabaseClient<Database> 로 reassert 해서 타입을 복구한다.
 */
export async function createServerClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies();

  const client = createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // Server Components 에서는 쿠키 설정 불가 — middleware 가 처리
          }
        },
      },
    },
  );
  return client as unknown as SupabaseClient<Database>;
}

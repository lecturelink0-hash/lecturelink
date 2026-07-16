/**
 * GET /api/schools — 학교 목록 조회
 *
 * 온보딩 화면의 학교 드롭다운에 사용.
 */

import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling } from '@/lib/utils/api';

export const GET = withErrorHandling(async (request: Request) => {
  const supabase = await createServerClient();
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') ?? 'medical';

  const { data, error } = await supabase
    .from('schools')
    .select('id, name, short_name, type')
    .eq('type', type)
    .order('name');

  if (error) throw error;

  return ok(data ?? []);
});

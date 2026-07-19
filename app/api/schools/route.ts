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

  const list = data ?? [];

  // 경상북도·대구 지역 의과대학을 최상단에 우선 배치(각 그룹 내 가나다순 유지).
  // DB 가 이미 name 오름차순(가나다순)이므로 partition 만 하면 순서가 보존된다.
  const DAEGU_GYEONGBUK = new Set(['경북대', '계명대', '대구가톨릭대', '동국대', '영남대']);
  const priority = list.filter((s) => DAEGU_GYEONGBUK.has(s.short_name));
  const rest = list.filter((s) => !DAEGU_GYEONGBUK.has(s.short_name));

  return ok([...priority, ...rest]);
});

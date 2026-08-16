/**
 * GET /api/subjects
 *
 * 과목 + sub_topic 트리 조회. 온보딩의 시험범위 체크리스트에 사용.
 *
 * Query:
 *   ?with_sub_topics=true  → sub_topic 포함 (기본 true)
 *   ?active_only=true      → 활성 과목만 (기본 true)
 */

import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling } from '@/lib/utils/api';

export const GET = withErrorHandling(async (request: Request) => {
  const supabase = await createServerClient();
  const { searchParams } = new URL(request.url);
  const activeOnly = searchParams.get('active_only') !== 'false';
  const withSubTopics = searchParams.get('with_sub_topics') !== 'false';

  // 과목 조회
  let subjectsQuery = supabase
    .from('subjects')
    .select('id, code, name, sort_order, is_active');

  if (activeOnly) {
    subjectsQuery = subjectsQuery.eq('is_active', true);
  }

  const { data: subjects, error: subjectsError } = await subjectsQuery
    .order('sort_order');

  if (subjectsError) throw subjectsError;

  // 과목/세부주제 구조는 드물게 바뀌므로 브라우저 캐시 허용(개인 캐시만) — 재방문 시 즉시 표시
  const cacheControl = 'private, max-age=300, stale-while-revalidate=3600';

  if (!withSubTopics) {
    // 마이페이지 등에서 매번 호출하는 경로. 아래 전체 트리와 같은 캐시 정책을 적용한다.
    const flat = ok(subjects ?? []);
    flat.headers.set('Cache-Control', cacheControl);
    return flat;
  }

  // sub_topics 조회 (한 번에 batch)
  const subjectIds = (subjects ?? []).map((s) => s.id);
  const { data: subTopics, error: stError } = await supabase
    .from('sub_topics')
    .select('id, subject_id, parent_id, level, code, name, exam_relevance, is_risk_category, sort_order')
    .in('subject_id', subjectIds)
    .order('sort_order');

  if (stError) throw stError;

  // 과목별로 그룹핑
  const result = (subjects ?? []).map((subject) => ({
    ...subject,
    sub_topics: (subTopics ?? []).filter((st) => st.subject_id === subject.id),
  }));

  const res = ok(result);
  res.headers.set('Cache-Control', cacheControl);
  return res;
});

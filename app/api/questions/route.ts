/**
 * GET /api/questions
 *
 * 공유 풀 문항 조회 (정답·해설 숨김 — QuestionForUser 형태).
 * 국시 대비 세부주제 풀이 / 내 문제집 카운트에 사용.
 *
 * Query:
 *   ?sub_topic_id=uuid        (단일)
 *   ?subject_id=uuid          (과목 전체 세부주제로 확장)
 *   ?tier=curated|community|beta
 *   ?status=active            (기본 active)
 *   ?limit=20                 (기본 20, 최대 50)
 *   ?count_only=true          → { count } 만 반환
 */

import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling } from '@/lib/utils/api';

const TIER_BADGE: Record<string, { label: string; color: 'curated' | 'community' | 'beta' }> = {
  curated: { label: '의사 검수', color: 'curated' },
  community: { label: 'AI 검증', color: 'community' },
  beta: { label: '베타', color: 'beta' },
};

export const GET = withErrorHandling(async (request: Request) => {
  await requireSession();
  const { searchParams } = new URL(request.url);
  const supabase = await createServerClient();

  const subTopicId = searchParams.get('sub_topic_id');
  const subjectId = searchParams.get('subject_id');
  const tier = searchParams.get('tier');
  const status = searchParams.get('status') ?? 'active';
  const countOnly = searchParams.get('count_only') === 'true';
  const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit') ?? 20)));

  // subject_id 가 오면 그 과목의 sub_topic 으로 확장
  let stIds: string[] | null = null;
  if (subjectId) {
    const { data: sts, error } = await supabase
      .from('sub_topics')
      .select('id')
      .eq('subject_id', subjectId);
    if (error) throw error;
    stIds = (sts ?? []).map((s) => s.id);
    if (stIds.length === 0) return ok(countOnly ? { count: 0 } : []);
  }

  if (countOnly) {
    let q = supabase
      .from('questions')
      .select('id', { count: 'exact', head: true })
      .eq('status', status as 'active');
    if (subTopicId) q = q.eq('sub_topic_id', subTopicId);
    else if (stIds) q = q.in('sub_topic_id', stIds);
    if (tier) q = q.eq('tier', tier as 'curated');
    const { count, error } = await q;
    if (error) throw error;
    return ok({ count: count ?? 0 });
  }

  let q = supabase
    .from('questions')
    .select(
      `
      id, stem, choices, concepts, difficulty, image_url, image_type, tier,
      sub_topic:sub_topics ( id, name, subject:subjects ( id, name ) )
    `,
    )
    .eq('status', status as 'active')
    .limit(limit);
  if (subTopicId) q = q.eq('sub_topic_id', subTopicId);
  else if (stIds) q = q.in('sub_topic_id', stIds);
  if (tier) q = q.eq('tier', tier as 'curated');

  const { data, error } = await q;
  if (error) throw error;

  const items = (data ?? []).map((row) => {
    const r = row as Record<string, any>;
    const st = r.sub_topic;
    return {
      id: r.id,
      stem: r.stem,
      choices: r.choices as string[],
      concepts: (r.concepts ?? []) as string[],
      difficulty: r.difficulty,
      imageUrl: r.image_url ?? null,
      imageType: r.image_type ?? null,
      tier: r.tier,
      badge: TIER_BADGE[r.tier] ?? TIER_BADGE.community,
      subjectName: st?.subject?.name ?? '기타',
      subTopicName: st?.name ?? '미분류',
      subTopicId: st?.id ?? null,
    };
  });

  return ok(items);
});

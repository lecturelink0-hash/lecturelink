/**
 * GET /api/questions/[id]?reveal=false
 *
 * 단일 공유 풀 문항 조회. 오답노트 '다시 풀기' / 모의고사 리뷰에 사용.
 * 기본은 정답·해설 숨김(QuestionForUser). ?reveal=true 면 정답·해설 포함.
 */

import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const TIER_BADGE: Record<string, { label: string; color: 'curated' | 'community' | 'beta' }> = {
  curated: { label: '의사 검수', color: 'curated' },
  community: { label: 'AI 검증', color: 'community' },
  beta: { label: '베타', color: 'beta' },
};

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = withErrorHandling(async (request: Request, context: RouteContext) => {
  await requireSession();
  const { id } = await context.params;
  const { searchParams } = new URL(request.url);
  const reveal = searchParams.get('reveal') === 'true';
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from('questions')
    .select(
      `
      id, stem, choices, answer_index, explanation, concepts, difficulty,
      image_url, image_type, tier, status,
      sub_topic:sub_topics ( id, name, subject:subjects ( id, name ) )
    `,
    )
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new ApiException('question_not_found', '문항을 찾을 수 없습니다.', 404);

  const r = data as Record<string, any>;
  const st = r.sub_topic;
  const subject = st?.subject;

  const base = {
    id: r.id,
    stem: r.stem,
    choices: r.choices as string[],
    concepts: r.concepts as string[],
    difficulty: r.difficulty,
    imageUrl: r.image_url ?? null,
    imageType: r.image_type ?? null,
    tier: r.tier,
    badge: TIER_BADGE[r.tier] ?? TIER_BADGE.community,
    subjectName: subject?.name ?? '기타',
    subTopicName: st?.name ?? '미분류',
    subTopicId: st?.id ?? null,
  };

  if (reveal) {
    return ok({ ...base, answerIndex: r.answer_index, explanation: r.explanation });
  }
  return ok(base);
});

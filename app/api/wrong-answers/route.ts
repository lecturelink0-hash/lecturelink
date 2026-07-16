/**
 * GET    /api/wrong-answers          — 오답노트 목록 (저장된 오답 + 문항 상세)
 * POST   /api/wrong-answers          — 오답노트에 저장 (체크한 문제만)
 * DELETE /api/wrong-answers?id=...    — 오답노트에서 제거
 *
 * question_id(공유 풀) 또는 private_question_id(내 강의노트) 중 하나로 식별.
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const TIER_BADGE: Record<string, { label: string; color: 'curated' | 'community' | 'beta' }> = {
  curated: { label: '의사 검수', color: 'curated' },
  community: { label: 'AI 검증', color: 'community' },
  beta: { label: '베타', color: 'beta' },
};

export const GET = withErrorHandling(async () => {
  await requireSession();
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from('saved_wrong_questions')
    .select(
      `
      id, source, selected_index, resolved, created_at, sub_topic_id,
      question:questions (
        id, stem, choices, answer_index, explanation, difficulty,
        image_url, image_type, tier
      ),
      private_question:private_questions (
        id, stem, choices, answer_index, explanation, difficulty
      ),
      sub_topic:sub_topics (
        id, name, subject:subjects ( id, name )
      )
    `,
    )
    .order('created_at', { ascending: false });

  if (error) throw error;

  const items = (data ?? []).map((row) => {
    const r = row as Record<string, any>;
    const q = r.question ?? r.private_question;
    const isPrivate = !r.question && !!r.private_question;
    const st = r.sub_topic;
    const subject = st?.subject;
    return {
      id: r.id,
      savedAt: r.created_at,
      source: r.source,
      resolved: r.resolved,
      selectedIndex: r.selected_index,
      isPrivate,
      question: q
        ? {
            id: q.id,
            stem: q.stem,
            choices: q.choices,
            answerIndex: q.answer_index,
            explanation: q.explanation,
            difficulty: q.difficulty,
            imageUrl: q.image_url ?? null,
            imageType: q.image_type ?? null,
            tier: q.tier ?? 'community',
            badge: TIER_BADGE[q.tier ?? 'community'] ?? TIER_BADGE.community,
          }
        : null,
      subjectName: subject?.name ?? (isPrivate ? '내 강의 노트' : '기타'),
      subTopicName: st?.name ?? '미분류',
      subTopicId: r.sub_topic_id,
    };
  });

  return ok(items);
});

const saveSchema = z
  .object({
    question_id: z.string().uuid().nullable().optional(),
    private_question_id: z.string().uuid().nullable().optional(),
    sub_topic_id: z.string().uuid().nullable().optional(),
    selected_index: z.number().int().min(0).max(4).nullable().optional(),
    source: z.enum(['exam', 'mock', 'practice', 'lecture_note']).default('exam'),
  })
  .refine((v) => v.question_id || v.private_question_id, {
    message: 'question_id 또는 private_question_id 가 필요합니다.',
  });

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const body = saveSchema.parse(await request.json());
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from('saved_wrong_questions')
    .upsert(
      {
        user_id: session.userId,
        question_id: body.question_id ?? null,
        private_question_id: body.private_question_id ?? null,
        sub_topic_id: body.sub_topic_id ?? null,
        selected_index: body.selected_index ?? null,
        source: body.source,
        resolved: false,
      },
      { onConflict: body.private_question_id ? 'user_id,private_question_id' : 'user_id,question_id' },
    )
    .select('id')
    .single();

  if (error) throw error;
  return ok({ id: data.id, saved: true }, 201);
});

export const DELETE = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const questionId = searchParams.get('question_id');
  if (!id && !questionId) {
    throw new ApiException('bad_request', 'id 또는 question_id 가 필요합니다.', 400);
  }
  const supabase = await createServerClient();

  let q = supabase.from('saved_wrong_questions').delete().eq('user_id', session.userId);
  if (id) q = q.eq('id', id);
  else if (questionId) q = q.eq('question_id', questionId);

  const { error } = await q;
  if (error) throw error;
  return ok({ deleted: true });
});

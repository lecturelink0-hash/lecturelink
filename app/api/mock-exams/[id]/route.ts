/**
 * GET   /api/mock-exams/[id]   — 세션 + 문항 (in_progress 면 정답 숨김, submitted 면 공개)
 * PATCH /api/mock-exams/[id]   — 답안 저장 / 표시 / 메모 / 제출(채점)
 *
 * Body(PATCH):
 *   { answers?: number[], flagged?: number[], memo?: string, action?: 'save' | 'submit' }
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { createAdminClient } from '@/lib/db/admin';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const TIER_BADGE: Record<string, { label: string; color: 'curated' | 'community' | 'beta' }> = {
  curated: { label: '의사 검수', color: 'curated' },
  community: { label: 'AI 검증', color: 'community' },
  beta: { label: '베타', color: 'beta' },
};

export const GET = withErrorHandling(async (_request: Request, context: RouteContext) => {
  const session = await requireSession();
  const { id } = await context.params;
  const supabase = await createServerClient();

  const { data: sess, error } = await supabase
    .from('mock_exam_sessions')
    .select('*')
    .eq('id', id)
    .eq('user_id', session.userId)
    .maybeSingle();
  if (error) throw error;
  if (!sess) throw new ApiException('not_found', '모의고사를 찾을 수 없습니다.', 404);

  const submitted = sess.status === 'submitted';

  const { data: qs, error: qErr } = await supabase
    .from('questions')
    .select(
      'id, stem, choices, answer_index, explanation, difficulty, image_url, image_type, tier, sub_topic:sub_topics(id, name, subject:subjects(name))',
    )
    .in('id', sess.question_ids);
  if (qErr) throw qErr;

  const byId = new Map((qs ?? []).map((q) => [(q as Record<string, any>).id, q as Record<string, any>]));
  const ordered = (sess.question_ids as string[])
    .map((qid) => byId.get(qid))
    .filter(Boolean)
    .map((q) => {
      const r = q as Record<string, any>;
      const st = r.sub_topic;
      return {
        id: r.id,
        stem: r.stem,
        choices: r.choices,
        difficulty: r.difficulty,
        imageUrl: r.image_url ?? null,
        imageType: r.image_type ?? null,
        tier: r.tier,
        badge: TIER_BADGE[r.tier] ?? TIER_BADGE.community,
        subjectName: st?.subject?.name ?? '기타',
        subTopicName: st?.name ?? '미분류',
        subTopicId: st?.id ?? null,
        ...(submitted ? { answerIndex: r.answer_index, explanation: r.explanation } : {}),
      };
    });

  return ok({
    session: {
      id: sess.id,
      title: sess.title,
      status: sess.status,
      total: sess.total,
      score: sess.score,
      answers: sess.answers,
      flagged: sess.flagged,
      memo: sess.memo,
      durationSeconds: sess.duration_seconds,
      startedAt: sess.started_at,
      submittedAt: sess.submitted_at,
    },
    questions: ordered,
  });
});

const patchSchema = z.object({
  answers: z.array(z.number().int().min(-1).max(4)).optional(),
  flagged: z.array(z.number().int().min(0)).optional(),
  memo: z.string().max(5000).nullable().optional(),
  action: z.enum(['save', 'submit']).default('save'),
});

export const PATCH = withErrorHandling(async (request: Request, context: RouteContext) => {
  const session = await requireSession();
  const { id } = await context.params;
  const body = patchSchema.parse(await request.json());
  const supabase = await createServerClient();
  const admin = createAdminClient();

  const { data: sess, error } = await supabase
    .from('mock_exam_sessions')
    .select('id, question_ids, status, total')
    .eq('id', id)
    .eq('user_id', session.userId)
    .maybeSingle();
  if (error) throw error;
  if (!sess) throw new ApiException('not_found', '모의고사를 찾을 수 없습니다.', 404);
  if (sess.status === 'submitted') {
    throw new ApiException('already_submitted', '이미 제출된 모의고사입니다.', 409);
  }

  const update: Record<string, unknown> = {};
  if (body.answers) update.answers = body.answers;
  if (body.flagged) update.flagged = body.flagged;
  if (body.memo !== undefined) update.memo = body.memo;

  if (body.action === 'submit') {
    const answers = body.answers ?? [];
    const qIds = sess.question_ids as string[];

    // 채점 — 정답 인덱스 조회
    const { data: qs, error: qErr } = await admin
      .from('questions')
      .select('id, answer_index, sub_topic_id')
      .in('id', qIds);
    if (qErr) throw qErr;
    const answerMap = new Map((qs ?? []).map((q) => [q.id, q.answer_index]));
    const subTopicMap = new Map((qs ?? []).map((q) => [q.id, q.sub_topic_id]));

    let score = 0;
    const attemptRows: Array<Record<string, unknown>> = [];
    qIds.forEach((qid, i) => {
      const sel = answers[i] ?? -1;
      const correct = answerMap.get(qid);
      const isCorrect = sel >= 0 && sel === correct;
      if (isCorrect) score += 1;
      if (sel >= 0) {
        attemptRows.push({
          user_id: session.userId,
          question_id: qid,
          track: 'smart_practice',
          selected_index: sel,
          is_correct: isCorrect,
          time_spent_seconds: null,
        });
      }
    });

    // 통계·약점·캘린더 반영을 위해 attempts 기록 (quota 는 생성 시 차감했으므로 미차감)
    if (attemptRows.length > 0) {
      const { error: aErr } = await admin.from('user_attempts').insert(attemptRows as never);
      if (aErr) console.warn('[mock submit] attempts insert failed:', aErr.message);
    }

    update.status = 'submitted';
    update.score = score;
    update.submitted_at = new Date().toISOString();
  }

  const { data: updated, error: upErr } = await supabase
    .from('mock_exam_sessions')
    .update(update as never)
    .eq('id', id)
    .eq('user_id', session.userId)
    .select('id, status, score, total')
    .single();
  if (upErr) throw upErr;

  return ok(updated);
});

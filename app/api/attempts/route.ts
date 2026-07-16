/**
 * POST /api/attempts
 *
 * 사용자가 문항을 풀었을 때 호출. 정답 여부 + 해설을 반환하고
 * user_attempts 테이블에 기록한다.
 *
 * track 에 따라 두 종류 문항을 지원:
 *   - 'smart_practice' → public questions. quota('questions'/'images') 차감.
 *   - 'lecture_note'   → 개인 private_questions. quota 면제(생성 시 이미 차감, 본인 자료).
 *
 * 약점 영역(user_weak_areas)은 sub_topic 이 분류된 경우 인라인 갱신한다.
 * public 통계(increment_question_stats)는 public 문항만 갱신한다.
 *
 * Body:
 *   {
 *     question_id: uuid,        // public 이면 questions.id, 개인이면 private_questions.id
 *     selected_index: 0~4,
 *     time_spent_seconds?: integer,
 *     track: 'smart_practice' | 'lecture_note',
 *     cohort_id?: uuid
 *   }
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { createAdminClient } from '@/lib/db/admin';
import { requireQuota, consumeQuota } from '@/lib/quota/check';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const bodySchema = z.object({
  question_id: z.string().uuid(),
  selected_index: z.number().int().min(0).max(4),
  time_spent_seconds: z.number().int().min(0).max(3600).optional(),
  track: z.enum(['smart_practice', 'lecture_note']),
  cohort_id: z.string().uuid().optional(),
});

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const body = bodySchema.parse(await request.json());

  const supabase = await createServerClient();
  const admin = createAdminClient();

  const isPrivate = body.track === 'lecture_note';

  // 1) 문항 조회 — track 에 따라 public questions 또는 개인 private_questions.
  let answerIndex: number;
  let explanation: string | null;
  let subTopicId: string | null;
  let isImageQuestion = false;

  if (isPrivate) {
    const { data: pq, error } = await admin
      .from('private_questions')
      .select('id, answer_index, explanation, sub_topic_id, user_id')
      .eq('id', body.question_id)
      .maybeSingle();
    if (error || !pq) {
      throw new ApiException('question_not_found', '문항을 찾을 수 없습니다.', 404);
    }
    // private 은 본인 것만 풀이 가능 (강의자료 IP 보호).
    if (pq.user_id !== session.userId) {
      throw new ApiException('forbidden', '본인 문항만 풀이할 수 있습니다.', 403);
    }
    answerIndex = pq.answer_index;
    explanation = pq.explanation;
    subTopicId = pq.sub_topic_id;
  } else {
    const { data: q, error } = await admin
      .from('questions')
      .select('id, answer_index, explanation, sub_topic_id, image_url')
      .eq('id', body.question_id)
      .maybeSingle();
    if (error || !q) {
      throw new ApiException('question_not_found', '문항을 찾을 수 없습니다.', 404);
    }
    answerIndex = q.answer_index;
    explanation = q.explanation;
    subTopicId = q.sub_topic_id;
    isImageQuestion = q.image_url !== null;
  }

  // 1-1) Quota 체크 — public 만. private 풀이는 생성 시 이미 차감했고 본인 자료라 무료.
  if (!isPrivate) {
    await requireQuota(session.userId, 'questions', 1);
    if (isImageQuestion) {
      await requireQuota(session.userId, 'images', 1);
    }
  }

  const isCorrect = body.selected_index === answerIndex;

  // 2) user_attempts 기록 — track 에 따라 정확히 한 컬럼만 채운다 (XOR 제약).
  const { data: attempt, error: attemptError } = await supabase
    .from('user_attempts')
    .insert({
      user_id: session.userId,
      question_id: isPrivate ? null : body.question_id,
      private_question_id: isPrivate ? body.question_id : null,
      cohort_id: body.cohort_id ?? null,
      track: body.track,
      selected_index: body.selected_index,
      is_correct: isCorrect,
      time_spent_seconds: body.time_spent_seconds ?? null,
    })
    .select('id')
    .single();

  if (attemptError) throw attemptError;

  // 3) public questions 통계 비동기 업데이트 (private 은 통계 테이블 없음 — 스킵).
  if (!isPrivate) {
    void admin
      .rpc('increment_question_stats', {
        p_question_id: body.question_id,
        p_is_correct: isCorrect,
      })
      .then(({ error }) => {
        if (error) console.warn('[attempts] stats update failed:', error.message);
      });
  }

  // 4) user_weak_areas 인라인 업데이트 — sub_topic 이 분류된 경우만 (public/private 공통).
  if (subTopicId) {
    const { data: existing } = await admin
      .from('user_weak_areas')
      .select('error_count, attempt_count')
      .eq('user_id', session.userId)
      .eq('sub_topic_id', subTopicId)
      .maybeSingle();

    const newAttemptCount = (existing?.attempt_count ?? 0) + 1;
    const newErrorCount = (existing?.error_count ?? 0) + (isCorrect ? 0 : 1);
    const newErrorRate =
      newAttemptCount === 0 ? 0 : newErrorCount / newAttemptCount;

    // severity: error_rate 기반 (>0.5 → 3, >0.3 → 2, else 1) + 최소 5회 시도 조건
    const severity =
      newAttemptCount >= 5 && newErrorRate > 0.5
        ? 3
        : newAttemptCount >= 5 && newErrorRate > 0.3
          ? 2
          : 1;

    await admin.from('user_weak_areas').upsert(
      {
        user_id: session.userId,
        sub_topic_id: subTopicId,
        attempt_count: newAttemptCount,
        error_count: newErrorCount,
        severity,
      },
      { onConflict: 'user_id,sub_topic_id' },
    );
  }

  // 5) Quota 차감 — public 만.
  if (!isPrivate) {
    await consumeQuota(session.userId, 'questions', 1);
    if (isImageQuestion) {
      await consumeQuota(session.userId, 'images', 1);
    }
  }

  return ok({
    attempt_id: attempt.id,
    is_correct: isCorrect,
    correct_index: answerIndex,
    explanation,
  });
});

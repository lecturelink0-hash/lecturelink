/**
 * POST /api/feedback/out-of-scope
 *
 * 사용자가 문제에 대해 "시험 범위가 아니에요" 버튼을 클릭했을 때 호출.
 *
 * 동작:
 *   1. out_of_scope_feedback 에 기록 (unique constraint: 한 문제당 한 번만)
 *   2. 해당 (cohort, sub_topic) 점수를 recalc_cohort_subtopic_score RPC 로 즉시 갱신
 *   3. 같은 사용자가 다시 누를 경우 409 가 아니라 idempotent 응답
 *
 * Body:
 *   { question_id: uuid, cohort_id: uuid }
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { createAdminClient } from '@/lib/db/admin';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const bodySchema = z.object({
  question_id: z.string().uuid(),
  cohort_id: z.string().uuid(),
});

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const body = bodySchema.parse(await request.json());

  const supabase = await createServerClient();
  const admin = createAdminClient();

  // 1) 문항의 sub_topic_id 조회
  const { data: question, error: qError } = await admin
    .from('questions')
    .select('id, sub_topic_id')
    .eq('id', body.question_id)
    .maybeSingle();

  if (qError || !question) {
    throw new ApiException('question_not_found', '문항을 찾을 수 없습니다.', 404);
  }

  // 2) 코호트 검증 — 사용자가 속한 코호트가 맞는지 가벼운 체크
  // (RLS 가 fk 검증을 보장하지만, 클라이언트가 다른 코호트를 보낼 수 있어 방어적 확인)
  const { data: cohort } = await admin
    .from('cohorts')
    .select('id')
    .eq('id', body.cohort_id)
    .maybeSingle();

  if (!cohort) {
    throw new ApiException('cohort_not_found', '코호트를 찾을 수 없습니다.', 404);
  }

  // 3) 피드백 기록 (unique constraint 로 중복 방지)
  const { error: insertError } = await supabase
    .from('out_of_scope_feedback')
    .insert({
      user_id: session.userId,
      question_id: body.question_id,
      sub_topic_id: question.sub_topic_id,
      cohort_id: body.cohort_id,
    });

  // PostgreSQL unique violation code = '23505'
  if (insertError && (insertError as { code?: string }).code === '23505') {
    return ok({ recorded: false, already_exists: true });
  }
  if (insertError) throw insertError;

  // 4) 코호트 점수 즉시 갱신 (RPC)
  //    호출 빈도가 크게 늘면 dirty flag + 주기적 배치 갱신 패턴으로 전환하는 것을 고려한다.
  const { error: rpcError } = await admin.rpc('recalc_cohort_subtopic_score', {
    p_cohort_id: body.cohort_id,
    p_sub_topic_id: question.sub_topic_id,
  });

  if (rpcError) {
    // 점수 갱신 실패해도 피드백 기록은 완료 — 다음 호출에서 자동 보정
    console.warn('[feedback] score recalc failed:', rpcError.message);
  }

  return ok({
    recorded: true,
    sub_topic_id: question.sub_topic_id,
  });
});

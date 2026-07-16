/**
 * GET /api/questions/recommend
 *
 * 사용자에게 풀이할 다음 문항들을 추천한다.
 *
 * Query:
 *   cohort_id?    : 코호트 ID (있으면 학교 필터 적용)
 *   subject_id?   : 과목 ID (cohort_id 없을 때 사용)
 *   count?        : 추천 문항 수 (기본 10)
 *
 * 응답:
 *   {
 *     questions: QuestionForUser[],
 *     rationale: { allocations, weakSubTopics, ... }
 *   }
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { recommendQuestions } from '@/lib/recommend/engine';
import { ok, withErrorHandling } from '@/lib/utils/api';

const querySchema = z.object({
  cohort_id: z.string().uuid().optional(),
  subject_id: z.string().uuid().optional(),
  count: z.coerce.number().int().min(1).max(50).optional(),
});

export const GET = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const { searchParams } = new URL(request.url);
  const params = querySchema.parse(Object.fromEntries(searchParams));

  const result = await recommendQuestions({
    userId: session.userId,
    cohortId: params.cohort_id,
    subjectId: params.subject_id,
    count: params.count,
  });

  return ok(result);
});

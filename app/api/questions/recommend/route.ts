/**
 * GET /api/questions/recommend
 *
 * 사용자에게 풀이할 다음 문항들을 추천한다.
 *
 * Query:
 *   cohort_id?    : 코호트 ID (있으면 학교 필터 적용)
 *   subject_id?   : 과목 ID (코호트 점수를 이 과목으로 좁힘)
 *   sub_topic_id? : 세부주제 ID — 약점 집중 코스. 있으면 이 주제 문항만 추천
 *   count?        : 추천 문항 수 (기본 10)
 *
 * 응답:
 *   {
 *     questions: QuestionForUser[],
 *     rationale: { allocations, weakSubTopics, ... }
 *   }
 */

import { z } from 'zod';
import { requireAuthUser } from '@/lib/auth/session';
import { recommendQuestions } from '@/lib/recommend/engine';
import { ok, withErrorHandling } from '@/lib/utils/api';

const querySchema = z.object({
  cohort_id: z.string().uuid().optional(),
  subject_id: z.string().uuid().optional(),
  sub_topic_id: z.string().uuid().optional(),
  count: z.coerce.number().int().min(1).max(50).optional(),
});

export const GET = withErrorHandling(async (request: Request) => {
  const session = await requireAuthUser();
  const { searchParams } = new URL(request.url);
  const params = querySchema.parse(Object.fromEntries(searchParams));

  const result = await recommendQuestions({
    userId: session.userId,
    cohortId: params.cohort_id,
    subjectId: params.subject_id,
    subTopicId: params.sub_topic_id,
    count: params.count,
  });

  return ok(result);
});

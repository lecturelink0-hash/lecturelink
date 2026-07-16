/**
 * GET /api/cohorts/lookup
 *
 * (school_id, grade, year, semester, subject_id) 조합으로 코호트를 찾고
 * 같은 코호트의 sub_topic inclusion_score 데이터를 반환한다.
 *
 * 온보딩에서 "선배 N% 포함" 데이터를 보여주는 API.
 *
 * Query:
 *   school_id, grade, year, semester, subject_id (모두 필수)
 *
 * 응답:
 *   {
 *     cohort_id: string | null,    // 같은 코호트가 없으면 null
 *     sample_size: number,
 *     scores: [{ sub_topic_id, inclusion_score, confidence, sample_size }, ...]
 *   }
 *
 * 같은 학기·년도가 없으면 직전 학기 또는 직전 년도 데이터로 폴백.
 */

import { z } from 'zod';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling } from '@/lib/utils/api';
import type { GradeLevel, SemesterTerm } from '@/lib/types/database';

const querySchema = z.object({
  school_id: z.string().uuid(),
  grade: z.enum(['pre_1', 'pre_2', 'med_1', 'med_2', 'med_3', 'med_4']),
  year: z.coerce.number().int().min(2024).max(2030),
  semester: z.enum(['spring', 'fall']),
  subject_id: z.string().uuid(),
});

export const GET = withErrorHandling(async (request: Request) => {
  const supabase = await createServerClient();
  const { searchParams } = new URL(request.url);
  const params = querySchema.parse(Object.fromEntries(searchParams));

  // 1) 현재 학기 코호트 찾기
  const { data: currentCohort } = await supabase
    .from('cohorts')
    .select('id')
    .eq('school_id', params.school_id)
    .eq('grade', params.grade as GradeLevel)
    .eq('year', params.year)
    .eq('semester', params.semester as SemesterTerm)
    .eq('subject_id', params.subject_id)
    .maybeSingle();

  // 2) 직전 학기/년도 코호트 폴백 찾기
  // 사용자가 학기를 시작하는 시점엔 현재 학기 데이터가 없을 수 있음
  let fallbackCohortId: string | null = null;
  if (!currentCohort) {
    const fallbackQuery = await supabase
      .from('cohorts')
      .select('id, year, semester')
      .eq('school_id', params.school_id)
      .eq('grade', params.grade as GradeLevel)
      .eq('subject_id', params.subject_id)
      .or(
        params.semester === 'fall'
          ? `and(year.eq.${params.year},semester.eq.spring)`
          : `year.lt.${params.year}`,
      )
      .order('year', { ascending: false })
      .order('semester', { ascending: false })
      .limit(1)
      .maybeSingle();
    fallbackCohortId = fallbackQuery.data?.id ?? null;
  }

  const cohortId = currentCohort?.id ?? fallbackCohortId;

  if (!cohortId) {
    return ok({
      cohort_id: null,
      is_fallback: false,
      sample_size: 0,
      scores: [],
    });
  }

  // 3) 코호트의 sub_topic 점수 조회
  const { data: scores, error: scoresError } = await supabase
    .from('cohort_sub_topic_scores')
    .select('sub_topic_id, inclusion_score, confidence, sample_size')
    .eq('cohort_id', cohortId)
    .order('inclusion_score', { ascending: false });

  if (scoresError) throw scoresError;

  const maxSample = (scores ?? []).reduce(
    (max, s) => Math.max(max, s.sample_size),
    0,
  );

  return ok({
    cohort_id: cohortId,
    is_fallback: !currentCohort,
    sample_size: maxSample,
    scores: scores ?? [],
  });
});

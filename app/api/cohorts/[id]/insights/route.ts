/**
 * GET /api/cohorts/[id]/insights
 *
 * 코호트의 학습 인사이트를 조회. 대시보드·온보딩에서 사용.
 *
 * 반환:
 *   - cohort: 코호트 메타 정보 (학교·학년·학기·과목)
 *   - active_users: 30일 이내 활성 사용자 수
 *   - in_scope_top: 시험 범위로 강하게 분류된 sub_topic top-N
 *   - out_of_scope_top: 시험 범위 아님으로 분류된 sub_topic top-N
 *   - curriculum_drift: 직전 학기 대비 ±0.3 이상 변동한 sub_topic
 *   - avg_accuracy: 코호트 평균 정답률
 *
 * 인증 필요. 코호트는 마스터 데이터이므로 본인 코호트 외에도 조회 가능.
 */

import { requireSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = withErrorHandling(async (
  _request: Request,
  context: RouteContext,
) => {
  await requireSession();
  const { id: cohortId } = await context.params;

  const admin = createAdminClient();

  // 1) 코호트 메타 + 학교/과목 join
  const { data: cohort, error: cohortError } = await admin
    .from('cohorts')
    .select(
      `
      id,
      grade,
      year,
      semester,
      school:schools ( id, name, short_name ),
      subject:subjects ( id, name, code )
    `,
    )
    .eq('id', cohortId)
    .maybeSingle();

  if (cohortError || !cohort) {
    throw new ApiException('cohort_not_found', '코호트를 찾을 수 없습니다.', 404);
  }

  // 2) 활성 사용자 수
  const { data: activeUsers } = await admin.rpc('cohort_active_users', {
    p_cohort_id: cohortId,
    p_days: 30,
  });

  // 3) Sub_topic 점수 (in_scope / out_of_scope 분리)
  const { data: scores } = await admin
    .from('cohort_sub_topic_scores')
    .select(
      `
      sub_topic_id,
      inclusion_score,
      confidence,
      sample_size,
      sub_topic:sub_topics ( id, name, exam_relevance, is_risk_category )
    `,
    )
    .eq('cohort_id', cohortId)
    .order('inclusion_score', { ascending: false });

  type ScoreRow = {
    sub_topic_id: string;
    inclusion_score: number;
    confidence: number;
    sample_size: number;
    sub_topic:
      | { id: string; name: string; exam_relevance: number; is_risk_category: boolean }
      | { id: string; name: string; exam_relevance: number; is_risk_category: boolean }[]
      | null;
  };

  const normalize = (row: ScoreRow) => {
    const st = Array.isArray(row.sub_topic) ? row.sub_topic[0] : row.sub_topic;
    return {
      sub_topic_id: row.sub_topic_id,
      sub_topic_name: st?.name ?? '',
      exam_relevance: st?.exam_relevance ?? 2,
      is_risk_category: st?.is_risk_category ?? false,
      inclusion_score: Number(row.inclusion_score.toFixed(3)),
      confidence: Number(row.confidence.toFixed(2)),
      sample_size: row.sample_size,
    };
  };

  const normalizedScores = (scores ?? []).map((s) => normalize(s as ScoreRow));
  const inScopeTop = normalizedScores
    .filter((s) => s.inclusion_score >= 0.7 && s.confidence >= 0.6)
    .slice(0, 10);
  const outOfScopeTop = [...normalizedScores]
    .filter((s) => s.inclusion_score <= 0.3 && s.confidence >= 0.6)
    .sort((a, b) => a.inclusion_score - b.inclusion_score)
    .slice(0, 10);

  // 4) 교육과정 드리프트
  const { data: drift } = await admin.rpc('detect_curriculum_drift', {
    p_cohort_id: cohortId,
  });

  // 5) 평균 정답률 (cohort 단위)
  const { data: attemptStats } = await admin
    .from('user_attempts')
    .select('is_correct')
    .eq('cohort_id', cohortId)
    .limit(5000);

  let avgAccuracy: number | null = null;
  if (attemptStats && attemptStats.length > 0) {
    const correctCount = attemptStats.filter((a) => a.is_correct).length;
    avgAccuracy = Number((correctCount / attemptStats.length).toFixed(3));
  }

  // 응답 빌드
  const school = Array.isArray(cohort.school) ? cohort.school[0] : cohort.school;
  const subject = Array.isArray(cohort.subject) ? cohort.subject[0] : cohort.subject;

  return ok({
    cohort: {
      id: cohort.id,
      grade: cohort.grade,
      year: cohort.year,
      semester: cohort.semester,
      school: school
        ? {
            id: (school as { id: string }).id,
            name: (school as { name: string }).name,
            short_name: (school as { short_name: string }).short_name,
          }
        : null,
      subject: subject
        ? {
            id: (subject as { id: string }).id,
            name: (subject as { name: string }).name,
            code: (subject as { code: string }).code,
          }
        : null,
    },
    active_users: activeUsers ?? 0,
    in_scope_top: inScopeTop,
    out_of_scope_top: outOfScopeTop,
    curriculum_drift: drift ?? [],
    avg_accuracy: avgAccuracy,
    sample_size: normalizedScores.reduce(
      (max, s) => Math.max(max, s.sample_size),
      0,
    ),
  });
});

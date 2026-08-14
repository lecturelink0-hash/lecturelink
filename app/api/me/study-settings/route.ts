/**
 * GET /api/me/study-settings
 * PUT /api/me/study-settings
 *
 * #150 온보딩 간소화에서 "온보딩 이후 필요한 화면에서 설정한다"로 미뤄졌던
 * 학기·수강 과목 설정의 실제 설정 지점.
 *
 * - GET: 코호트 배정에 필요한 프로필 값(학교·학년·학기·연도)을 돌려준다.
 * - PUT: 학기·연도를 저장하고 (학교, 학년, 학기, 연도, 과목) 조합의 코호트를
 *   lookup-or-create 해 배정한다. 과목 선택 자체는 users 에 컬럼이 없어
 *   서버에 저장하지 않는다 — 클라이언트가 기억하고, 코호트가 조합을 보존한다.
 */

import { z } from 'zod';
import { requireStudent } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { createAdminClient } from '@/lib/db/admin';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
import type { GradeLevel, SemesterTerm } from '@/lib/types/database';

export const GET = withErrorHandling(async () => {
  const session = await requireStudent();
  const supabase = await createServerClient();

  const { data: me, error } = await supabase
    .from('users')
    .select('school_id, grade, current_semester, current_year')
    .eq('id', session.userId)
    .single();

  if (error) throw error;

  return ok({
    school_id: me.school_id,
    grade: me.grade,
    semester: me.current_semester,
    year: me.current_year,
  });
});

const putSchema = z.object({
  semester: z.enum(['spring', 'fall']),
  year: z.number().int().min(2024).max(2030),
  subject_id: z.string().uuid(),
});

export const PUT = withErrorHandling(async (request: Request) => {
  const session = await requireStudent();
  const body = putSchema.parse(await request.json());

  const supabase = await createServerClient();
  const admin = createAdminClient();

  const { data: me } = await supabase
    .from('users')
    .select('school_id, grade')
    .eq('id', session.userId)
    .single();

  if (!me?.school_id || !me.grade) {
    throw new ApiException(
      'profile_incomplete',
      '소속 의과대학과 학년을 먼저 저장해 주세요.',
      400,
    );
  }

  const { data: subject } = await supabase
    .from('subjects')
    .select('id, name')
    .eq('id', body.subject_id)
    .eq('is_active', true)
    .maybeSingle();

  if (!subject) throw new ApiException('subject_not_found', '과목을 찾을 수 없습니다.', 404);

  // 코호트 lookup-or-create (구 온보딩과 동일한 조합 키)
  let cohortId: string;

  const { data: existing } = await admin
    .from('cohorts')
    .select('id')
    .eq('school_id', me.school_id)
    .eq('grade', me.grade as GradeLevel)
    .eq('semester', body.semester as SemesterTerm)
    .eq('year', body.year)
    .eq('subject_id', body.subject_id)
    .maybeSingle();

  if (existing) {
    cohortId = existing.id;
  } else {
    const { data: created, error: createError } = await admin
      .from('cohorts')
      .insert({
        school_id: me.school_id,
        grade: me.grade as GradeLevel,
        semester: body.semester as SemesterTerm,
        year: body.year,
        subject_id: body.subject_id,
      })
      .select('id')
      .single();

    if (createError || !created) {
      throw new ApiException('cohort_create_failed', '코호트 생성에 실패했습니다.', 500);
    }
    cohortId = created.id;
  }

  const { error: updateError } = await supabase
    .from('users')
    .update({
      current_semester: body.semester as SemesterTerm,
      current_year: body.year,
    })
    .eq('id', session.userId);

  if (updateError) throw updateError;

  return ok({
    cohort_id: cohortId,
    subject_name: subject.name,
  });
});

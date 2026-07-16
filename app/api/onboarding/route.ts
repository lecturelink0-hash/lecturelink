/**
 * POST /api/onboarding
 *
 * 사용자가 학교·학년·학기를 입력하고 첫 코호트를 결정하는 단계.
 * 입력값으로 코호트를 자동 lookup 또는 생성하고 사용자 프로필을 갱신한다.
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { createAdminClient } from '@/lib/db/admin';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
import type { GradeLevel, SemesterTerm } from '@/lib/types/database';

const bodySchema = z.object({
  school_id: z.string().uuid(),
  grade: z.enum(['pre_1', 'pre_2', 'med_1', 'med_2', 'med_3', 'med_4']),
  semester: z.enum(['spring', 'fall']),
  year: z.number().int().min(2024).max(2030),
  subject_id: z.string().uuid(),
  // 기획서: 회원가입 시 서비스 이용 목적 / 추천인 코드(선택) / 알게된 경로(선택)
  study_purpose: z.enum(['naesin', 'kmle', 'usmle', 'other']).optional(),
  referral_code: z.string().max(50).nullable().optional(),
  acquisition_channel: z.string().max(100).nullable().optional(),
});

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const body = bodySchema.parse(await request.json());

  const supabase = await createServerClient();
  const admin = createAdminClient();

  // 1) 학교·과목 유효성 확인
  const [{ data: school }, { data: subject }] = await Promise.all([
    supabase.from('schools').select('id, name').eq('id', body.school_id).maybeSingle(),
    supabase.from('subjects').select('id, name').eq('id', body.subject_id).maybeSingle(),
  ]);

  if (!school) throw new ApiException('school_not_found', '학교를 찾을 수 없습니다.', 404);
  if (!subject) throw new ApiException('subject_not_found', '과목을 찾을 수 없습니다.', 404);

  // 2) 코호트 lookup-or-create
  let cohortId: string;

  const { data: existing } = await admin
    .from('cohorts')
    .select('id')
    .eq('school_id', body.school_id)
    .eq('grade', body.grade as GradeLevel)
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
        school_id: body.school_id,
        grade: body.grade as GradeLevel,
        semester: body.semester as SemesterTerm,
        year: body.year,
        subject_id: body.subject_id,
      })
      .select('id')
      .single();

    if (createError || !created) {
      throw new ApiException('cohort_create_failed', '코호트 생성 실패', 500);
    }
    cohortId = created.id;
  }

  // 3) 사용자 프로필 업데이트
  const { data: updated, error: updateError } = await supabase
    .from('users')
    .update({
      school_id: body.school_id,
      grade: body.grade as GradeLevel,
      current_semester: body.semester as SemesterTerm,
      current_year: body.year,
      study_purpose: body.study_purpose ?? null,
      referral_code: body.referral_code ?? null,
      acquisition_channel: body.acquisition_channel ?? null,
      onboarded_at: new Date().toISOString(),
    })
    .eq('id', session.userId)
    .select()
    .single();

  if (updateError) throw updateError;

  return ok({
    user: updated,
    cohort_id: cohortId,
    school_name: school.name,
    subject_name: subject.name,
  });
});

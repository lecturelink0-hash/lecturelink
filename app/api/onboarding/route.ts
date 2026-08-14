/**
 * POST /api/onboarding
 *
 * 학생이 학교·학년과 서비스 이용 목적을 입력하고 가입 설정을 마치는 단계.
 * 과목과 학기, 추천 범위는 온보딩 이후 필요한 화면에서 설정한다.
 */

import { z } from 'zod';
import { requireStudent } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
import type { GradeLevel } from '@/lib/types/database';

const bodySchema = z
  .object({
    school_id: z.string().uuid(),
    grade: z.enum(['pre_1', 'pre_2', 'med_1', 'med_2', 'med_3', 'med_4']),
    study_purpose: z.enum(['naesin', 'cpx', 'other']),
    study_purpose_detail: z.string().trim().max(100).nullable().optional(),
    acquisition_channel: z.string().trim().max(100).nullable().optional(),
  })
  .superRefine((body, context) => {
    if (body.study_purpose === 'other' && !body.study_purpose_detail) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['study_purpose_detail'],
        message: '기타 이용 목적을 입력해 주세요.',
      });
    }
  });

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireStudent();
  const body = bodySchema.parse(await request.json());

  const supabase = await createServerClient();

  const { data: school } = await supabase
    .from('schools')
    .select('id, name')
    .eq('id', body.school_id)
    .eq('type', 'medical')
    .maybeSingle();

  if (!school) throw new ApiException('school_not_found', '학교를 찾을 수 없습니다.', 404);

  const { data: updated, error: updateError } = await supabase
    .from('users')
    .update({
      school_id: body.school_id,
      grade: body.grade as GradeLevel,
      study_purpose: body.study_purpose,
      study_purpose_detail: body.study_purpose === 'other' ? body.study_purpose_detail : null,
      acquisition_channel: body.acquisition_channel ?? null,
      onboarded_at: new Date().toISOString(),
    })
    .eq('id', session.userId)
    .select()
    .single();

  if (updateError) throw updateError;

  return ok({
    user: updated,
    school_name: school.name,
  });
});

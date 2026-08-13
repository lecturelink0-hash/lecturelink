import { z } from 'zod';
import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';

const CHANNEL_OPTIONS = ['학교 관계자 소개', '동료 교수 추천', '학생 추천', 'SNS/유튜브', '검색', '기타'] as const;

const bodySchema = z.object({
  display_name: z.string().trim().min(1).max(50),
  school_id: z.string().uuid(),
  acquisition_channel: z.enum(CHANNEL_OPTIONS),
});

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireProfessor();
  const body = bodySchema.parse(await request.json());
  const supabase = await createServerClient();

  const { data: school, error: schoolError } = await supabase
    .from('schools')
    .select('id, name, short_name')
    .eq('id', body.school_id)
    .eq('type', 'medical')
    .maybeSingle();

  if (schoolError) throw schoolError;
  if (!school) throw new ApiException('invalid_school', '등록된 의과대학을 선택해 주세요.', 400);

  const { data: user, error: updateError } = await supabase
    .from('users')
    .update({
      display_name: body.display_name,
      school_id: body.school_id,
      acquisition_channel: body.acquisition_channel,
      onboarded_at: new Date().toISOString(),
    })
    .eq('id', session.userId)
    .select()
    .single();

  if (updateError) throw updateError;
  return ok({ user, school });
});

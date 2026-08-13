/**
 * GET  /api/me       — 현재 사용자 프로필 조회
 * PATCH /api/me      — 프로필 부분 수정 (display_name 등)
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling } from '@/lib/utils/api';

// ───────────── GET ─────────────

export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  return ok(session.profile);
});

// ───────────── PATCH ─────────────

const patchSchema = z.object({
  display_name: z.string().trim().min(1).max(50).optional(),
  school_id: z.string().uuid().optional(),
});

export const PATCH = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const body = patchSchema.parse(await request.json());

  const supabase = await createServerClient();
  if (body.school_id) {
    if (session.profile.accountType !== 'professor' && session.role !== 'admin') {
      const { ForbiddenException } = await import('@/lib/utils/api');
      throw new ForbiddenException('교수 계정에서만 소속 의과대학을 변경할 수 있습니다.');
    }

    const { data: school, error: schoolError } = await supabase
      .from('schools')
      .select('id')
      .eq('id', body.school_id)
      .eq('type', 'medical')
      .maybeSingle();

    if (schoolError) throw schoolError;
    if (!school) {
      const { ApiException } = await import('@/lib/utils/api');
      throw new ApiException('invalid_school', '등록된 의과대학을 선택해 주세요.', 400);
    }
  }

  const { data, error } = await supabase
    .from('users')
    .update(body)
    .eq('id', session.userId)
    .select()
    .single();

  if (error) throw error;

  return ok(data);
});

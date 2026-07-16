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
  display_name: z.string().min(1).max(50).optional(),
});

export const PATCH = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const body = patchSchema.parse(await request.json());

  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from('users')
    .update(body)
    .eq('id', session.userId)
    .select()
    .single();

  if (error) throw error;

  return ok(data);
});

/**
 * PATCH  /api/exam-schedules/[id]  — 시험 일정 수정
 * DELETE /api/exam-schedules/[id]  — 시험 일정 삭제
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const patchSchema = z.object({
  title: z.string().min(1).max(100).optional(),
  exam_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  subject_id: z.string().uuid().nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
  color: z.string().max(20).optional(),
});

export const PATCH = withErrorHandling(async (request: Request, context: RouteContext) => {
  const session = await requireSession();
  const { id } = await context.params;
  const body = patchSchema.parse(await request.json());
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from('exam_schedules')
    .update(body)
    .eq('id', id)
    .eq('user_id', session.userId)
    .select('id, title, exam_date, subject_id, memo, color, created_at')
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new ApiException('not_found', '일정을 찾을 수 없습니다.', 404);
  return ok(data);
});

export const DELETE = withErrorHandling(async (_request: Request, context: RouteContext) => {
  const session = await requireSession();
  const { id } = await context.params;
  const supabase = await createServerClient();

  const { error } = await supabase
    .from('exam_schedules')
    .delete()
    .eq('id', id)
    .eq('user_id', session.userId);

  if (error) throw error;
  return ok({ deleted: true });
});

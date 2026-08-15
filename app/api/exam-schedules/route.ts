/**
 * GET  /api/exam-schedules   — 본인 시험 일정 목록 (마이페이지 캘린더)
 * POST /api/exam-schedules   — 시험 일정 추가
 */

import { z } from 'zod';
import { requireAuthUser } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling } from '@/lib/utils/api';

export const GET = withErrorHandling(async () => {
  await requireAuthUser();
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from('exam_schedules')
    .select('id, title, exam_date, subject_id, memo, color, created_at')
    .order('exam_date', { ascending: true });

  if (error) throw error;
  return ok(data ?? []);
});

const createSchema = z.object({
  title: z.string().min(1).max(100),
  exam_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다.'),
  subject_id: z.string().uuid().nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
  color: z.string().max(20).optional(),
});

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireAuthUser();
  const body = createSchema.parse(await request.json());
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from('exam_schedules')
    .insert({
      user_id: session.userId,
      title: body.title,
      exam_date: body.exam_date,
      subject_id: body.subject_id ?? null,
      memo: body.memo ?? null,
      // color 는 저장만 되고 아직 UI(색 선택·렌더링)에서 쓰지 않는다 —
      // 캘린더 점 색은 warn 고정. 색 선택 기능을 붙일 때 이 필드를 활용할 것.
      color: body.color ?? 'sage',
    })
    .select('id, title, exam_date, subject_id, memo, color, created_at')
    .single();

  if (error) throw error;
  return ok(data, 201);
});

import { z } from 'zod';
import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const createSchema = z.object({ title: z.string().trim().min(1).max(120), term: z.string().trim().max(60).optional() });

export const GET = withErrorHandling(async () => {
  const session = await requireProfessor();
  const db = await createServerClient() as any;
  const { data, error } = await db.from('courses').select('id,title,code,term,status,created_at').eq('professor_id', session.userId).order('created_at', { ascending: false });
  if (error) throw new ApiException('courses_unavailable', '강의 목록을 불러오지 못했습니다.', 500);
  return ok(data ?? []);
});

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireProfessor();
  const input = createSchema.parse(await request.json());
  const db = await createServerClient() as any;
  const { data, error } = await db.from('courses').insert({ professor_id: session.userId, title: input.title, term: input.term || null }).select('id,title,code,term,status,created_at').single();
  if (error) throw new ApiException('course_create_failed', '강의를 만들지 못했습니다.', 500);
  return ok(data, 201);
});

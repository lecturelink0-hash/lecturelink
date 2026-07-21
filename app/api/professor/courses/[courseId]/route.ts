import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

export const GET = withErrorHandling(async (_request: Request, context: { params: Promise<{ courseId: string }> }) => {
  const session = await requireProfessor();
  const { courseId } = await context.params;
  const db = await createServerClient() as any;
  const { data: course, error } = await db.from('courses').select('id,title,code,term,status,created_at').eq('id', courseId).eq('professor_id', session.userId).single();
  if (error || !course) throw new ApiException('course_not_found', '강의를 찾을 수 없습니다.', 404);
  const [{ data: artifacts }, { count: studentCount }] = await Promise.all([
    db.from('learning_artifacts').select('id,type,title,status,source_name,summary,created_at,published_at').eq('course_id', courseId).order('created_at', { ascending: false }),
    db.from('course_members').select('*', { count: 'exact', head: true }).eq('course_id', courseId),
  ]);
  return ok({ course, artifacts: artifacts ?? [], studentCount: studentCount ?? 0 });
});

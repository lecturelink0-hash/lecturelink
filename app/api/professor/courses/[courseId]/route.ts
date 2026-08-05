import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
import { TEACHING_MATERIAL_BUCKET } from '@/lib/teaching/materials';

export const GET = withErrorHandling(async (_request: Request, context: { params: Promise<{ courseId: string }> }) => {
  const session = await requireProfessor();
  const { courseId } = await context.params;
  const db = await createServerClient() as any;
  const { data: course, error } = await db.from('courses').select('id,title,code,term,status,created_at').eq('id', courseId).eq('professor_id', session.userId).single();
  if (error || !course) throw new ApiException('course_not_found', '강의를 찾을 수 없습니다.', 404);
  const [{ data: artifacts }, { data: materials }, { count: studentCount }] = await Promise.all([
    db.from('learning_artifacts').select('id,type,title,status,source_name,summary,created_at,published_at').eq('course_id', courseId).order('created_at', { ascending: false }),
    db.from('teaching_materials').select('id,file_name,file_type,file_size_bytes,page_count,status,created_at').eq('course_id', courseId).order('created_at', { ascending: false }),
    db.from('course_members').select('*', { count: 'exact', head: true }).eq('course_id', courseId),
  ]);
  return ok({ course, artifacts: artifacts ?? [], materials: materials ?? [], studentCount: studentCount ?? 0 });
});

export const DELETE = withErrorHandling(async (_request: Request, context: { params: Promise<{ courseId: string }> }) => {
  const session = await requireProfessor();
  const { courseId } = await context.params;
  const db = await createServerClient() as any;

  const { data: course } = await db
    .from('courses')
    .select('id')
    .eq('id', courseId)
    .eq('professor_id', session.userId)
    .maybeSingle();
  if (!course) throw new ApiException('course_not_found', '차시를 찾을 수 없습니다.', 404);

  const { data: materials, error: materialError } = await db
    .from('teaching_materials')
    .select('storage_path')
    .eq('course_id', courseId)
    .eq('professor_id', session.userId);
  if (materialError) {
    throw new ApiException('course_delete_failed', '차시에 저장된 자료를 확인하지 못했습니다.', 500);
  }

  const storagePaths = (materials ?? [])
    .map((material: { storage_path: string | null }) => material.storage_path)
    .filter((path: string | null): path is string => Boolean(path));
  if (storagePaths.length > 0) {
    const { error: storageError } = await db.storage
      .from(TEACHING_MATERIAL_BUCKET)
      .remove(storagePaths);
    if (storageError) {
      throw new ApiException('course_file_delete_failed', '저장된 강의자료를 삭제하지 못했습니다. 차시는 삭제되지 않았습니다.', 500);
    }
  }

  const { error: deleteError } = await db
    .from('courses')
    .delete()
    .eq('id', courseId)
    .eq('professor_id', session.userId);
  if (deleteError) {
    throw new ApiException('course_delete_failed', '차시를 삭제하지 못했습니다.', 500);
  }

  return ok({ id: courseId });
});

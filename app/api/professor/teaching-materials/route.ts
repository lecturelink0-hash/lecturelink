import { z } from 'zod';
import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';
import {
  extractTeachingMaterial,
  hashFile,
  materialFileType,
  MAX_TEACHING_MATERIAL_BYTES,
  TEACHING_MATERIAL_BUCKET,
} from '@/lib/teaching/materials';

const courseIdSchema = z.string().uuid();

export const GET = withErrorHandling(async (request: Request) => {
  const session = await requireProfessor();
  const courseId = new URL(request.url).searchParams.get('courseId');
  if (courseId && !courseIdSchema.safeParse(courseId).success) {
    throw new ApiException('invalid_course', '차시를 확인해주세요.', 400);
  }
  const db = await createServerClient() as any;
  let query = db
    .from('teaching_materials')
    .select('id,course_id,file_name,file_type,mime_type,file_size_bytes,status,page_count,error_message,created_at')
    .eq('professor_id', session.userId)
    .order('created_at', { ascending: false });
  if (courseId) query = query.eq('course_id', courseId);
  const { data, error } = await query;
  if (error) throw new ApiException('materials_unavailable', '강의자료 목록을 불러오지 못했습니다.', 500);
  return ok(data ?? []);
});

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireProfessor();
  const form = await request.formData();
  const file = form.get('file');
  const courseId = String(form.get('courseId') ?? '');
  if (!(file instanceof File)) throw new ApiException('file_required', '강의자료를 선택해주세요.', 400);
  if (!courseIdSchema.safeParse(courseId).success) throw new ApiException('course_required', '차시를 선택해주세요.', 400);
  if (file.size > MAX_TEACHING_MATERIAL_BYTES) throw new ApiException('file_too_large', '파일은 25MB 이하만 지원합니다.', 400);
  const fileType = materialFileType(file);
  const fileHash = await hashFile(file);
  const db = await createServerClient() as any;
  const { data: course } = await db.from('courses').select('id').eq('id', courseId).eq('professor_id', session.userId).maybeSingle();
  if (!course) throw new ApiException('course_not_found', '선택한 차시를 찾을 수 없습니다.', 404);
  const { data: duplicate } = await db
    .from('teaching_materials')
    .select('id,course_id,file_name,file_type,mime_type,file_size_bytes,status,page_count,error_message,created_at')
    .eq('course_id', courseId)
    .eq('file_hash', fileHash)
    .maybeSingle();
  if (duplicate) return ok({ ...duplicate, reused: true });

  const materialId = crypto.randomUUID();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-120) || `material.${fileType}`;
  const storagePath = `${session.userId}/${materialId}/${safeName}`;
  const { error: uploadError } = await db.storage
    .from(TEACHING_MATERIAL_BUCKET)
    .upload(storagePath, file, { contentType: file.type, upsert: false });
  if (uploadError) throw new ApiException('material_upload_failed', '강의자료를 저장하지 못했습니다.', 500);

  const { error: insertError } = await db.from('teaching_materials').insert({
    id: materialId,
    course_id: courseId,
    professor_id: session.userId,
    file_name: file.name,
    file_type: fileType,
    mime_type: file.type || (fileType === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
    file_size_bytes: file.size,
    file_hash: fileHash,
    storage_path: storagePath,
    status: 'processing',
  });
  if (insertError) {
    await db.storage.from(TEACHING_MATERIAL_BUCKET).remove([storagePath]);
    throw new ApiException('material_save_failed', '강의자료 정보를 저장하지 못했습니다.', 500);
  }

  try {
    const extracted = await extractTeachingMaterial(file);
    const { data, error } = await db.from('teaching_materials').update({
      status: 'ready',
      page_count: extracted.pages.length,
      extracted_text: extracted.text,
      extracted_pages: extracted.pages,
      updated_at: new Date().toISOString(),
    }).eq('id', materialId).select('id,course_id,file_name,file_type,mime_type,file_size_bytes,status,page_count,error_message,created_at').single();
    if (error || !data) throw error ?? new Error('material update failed');
    return ok({ ...data, reused: false }, 201);
  } catch (error) {
    await db.from('teaching_materials').update({
      status: 'failed',
      error_message: error instanceof Error ? error.message.slice(0, 500) : '자료 처리 실패',
      updated_at: new Date().toISOString(),
    }).eq('id', materialId);
    throw error;
  }
});

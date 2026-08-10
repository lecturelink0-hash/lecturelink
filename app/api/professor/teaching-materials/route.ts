import { z } from 'zod';
import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';
import {
  hashFile,
  materialFileType,
  MAX_TEACHING_MATERIAL_BYTES,
  TEACHING_MATERIAL_BUCKET,
} from '@/lib/teaching/materials';
import { enqueueTeachingMaterial } from '@/lib/teaching/queue-material';
import { processTeachingMaterial } from '@/lib/teaching/process-material';

export const maxDuration = 120;

const courseIdSchema = z.string().uuid();
const materialIdSchema = z.string().uuid();
const directUploadSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('initialize'),
    courseId: courseIdSchema,
    fileName: z.string().trim().min(1).max(255),
    fileType: z.enum(['pdf', 'pptx']),
    mimeType: z.string().trim().min(1).max(200),
    fileSizeBytes: z.number().int().positive().max(MAX_TEACHING_MATERIAL_BYTES),
    fileHash: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    action: z.literal('finalize'),
    materialId: materialIdSchema,
  }),
]);

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
  if (request.headers.get('content-type')?.includes('application/json')) {
    const command = directUploadSchema.parse(await request.json());
    const db = await createServerClient() as any;

    if (command.action === 'finalize') {
      const { data: material } = await db
        .from('teaching_materials')
        .select('id')
        .eq('id', command.materialId)
        .eq('professor_id', session.userId)
        .maybeSingle();
      if (!material) throw new ApiException('material_not_found', '업로드한 강의자료를 찾지 못했습니다.', 404);

      try {
        const queued = await enqueueTeachingMaterial(command.materialId, session.userId);
        if (queued.mode === 'inline') await processTeachingMaterial(command.materialId, session.userId);
        const { data } = await db.from('teaching_materials')
          .select('id,course_id,file_name,file_type,mime_type,file_size_bytes,status,page_count,error_message,created_at')
          .eq('id', command.materialId).single();
        return ok({ ...data, reused: false }, queued.mode === 'qstash' ? 202 : 201);
      } catch (error) {
        await db.from('teaching_materials').update({
          status: 'failed',
          error_message: `processing_failed:${error instanceof Error ? error.message.slice(0, 400) : '자료 처리 실패'}`,
          updated_at: new Date().toISOString(),
        }).eq('id', command.materialId);
        throw new ApiException('processing_failed', '원본은 저장했지만 자료 처리를 시작하지 못했습니다. 다시 시도해주세요.', 503);
      }
    }

    const { data: course } = await db.from('courses').select('id').eq('id', command.courseId).eq('professor_id', session.userId).maybeSingle();
    if (!course) throw new ApiException('course_not_found', '선택한 차시를 찾을 수 없습니다.', 404);
    const { data: duplicate } = await db
      .from('teaching_materials')
      .select('id,course_id,file_name,file_type,mime_type,file_size_bytes,status,page_count,error_message,created_at,storage_path')
      .eq('course_id', command.courseId)
      .eq('file_hash', command.fileHash)
      .maybeSingle();
    if (duplicate?.status === 'ready') return ok({ ...duplicate, reused: true });

    const materialId = duplicate?.id ?? crypto.randomUUID();
    const safeName = command.fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-120) || `material.${command.fileType}`;
    const storagePath = duplicate?.storage_path ?? `${session.userId}/${materialId}/${safeName}`;
    const { data: signed, error: signedError } = await db.storage
      .from(TEACHING_MATERIAL_BUCKET)
      .createSignedUploadUrl(storagePath, { upsert: Boolean(duplicate) });
    if (signedError || !signed) throw new ApiException('signed_upload_failed', '강의자료 업로드를 준비하지 못했습니다.', 500);

    if (!duplicate) {
      const { error: insertError } = await db.from('teaching_materials').insert({
        id: materialId,
        course_id: command.courseId,
        professor_id: session.userId,
        file_name: command.fileName,
        file_type: command.fileType,
        mime_type: command.mimeType,
        file_size_bytes: command.fileSizeBytes,
        file_hash: command.fileHash,
        storage_path: storagePath,
        status: 'processing',
      });
      if (insertError) throw new ApiException('material_save_failed', '강의자료 정보를 저장하지 못했습니다.', 500);
    }

    return ok({
      materialId,
      signedUploadUrl: signed.signedUrl,
      reused: false,
    });
  }

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
  if (duplicate) {
    if (duplicate.status !== 'ready') {
      const queued = await enqueueTeachingMaterial(duplicate.id, session.userId, true);
      if (queued.mode === 'inline') await processTeachingMaterial(duplicate.id, session.userId);
    }
    return ok({ ...duplicate, reused: true });
  }

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
    const queued = await enqueueTeachingMaterial(materialId, session.userId);
    if (queued.mode === 'inline') await processTeachingMaterial(materialId, session.userId);
    const { data } = await db.from('teaching_materials')
      .select('id,course_id,file_name,file_type,mime_type,file_size_bytes,status,page_count,error_message,created_at')
      .eq('id', materialId).single();
    return ok({ ...data, reused: false }, queued.mode === 'qstash' ? 202 : 201);
  } catch (error) {
    await db.from('teaching_materials').update({
      status: 'failed',
      error_message: `processing_failed:${error instanceof Error ? error.message.slice(0, 400) : '자료 처리 실패'}`,
      updated_at: new Date().toISOString(),
    }).eq('id', materialId);
    throw new ApiException('processing_failed', '원본은 저장했지만 자료 처리를 시작하지 못했습니다. 다시 처리를 눌러주세요.', 503);
  }
});

export const DELETE = withErrorHandling(async (request: Request) => {
  const session = await requireProfessor();
  const materialId = new URL(request.url).searchParams.get('materialId');
  if (!materialId || !materialIdSchema.safeParse(materialId).success) {
    throw new ApiException('invalid_material', '삭제할 강의자료를 확인해주세요.', 400);
  }
  const db = await createServerClient() as any;
  const { data: material } = await db
    .from('teaching_materials')
    .select('id,storage_path')
    .eq('id', materialId)
    .eq('professor_id', session.userId)
    .maybeSingle();
  if (!material) throw new ApiException('material_not_found', '강의자료를 찾을 수 없습니다.', 404);

  const { error: storageError } = await db.storage
    .from(TEACHING_MATERIAL_BUCKET)
    .remove([material.storage_path]);
  if (storageError) throw new ApiException('material_delete_failed', '강의자료 파일을 삭제하지 못했습니다.', 500);

  const { error: deleteError } = await db
    .from('teaching_materials')
    .delete()
    .eq('id', materialId)
    .eq('professor_id', session.userId);
  if (deleteError) throw new ApiException('material_delete_failed', '강의자료 정보를 삭제하지 못했습니다.', 500);
  return ok({ id: materialId });
});

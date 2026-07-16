/**
 * GET  /api/uploads        — 본인 업로드 목록
 * POST /api/uploads        — 업로드 초기화 (signed URL 발급)
 *
 * 업로드 흐름 (클라이언트 관점):
 *   1. POST /api/uploads      → { upload_id, signed_upload_url, storage_path }
 *   2. PUT signed_upload_url  (파일 본체 업로드)
 *   3. POST /api/uploads/[id]/process  (AI 생성 트리거)
 *   4. (선택) GET /api/uploads/[id]    (상태 폴링)
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
import { STORAGE_BUCKET, buildStoragePath } from '@/lib/storage/paths';

// ───────────── GET (목록) ─────────────

export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from('user_uploads')
    .select(
      `
      id, file_name, file_type, file_size_bytes, status,
      page_count, processed_at, created_at, error_message
    `,
    )
    .eq('user_id', session.userId)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) throw error;
  return ok(data ?? []);
});

// ───────────── POST (초기화) ─────────────

const ALLOWED_MIME = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

const MAX_SIZE_BYTES = 524_288_000; // 500MB

const initSchema = z.object({
  file_name: z.string().min(1).max(255),
  file_type: z.enum(ALLOWED_MIME),
  file_size_bytes: z.number().int().min(1).max(MAX_SIZE_BYTES),
});

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const body = initSchema.parse(await request.json());

  const admin = createAdminClient();

  // 1) user_uploads 행 생성 (uploaded 상태, 파일은 아직 X)
  const { data: upload, error: insertErr } = await admin
    .from('user_uploads')
    .insert({
      user_id: session.userId,
      file_name: body.file_name,
      file_type: body.file_type,
      file_size_bytes: body.file_size_bytes,
      storage_path: '',          // 임시. 아래에서 업데이트
      status: 'uploaded',
    })
    .select('id')
    .single();

  if (insertErr || !upload) {
    throw new ApiException(
      'upload_init_failed',
      '업로드 초기화 실패',
      500,
      insertErr,
    );
  }

  // 2) Storage 경로 + signed upload URL 발급
  const storagePath = buildStoragePath(
    session.userId,
    upload.id,
    body.file_name,
  );

  const { data: signed, error: signedErr } = await admin.storage
    .from(STORAGE_BUCKET)
    .createSignedUploadUrl(storagePath);

  if (signedErr || !signed) {
    // 정합성 정리
    await admin.from('user_uploads').delete().eq('id', upload.id);
    throw new ApiException(
      'signed_url_failed',
      `Signed URL 발급 실패: ${signedErr?.message}`,
      500,
    );
  }

  // 3) storage_path 업데이트
  await admin
    .from('user_uploads')
    .update({ storage_path: storagePath })
    .eq('id', upload.id);

  return ok({
    upload_id: upload.id,
    storage_path: storagePath,
    signed_upload_url: signed.signedUrl,
    signed_token: signed.token,
    expires_in_seconds: 3600,
  });
});

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

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireAuthUser } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
import { STORAGE_BUCKET, buildStoragePath } from '@/lib/storage/paths';

// ───────────── GET (목록) ─────────────

export const GET = withErrorHandling(async () => {
  const session = await requireAuthUser();
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from('user_uploads')
    .select(
      `
      id, file_name, file_type, file_size_bytes, status,
      page_count, processed_at, created_at, error_message,
      processing_stage, progress_current, progress_total,
      completed_question_count, target_question_count, heartbeat_at
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
  const session = await requireAuthUser();
  const body = initSchema.parse(await request.json());

  const admin = createAdminClient();

  // upload id 를 서버에서 미리 생성해 storage 경로를 확정한다.
  // 행 insert 와 signed URL 발급이 서로를 기다릴 필요가 없어져 병렬 1회 왕복으로 끝난다.
  // (기존: insert → signed URL → storage_path update 3회 순차 왕복 — 업로드 시작 지연의 주원인)
  const uploadId = randomUUID();
  const storagePath = buildStoragePath(session.userId, uploadId, body.file_name);

  const [insertRes, signedRes] = await Promise.all([
    admin
      .from('user_uploads')
      .insert({
        id: uploadId,
        user_id: session.userId,
        file_name: body.file_name,
        file_type: body.file_type,
        file_size_bytes: body.file_size_bytes,
        storage_path: storagePath,
        status: 'uploaded',
      })
      .select('id')
      .single(),
    admin.storage.from(STORAGE_BUCKET).createSignedUploadUrl(storagePath),
  ]);

  if (insertRes.error || !insertRes.data) {
    throw new ApiException(
      'upload_init_failed',
      '업로드 초기화 실패',
      500,
      insertRes.error,
    );
  }

  if (signedRes.error || !signedRes.data) {
    // 정합성 정리
    await admin.from('user_uploads').delete().eq('id', uploadId);
    throw new ApiException(
      'signed_url_failed',
      `Signed URL 발급 실패: ${signedRes.error?.message}`,
      500,
    );
  }

  return ok({
    upload_id: uploadId,
    storage_path: storagePath,
    signed_upload_url: signedRes.data.signedUrl,
    signed_token: signedRes.data.token,
    expires_in_seconds: 3600,
  });
});

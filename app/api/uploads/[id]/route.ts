/**
 * GET    /api/uploads/[id]   — 업로드 상세 + 처리 상태
 * DELETE /api/uploads/[id]   — 업로드 + 연결된 private 문항 삭제
 */

import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { createAdminClient } from '@/lib/db/admin';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
import { STORAGE_BUCKET } from '@/lib/storage/paths';

interface RouteContext {
  params: Promise<{ id: string }>;
}

// ───────────── GET ─────────────

export const GET = withErrorHandling(async (
  _request: Request,
  context: RouteContext,
) => {
  const session = await requireSession();
  const { id } = await context.params;
  const supabase = await createServerClient();

  const { data: upload, error } = await supabase
    .from('user_uploads')
    .select(
      `
      id, file_name, file_type, file_size_bytes, storage_path, status,
      extracted_text, page_count, error_message, processed_at, created_at
    `,
    )
    .eq('id', id)
    .eq('user_id', session.userId)
    .maybeSingle();

  if (error) throw error;
  if (!upload) {
    throw new ApiException('upload_not_found', '업로드를 찾을 수 없습니다.', 404);
  }

  // 연결된 private_questions 수
  const { count } = await supabase
    .from('private_questions')
    .select('id', { count: 'exact', head: true })
    .eq('upload_id', id)
    .eq('user_id', session.userId);

  return ok({
    ...upload,
    generated_question_count: count ?? 0,
  });
});

// ───────────── DELETE ─────────────

export const DELETE = withErrorHandling(async (
  _request: Request,
  context: RouteContext,
) => {
  const session = await requireSession();
  const { id } = await context.params;
  const supabase = await createServerClient();
  const admin = createAdminClient();

  // 1) 업로드 행 조회 (소유권 확인)
  const { data: upload } = await supabase
    .from('user_uploads')
    .select('id, storage_path')
    .eq('id', id)
    .eq('user_id', session.userId)
    .maybeSingle();

  if (!upload) {
    throw new ApiException('upload_not_found', '업로드를 찾을 수 없습니다.', 404);
  }

  // 2) Storage 파일 삭제 (admin)
  if (upload.storage_path) {
    const { error: removeErr } = await admin.storage
      .from(STORAGE_BUCKET)
      .remove([upload.storage_path]);
    if (removeErr) {
      console.warn('[uploads] storage remove failed:', removeErr.message);
    }
  }

  // 2-1) crop 의료 이미지 정리 — DB row 는 upload cascade 로 지워지지만 Storage
  //      파일은 별도 remove 가 필요(고아 방지). upload row 삭제 전에 경로를 조회한다.
  const { data: cropImgs } = await admin
    .from('private_question_images')
    .select('storage_path')
    .eq('upload_id', id);
  if (cropImgs && cropImgs.length > 0) {
    const { error: cropErr } = await admin.storage
      .from(STORAGE_BUCKET)
      .remove(cropImgs.map((r) => r.storage_path));
    if (cropErr) {
      console.warn('[uploads] crop remove failed:', cropErr.message);
    }
  }

  // 3) private_questions 삭제 (CASCADE on upload row 로 자동)
  // 4) user_uploads 행 삭제
  const { error: deleteErr } = await supabase
    .from('user_uploads')
    .delete()
    .eq('id', id);

  if (deleteErr) throw deleteErr;

  return ok({ deleted: true });
});

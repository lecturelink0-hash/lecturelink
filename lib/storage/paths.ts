/**
 * Storage 경로 규칙 — Track A 업로드 파일
 *
 * 규칙: {user_id}/{upload_id}/{sanitized_filename}
 *
 * RLS 정책이 storage.foldername(name)[1] == auth.uid()::text 로
 * 본인 폴더 접근만 허용하므로 user_id 는 *반드시* 경로 첫 segment 에 위치.
 */

export const STORAGE_BUCKET = 'user_uploads';

export function buildStoragePath(
  userId: string,
  uploadId: string,
  fileName: string,
): string {
  // 스토리지 오브젝트 키는 반드시 ASCII-safe 여야 한다.
  // 한글/공백 등 비-ASCII 가 키에 들어가면 Supabase 서명 업로드 URL 에 raw 로 실려
  // PUT 요청이 깨지거나 서명 불일치로 400 이 난다. (원본 파일명은 user_uploads.file_name
  // 에 그대로 보관되므로 표시에는 영향 없음.) uploadId 가 유일성을 보장한다.
  const dotIdx = fileName.lastIndexOf('.');
  const ext = (dotIdx > 0 ? fileName.slice(dotIdx + 1) : '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toLowerCase()
    .slice(0, 8);
  let base = (dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName)
    .replace(/[^A-Za-z0-9._-]/g, '_') // 비-ASCII(한글 포함)·특수문자 → _
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 60);
  if (!base) base = 'upload';

  return `${userId}/${uploadId}/${base}${ext ? '.' + ext : ''}`;
}

export function parseStoragePath(path: string): {
  userId: string;
  uploadId: string;
  fileName: string;
} | null {
  const parts = path.split('/');
  if (parts.length < 3) return null;
  return {
    userId: parts[0],
    uploadId: parts[1],
    fileName: parts.slice(2).join('/'),
  };
}

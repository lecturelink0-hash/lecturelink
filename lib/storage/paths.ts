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

/**
 * 문항 이미지(크롭) 경로.
 *
 * 한 이미지는 두 판으로 저장될 수 있다.
 *   q_image_3.png    — 기본 정제본
 *   q_image_3_m.png  — A·B·C 표식을 얹은 판(표식을 실제로 묻는 문항만 쓴다)
 *
 * 두 판은 **같은 이미지**다. 재사용 상한("한 그림당 최대 2문항")을 셀 때 경로로 묶으면
 * 상한이 두 배로 풀리므로, 세는 쪽은 반드시 questionImageIndex() 로 gi 를 뽑아 묶는다.
 * 규칙이 세 곳(생성·상한 정리·보충 배정)에 흩어져 있어 한곳에 모은다.
 */
export function questionImagePath(
  userId: string,
  uploadId: string,
  imageIndex: number,
  marked = false,
): string {
  return `${userId}/${uploadId}/crops/q_image_${imageIndex}${marked ? '_m' : ''}.png`;
}

/** 문항 이미지 경로에서 이미지 번호(gi)를 뽑는다. 표식판(`_m`)도 같은 번호로 본다. */
export function questionImageIndex(path: string): number | null {
  const m = /\/crops\/q_image_(\d+)(?:_m)?\.png$/.exec(path ?? '');
  return m ? Number(m[1]) : null;
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

/**
 * GET /api/uploads/[id]/diagnostics
 *
 * 문항 생성 파이프라인의 실행 진단(단계별 소요·추출 세부 수치·경고)을 반환한다.
 *
 * 왜 필요한가: 전처리에서 시간이 어디로 가는지, 임베드 이미지 경로(mutool)가 배포 환경에서
 * 실제로 동작하는지를 밖에서 확인할 방법이 없어 최적화 판단을 추측에 의존해야 했다.
 * 파이프라인이 실행마다 ai_cost_log.metadata(jsonb)에 진단을 남기고,
 * 이 라우트가 본인 업로드의 최근 기록을 그대로 돌려준다. (DB 스키마 변경 없음)
 *
 * 응답: GenerationDiagnostics JSON. 아직 기록이 없으면 404.
 */

import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { createAdminClient } from '@/lib/db/admin';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const GET = withErrorHandling(async (
  _request: Request,
  context: RouteContext,
) => {
  const session = await requireSession();
  const { id } = await context.params;

  // 소유권 확인 — 남의 업로드 진단을 볼 수 없게 사용자 스코프로 조회한다.
  const supabase = await createServerClient();
  const { data: upload, error } = await supabase
    .from('user_uploads')
    .select('id, user_id, status, processing_stage, processed_at')
    .eq('id', id)
    .eq('user_id', session.userId)
    .maybeSingle();
  if (error) throw error;
  if (!upload) {
    throw new ApiException('upload_not_found', '업로드를 찾을 수 없습니다.', 404);
  }

  // 진단은 ai_cost_log.metadata(jsonb)에 기록된다.
  // (Storage 는 user_uploads 버킷의 allowed_mime_types 가 application/json 을 막아 사용 불가.)
  const admin = createAdminClient();
  const { data: rows, error: logErr } = await admin
    .from('ai_cost_log')
    .select('metadata, created_at')
    .eq('user_id', session.userId)
    .eq('endpoint', 'private.diagnostics')
    .eq('metadata->>uploadId', id)
    .order('created_at', { ascending: false })
    .limit(1);
  if (logErr) throw logErr;

  const parsed = rows?.[0]?.metadata ?? null;
  if (!parsed) {
    throw new ApiException(
      'diagnostics_not_found',
      '이 업로드의 진단 기록이 없습니다. (배포 이후 실행된 생성만 기록됩니다)',
      404,
    );
  }

  return ok({
    upload: {
      id: upload.id,
      status: upload.status,
      processing_stage: upload.processing_stage,
      processed_at: upload.processed_at,
    },
    diagnostics: parsed,
  });
});

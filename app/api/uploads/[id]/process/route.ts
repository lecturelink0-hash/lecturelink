/**
 * POST /api/uploads/[id]/process
 *
 * 파일 업로드 완료 후 호출. PPT/PDF/이미지 → crop+OCR → 문항 생성 파이프라인을 enqueue.
 *
 * 동작:
 *   - QStash 설정 시 큐로 발송, 즉시 202 (Accepted) 반환. 클라이언트는 GET /api/uploads/[id] 폴링.
 *   - QStash 미설정 시 inline 동기 처리 (개발용, Vercel 5분 timeout 가정).
 *
 * Body:
 *   { desired_count?: number, style?: 'kmle' | 'professor' | 'internal' }
 */

import { after } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { generatePrivateQuestionsFromUpload } from '@/lib/ai/private-generation';
import { enqueueProcessUpload } from '@/lib/queue/process-upload';
import { requireQuota } from '@/lib/quota/check';
import { requireDailyCostCap } from '@/lib/ai/cost-cap';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
import { STORAGE_BUCKET } from '@/lib/storage/paths';

interface RouteContext {
  params: Promise<{ id: string }>;
}

const bodySchema = z.object({
  desired_count: z.number().int().min(5).max(20).default(12),
  style: z.enum(['kmle', 'professor', 'internal']).default('kmle'),
  difficulty: z.enum(['하', '중', '상']).optional(),
  question_type: z.enum(['지식형', '임상형', '이미지형']).optional(),
  title: z.string().max(100).optional(),
  reference_upload_ids: z.array(z.string().uuid()).max(10).default([]),
});

export const maxDuration = 300;

export const POST = withErrorHandling(async (
  request: Request,
  context: RouteContext,
) => {
  const session = await requireSession();
  const { id } = await context.params;
  const body = bodySchema.parse(
    await request
      .clone()
      .json()
      .catch(() => ({})),
  );

  const admin = createAdminClient();

  // 1) 업로드 소유권 + 상태 확인
  const { data: upload, error: uErr } = await admin
    .from('user_uploads')
    .select('id, user_id, storage_path, status')
    .eq('id', id)
    .maybeSingle();

  if (uErr || !upload) {
    throw new ApiException('upload_not_found', '업로드를 찾을 수 없습니다.', 404);
  }
  if (upload.user_id !== session.userId) {
    throw new ApiException('forbidden', '본인 업로드만 처리 가능합니다.', 403);
  }
  if (upload.status === 'completed') {
    throw new ApiException(
      'already_processed',
      '이미 처리 완료된 업로드입니다.',
      409,
    );
  }
  if (upload.status === 'processing' || upload.status === 'queued') {
    throw new ApiException(
      'already_processing',
      '현재 처리 중입니다. 잠시 후 다시 확인하세요.',
      409,
    );
  }

  // 2) 파일이 실제로 storage 에 있는지
  const { data: fileHead, error: headErr } = await admin.storage
    .from(STORAGE_BUCKET)
    .list(upload.storage_path.split('/').slice(0, -1).join('/'), {
      search: upload.storage_path.split('/').pop(),
    });

  if (headErr || !fileHead || fileHead.length === 0) {
    throw new ApiException(
      'file_not_uploaded',
      '파일이 아직 업로드되지 않았습니다. 업로드 완료 후 호출하세요.',
      400,
    );
  }

  // 3) P0-3 비용 캡 + P0-6 quota 사전 체크
  //    quota 실제 차감은 enqueueProcessUpload 내부에서 enqueue 성공 직후 1회 발생.
  await requireDailyCostCap();
  await requireQuota(session.userId, 'uploads', 1);

  // 4) Enqueue or inline 처리 (quota 1회 차감은 enqueueProcessUpload 가 책임)
  const result = await enqueueProcessUpload({
    uploadId: id,
    userId: session.userId,
    desiredCount: body.desired_count,
    style: body.style,
    difficulty: body.difficulty,
    questionType: body.question_type,
    title: body.title,
    referenceUploadIds: body.reference_upload_ids,
  });

  if (result.mode === 'qstash') {
    return ok(
      {
        upload_id: id,
        status: 'queued',
        queue_message_id: result.messageId,
      },
      202,
    );
  }

  // inline 모드: after() 로 응답 후 처리하고 즉시 202 반환.
  //
  // ⚠️ Vercel 서버리스 주의: 예전엔 `void generate...()` fire-and-forget 이었는데,
  // 서버리스는 응답을 반환하면 await 되지 않은 백그라운드 Promise 를 함수와 함께
  // 동결/종료해 느린 생성이 중간에 죽는다(업로드가 'processing'에서 멈춤).
  // Next 15 `after()` 는 응답 전송 후에도 런타임이 함수를 살려 콜백을 완주시키므로
  // maxDuration(300s) 한도 내에서 안전하게 생성이 끝난다.
  // 동기로 await 하면 대용량 PDF(수십 페이지)에서 생성이 수 분 걸려 프록시/브라우저가
  // 먼저 연결을 끊는다(nginx 499). 이 서버는 상시 구동(next start)이라 응답 후에도
  // 백그라운드 Promise 가 계속 실행되며, generatePrivateQuestionsFromUpload 가
  // 업로드 status 를 processing→completed/failed 로 갱신한다. 클라이언트는
  // GET /api/uploads 폴링(최대 5분)으로 완료를 감지해 결과를 조회한다.
  // quota 는 enqueue 단계에서 이미 1회 차감됨.
  // 병합 해결: 서버리스 완주 보장(after) + 참고자료 반영(referenceUploadIds) 둘 다 유지.
  after(
    generatePrivateQuestionsFromUpload({
      uploadId: id,
      userId: session.userId,
      desiredCount: body.desired_count,
      style: body.style,
      difficulty: body.difficulty,
      questionType: body.question_type,
      title: body.title,
      referenceUploadIds: body.reference_upload_ids,
    }).catch((e) => {
      // 생성 함수 내부에서 status='failed' 로 갱신하지만, 예기치 못한 예외를 로깅.
      console.error(
        '[process/inline-bg] 백그라운드 생성 실패:',
        e instanceof Error ? e.message : String(e),
      );
    }),
  );

  return ok(
    {
      upload_id: id,
      status: 'queued',
    },
    202,
  );
});

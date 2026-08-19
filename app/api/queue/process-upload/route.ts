/**
 * POST /api/queue/process-upload
 *
 * QStash 콜백 엔드포인트. 큐가 발행한 메시지를 받아 실제 처리.
 *
 * 인증:
 *   - Upstash-Signature 헤더 검증 (HMAC-SHA256, QSTASH_CURRENT_SIGNING_KEY)
 *   - 검증 실패 시 401
 */

import { z } from 'zod';
import { Receiver } from '@upstash/qstash';
import { executeProcessUpload } from '@/lib/queue/process-upload';
import { requireDailyCostCap } from '@/lib/ai/cost-cap';
import { reportAlert } from '@/lib/notify/alerts';
import { ApiException, CostCapExceededException } from '@/lib/utils/api';

export const maxDuration = 300;

const bodySchema = z.object({
  uploadId: z.string().uuid(),
  userId: z.string().uuid(),
  // 하한은 반드시 /api/uploads/[id]/process 의 desired_count 와 같아야 한다.
  // 여기만 min(5) 로 남아 있어서 1~4문항 요청이 워커에서 400 으로 거절되고,
  // QStash 는 4xx 를 영구 실패로 보아 재시도하지 않아 업로드가 'queued' 에
  // 영구 고착됐다(사용자에게는 끝나지 않는 생성으로 보임).
  desiredCount: z.number().int().min(1).max(20).optional(),
  style: z.enum(['kmle', 'professor', 'internal']).optional(),
  difficulty: z.enum(['하', '중', '상']).optional(),
  questionTypes: z.array(z.enum(['지식형', '임상형', '이미지형'])).min(1).max(3).optional(),
  title: z.string().max(100).optional(),
  // P5 — 출제 초점. 큐 payload 는 워커가 재검증하므로 여기에도 넣어야 전달된다
  // (desiredCount 가 min(5) 로 남아 요청이 영구 고착됐던 것과 같은 계열의 함정).
  topic: z.string().max(60).optional(),
  keywords: z.array(z.string().max(30)).max(8).optional(),
  referenceUploadIds: z.array(z.string().uuid()).max(10).optional(),
});

/**
 * QStash 서명 검증.
 *
 * - production: SIGNING_KEY 없으면 throw — 운영 환경 누락은 즉시 실패.
 * - 비-production: default reject. NODE_ENV 가 비어 있거나 'staging' 같은 값일 때
 *   자동 우회되는 사고를 막는다.
 * - 로컬 개발에서만 명시적으로 ALLOW_UNSIGNED_QSTASH=1 을 켜야 우회 가능.
 */
async function verifyQStashSignature(
  rawBody: string,
  signature: string,
): Promise<boolean> {
  const currentKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!currentKey && !nextKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        '[queue/callback] QSTASH_CURRENT_SIGNING_KEY 가 프로덕션에 설정되지 않았습니다.',
      );
    }
    if (process.env.ALLOW_UNSIGNED_QSTASH === '1') {
      console.warn(
        '[queue/callback] SIGNING_KEY 미설정 — ALLOW_UNSIGNED_QSTASH 우회 허용',
      );
      return true;
    }
    console.error(
      '[queue/callback] SIGNING_KEY 미설정 — 서명 검증 실패로 처리. ' +
        '로컬 개발에서 우회가 필요하면 ALLOW_UNSIGNED_QSTASH=1 을 명시하세요.',
    );
    return false;
  }
  if (!signature) return false;

  // 공식 SDK Receiver — current + next key 로테이션 자동 처리.
  const receiver = new Receiver({
    currentSigningKey: currentKey ?? '',
    nextSigningKey: nextKey ?? '',
  });

  try {
    const verified = await receiver.verify({
      signature,
      body: rawBody,
    });
    return verified === true;
  } catch {
    return false;
  }
}

/**
 * payload 검증 실패처럼 "재시도해도 소용없는" 실패에서, 원문에서 uploadId 만 건져
 * 업로드를 'failed' 로 마킹한다. 실패해도 조용히 무시(이미 오류 경로).
 */
async function markUploadFailedBestEffort(
  rawBody: string,
  message: string,
): Promise<void> {
  try {
    const parsed = JSON.parse(rawBody) as { uploadId?: unknown };
    const uploadId = typeof parsed.uploadId === 'string' ? parsed.uploadId : null;
    if (!uploadId || !/^[0-9a-f-]{36}$/i.test(uploadId)) return;
    const { createAdminClient } = await import('@/lib/db/admin');
    await createAdminClient()
      .from('user_uploads')
      .update({
        status: 'failed',
        processing_stage: 'failed',
        error_message: message,
        heartbeat_at: new Date().toISOString(),
      })
      .eq('id', uploadId);
  } catch {
    // 무시 — 알림은 호출자가 남긴다.
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get('upstash-signature') ?? '';

  let signatureOk = false;
  try {
    signatureOk = await verifyQStashSignature(rawBody, signature);
  } catch (error) {
    // SIGNING_KEY 누락(production) → throw. ops alert 만 남기고 401 반환.
    await reportAlert({
      severity: 'critical',
      source: 'queue/callback',
      message: 'QStash 서명 검증 실패 (구성 누락 가능성)',
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    return new Response('Invalid signature', { status: 401 });
  }
  if (!signatureOk) {
    await reportAlert({
      severity: 'high',
      source: 'queue/callback',
      message: 'QStash 서명 검증 실패',
      payload: { signaturePrefix: signature.slice(0, 16) },
    });
    return new Response('Invalid signature', { status: 401 });
  }

  let payload: z.infer<typeof bodySchema>;
  try {
    payload = bodySchema.parse(JSON.parse(rawBody));
  } catch (e) {
    // 400 은 QStash 가 재시도하지 않는 영구 실패다. 여기서 아무 것도 하지 않으면 업로드가
    // 'queued' 상태로 영원히 남아 사용자에게는 "생성이 끝나지 않는" 증상이 된다.
    // 업로드 id 를 알아낼 수 있으면 'failed' 로 마킹해 사용자가 즉시 재시도할 수 있게 한다.
    const reason = e instanceof Error ? e.message : String(e);
    await markUploadFailedBestEffort(
      rawBody,
      `작업 요청 형식 오류로 처리하지 못했습니다. 다시 시도해주세요. (${reason.slice(0, 80)})`,
    );
    await reportAlert({
      severity: 'critical',
      source: 'queue/callback',
      message: '큐 payload 검증 실패 — 업로드를 failed 로 마킹(영구 고착 방지)',
      payload: { error: reason.slice(0, 300), bodyPrefix: rawBody.slice(0, 200) },
    });
    return new Response(`Invalid payload: ${reason}`, { status: 400 });
  }

  // P0-3: 비용 캡 사전 체크. inline 경로는 /api/uploads/[id]/process 에서 막지만
  // QStash 경로는 enqueue 시점과 실제 처리 시점이 분리되므로 여기서 재확인한다.
  // cap 초과 / RPC 실패 시 throw → 5xx 응답으로 1회 재시도 유도.
  try {
    await requireDailyCostCap();
  } catch (e) {
    const status =
      e instanceof CostCapExceededException
        ? 402
        : e instanceof ApiException
          ? e.status
          : 503;
    await reportAlert({
      severity: 'high',
      source: 'queue/callback',
      message: 'cost cap 사전 체크 실패 — 처리 중단',
      payload: {
        uploadId: payload.uploadId,
        userId: payload.userId,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    return new Response('Cost cap reached or check failed', { status });
  }

  try {
    await executeProcessUpload(payload);
    return new Response('OK', { status: 200 });
  } catch (e) {
    // 처리 실패: 200 반환하면 QStash 가 재시도하지 않음. 의도적으로 5xx 반환해 1회 재시도 유도.
    return new Response(
      `Processing failed: ${e instanceof Error ? e.message : String(e)}`,
      { status: 500 },
    );
  }
}

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
  desiredCount: z.number().int().min(5).max(20).optional(),
  style: z.enum(['kmle', 'professor', 'internal']).optional(),
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
    return new Response(
      `Invalid payload: ${e instanceof Error ? e.message : String(e)}`,
      { status: 400 },
    );
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

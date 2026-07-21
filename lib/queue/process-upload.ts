/**
 * 업로드 처리 백그라운드 큐 — 최소 구현.
 *
 * 백엔드 선택:
 *   - QStash (Upstash) HTTP 큐 — Vercel 친화, 재시도·idempotency 기본 제공
 *   - 환경변수 누락 시 'inline' 모드로 폴백 (즉시 처리, P0 단계 호환)
 *
 * 종료 기준 (P1-A9 in-scope):
 *   - 상태 전이: queued → processing → completed | failed
 *   - Idempotency: upload_id 단일 키. 원자적 status 전이로 race 차단.
 *   - 재시도 1회만 (HTTP 5xx / network 한정)
 *   - 진행률은 user_uploads.status polling
 *
 * Out of scope:
 *   - DLQ, exponential backoff, multi-retry, 큐 모니터링 대시보드
 */

import { Client as QStashClient } from '@upstash/qstash';
import { createAdminClient } from '@/lib/db/admin';
import { ApiException } from '@/lib/utils/api';
import { reportAlert } from '@/lib/notify/alerts';
import { consumeQuotaCheckedStrict } from '@/lib/quota/check';

export type QueueBackend = 'qstash' | 'inline';

export interface EnqueueInput {
  uploadId: string;
  userId: string;
  desiredCount?: number;
  style?: 'kmle' | 'professor' | 'internal';
  difficulty?: '하' | '중' | '상';
  questionTypes?: Array<'지식형' | '임상형' | '이미지형'>;
  title?: string;
  referenceUploadIds?: string[];
}

function getBackend(): QueueBackend {
  if (process.env.QSTASH_TOKEN && getQStashTargetUrl()) {
    return 'qstash';
  }
  return 'inline';
}

function getQStashTargetUrl(): string | null {
  const configured = process.env.QSTASH_TARGET_URL?.trim();
  if (configured) return configured;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) return null;

  try {
    const url = new URL(appUrl);
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      return null;
    }
    return new URL('/api/queue/process-upload', url).toString();
  } catch {
    return null;
  }
}

/**
 * 원자적 큐 슬롯 점유.
 *
 * status 가 'uploaded' 또는 'failed' 인 경우에만 'queued' 로 전이.
 * 한 트랜잭션 안의 conditional UPDATE 라서 동시 요청 N 개 중 정확히 1 개만
 * row 를 돌려받고, 나머지는 0 row 를 받는다.
 *
 * - 1 row 반환: 점유 성공. 호출자는 enqueue / quota 차감 단계로 진행.
 * - 0 row 반환: 누군가 이미 점유했거나(queued/processing/completed) row 가 없음.
 *   현재 status 를 follow-up SELECT 로 확인해 적절한 ApiException 을 던진다.
 */
async function claimForQueue(uploadId: string): Promise<void> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('user_uploads')
    .update({ status: 'queued', error_message: null })
    .eq('id', uploadId)
    .in('status', ['uploaded', 'failed'])
    .select('id')
    .maybeSingle();

  if (error) {
    throw new Error(`[queue/claim] ${error.message}`);
  }
  if (data) return;

  const { data: row, error: selErr } = await admin
    .from('user_uploads')
    .select('status')
    .eq('id', uploadId)
    .maybeSingle();

  if (selErr || !row) {
    throw new ApiException('upload_not_found', '업로드를 찾을 수 없습니다.', 404);
  }
  if (row.status === 'queued' || row.status === 'processing') {
    throw new ApiException('already_processing', '이미 처리 중입니다.', 409);
  }
  if (row.status === 'completed') {
    throw new ApiException('already_processed', '이미 완료된 업로드입니다.', 409);
  }
  throw new ApiException(
    'invalid_status',
    `재처리할 수 없는 상태입니다: ${row.status}`,
    409,
  );
}

/**
 * 상태 전이 헬퍼 (claim 외 경로용).
 */
async function setStatus(
  uploadId: string,
  status: 'queued' | 'processing' | 'completed' | 'failed',
  extra: Record<string, unknown> = {},
): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from('user_uploads')
    .update({ status, ...extra })
    .eq('id', uploadId);
}

/**
 * QStash 로 작업 enqueue. 재시도 1회 (5xx 한정).
 */
async function enqueueQStash(payload: EnqueueInput): Promise<{ messageId: string }> {
  const token = process.env.QSTASH_TOKEN!;
  let target = getQStashTargetUrl();
  if (!target) {
    throw new Error(
      'QStash target URL is missing. Set QSTASH_TARGET_URL or NEXT_PUBLIC_APP_URL.',
    );
  }

  // 진단: 함수 런타임이 실제로 본 env 값. Netlify Function logs 에서 확인.
  console.log(
    '[queue/enqueue] QSTASH_TARGET_URL raw value:',
    JSON.stringify(target),
  );

  // 안전망: URL 스킴 누락 시 자동 prepend.
  // Upstash 는 destination 에 http(s):// 가 명시돼 있어야 publish 를 받는데,
  // 환경변수에 스킴이 빠진 채로 들어오는 사고가 반복돼 즉시 우회한다.
  if (target && !target.startsWith('https://') && !target.startsWith('http://')) {
    const fixed = `https://${target}`;
    console.warn(
      '[queue/enqueue] QSTASH_TARGET_URL missing scheme — auto-prepended https://',
      { original: target, fixed },
    );
    target = fixed;
  }

  // 공식 SDK 사용 — fetch 를 직접 만들지 않아 destination URL 인코딩 함정을 피한다.
  // (이전에 `encodeURIComponent(target)` 가 Upstash 의 destination 파서와 안 맞아 400 으로
  //  되돌아오는 사고가 있었음.)
  const client = new QStashClient({ token });

  try {
    const result = await client.publishJSON({
      url: target,
      body: payload,
      // upload_id 기준 deduplication — 동일 enqueue 차단
      deduplicationId: payload.uploadId,
      // 큐 내 재시도 1회만
      retries: 1,
    });
    return { messageId: result.messageId };
  } catch (e) {
    throw new Error(
      `QStash publish failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * 작업 enqueue. 원자적 status 전이 → quota 차감 → 큐 발송 (qstash) 또는 inline 반환.
 *
 * Quota 차감 정책:
 *   - claimForQueue 가 status='uploaded'|'failed' → 'queued' 를 원자적으로 보장하므로
 *     "성공한 enqueue == 정확히 1회의 새로운 처리 시도" 이고 quota 도 1회만 차감.
 *   - failed 상태 재시도는 새 처리 시도이므로 quota 1회 차감.
 *   - 차감은 consumeQuotaCheckedStrict (atomic check+consume RPC). 한도 초과면
 *     ApiException(402) throw. 사전 requireQuota 가 통과했더라도 다른 동시 요청이
 *     먼저 차감해 한도를 깎았을 가능성을 여기서 최종 확정한다.
 *   - quota 차감 실패(throw): status 를 'failed' 로 되돌리고 alert 후 rethrow.
 *     (claim 으로 잃은 quota 슬롯 없이 사용자가 깨끗하게 재시도 가능.)
 *   - QStash 발송 실패: status='failed', alert 후 throw.
 *     이 시점 quota 는 이미 1회 차감된 상태이므로 alert 에 명시.
 *     (정합성 결함이지만 흔치 않은 경로이며 운영팀 reconciliation 으로 수습.)
 *
 * 반환: { mode: 'qstash', messageId } | { mode: 'inline' }
 * inline 모드는 호출자가 즉시 처리하라는 신호. quota 는 이 함수에서 이미 차감 완료.
 */
export async function enqueueProcessUpload(
  input: EnqueueInput,
): Promise<
  | { mode: 'qstash'; messageId: string }
  | { mode: 'inline' }
> {
  const backend = getBackend();
  if (
    backend === 'inline' &&
    process.env.NODE_ENV === 'production' &&
    process.env.ALLOW_INLINE_GENERATION !== '1'
  ) {
    throw new ApiException(
      'generation_queue_unavailable',
      '문항 생성 작업 큐가 준비되지 않았습니다. 잠시 후 다시 시도해주세요.',
      503,
    );
  }

  // 1) 원자적 점유 — race-free
  await claimForQueue(input.uploadId);

  // 2) quota 차감 (atomic check+consume). 실패 시 점유 롤백.
  try {
    await consumeQuotaCheckedStrict(input.userId, 'uploads', 1);
  } catch (e) {
    await setStatus(input.uploadId, 'failed', {
      error_message: `quota 차감 실패: ${e instanceof Error ? e.message : String(e)}`,
    });
    await reportAlert({
      severity: 'high',
      source: 'queue/enqueue',
      message: 'quota 차감 실패 — claim 롤백',
      payload: {
        uploadId: input.uploadId,
        userId: input.userId,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    throw e;
  }

  if (backend === 'qstash') {
    try {
      const r = await enqueueQStash(input);
      return { mode: 'qstash', messageId: r.messageId };
    } catch (e) {
      // 발송 실패 — failed 마킹. quota 는 이미 차감됐으므로 alert 에 표시해 운영 reconciliation 신호.
      await setStatus(input.uploadId, 'failed', {
        error_message: `enqueue 실패: ${e instanceof Error ? e.message : String(e)}`,
      });
      await reportAlert({
        severity: 'high',
        source: 'queue/enqueue',
        message: 'QStash enqueue 실패 — quota 1회 차감된 상태',
        payload: {
          uploadId: input.uploadId,
          userId: input.userId,
          quotaConsumed: true,
          error: e instanceof Error ? e.message : String(e),
        },
      });
      throw e;
    }
  }

  // inline 모드: 호출자가 곧바로 처리. quota 는 위에서 이미 차감.
  return { mode: 'inline' };
}

/**
 * QStash 가 콜백할 때 본 함수가 실행됨 (별도 API 라우트에서 호출).
 * processing 마킹 → 작업 수행 → completed/failed.
 */
export async function executeProcessUpload(
  input: EnqueueInput,
): Promise<void> {
  const { generatePrivateQuestionsFromUpload } = await import(
    '@/lib/ai/private-generation'
  );

  await setStatus(input.uploadId, 'processing');

  try {
    await generatePrivateQuestionsFromUpload({
      uploadId: input.uploadId,
      userId: input.userId,
      desiredCount: input.desiredCount,
      style: input.style,
      difficulty: input.difficulty,
      questionTypes: input.questionTypes,
      title: input.title,
      referenceUploadIds: input.referenceUploadIds,
    });
    // generatePrivateQuestionsFromUpload 내부에서 completed 마킹함.
  } catch (e) {
    // private-generation 내부에서 failed 마킹하므로 여기선 알림만.
    await reportAlert({
      severity: 'medium',
      source: 'queue/execute',
      message: 'private-generation 처리 실패',
      payload: {
        uploadId: input.uploadId,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    throw e;
  }
}

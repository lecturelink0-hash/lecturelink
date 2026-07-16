/**
 * 토스페이먼츠 API 클라이언트
 *
 * https://docs.tosspayments.com/reference
 *
 * 결제 흐름:
 *   1. 클라이언트 위젯 호출 (clientKey 사용, 브라우저)
 *   2. 사용자 결제 완료 시 successUrl 로 paymentKey/orderId/amount 리턴
 *   3. 서버에서 confirmPayment 호출하여 승인 (secretKey 사용)
 *   4. webhook 으로 비동기 상태 변경 수신
 */

import { ApiException } from '@/lib/utils/api';

const TOSS_API_BASE = 'https://api.tosspayments.com';

/**
 * 결제 UX 경로 (승인 클릭 직후 등) 라 너무 길게 잡으면 사용자가 떠난다.
 * 8 초 + 1 회 재시도 = 최악 16 초 정도까지만 사용자가 기다린다.
 */
const TOSS_TIMEOUT_MS = 8_000;
const TOSS_RETRY_MAX_ATTEMPTS = 2;

function getAuthHeader(): string {
  const secretKey = process.env.TOSSPAYMENTS_SECRET_KEY;
  if (!secretKey) {
    throw new Error('TOSSPAYMENTS_SECRET_KEY 환경변수가 설정되지 않았습니다.');
  }
  // 토스는 Basic Auth: base64(secretKey + ':')
  const encoded = Buffer.from(`${secretKey}:`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * 토스 API fetch 공통 래퍼.
 *   - 명시적 timeout (TOSS_TIMEOUT_MS) — 외부 hang 으로 라우트가 묶이는 것 방지.
 *   - 일시 장애 (HTTP 429 / 5xx / timeout / network abort) 만 1 회 재시도.
 *   - 결제 비즈니스 오류 (4xx, 예: ALREADY_PROCESSED_PAYMENT) 는 재시도 금지 —
 *     마지막 응답을 그대로 반환해 호출자가 ApiException 으로 변환한다.
 */
async function tossFetch(
  url: string,
  init: RequestInit,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TOSS_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(TOSS_TIMEOUT_MS),
      });
      const isTransientStatus = res.status === 429 || res.status >= 500;
      if (isTransientStatus && attempt < TOSS_RETRY_MAX_ATTEMPTS) {
        // 응답 본문은 버리고 재시도. 짧은 backoff.
        await res.body?.cancel().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 500 * attempt));
        continue;
      }
      return res;
    } catch (error) {
      lastError = error;
      const isTransient =
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError');
      if (!isTransient || attempt === TOSS_RETRY_MAX_ATTEMPTS) {
        throw error;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastError;
}

// ───────────── 결제 승인 ─────────────

export interface ConfirmPaymentInput {
  paymentKey: string;
  orderId: string;
  amount: number; // KRW
}

export interface TossPaymentResponse {
  paymentKey: string;
  orderId: string;
  orderName: string;
  status:
    | 'READY'
    | 'IN_PROGRESS'
    | 'WAITING_FOR_DEPOSIT'
    | 'DONE'
    | 'CANCELED'
    | 'PARTIAL_CANCELED'
    | 'ABORTED'
    | 'EXPIRED';
  approvedAt: string;
  method: string;
  totalAmount: number;
  card?: { issuerCode: string; number: string; installmentPlanMonths: number };
  receipt?: { url: string };
  // 기타 필드들...
  [key: string]: unknown;
}

/**
 * 토스 결제의 현재 상태 조회.
 *
 * 사용 시점:
 *   - confirm 후 DB 저장이 실패해 우리 쪽 row 가 pending 인 채로 남은 경우,
 *     confirm 재호출 대신 본 함수로 실제 토스 상태를 확인해 reconcile.
 *   - confirm 에서 ALREADY_PROCESSED_PAYMENT 오류를 받았을 때 실제 결제 정보를 가져옴.
 *
 * 토스 API: GET /v1/payments/{paymentKey}
 */
export async function getPayment(
  paymentKey: string,
): Promise<TossPaymentResponse> {
  const res = await tossFetch(
    `${TOSS_API_BASE}/v1/payments/${encodeURIComponent(paymentKey)}`,
    {
      method: 'GET',
      headers: {
        Authorization: getAuthHeader(),
      },
    },
  );

  const body = (await res.json()) as
    | TossPaymentResponse
    | { code: string; message: string };

  if (!res.ok) {
    const err = body as { code: string; message: string };
    throw new ApiException(
      `toss_${err.code ?? 'error'}`,
      err.message ?? '토스 결제 조회 실패',
      400,
      body,
    );
  }
  return body as TossPaymentResponse;
}

export async function confirmPayment(
  input: ConfirmPaymentInput,
): Promise<TossPaymentResponse> {
  const res = await tossFetch(`${TOSS_API_BASE}/v1/payments/confirm`, {
    method: 'POST',
    headers: {
      Authorization: getAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      paymentKey: input.paymentKey,
      orderId: input.orderId,
      amount: input.amount,
    }),
  });

  const body = (await res.json()) as
    | TossPaymentResponse
    | { code: string; message: string };

  if (!res.ok) {
    const err = body as { code: string; message: string };
    throw new ApiException(
      `toss_${err.code ?? 'error'}`,
      err.message ?? '토스 승인 실패',
      400,
      body,
    );
  }

  return body as TossPaymentResponse;
}

// ───────────── 결제 취소·환불 ─────────────

export interface CancelPaymentInput {
  paymentKey: string;
  cancelReason: string;
  cancelAmount?: number; // 부분 환불 시
}

export async function cancelPayment(
  input: CancelPaymentInput,
): Promise<TossPaymentResponse> {
  const res = await tossFetch(
    `${TOSS_API_BASE}/v1/payments/${encodeURIComponent(input.paymentKey)}/cancel`,
    {
      method: 'POST',
      headers: {
        Authorization: getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        cancelReason: input.cancelReason,
        cancelAmount: input.cancelAmount,
      }),
    },
  );

  const body = await res.json();
  if (!res.ok) {
    throw new ApiException(
      'toss_cancel_failed',
      (body as { message?: string }).message ?? '결제 취소 실패',
      400,
      body,
    );
  }
  return body as TossPaymentResponse;
}

// ───────────── Webhook 서명 검증 ─────────────

import { createHmac, timingSafeEqual } from 'crypto';

/**
 * 토스 webhook 의 서명 검증.
 * 헤더: TossPayments-Webhook-Transmission-Time + Signature
 *
 * https://docs.tosspayments.com/guides/v2/webhook/integration#3-웹훅-서명-검증하기
 */
export function verifyWebhookSignature(input: {
  rawBody: string;
  transmissionTime: string;
  signature: string;
}): boolean {
  const webhookSecret = process.env.TOSSPAYMENTS_WEBHOOK_SECRET;

  if (!webhookSecret) {
    // 1) production 은 무조건 throw — 운영 환경 누락은 즉시 실패.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        '[toss/webhook] TOSSPAYMENTS_WEBHOOK_SECRET 가 프로덕션에 설정되지 않았습니다.',
      );
    }
    // 2) 비-production 도 default 는 reject. NODE_ENV 가 비어 있거나 'staging' 같은
    //    값일 때 자동 우회되는 사고를 막는다.
    // 3) 로컬 개발에서만 명시적으로 ALLOW_UNSIGNED_TOSS_WEBHOOK=1 을 켜야 우회 가능.
    if (process.env.ALLOW_UNSIGNED_TOSS_WEBHOOK === '1') {
      console.warn(
        '[toss/webhook] WEBHOOK_SECRET 미설정 — ALLOW_UNSIGNED_TOSS_WEBHOOK 우회 허용',
      );
      return true;
    }
    console.error(
      '[toss/webhook] WEBHOOK_SECRET 미설정 — 서명 검증 실패로 처리. ' +
        '로컬 개발에서 우회가 필요하면 ALLOW_UNSIGNED_TOSS_WEBHOOK=1 을 명시하세요.',
    );
    return false;
  }

  if (!input.signature || !input.transmissionTime) return false;

  const expected = createHmac('sha256', webhookSecret)
    .update(`${input.transmissionTime}.${input.rawBody}`)
    .digest('hex');

  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(input.signature);

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

// ───────────── 주문 ID 생성 ─────────────

import { nanoid } from 'nanoid';

/**
 * 우리 측에서 생성하는 주문 ID.
 * 토스 요구사항: 6~64자, 영문/숫자/특수문자 (-_) 만.
 */
export function generateOrderId(prefix: 'sub' | 'cred' = 'sub'): string {
  return `${prefix}_${Date.now()}_${nanoid(16)}`;
}

// ───────────── 가격 정의 (단일 소스) ─────────────

import type { PlanTier } from '@/lib/types/database';

export const PLAN_PRICES: Record<Exclude<PlanTier, 'free'>, number> = {
  lite: 7_900,     // 내신 대비
  standard: 9_900, // 국가고시 대비
  pro: 14_900,     // 통합형
};

export const CREDIT_PRICES = {
  questions: { amount: 500, price_krw: 4_900 },
  images: { amount: 200, price_krw: 6_900 },
  uploads: { amount: 10, price_krw: 3_900 },
} as const;

export type CreditKind = keyof typeof CREDIT_PRICES;

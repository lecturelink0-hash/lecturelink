/**
 * POST /api/webhooks/toss
 *
 * 토스페이먼츠 webhook 수신.
 *
 * 정책:
 *   - 항상 200 반환 (토스 재전송 루프 방지)
 *   - 서명 검증 실패 / 처리 실패는 ops_alerts 에 기록
 *   - PAYMENT_STATUS_CHANGED 처리: subscription_id 가 있는 결제만 정확한 구독 매핑
 */

import { createAdminClient } from '@/lib/db/admin';
import { verifyWebhookSignature } from '@/lib/payment/toss';
import { reportAlert } from '@/lib/notify/alerts';

export async function POST(request: Request) {
  const rawBody = await request.text();
  const transmissionTime =
    request.headers.get('tosspayments-webhook-transmission-time') ?? '';
  const signature =
    request.headers.get('tosspayments-webhook-signature') ?? '';

  // 1) 서명 검증
  let isValid = false;
  try {
    isValid = verifyWebhookSignature({
      rawBody,
      transmissionTime,
      signature,
    });
  } catch (error) {
    await reportAlert({
      severity: 'critical',
      source: 'webhook/toss',
      message: 'verifyWebhookSignature 호출 실패 (구성 누락 가능성)',
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    return new Response('OK', { status: 200 });
  }

  if (!isValid) {
    await reportAlert({
      severity: 'high',
      source: 'webhook/toss',
      message: '서명 검증 실패 — 위조 시도 가능',
      payload: {
        transmissionTime,
        signaturePrefix: signature.slice(0, 12),
        bodyPrefix: rawBody.slice(0, 200),
      },
    });
    return new Response('OK', { status: 200 });
  }

  // 2) 페이로드 파싱
  let event: {
    eventType: string;
    data: {
      paymentKey?: string;
      orderId?: string;
      status?: string;
      cancels?: Array<{ cancelReason: string; cancelAmount: number }>;
    };
  };
  try {
    event = JSON.parse(rawBody);
  } catch {
    await reportAlert({
      severity: 'medium',
      source: 'webhook/toss',
      message: 'JSON 파싱 실패',
      payload: { bodyPrefix: rawBody.slice(0, 200) },
    });
    return new Response('OK', { status: 200 });
  }

  // 운영 가시성용 최소 로깅 — 전체 페이로드는 출력하지 않는다.
  // paymentKey/orderId 는 prefix 6 자만 남겨 정합성 추적은 가능하되 평문 노출은 피한다.
  const maskId = (v: string | undefined): string =>
    v && v.length > 6 ? `${v.slice(0, 6)}…` : (v ?? '');
  console.log('[webhook/toss]', {
    eventType: event.eventType,
    status: event.data.status,
    paymentKeyPrefix: maskId(event.data.paymentKey),
    orderIdPrefix: maskId(event.data.orderId),
  });

  // 3) 이벤트 처리
  try {
    const admin = createAdminClient();

    if (event.eventType === 'PAYMENT_STATUS_CHANGED') {
      const { paymentKey, orderId, status } = event.data;
      if (!orderId) return new Response('OK', { status: 200 });

      const dbStatus =
        status === 'DONE'
          ? 'approved'
          : status === 'CANCELED' || status === 'PARTIAL_CANCELED'
            ? 'cancelled'
            : status === 'ABORTED' || status === 'EXPIRED'
              ? 'failed'
              : null;

      if (dbStatus) {
        const { data: payment } = await admin
          .from('payments')
          .select('id, user_id, kind, subscription_id')
          .eq('toss_order_id', orderId)
          .maybeSingle();

        if (payment) {
          await admin
            .from('payments')
            .update({
              status: dbStatus,
              toss_payment_key: paymentKey ?? null,
              raw_response: event.data as unknown as Record<string, unknown>,
            })
            .eq('id', payment.id);

          // 취소·환불 시: subscription_id 가 있으면 그것만 cancel.
          // 없으면 P2-2b 로직(현재는 user_id 기반 폴백) — 단 알림 발송
          if (
            dbStatus === 'cancelled' &&
            payment.kind.startsWith('subscription')
          ) {
            if (payment.subscription_id) {
              await admin
                .from('subscriptions')
                .update({ status: 'cancelled', auto_renew: false })
                .eq('id', payment.subscription_id);
            } else {
              // FK 미설정 결제 (P2-2a 이전 데이터). 사용자에 묶인 active 구독 1건만 정상.
              const { data: activeSubs } = await admin
                .from('subscriptions')
                .select('id')
                .eq('user_id', payment.user_id)
                .eq('status', 'active');

              if (activeSubs && activeSubs.length === 1) {
                await admin
                  .from('subscriptions')
                  .update({ status: 'cancelled', auto_renew: false })
                  .eq('id', activeSubs[0].id);
                // fallback 경로 사용 자체가 데이터 결함 신호 — 운영자가 backfill 하도록 알림.
                await reportAlert({
                  severity: 'medium',
                  source: 'webhook/toss',
                  message:
                    '결제 취소 webhook: subscription_id 없이 user 기준 fallback 으로 cancel',
                  payload: {
                    paymentId: payment.id,
                    userId: payment.user_id,
                    canceledSubscriptionId: activeSubs[0].id,
                  },
                });
              } else if (activeSubs && activeSubs.length > 1) {
                await reportAlert({
                  severity: 'high',
                  source: 'webhook/toss',
                  message:
                    '결제 취소 webhook: subscription_id 없음 + active 구독 다수 — 수동 처리 필요',
                  payload: {
                    paymentId: payment.id,
                    userId: payment.user_id,
                    activeSubs,
                  },
                });
              } else {
                // 0건 — 이미 취소됐을 수 있으나 데이터 불일치일 수도 있어 medium 알림.
                await reportAlert({
                  severity: 'medium',
                  source: 'webhook/toss',
                  message:
                    '결제 취소 webhook: subscription_id 없음 + active 구독 0건 — 이미 취소됐거나 결제-구독 매핑 누락',
                  payload: {
                    paymentId: payment.id,
                    userId: payment.user_id,
                  },
                });
              }
            }
          }
        }
      }
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    await reportAlert({
      severity: 'high',
      source: 'webhook/toss',
      message: 'webhook 처리 중 예외',
      payload: { error: error instanceof Error ? error.message : String(error) },
    });
    return new Response('OK', { status: 200 });
  }
}

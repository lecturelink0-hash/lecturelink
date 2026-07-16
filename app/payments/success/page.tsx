'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { CheckCircle2, XCircle } from 'lucide-react';

/**
 * 토스 결제 성공 리다이렉트 처리. success_url(=/payments/success)로 오면서 붙는
 * paymentKey / orderId / amount 를 서버 confirm 에 넘겨 결제를 확정하고 홈으로 이동한다.
 * (기획서: 결제 완료 시 바로 홈페이지로 이동)
 */
export default function PaymentSuccessPage() {
  const [status, setStatus] = useState<'confirming' | 'ok' | 'error'>('confirming');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paymentKey = params.get('paymentKey');
    const orderId = params.get('orderId');
    const amount = Number(params.get('amount'));
    if (!paymentKey || !orderId || !amount) {
      setStatus('error');
      setMessage('결제 정보가 올바르지 않습니다.');
      return;
    }
    api
      .post('/api/payments/confirm', { payment_key: paymentKey, order_id: orderId, amount })
      .then(() => {
        setStatus('ok');
        // 결제 완료 → 바로 홈으로.
        setTimeout(() => { window.location.href = '/dashboard'; }, 1200);
      })
      .catch((e) => {
        setStatus('error');
        setMessage(e instanceof ApiError ? e.message : '결제 확정에 실패했습니다.');
      });
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] px-6">
      <div className="w-full max-w-md text-center">
        {status === 'confirming' && (
          <>
            <div className="w-10 h-10 mx-auto mb-5 border-2 border-sage-600 border-t-transparent rounded-full animate-spin" />
            <div className="text-lg font-bold text-sage-800">결제를 확인하는 중이에요…</div>
          </>
        )}
        {status === 'ok' && (
          <>
            <div className="flex justify-center mb-5">
              <span className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[var(--color-curated-bg)] text-sage-700">
                <CheckCircle2 className="w-9 h-9" strokeWidth={2} />
              </span>
            </div>
            <div className="text-xl font-bold text-sage-800 mb-1">결제가 완료됐어요</div>
            <div className="text-sm text-[var(--color-muted)]">잠시 후 홈으로 이동합니다…</div>
          </>
        )}
        {status === 'error' && (
          <>
            <div className="flex justify-center mb-5">
              <span className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[var(--color-warn-bg)] text-[var(--color-warn)]">
                <XCircle className="w-9 h-9" strokeWidth={2} />
              </span>
            </div>
            <div className="text-xl font-bold text-sage-800 mb-1">결제를 완료하지 못했어요</div>
            <div className="text-sm text-[var(--color-muted)] mb-6">{message}</div>
            <Button variant="secondary" onClick={() => { window.location.href = '/plan'; }}>
              요금제로 돌아가기
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

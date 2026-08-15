'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertCircle, ArrowLeft, CalendarDays, CheckCircle2, CreditCard, Info, RefreshCw } from 'lucide-react';
import { api, ApiError } from '@/lib/api/client';
// 플랜 명칭·가격·설명은 PLAN_CATALOG(단일 소스)에서 가져온다.
import { PLAN_CATALOG, planName as planNameFor } from '@/lib/payment/plans';
import type { PlanTier } from '@/lib/types/database';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PageHeader } from '@/components/ui/PageHeader';

type CancellationReason =
  | 'price'
  | 'low_usage'
  | 'missing_features'
  | 'temporary_break'
  | 'other'
  | 'prefer_not_to_say';

interface SubscriptionSnapshot {
  id: string;
  plan_tier: PlanTier;
  status: string;
  started_at: string | null;
  expires_at: string | null;
  auto_renew: boolean;
  cancellation_reason: CancellationReason | null;
  cancelled_at: string | null;
}

interface SubscriptionResponse {
  subscription: SubscriptionSnapshot | null;
  plan_tier: PlanTier;
}

const CANCELLATION_REASONS: ReadonlyArray<{ value: CancellationReason; label: string }> = [
  { value: 'price', label: '가격이 부담돼요' },
  { value: 'low_usage', label: '자주 이용하지 않아요' },
  { value: 'missing_features', label: '필요한 기능이 부족해요' },
  { value: 'temporary_break', label: '잠시 쉬고 싶어요' },
  { value: 'other', label: '기타' },
  { value: 'prefer_not_to_say', label: '답변하지 않을게요' },
];

function formatDate(date: string | null) {
  if (!date) return '이용 기간을 확인 중이에요';
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(date));
}

export default function SubscriptionPage() {
  const router = useRouter();
  const [data, setData] = useState<SubscriptionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<CancellationReason>('prefer_not_to_say');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const loadSubscription = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.get<SubscriptionResponse>('/api/me/subscription'));
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '구독 정보를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSubscription();
  }, [loadSubscription]);

  const subscription = data?.subscription ?? null;
  const isActivePaidSubscription = subscription?.status === 'active' && subscription.plan_tier !== 'free';
  const accessEndDate = formatDate(subscription?.expires_at ?? null);
  const planName = subscription ? planNameFor(subscription.plan_tier) : null;
  const pricingPlan = subscription && subscription.plan_tier !== 'free'
    ? PLAN_CATALOG[subscription.plan_tier]
    : undefined;
  const monthlyPrice = pricingPlan
    ? new Intl.NumberFormat('ko-KR').format(pricingPlan.price)
    : null;
  const planSummary = subscription?.plan_tier === 'pro'
    ? '내신 대비 + CPX를 함께 이용할 수 있어요.'
    : pricingPlan?.desc;

  async function cancelSubscription() {
    setCancelling(true);
    setError(null);
    try {
      await api.post('/api/me/subscription/cancel', { reason });
      setData((current) => current && current.subscription
        ? {
            ...current,
            subscription: {
              ...current.subscription,
              auto_renew: false,
              cancellation_reason: reason,
              cancelled_at: new Date().toISOString(),
            },
          }
        : current);
      setConfirmOpen(false);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '구독 해지 처리에 실패했습니다.');
      setConfirmOpen(false);
    } finally {
      setCancelling(false);
    }
  }

  if (loading) {
    return (
      <div className="ll-system-page" aria-busy="true" aria-label="구독 정보를 불러오는 중">
        <div className="h-9 w-36 rounded-lg bg-[var(--color-sage-100)] animate-pulse" />
        <div className="mt-4 h-5 max-w-xl rounded bg-[var(--color-sage-100)] animate-pulse" />
        <div className="mt-10 grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,.8fr)] gap-5">
          <div className="h-72 rounded-[var(--radius-lg)] bg-[var(--color-sage-100)] animate-pulse" />
          <div className="h-72 rounded-[var(--radius-lg)] bg-[var(--color-sage-100)] animate-pulse" />
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="ll-system-page">
        <PageHeader title="구독 관리" description="현재 이용 중인 요금제와 정기 결제를 관리할 수 있어요." />
        <Card>
          <div className="flex items-start gap-3 text-[var(--color-error)]">
            <AlertCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm leading-relaxed">{error}</p>
              <Button className="mt-4" variant="secondary" size="sm" onClick={() => void loadSubscription()}>
                <RefreshCw className="w-4 h-4" />
                다시 시도
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  if (!isActivePaidSubscription || !subscription || !planName) {
    return (
      <div className="ll-system-page">
        <PageHeader title="구독 관리" description="현재 이용 중인 유료 구독이 없어요." />
        <Card>
          <CheckCircle2 className="w-5 h-5 text-sage-600" aria-hidden="true" />
          <h2 className="mt-3 text-lg font-bold tracking-tight text-sage-800">필요할 때 요금제를 선택할 수 있어요</h2>
          <p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">
            요금제에서 내신 대비와 CPX 학습 방식에 맞는 이용권을 확인해보세요.
          </p>
          <Button className="mt-5" onClick={() => router.push('/plan')}>
            요금제 보기
          </Button>
        </Card>
      </div>
    );
  }

  const cancellationScheduled = !subscription.auto_renew;

  return (
    <div className="ll-system-page">
      <div className="mb-8 md:mb-10">
        <button
          type="button"
          onClick={() => router.push('/mypage')}
          className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-[var(--color-muted)] transition-colors hover:text-[var(--color-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-line-strong)] focus-visible:ring-offset-2"
        >
          <ArrowLeft className="h-4 w-4" />
          마이페이지
        </button>
        <PageHeader
          className="!mb-0"
          title="구독 관리"
          description="현재 이용 중인 요금제와 결제 정보를 관리할 수 있어요."
        />
      </div>

      {error && (
        <div role="alert" className="mb-5 flex items-start gap-2.5 rounded-[var(--radius-md)] border border-[var(--color-error)] bg-[var(--color-error-bg)] px-4 py-3 text-sm leading-relaxed text-[var(--color-error)]">
          <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,.8fr)] gap-5 items-stretch">
        <Card className="h-full" title="현재 이용 중인 요금제">
          <div className="rounded-[var(--radius-md)] bg-[var(--color-primary)] px-5 py-5 text-white sm:px-6">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <p className="text-xl font-bold tracking-tight">{planName}</p>
                <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-bold">
                  {cancellationScheduled ? '결제 종료 예정' : '이용 중'}
                </span>
              </div>
              {planSummary && <p className="mt-1.5 text-sm leading-relaxed text-white/80">{planSummary}</p>}
              {monthlyPrice && <p className="mt-3 text-xl font-bold tracking-tight">월 {monthlyPrice}원</p>}
            </div>
          </div>

          <dl className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="flex items-start gap-2.5">
              <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted)]">{cancellationScheduled ? '이용 가능 기간' : '다음 결제일'}</dt>
                <dd className="mt-1 text-sm font-bold text-[var(--color-text)]">{accessEndDate}</dd>
              </div>
            </div>
            <div className="flex items-start gap-2.5 md:border-l md:border-[var(--color-border)] md:pl-5">
              <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
              <div>
                <dt className="text-xs font-medium text-[var(--color-muted)]">결제 상태</dt>
                <dd className="mt-1 text-sm font-bold text-[var(--color-text)]">{cancellationScheduled ? '자동결제 종료됨' : '자동결제 이용 중'}</dd>
              </div>
            </div>
            <div className="flex items-start justify-between gap-3 md:border-l md:border-[var(--color-border)] md:pl-5">
              <div className="flex min-w-0 items-start gap-2.5">
                <CreditCard className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
                <div className="min-w-0">
                  <dt className="text-xs font-medium text-[var(--color-muted)]">결제 수단</dt>
                  <dd className="mt-1 text-sm font-bold text-[var(--color-muted)]">결제수단 정보 없음</dd>
                </div>
              </div>
              <Button type="button" variant="secondary" size="sm" disabled title="결제수단 변경 기능을 준비 중이에요.">
                변경
              </Button>
            </div>
          </dl>

          <div className="mt-6 flex flex-col gap-4 border-t border-[var(--color-border)] pt-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-sm font-bold text-[var(--color-text)]">필요한 학습 방식이 달라졌나요?</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-muted)]">내신 대비와 CPX 이용 범위에 맞춰 요금제를 변경할 수 있어요.</p>
            </div>
            <Button className="shrink-0" size="sm" onClick={() => router.push('/plan')}>
              요금제 변경
            </Button>
          </div>
        </Card>

        <Card
          className="flex h-full flex-col"
          title={cancellationScheduled ? '자동결제가 종료되었어요' : '정기결제 해지'}
          description={cancellationScheduled ? undefined : '정기결제를 해지하면 다음 결제일부터 추가 결제가 진행되지 않아요.'}
        >
          {cancellationScheduled ? (
            <div role="status" aria-live="polite">
              <div className="rounded-[var(--radius-md)] bg-[var(--color-sage-100)] px-4 py-3 text-sm leading-relaxed text-sage-800">
                <strong>{accessEndDate}</strong>까지 현재 요금제의 기능을 계속 이용할 수 있어요.
              </div>
              <p className="mt-4 text-sm leading-relaxed text-[var(--color-muted)]">결제 기간이 끝난 뒤에는 새 결제가 진행되지 않습니다. 학습 기록과 문제집은 삭제되지 않아요.</p>
            </div>
          ) : (
            <div className="flex flex-1 flex-col">
              <div className="rounded-[var(--radius-md)] bg-[var(--color-sage-100)] px-4 py-4 text-sm leading-relaxed text-[var(--color-text)]">
                <div className="flex items-start gap-3">
                  <CalendarDays className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
                  <p>해지 후에도 <strong>{accessEndDate}</strong>까지 현재 요금제를 이용할 수 있습니다.</p>
                </div>
              </div>
              <div className="mt-4 flex items-start gap-2.5 text-sm leading-relaxed text-[var(--color-muted)]">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted)]" aria-hidden="true" />
                <p>결제 취소·환불은 이 화면에서 처리되지 않으며, 이용 기간이 끝나면 정기 결제가 종료됩니다.</p>
              </div>
              <Button className="mt-6 sm:mt-auto" fullWidth variant="secondary" onClick={() => setConfirmOpen(true)}>
                정기결제 해지하기
              </Button>
            </div>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title="정기 결제를 해지할까요?"
        description={`해지 후에도 ${accessEndDate}까지 현재 요금제를 이용할 수 있으며, 이후에는 자동으로 결제되지 않습니다.`}
        confirmLabel="정기결제 해지"
        cancelLabel="계속 이용하기"
        confirmVariant="secondary"
        cancelVariant="primary"
        loading={cancelling}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void cancelSubscription()}
      >
        <fieldset className="mt-5 border-t border-[var(--color-border)] pt-5">
          <legend className="text-sm font-bold text-sage-800">구독을 취소하는 이유를 알려주세요</legend>
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">서비스 개선을 위한 선택 항목이에요.</p>
          <div className="mt-3 grid gap-2">
            {CANCELLATION_REASONS.map((option) => (
              <label key={option.value} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-sage-800 hover:bg-[var(--color-sage-100)]">
                <input
                  type="radio"
                  name="cancellation-reason"
                  value={option.value}
                  checked={reason === option.value}
                  onChange={() => setReason(option.value)}
                  className="h-4 w-4 accent-[var(--color-primary)]"
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
      </ConfirmDialog>
    </div>
  );
}

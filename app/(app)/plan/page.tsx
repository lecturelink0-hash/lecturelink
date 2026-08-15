'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import clsx from 'clsx';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { PLAN_CATALOG, planName } from '@/lib/payment/plans';
import { Check, Ticket, BarChart3 } from 'lucide-react';

interface QuotaSnapshot {
  plan_tier: 'free' | 'lite' | 'standard' | 'pro' | 'unlimited';
  questions: { limit: number; used: number; bonus: number; remaining: number };
  uploads: { limit: number; used: number; bonus: number; remaining: number };
  images: { limit: number; used: number; bonus: number; remaining: number };
}

interface Plan {
  tier: 'lite' | 'standard' | 'pro';
  name: string;
  price: number;
  desc: string;
  featured?: boolean;
  features: { text: string; supportingText?: string }[];
}

// 플랜 명칭·가격·설명은 PLAN_CATALOG(단일 소스)에서 — 이 페이지는 features 만 정의한다.
const PLANS: Plan[] = [
  {
    tier: 'lite' as const,
    ...PLAN_CATALOG.lite,
    features: [
      { text: '강의자료 업로드' },
      { text: '월 500문항 생성' },
      { text: '지식형 · 임상형 · 이미지형 문제 생성' },
      { text: '기본 해설 + 오답노트' },
      { text: '유사문제 자동 생성' },
      { text: 'CPX 체험 1회' },
    ],
  },
  {
    tier: 'standard' as const,
    ...PLAN_CATALOG.standard,
    features: [
      {
        text: '월 CPX 240분',
        supportingText: '약 12분 × 20회 분량',
      },
      { text: 'AI 환자와 음성 문진' },
      { text: '신체진찰 연습' },
      { text: '진료 종료 후 자동 채점' },
      { text: '항목별 점수 및 피드백' },
      { text: '부족한 영역 다시 연습' },
    ],
  },
  {
    tier: 'pro' as const,
    ...PLAN_CATALOG.pro,
    featured: true,
    features: [
      { text: '강의자료 업로드' },
      { text: '월 500문항 생성' },
      { text: '지식형 · 임상형 · 이미지형 문제 생성' },
      { text: '오답노트 + 유사문제 생성' },
      {
        text: '월 CPX 240분',
        supportingText: '약 12분 × 20회 분량',
      },
      { text: 'CPX 채점 및 피드백' },
    ],
  },
];

const PLAN_NAMES: Record<QuotaSnapshot['plan_tier'], string> = {
  free: PLAN_CATALOG.free.name,
  lite: PLAN_CATALOG.lite.name,
  standard: PLAN_CATALOG.standard.name,
  pro: PLAN_CATALOG.pro.name,
  unlimited: planName('unlimited'),
};

export default function PlanPage() {
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [quotaReady, setQuotaReady] = useState(false);
  const [loading, setLoading] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);

  useEffect(() => {
    api
      .get<QuotaSnapshot>('/api/me/quota')
      .then(setQuota)
      .catch(() => {})
      .finally(() => setQuotaReady(true));
    if (typeof window !== 'undefined') {
      setLimitReached(new URLSearchParams(window.location.search).has('limit'));
    }
  }, []);

  async function handlePurchase(plan: Plan) {
    setLoading(plan.tier);
    try {
      const res = await api.post<{
        order_id: string;
        amount: number;
        order_name: string;
        customer_email: string;
        success_url: string;
        fail_url: string;
        client_key: string;
      }>('/api/payments/init', {
        kind: 'subscription',
        plan_tier: plan.tier as 'lite' | 'standard' | 'pro',
      });

      // 실제 토스 SDK 로딩 및 결제 위젯 호출은 다음 단계에서 통합
      alert(
        `결제 초기화 완료\n주문 ID: ${res.order_id}\n금액: ₩${res.amount.toLocaleString()}\n\n(데모) 실제 토스 위젯 연결은 운영 단계에서 추가됩니다.`,
      );
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '결제 초기화 실패';
      alert(msg);
    } finally {
      setLoading(null);
    }
  }

  function handleCpxPassPurchase() {
    // CPX 이용권용 결제 kind/product ID와 entitlement가 아직 없어 기존 구독 결제로
    // 우회하지 않는다. 버튼은 현재 구독 상태와 무관하게 같은 진입점을 사용한다.
    alert('CPX 5회 이용권은 결제 상품 연결 후 구매할 수 있어요. 현재는 상품 정보를 확인해 주세요.');
  }

  const hasPaidPlan = quota != null && quota.plan_tier !== 'free';
  const showFreeTrial = quotaReady && quota?.plan_tier === 'free';

  return (
    <div className="ll-plan-page content">
      <section className="page-head">
        <h1>
          <span className="headline-accent">학습 방식에 맞는</span>
          <br />
          플랜을 선택하세요
        </h1>
        <p className="lead">내신 대비부터 CPX 실전 연습까지, 필요한 기능에 맞는 플랜을 선택하세요.</p>
      </section>

      <div className="plan-content-flow">
        <div className={clsx('plan-selection', showFreeTrial && 'has-trial')}>
          {showFreeTrial && (
            <div className="notice">
              <strong>무료로 먼저 체험해보세요</strong>
              <span>문제 생성 30문항 + CPX 1회를 무료로 이용할 수 있어요.</span>
            </div>
          )}

          {/* 요금제 카드 */}
          <div className="relative">
            {!quotaReady && (
              <section
                className="plans absolute inset-0 z-10"
                aria-label="요금제 정보를 불러오는 중"
                aria-busy="true"
              >
                {PLANS.map((plan) => (
                  <div key={plan.tier} className="plan pointer-events-none" aria-hidden="true">
                    <div className="flex h-full flex-col animate-pulse">
                      <div className="h-7 w-28 rounded-md bg-[var(--color-sage-100)]" />
                      <div className="mt-3 h-4 w-40 rounded bg-[var(--color-sage-100)]" />
                      <div className="mt-7 h-10 w-32 rounded bg-[var(--color-sage-100)]" />
                      <div className="mt-7 space-y-3">
                        <div className="h-4 rounded bg-[var(--color-sage-100)]" />
                        <div className="h-4 rounded bg-[var(--color-sage-100)]" />
                        <div className="h-4 w-4/5 rounded bg-[var(--color-sage-100)]" />
                      </div>
                      <div className="mt-auto h-[52px] rounded-lg bg-[var(--color-sage-100)]" />
                    </div>
                  </div>
                ))}
              </section>
            )}

            <section
              className={clsx('plans', !quotaReady && 'pointer-events-none opacity-0')}
              aria-label="요금제 목록"
            >
              {PLANS.map((plan) => {
                const featured = !!plan.featured;
                const currentPlanTier = quota?.plan_tier === 'unlimited' ? 'pro' : quota?.plan_tier;
                const isCurrent = currentPlanTier === plan.tier;
                return (
                  <div
                    key={plan.tier}
                    className={clsx(
                      'plan',
                      featured && 'integrated',
                      isCurrent && 'current',
                    )}
                  >
                  {/* 플랜명·가격·설명 */}
                  <div className="plan-heading-row">
                    <div className="plan-title-group">
                      <h2 className="plan-name">
                        {plan.name}
                      </h2>
                      {featured && <span className="ribbon">추천</span>}
                    </div>
                    {isCurrent && <span className="current-state">현재 플랜</span>}
                  </div>

                  <div className="plan-summary">
                    <div className="price" aria-label={`월 ${plan.price.toLocaleString()}원`}>
                      <strong>
                        ₩{plan.price.toLocaleString()}
                      </strong>
                      <span>/월</span>
                    </div>
                    <p className="plan-sub">
                      {plan.desc}
                    </p>
                  </div>

                  {/* 기능 목록 */}
                  <ul className="features">
                    {plan.features.map((f, i) => (
                      <li key={i}>
                        <Check
                          className="w-4 h-4 mt-0.5 flex-shrink-0 text-sage-600"
                          strokeWidth={2.5}
                        />
                        <span className="feature-copy">
                          <span>{f.text}</span>
                          {f.supportingText && <small>{f.supportingText}</small>}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {/* CTA */}
                  <div className="plan-action">
                    {isCurrent ? (
                      // 현재 플랜 칸은 구독 관리(해지 포함) 화면 진입점을 겸한다.
                      <Link
                        href="/subscription"
                        aria-current="true"
                        className="plan-current-button"
                      >
                        구독 관리
                      </Link>
                    ) : (
                      <Button
                        fullWidth
                        size="lg"
                        variant={featured ? 'primary' : 'secondary'}
                        className="plan-action-button"
                        onClick={() => handlePurchase(plan)}
                        loading={loading === plan.tier}
                      >
                        {hasPaidPlan ? '이 플랜으로 변경 →' : `${plan.name} 구독하기`}
                      </Button>
                    )}
                  </div>
                  </div>
                );
              })}
            </section>
          </div>
        </div>

        <section className="cpx-pass" aria-labelledby="cpx-pass-title">
          <div className="cpx-pass-copy">
            <div className="cpx-pass-heading">
              <Ticket className="w-4 h-4" aria-hidden="true" />
              <h2 id="cpx-pass-title">CPX 5회 이용권</h2>
            </div>
            <p className="cpx-pass-price">
              <strong>CPX 5회</strong>
              <span aria-hidden="true">·</span>
              <strong>₩4,900</strong>
            </p>
            <p id="cpx-pass-description">구독 없이 필요한 만큼 이용하거나, 기존 플랜에 추가할 수 있어요.</p>
          </div>
          <Button
            type="button"
            variant="primary"
            size="lg"
            className="cpx-pass-button"
            onClick={handleCpxPassPurchase}
            aria-describedby="cpx-pass-description"
          >
            CPX 5회 구매하기
          </Button>
        </section>

        {limitReached && (
          <div className="limit-notice" role="status">
            <strong>사용량 한도에 도달했어요.</strong>
            <span>필요한 기능에 맞는 플랜이나 CPX 5회 이용권을 확인해 주세요.</span>
          </div>
        )}

        {/* 이번 달 사용량 — 플랫 */}
        {quota && (
          <section className="usage">
            <div className="usage-head">
              <BarChart3 className="w-4 h-4 text-sage-600" strokeWidth={2} />
              <span className="ll-eyebrow">이번 달 사용량</span>
            </div>
            <h2>
              현재 {PLAN_NAMES[quota.plan_tier]} 플랜
            </h2><p className="current-plan">현재 계정에서 이번 달 사용할 수 있는 학습 리소스입니다.</p>
            <div className="usage-grid">
              <QuotaBar label="문항" data={quota.questions} />
              <QuotaBar label="자료 업로드" data={quota.uploads} />
              {/* #163 에서 '별도 제한 폐지'로 뺐던 바를 사용자 요청으로 복원.
                  /api/me/quota 는 계속 images 를 내려주므로 실제 수치가 뜬다. */}
              <QuotaBar label="이미지 문항" data={quota.images} />
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function QuotaBar({ label, data }: { label: string; data: { limit: number; used: number; bonus: number; remaining: number } }) {
  const total = data.limit + data.bonus;
  const unlimited = data.remaining >= 1_000_000 || data.limit >= 1_000_000;
  const percent = unlimited ? 0 : total === 0 ? 0 : Math.min(100, (data.used / total) * 100);
  return (
    <div className="usage-item">
      <div className="usage-row">
        <span className="usage-label">{label}</span>
        <span className="usage-value">
          {unlimited ? '무제한' : <>{data.used} <span className="text-[var(--color-muted)] font-medium">/ {total}</span></>}
        </span>
      </div>
      <div className="bar">
        <div
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="remaining">잔여 {unlimited ? '무제한' : data.remaining}</p>
      <div className="text-xs text-[var(--color-muted)] mt-2">
        {unlimited ? '잔여 무제한' : <>잔여 {data.remaining}{data.bonus > 0 && ` (보너스 ${data.bonus})`}</>}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';
import { Check, X, Gift, BarChart3 } from 'lucide-react';

interface QuotaSnapshot {
  plan_tier: 'free' | 'lite' | 'standard' | 'pro';
  questions: { limit: number; used: number; bonus: number; remaining: number };
  uploads: { limit: number; used: number; bonus: number; remaining: number };
  images: { limit: number; used: number; bonus: number; remaining: number };
}

interface Plan {
  tier: 'lite' | 'standard' | 'pro' | 'unlimited';
  name: string;
  price: number;
  desc: string;
  featured?: boolean;
  /** 통합형 무제한: 별도 enum 값이 필요해 현재는 표시만(구매 대신 문의) */
  displayOnly?: boolean;
  features: { ok: boolean; text: string }[];
}

const PLANS: Plan[] = [
  {
    tier: 'lite' as const,
    name: '내신 대비',
    price: 7_900,
    desc: '학교 시험·내신 위주',
    features: [
      { ok: true, text: '강의자료 업로드' },
      { ok: true, text: '월 500문항 생성' },
      { ok: true, text: '기본 해설 + 오답노트' },
      { ok: true, text: '유사문제 자동 생성' },
      { ok: false, text: '모의고사 CBT' },
      { ok: false, text: '국시 전 범위 풀이' },
    ],
  },
  {
    tier: 'standard' as const,
    name: '국가고시 대비',
    price: 9_900,
    desc: '국가고시형 집중',
    features: [
      { ok: true, text: '국가고시형 문제 풀이' },
      { ok: true, text: '오답 기반 월 500문항 생성' },
      { ok: true, text: '실전 해설 + 개념 연결' },
      { ok: true, text: '모의고사 CBT' },
      { ok: true, text: '주간 학습 리포트' },
      { ok: false, text: '자료 기반 문제 생성' },
    ],
  },
  {
    tier: 'pro' as const,
    name: '통합형',
    price: 14_900,
    desc: '내신 + 국시 통합',
    featured: true,
    features: [
      { ok: true, text: '자료 기반 + 국가고시형 모두' },
      { ok: true, text: '월 2,000문항 생성' },
      { ok: true, text: '자료 업로드 월 100개' },
      { ok: true, text: '자료·국시 오답 통합 보기' },
      { ok: true, text: '모의고사 CBT (전 과목)' },
      { ok: true, text: '이미지 문제 적용' },
    ],
  },
  {
    tier: 'unlimited' as const,
    name: '통합형 무제한',
    price: 20_900,
    desc: '국시 직전·시험 직전 집중',
    features: [
      { ok: true, text: '자료 업로드 무제한' },
      { ok: true, text: '문항 생성 무제한' },
      { ok: true, text: '우선 처리 (빠른 분석)' },
      { ok: true, text: '이미지 문제 무제한' },
      { ok: true, text: '상세 유형별 학습 분석' },
    ],
  },
];

export default function PlanPage() {
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);

  useEffect(() => {
    api.get<QuotaSnapshot>('/api/me/quota').then(setQuota).catch(() => {});
    if (typeof window !== 'undefined') {
      setLimitReached(new URLSearchParams(window.location.search).has('limit'));
    }
  }, []);

  async function handlePurchase(plan: Plan) {
    if (plan.displayOnly) {
      window.location.href = '/contact';
      return;
    }
    // 통합형 무제한(unlimited)은 결제 tier enum(lite/standard/pro)에 없어 서버 결제 초기화 대상이
    // 아니므로, 다른 유료 플랜과 동일한 결제(데모) 플로우를 직접 노출한다.
    if (plan.tier === 'unlimited') {
      alert(
        `결제 초기화 완료\n플랜: 통합형 무제한\n금액: ₩${plan.price.toLocaleString()}\n\n(데모) 실제 토스 위젯 연결은 운영 단계에서 추가됩니다.`,
      );
      return;
    }
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

  return (
    <div className="ll-plan-page content">
      {/* 사용량 한도 도달 시: '추가 크레딧' / '통합형 무제한' 2택 병렬 안내(기획서) */}
      {limitReached && (
        <div className="ll-card p-5 mb-8 border border-[var(--color-accent)]/40 bg-[var(--color-accent-bg)]">
          <div className="text-[15px] font-bold text-sage-800 mb-1">사용량 한도에 도달했어요</div>
          <div className="text-[13px] text-[var(--color-muted)] mb-4 leading-relaxed">
            계속 학습하려면 아래 두 가지 중 하나를 선택하세요.
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => handlePurchase({ tier: 'lite', name: '추가 크레딧', price: 0, desc: '', features: [] } as unknown as Plan)}
              className="text-left rounded-[14px] border border-[var(--color-border)] bg-white p-4 hover:border-sage-400 transition-colors"
            >
              <div className="text-sm font-bold text-sage-800 mb-1">추가 크레딧 결제</div>
              <div className="text-[12px] text-[var(--color-muted)]">지금 요금제를 유지하고 문제 수만 추가로 충전</div>
            </button>
            <a
              href="mailto:goodwood0202@gmail.com?subject=통합형 무제한 문의"
              className="text-left rounded-[14px] border border-sage-700 bg-sage-700 text-white p-4 hover:bg-sage-800 transition-colors"
            >
              <div className="text-sm font-bold mb-1">통합형 무제한으로 전환</div>
              <div className="text-[12px] text-white/80">한도 없이 무제한으로 이용 (문의)</div>
            </a>
          </div>
        </div>
      )}

      <section className="page-head"><span className="eyebrow">요금 안내</span><h1>학습 목표에 맞게<br/><span className="headline-accent">필요한 기능만</span> 선택하세요</h1><p className="lead">학교 시험 대비, 국가고시 대비, 또는 둘 다. 렉처링크의 주요 학습 흐름을 필요한 만큼 골라 사용할 수 있습니다.</p></section>

      <div className="space-y-8">
        {/* 첫 달 무료 배너 — 통합형 요금제 한정(기획서) */}
        <div className="notice">
          <strong>가입 후 첫 달, 모든 기능 무료</strong><span>부담 없이 시작하고 언제든 해지할 수 있습니다.</span>
        </div>

        {/* 요금제 카드 */}
        <div>
          <section className="plans" aria-label="요금제 목록">
            {PLANS.map((plan) => {
              const featured = !!plan.featured;
              const isCurrent = quota?.plan_tier === plan.tier;
              return (
                <div
                  key={plan.tier}
                  className={clsx(
                    'plan',
                    featured && 'integrated',
                  )}
                >
                  {featured && (
                    <span className="ribbon">
                      추천
                    </span>
                  )}

                  {/* 플랜명 */}
                  <div className="mb-5">
                    <h2 className="plan-name">
                      {plan.name}
                    </h2>
                    <p className="plan-sub">
                      {plan.desc}
                    </p>
                  </div>

                  {/* 가격 */}
                  <div className="price">
                    <strong>
                      ₩{plan.price.toLocaleString()}
                    </strong><span>/월</span>
                  </div>
                  <p className="desc">
                    {plan.tier === 'pro' || plan.tier === 'unlimited'
                      ? `첫 달 무료 후 월 ₩${plan.price.toLocaleString()}`
                      : '무료체험은 통합형부터'}
                  </p>

                  {/* 기능 목록 */}
                  <ul className="features">
                    {plan.features.map((f, i) => (
                      <li key={i} className={f.ok ? '' : 'no'}>
                        {f.ok ? (
                          <Check
                            className={clsx('w-4 h-4 mt-0.5 flex-shrink-0', featured ? 'text-[#9A7B16]' : 'text-sage-600')}
                            strokeWidth={2.5}
                          />
                        ) : (
                          <X
                            className={clsx('w-4 h-4 mt-0.5 flex-shrink-0', featured ? 'text-[#C4AC5E]' : 'text-[var(--color-sage-400)]')}
                            strokeWidth={2.5}
                          />
                        )}
                        {/* 통합형(featured) 카드는 밝은 골드 배경 → 흰색 대신 진한 골드-브라운으로 표기 */}
                        <span
                          className={clsx(
                            f.ok
                              ? featured ? 'text-[#6F5511]' : 'text-sage-800'
                              : featured ? 'text-[#A98B2E]' : 'text-[var(--color-muted)]',
                          )}
                        >
                          {f.text}
                        </span>
                      </li>
                    ))}
                  </ul>

                  {/* CTA */}
                  <div className="mt-auto">
                    {featured ? (
                      <button
                        type="button"
                        onClick={() => handlePurchase(plan)}
                        disabled={isCurrent || loading === plan.tier}
                        className="w-full h-[52px] rounded-lg inline-flex items-center justify-center gap-2 text-base font-bold bg-[var(--color-gold)] text-sage-900 hover:bg-[var(--color-gold-dark)] transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                      >
                        {loading === plan.tier && (
                          <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        )}
                        {isCurrent ? '현재 플랜' : '결제하기'}
                      </button>
                    ) : (
                      <Button
                        fullWidth
                        size="lg"
                        variant="secondary"
                        onClick={() => handlePurchase(plan)}
                        loading={loading === plan.tier}
                        disabled={isCurrent}
                      >
                        {plan.displayOnly ? '문의하기' : isCurrent ? '현재 플랜' : '결제하기'}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </section>

          <p className="text-center text-xs text-[var(--color-muted)] mt-5">
            추가 크레딧 결제 시 문제 수 추가 가능
          </p>
        </div>

        {/* 이번 달 사용량 — 플랫 */}
        {quota && (
          <section className="usage">
            <div className="usage-head">
              <BarChart3 className="w-4 h-4 text-sage-600" strokeWidth={2} />
              <span className="ll-eyebrow">이번 달 사용량</span>
            </div>
            <h2>
              현재 {quota.plan_tier.toUpperCase()} 플랜
            </h2><p className="current-plan">현재 계정에서 이번 달 사용할 수 있는 학습 리소스입니다.</p>
            <div className="usage-grid">
              <QuotaBar label="문항" data={quota.questions} />
              <QuotaBar label="자료 업로드" data={quota.uploads} />
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

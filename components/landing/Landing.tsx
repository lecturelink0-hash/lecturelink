'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  Stethoscope,
  Target,
  Upload,
  FileText,
  RotateCcw,
  Infinity as InfinityIcon,
  Image as ImageIcon,
  Activity,
  Timer,
  ClipboardCheck,
  Check,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';

/* ============================================================
   Reveal — IntersectionObserver 기반 fade-in + slide-up 래퍼
   ============================================================ */
function Reveal({
  children,
  delay = 0,
  className = '',
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(el);

    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={`transition-[opacity,transform] duration-500 ease-out ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'
      } ${className}`}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {children}
    </div>
  );
}

/* ============================================================
   인터랙티브 데모 — 자동 재생 가짜 문제 카드
   ============================================================ */
const DEMO_CHOICES = [
  { label: 'A', text: '좌심실 비대' },
  { label: 'B', text: '심낭 삼출' },
  { label: 'C', text: '폐동맥 고혈압' },
  { label: 'D', text: '승모판 역류' },
  { label: 'E', text: '대동맥 협착' },
];

function InteractiveDemo() {
  const [selected, setSelected] = useState<number | null>(null);
  const [showReview, setShowReview] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'selecting' | 'answered' | 'reviewing'>('idle');
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function startAnimation() {
    setSelected(null);
    setShowReview(false);
    setPhase('selecting');

    let step = 0;
    intervalRef.current = setInterval(() => {
      setSelected(step % DEMO_CHOICES.length);
      step++;
    }, 180);

    timerRef.current = setTimeout(() => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      const correctIdx = 0; // 좌심실 비대 = 정답
      setSelected(correctIdx);
      setPhase('answered');

      timerRef.current = setTimeout(() => {
        setShowReview(true);
        setPhase('reviewing');

        timerRef.current = setTimeout(() => {
          startAnimation();
        }, 3200);
      }, 1200);
    }, 1800);
  }

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          startAnimation();
          observer.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(el);

    return () => {
      observer.disconnect();
      if (timerRef.current) clearTimeout(timerRef.current);
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const CORRECT = 0;

  return (
    <div ref={ref} className="w-full max-w-lg mx-auto space-y-4">
      {/* 문제 카드 */}
      <div className="bg-white rounded-2xl border border-[var(--color-border)] p-7 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <span className="text-xs font-semibold text-sage-600 bg-[var(--color-sage-100)] px-2.5 py-1 rounded-full">
            AI 생성 문제 · 순환기내과
          </span>
        </div>
        <p className="text-base font-semibold text-sage-800 leading-relaxed mb-6">
          70세 남성이 운동 시 호흡곤란과 흉통을 주소로 내원하였다.
          심초음파에서 좌심실 벽 두께 14 mm, 이완기 기능 장애 소견.
          가장 가능성이 높은 진단은?
        </p>
        <div className="space-y-2">
          {DEMO_CHOICES.map((c, i) => {
            const isSelected = selected === i;
            const isAnswered = phase === 'answered' || phase === 'reviewing';
            const isCorrect = i === CORRECT;

            let bg = 'bg-[var(--color-sage-50)] border-[var(--color-border)]';
            let textColor = 'text-sage-800';

            if (isAnswered && isCorrect) {
              bg = 'bg-[var(--color-curated-bg)] border-[var(--color-curated)]';
              textColor = 'text-[var(--color-curated)]';
            } else if (isAnswered && isSelected && !isCorrect) {
              bg = 'bg-[var(--color-warn-bg)] border-[var(--color-warn)]';
              textColor = 'text-[var(--color-warn)]';
            } else if (phase === 'selecting' && isSelected) {
              bg = 'bg-[var(--color-sage-200)] border-sage-500';
            }

            return (
              <div
                key={c.label}
                className={`flex items-center gap-3 rounded-xl border px-4 py-3.5 transition-all duration-200 ${bg}`}
              >
                <span className={`text-sm font-bold w-5 ${textColor}`}>{c.label}</span>
                <span className={`text-sm flex-1 ${textColor}`}>{c.text}</span>
                {isAnswered && isCorrect && (
                  <Check className="w-4 h-4 text-[var(--color-curated)]" strokeWidth={2.5} />
                )}
                {isAnswered && isSelected && !isCorrect && (
                  <X className="w-4 h-4 text-[var(--color-warn)]" strokeWidth={2.5} />
                )}
              </div>
            );
          })}
        </div>
        {(phase === 'answered' || phase === 'reviewing') && (
          <div className="mt-5 p-4 bg-[var(--color-sage-100)] rounded-xl text-sm text-sage-700 leading-relaxed">
            <span className="font-semibold">해설:</span> LVH(좌심실 비대)는 고혈압, 대동맥 협착 등에서 보상 기전으로 발생하며,
            이완기 기능 장애와 동반 시 심부전 위험이 높습니다. 벽 두께 ≥13 mm이 진단 기준.
          </div>
        )}
      </div>

      {/* 오답 복습 슬라이드업 카드 */}
      <div
        className={`transition-all duration-500 ease-out overflow-hidden ${
          showReview ? 'opacity-100 translate-y-0 max-h-48' : 'opacity-0 translate-y-4 max-h-0'
        }`}
      >
        <div className="bg-white rounded-2xl border border-[var(--color-border)] p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-2.5">
            <RotateCcw className="w-4 h-4 text-sage-600" />
            <span className="text-sm font-semibold text-sage-700">오답 기반 유사문제 자동 생성</span>
          </div>
          <p className="text-sm text-[var(--color-muted)] leading-relaxed">
            틀린 개념(이완기 기능 장애, 심낭 삼출 감별)에서 유사 난이도 문제 3개를 자동 생성합니다.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   기능 소개 카드
   ============================================================ */
interface FeatureCardProps {
  icon: ReactNode;
  title: string;
  desc: string;
  tag?: string;
}

function FeatureCard({ icon, title, desc, tag }: FeatureCardProps) {
  return (
    <div className="ll-feature border-t border-[var(--color-border)] py-6">
      <div className="inline-flex items-center justify-center mb-4 text-sage-600">
        {icon}
      </div>
      {tag && (
        <span className="inline-block text-xs font-semibold text-[var(--color-accent)] bg-[var(--color-accent-bg)] px-2.5 py-1 rounded-full mb-2.5">
          {tag}
        </span>
      )}
      <h3 className="text-lg font-bold text-sage-800 mb-2">{title}</h3>
      <p className="text-base text-[var(--color-muted)] leading-relaxed">{desc}</p>
    </div>
  );
}

/* ============================================================
   요금제 카드
   ============================================================ */
interface PlanCardProps {
  name: string;
  price: string;
  highlight?: boolean;
  features: string[];
}

function PlanCard({ name, price, highlight, features }: PlanCardProps) {
  return (
    <div
      className={`rounded-2xl border p-7 flex flex-col gap-5 ${
        highlight
          ? 'border-2 border-[var(--color-gold)] bg-white shadow-md'
          : 'border-[var(--color-border)] bg-white'
      }`}
    >
      {highlight && (
        <span className="self-start text-xs font-semibold text-[var(--color-text)] bg-[var(--color-gold)] px-2.5 py-1 rounded-full">
          인기
        </span>
      )}
      <div>
        <p className="text-sm font-semibold text-[var(--color-muted)] mb-1.5">{name}</p>
        <p className="text-3xl font-bold text-sage-800">
          {price}
          {price !== '문의' && (
            <span className="text-base font-normal text-[var(--color-muted)]">/월</span>
          )}
        </p>
      </div>
      <ul className="space-y-2.5 flex-1">
        {features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-sm text-sage-700">
            <Check className="w-4 h-4 mt-0.5 text-sage-600 shrink-0" strokeWidth={2.5} />
            {f}
          </li>
        ))}
      </ul>
      <Link
        href="/login"
        className={`inline-flex items-center justify-center h-12 px-5 rounded-lg text-sm font-semibold transition-colors ${
          highlight
            ? 'bg-[var(--color-gold)] text-[var(--color-text)] hover:bg-[var(--color-gold-dark)]'
            : 'border border-sage-600 text-sage-700 hover:bg-[var(--color-sage-100)]'
        }`}
      >
        시작하기
      </Link>
    </div>
  );
}

/* ============================================================
   Landing — 메인 컴포넌트
   ============================================================ */
export function Landing() {
  return (
    <div className="ll-landing min-h-screen" style={{ background: 'var(--color-bg)', fontFamily: 'var(--font-body)' }}>

      {/* ── 네비바 ── */}
      <header className="sticky top-0 z-50 bg-[var(--color-bg)]">
        <div className="max-w-6xl mx-auto px-6 h-18 flex items-center justify-between border-b border-[var(--color-border)]">
          <Link href="/" className="flex items-center gap-2 text-sage-700 font-bold text-xl">
            <Stethoscope className="w-6 h-6" strokeWidth={2.2} />
            렉처링크
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/login">
              <Button variant="ghost" size="sm">
                로그인
              </Button>
            </Link>
            <Link href="/login">
              <Button variant="accent" size="sm">
                1달 무료체험
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="relative px-6 py-20 md:py-28 overflow-hidden">
        <div className="relative z-10 max-w-6xl mx-auto">
          <div className="inline-flex items-center gap-2 text-sm font-semibold text-sage-700 mb-8">
            <Stethoscope className="w-4 h-4" />
            의료 교육 특화 AI 학습 인프라
          </div>

          <h1 className="text-[var(--text-display)] max-w-5xl font-bold text-sage-800 leading-[1.05] mb-8 tracking-[-0.045em]">
            우리 학교 시험 범위에 맞춘
            <br />
            <span className="text-sage-600">AI 의학 문제</span> 무한 생성
          </h1>

          <p className="text-lg sm:text-xl text-[var(--color-muted)] max-w-2xl mb-10 leading-relaxed">
            교수님 강의자료를 업로드하면 국시 스타일 문제를 즉시 생성.
            틀린 문제에서 유사 문제를 자동으로 만들어 반복 학습까지.
          </p>

          <div className="flex flex-col sm:flex-row items-start gap-3">
            <Link href="/login">
              <Button size="lg" variant="accent">1달 무료체험 시작하기</Button>
            </Link>
            <Link href="/login">
              <Button size="lg" variant="secondary">
                기능 살펴보기
              </Button>
            </Link>
          </div>

          <p className="text-sm text-[var(--color-muted)] mt-6">
            신용카드 없이 시작 · 언제든 해지 가능
          </p>
        </div>

        {/* 스크롤 힌트 */}
        <div className="hidden">
          <span className="text-sm">스크롤</span>
          <div className="w-px h-10 bg-[var(--color-border)] animate-pulse" />
        </div>
      </section>

      {/* ── 인터랙티브 데모 섹션 ── */}
      <section className="py-24 px-6 bg-[var(--color-sage-50)]">
        <div className="max-w-5xl mx-auto">
          <Reveal className="text-left mb-12 max-w-2xl">
            <span className="text-sm font-semibold text-[var(--color-accent)] uppercase tracking-widest">
              Live Demo
            </span>
            <h2 className="text-3xl sm:text-4xl font-bold text-sage-800 mt-4 mb-5">
              AI가 문제를 생성하는 순간
            </h2>
            <p className="text-lg text-[var(--color-muted)] max-w-lg">
              클릭 한 번 없이 — 지금 이 화면에서 실제로 동작합니다.
            </p>
          </Reveal>

          <Reveal delay={150}>
            <InteractiveDemo />
          </Reveal>
        </div>
      </section>

      {/* ── 기능 1: 국시 대비 ── */}
      <section className="py-24 px-6">
        <div className="max-w-5xl mx-auto grid md:grid-cols-2 gap-14 items-center">
          <Reveal>
            <span className="text-sm font-semibold text-sage-600 uppercase tracking-widest">
              01 · 국시 대비
            </span>
            <h2 className="text-3xl sm:text-4xl font-bold text-sage-800 mt-4 mb-5 leading-tight">
              KMLE 가이드라인 기반
              <br />
              학교별 시험 범위 필터
            </h2>
            <p className="text-lg text-[var(--color-muted)] leading-relaxed mb-7">
              한국의사국가시험 출제 기준과 각 의대의 커리큘럼 데이터를 결합해,
              내가 집중해야 할 영역만 골라 문제를 생성합니다.
              CBT 모드로 실전 감각까지 완성하세요.
            </p>
            <div className="flex flex-wrap gap-2.5">
              {['순환기', '호흡기', '내분비', '신장', '혈액'].map((t) => (
                <span
                  key={t}
                  className="text-sm font-medium text-sage-700 bg-[var(--color-sage-100)] px-3.5 py-1.5 rounded-full"
                >
                  {t}
                </span>
              ))}
            </div>
          </Reveal>

          <Reveal delay={100}>
            <div className="grid grid-cols-2 gap-4">
              <FeatureCard
                icon={<Stethoscope className="w-5 h-5 text-sage-600" />}
                title="KMLE 매핑"
                desc="국시 출제 빈도 기반 가중치 적용. 자주 나오는 개념 집중 훈련."
              />
              <FeatureCard
                icon={<Target className="w-5 h-5 text-sage-600" />}
                title="학교별 필터"
                desc="전국 40개 의대 커리큘럼 데이터베이스. 우리 학교 시험에 최적화."
              />
              <FeatureCard
                icon={<ClipboardCheck className="w-5 h-5 text-sage-600" />}
                title="CBT 시뮬레이션"
                desc="실제 국시와 동일한 인터페이스로 모의 시험 응시."
                tag="NEW"
              />
              <FeatureCard
                icon={<Timer className="w-5 h-5 text-sage-600" />}
                title="시간 분석"
                desc="문항별 소요 시간 추적. 취약 파트를 수치로 확인."
              />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── 기능 2: 내신 대비 ── */}
      <section className="py-24 px-6 bg-[var(--color-sage-50)]">
        <div className="max-w-5xl mx-auto grid md:grid-cols-2 gap-14 items-center">
          <Reveal delay={100} className="order-2 md:order-1">
            <div className="bg-white rounded-2xl border border-[var(--color-border)] p-7 shadow-sm">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-lg bg-[var(--color-sage-100)] flex items-center justify-center">
                  <Upload className="w-5 h-5 text-sage-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-sage-800">강의자료 업로드</p>
                  <p className="text-sm text-[var(--color-muted)]">PDF · PPT · DOCX · 이미지 지원</p>
                </div>
              </div>
              <div className="space-y-2.5">
                {['심장학 강의 8주차.pdf', '호흡기내과 슬라이드.pptx', 'ECG 판독 실습.pdf'].map(
                  (f, i) => (
                    <div
                      key={f}
                      className="flex items-center gap-2.5 bg-[var(--color-sage-50)] rounded-lg px-3.5 py-3"
                    >
                      <FileText className="w-4 h-4 text-sage-600 shrink-0" />
                      <span className="text-sm text-sage-700">{f}</span>
                      <span className="ml-auto text-xs text-[var(--color-curated)] font-semibold">
                        {i === 0 ? '분석 완료' : i === 1 ? '처리 중' : '대기'}
                      </span>
                    </div>
                  ),
                )}
              </div>
              <div className="mt-5 pt-5 border-t border-[var(--color-border)]">
                <p className="text-sm text-[var(--color-muted)]">
                  생성된 문제 <span className="font-bold text-sage-700">238개</span> ·
                  예상 시험 스타일 매핑 완료
                </p>
              </div>
            </div>
          </Reveal>

          <Reveal className="order-1 md:order-2">
            <span className="text-sm font-semibold text-sage-600 uppercase tracking-widest">
              02 · 내신 대비
            </span>
            <h2 className="text-3xl sm:text-4xl font-bold text-sage-800 mt-4 mb-5 leading-tight">
              교수님 자료 업로드,
              <br />
              시험 예상 문제 즉시 생성
            </h2>
            <p className="text-lg text-[var(--color-muted)] leading-relaxed">
              PDF 강의록, PPT 슬라이드, 손필기 스캔 이미지까지.
              AI가 교수님의 출제 스타일을 분석해 내신에 특화된 문제를 만들어드립니다.
            </p>
          </Reveal>
        </div>
      </section>

      {/* ── 기능 3·4: 오답 확장 + 이미지 ── */}
      <section className="py-24 px-6">
        <div className="max-w-5xl mx-auto">
          <Reveal className="text-left mb-12">
            <span className="text-sm font-semibold text-sage-600 uppercase tracking-widest">
              03 · 04
            </span>
            <h2 className="text-3xl sm:text-4xl font-bold text-sage-800 mt-4">
              무한 확장, 이미지까지
            </h2>
          </Reveal>

          <div className="grid sm:grid-cols-2 gap-6">
            <Reveal delay={0}>
              <FeatureCard
                icon={<RotateCcw className="w-5 h-5 text-sage-600" />}
                title="오답 기반 무한 확장"
                desc="틀린 문제의 핵심 개념에서 유사 문제를 자동 생성. 반복 학습으로 완전 정복."
                tag="핵심 기능"
              />
            </Reveal>
            <Reveal delay={80}>
              <FeatureCard
                icon={<InfinityIcon className="w-5 h-5 text-sage-600" />}
                title="무제한 문제 뱅크"
                desc="정해진 문제 수 제한 없이 개념이 이해될 때까지 새 문제를 계속 생성."
              />
            </Reveal>
            <Reveal delay={160}>
              <FeatureCard
                icon={<ImageIcon className="w-5 h-5 text-sage-600" />}
                title="의료 이미지 문항"
                desc="CT, X-ray, ECG, 병리 슬라이드 이미지를 포함한 실전형 이미지 문제 생성."
                tag="NEW"
              />
            </Reveal>
            <Reveal delay={240}>
              <FeatureCard
                icon={<Activity className="w-5 h-5 text-sage-600" />}
                title="파형·그래프 해석"
                desc="ECG 판독, 폐기능 검사, 혈압 그래프 등 복합 데이터 해석 문제까지."
              />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ── 요금제 섹션 ── */}
      <section className="py-24 px-6 bg-[var(--color-sage-50)]">
        <div className="max-w-5xl mx-auto">
          <Reveal className="text-left mb-4 max-w-2xl">
            <span className="text-sm font-semibold text-sage-600 uppercase tracking-widest">
              요금제
            </span>
            <h2 className="text-3xl sm:text-4xl font-bold text-sage-800 mt-4 mb-3">
              필요한 만큼만 선택
            </h2>
            <p className="text-lg text-[var(--color-muted)]">
              추가 크레딧 결제 시 문제 수 추가 가능
            </p>
          </Reveal>

          <Reveal delay={100}>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-5 mt-12">
              <PlanCard
                name="내신 대비"
                price="₩5,900"
                features={[
                  '강의자료 업로드 3개/월',
                  '문제 생성 200개/월',
                  '오답 리뷰',
                  '기본 CBT 모드',
                ]}
              />
              <PlanCard
                name="국가고시 대비"
                price="₩11,900"
                features={[
                  'KMLE 가이드라인 매핑',
                  '문제 생성 500개/월',
                  '학교별 범위 필터',
                  'CBT 시뮬레이션',
                ]}
              />
              <PlanCard
                name="통합형"
                price="₩19,900"
                highlight
                features={[
                  '내신 + 국시 모두 포함',
                  '문제 생성 1,500개/월',
                  '이미지 문항 포함',
                  '우선 지원',
                ]}
              />
              <PlanCard
                name="통합형 무제한"
                price="문의"
                features={[
                  '문제 생성 무제한',
                  '학교/병원 계정 관리',
                  '전용 모델 파인튜닝',
                  'API 연동',
                ]}
              />
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── 마지막 CTA ── */}
      <section className="py-24 px-6">
        <Reveal>
          <div className="max-w-5xl mx-auto border-y border-sage-700 bg-sage-800 px-6 py-16 text-left">
            <h2 className="text-3xl sm:text-4xl md:text-5xl font-bold text-white mb-5">
              지금 바로 시작하세요
            </h2>
            <p className="text-lg text-sage-200 mb-10 max-w-xl leading-relaxed">
              가입 후 1달 동안 모든 기능을 무료로 사용할 수 있습니다.
              신용카드 없이 이메일 하나면 충분합니다.
            </p>
            <Link href="/login">
              <Button size="lg" variant="accent">1달 무료체험 시작하기 →</Button>
            </Link>
          </div>
        </Reveal>
      </section>

      {/* ── 푸터 ── */}
      <footer className="border-t border-[var(--color-border)] py-10 px-6">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-5">
          <div className="flex items-center gap-2 text-sage-700 font-semibold text-base">
            <Stethoscope className="w-5 h-5" strokeWidth={2.2} />
            렉처링크 · 의료 교육 특화 AI 학습
          </div>
          <div className="flex items-center gap-5 text-sm text-[var(--color-muted)]">
            <a href="/faq" className="hover:text-sage-700 transition-colors">자주 묻는 질문</a>
            <a href="/terms" className="hover:text-sage-700 transition-colors">이용약관</a>
            <a href="/privacy" className="hover:text-sage-700 transition-colors">개인정보 처리방침</a>
          </div>
          <p className="text-sm text-[var(--color-muted)]">© 2026 렉처링크</p>
        </div>
      </footer>
    </div>
  );
}

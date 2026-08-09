'use client';

/**
 * 렉처링크 랜딩페이지
 *
 * 디자인 시스템: 기존 정적 랜딩(public/landing.html)의 크림·포레스트 그린 팔레트,
 * Pretendard(전역 globals.css 로드), 버튼·카드·배지 스타일을 그대로 사용한다.
 *   cream #FCFAF4 · cream-deep #F4F1E8 · forest #1F5C43/#194B37/#143C2C
 *   sage #EAF3ED/#DCEBE0/#A6C7B0 · gold #F3C64E/#D9A82F · ink #111827/#6B7280/#9AA1AC · line #E5E1D8
 *
 * 재사용한 기존 컴포넌트/에셋:
 *   - 01 강의자료 기반 섹션 + 문제 프리뷰(MockGenerated) + 커서 클릭 데모 애니메이션: public/landing.html
 *   - 후기 캐러셀, 요금제(4개 플랜 데이터 포함), 헤더/푸터: public/landing.html
 *   - CPX 스테이지: components/cpx/CpxPractice.jsx 진료 화면 + Avatar3D
 *     (public/cpx/models/patient_female.glb — 실제 CPX 실전 연습과 동일한 캐릭터)
 */

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  ClipboardCheck,
  FileText,
  GraduationCap,
  Menu,
  Quote,
  RotateCcw,
  Sparkles,
  Star,
  Stethoscope,
  Upload,
  X,
} from 'lucide-react';

// 실제 CPX 진료 화면(components/cpx/CpxPractice.jsx)이 사용하는 환자 아바타 렌더러를 그대로 재사용.
// /cpx/models/patient_female.glb 를 로드하며, CPX 실전 연습 화면과 동일한 캐릭터·idle/말하기 모션이다.
const Avatar3D = dynamic(() => import('@/components/cpx/Avatar3D'), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-sm font-bold text-[#DDECE4]">
      CPX 환자 모델을 불러오는 중
    </div>
  ),
});

/* ============================================================
   데이터
   ============================================================ */

// 문제 제기 — 새 기획 콘텐츠
const problems = [
  {
    number: '01',
    title: '우리 학교 시험에 꼭 맞는 문제를 만들기 어렵습니다.',
    description: '교수님의 강의자료와 기존 문제의 특성을 충분히 반영하기 어렵습니다.',
  },
  {
    number: '02',
    title: '의료 이미지가 포함된 문항을 만들기 어렵습니다.',
    description: '영상검사·병리·심전도 기반의 실제 시험형 문항 생성이 어렵습니다.',
  },
  {
    number: '03',
    title: '오답 복습은 결국 직접 해야 합니다.',
    description: '틀린 문제를 다시 모으고 유사문항까지 만드는 과정이 번거롭습니다.',
  },
  {
    number: '04',
    title: '범용 AI만으로는 CPX를 실전처럼 연습하기 어렵습니다.',
    description: '일관된 환자 역할과 음성 문진, 평가 기준에 따른 피드백을 한 번에 받기 어렵습니다.',
  },
];

// 후기 — 기존 랜딩(public/landing.html) 후기 데이터 그대로
const reviews = [
  { q: '강의록을 올리면 단원별로 문제가 정리돼서 시험 직전 복습이 훨씬 빨라졌어요.', who: '본과 2학년', tag: '순환기' },
  { q: '틀린 문제만 모아 비슷한 유형을 다시 풀 수 있어서 약한 개념을 집중적으로 메웠습니다.', who: '본과 3학년', tag: '호흡기' },
  { q: '출제 비중 분석을 보고 어떤 유형을 더 연습해야 할지 감이 잡혀서 공부 계획 세우기가 쉬워졌어요.', who: '본과 2학년', tag: '내분비' },
  { q: '오답노트가 자동으로 정리되니까 시험 전날 약한 개념만 빠르게 훑어볼 수 있었습니다.', who: '본과 3학년', tag: '소화기' },
];

// 요금제 — 기존 랜딩(public/landing.html) 요금제 데이터 그대로
interface Plan {
  name: string;
  price: string;
  sub: string;
  feats: string[];
  primary?: boolean;
  badge?: string;
}
const plans: Plan[] = [
  {
    name: '자료 생성 전용',
    price: '7,900',
    sub: '학교 시험 대비',
    feats: ['강의자료 업로드 월 50시간', '월 500문항 생성', '기본 해설 + 오답노트', '유사문제 자동 생성'],
  },
  {
    name: '국가고시형 전용',
    price: '9,900',
    sub: '국시 대비',
    feats: ['국가고시형 문제풀이 무제한', '오답 기반 500문항 생성', '심화 해설 + 개념 연결', '주간 학습 리포트'],
  },
  {
    name: '통합형',
    price: '14,900',
    sub: '학교 시험 + 국시 통합',
    feats: ['자료 기반 + 국가고시형 모두 사용', '월 2,000문항 생성 / 200시간 업로드', '자료 기반 + 국시형 오답 통합 보기', '이미지 문제 적용'],
    primary: true,
    badge: '추천',
  },
  {
    name: '통합형 무제한',
    price: '20,900',
    sub: '고학년 · 집중 학습자',
    feats: ['자료 업로드 · 문항 생성 무제한', '우선 처리 및 빠른 분석', '이미지 문제 무제한', '다양한 문제 유형 이용'],
  },
];

/* ============================================================
   공용 스타일 문자열 — 기존 랜딩의 버튼/그림자
   ============================================================ */
const SHADOW_CARD = 'shadow-[0_1px_3px_rgba(17,24,39,0.04),0_4px_16px_-10px_rgba(17,24,39,0.10)]';
const SHADOW_SOFT = 'shadow-[0_1px_2px_rgba(17,24,39,0.03)]';
const SHADOW_LIFT = 'shadow-[0_8px_28px_-16px_rgba(17,24,39,0.16)]';
const BTN_PRIMARY =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-[#1F5C43] px-5 h-11 text-[14.5px] font-bold text-white transition hover:bg-[#194B37] active:scale-[.98]';
const BTN_GHOST =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-white px-5 h-11 text-[14.5px] font-bold text-[#111827] ring-1 ring-[#E5E1D8] transition hover:bg-[#F4F1E8] active:scale-[.98]';

/* ============================================================
   스크롤 등장 애니메이션 — 기존 랜딩과 동일한 규칙
   (IntersectionObserver 1회 재생 후 unobserve · prefers-reduced-motion 제거
    · 이동 8~14px · 450~650ms · 등장 후 유지)
   ============================================================ */
function ScrollReveal({
  children,
  delay = 0,
  fromX = 0,
}: {
  children: ReactNode;
  delay?: number;
  fromX?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hasAnimated = useRef(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let animation: Animation | null = null;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || hasAnimated.current) return;
        hasAnimated.current = true;

        // 모바일에서는 이동 거리를 줄이고 좌우 이동 없이 fade-up만 적용
        const mobile = window.matchMedia('(max-width: 767px)').matches;
        const dx = mobile ? 0 : fromX;
        const dy = mobile ? 8 : fromX !== 0 ? 0 : 12;
        animation = element.animate(
          [
            { opacity: 0, transform: `translate(${dx}px, ${dy}px)` },
            { opacity: 1, transform: 'translate(0, 0)' },
          ],
          { duration: 520, delay, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' },
        );
        observer.unobserve(element);
      },
      { threshold: 0.12 },
    );

    observer.observe(element);
    return () => {
      observer.disconnect();
      animation?.cancel();
    };
  }, [delay, fromX]);

  return <div ref={ref}>{children}</div>;
}

// 프리뷰 데모(커서 클릭·진행 바)를 화면 진입 시 1회 재생시키는 래퍼 — 기존 랜딩의 ll-play 방식
function PlayOnView({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [play, setPlay] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setPlay(true);
          observer.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={play ? 'll-play' : undefined}>
      {children}
    </div>
  );
}

/* ============================================================
   공용 아톰 — 기존 랜딩(public/landing.html)의 Badge/Bullet/SectionHeading
   ============================================================ */
function Badge({ children, tone = 'sage' }: { children: ReactNode; tone?: 'sage' | 'gold' | 'line' }) {
  const tones = {
    sage: 'bg-[#EAF3ED] text-[#1F5C43]',
    gold: 'bg-[#FBF1D4] text-[#9A7B16]',
    line: 'bg-white text-[#6B7280] ring-1 ring-[#E5E1D8]',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] font-bold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2.5">
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-[#1F5C43]" strokeWidth={2.4} />
      <span className="text-[14.5px] leading-relaxed text-[#6B7280]">{children}</span>
    </li>
  );
}

function SectionHeading({
  badge,
  title,
  desc,
  center = true,
}: {
  badge?: ReactNode;
  title: string;
  desc?: string;
  center?: boolean;
}) {
  return (
    <div className={`max-w-xl [word-break:keep-all] ${center ? 'mx-auto text-center' : ''}`}>
      {badge}
      <h2 className={`${badge ? 'mt-3.5' : ''} whitespace-pre-line text-[clamp(24px,3vw,32px)] font-extrabold leading-[1.3] tracking-tight text-[#111827]`}>
        {title}
      </h2>
      {desc && <p className="mt-3.5 whitespace-pre-line text-[15px] leading-relaxed text-[#6B7280]">{desc}</p>}
    </div>
  );
}

/* ============================================================
   헤더 — 기존 랜딩 헤더(로고·내비·모바일 메뉴) 구조 그대로
   ============================================================ */
const NAV_LINKS = [
  { id: 'features', label: '기능 소개' },
  { id: 'how', label: '활용 방법' },
  { id: 'pricing', label: '요금 안내' },
  { id: 'reviews', label: '고객 후기' },
];

function Logo({ light = false }: { light?: boolean }) {
  return (
    <span className="flex select-none items-center gap-2.5">
      <span className={`grid h-9 w-9 place-items-center rounded-xl shadow-sm ${light ? 'bg-white/15' : 'bg-[#1F5C43]'}`}>
        <BookOpen className="h-[19px] w-[19px] text-white" strokeWidth={1.9} />
      </span>
      <span className={`text-[20px] font-extrabold tracking-tight ${light ? 'text-white' : 'text-[#111827]'}`}>렉처링크</span>
    </span>
  );
}

function Header() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-50 border-b border-[#E5E1D8] bg-[#FCFAF4]/90 backdrop-blur-md">
      <div className="mx-auto flex h-[60px] max-w-[1140px] items-center justify-between px-5 sm:px-8">
        <a href="#top" aria-label="렉처링크 홈">
          <Logo />
        </a>
        <nav className="hidden items-center gap-1 md:flex" aria-label="주요 메뉴">
          {NAV_LINKS.map((l) => (
            <a
              key={l.id}
              href={`#${l.id}`}
              className="whitespace-nowrap rounded-lg px-3 py-2 text-[14.5px] font-semibold text-[#6B7280] transition hover:text-[#1F5C43]"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="hidden items-center gap-3 md:flex">
          <Link href="/login" className="text-[14.5px] font-semibold text-[#6B7280] transition hover:text-[#111827]">
            로그인
          </Link>
          <Link href="/login" className={`${BTN_PRIMARY} h-10 px-4 text-[14px]`}>
            1달 무료체험
          </Link>
        </div>
        <button
          type="button"
          className="grid h-10 w-10 place-items-center rounded-lg text-[#111827] md:hidden"
          onClick={() => setOpen((o) => !o)}
          aria-label="메뉴"
          aria-expanded={open}
        >
          {open ? <X className="h-[22px] w-[22px]" /> : <Menu className="h-[22px] w-[22px]" />}
        </button>
      </div>
      {open && (
        <div className="border-t border-[#E5E1D8] bg-[#FCFAF4] px-5 py-3 md:hidden">
          <nav className="flex flex-col" aria-label="모바일 메뉴">
            {NAV_LINKS.map((l) => (
              <a
                key={l.id}
                href={`#${l.id}`}
                onClick={() => setOpen(false)}
                className="rounded-lg px-3 py-3 text-[15px] font-semibold text-[#6B7280] hover:bg-[#EAF3ED]"
              >
                {l.label}
              </a>
            ))}
          </nav>
          <div className="mt-2 flex gap-2">
            <Link href="/login" className={`${BTN_GHOST} h-11 flex-1`}>
              로그인
            </Link>
            <Link href="/login" className={`${BTN_PRIMARY} h-11 flex-1`}>
              1달 무료체험
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

/* ============================================================
   01 내신 대비 — 기존 랜딩 "강의자료 기반" 문제 프리뷰(MockGenerated) 그대로
   + 기존 커서 클릭 데모 애니메이션(ll-answer-demo)
   ============================================================ */
function MockGenerated() {
  const opts = ['대동맥판협착증', '승모판협착증', '비후성 심근병증', '삼첨판폐쇄부전', '폐동맥판협착증'];
  return (
    <div className={`ll-answer-demo relative rounded-2xl bg-white p-5 ring-1 ring-[#E5E1D8] ${SHADOW_CARD}`}>
      <div className="flex items-center justify-between border-b border-[#E5E1D8] pb-3">
        <div className="flex items-center gap-1.5 text-[12px] font-semibold text-[#1F5C43]">
          <span className="rounded-md bg-[#EAF3ED] px-2 py-0.5">순환기</span>
          <span className="rounded-md bg-[#EAF3ED] px-2 py-0.5">판막질환</span>
        </div>
        <span className="text-[12px] font-semibold text-[#9AA1AC]">난이도 중상</span>
      </div>
      <p className="mt-4 text-[14px] font-bold leading-relaxed text-[#111827]">
        Q. 운동 시 흉통·실신을 호소하는 68세 환자에서 우상흉골연 수축기 박출성 잡음이 들린다. 가장 가능성이 높은
        진단은?
      </p>
      <div className="mt-3.5 space-y-1.5">
        {opts.map((o, i) => (
          <div
            key={o}
            className={`ll-option flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] text-[#6B7280] ${
              i === 0 ? 'll-correct-target' : ''
            } ${i === 1 ? 'll-picked-target' : ''}`}
          >
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#F4F1E8] text-[11px] font-bold text-[#9AA1AC]">
              {String.fromCharCode(65 + i)}
            </span>
            {o}
            {i === 0 && <Check className="ml-auto h-[15px] w-[15px] shrink-0 text-[#1F5C43]" strokeWidth={2.6} />}
          </div>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5 border-t border-[#E5E1D8] pt-3.5">
        {['대동맥판협착증', '수축기잡음', '실신감별'].map((t) => (
          <span key={t} className="rounded-md bg-[#F4F1E8] px-2 py-1 text-[11.5px] font-medium text-[#6B7280]">
            #{t}
          </span>
        ))}
      </div>
      {/* 기존 랜딩의 데모 커서 — 오답 클릭 → 정답 표시 시퀀스 */}
      <div className="ll-demo-cursor" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none">
          <path
            d="M7 4.8 24.8 18l-8.1 1.4 4.1 7.1-3.8 2.1-4.1-7.2-5.4 6.1L7 4.8Z"
            fill="white"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}

/* ============================================================
   02 CPX 실전 연습 — 실제 진료 화면(components/cpx/CpxPractice.jsx) 구성 축약
   + 실제 CPX 캐릭터(Avatar3D · patient_female.glb)
   ============================================================ */
function CpxPreview() {
  return (
    <div className={`overflow-hidden rounded-2xl bg-white ring-1 ring-[#E5E1D8] ${SHADOW_CARD}`}>
      {/* 스테이지 — 실제 CPX 진료 화면과 동일한 배경(#143C2C)과 오버레이 배치 */}
      <div className="relative min-h-[340px] bg-[#143C2C]">
        <div className="absolute left-4 top-4 z-10 rounded-lg bg-black/20 px-3 py-2 text-white">
          <div className="text-xs text-white/70">주소증</div>
          <div className="font-bold">소화불량/만성복통</div>
        </div>
        <div className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-sm font-bold text-white">
          {/* 실제 CPX 화면의 음성 웨이브 표시(gold 이퀄라이저) */}
          <span className="flex h-7 items-center gap-1" aria-label="음성 연결 중">
            {Array.from({ length: 9 }, (_, i) => (
              <span
                key={i}
                className="cpx-wave h-2 w-1 rounded-full bg-[#F3C64E]"
                style={{ animationDelay: `${i * 85}ms` }}
              />
            ))}
          </span>
          음성 대화 중
        </div>
        <div className="absolute bottom-4 left-4 z-10 rounded-full bg-white/10 px-3 py-1.5 text-[12px] font-bold text-white/85 ring-1 ring-white/15">
          종료 후 피드백 제공
        </div>
        <div className="h-[340px]">
          <Avatar3D gender="여성" age={48} speaking audioLevel={0.08} pose="sitting" category="소화불량/만성복통" />
        </div>
      </div>
      {/* 최근 대화 — 실제 화면과 동일하게 캐릭터 아래 배치(캐릭터를 가리지 않음) */}
      <div className="space-y-2 border-t border-[#E5E1D8] bg-white p-4">
        <div className="text-left">
          <span className="inline-block max-w-[88%] rounded-lg bg-[#E9F2EC] px-3 py-2 text-sm text-[#18241E]">
            두 달째 배가 고플 때와 새벽에 명치가 쓰려요.
          </span>
        </div>
        <div className="text-right">
          <span className="inline-block max-w-[88%] rounded-lg bg-[#1F5C43] px-3 py-2 text-sm text-white">
            통증이 식사와 어떤 관계가 있는지 조금 더 말씀해 주시겠어요?
          </span>
        </div>
        <p className="pt-1 text-center text-[11px] text-[#6B7280]">
          실제 시험처럼 최근 대화만 표시됩니다 · 전체 기록은 채점에 반영됩니다
        </p>
      </div>
    </div>
  );
}

/* ============================================================
   기능 소개 행 — 기존 랜딩 FeatureRow 레이아웃 그대로
   (데스크톱: 텍스트/프리뷰 좌우 배치, flip 시 반전 · 모바일: 텍스트 → 프리뷰 순)
   ============================================================ */
function FeatureRow({
  index,
  badge,
  title,
  desc,
  bullets,
  visual,
  flip = false,
}: {
  index: string;
  badge: string;
  title: string;
  desc: string;
  bullets: string[];
  visual: ReactNode;
  flip?: boolean;
}) {
  return (
    <div className="mx-auto grid max-w-[1140px] items-center gap-10 px-5 py-12 sm:px-8 lg:grid-cols-2 lg:gap-14 lg:py-14">
      <div className={flip ? 'lg:order-2' : ''}>
        <ScrollReveal fromX={flip ? 14 : -14}>
          <div className="flex items-center gap-2.5">
            <span className="text-[13px] font-bold tabular-nums text-[#1F5C43]">{index}</span>
            <span className="h-4 w-px bg-[#E5E1D8]" />
            <span className="text-[13px] font-semibold text-[#6B7280]">{badge}</span>
          </div>
          <h3 className="mt-3 whitespace-pre-line text-[clamp(21px,2.6vw,28px)] font-extrabold leading-[1.3] tracking-tight text-[#111827] [word-break:keep-all]">
            {title}
          </h3>
          <p className="mt-3.5 text-[15px] leading-relaxed text-[#6B7280] [word-break:keep-all]">{desc}</p>
          <ul className="mt-5 space-y-2.5">
            {bullets.map((b) => (
              <Bullet key={b}>{b}</Bullet>
            ))}
          </ul>
        </ScrollReveal>
      </div>
      <div className={flip ? 'lg:order-1' : ''}>
        <ScrollReveal delay={90} fromX={flip ? -14 : 14}>
          <div className="mx-auto w-full max-w-[480px]">{visual}</div>
        </ScrollReveal>
      </div>
    </div>
  );
}

/* ============================================================
   이용 방법 스텝 카드 — 기존 랜딩 Flow 카드 스타일 그대로
   ============================================================ */
function StepCard({ n, icon, title, desc }: { n: string; icon: ReactNode; title: string; desc: string }) {
  return (
    <article className="rounded-2xl bg-white p-5 ring-1 ring-[#E5E1D8] transition hover:-translate-y-0.5 hover:shadow-[0_1px_3px_rgba(17,24,39,0.04),0_4px_16px_-10px_rgba(17,24,39,0.10)]">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#EAF3ED] text-[#1F5C43] [&>svg]:h-[19px] [&>svg]:w-[19px]">
          {icon}
        </span>
        <span className="text-[12px] font-bold tabular-nums text-[#9AA1AC]">STEP {n}</span>
      </div>
      <h4 className="mt-4 text-[16px] font-bold text-[#111827]">{title}</h4>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-[#6B7280]">{desc}</p>
    </article>
  );
}

/* ============================================================
   후기 캐러셀 — 기존 랜딩 Reviews 컴포넌트·데이터·동작 그대로
   ============================================================ */
function Reviews() {
  const [idx, setIdx] = useState(2);
  const CARD = 380;
  const GAP = 20;
  const STRIDE = CARD + GAP;
  const clampIdx = (n: number) => Math.max(0, Math.min(reviews.length - 1, n));

  return (
    <section id="reviews" className="scroll-mt-16 overflow-hidden border-t border-[#E5E1D8] py-16 sm:py-20">
      <div className="mx-auto max-w-[1140px] px-5 sm:px-8">
        <SectionHeading
          badge={
            <Badge tone="line">
              <Quote className="h-[13px] w-[13px] text-[#1F5C43]" /> 고객 후기
            </Badge>
          }
          title="먼저 사용한 의대생들의 이야기"
        />
      </div>
      <div className="relative mt-12">
        <div
          className="flex transition-transform duration-500 ease-out"
          style={{ transform: `translateX(calc(50% - ${idx * STRIDE + CARD / 2}px))`, gap: `${GAP}px` }}
        >
          {reviews.map((it, i) => {
            const active = i === idx;
            return (
              <div
                key={i}
                onClick={() => setIdx(i)}
                className={`shrink-0 cursor-pointer rounded-2xl bg-white ring-1 transition-all duration-500 ${
                  active ? `ring-[#E5E1D8] ${SHADOW_CARD} p-8` : 'ring-[#E5E1D8]/70 p-6 opacity-45 hover:opacity-70'
                }`}
                style={{ width: CARD, transform: active ? 'scale(1.06)' : 'scale(0.82)' }}
              >
                <div className="flex gap-0.5">
                  {[0, 1, 2, 3, 4].map((s) => (
                    <Star
                      key={s}
                      className={`fill-current text-[#F3C64E] ${active ? 'h-[18px] w-[18px]' : 'h-[13px] w-[13px]'}`}
                      strokeWidth={0}
                    />
                  ))}
                </div>
                <p className={`mt-4 font-medium leading-relaxed text-[#111827] ${active ? 'text-[18px]' : 'text-[13.5px]'}`}>
                  “{it.q}”
                </p>
                <div className="mt-5 flex items-center gap-2">
                  <span className={`font-semibold text-[#6B7280] ${active ? 'text-[14px]' : 'text-[12.5px]'}`}>
                    {it.who}
                  </span>
                  <span className="rounded-md bg-[#EAF3ED] px-2 py-0.5 text-[11.5px] font-semibold text-[#1F5C43]">
                    {it.tag}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setIdx((i) => clampIdx(i - 1))}
          disabled={idx === 0}
          className={`absolute left-4 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-white ring-1 ring-[#E5E1D8] text-[#111827] ${SHADOW_SOFT} transition hover:bg-[#F4F1E8] disabled:opacity-0 sm:left-8`}
          aria-label="이전 후기"
        >
          <ArrowRight className="h-[18px] w-[18px] rotate-180" />
        </button>
        <button
          type="button"
          onClick={() => setIdx((i) => clampIdx(i + 1))}
          disabled={idx === reviews.length - 1}
          className={`absolute right-4 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-white ring-1 ring-[#E5E1D8] text-[#111827] ${SHADOW_SOFT} transition hover:bg-[#F4F1E8] disabled:opacity-0 sm:right-8`}
          aria-label="다음 후기"
        >
          <ArrowRight className="h-[18px] w-[18px]" />
        </button>
        <div className="mt-10 flex items-center justify-center gap-1.5">
          {reviews.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIdx(i)}
              aria-label={`후기 ${i + 1}`}
              className={`h-1.5 rounded-full transition-all ${i === idx ? 'w-5 bg-[#1F5C43]' : 'w-1.5 bg-[#E5E1D8]'}`}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ============================================================
   요금제 카드 — 기존 랜딩 Pricing 컴포넌트·데이터 그대로
   ============================================================ */
function PlanCard({ name, price, sub, feats, primary = false, badge }: Plan) {
  return (
    <div
      className={`relative flex flex-col rounded-2xl p-6 transition-[transform,box-shadow] duration-200 hover:-translate-y-[2px] ${
        primary
          ? `bg-[#143C2C] text-white ring-1 ring-[#143C2C] ${SHADOW_LIFT}`
          : 'bg-white text-[#111827] ring-1 ring-[#E5E1D8] hover:shadow-[0_1px_3px_rgba(17,24,39,0.04),0_4px_16px_-10px_rgba(17,24,39,0.10)]'
      }`}
    >
      {badge && (
        <span className="absolute -top-2.5 right-5 rounded-full bg-[#F3C64E] px-2.5 py-0.5 text-[11.5px] font-bold text-[#143C2C]">
          {badge}
        </span>
      )}
      <div className={`text-[14.5px] font-bold ${primary ? 'text-white' : 'text-[#111827]'}`}>{name}</div>
      <div className={`mt-1 text-[12.5px] ${primary ? 'text-white/60' : 'text-[#9AA1AC]'}`}>{sub}</div>
      <div className="mt-4 flex items-baseline gap-1">
        <span className="text-[26px] font-extrabold tracking-tight">{price}</span>
        <span className={`text-[12.5px] ${primary ? 'text-white/60' : 'text-[#9AA1AC]'}`}>원 / 월</span>
      </div>
      <ul className="mt-4 flex-1 space-y-2">
        {feats.map((f) => (
          <li key={f} className="flex items-start gap-2 text-[13px]">
            <Check className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${primary ? 'text-[#F3C64E]' : 'text-[#1F5C43]'}`} strokeWidth={2.4} />
            <span className={primary ? 'text-white/85' : 'text-[#6B7280]'}>{f}</span>
          </li>
        ))}
      </ul>
      <Link
        href="/login"
        className={`mt-6 grid h-11 place-items-center rounded-xl text-[14px] font-bold transition active:scale-[.98] ${
          primary ? 'bg-[#F3C64E] text-[#143C2C] hover:bg-[#D9A82F]' : 'bg-[#F4F1E8] text-[#111827] hover:bg-[#EAF3ED]'
        }`}
      >
        시작하기
      </Link>
    </div>
  );
}

/* ============================================================
   Landing — 메인
   ============================================================ */
export function Landing() {
  return (
    <div className="ll-land min-h-screen overflow-x-hidden bg-[#FCFAF4] text-[#111827]">
      {/* 기존 랜딩의 프리뷰 데모 애니메이션(커서 클릭·진행 바·음성 웨이브) — 스코프 유지 */}
      <style>{`
        /* 히어로 인트로 타임라인 — 잇(0.45s) → 선(0.85s~) → 다(1.8s) → 0.5s 정지 →
           하단 워드마크(2.55s) → CTA → 안내문구 */
        .ll-land .llh-1{animation:llh-fade .45s ease-out both}
        .ll-land .llh-2{animation:llh-rise .3s cubic-bezier(.22,1,.36,1) .45s both}
        .ll-land .llh-line{transform-origin:left center;animation:llh-draw .95s cubic-bezier(.4,0,.2,1) .85s both}
        .ll-land .llh-3{animation:llh-rise .25s cubic-bezier(.22,1,.36,1) 1.8s both}
        .ll-land .llh-4{animation:llh-wordmark .75s cubic-bezier(.22,1,.36,1) 2.55s both}
        .ll-land .llh-5{animation:llh-rise .4s cubic-bezier(.22,1,.36,1) 3.5s both}
        .ll-land .llh-6{animation:llh-rise .4s cubic-bezier(.22,1,.36,1) 3.68s both}
        .ll-land .llh-7{animation:llh-fade .35s ease-out 3.85s both}
        @keyframes llh-fade{from{opacity:0}to{opacity:1}}
        @keyframes llh-rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
        @keyframes llh-wordmark{from{opacity:0;transform:translateY(.13em)}to{opacity:1;transform:translateY(0)}}
        @keyframes llh-draw{from{transform:scaleX(0)}to{transform:scaleX(1)}}
        .ll-land .ll-option{background:#fff;box-shadow:inset 0 0 0 1px #E5E1D8;transition:background-color .38s ease,color .38s ease,box-shadow .38s ease,transform .38s ease}
        .ll-land .ll-correct-target svg{opacity:0;transform:scale(.7)}
        .ll-land .ll-demo-cursor{position:absolute;left:63%;top:53%;z-index:4;width:34px;height:34px;color:#143C2C;filter:drop-shadow(0 10px 16px rgba(17,24,39,.20));opacity:0;pointer-events:none}
        .ll-land .ll-play .ll-demo-cursor{animation:ll-cursor-click 2.35s cubic-bezier(.22,1,.36,1) .55s both}
        .ll-land .ll-play .ll-picked-target{animation:ll-picked-answer 2.25s ease .95s both}
        .ll-land .ll-play .ll-correct-target{animation:ll-correct-answer 1.2s ease 1.8s both}
        .ll-land .ll-play .ll-picked-target>span:first-child{animation:ll-picked-badge 2.25s ease .95s both}
        .ll-land .ll-play .ll-correct-target>span:first-child{animation:ll-correct-badge 1.2s ease 1.8s both}
        .ll-land .ll-play .ll-correct-target svg{animation:ll-check-pop .48s ease 2.08s both}
        .ll-land .cpx-wave{animation:ll-wave 1.05s ease-in-out infinite;transform-origin:center}
        @keyframes ll-cursor-click{0%{opacity:0;transform:translate(-42px,-36px) rotate(-10deg) scale(.94)}24%{opacity:1}54%{opacity:1;transform:translate(0,0) rotate(-10deg) scale(1)}65%{opacity:1;transform:translate(0,0) rotate(-10deg) scale(.88)}76%{opacity:1;transform:translate(0,0) rotate(-10deg) scale(1)}100%{opacity:0;transform:translate(12px,10px) rotate(-10deg) scale(1)}}
        @keyframes ll-picked-answer{0%,28%{background:#fff;color:#6B7280;box-shadow:inset 0 0 0 1px #E5E1D8;transform:scale(1)}44%,100%{background:#FFF0E9;color:#B95035;box-shadow:inset 0 0 0 1px rgba(185,80,53,.26);transform:scale(1.012)}}
        @keyframes ll-correct-answer{0%{background:#fff;color:#6B7280;box-shadow:inset 0 0 0 1px #E5E1D8;transform:scale(1)}100%{background:#EAF3ED;color:#1F5C43;box-shadow:inset 0 0 0 1px rgba(31,92,67,.16);transform:scale(1.012)}}
        @keyframes ll-picked-badge{0%,28%{background:#F4F1E8;color:#9AA1AC}44%,100%{background:#B95035;color:#fff}}
        @keyframes ll-correct-badge{0%{background:#F4F1E8;color:#9AA1AC}100%{background:#1F5C43;color:#fff}}
        @keyframes ll-check-pop{0%{opacity:0;transform:scale(.7)}70%{opacity:1;transform:scale(1.12)}100%{opacity:1;transform:scale(1)}}
        @keyframes ll-wave{0%,100%{transform:scaleY(.45)}50%{transform:scaleY(1)}}
        @media (prefers-reduced-motion: reduce){
          .ll-land .llh-1,.ll-land .llh-2,.ll-land .llh-3,.ll-land .llh-4,.ll-land .llh-5,.ll-land .llh-6,.ll-land .llh-7,.ll-land .llh-line{animation:none !important}
          .ll-land .ll-demo-cursor{display:none}
          .ll-land .ll-play .ll-picked-target,.ll-land .ll-play .ll-correct-target,.ll-land .ll-play .ll-picked-target>span:first-child,.ll-land .ll-play .ll-correct-target>span:first-child,.ll-land .ll-play .ll-correct-target svg,.ll-land .cpx-wave{animation:none !important}
          .ll-land .ll-correct-target{background:#EAF3ED;color:#1F5C43;box-shadow:inset 0 0 0 1px rgba(31,92,67,.16)}
          .ll-land .ll-correct-target>span:first-child{background:#1F5C43;color:#fff}
          .ll-land .ll-correct-target svg{opacity:1;transform:none}
        }
      `}</style>

      <Header />

      <main>
        {/* ── 히어로 — 그린 필드 위에 현재 내비게이션과 "잇—다"를 남긴 브랜드 인트로 ── */}
        <section
          id="top"
          className="relative isolate flex min-h-[calc(100svh-60px)] scroll-mt-16 overflow-hidden bg-[#07563A] px-5 sm:px-8"
        >
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_16%_76%,rgba(28,126,85,.42),transparent_31%),radial-gradient(circle_at_76%_10%,rgba(255,255,255,.08),transparent_26%),linear-gradient(118deg,#063F2D_0%,#07563A_52%,#06452F_100%)]" />
          <div aria-hidden="true" className="pointer-events-none absolute -right-[12%] top-[10%] h-[38vw] w-[38vw] rounded-full border border-white/[0.07]" />
          <div aria-hidden="true" className="pointer-events-none absolute -right-[3%] top-[19%] h-[22vw] w-[22vw] rounded-full border border-white/[0.06]" />

          <div className="relative z-10 mx-auto flex w-full max-w-[1140px] items-center pb-[clamp(3rem,8vw,7rem)] pt-16 sm:pt-20 [word-break:keep-all]">
            <div className="max-w-[790px]">
              <h1 aria-label="의대 공부의 흐름을 잇다 — 렉처링크" className="font-extrabold tracking-tight text-white">
                <span className="llh-1 block text-[clamp(26px,3vw,42px)] leading-[1.25]">의대 공부의 흐름을</span>
                <span className="mt-[0.1em] flex items-center gap-[0.14em] text-[clamp(68px,9vw,140px)] leading-[.98]" aria-hidden="true">
                  <span className="llh-2 shrink-0">잇</span>
                  {/* 잇의 받침에서 다의 ㅏ로 이어지는 선 */}
                  <span className="min-w-[1.8em] flex-1 translate-y-[0.06em]">
                    <span className="llh-line block h-[0.075em] w-full rounded-full bg-white" />
                  </span>
                  <span className="llh-3 shrink-0">다</span>
                </span>
              </h1>

              <div className="mt-10 flex flex-wrap gap-3 sm:mt-12">
                <Link
                  href="/login"
                  className="llh-5 group inline-flex h-[54px] items-center justify-center gap-2 rounded-xl bg-white px-6 text-[16px] font-bold text-[#07563A] shadow-[0_12px_28px_rgba(0,0,0,.16)] transition hover:bg-[#EAF3ED] active:scale-[.98]"
                >
                  1달 무료체험 시작하기
                  <ArrowRight className="h-[18px] w-[18px] transition-transform group-hover:translate-x-0.5" />
                </Link>
                <a
                  href="#features"
                  className="llh-6 inline-flex h-[54px] items-center justify-center gap-2 rounded-xl bg-white/[0.08] px-6 text-[16px] font-bold text-white ring-1 ring-inset ring-white/50 transition hover:bg-white/[0.16] active:scale-[.98]"
                >
                  기능 살펴보기
                </a>
              </div>
              <p className="llh-7 mt-5 text-[13px] font-semibold text-white/65">카드 등록 없이 시작 · 첫 한 달 무료</p>
            </div>
          </div>

          <p
            aria-hidden="true"
            className="llh-4 pointer-events-none absolute inset-x-0 bottom-16 z-0 whitespace-nowrap text-center text-[clamp(58px,14.5vw,280px)] font-black leading-[0.78] tracking-[-0.04em] text-white/[0.96] sm:bottom-[-0.075em]"
          >
            LECTURELINK
          </p>
        </section>

        {/* ── 문제 공감 — 기존 히어로 카피 (매번 ChatGPT로…) ── */}
        <section className="px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-[860px] text-center [word-break:keep-all]">
            <ScrollReveal>
              <Badge tone="sage">
                <Stethoscope className="h-[13px] w-[13px]" /> 의대생을 위한 통합 학습 플랫폼
              </Badge>
            </ScrollReveal>
            <ScrollReveal delay={70}>
              <h2 className="mt-5 text-[clamp(26px,3.6vw,40px)] font-extrabold leading-[1.3] tracking-tight text-[#111827]">
                매번 ChatGPT로 내신 문제 만들기,
                <br />
                <span className="text-[#1F5C43]">힘들지 않았나요?</span>
              </h2>
            </ScrollReveal>
            <ScrollReveal delay={140}>
              <p className="mx-auto mt-5 max-w-xl text-[16px] leading-relaxed text-[#6B7280]">
                강의자료를 다시 설명하고, 원하는 문제가 나올 때까지 수정하고,
                <br className="hidden sm:block" /> 문제를 풀고 나면 오답은 또 직접 정리해야 했으니까요.
              </p>
            </ScrollReveal>
            <ScrollReveal delay={210}>
              <p className="mx-auto mt-4 text-[18px] font-extrabold leading-relaxed tracking-tight text-[#1F5C43] sm:text-[20px]">
                내신 대비부터 CPX까지
                <br />
                렉처링크로 준비하세요.
              </p>
            </ScrollReveal>
          </div>
        </section>

        {/* ── 문제 제기 — 새 기획 콘텐츠 ── */}
        <section id="why" className="scroll-mt-16 border-y border-[#E5E1D8] bg-white px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto grid max-w-[1140px] gap-10 lg:grid-cols-[.9fr_1.1fr] lg:gap-14">
            <div className="[word-break:keep-all]">
              <ScrollReveal>
                <Badge tone="line">
                  <Sparkles className="h-[13px] w-[13px] text-[#1F5C43]" /> 왜 렉처링크인가요
                </Badge>
              </ScrollReveal>
              <ScrollReveal delay={70}>
                <h2 className="mt-4 text-[clamp(24px,3vw,32px)] font-extrabold leading-[1.35] tracking-tight text-[#1F5C43]">
                  의대생의,
                  <br />
                  의대생에 의한,
                  <br />
                  의대생을 위한 학습 플랫폼.
                </h2>
              </ScrollReveal>
              <ScrollReveal delay={140}>
                <p className="mt-4 text-[15px] leading-relaxed text-[#6B7280]">직접 겪었던 불편에서 시작했습니다.</p>
              </ScrollReveal>
            </div>
            <div>
              <ScrollReveal delay={70}>
                <h3 className="text-[clamp(19px,2.2vw,24px)] font-extrabold leading-[1.35] tracking-tight text-[#111827] [word-break:keep-all]">
                  범용 AI만으로는 해결되지 않는 불편함들
                </h3>
              </ScrollReveal>
              <div className="mt-5 divide-y divide-[#E5E1D8] border-y border-[#E5E1D8]">
                {problems.map((problem, index) => (
                  <ScrollReveal key={problem.number} delay={140 + index * 80}>
                    <article className="-mx-3 rounded-xl px-3 py-5 transition-colors duration-200 hover:bg-[#FCFAF4]">
                      <div className="grid gap-2 sm:grid-cols-[3.25rem_1fr] sm:gap-4">
                        <span className="text-[17px] font-bold text-[#1F5C43]">{problem.number}.</span>
                        <div className="[word-break:keep-all]">
                          <h4 className="text-[16.5px] font-bold leading-7 tracking-tight text-[#111827]">
                            {problem.title}
                          </h4>
                          <p className="mt-1.5 text-[13.5px] leading-6 text-[#6B7280]">{problem.description}</p>
                        </div>
                      </div>
                    </article>
                  </ScrollReveal>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* ── 기능 소개 — 01 내신(강의자료 기반) → 02 CPX ── */}
        <section id="features" className="scroll-mt-16 pt-16 sm:pt-20">
          <div className="mx-auto max-w-[1140px] px-5 sm:px-8">
            <ScrollReveal>
              <SectionHeading
                title={'강의자료 기반 내신 대비부터\nAI 환자와 함께하는 CPX까지'}
                desc="문제 생성과 복습, CPX 실전 연습을 렉처링크 안에서 이어갈 수 있습니다."
              />
            </ScrollReveal>
          </div>

          <div className="mt-4">
            {/* 01 — 기존 랜딩 "강의자료 기반" 섹션 원형 복원(= 내신 대비) */}
            <FeatureRow
              index="01"
              badge="강의자료 기반"
              title={'강의자료를 분석해\n시험에 맞는 문제를 생성합니다'}
              desc="강의록·수업자료·필기를 올리면 핵심 개념과 중요 포인트를 분석해 시험 대비에 맞는 문제를 자동으로 만들어드립니다."
              bullets={['PDF·PPT 강의자료 업로드 지원', '핵심 개념·중요 포인트 자동 추출', '단원별·개념별 문제 생성', '학교 수업 흐름에 맞춘 학습']}
              visual={
                <PlayOnView>
                  <MockGenerated />
                </PlayOnView>
              }
            />
            <div className="border-t border-[#E5E1D8]" />
            {/* 02 — CPX 실전 연습 (프리뷰: 실제 진료 화면 구성 + 실제 캐릭터) */}
            <FeatureRow
              flip
              index="02"
              badge="CPX 실전 연습"
              title={'AI 환자와 직접 대화하며\nCPX를 연습하세요'}
              desc="렉처링크의 AI 환자와 음성으로 문진하고, 연습이 끝난 뒤 빠뜨린 질문과 표현을 바로 확인할 수 있습니다."
              bullets={['AI 가상 환자와 음성 문진', '병력 청취와 환자 교육 연습', '빠뜨린 질문과 표현 확인', '대화 종료 후 즉시 피드백']}
              visual={<CpxPreview />}
            />
          </div>
        </section>

        {/* ── 이용 방법 — 내신 흐름 3단계 + 안내 배너 ── */}
        <section id="how" className="scroll-mt-16 border-t border-[#E5E1D8] px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-[1140px]">
            <ScrollReveal>
              <SectionHeading
                badge={
                  <Badge tone="line">
                    <ClipboardCheck className="h-[13px] w-[13px] text-[#1F5C43]" /> 이용 방법
                  </Badge>
                }
                title="복잡한 설정 없이 바로 시작하세요"
              />
            </ScrollReveal>
            <div className="mt-12 grid gap-4 sm:grid-cols-3">
              <ScrollReveal>
                <StepCard n="01" icon={<Upload />} title="강의자료를 업로드하세요." desc="PDF나 강의자료를 올리고 학습 범위를 선택합니다." />
              </ScrollReveal>
              <ScrollReveal delay={80}>
                <StepCard n="02" icon={<FileText />} title="생성된 문제를 풀어보세요." desc="강의자료 기반 예상문제를 실제 시험처럼 풀어봅니다." />
              </ScrollReveal>
              <ScrollReveal delay={160}>
                <StepCard n="03" icon={<RotateCcw />} title="틀린 내용을 다시 학습하세요." desc="오답과 유사문항으로 취약한 개념을 반복해서 복습합니다." />
              </ScrollReveal>
            </div>
            <ScrollReveal delay={240}>
              <div className="mt-6 flex items-center justify-center gap-2.5 rounded-2xl bg-[#EAF3ED] px-5 py-4 text-center text-[13.5px] font-semibold text-[#1F5C43] [word-break:keep-all]">
                <GraduationCap className="h-4 w-4 shrink-0" />
                CPX는 원하는 사례를 선택해 바로 연습할 수 있습니다.
              </div>
            </ScrollReveal>
          </div>
        </section>

        {/* ── 요금 안내 — 기존 랜딩 요금제 복원 + 무료 체험 안내 ── */}
        <section id="pricing" className="scroll-mt-16 border-t border-[#E5E1D8] bg-[#F4F1E8]/50 px-5 py-16 sm:px-8 sm:py-20">
          <div className="mx-auto max-w-[1140px]">
            <ScrollReveal>
              <SectionHeading
                badge={
                  <Badge tone="gold">
                    <Sparkles className="h-[13px] w-[13px]" /> 첫 한 달 무료 체험
                  </Badge>
                }
                title="학습 목표에 맞게 선택하세요"
                desc={'한 달 동안 직접 사용해보세요.\n학교 시험만, 국시만, 또는 둘 다 — 필요한 학습 흐름에 맞춰 요금제를 고를 수 있습니다.'}
              />
            </ScrollReveal>
            <ScrollReveal delay={100}>
              <div className="mt-12 grid items-stretch gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {plans.map((plan) => (
                  <PlanCard key={plan.name} {...plan} />
                ))}
              </div>
            </ScrollReveal>
          </div>
        </section>

        {/* ── 후기 — 기존 랜딩 캐러셀 복원 ── */}
        <Reviews />

        {/* ── CTA — 기존 랜딩 마감 패널 스타일 ── */}
        <section className="border-t border-[#E5E1D8] px-5 py-16 sm:px-8 sm:py-20">
          <ScrollReveal>
            <div className="relative mx-auto max-w-[1140px] overflow-hidden rounded-3xl bg-[#143C2C] px-6 py-14 text-center sm:px-12 sm:py-16">
              <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-white/[0.04]" />
              <div className="pointer-events-none absolute -bottom-20 -left-20 h-64 w-64 rounded-full bg-white/[0.03]" />
              <div className="relative mx-auto max-w-2xl [word-break:keep-all]">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[12.5px] font-bold text-white/85">
                  <BookOpen className="h-[13px] w-[13px] text-[#F3C64E]" /> 지금 바로 시작
                </span>
                <h2 className="mt-5 text-[clamp(24px,3.4vw,36px)] font-extrabold leading-[1.3] tracking-tight text-white">
                  의대 공부에 필요한 모든 준비,
                  <br />
                  이제 렉처링크 하나로 시작하세요.
                </h2>
                <p className="mx-auto mt-4 max-w-lg text-[15px] leading-relaxed text-white/65">
                  강의자료 기반 내신 대비부터 CPX 실전 연습까지
                  <br className="hidden sm:block" /> 한곳에서 시작해보세요.
                </p>
                <div className="mt-8 flex flex-wrap justify-center gap-3">
                  <Link
                    href="/login"
                    className="group inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-[#F3C64E] px-7 text-[15px] font-bold text-[#143C2C] transition hover:bg-[#D9A82F] active:scale-[.98]"
                  >
                    1달 무료체험 시작하기
                    <ArrowRight className="h-[17px] w-[17px] transition-transform group-hover:translate-x-0.5" />
                  </Link>
                  <a
                    href="#pricing"
                    className="inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-white/10 px-6 text-[15px] font-bold text-white ring-1 ring-white/20 transition hover:bg-white/15 active:scale-[.98]"
                  >
                    요금 안내 보기
                  </a>
                </div>
              </div>
            </div>
          </ScrollReveal>
        </section>
      </main>

      {/* ── 푸터 — 기존 랜딩 다크 푸터 구조 그대로 ── */}
      <footer className="bg-[#143C2C] text-white/75">
        <div className="mx-auto max-w-[1140px] px-5 py-10 sm:px-8">
          <div className="grid gap-8 md:grid-cols-[1.8fr_1fr_1fr_1fr]">
            <div className="max-w-xs">
              <Logo light />
              <p className="mt-3 text-[13px] leading-relaxed text-white/55">
                강의자료를 바탕으로 의학 문제를 생성하고, 오답을 분석해 시험 대비를 돕는 학습 플랫폼입니다.
              </p>
            </div>
            {[
              {
                t: '서비스',
                l: [
                  { label: '기능 소개', href: '#features' },
                  { label: '활용 방법', href: '#how' },
                  { label: '요금 안내', href: '#pricing' },
                ],
              },
              {
                t: '지원',
                l: [
                  { label: '자주 묻는 질문', href: '/faq' },
                  { label: '문의하기', href: '/contact' },
                ],
              },
              {
                t: '약관',
                l: [
                  { label: '이용약관', href: '/terms' },
                  { label: '개인정보처리방침', href: '/privacy' },
                ],
              },
            ].map((c) => (
              <div key={c.t}>
                <div className="text-[12.5px] font-bold text-white/45">{c.t}</div>
                <ul className="mt-3 space-y-2">
                  {c.l.map((x) => (
                    <li key={x.label}>
                      <a href={x.href} className="text-[13px] text-white/70 transition hover:text-white">
                        {x.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mt-8 flex flex-col gap-2 border-t border-white/10 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[12px] text-white/45">
              렉처링크는 학습 보조 도구이며, 생성된 문항과 해설은 검토 후 학습에 활용해주세요.
            </p>
            <p className="text-[12px] text-white/40">© 2026 렉처링크. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}

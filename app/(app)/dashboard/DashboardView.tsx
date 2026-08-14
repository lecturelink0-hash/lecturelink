import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  CalendarDays,
  Check,
  FileText,
  Flame,
  Plus,
  Stethoscope,
} from 'lucide-react';
import { KakaoEmailPrompt } from '@/components/auth/KakaoEmailPrompt';
import loginCpxCharacter from '@/public/login-cpx-character-v2.png';

interface Day {
  label: string;
  studied: boolean;
  isToday: boolean;
}

interface LearningSet {
  id: string;
  fileName: string;
  fileType: string;
  questionCount: number;
  attemptedCount: number | null;
  href: string;
  hasProgress: boolean;
}

interface DailyAccuracyPoint {
  dayIndex: number;
  accuracy: number;
}

interface ExamDday {
  title: string;
  dday: number;
}

interface WeakArea {
  name: string;
  accuracy: number;
}

interface NextStep {
  title: string;
  description: ReactNode;
  href: string;
  progressPct?: number | null;
}

export function DashboardView({
  displayName,
  weekSeconds,
  weekCount,
  streak,
  weekDays,
  totalSolved,
  weekSecondsDelta,
  weekCountDelta,
  recentAccuracy,
  recentAccuracyDelta,
  recentDaily,
  examDday,
  unresolvedWrongCount,
  topWeakArea,
  nextLearningSet,
}: {
  displayName: string;
  weekSeconds: number;
  weekCount: number;
  streak: number;
  weekDays: Day[];
  totalSolved: number;
  weekSecondsDelta: number | null;
  weekCountDelta: number | null;
  recentAccuracy: number | null;
  recentAccuracyDelta: number | null;
  recentDaily: DailyAccuracyPoint[];
  examDday: ExamDday | null;
  unresolvedWrongCount: number;
  topWeakArea: WeakArea | null;
  nextLearningSet: LearningSet | null;
}) {
  const learnerName = displayName.trim() || '학생';
  const isNewUser = totalSolved === 0;
  const studyTime = formatStudyTime(weekSeconds);

  const continuationStep: NextStep[] = nextLearningSet
    ? [
        {
          title: '이어풀기',
          description: describeLearningSet(nextLearningSet),
          href: nextLearningSet.href,
          progressPct: learningSetProgress(nextLearningSet),
        },
      ]
    : [];
  const secondarySteps: NextStep[] = isNewUser
    ? [
        {
          title: '문제 만드는 법 익히기',
          description: '자료 업로드부터 문제 생성까지 짧은 안내를 확인하세요.',
          href: '/tutorial',
        },
        {
          title: '내 문제집 확인하기',
          description: '생성한 문제집과 학습 진행 상태를 한곳에서 관리하세요.',
          href: '/library',
        },
        {
          title: '시험 일정 등록하기',
          description: 'D-day 기준으로 학습 리듬을 잡아드려요.',
          href: '/mypage#calendar',
        },
      ]
    : [
        ...continuationStep,
        {
          title: '오답 흐름 다시 잡기',
          description: unresolvedWrongCount > 0
            ? (<>복습 대기 오답 <b>{unresolvedWrongCount}문항</b></>)
            : '틀린 문제를 모아 다시 풀고 유사문제로 이어가세요.',
          href: '/wrong-notes',
        },
        {
          title: '학습 결과 확인하기',
          description: topWeakArea
            ? (<>가장 취약: <b>{topWeakArea.name} · 정답률 {topWeakArea.accuracy}%</b></>)
            : '누적 정답률과 취약 영역을 확인해 다음 범위를 정하세요.',
          href: '/analysis',
        },
      ];

  return (
    <div className="ll-dashboard-page student-dashboard content">
      <KakaoEmailPrompt />

      <header className="dashboard-greeting" aria-labelledby="page-title">
        <h1 id="page-title">안녕하세요, {learnerName}님</h1>
        <p>오늘도 학습을 시작해보세요.</p>
      </header>

      <section className="dashboard-priority-grid" aria-label="오늘의 우선 학습">
        <article className="dashboard-card dashboard-next-card">
          <div className="dashboard-next-copy">
            <div className="dashboard-next-copy-content">
              <h2>내신 대비 문항 생성하기</h2>
              <p>강의자료를 올리면 내 시험 범위에 맞는 문항을 만들 수 있어요.</p>
            </div>

            <div className="dashboard-next-actions">
              <Link href="/notes" className="dashboard-primary-action">
                문항 생성하기
                <ArrowRight aria-hidden="true" />
              </Link>
              <Link
                href="/library"
                className="dashboard-secondary-action"
              >
                내 문제집
              </Link>
            </div>
          </div>

          <aside
            className="dashboard-material-summary"
            aria-label="강의자료 업로드 안내"
          >
            <div className="dashboard-document-visual" aria-hidden="true">
              <span className="document-sheet document-sheet-back" />
              <span className="document-sheet document-sheet-front"><FileText /></span>
              <span className="document-book"><BookOpen /></span>
            </div>
            <div className="dashboard-material-copy">
              <span>내신 대비</span>
              <strong>강의자료로 문항 만들기</strong>
              <small>PDF · PPTX · 문서 지원</small>
            </div>
          </aside>
        </article>

        <article className="dashboard-card dashboard-cpx-card">
          <div className="dashboard-cpx-copy">
            <Stethoscope className="dashboard-cpx-icon" aria-hidden="true" />
            <h2>CPX 진료 연습</h2>
            <p>환자 진료 과정을 실전처럼 단계별로 연습하세요.</p>
            <span className="dashboard-cpx-flow">병력청취 → 신체진찰 → 환자교육</span>
            <Link href="/cpx" className="dashboard-primary-action dashboard-cpx-action">
              CPX 시작하기 <ArrowRight aria-hidden="true" />
            </Link>
          </div>
          <div className="dashboard-cpx-character-frame">
            <Image
              src={loginCpxCharacter}
              alt="손을 들어 인사하는 CPX 환자 캐릭터"
              className="dashboard-cpx-character"
              sizes="(max-width: 720px) 171px, 216px"
              priority
            />
          </div>
        </article>
      </section>

      <section className="dashboard-progress-grid" aria-label="학습 기록과 학습 추천">
        <article className="dashboard-card dashboard-weekly-card">
          <div className="dashboard-section-heading">
            <div>
              <h2>내 학습 현황</h2>
              {streak > 0 ? (
                <span className="dashboard-streak-line">
                  <Flame aria-hidden="true" />
                  {streak}일 연속 학습 중
                </span>
              ) : (
                <p>오늘부터 학습 기록을 만들어보세요</p>
              )}
            </div>
            <div className="dashboard-head-side">
              {examDday ? (
                <Link href="/mypage#calendar" className="dashboard-dday-chip">
                  <CalendarDays aria-hidden="true" />
                  {examDday.title}&nbsp;
                  <strong>{examDday.dday === 0 ? 'D-Day' : `D-${examDday.dday}`}</strong>
                </Link>
              ) : (
                <Link href="/mypage#calendar" className="dashboard-dday-chip is-ghost">
                  <Plus aria-hidden="true" />
                  시험 일정 등록
                </Link>
              )}
              <Link href="/analysis" className="dashboard-inline-link">
                상세 분석 <ArrowRight aria-hidden="true" />
              </Link>
            </div>
          </div>

          <dl className="dashboard-metrics">
            <div>
              <dt>학습 시간</dt>
              <dd>
                {isNewUser ? '—' : studyTime}
                <MetricDelta
                  delta={isNewUser ? null : weekSecondsDelta}
                  format={(value) => formatStudyTime(value)}
                  minUnit={60}
                />
              </dd>
            </div>
            <div>
              <dt>이번 주 풀이</dt>
              <dd>
                {isNewUser ? '—' : `${weekCount}문항`}
                <MetricDelta
                  delta={isNewUser ? null : weekCountDelta}
                  format={(value) => `${value}문항`}
                />
              </dd>
            </div>
            <div>
              <dt>최근 7일 정답률</dt>
              <dd>
                {!isNewUser && recentAccuracy !== null ? `${recentAccuracy}%` : '—'}
                {!isNewUser && recentDaily.length >= 2 && (
                  <AccuracySparkline points={recentDaily} />
                )}
                <MetricDelta
                  delta={isNewUser ? null : recentAccuracyDelta}
                  format={(value) => `${value}%p`}
                />
              </dd>
            </div>
          </dl>

          <ul className="study-week" aria-label="월요일부터 일요일까지의 학습 기록">
            {weekDays.map((day) => {
              const status = day.studied ? '학습 완료' : day.isToday ? '오늘, 아직 학습 전' : '학습 기록 없음';
              return (
                <li key={day.label} className="study-day" aria-label={`${day.label}: ${status}`}>
                  <span aria-hidden="true">{day.label}</span>
                  <i
                    aria-hidden="true"
                    className={day.studied ? 'is-complete' : day.isToday ? 'is-today' : ''}
                  >
                    {day.studied && <Check aria-hidden="true" />}
                  </i>
                </li>
              );
            })}
          </ul>
        </article>

        <section className="dashboard-next-queue" aria-labelledby="next-steps-title">
          <div className="dashboard-queue-heading">
            <h2 id="next-steps-title">학습 추천</h2>
            <p>{isNewUser ? '처음이라면 여기서 시작해보세요.' : '진행 중인 학습과 다음 단계를 모았습니다.'}</p>
          </div>
          <ol>
            {secondarySteps.map((step) => (
              <li key={step.href}>
                <Link href={step.href}>
                  <span className="dashboard-step-copy">
                    <strong>{step.title}</strong>
                    <small>{step.description}</small>
                    {typeof step.progressPct === 'number' && (
                      <span
                        className="dashboard-step-progress"
                        role="img"
                        aria-label={`진행률 ${step.progressPct}퍼센트`}
                      >
                        <b style={{ width: `${step.progressPct}%` }} />
                      </span>
                    )}
                  </span>
                  <ArrowRight aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ol>
        </section>
      </section>
    </div>
  );
}

function describeLearningSet(set: LearningSet): ReactNode {
  const title = materialDisplayTitle(set.fileName);
  if (set.attemptedCount !== null && set.attemptedCount > 0 && set.questionCount > 0) {
    return (
      <>{title} · {set.questionCount}문항 중 <b>{Math.min(set.attemptedCount, set.questionCount)}문항</b></>
    );
  }
  return `${title} · ${set.questionCount}문항`;
}

function learningSetProgress(set: LearningSet): number | null {
  if (set.attemptedCount === null || set.attemptedCount <= 0 || set.questionCount <= 0) {
    return null;
  }
  return Math.min(100, Math.round((set.attemptedCount / set.questionCount) * 100));
}

function MetricDelta({
  delta,
  format,
  minUnit = 1,
}: {
  delta: number | null;
  format: (absValue: number) => string;
  minUnit?: number;
}) {
  if (delta === null || Math.abs(delta) < minUnit) return null;
  const isDown = delta < 0;
  return (
    <span className={isDown ? 'dashboard-delta is-down' : 'dashboard-delta'}>
      {isDown ? <ArrowDown aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
      {format(Math.abs(delta))}
      <small>지난주 대비</small>
    </span>
  );
}

const SPARK_STEP_X = 12;
const SPARK_HEIGHT = 24;
const SPARK_PAD_Y = 4;

function AccuracySparkline({ points }: { points: DailyAccuracyPoint[] }) {
  const accuracies = points.map((point) => point.accuracy);
  const min = Math.min(...accuracies);
  const max = Math.max(...accuracies);
  const range = max - min;
  const width = 6 * SPARK_STEP_X;

  const coords = points.map((point) => ({
    x: point.dayIndex * SPARK_STEP_X,
    y: range === 0
      ? SPARK_HEIGHT / 2
      : SPARK_PAD_Y + ((max - point.accuracy) / range) * (SPARK_HEIGHT - SPARK_PAD_Y * 2),
  }));
  const line = coords
    .map((coord, index) => `${index === 0 ? 'M' : 'L'}${coord.x},${round1(coord.y)}`)
    .join(' ');
  const first = coords[0];
  const last = coords[coords.length - 1];
  const area = `${line} L${last.x},${SPARK_HEIGHT} L${first.x},${SPARK_HEIGHT} Z`;

  return (
    <svg
      className="dashboard-spark"
      viewBox={`-3 -3 ${width + 6} ${SPARK_HEIGHT + 6}`}
      width={width + 6}
      height={SPARK_HEIGHT + 6}
      role="img"
      aria-label={`최근 7일 정답률 추이, ${points[0].accuracy}%에서 ${points[points.length - 1].accuracy}%`}
    >
      <path className="spark-area" d={area} />
      <path className="spark-line" d={line} />
      <circle className="spark-dot" cx={last.x} cy={round1(last.y)} r="3" />
    </svg>
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function materialDisplayTitle(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
}

function formatStudyTime(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours > 0) return `${hours}시간 ${remainingMinutes}분`;
  if (minutes > 0) return `${minutes}분`;
  return '0분';
}

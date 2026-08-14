import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, BookOpen, Check, FileText, Flame, Stethoscope } from 'lucide-react';
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
  href: string;
  hasProgress: boolean;
}

interface NextStep {
  title: string;
  description: string;
  href: string;
}

export function DashboardView({
  displayName,
  weekSeconds,
  weekCount,
  streak,
  weekDays,
  overallAccuracy,
  totalSolved,
  nextLearningSet,
}: {
  displayName: string;
  weekSeconds: number;
  weekCount: number;
  streak: number;
  weekDays: Day[];
  overallAccuracy: number;
  totalSolved: number;
  nextLearningSet: LearningSet | null;
}) {
  const learnerName = displayName.trim() || '학생';
  const studyTime = formatStudyTime(weekSeconds);
  const continuationStep: NextStep[] = nextLearningSet
    ? [
        {
          title: '이어풀기',
          description: `${materialDisplayTitle(nextLearningSet.fileName)} · ${nextLearningSet.questionCount}문항`,
          href: nextLearningSet.href,
        },
      ]
    : [];
  const secondarySteps: NextStep[] = [
    ...continuationStep,
    ...(totalSolved > 0
      ? [
          {
            title: '오답 흐름 다시 잡기',
            description: '틀린 문제를 모아 다시 풀고 유사문제로 이어가세요.',
            href: '/wrong-notes',
          },
          {
            title: '학습 결과 확인하기',
            description: '누적 정답률과 취약 영역을 확인해 다음 범위를 정하세요.',
            href: '/analysis',
          },
        ]
      : [
          {
            title: '내 문제집 확인하기',
            description: '생성한 문제집과 학습 진행 상태를 한곳에서 관리하세요.',
            href: '/library',
          },
          {
            title: '문제 만드는 법 익히기',
            description: '자료 업로드부터 문제 생성까지 짧은 안내를 확인하세요.',
            href: '/tutorial',
          },
        ]),
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

      <section className="dashboard-progress-grid" aria-label="학습 기록과 다음 단계">
        <article className="dashboard-card dashboard-weekly-card">
          <div className="dashboard-section-heading">
            <h2>이번 주 학습</h2>
            <p className="dashboard-streak">
              {streak > 0 && <Flame aria-hidden="true" />}
              <span>{streak > 0 ? `${streak}일 연속 학습 중` : '오늘부터 학습 기록을 만들어보세요'}</span>
            </p>
          </div>

          <dl className="dashboard-metrics">
            <div><dt>학습 시간</dt><dd>{studyTime}</dd></div>
            <div><dt>이번 주 풀이</dt><dd>{weekCount}문항</dd></div>
            <div><dt>누적 정답률</dt><dd>{totalSolved > 0 ? `${overallAccuracy}%` : '—'}</dd></div>
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
            <h2 id="next-steps-title">다음 학습</h2>
            <p>진행 중인 학습과 다음 단계를 모았습니다.</p>
          </div>
          <ol>
            {secondarySteps.map((step) => (
              <li key={step.href}>
                <Link href={step.href}>
                  <span className="dashboard-step-copy">
                    <strong>{step.title}</strong>
                    <small>{step.description}</small>
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

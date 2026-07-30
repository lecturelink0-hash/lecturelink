import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { KakaoEmailPrompt } from '@/components/auth/KakaoEmailPrompt';

interface Day { label: string; studied: boolean; isToday: boolean }
interface Recent { isCorrect: boolean; subTopicName: string; subjectName: string; label: string }
interface WeakConcept { name: string; subjectName: string; accuracy: number; count: number }

export function DashboardView({
  displayName,
  recent,
  weekSeconds,
  weekCount,
  weekAccuracy,
  streak,
  weekDays,
  overallAccuracy,
  totalSolved,
  weakConcept,
}: {
  displayName: string;
  recent: Recent | null;
  weekSeconds: number;
  weekCount: number;
  weekAccuracy: number;
  streak: number;
  weekDays: Day[];
  overallAccuracy: number;
  totalSolved: number;
  weakConcept: WeakConcept | null;
}) {
  const studyTime = weekSeconds < 60 ? `${weekSeconds}초` : weekSeconds < 3600 ? `${Math.floor(weekSeconds / 60)}분` : `${Math.floor(weekSeconds / 3600)}시간 ${Math.floor((weekSeconds % 3600) / 60)}분`;

  return (
    <div className="ll-dashboard-page content">
      {/* 카카오(합성 이메일) 사용자 이메일 등록 유도 — 첫 진입 모달 + 이후 하루 1회 배너 */}
      <KakaoEmailPrompt />
      <section className="welcome-row" aria-labelledby="page-title">
        <div>
          <h1 id="page-title">
            안녕하세요, <span className="text-[#1f5c43]">{displayName}</span>님
          </h1>
          <p className="sub">
            {recent ? `마지막 학습은 ${recent.label}입니다.` : '오늘도 학습을 시작해보세요.'}
          </p>
        </div>
      </section>

      <section className="priority-grid">
        <article className="card primary-card continue-card">
          <div className="section-title">
            <span>지금 이어서 할 학습</span>
            {recent && <span className="muted">{recent.subjectName} · {recent.label}</span>}
          </div>
          <div className="topic">
            {recent?.subTopicName ?? '국시형 임상 문제'}
          </div>
          <p className="task-copy">
            {weekCount > 0 ? `이번 주 정답률 ${weekAccuracy}% · ${weekCount}문항 · 마지막 ${recent?.isCorrect ? '정답' : '오답'}` : '첫 문제를 풀고 나만의 학습 흐름을 시작해보세요.'}
          </p>
          <div className="progress-line" aria-label={`진행률 ${weekAccuracy}%`}>
            <span style={{ width: `${Math.max(weekAccuracy, weekCount ? 4 : 0)}%` }} />
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 24, flexWrap: 'wrap' }}>
            <Link href="/exam" className="btn btn-focus">
              이어풀기 <ArrowRight className="w-4 h-4" />
            </Link>
            <Link href="/wrong-notes" className="btn" style={{ background: 'white', color: 'var(--forest)', border: '1px solid #C9DEBE' }}>
              오답노트 보기
            </Link>
          </div>
        </article>

        <article className="card pad supporting-card">
          <div className="section-title">
            <span>이번 주 학습</span>
            {streak >= 2 && <span className="chip">{streak}일 연속 학습 🔥</span>}
          </div>
          <p className="muted">이번 주 학습 현황을 확인해보세요.</p>
          <div className="stats stats-inline">
            {[[studyTime, '학습 시간'], [`${weekCount}문항`, '푼 문항'], [`${weekAccuracy}%`, '정답률']].map(([value, label]) => (
              <div key={label} className="stat">
                <span>{label}</span><strong>{value}</strong>
              </div>
            ))}
          </div>
          <div className="week">
            <div className="muted">주간 학습 기록</div>
            <div className="week-days">
              {weekDays.map((day) => (
                <div key={day.label} className="day">
                  {day.label}
                  <span className={`dot ${day.studied ? 'done' : day.isToday ? 'today' : ''}`}>
                    {day.studied ? <span className="text-xl leading-none">🔥</span> : <span className="text-2xl leading-none">·</span>}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </article>
      </section>

      <section className="section secondary-grid">
        <div>
          <h2 className="section-title">나의 학습 분석</h2>
          <div className="card pad quiet-card">
            <div className="analysis">
              {[[`${overallAccuracy}%`, '평균 정답률'], [`${totalSolved}문항`, '누적 학습'], [weakConcept?.name ?? '–', '가장 취약한 개념']].map(([value, label]) => (
                <div key={label}><strong>{value}</strong><span>{label}</span></div>
              ))}
            </div>
            <div className="analysis-action">
              최근 학습 기록과 자주 틀린 개념을 확인해보세요.
            </div>
          </div>
        </div>

        <div>
          <h2 className="section-title">다른 학습 시작</h2>
          <div className="mode-grid">
            <StudyTile href="/notes" variant="tile-upload" title="시험 범위 PDF로 10문항 만들기" copy="강의자료를 올리고 바로 풀 수 있는 짧은 문제집을 만듭니다." cta="문제집 만들기" />
            <StudyTile href="/exam" variant="tile-book" title="국시형 임상 문제 20분 풀기" copy="과목별 임상형 문제를 짧게 풀고 해설로 정리합니다." cta="국시 문제 풀기" />
          </div>
        </div>
      </section>
    </div>
  );
}

function StudyTile({ href, variant, title, copy, cta }: { href: string; variant: string; title: string; copy: string; cta: string }) {
  return (
    <Link href={href} className={`card tile quiet-card ${variant}`}>
      <h3>{title}</h3><p>{copy}</p>
      <span className="link">{cta} <ArrowRight className="icon" /></span>
    </Link>
  );
}

import Link from 'next/link';
import { ArrowRight, Flame } from 'lucide-react';

interface Day { label: string; studied: boolean; isToday: boolean }
interface Recent { isCorrect: boolean; subTopicName: string; subjectName: string; label: string }

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
  weakCount,
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
  weakCount: number;
}) {
  const studyTime = weekSeconds < 60 ? `${weekSeconds}초` : weekSeconds < 3600 ? `${Math.floor(weekSeconds / 60)}분` : `${Math.floor(weekSeconds / 3600)}시간 ${Math.floor((weekSeconds % 3600) / 60)}분`;

  return (
    <div className="ll-dashboard-page content">
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
            <span className="chip">{streak}일 연속 학습 🔥</span>
          </div>
          <p className="muted">오늘 짧게라도 이어가면 학습 흐름이 더 단단해집니다.</p>
          <div className="stats">
            {[[studyTime, '이번 주 공부시간'], [`${weekCount}문항`, '이번 주 푼 문항'], [`${weekAccuracy}%`, '이번 주 정답률']].map(([value, label]) => (
              <div key={label} className="stat">
                <strong>{value}</strong><span>{label}</span>
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
                    {day.studied ? <Flame className="w-5 h-5 fill-current" strokeWidth={1.7} /> : <span className="text-2xl leading-none">·</span>}
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
              {[[`${overallAccuracy}%`, '평균 정답률'], [`${totalSolved}문항`, '누적 학습'], [`${weakCount}개`, '취약 개념']].map(([value, label]) => (
                <div key={label}><strong>{value}</strong><span>{label}</span></div>
              ))}
            </div>
            <div className="analysis-action">
              {totalSolved < 10 ? `분석을 열려면 ${10 - totalSolved}문항만 더 풀어보세요. 이후 자주 틀리는 개념과 복습 우선순위를 자동으로 보여드립니다.` : '학습 결과를 바탕으로 자주 틀리는 개념과 복습 우선순위를 정리했습니다.'}
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

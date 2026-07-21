'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, Clock3, History, ShieldAlert, Stethoscope } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';

function request(path) {
  return fetch(`/api/cpx${path}`, { cache: 'no-store' }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || `요청 실패 (${response.status})`);
    return body;
  });
}

function formatStartedAt(value) {
  if (!value) return '';
  const date = new Date(typeof value === 'number' ? value * 1000 : value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function gradeVariant(grade) {
  if (grade === '우수') return 'default';
  if (grade === '미흡') return 'warn';
  return 'beta';
}

export default function CpxHistory() {
  const [sessions, setSessions] = useState(null);
  const [cases, setCases] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    Promise.all([request('/history'), request('/cases')])
      .then(([historyData, caseData]) => {
        if (!active) return;
        setSessions(Array.isArray(historyData.sessions) ? historyData.sessions : []);
        setCases(Array.isArray(caseData.cases) ? caseData.cases : []);
      })
      .catch((nextError) => {
        if (!active) return;
        setSessions([]);
        setError(nextError instanceof Error ? nextError.message : 'CPX 기록을 불러오지 못했습니다.');
      });
    return () => { active = false; };
  }, []);

  const titles = useMemo(() => new Map(cases.map((item) => [item.id, item.title])), [cases]);

  return <div className="ll-system-page space-y-7">
    <section className="flex flex-col gap-4 border-b border-[var(--color-border)] pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <span className="ll-eyebrow"><History className="h-3.5 w-3.5" /> CPX 학습 기록</span>
        <h1 className="mt-2 text-3xl font-bold tracking-[-.035em] text-[var(--color-text)]">나의 CPX 기록</h1>
        <p className="mt-2 text-sm text-[var(--color-muted)]">완료한 진료의 점수와 환자 정보를 다시 확인할 수 있습니다.</p>
      </div>
      <Link href="/cpx" className="inline-flex h-11 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-5 text-[15px] font-bold text-white transition hover:bg-[var(--color-primary-strong)]"><ArrowLeft className="h-4 w-4" />실습으로 돌아가기</Link>
    </section>

    {error && <div role="alert" className="flex gap-2 rounded-[var(--radius-md)] border border-[var(--color-warn)] bg-[var(--color-warn-bg)] p-4 text-sm text-[var(--color-warn)]"><ShieldAlert className="h-5 w-5 shrink-0" />{error}</div>}

    {sessions === null && <Card><div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--color-muted)]"><span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />기록을 불러오는 중입니다.</div></Card>}

    {sessions?.length === 0 && !error && <Card className="text-center"><Stethoscope className="mx-auto h-10 w-10 text-[var(--color-primary)]" /><h2 className="mt-3 font-bold text-[var(--color-text)]">아직 완료한 세션이 없습니다</h2><p className="mt-1 text-sm text-[var(--color-muted)]">첫 CPX 연습을 마치면 결과가 여기에 저장됩니다.</p><Link href="/cpx" className="mt-5 inline-flex h-11 items-center rounded-[var(--radius-md)] bg-[var(--color-accent)] px-5 text-sm font-bold text-white">첫 연습 시작</Link></Card>}

    {sessions?.length > 0 && <div className="grid gap-3">
      {sessions.map((session) => <Link key={session.sessionId} href={`/cpx/history/${session.sessionId}`} className="block rounded-[var(--radius-lg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]">
        <Card hover className="p-4 sm:p-5 cursor-pointer">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex min-w-28 items-baseline gap-1 sm:block sm:text-center">
            <span className="tnum text-4xl font-bold text-[var(--color-primary)]">{session.totalScore ?? '-'}</span>
            <span className="text-xs text-[var(--color-muted)]">/ 100</span>
          </div>
          <div className="min-w-0 flex-1 border-t border-[var(--color-border)] pt-4 sm:border-l sm:border-t-0 sm:pl-5 sm:pt-0">
            <div className="flex flex-wrap items-center gap-2"><h2 className="font-bold text-[var(--color-text)]">{titles.get(session.caseId) || session.caseId}</h2><Badge variant={gradeVariant(session.gradeLabel)}>{session.gradeLabel || '채점 완료'}</Badge></div>
            {session.persona && <p className="mt-1 text-sm text-[var(--color-muted)]">{session.persona.name} · {session.persona.age}세 · {session.persona.gender}</p>}
            <p className="mt-2 flex items-center gap-1 text-xs text-[var(--color-muted)]"><Clock3 className="h-3.5 w-3.5" />{formatStartedAt(session.startedAt)}</p>
          </div>
          <ChevronRight className="hidden h-5 w-5 shrink-0 self-center text-[var(--color-muted)] sm:block" />
        </div>
        </Card>
      </Link>)}
    </div>}
  </div>;
}

'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, CheckCircle2, ChevronDown, Clock3, MinusCircle,
  Quote, ShieldAlert, Sparkles, ThumbsUp, XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';

function request(path, init) {
  return fetch(`/api/cpx${path}`, { cache: 'no-store', ...init }).then(async (response) => {
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
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function gradeVariant(grade) {
  if (grade === '우수') return 'default';
  if (grade === '미흡') return 'warn';
  return 'beta';
}

export default function CpxResultDetail({ sessionId }) {
  const [result, setResult] = useState(null);
  const [title, setTitle] = useState('');
  const [startedAt, setStartedAt] = useState(null);
  const [error, setError] = useState('');
  const [openSections, setOpenSections] = useState({});

  useEffect(() => {
    let active = true;
    // 저장된 세션 결과를 먼저 조회(persist 모드: Supabase에 미러링된 전체 결과).
    // 실패 시(비-persist 모드) evaluate 로 폴백 — 이미 채점된 세션은 캐시 결과를 즉시 반환.
    const loadResult = () =>
      request(`/history/${sessionId}`).catch(() =>
        request(`/sessions/${sessionId}/evaluate`, { method: 'POST' }),
      );
    Promise.all([
      loadResult(),
      request('/cases').catch(() => ({ cases: [] })),
    ])
      .then(([evaluation, caseData]) => {
        if (!active) return;
        setResult(evaluation);
        const titles = new Map((caseData.cases || []).map((c) => [c.id, c.title]));
        setTitle(titles.get(evaluation.caseId) || evaluation.caseId || '');
        setStartedAt(evaluation.startedAt ?? null);
        // 모든 영역을 기본 펼침 — 세부 채점표는 전체를 보여준다.
        const open = {};
        (evaluation.sections || []).forEach((s) => { open[s.id] = true; });
        setOpenSections(open);
      })
      .catch((nextError) => {
        if (!active) return;
        setError(nextError instanceof Error ? nextError.message : '채점 기록을 불러오지 못했습니다.');
      });
    return () => { active = false; };
  }, [sessionId]);

  // judgments는 두 가지 형태로 올 수 있다:
  //  - 배열 [{ id, status, evidence }]           (Fly evaluate 실시간 응답)
  //  - 객체 { ht01: { status, evidence }, ... }  (Supabase 미러링 저장본, item id 키)
  const judgmentMap = useMemo(() => {
    const j = result?.judgments;
    if (Array.isArray(j)) return new Map(j.map((x) => [x.id, x]));
    if (j && typeof j === 'object') return new Map(Object.entries(j));
    return new Map();
  }, [result]);

  const toggle = (id) => setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));

  return <div className="ll-system-page space-y-7">
    <section className="flex flex-col gap-4 border-b border-[var(--color-border)] pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <span className="ll-eyebrow"><Sparkles className="h-3.5 w-3.5" /> 세부 채점 기록</span>
        <h1 className="mt-2 text-3xl font-bold tracking-[-.035em] text-[var(--color-text)]">{title || 'CPX 채점 상세'}</h1>
        {result?.persona && <p className="mt-2 text-sm text-[var(--color-muted)]">{result.persona.name} · {result.persona.age}세 · {result.persona.gender}</p>}
        {startedAt && <p className="mt-1 flex items-center gap-1 text-xs text-[var(--color-muted)]"><Clock3 className="h-3.5 w-3.5" />{formatStartedAt(startedAt)}</p>}
      </div>
      <Link href="/cpx/history" className="inline-flex h-11 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-primary)] px-5 text-[15px] font-bold text-white transition hover:bg-[var(--color-primary-strong)]"><ArrowLeft className="h-4 w-4" />기록으로 돌아가기</Link>
    </section>

    {error && <div role="alert" className="flex gap-2 rounded-[var(--radius-md)] border border-[var(--color-warn)] bg-[var(--color-warn-bg)] p-4 text-sm text-[var(--color-warn)]"><ShieldAlert className="h-5 w-5 shrink-0" />{error}</div>}

    {!result && !error && <Card><div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--color-muted)]"><span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />채점 기록을 불러오는 중입니다.</div></Card>}

    {result && <>
      {/* 총점 */}
      <Card>
        <div className="flex flex-wrap items-center gap-5">
          <div className="rounded-[var(--radius-md)] bg-[var(--color-primary)] px-7 py-5 text-center text-white">
            <div className="text-xs text-white/70">총점</div>
            <div className="tnum mt-1 text-5xl font-bold">{result.totalScore ?? '-'}</div>
            <div className="mt-1 text-sm">{result.overallGradeLabel || '채점 완료'}</div>
          </div>
          <div className="flex flex-1 flex-wrap gap-2">
            {(result.sections || []).map((s) => {
              const isDeduction = s.violationCount !== undefined && !Array.isArray(s.satisfiedIds);
              return <span key={s.id} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] px-3 py-1 text-xs">
                <span className="font-semibold text-[var(--color-text)]">{s.name}</span>
                <span className="tnum font-bold text-[var(--color-primary)]">{s.score}</span>
                {s.gradeLabel && <Badge variant={gradeVariant(s.gradeLabel)}>{s.gradeLabel}</Badge>}
                {isDeduction && <span className="text-[var(--color-muted)]">위반 {s.violationCount}</span>}
              </span>;
            })}
          </div>
        </div>
      </Card>

      {/* 영역별 세부 채점 + 근거 인용 */}
      {(result.sections || []).map((section) => {
        const open = openSections[section.id];
        const isDeduction = section.violationCount !== undefined && !Array.isArray(section.satisfiedIds);
        const rows = [
          ...(section.satisfiedIds || []).map((id) => ({ id, kind: 'met' })),
          ...(section.partialIds || []).map((id) => ({ id, kind: 'partial' })),
          ...(section.missedIds || []).map((id) => ({ id, kind: 'missed' })),
        ];
        return <Card key={section.id} className="p-0 overflow-hidden">
          <button type="button" onClick={() => toggle(section.id)} className="flex w-full items-center justify-between gap-3 p-4 text-left sm:p-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold text-[var(--color-text)]">{section.name}</span>
              {section.gradeLabel && <Badge variant={gradeVariant(section.gradeLabel)}>{section.gradeLabel}</Badge>}
              <span className="text-xs text-[var(--color-muted)]">
                {isDeduction
                  ? `감점 위반 ${section.violationCount ?? 0}건`
                  : `충족 ${section.satisfiedCount ?? 0}/${section.applicableCount ?? rows.length}${section.partialCount ? ` · 부분 ${section.partialCount}` : ''}`}
              </span>
            </div>
            <span className="inline-flex items-center gap-2">
              <span className="tnum font-bold text-[var(--color-primary)]">{section.score}</span>
              <ChevronDown className={`h-4 w-4 text-[var(--color-muted)] transition-transform ${open ? 'rotate-180' : ''}`} />
            </span>
          </button>
          {open && <div className="border-t border-[var(--color-border)] p-4 sm:p-5">
            {isDeduction ? (
              <div className="space-y-2 text-sm">
                {section.violationCount ? (result.feedback?.violationNotes || []).map((note, i) => (
                  <p key={i} className="flex items-start gap-2 text-[var(--color-warn)]"><ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />{note}</p>
                )) : <p className="text-[var(--color-muted)]">위반 사항이 없습니다. 임상예의 영역 만점.</p>}
                {section.violationCount > 0 && (result.feedback?.violationNotes || []).length === 0 && (
                  <p className="text-[var(--color-muted)]">위반 {section.violationCount}건 감지됨.</p>
                )}
              </div>
            ) : rows.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">표시할 항목이 없습니다.</p>
            ) : (
              <ul className="space-y-3">{rows.map((r) => {
                const j = judgmentMap.get(r.id);
                const quotes = (j && Array.isArray(j.evidence) ? j.evidence : [])
                  .map((q) => (typeof q === 'string' ? q : JSON.stringify(q)));
                return <li key={r.id} className="flex items-start gap-2 text-sm">
                  {r.kind === 'met' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" />
                    : r.kind === 'partial' ? <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warn)]" />
                    : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted)]" />}
                  <div className="min-w-0 flex-1">
                    <span className={r.kind === 'missed' ? 'text-[var(--color-muted)]' : 'text-[var(--color-text)]'}>
                      {(result.itemTexts || {})[r.id] || r.id}
                      {r.kind === 'partial' && <em className="ml-1 not-italic text-[var(--color-warn)]">(부분 인정)</em>}
                    </span>
                    {quotes.length > 0 && <div className="mt-1.5 space-y-1">
                      {quotes.map((q, i) => (
                        <p key={i} className="flex items-start gap-1.5 rounded-md bg-[var(--color-sage-50)] px-2.5 py-1.5 text-xs text-[var(--color-muted)]">
                          <Quote className="mt-0.5 h-3 w-3 shrink-0" /><span className="min-w-0">{q}</span>
                        </p>
                      ))}
                    </div>}
                    {r.kind === 'missed' && quotes.length === 0 && (
                      <p className="mt-1 text-xs text-[var(--color-muted)]">관련 근거가 확인되지 않았습니다.</p>
                    )}
                  </div>
                </li>;
              })}</ul>
            )}
          </div>}
        </Card>;
      })}

      {/* 종합 피드백 */}
      {result.feedback && <Card title="종합 피드백" icon={<ThumbsUp className="h-5 w-5" />}>
        {(result.feedback.strengths || []).length > 0 && <div className="mb-4">
          <div className="mb-1.5 text-sm font-bold text-[var(--color-text)]">잘한 영역</div>
          <div className="flex flex-wrap gap-2">{result.feedback.strengths.map((s) => (
            <span key={s} className="inline-flex items-center gap-1 rounded-full bg-[var(--color-sage-50)] px-3 py-1 text-xs font-semibold text-[var(--color-primary)]"><CheckCircle2 className="h-3.5 w-3.5" />{s}</span>
          ))}</div>
        </div>}
        {Object.keys(result.feedback.missedBySection || {}).length > 0 ? <div className="space-y-3">
          <div className="text-sm font-bold text-[var(--color-text)]">다음 진료에서 보완할 점</div>
          {Object.entries(result.feedback.missedBySection).map(([sectionName, items]) => (
            <div key={sectionName}>
              <div className="text-xs font-semibold text-[var(--color-muted)]">{sectionName}</div>
              <ul className="mt-1 space-y-1">{items.map((t, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-[var(--color-text)]"><MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warn)]" />{t}</li>
              ))}</ul>
            </div>
          ))}
        </div> : (result.feedback.strengths || []).length > 0 && <p className="text-sm text-[var(--color-muted)]">놓친 핵심 항목이 없습니다. 훌륭합니다.</p>}
      </Card>}
    </>}
  </div>;
}

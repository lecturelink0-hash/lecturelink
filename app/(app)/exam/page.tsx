'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api/client';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { SubjectIcon } from '@/components/SubjectIcon';
import {
  Stethoscope, ChevronDown, ChevronRight, ChevronLeft, CheckCircle2, XCircle, RotateCcw,
  BookmarkPlus, AlertTriangle, BookOpen, Target, GraduationCap, Search, Play, ZoomIn, X,
} from 'lucide-react';

interface SubTopic {
  id: string;
  name: string;
  parent_id: string | null;
  level: number;
  exam_relevance: 1 | 2 | 3;
  is_risk_category: boolean;
}
interface Subject {
  id: string;
  code: string;
  name: string;
  sub_topics: SubTopic[];
}
interface QuestionForUser {
  id: string;
  stem: string;
  choices: string[];
  concepts: string[];
  difficulty: 1 | 2 | 3;
  imageUrl: string | null;
  imageType: string | null;
  tier: 'curated' | 'community' | 'beta';
  badge: { label: string; color: 'curated' | 'community' | 'beta' };
  subjectName: string;
  subTopicName: string;
  subTopicId: string | null;
}
interface AttemptResponse {
  attempt_id: string;
  is_correct: boolean;
  correct_index: number;
  explanation: string | null;
}
interface SetResult {
  questionId: string;
  subTopicId: string | null;
  selected: number;
  correctIndex: number;
  isCorrect: boolean;
  stem: string;
}

export default function ExamPage() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandedMid, setExpandedMid] = useState<Record<string, boolean>>({});
  const [loadingSubjects, setLoadingSubjects] = useState(true);
  // 전 세부주제별 실제 문항 수(전역 1회 로드) — 과목 카드·상세 사이드바 카운트가 모두 여기서 파생
  const [stCounts, setStCounts] = useState<Record<string, number> | null>(null);

  // 브라우즈 → 상세: 선택된 과목
  const [selectedSubject, setSelectedSubject] = useState<Subject | null>(null);

  const [active, setActive] = useState<{ subTopicId: string; name: string; subjectName: string } | null>(null);
  const [questions, setQuestions] = useState<QuestionForUser[]>([]);
  const [loadingQuestions, setLoadingQuestions] = useState(false);

  const [idx, setIdx] = useState(0);
  // 문항이 화면에 표시된 시각 — 제출 시 실제 소요시간(누적 학습시간) 측정에 사용.
  const shownAtRef = useRef<number>(Date.now());
  const [selected, setSelected] = useState<number | null>(null);
  const [result, setResult] = useState<AttemptResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<SetResult[]>([]);
  const [finished, setFinished] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [savedNote, setSavedNote] = useState(false);
  const [zoomImage, setZoomImage] = useState<string | null>(null);
  const [cpxStats, setCpxStats] = useState<{ cases: number; categories: number } | null>(null);

  // CPX 배너 수치 — 연습 화면과 동일한 승인 증례 카탈로그에서 실제 수를 집계한다(하드코딩 금지).
  useEffect(() => {
    let alive = true;
    fetch('/api/cpx/cases', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { cases?: Array<{ id?: string; category?: string }> } | null) => {
        if (!alive || !data || !Array.isArray(data.cases)) return;
        const cases = data.cases.filter((c) => c?.id);
        const categories = new Set(cases.map((c) => c.category).filter(Boolean));
        setCpxStats({ cases: cases.length, categories: categories.size });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!zoomImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setZoomImage(null);
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [zoomImage]);

  useEffect(() => {
    api
      .get<Subject[]>('/api/subjects?with_sub_topics=true&active_only=true')
      .then(setSubjects)
      .catch(() => {})
      .finally(() => setLoadingSubjects(false));
    // 전 세부주제 문항 수를 요청 1회로 로드 — 과목 목록과 병렬.
    // (과목당 count_only 요청 N개를 병렬 발사하던 방식을 대체)
    api
      .get<{ total: number; counts: Record<string, number> }>('/api/questions?count_by=sub_topic')
      .then((r) => setStCounts(r.counts))
      .catch(() => setStCounts({}));
  }, []);

  // 과목별 문항 수 — 전역 세부주제 카운트에서 파생 (READY/준비중 · 카드 문항 수)
  const questionCounts = useMemo<Record<string, number>>(() => {
    if (!stCounts) return {};
    return Object.fromEntries(
      subjects.map((s) => [
        s.id,
        s.sub_topics.reduce((sum, t) => sum + (stCounts[t.id] ?? 0), 0),
      ]),
    );
  }, [subjects, stCounts]);

  function toggle(subjectId: string) {
    setExpanded((e) => ({ ...e, [subjectId]: !e[subjectId] }));
  }
  function toggleMid(midId: string) {
    setExpandedMid((e) => ({ ...e, [midId]: !e[midId] }));
  }
  const midsOf = (s: Subject) => s.sub_topics.filter((t) => t.level === 1);
  const leavesOf = (s: Subject, midId: string) =>
    s.sub_topics.filter((t) => t.level === 2 && t.parent_id === midId);

  // 과목 카드 → 상세 뷰 진입. 카운트는 브라우즈에서 이미 로드한 전역 집계를 재사용(추가 요청 없음 — 즉시 표시).
  function openSubject(s: Subject) {
    setSelectedSubject(s);
    setActive(null);
    setExpandedMid({});
    setQuestions([]);
    setResults([]);
    setFinished(false);
    setChecked(new Set());
    setSavedNote(false);
  }

  function backToBrowse() {
    setSelectedSubject(null);
    setActive(null);
  }

  async function openSubTopic(st: SubTopic, subjectName: string) {
    setActive({ subTopicId: st.id, name: st.name, subjectName });
    setLoadingQuestions(true);
    setQuestions([]);
    setIdx(0);
    setSelected(null);
    setResult(null);
    setResults([]);
    setFinished(false);
    setChecked(new Set());
    setSavedNote(false);
    try {
      // 사이드바에 표시된 문항 수와 실제 풀 수 있는 문항 수가 일치하도록 API 최대치(50)까지 로드
      const qs = await api.get<QuestionForUser[]>(`/api/questions?sub_topic_id=${st.id}&limit=50`);
      setQuestions(qs);
    } catch (e) {
      alert(e instanceof ApiError ? e.message : '문항을 불러오지 못했습니다.');
    } finally {
      setLoadingQuestions(false);
    }
  }

  const current = questions[idx];

  // 새 문항이 표시될 때마다(문항 이동 / 새 세부주제 로드) 타이머를 리셋해
  // 실제 문항 풀이 시간을 측정한다.
  useEffect(() => {
    shownAtRef.current = Date.now();
  }, [idx, active]);

  async function submit() {
    if (selected === null || !current) return;
    setSubmitting(true);
    // 문항 표시 시점부터 제출까지의 실제 경과 시간(초). 1~3600초로 클램프.
    const elapsedSeconds = Math.min(
      3600,
      Math.max(1, Math.round((Date.now() - shownAtRef.current) / 1000)),
    );
    try {
      const res = await api.post<AttemptResponse>('/api/attempts', {
        question_id: current.id,
        selected_index: selected,
        time_spent_seconds: elapsedSeconds,
        track: 'smart_practice',
      });
      setResult(res);
      setResults((r) => [
        ...r,
        {
          questionId: current.id,
          subTopicId: current.subTopicId,
          selected,
          correctIndex: res.correct_index,
          isCorrect: res.is_correct,
          stem: current.stem,
        },
      ]);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'quota_exceeded') {
        window.location.href = '/plan?limit=1';
      } else {
        alert(e instanceof Error ? e.message : '제출 실패');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function next() {
    if (idx < questions.length - 1) {
      setIdx((i) => i + 1);
      setSelected(null);
      setResult(null);
    } else {
      setFinished(true);
    }
  }

  const wrongResults = results.filter((r) => !r.isCorrect);

  async function saveToNotes() {
    const targets = wrongResults.filter((r) => checked.has(r.questionId));
    if (targets.length === 0) {
      alert('오답노트에 담을 문제를 선택해주세요.');
      return;
    }
    try {
      await Promise.all(
        targets.map((r) =>
          api.post('/api/wrong-answers', {
            question_id: r.questionId,
            sub_topic_id: r.subTopicId,
            selected_index: r.selected,
            source: 'exam',
          }),
        ),
      );
      setSavedNote(true);
    } catch (e) {
      alert(e instanceof Error ? e.message : '오답노트 저장 실패');
    }
  }

  // 준비된(READY) 과목을 최상단에, 준비 중 과목을 아래에 배치.
  // (Array.prototype.sort 는 안정 정렬이라 같은 그룹 내 원래 순서는 유지된다.)
  const isSubjectReady = (s: Subject) => {
    const c = questionCounts[s.id];
    return c === undefined ? s.sub_topics.length > 0 : c > 0;
  };
  const sortedSubjects = useMemo(
    () => [...subjects].sort((a, b) => Number(isSubjectReady(b)) - Number(isSubjectReady(a))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subjects, questionCounts],
  );

  // 세부주제별 실제 문항 수(DB 집계, 전역 1회 로드). 로딩 중에는 0 대신 자리 표시자를 렌더링한다.
  const stCount = stCounts ?? {};
  const countOrDots = (n: number) => (stCounts === null ? '…' : n);

  // ============================================================
  // 브라우즈 뷰 — 과목 카드 그리드
  // ============================================================
  if (!selectedSubject) {
    const totalQuestions = Object.values(questionCounts).reduce((a, b) => a + b, 0);
    return (
      <div className="ll-exam-page content">
        <section className="page-head">
          <div>
            <span className="eyebrow"><GraduationCap className="icon" />국시 대비</span>
            <h1><span className="headline-accent">예상문제</span>를 통해<br/><span className="headline-accent">국가고시</span>를 대비해보세요</h1>
            <p className="lead">교과서적 의학 지식과 임상 시나리오를 결합한 국가고시형 문제입니다. 과목·세부주제별로 풀고, 오답 데이터로 약한 개념을 반복 학습하세요.</p>
          </div>
          {/* CPX 실전 연습 — 국시 대비 우측 대표 배너(별도 진입) */}
          <a href="/cpx" className="cpx-banner">
            <div className="cpx-banner-top">
              <span className="cpx-banner-icon"><Stethoscope className="w-5 h-5" strokeWidth={2} /></span>
              <span className="cpx-banner-badge">CPX</span>
            </div>
            <h2 className="cpx-banner-title">CPX 실전 연습</h2>
            <p className="cpx-banner-desc">AI 표준화 환자와 12분 진료 세션 · 음성/텍스트 문진 · 부위별 신체진찰 · 루브릭 채점</p>
            <div className="cpx-banner-meta">
              <span><strong>{cpxStats?.cases ?? '…'}</strong> 증례</span>
              <span><strong>{cpxStats?.categories ?? '…'}</strong> 주호소</span>
            </div>
            <span className="cpx-banner-cta"><Play className="w-4 h-4" strokeWidth={2.4} /> 연습 시작</span>
          </a>
        </section>

        {totalQuestions > 0 && (
          <p className="total-line">
            총 <strong className="text-sage-800 tnum">{totalQuestions}</strong>개의 문항이 준비되어 있어요.
          </p>
        )}

        {loadingSubjects ? (
          <div className="ll-card py-20 text-center text-[var(--color-muted)]">과목 불러오는 중...</div>
        ) : subjects.length === 0 ? (
          <div className="ll-card py-16 px-8 text-center text-[var(--color-muted)] leading-relaxed">
            아직 등록된 과목이 없습니다. 시드 문항을 추가하면 표시됩니다.
          </div>
        ) : (
          <><div className="grid-head"><div className="grid-note">카드를 선택하면 해당 과목의 국시형 문제 풀이로 이동합니다.</div></div><section className="grid">
            {sortedSubjects.map((s) => {
              const count = questionCounts[s.id];
              const ready = count === undefined ? s.sub_topics.length > 0 : count > 0;
              return (
                <div
                  key={s.id}
                  className={`subject-card ll-card p-6 flex flex-col items-center text-center ${ready ? 'ready ll-card-hover' : 'disabled opacity-60'}`}
                >
                  <div className="card-top w-full">
                    <div className="subject-title">
                      <span className="subject-icon"><SubjectIcon name={s.name} className="w-6 h-6" strokeWidth={1.9} /></span>
                      <h3>{s.name}</h3>
                    </div>
                    <span className={`status ${ready ? 'ready' : 'locked'}`}>{ready ? 'READY' : '준비 중'}</span>
                  </div>
                  <p className="subject-desc">{s.sub_topics.slice(0, 4).map((topic) => topic.name).join(' · ') || '세부 주제를 준비하고 있습니다.'}</p>
                  <div className="metrics">
                    <div className="metric"><span>문항</span><strong>{countOrDots(count ?? 0)}</strong></div>
                    <div className="metric"><span>주제</span><strong>{s.sub_topics.length}</strong></div>
                  </div>

                  {ready ? (
                    <Button className="start-btn" onClick={() => openSubject(s)} fullWidth>
                      <Play className="w-4 h-4" strokeWidth={2.4} />
                      학습 시작
                    </Button>
                  ) : (
                    <div className="locked-btn">
                      준비 중
                    </div>
                  )}
                </div>
              );
            })}
          </section></>
        )}
      </div>
    );
  }

  // ============================================================
  // 상세 뷰 — 좌: 세부주제 사이드바 / 우: 탭 + 문제 카드 or 풀이
  // ============================================================
  const mids = midsOf(selectedSubject);
  const detailMeta = mids.slice(0, 5).map((m) => m.name).join(' · ');

  return (
    <div className="ll-exam-page">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div className="min-w-0 flex flex-col items-start">
          <button
            onClick={backToBrowse}
            className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--color-muted)] hover:text-sage-800 transition-colors mb-2.5"
          >
            <ChevronLeft className="w-4 h-4" />
            과목 선택
          </button>
          <span className="ll-eyebrow mb-1.5">
            <GraduationCap className="w-3.5 h-3.5" strokeWidth={2.4} />
            국시 대비 · {selectedSubject.name}
          </span>
          <h1 className="text-[1.9rem] leading-[1.15] font-bold text-sage-800 tracking-[-0.02em]">
            {selectedSubject.name} 임상추론
          </h1>
          {detailMeta && (
            <p className="mt-2 text-[15px] text-[var(--color-muted)] leading-relaxed">{detailMeta}</p>
          )}
        </div>
      </div>

      {/* 전용 클래스 사용 — 과목 카드 그리드용 `.ll-exam-page .grid`(3등분)와 충돌 방지 */}
      <div className="exam-detail-layout items-start">
        {/* 좌측: 세부주제 */}
        <div className="ll-card p-3 md:sticky md:top-6">
          <div className="flex items-center gap-2 px-2 pb-2.5 mb-1.5 border-b border-[var(--color-border)]">
            <BookOpen className="w-4 h-4 text-[var(--color-sage-600)]" strokeWidth={2} />
            <span className="text-[13px] font-bold text-sage-800 tracking-tight">세부주제</span>
          </div>
          <div className="space-y-0.5 max-h-[70vh] overflow-y-auto pr-0.5">
            {/* 전체 */}
            <button
              onClick={() => setActive(null)}
              className={`w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-left text-[13px] transition-colors ${
                active === null ? 'bg-sage-700 text-white font-semibold' : 'text-sage-800 hover:bg-[var(--color-sage-100)]'
              }`}
            >
              <span>전체</span>
              <span className={`text-[11px] tnum ${active === null ? 'text-white/80' : 'text-[var(--color-muted)]'}`}>
                {countOrDots(questionCounts[selectedSubject.id] ?? 0)}
              </span>
            </button>

            {mids.length === 0 ? (
              <div className="text-[11px] text-[var(--color-muted)] px-2.5 py-2">세부주제 준비 중</div>
            ) : (
              mids.map((mid) => {
                const leaves = leavesOf(selectedSubject, mid.id);
                const midCount =
                  (stCount[mid.id] ?? 0) + leaves.reduce((sum, l) => sum + (stCount[l.id] ?? 0), 0);
                const midOpen = expandedMid[mid.id];
                const isActive = active?.subTopicId === mid.id;
                return (
                  <div key={mid.id}>
                    <button
                      onClick={() => (leaves.length > 0 ? toggleMid(mid.id) : openSubTopic(mid, selectedSubject.name))}
                      className={`w-full flex items-center gap-1.5 px-2.5 py-2 rounded-lg text-left text-[13px] transition-colors ${
                        isActive ? 'bg-sage-700 text-white font-semibold' : 'text-sage-800 hover:bg-[var(--color-sage-100)]'
                      }`}
                    >
                      {mid.is_risk_category && (
                        <AlertTriangle
                          className={`w-3 h-3 flex-shrink-0 ${isActive ? 'text-white' : 'text-[var(--color-warn)]'}`}
                        />
                      )}
                      <span className="flex-1 truncate">{mid.name}</span>
                      <span className={`text-[11px] tnum ${isActive ? 'text-white/80' : 'text-[var(--color-muted)]'}`}>
                        {countOrDots(midCount)}
                      </span>
                      {leaves.length > 0 &&
                        (midOpen ? (
                          <ChevronDown className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-white' : 'text-[var(--color-muted)]'}`} />
                        ) : (
                          <ChevronRight className={`w-3.5 h-3.5 flex-shrink-0 ${isActive ? 'text-white' : 'text-[var(--color-muted)]'}`} />
                        ))}
                    </button>
                    {midOpen && leaves.length > 0 && (
                      <div className="ml-3 border-l border-[var(--color-border)] pl-1.5 my-0.5">
                        {leaves.map((leaf) => {
                          const leafActive = active?.subTopicId === leaf.id;
                          return (
                            <button
                              key={leaf.id}
                              onClick={() => openSubTopic(leaf, selectedSubject.name)}
                              className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-left text-[12px] transition-colors ${
                                leafActive
                                  ? 'bg-sage-700 text-white font-semibold'
                                  : 'text-[var(--color-muted)] hover:bg-[var(--color-sage-100)] hover:text-sage-800'
                              }`}
                            >
                              {leaf.is_risk_category && (
                                <AlertTriangle className={`w-3 h-3 flex-shrink-0 ${leafActive ? 'text-white' : 'text-[var(--color-warn)]'}`} />
                              )}
                              <span className="flex-1 truncate">{leaf.name}</span>
                              <span className={`text-[11px] tnum ${leafActive ? 'text-white/80' : 'text-[var(--color-muted)]'}`}>
                                {countOrDots(stCount[leaf.id] ?? 0)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* 우측: 문제 카드 그리드(전체) 또는 풀이 화면(세부주제 선택 시) */}
        <div>
          {active === null ? (
            <div className="ll-card py-20 px-8 text-center">
              <div className="flex justify-center mb-4">
                <span className="ll-chip" style={{ width: '3rem', height: '3rem' }}>
                  <BookOpen className="w-6 h-6" strokeWidth={1.8} />
                </span>
              </div>
              <div className="text-lg text-sage-800 font-bold mb-1.5 tracking-tight">세부주제를 선택하세요</div>
              <div className="text-sm text-[var(--color-muted)]">
                왼쪽에서 세부주제를 누르면 해당 문제를 바로 풀 수 있어요.
              </div>
            </div>
          ) : loadingQuestions ? (
            <div className="ll-card py-20 text-center text-[var(--color-muted)]">문항 불러오는 중...</div>
          ) : questions.length === 0 ? (
            <div className="ll-card py-16 px-8 text-center">
              <div className="flex justify-center mb-4">
                <span className="ll-chip ll-chip-gold" style={{ width: '3rem', height: '3rem' }}>
                  <AlertTriangle className="w-6 h-6" strokeWidth={1.8} />
                </span>
              </div>
              <div className="text-lg text-sage-800 font-bold mb-1.5 tracking-tight">{active.name}</div>
              <div className="text-sm text-[var(--color-muted)] mb-5">이 세부주제에는 아직 출제 가능한 문항이 없습니다.</div>
              <button
                onClick={() => setActive(null)}
                className="inline-flex items-center gap-1 text-[13px] font-semibold text-sage-700 hover:text-sage-800 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                문제 목록으로
              </button>
            </div>
          ) : finished ? (
            <FinishedView
              subTopicName={active.name}
              results={results}
              wrongResults={wrongResults}
              checked={checked}
              setChecked={setChecked}
              savedNote={savedNote}
              onSave={saveToNotes}
              onRetry={() =>
                active && openSubTopic({ id: active.subTopicId, name: active.name } as SubTopic, active.subjectName)
              }
              onBack={() => setActive(null)}
            />
          ) : (
            current && (
              <>
                <button
                  onClick={() => setActive(null)}
                  className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--color-muted)] hover:text-sage-800 transition-colors mb-3"
                >
                  <ChevronLeft className="w-4 h-4" />
                  문제 목록
                </button>

                <div className="ll-card p-5 mb-4">
                  <div className="flex items-center justify-between gap-3 mb-3.5">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="ll-chip" style={{ width: '2.25rem', height: '2.25rem' }}>
                        <Target className="w-4 h-4" strokeWidth={2} />
                      </span>
                      <div className="min-w-0">
                        <div className="text-[12px] font-semibold text-sage-600 truncate">{active.subjectName}</div>
                        <div className="text-[15px] font-bold text-sage-800 tracking-tight truncate">{active.name}</div>
                      </div>
                    </div>
                    <span className="text-sm text-[var(--color-muted)] whitespace-nowrap">
                      문항 <strong className="text-sage-800 tnum">{idx + 1}</strong> / {questions.length}
                    </span>
                  </div>
                  <div className="w-full h-2 bg-[var(--color-sage-200)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-sage-700 rounded-full transition-all"
                      style={{ width: `${((idx + 1) / questions.length) * 100}%` }}
                    />
                  </div>
                </div>

                <Card className="mb-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap mb-5">
                    <div className="flex gap-2 flex-wrap">
                      <Badge>{current.subTopicName}</Badge>
                      <Badge variant="warn">난이도 {'★'.repeat(current.difficulty)}</Badge>
                    </div>
                    <Badge variant={current.badge.color}>{current.badge.label}</Badge>
                  </div>

                  <div className="whitespace-pre-line text-[17px] leading-8 text-sage-800 mb-6">
                    <strong className="text-sage-700">{idx + 1}.</strong> {current.stem}
                  </div>

                  {current.imageUrl && (
                    <div className="relative mb-3 bg-sage-900 rounded-lg overflow-hidden">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={current.imageUrl}
                        alt="medical"
                        className="w-full max-h-[70vh] object-contain cursor-zoom-in"
                        onClick={() => setZoomImage(current.imageUrl)}
                      />
                      <button
                        onClick={() => setZoomImage(current.imageUrl)}
                        aria-label="이미지 확대"
                        className="absolute bottom-3 right-3 w-9 h-9 rounded-full bg-black/55 hover:bg-black/75 text-white flex items-center justify-center transition-colors"
                      >
                        <ZoomIn className="w-5 h-5" />
                      </button>
                    </div>
                  )}

                  <div className="space-y-2">
                    {current.choices.map((choice, i) => {
                      const isSelected = selected === i;
                      const isCorrect = result && i === result.correct_index;
                      const isWrong = result && result.correct_index !== i && selected === i;
                      return (
                        <button
                          key={i}
                          onClick={() => !result && setSelected(i)}
                          disabled={result !== null}
                          className={`w-full text-left p-3.5 px-4 rounded-xl border flex items-center gap-3 transition-all ${
                            isCorrect
                              ? 'bg-[var(--color-curated-bg)] border-sage-600'
                              : isWrong
                                ? 'bg-[var(--color-warn-bg)] border-[var(--color-warn)]'
                                : isSelected
                                  ? 'bg-[var(--color-sage-100)] border-sage-600 shadow-[0_1px_2px_rgba(24,40,32,0.05)]'
                                  : 'bg-white border-[var(--color-border)] hover:border-sage-400 hover:bg-[var(--color-sage-50)]'
                          }`}
                        >
                          <span
                            className={`w-7 h-7 rounded-full border flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                              isCorrect
                                ? 'bg-sage-700 text-white border-sage-700'
                                : isWrong
                                  ? 'bg-[var(--color-warn)] text-white border-[var(--color-warn)]'
                                  : isSelected
                                    ? 'bg-sage-700 text-white border-sage-700'
                                    : 'border-[var(--color-sage-400)] text-[var(--color-muted)]'
                            }`}
                          >
                            {i + 1}
                          </span>
                          <span className="text-[15px] text-sage-800 flex-1">{choice}</span>
                          {isCorrect && <CheckCircle2 className="w-5 h-5 text-sage-700 flex-shrink-0" />}
                          {isWrong && <XCircle className="w-5 h-5 text-[var(--color-warn)] flex-shrink-0" />}
                        </button>
                      );
                    })}
                  </div>

                  {result && result.explanation && (
                    <div className="mt-5 ll-tint rounded-2xl p-5 border border-[var(--color-border)]">
                      <span className="ll-eyebrow mb-3">해설</span>
                      <div className="text-sm text-sage-800 leading-relaxed whitespace-pre-line">{result.explanation}</div>
                    </div>
                  )}
                </Card>

                <div className="flex justify-end">
                  {!result ? (
                    <Button variant="accent" onClick={submit} disabled={selected === null} loading={submitting}>
                      제출하고 채점
                    </Button>
                  ) : (
                    <Button onClick={next}>
                      {idx === questions.length - 1 ? '결과 보기' : '다음 문제'}
                      <ChevronRight className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </>
            )
          )}
        </div>
      </div>

      {zoomImage && (
        <div
          className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-4 cursor-zoom-out"
          onClick={() => setZoomImage(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoomImage} alt="확대된 문항 이미지" className="max-w-[95vw] max-h-[92vh] object-contain rounded-lg" />
          <button
            onClick={() => setZoomImage(null)}
            aria-label="닫기"
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/15 hover:bg-white/30 text-white flex items-center justify-center transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
      )}
    </div>
  );
}

function FinishedView({
  subTopicName,
  results,
  wrongResults,
  checked,
  setChecked,
  savedNote,
  onSave,
  onRetry,
  onBack,
}: {
  subTopicName: string;
  results: SetResult[];
  wrongResults: SetResult[];
  checked: Set<string>;
  setChecked: (s: Set<string>) => void;
  savedNote: boolean;
  onSave: () => void;
  onRetry: () => void;
  onBack: () => void;
}) {
  const correctCount = results.filter((r) => r.isCorrect).length;
  const pct = results.length === 0 ? 0 : Math.round((correctCount / results.length) * 100);

  function toggleCheck(id: string) {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  }

  return (
    <div>
      <button
        onClick={onBack}
        className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--color-muted)] hover:text-sage-800 transition-colors mb-3"
      >
        <ChevronLeft className="w-4 h-4" />
        문제 목록
      </button>

      <div className="ll-card ll-tint mb-4 text-center py-10 px-8">
        <div className="flex justify-center mb-4">
          <span className="ll-chip" style={{ width: '3.25rem', height: '3.25rem' }}>
            <CheckCircle2 className="w-7 h-7" strokeWidth={1.8} />
          </span>
        </div>
        <div className="flex justify-center mb-4">
          <span className="ll-eyebrow">{subTopicName} · 완료</span>
        </div>
        <div className="ll-stat text-[3.5rem] font-bold leading-none">
          {correctCount}
          <span className="text-2xl text-[var(--color-muted)] font-semibold"> / {results.length}</span>
        </div>
        <div className="text-base text-sage-700 font-semibold mt-3">정답률 {pct}%</div>
      </div>

      {wrongResults.length > 0 ? (
        <Card
          icon={<BookmarkPlus className="w-5 h-5" strokeWidth={2} />}
          tone="accent"
          title={`오답 ${wrongResults.length}개`}
          description="오답노트에 담을 문제를 선택하세요."
          className="mb-4"
        >
          <div className="space-y-2 mb-4">
            {wrongResults.map((r) => (
              <label
                key={r.questionId}
                className="flex items-start gap-3 p-3.5 rounded-xl border border-[var(--color-border)] cursor-pointer hover:border-sage-400 hover:bg-[var(--color-sage-50)] transition-all"
              >
                <input
                  type="checkbox"
                  checked={checked.has(r.questionId)}
                  onChange={() => toggleCheck(r.questionId)}
                  className="mt-1 accent-[var(--color-primary)]"
                />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-sage-800 line-clamp-2">{r.stem}</div>
                  <div className="text-xs text-[var(--color-warn)] mt-1">
                    내 답 {r.selected + 1}번 · 정답 {r.correctIndex + 1}번
                  </div>
                </div>
              </label>
            ))}
          </div>
          {savedNote ? (
            <div className="flex items-center justify-center gap-2 text-sm text-sage-700 bg-[var(--color-curated-bg)] border border-[var(--color-sage-500)] rounded-xl p-3.5 text-center font-semibold">
              <CheckCircle2 className="w-4 h-4" strokeWidth={2.2} />
              선택한 문제를 오답노트에 담았습니다.
            </div>
          ) : (
            <Button onClick={onSave} fullWidth>
              <BookmarkPlus className="w-4 h-4" />
              선택한 오답 노트에 담기
            </Button>
          )}
        </Card>
      ) : (
        <div className="ll-card mb-4 text-center py-10 px-8">
          <div className="flex justify-center mb-3">
            <span className="ll-chip" style={{ width: '3rem', height: '3rem' }}>
              <CheckCircle2 className="w-6 h-6" strokeWidth={1.8} />
            </span>
          </div>
          <div className="text-lg text-sage-800 font-bold tracking-tight">전부 맞혔습니다!</div>
          <div className="text-sm text-[var(--color-muted)] mt-1">완벽해요. 다음 주제로 넘어가 볼까요?</div>
        </div>
      )}

      <Button variant="accent" onClick={onRetry} fullWidth>
        <RotateCcw className="w-4 h-4" />
        새 문항으로 다시 풀기
      </Button>
    </div>
  );
}

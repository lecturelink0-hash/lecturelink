'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api/client';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  StickyNote, Calculator as CalcIcon, ChevronLeft, ChevronRight,
  Clock, Check, CheckCircle2, XCircle, BookmarkPlus, X, Send, ArrowLeft,
  Pencil, Eraser, Columns2, Square,
} from 'lucide-react';
import { ScrollExamView } from './ScrollExamView';
import { ExamResultView } from './ExamResultView';

interface MockQuestion {
  id: string;
  stem: string;
  choices: string[];
  difficulty: 1 | 2 | 3;
  imageUrl: string | null;
  imageType: string | null;
  tier: 'curated' | 'community' | 'beta';
  badge: { label: string; color: 'curated' | 'community' | 'beta' };
  subjectName: string;
  subTopicName: string;
  subTopicId?: string | null;
  answerIndex?: number;
  explanation?: string | null;
}
interface SessionInfo {
  id: string;
  title: string;
  status: 'in_progress' | 'submitted' | 'abandoned';
  total: number;
  score: number | null;
  answers: number[];
  flagged: number[];
  memo: string | null;
  durationSeconds: number | null;
  startedAt: string;
  submittedAt: string | null;
}
interface SessionData {
  session: SessionInfo;
  questions: MockQuestion[];
}

const CIRCLED = ['①', '②', '③', '④', '⑤'];

/** 지문(case) 과 물음(question) 을 마지막 물음표 기준으로 분리 — 실제 CBT 처럼 좌: 지문, 우: 물음+보기 */
function splitStem(stem: string): { vignette: string; question: string } {
  const q = stem.lastIndexOf('?');
  if (q < 0) return { vignette: stem, question: '' };
  let start = 0;
  const boundary = /[.?!]\s+/g;
  let m: RegExpExecArray | null;
  const head = stem.slice(0, q);
  while ((m = boundary.exec(head)) !== null) start = m.index + m[0].length;
  const vignette = stem.slice(0, start).trim();
  const question = stem.slice(start).trim();
  // 지문이 너무 짧으면 분리하지 않고 전체를 지문으로
  if (vignette.length < 20) return { vignette: stem, question: '' };
  return { vignette, question };
}

function safeParseMemos(raw: string | null): Record<number, string> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw);
    if (o && typeof o === 'object' && !Array.isArray(o)) return o as Record<number, string>;
  } catch {
    /* legacy 단일 메모 → 무시 */
  }
  return {};
}

export default function MockExamPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [data, setData] = useState<SessionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [examinee, setExaminee] = useState<string>('응시자');
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<number[]>([]);
  const [flagged, setFlagged] = useState<number[]>([]);
  const [memos, setMemos] = useState<Record<number, string>>({});
  const [eliminated, setEliminated] = useState<Record<number, number[]>>({});
  const [highlights, setHighlights] = useState<Record<number, [number, number][]>>({});
  const [hlOn, setHlOn] = useState(false);
  const [fontScale, setFontScale] = useState(1);
  const [cols, setCols] = useState<1 | 2>(2);
  const [overlay, setOverlay] = useState<'none' | 'calc' | 'draw' | 'memo'>('none');
  const [remaining, setRemaining] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savedNotes, setSavedNotes] = useState<Set<string>>(new Set());

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passageRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<SessionData>(`/api/mock-exams/${id}`);
      setData(res);
      setAnswers(res.session.answers?.length ? res.session.answers : Array(res.session.total).fill(-1));
      setFlagged(res.session.flagged ?? []);
      setMemos(safeParseMemos(res.session.memo));
    } catch (e) {
      alert(e instanceof ApiError ? e.message : '모의고사를 불러오지 못했습니다.');
      router.push('/mock');
    } finally {
      setLoading(false);
    }
  }, [id, router]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api.get<{ displayName: string | null }>('/api/me')
      .then((m) => { if (m?.displayName) setExaminee(m.displayName); })
      .catch(() => {});
  }, []);

  const submitted = data?.session.status === 'submitted';

  // 타이머
  useEffect(() => {
    if (!data || submitted || !data.session.durationSeconds) return;
    const startMs = new Date(data.session.startedAt).getTime();
    const total = data.session.durationSeconds;
    const tick = () => {
      const elapsed = Math.floor((Date.now() - startMs) / 1000);
      const left = total - elapsed;
      setRemaining(left);
      if (left <= 0) {
        clearInterval(t);
        void doSubmit();
      }
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, submitted]);

  function scheduleSave(nextAnswers: number[], nextFlagged: number[], nextMemos: Record<number, string>) {
    if (submitted) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void api
        .patch(`/api/mock-exams/${id}`, {
          answers: nextAnswers,
          flagged: nextFlagged,
          memo: JSON.stringify(nextMemos),
          action: 'save',
        })
        .catch(() => {});
    }, 1000);
  }

  function chooseFor(qi: number, ci: number) {
    if (submitted) return;
    const next = [...answers];
    next[qi] = ci;
    setAnswers(next);
    scheduleSave(next, flagged, memos);
  }

  function toggleFlag(qi = idx) {
    const next = flagged.includes(qi) ? flagged.filter((f) => f !== qi) : [...flagged, qi];
    setFlagged(next);
    scheduleSave(answers, next, memos);
  }

  function toggleEliminate(qi: number, ci: number) {
    if (submitted) return;
    setEliminated((prev) => {
      const cur = new Set(prev[qi] ?? []);
      if (cur.has(ci)) cur.delete(ci);
      else cur.add(ci);
      return { ...prev, [qi]: [...cur] };
    });
  }

  function setMemo(qi: number, text: string) {
    const next = { ...memos, [qi]: text };
    setMemos(next);
    scheduleSave(answers, flagged, next);
  }

  // ── 형광펜 ──
  function charOffset(root: Node, node: Node, offset: number): number {
    let total = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n: Node | null;
    while ((n = walker.nextNode())) {
      if (n === node) return total + offset;
      total += (n.textContent ?? '').length;
    }
    return total;
  }
  function onPassageMouseUp() {
    if (!hlOn || !passageRef.current) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (!passageRef.current.contains(range.commonAncestorContainer)) return;
    const start = charOffset(passageRef.current, range.startContainer, range.startOffset);
    const end = charOffset(passageRef.current, range.endContainer, range.endOffset);
    if (end > start) {
      setHighlights((prev) => ({ ...prev, [idx]: [...(prev[idx] ?? []), [start, end]] }));
      sel.removeAllRanges();
    }
  }
  function clearHighlights() {
    setHighlights((prev) => ({ ...prev, [idx]: [] }));
  }
  function renderText(text: string, ranges: [number, number][]) {
    if (!ranges || ranges.length === 0) return text;
    const merged: [number, number][] = [];
    [...ranges].sort((a, b) => a[0] - b[0]).forEach((r) => {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    });
    const out: React.ReactNode[] = [];
    let cur = 0;
    merged.forEach(([s, e], i) => {
      if (s > cur) out.push(<span key={`t${i}`}>{text.slice(cur, s)}</span>);
      out.push(<mark key={`h${i}`} className="rounded-[2px] bg-[#fff17a] px-px">{text.slice(s, e)}</mark>);
      cur = e;
    });
    if (cur < text.length) out.push(<span key="tail">{text.slice(cur)}</span>);
    return out;
  }

  async function doSubmit() {
    if (submitting) return;
    setSubmitting(true);
    try {
      await api.patch(`/api/mock-exams/${id}`, { answers, flagged, memo: JSON.stringify(memos), action: 'submit' });
      await load();
      setOverlay('none');
      setIdx(0);
    } catch (e) {
      alert(e instanceof Error ? e.message : '제출 실패');
    } finally {
      setSubmitting(false);
    }
  }

  function confirmSubmit() {
    const unanswered = answers.filter((a) => a < 0).length;
    const msg =
      unanswered > 0
        ? `안 푼 문제가 ${unanswered}개 있습니다. 답안을 제출하시겠습니까?\n제출 후에는 수정할 수 없습니다.`
        : '답안을 제출하고 채점하시겠습니까?\n제출 후에는 수정할 수 없습니다.';
    if (confirm(msg)) void doSubmit();
  }

  async function saveWrongToNotes(q: MockQuestion, selectedIdx: number) {
    try {
      await api.post('/api/wrong-answers', {
        question_id: q.id,
        sub_topic_id: q.subTopicId ?? null,
        selected_index: selectedIdx >= 0 ? selectedIdx : null,
        source: 'mock',
      });
      setSavedNotes((s) => new Set(s).add(q.id));
    } catch (e) {
      alert(e instanceof Error ? e.message : '저장 실패');
    }
  }

  const answeredCount = useMemo(() => answers.filter((a) => a >= 0).length, [answers]);
  const unansweredCount = (data?.session.total ?? 0) - answeredCount;

  function jumpToFirst(pred: (i: number) => boolean) {
    const total = data?.session.total ?? 0;
    for (let i = 0; i < total; i++) if (pred(i)) { setIdx(i); return; }
  }

  if (loading || !data) {
    return (
      <div className="text-center py-24 text-[var(--color-muted)]">
        <Clock className="w-8 h-8 mx-auto mb-3 animate-pulse text-[var(--color-sage-400)]" />
        모의고사 불러오는 중...
      </div>
    );
  }

  // ─────────── 결과 모드 (채점·리뷰) ───────────
  if (submitted) {
    const s = data.session;
    const pct = s.total === 0 ? 0 : Math.round(((s.score ?? 0) / s.total) * 100);
    return (
      <ExamResultView title={s.title} score={s.score ?? 0} answers={answers} questions={data.questions} saved={savedNotes} onBack={() => router.push('/mock')} onRetry={() => router.push('/mock')} onSave={(question, selected) => saveWrongToNotes(question as MockQuestion, selected)} />
    );
    function renderLegacyResult(data: SessionData) { return (
      <div className="ll-exam-result-page pb-10">
        <button
          onClick={() => router.push('/mock')}
          className="flex items-center gap-1.5 text-sm text-[var(--color-muted)] hover:text-sage-700 mb-4"
        >
          <ArrowLeft className="w-4 h-4" /> 모의고사 목록
        </button>

        <div className="bg-[linear-gradient(135deg,#f8fcf7,#edf7ec)] border border-[#c5dec9] rounded-2xl p-8 text-center mb-6 shadow-[0_10px_30px_-24px_rgba(31,92,67,.3)]">
          <div className="text-sm text-[var(--color-muted)] mb-1">{s.title}</div>
          <div className="text-5xl font-bold text-sage-800 mb-1 tnum">
            {s.score} <span className="text-2xl text-[var(--color-muted)]">/ {s.total}</span>
          </div>
          <div className="text-sage-700 font-semibold">정답률 {pct}%</div>
        </div>

        <h2 className="text-sm font-bold text-sage-800 mb-3">문항별 리뷰</h2>
        <div className="space-y-4">
          {data.questions.map((q, i) => {
            const sel = answers[i] ?? -1;
            const correct = q.answerIndex ?? -1;
            const ok = sel === correct;
            return (
              <div key={q.id} className="bg-white border border-[var(--color-border)] rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                        ok ? 'bg-[var(--color-curated-bg)] text-sage-700' : 'bg-[var(--color-warn-bg)] text-[var(--color-warn)]'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <Badge>{q.subTopicName}</Badge>
                    {ok ? (
                      <CheckCircle2 className="w-4 h-4 text-sage-700" />
                    ) : (
                      <XCircle className="w-4 h-4 text-[var(--color-warn)]" />
                    )}
                  </div>
                  {!ok &&
                    (savedNotes.has(q.id) ? (
                      <span className="text-xs text-sage-700 font-medium">✓ 오답노트 담음</span>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => saveWrongToNotes(q, sel)}>
                        <BookmarkPlus className="w-3.5 h-3.5" />
                        오답노트
                      </Button>
                    ))}
                </div>
                <div className="text-[15px] leading-7 text-sage-800 mb-3">{q.stem}</div>
                <div className="space-y-1.5">
                  {q.choices.map((c, ci) => {
                    const isCorrect = ci === correct;
                    const isMine = ci === sel;
                    return (
                      <div
                        key={ci}
                        className={`p-2.5 px-3 rounded-lg border text-sm flex items-center gap-2 ${
                          isCorrect
                            ? 'bg-[var(--color-curated-bg)] border-sage-600 text-sage-800'
                            : isMine
                              ? 'bg-[var(--color-warn-bg)] border-[var(--color-warn)] text-sage-800'
                              : 'border-[var(--color-border)] text-sage-800'
                        }`}
                      >
                        <span className="font-semibold w-5">{ci + 1}</span>
                        <span className="flex-1">{c}</span>
                        {isCorrect && <span className="text-[11px] text-sage-700 font-semibold">정답</span>}
                        {isMine && !isCorrect && <span className="text-[11px] text-[var(--color-warn)] font-semibold">내 답</span>}
                      </div>
                    );
                  })}
                </div>
                {q.explanation && (
                  <div className="mt-3 p-3 bg-[var(--color-sage-100)] rounded-lg">
                    <div className="text-[11px] font-bold text-sage-700 mb-1">해설</div>
                    <div className="text-sm text-sage-800 leading-relaxed whitespace-pre-line">{q.explanation}</div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    ); }
    void renderLegacyResult;
  }

  // ─────────── 풀이 모드 (실제 CBT 재현) ───────────
  const q = data.questions[idx];
  const total = data.session.total;
  const { vignette, question } = splitStem(q.stem);
  const fs = Math.round(16 * fontScale);
  const examNo = (id.replace(/[^0-9]/g, '') + '00000000').slice(0, 8);
  const NAVY = '#1f5c43';

  const choiceBlock = (
    <div className="rounded-md border border-[#d7dbe3] bg-white p-4 sm:p-5">
      {/* 문항 도구 (체크문제 / 메모) */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <span className="text-[#3a52a0] font-bold" style={{ fontSize: fs }}>{idx + 1}.</span>{' '}
          {question ? (
            <span className="text-[#1a1f2b] font-medium" style={{ fontSize: fs }}>{question}</span>
          ) : (
            <span className="text-[#5a6172]" style={{ fontSize: fs }}>다음 중 옳은 것을 고르시오.</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() => toggleFlag()}
            className={`flex h-8 w-14 flex-col items-center justify-center gap-px rounded border text-[10px] leading-none ${
              flagged.includes(idx) ? 'border-[#e0743a] bg-[#fbeee4] text-[#c9622e]' : 'border-[#d7dbe3] bg-[#f6f7f9] text-[#5a6172] hover:bg-[#eef0f4]'
            }`}
          >
            <Check className="w-3 h-3" strokeWidth={2.5} />체크문제
          </button>
          <button
            onClick={() => setOverlay('memo')}
            className={`flex h-8 w-14 flex-col items-center justify-center gap-px rounded border text-[10px] leading-none ${
              memos[idx] ? 'border-[#3a52a0] bg-[#eaeefb] text-[#2c3f86]' : 'border-[#d7dbe3] bg-[#f6f7f9] text-[#5a6172] hover:bg-[#eef0f4]'
            }`}
          >
            <StickyNote className="w-3 h-3" />메모
          </button>
        </div>
      </div>

      {q.imageUrl && (
        <div className="mb-3 bg-[#f6f7f9] border border-[#e3e6ec] rounded h-56 flex items-center justify-center overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={q.imageUrl} alt="문항 이미지" className="max-h-full max-w-full object-contain" />
        </div>
      )}

      <div className="space-y-1">
        {q.choices.map((c, ci) => {
          const selected = answers[idx] === ci;
          const struck = (eliminated[idx] ?? []).includes(ci);
          return (
            <div key={ci} className="flex items-center gap-2">
              <button
                onClick={() => chooseFor(idx, ci)}
                className={`group flex flex-1 items-center gap-3 rounded px-3 py-2.5 text-left transition-colors ${
                  selected ? 'bg-[#eaf3ed] ring-1 ring-[#1f5c43]' : 'hover:bg-[#f4f1e8]'
                }`}
              >
                <span
                  className={`flex-shrink-0 font-semibold ${selected ? 'text-[#1f5c43]' : 'text-[#3a3f4b]'}`}
                  style={{ fontSize: fs + 2 }}
                >
                  {CIRCLED[ci]}
                </span>
                <span
                  className={`flex-1 ${struck ? 'text-[#aab0bd] line-through decoration-[#c9622e]' : 'text-[#1a1f2b]'}`}
                  style={{ fontSize: fs }}
                >
                  {c}
                </span>
              </button>
              <button
                onClick={() => toggleEliminate(idx, ci)}
                title="오답 표시 (지우기)"
                className={`flex-shrink-0 rounded border px-2 py-1 text-[11px] ${
                  struck ? 'border-[#c9622e] bg-[#fbeee4] text-[#c9622e]' : 'border-[#d7dbe3] bg-[#f6f7f9] text-[#8a91a0] hover:bg-[#eef0f4]'
                }`}
              >
                오답
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );

  const passageBlock = (
    <div className="rounded-md border border-[#d7dbe3] bg-white p-4 sm:p-5 h-full">
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="text-[#143c2c] font-bold" style={{ fontSize: fs + 3 }}>[문항 {idx + 1}]</div>
          <div className="text-[#7c8496] mt-0.5" style={{ fontSize: fs - 3 }}>
            {q.subjectName} · {q.subTopicName}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <button
            onClick={() => setHlOn((v) => !v)}
            className={`rounded border px-2 py-1 text-[11px] leading-tight ${
              hlOn ? 'border-[#e6b800] bg-[#fff9d6] text-[#8a7300]' : 'border-[#d7dbe3] bg-[#f6f7f9] text-[#5a6172] hover:bg-[#eef0f4]'
            }`}
          >
            형광펜 {hlOn ? '켜짐' : '꺼짐'}
          </button>
          <button
            onClick={clearHighlights}
            className="rounded border border-[#d7dbe3] bg-[#f6f7f9] px-2 py-1 text-[11px] leading-tight text-[#5a6172] hover:bg-[#eef0f4]"
          >
            형광펜 지우기
          </button>
        </div>
      </div>
      <div
        ref={passageRef}
        onMouseUp={onPassageMouseUp}
        className={`whitespace-pre-line leading-[1.9] text-[#1a1f2b] ${hlOn ? 'cursor-text selection:bg-[#fff17a]' : ''}`}
        style={{ fontSize: fs }}
      >
        {renderText(vignette, highlights[idx] ?? [])}
      </div>
    </div>
  );

  const fmtTime = (sec: number) => {
    const s = Math.max(0, sec);
    return `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`;
  };

  return (
    <ScrollExamView
      title={data.session.title}
      questions={data.questions}
      answers={answers}
      flagged={flagged}
      remaining={remaining}
      submitting={submitting}
      onChoose={chooseFor}
      onFlag={toggleFlag}
      onSubmit={confirmSubmit}
    />
  );

  function renderLegacy(data: SessionData, remaining: number) { return (
    <div className="ll-exam-session-page fixed inset-0 z-50 flex flex-col bg-[#fcfaf4] text-[#111827]">
      {/* ─── 상단 응시 정보 바 ─── */}
      <header className="flex items-center gap-4 px-4 py-2 text-white" style={{ background: NAVY }}>
        <div className="flex items-center gap-3 min-w-0">
          <span className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-white/15 text-lg font-bold ring-2 ring-white/30">
            01
          </span>
          <div className="leading-tight text-[13px]">
            <div>응시번호: <span className="font-semibold tnum">{examNo}</span></div>
            <div>성명: <span className="font-semibold">{examinee}</span></div>
          </div>
        </div>

        <div className="flex-1 text-center font-bold tracking-tight text-lg sm:text-xl truncate">
          보건의료인 CBT · {data.session.title}
        </div>

        {/* 글자 크기 */}
        <div className="hidden md:flex items-center gap-2">
          <span className="text-[11px] leading-tight text-white/80 text-center">글자<br />크기</span>
          <div className="flex overflow-hidden rounded-md">
            {([[0.9, '가', 'text-sm'], [1, '가', 'text-base'], [1.25, '가', 'text-lg']] as const).map(([sc, label, sz]) => (
              <button
                key={sc}
                onClick={() => setFontScale(sc)}
                className={`px-3 py-1.5 font-bold ${sz} ${
                  fontScale === sc ? 'bg-[#d9a82f] text-[#111827]' : 'bg-white text-[#143c2c] hover:bg-[#eaf3ed]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 화면 배치 */}
        <div className="hidden lg:flex items-center gap-2">
          <span className="text-[11px] leading-tight text-white/80 text-center">화면<br />배치</span>
          <div className="flex gap-1">
            <button
              onClick={() => setCols(1)}
              title="1단 보기"
              className={`rounded p-1.5 ${cols === 1 ? 'bg-[#d9a82f]' : 'bg-white/15 hover:bg-white/25'}`}
            >
              <Square className="w-5 h-5" />
            </button>
            <button
              onClick={() => setCols(2)}
              title="2단 보기"
              className={`rounded p-1.5 ${cols === 2 ? 'bg-[#d9a82f]' : 'bg-white/15 hover:bg-white/25'}`}
            >
              <Columns2 className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* 제한 / 남은 시간 */}
        <div className="flex items-center gap-2 text-[13px]">
          <Clock className="w-5 h-5 text-[#ff6b6b]" />
          <div className="leading-tight">
            <div>제한시간 : {data.session.durationSeconds ? `${Math.round(data.session.durationSeconds / 60)}분` : '없음'}</div>
            <div className="flex items-center gap-1">
              남은시간 :
              <span className="rounded bg-[#ffe3e3] px-1.5 py-0.5 font-bold tnum text-[#e03131]">
                {remaining !== null ? fmtTime(remaining) : '제한 없음'}
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* ─── 본문: (지문 + 문항)  |  답안 표기란 ─── */}
      <div className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-y-auto p-4">
          <div className={cols === 2 && vignette ? 'grid grid-cols-1 lg:grid-cols-2 gap-4 items-start' : 'max-w-3xl mx-auto space-y-4'}>
            {vignette ? (
              <>
                {passageBlock}
                <div>{choiceBlock}</div>
              </>
            ) : (
              <>
                {/* 지문 분리가 안 되는 문항: 지문 카드에 전체 본문, 아래 보기 */}
                <div className="rounded-md border border-[#d7dbe3] bg-white p-4 sm:p-5">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <div className="text-[#143c2c] font-bold" style={{ fontSize: fs + 3 }}>[문항 {idx + 1}]</div>
                      <div className="text-[#7c8496] mt-0.5" style={{ fontSize: fs - 3 }}>{q.subjectName} · {q.subTopicName}</div>
                    </div>
                    <div className="flex flex-col gap-1">
                      <button onClick={() => setHlOn((v) => !v)} className={`rounded border px-2 py-1 text-[11px] ${hlOn ? 'border-[#e6b800] bg-[#fff9d6] text-[#8a7300]' : 'border-[#d7dbe3] bg-[#f6f7f9] text-[#5a6172]'}`}>형광펜 {hlOn ? '켜짐' : '꺼짐'}</button>
                      <button onClick={clearHighlights} className="rounded border border-[#d7dbe3] bg-[#f6f7f9] px-2 py-1 text-[11px] text-[#5a6172]">형광펜 지우기</button>
                    </div>
                  </div>
                  <div
                    ref={passageRef}
                    onMouseUp={onPassageMouseUp}
                    className={`whitespace-pre-line leading-[1.9] text-[#1a1f2b] ${hlOn ? 'cursor-text selection:bg-[#fff17a]' : ''}`}
                    style={{ fontSize: fs }}
                  >
                    {renderText(q.stem, highlights[idx] ?? [])}
                  </div>
                </div>
                {choiceBlock}
              </>
            )}
          </div>
        </div>

        {/* 답안 표기란 (OMR) */}
        <aside className="hidden sm:flex w-[260px] flex-shrink-0 flex-col border-l border-[#d7dbe3] bg-white">
          <div className="py-2 text-center font-bold text-white" style={{ background: NAVY }}>답안 표기란</div>
          <div className="flex-1 overflow-y-auto px-2 py-2">
            {Array.from({ length: total }).map((_, i) => {
              const current = i === idx;
              const isFlagged = flagged.includes(i);
              return (
                <div
                  key={i}
                  className={`flex items-center gap-1.5 rounded px-1.5 py-1 ${current ? 'bg-[#eaf1ff]' : ''} ${
                    i > 0 && i % 5 === 0 ? 'mt-1 border-t border-dashed border-[#d7dbe3] pt-2' : ''
                  }`}
                >
                  <button
                    onClick={() => setIdx(i)}
                    className={`flex w-7 flex-shrink-0 items-center justify-center gap-0.5 text-[13px] font-bold tnum ${
                      current ? 'text-[#1f5c43]' : 'text-[#6b7280]'
                    }`}
                  >
                    {String(i + 1).padStart(2, '0')}
                    {isFlagged && <span className="text-[#e0743a]">✓</span>}
                  </button>
                  <div className="flex flex-1 justify-between">
                    {[0, 1, 2, 3, 4].map((c) => {
                      const on = answers[i] === c;
                      return (
                        <button
                          key={c}
                          onClick={() => { setIdx(i); chooseFor(i, c); }}
                          className={`flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold transition-colors ${
                            on ? 'border-[#1f5c43] bg-[#1f5c43] text-white' : 'border-[#d8e8dd] text-[#6b7280] hover:border-[#1f5c43]'
                          }`}
                        >
                          {c + 1}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      </div>

      {/* ─── 하단 도구 바 ─── */}
      <footer className="flex items-center justify-between gap-2 border-t border-[#d7dbe3] bg-white px-3 py-2">
        <div className="flex items-center gap-2">
          <button onClick={() => setOverlay('calc')} className="flex items-center gap-1.5 rounded border border-[#c8cdd8] bg-[#f6f7f9] px-3 py-2 text-sm font-medium text-[#3a3f4b] hover:bg-[#eef0f4]">
            <CalcIcon className="w-4 h-4" /> 계산기
          </button>
          <button onClick={() => setOverlay('draw')} className="flex items-center gap-1.5 rounded border border-[#c8cdd8] bg-[#f6f7f9] px-3 py-2 text-sm font-medium text-[#3a3f4b] hover:bg-[#eef0f4]">
            <Pencil className="w-4 h-4" /> 그림판
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0} className="flex items-center gap-1 rounded px-2 py-1.5 text-sm font-medium text-[#3a3f4b] disabled:opacity-40 hover:bg-[#eef0f4]">
            <ChevronLeft className="w-4 h-4" /> 이전
          </button>
          <span className="text-sm font-bold tnum text-[#143c2c]">{idx + 1} / {total}</span>
          <button onClick={() => setIdx((i) => Math.min(total - 1, i + 1))} disabled={idx === total - 1} className="flex items-center gap-1 rounded px-2 py-1.5 text-sm font-medium text-[#3a3f4b] disabled:opacity-40 hover:bg-[#eef0f4]">
            다음 <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => setIdx(0)} className="rounded border border-[#c8cdd8] bg-[#f6f7f9] px-3 py-2 text-[13px] font-medium text-[#3a3f4b] hover:bg-[#eef0f4]">
            전체 문제 <span className="tnum">({total})</span>
          </button>
          <button onClick={() => jumpToFirst((i) => flagged.includes(i))} className="rounded border border-[#c8cdd8] bg-[#f6f7f9] px-3 py-2 text-[13px] font-medium text-[#c9622e] hover:bg-[#eef0f4]">
            체크 문제 <span className="tnum">({flagged.length})</span>
          </button>
          <button onClick={() => jumpToFirst((i) => (answers[i] ?? -1) < 0)} className="rounded border border-[#c8cdd8] bg-[#f6f7f9] px-3 py-2 text-[13px] font-medium text-[#3a3f4b] hover:bg-[#eef0f4]">
            안 푼 문제 <span className="tnum">({unansweredCount})</span>
          </button>
          <button onClick={confirmSubmit} disabled={submitting} className="flex items-center gap-1.5 rounded px-4 py-2 text-sm font-bold text-white disabled:opacity-60" style={{ background: NAVY }}>
            <Send className="w-4 h-4" /> 답안 제출
          </button>
        </div>
      </footer>

      {/* ─── 오버레이: 계산기 / 그림판 / 메모 ─── */}
      {overlay === 'calc' && (
        <Overlay title="계산기" onClose={() => setOverlay('none')}>
          <Calculator />
        </Overlay>
      )}
      {overlay === 'draw' && (
        <Overlay title="그림판" onClose={() => setOverlay('none')} wide>
          <DrawingBoard />
        </Overlay>
      )}
      {overlay === 'memo' && (
        <Overlay title={`메모 — 문항 ${idx + 1}`} onClose={() => setOverlay('none')}>
          <textarea
            value={memos[idx] ?? ''}
            onChange={(e) => setMemo(idx, e.target.value)}
            rows={8}
            placeholder="계산 과정·메모를 자유롭게 작성하세요. 자동 저장됩니다."
            className="w-full rounded-lg border border-[#d7dbe3] p-3 text-sm resize-none focus:border-[#2f6ae0] focus:outline-none"
          />
        </Overlay>
      )}
    </div>
  ); }
  void renderLegacy;
}

/* ─────────── 오버레이(모달) ─────────── */
function Overlay({ children, title, onClose, wide }: { children: React.ReactNode; title: string; onClose: () => void; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className={`rounded-xl border border-[#d7dbe3] bg-white p-5 shadow-lg ${wide ? 'w-full max-w-3xl' : 'w-full max-w-md'}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-bold text-[#1a2b5b]">{title}</h3>
          <button onClick={onClose} className="text-[#8a91a0] hover:text-[#1a2b5b]">
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ─────────── 그림판(간이 캔버스) ─────────── */
function DrawingBoard() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);

  function pos(e: React.MouseEvent) {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function start(e: React.MouseEvent) {
    const ctx = canvasRef.current!.getContext('2d')!;
    const { x, y } = pos(e);
    drawing.current = true;
    ctx.beginPath();
    ctx.moveTo(x, y);
  }
  function move(e: React.MouseEvent) {
    if (!drawing.current) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    const { x, y } = pos(e);
    ctx.lineTo(x, y);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#1a2b5b';
    ctx.stroke();
  }
  function end() { drawing.current = false; }
  function clear() {
    const c = canvasRef.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
  }
  return (
    <div>
      <canvas
        ref={canvasRef}
        width={640}
        height={360}
        onMouseDown={start}
        onMouseMove={move}
        onMouseUp={end}
        onMouseLeave={end}
        className="w-full rounded-lg border border-[#d7dbe3] bg-white cursor-crosshair touch-none"
      />
      <div className="mt-3 flex justify-end">
        <button onClick={clear} className="flex items-center gap-1.5 rounded border border-[#d7dbe3] bg-[#f6f7f9] px-3 py-1.5 text-sm text-[#3a3f4b] hover:bg-[#eef0f4]">
          <Eraser className="w-4 h-4" /> 지우기
        </button>
      </div>
    </div>
  );
}

/* ─────────── 계산기 ─────────── */
function Calculator() {
  const [expr, setExpr] = useState('');
  const [display, setDisplay] = useState('0');

  function press(key: string) {
    if (key === 'C') {
      setExpr('');
      setDisplay('0');
      return;
    }
    if (key === '=') {
      if (!/^[0-9+\-*/.() ]+$/.test(expr) || expr === '') {
        setDisplay('Error');
        return;
      }
      try {
        // eslint-disable-next-line no-new-func
        const result = Function('"use strict"; return (' + expr + ')')();
        setDisplay(String(result));
        setExpr(String(result));
      } catch {
        setDisplay('Error');
      }
      return;
    }
    const next = (expr === '0' ? '' : expr) + key;
    setExpr(next);
    setDisplay(next);
  }

  const keys = ['7', '8', '9', '/', '4', '5', '6', '*', '1', '2', '3', '-', '0', '.', '=', '+'];
  return (
    <div className="max-w-[260px] mx-auto">
      <div className="mb-2 overflow-x-auto rounded-lg bg-[#1a2b5b] px-4 py-3 text-right font-mono text-xl text-white">
        {display}
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        <button onClick={() => press('C')} className="col-span-4 h-10 rounded-lg bg-[#fbeee4] text-sm font-semibold text-[#c9622e]">
          C (초기화)
        </button>
        {keys.map((k) => (
          <button
            key={k}
            onClick={() => press(k)}
            className={`h-11 rounded-lg text-sm font-semibold ${
              ['/', '*', '-', '+', '='].includes(k) ? 'bg-[#2f6ae0] text-white' : 'bg-[#eef1f5] text-[#1a2b5b] hover:bg-[#e2e7f0]'
            }`}
          >
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

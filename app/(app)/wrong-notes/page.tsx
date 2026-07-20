'use client';

import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api/client';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  CheckCircle2,
  XCircle,
  X,
  Folder,
  FolderOpen,
  BookOpen,
  RefreshCw,
  Copy,
} from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface QuestionDetail {
  id: string;
  stem: string;
  choices: string[];
  answerIndex: number;
  explanation: string | null;
  difficulty: 1 | 2 | 3;
  imageUrl: string | null;
  imageType: string | null;
  tier: 'curated' | 'community' | 'beta';
  badge: { label: string; color: 'curated' | 'community' | 'beta' };
}

interface WrongAnswerItem {
  id: string;
  savedAt: string;
  source: string;
  resolved: boolean;
  selectedIndex: number | null;
  isPrivate: boolean;
  question: QuestionDetail | null;
  subjectName: string;
  subTopicName: string;
  subTopicId: string | null;
}

interface SimilarQuestion {
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
  subTopicId: string;
}

interface AttemptResponse {
  is_correct: boolean;
  correct_index: number;
  explanation: string | null;
}

// ─── Per-question UI state ─────────────────────────────────────────────────────

interface QuestionUIState {
  selected: number | null;
  submitted: boolean;
  correctIndex: number | null;
  explanation: string | null;
  expanded: boolean; // 요약 보기에서 펼침 여부
  // 유사문제
  similarQ: SimilarQuestion | null;
  similarLoading: boolean;
  similarSelected: number | null;
  similarSubmitted: boolean;
  similarCorrectIndex: number | null;
  similarExplanation: string | null;
}

function initUIState(expanded = false): QuestionUIState {
  return {
    selected: null,
    submitted: false,
    correctIndex: null,
    explanation: null,
    expanded,
    similarQ: null,
    similarLoading: false,
    similarSelected: null,
    similarSubmitted: false,
    similarCorrectIndex: null,
    similarExplanation: null,
  };
}

// ─── Type filter (오답 카드 상단 필터 탭) ───────────────────────────────────────

const TYPE_FILTERS = [
  { id: 'all', label: '전체' },
  { id: 'private', label: '자료 기반' },
  { id: 'exam', label: '국가고시형' },
  { id: 'image', label: '이미지 문제' },
] as const;

type TypeFilter = (typeof TYPE_FILTERS)[number]['id'];

// ─── Sub-components ───────────────────────────────────────────────────────────

interface ChoicesProps {
  choices: string[];
  selected: number | null;
  submitted: boolean;
  correctIndex: number | null;
  disabled?: boolean;
  onSelect: (i: number) => void;
}

function Choices({ choices, selected, submitted, correctIndex, disabled, onSelect }: ChoicesProps) {
  return (
    <div className="space-y-2">
      {choices.map((choice, i) => {
        const isSelected = selected === i;
        const isCorrect = submitted && i === correctIndex;
        const isWrong = submitted && correctIndex !== null && correctIndex !== i && selected === i;

        return (
          <button
            key={i}
            onClick={() => !submitted && !disabled && onSelect(i)}
            disabled={submitted || disabled}
            className={`w-full text-left p-3 px-4 rounded-lg border flex items-center gap-3 transition-colors ${
              isCorrect
                ? 'bg-[var(--color-curated-bg)] border-sage-600'
                : isWrong
                  ? 'bg-[var(--color-warn-bg)] border-[var(--color-warn)]'
                  : isSelected
                    ? 'bg-[var(--color-sage-200)] border-sage-600'
                    : 'bg-white border-[var(--color-border)] hover:border-sage-600'
            }`}
          >
            <span
              className={`w-6 h-6 rounded-full border flex items-center justify-center text-xs font-semibold flex-shrink-0 ${
                isSelected || isCorrect
                  ? 'bg-sage-700 text-white border-sage-700'
                  : 'border-[var(--color-sage-400)] text-[var(--color-muted)]'
              }`}
            >
              {i + 1}
            </span>
            <span className="text-sm text-sage-800 flex-1">{choice}</span>
            {isCorrect && <CheckCircle2 className="w-5 h-5 text-sage-700 flex-shrink-0" />}
            {isWrong && <XCircle className="w-5 h-5 text-[var(--color-warn)] flex-shrink-0" />}
          </button>
        );
      })}
    </div>
  );
}

interface ExplanationBoxProps {
  explanation: string | null;
  isCorrect: boolean | null;
}

function ExplanationBox({ explanation, isCorrect }: ExplanationBoxProps) {
  return (
    <div className="mt-4 space-y-2">
      <div
        className={`flex items-center gap-2 text-sm font-semibold ${
          isCorrect ? 'text-sage-700' : 'text-[var(--color-warn)]'
        }`}
      >
        {isCorrect ? (
          <>
            <CheckCircle2 className="w-4 h-4" />
            정답입니다!
          </>
        ) : (
          <>
            <XCircle className="w-4 h-4" />
            오답입니다.
          </>
        )}
      </div>
      {explanation && (
        <div className="p-4 bg-[var(--color-sage-100)] rounded-lg">
          <div className="text-xs font-bold text-sage-700 mb-2">해설</div>
          <div className="text-sm text-sage-800 leading-relaxed whitespace-pre-line">
            {explanation}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Similar Question Panel ───────────────────────────────────────────────────

interface SimilarPanelProps {
  state: QuestionUIState;
  isPrivate: boolean;
  subTopicId: string | null;
  sourceQuestionId: string;
  onChange: (patch: Partial<QuestionUIState>) => void;
}

function SimilarPanel({ state, isPrivate, subTopicId, sourceQuestionId, onChange }: SimilarPanelProps) {
  async function loadSimilar() {
    if (!subTopicId) return;
    onChange({ similarLoading: true, similarQ: null, similarSelected: null, similarSubmitted: false, similarCorrectIndex: null, similarExplanation: null });
    try {
      // 오답 기반 AI 유사문제 생성 (ai_user_triggered). 풀 재출제가 아니라 새 문항을 생성한다.
      const result = await api.post<{ upload_id: string; question_count: number }>('/api/questions/similar', {
        source_question_id: sourceQuestionId,
        source_kind: isPrivate ? 'private' : 'public',
      });
      window.location.assign(`/similar-practice/${result.upload_id}`);
    } catch (e) {
      onChange({ similarLoading: false });
      alert(e instanceof ApiError ? e.message : '유사문제 생성에 실패했습니다. 잠시 후 다시 시도해주세요.');
    }
  }

  async function submitSimilar() {
    if (state.similarSelected === null || !state.similarQ) return;
    try {
      const res = await api.post<AttemptResponse>('/api/attempts', {
        question_id: state.similarQ.id,
        selected_index: state.similarSelected,
        time_spent_seconds: 30,
        track: isPrivate ? 'lecture_note' : 'smart_practice',
      });
      onChange({
        similarSubmitted: true,
        similarCorrectIndex: res.correct_index,
        similarExplanation: res.explanation,
      });
    } catch (e) {
      alert(e instanceof ApiError ? e.message : '제출 실패');
    }
  }

  return (
    // display:contents — 트리거 버튼이 부모 flex 행에 직접 정렬되도록(형제 버튼과 높이 일치).
    // 로딩/확장 패널은 basis-full 로 전체 폭 아래줄로 내려간다.
    <div className="contents">
      {!state.similarQ && !state.similarLoading && (
        <Button
          variant="accent"
          size="sm"
          onClick={loadSimilar}
          disabled={!subTopicId}
        >
          <Copy className="w-3.5 h-3.5" />
          유사문제 생성
        </Button>
      )}
      {state.similarLoading && (
        <p className="basis-full flex items-center gap-2 text-xs text-[var(--color-muted)] py-1.5">
          <span className="inline-block w-3.5 h-3.5 border-2 border-[var(--color-sage-400)] border-t-transparent rounded-full animate-spin" />
          AI가 유사문제를 생성하는 중입니다... (최대 30초)
        </p>
      )}
      {state.similarQ && (
        <div className="basis-full w-full mt-3 ll-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <span
              className="ll-chip ll-chip-accent"
              style={{ width: '1.75rem', height: '1.75rem', borderRadius: '9px' }}
            >
              <Copy className="w-3.5 h-3.5" strokeWidth={2.2} />
            </span>
            <span className="text-sm font-bold text-sage-800">AI 유사문제</span>
            <Badge variant={state.similarQ.badge.color}>{state.similarQ.badge.label}</Badge>
          </div>
          <div className="text-sm text-sage-800 leading-6 mb-4">{state.similarQ.stem}</div>
          <Choices
            choices={state.similarQ.choices}
            selected={state.similarSelected}
            submitted={state.similarSubmitted}
            correctIndex={state.similarCorrectIndex}
            onSelect={(i) => onChange({ similarSelected: i })}
          />
          {state.similarSubmitted && (
            <ExplanationBox
              explanation={state.similarExplanation}
              isCorrect={state.similarSelected === state.similarCorrectIndex}
            />
          )}
          {!state.similarSubmitted && (
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                onClick={submitSimilar}
                disabled={state.similarSelected === null}
              >
                제출
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={loadSimilar}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                다른 문제
              </Button>
            </div>
          )}
          {state.similarSubmitted && (
            <div className="mt-3">
              <Button variant="ghost" size="sm" onClick={loadSimilar}>
                <RefreshCw className="w-3.5 h-3.5" />
                새 유사문제
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

type ViewMode = 'summary' | 'full';

export default function WrongNotesPage() {
  const [items, setItems] = useState<WrongAnswerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('summary');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [selectedSubTopicId, setSelectedSubTopicId] = useState<string | null>(null); // null = 전체
  const [uiStates, setUiStates] = useState<Record<string, QuestionUIState>>({});
  const [deleting, setDeleting] = useState<Set<string>>(new Set());

  // ── Load ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    loadItems();
  }, []);

  async function loadItems() {
    setLoading(true);
    try {
      const data = await api.get<WrongAnswerItem[]>('/api/wrong-answers');
      setItems(data);
      // 전체 보기에서는 처음부터 펼침
      const states: Record<string, QuestionUIState> = {};
      data.forEach((item) => {
        states[item.id] = initUIState(false);
      });
      setUiStates(states);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '불러오기 실패';
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  // ── Filtering ─────────────────────────────────────────────────────────────

  type SubTopicEntry = { id: string | null; name: string; count: number };

  // 상단 타입 필터(전체 / 자료 기반 / 국가고시형 / 이미지 문제)
  const typeFilteredItems = items.filter((item) => {
    if (typeFilter === 'private') return item.isPrivate;
    if (typeFilter === 'exam') return !item.isPrivate;
    if (typeFilter === 'image') return !!item.question?.imageUrl;
    return true;
  });

  // 세부 주제 폴더 목록(타입 필터 반영한 카운트)
  const subTopics: SubTopicEntry[] = (() => {
    const map = new Map<string, SubTopicEntry>();
    typeFilteredItems.forEach((item) => {
      const key = item.subTopicId ?? '__null__';
      if (!map.has(key)) {
        map.set(key, { id: item.subTopicId, name: item.subTopicName, count: 0 });
      }
      map.get(key)!.count++;
    });
    return Array.from(map.values());
  })();

  const filteredItems = selectedSubTopicId === null
    ? typeFilteredItems
    : typeFilteredItems.filter((item) => item.subTopicId === selectedSubTopicId);

  // 헤더 카운트 서브라인
  const privateCount = items.filter((i) => i.isPrivate).length;
  const examCount = items.length - privateCount;
  const countSubline = `총 ${items.length}개 · 자료 기반 ${privateCount} · 국가고시형 ${examCount}`;

  // ── UI state helpers ──────────────────────────────────────────────────────

  function patchUI(id: string, patch: Partial<QuestionUIState>) {
    setUiStates((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch },
    }));
  }

  function getUI(id: string): QuestionUIState {
    return uiStates[id] ?? initUIState(false);
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  async function handleDelete(id: string) {
    setDeleting((prev) => new Set(prev).add(id));
    try {
      await api.delete(`/api/wrong-answers?id=${id}`);
      setItems((prev) => prev.filter((it) => it.id !== id));
    } catch (e) {
      alert(e instanceof ApiError ? e.message : '삭제 실패');
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  // ── Submit (다시 풀기) ──────────────────────────────────────────────────

  async function handleSubmit(item: WrongAnswerItem) {
    const ui = getUI(item.id);
    if (ui.selected === null || !item.question) return;

    try {
      await api.post<AttemptResponse>('/api/attempts', {
        question_id: item.question.id,
        selected_index: ui.selected,
        time_spent_seconds: 30,
        track: item.isPrivate ? 'lecture_note' : 'smart_practice',
      });
    } catch {
      // 기록 실패해도 채점은 클라이언트에서 즉시 처리
    }

    // 채점: question.answerIndex 로 즉시 비교
    patchUI(item.id, {
      submitted: true,
      correctIndex: item.question.answerIndex,
      explanation: item.question.explanation,
    });
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  function renderChoicesSection(item: WrongAnswerItem) {
    if (!item.question) return null;
    const ui = getUI(item.id);

    return (
      <>
        <Choices
          choices={item.question.choices}
          selected={ui.selected}
          submitted={ui.submitted}
          correctIndex={ui.correctIndex}
          onSelect={(i) => patchUI(item.id, { selected: i })}
        />

        {ui.submitted ? (
          <>
            <ExplanationBox
              explanation={ui.explanation}
              isCorrect={ui.selected === ui.correctIndex}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => patchUI(item.id, initUIState(true))}
              >
                <RefreshCw className="w-3.5 h-3.5" />
                다시 풀기
              </Button>
              <SimilarPanel
                state={ui}
                isPrivate={item.isPrivate}
                subTopicId={item.subTopicId}
                sourceQuestionId={item.question!.id}
                onChange={(patch) => patchUI(item.id, patch)}
              />
            </div>
          </>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => handleSubmit(item)}
              disabled={ui.selected === null}
            >
              제출
            </Button>
            <SimilarPanel
              state={ui}
              isPrivate={item.isPrivate}
              subTopicId={item.subTopicId}
              sourceQuestionId={item.question!.id}
              onChange={(patch) => patchUI(item.id, patch)}
            />
          </div>
        )}
      </>
    );
  }

  // ── Summary card ──────────────────────────────────────────────────────────

  function SummaryCard({ item }: { item: WrongAnswerItem }) {
    const ui = getUI(item.id);
    const q = item.question;
    const myIdx = item.selectedIndex;
    const myAnswer = q && myIdx !== null ? `${myIdx + 1}. ${q.choices[myIdx]}` : '무응답';
    const correctAnswer = q ? `${q.answerIndex + 1}. ${q.choices[q.answerIndex]}` : '';

    return (
      <Card className="wrong-card">
        {/* Header row — 과목/세부주제 배지 + 삭제 */}
        <div className="badges">
          <div className="badges">
            <Badge>{item.subjectName}</Badge>
            <Badge variant="gray">{item.subTopicName}</Badge>
            {q && <Badge variant={q.badge.color}>{q.badge.label}</Badge>}
            {q && <Badge variant="warn">난이도 {'★'.repeat(q.difficulty)}</Badge>}
          </div>
          <button
            onClick={() => handleDelete(item.id)}
            disabled={deleting.has(item.id)}
            className="remove"
            title="오답노트에서 제거"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Stem preview */}
        {q ? (
          <><p className="question">{q.stem}</p><div className="answer-grid"><div className="answer wrong"><div className="answer-label">내 답</div><div className="answer-text">{myAnswer}</div></div><div className="answer correct"><div className="answer-label">정답</div><div className="answer-text">{correctAnswer}</div></div></div></>
        ) : (
          <p className="text-sm text-[var(--color-muted)] mb-3">문제를 불러올 수 없습니다.</p>
        )}

        {/* Expanded content — 다시 풀기 */}
        {ui.expanded && q && (
          <div className="mt-2 border-t border-[var(--color-border)] pt-4">
            <div className="text-[14px] leading-7 text-sage-800 mb-4">{q.stem}</div>
            {q.imageUrl && (
              <div className="mb-3 rounded-lg overflow-hidden border border-[var(--color-border)] bg-[var(--color-sage-100)] h-48 flex items-center justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={q.imageUrl}
                  alt={q.imageType ?? 'medical image'}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            )}
            {renderChoicesSection(item)}
          </div>
        )}

        {/* Action buttons — 다시 풀기(secondary) + 유사문제 생성(accent) */}
        {!ui.expanded && (
          <div className="actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => patchUI(item.id, { expanded: true })}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              다시 풀기
            </Button>
            {item.subTopicId && (
              <SimilarPanel
                state={ui}
                isPrivate={item.isPrivate}
                subTopicId={item.subTopicId}
                sourceQuestionId={item.question!.id}
                onChange={(patch) => patchUI(item.id, patch)}
              />
            )}
          </div>
        )}
      </Card>
    );
  }

  // ── Full mode item ────────────────────────────────────────────────────────

  function FullItem({ item }: { item: WrongAnswerItem }) {
    const ui = getUI(item.id);
    const q = item.question;

    return (
      <Card className="wrong-card">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex flex-wrap items-center gap-1.5 min-w-0">
            <Badge>{item.subjectName}</Badge>
            <Badge variant="gray">{item.subTopicName}</Badge>
            {q && <Badge variant={q.badge.color}>{q.badge.label}</Badge>}
            {q && <Badge variant="warn">난이도 {'★'.repeat(q.difficulty)}</Badge>}
          </div>
          <button
            onClick={() => handleDelete(item.id)}
            disabled={deleting.has(item.id)}
            className="flex-shrink-0 p-1.5 rounded-lg hover:bg-[var(--color-warn-bg)] text-[var(--color-muted)] hover:text-[var(--color-warn)] transition-colors"
            title="오답노트에서 제거"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {q ? (
          <>
            <div className="text-[15px] leading-7 text-sage-800 mb-4">{q.stem}</div>
            {q.imageUrl && (
              <div className="mb-3 rounded-lg overflow-hidden border border-[var(--color-border)] bg-[var(--color-sage-100)] h-56 flex items-center justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={q.imageUrl}
                  alt={q.imageType ?? 'medical image'}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
            )}

            <Choices
              choices={q.choices}
              selected={ui.selected}
              submitted={ui.submitted}
              correctIndex={ui.correctIndex}
              onSelect={(i) => patchUI(item.id, { selected: i })}
            />

            {!ui.submitted && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => handleSubmit(item)}
                  disabled={ui.selected === null}
                >
                  제출
                </Button>
              </div>
            )}

            {ui.submitted && (
              <>
                <ExplanationBox
                  explanation={ui.explanation}
                  isCorrect={ui.selected === ui.correctIndex}
                />
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => patchUI(item.id, initUIState(false))}
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    다시 풀기
                  </Button>
                  <SimilarPanel
                    state={ui}
                    isPrivate={item.isPrivate}
                    subTopicId={item.subTopicId}
                    sourceQuestionId={item.question!.id}
                    onChange={(patch) => patchUI(item.id, patch)}
                  />
                </div>
              </>
            )}

            {!ui.submitted && (
              <div className="mt-2">
                <SimilarPanel
                  state={ui}
                  isPrivate={item.isPrivate}
                  subTopicId={item.subTopicId}
                  sourceQuestionId={item.question!.id}
                  onChange={(patch) => patchUI(item.id, patch)}
                />
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-[var(--color-muted)]">문제를 불러올 수 없습니다.</p>
        )}
      </Card>
    );
  }

  // ── Main render ────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2.5 py-24 text-[var(--color-muted)] text-sm">
        <span className="inline-block w-4 h-4 border-2 border-[var(--color-sage-400)] border-t-transparent rounded-full animate-spin" />
        오답노트 불러오는 중...
      </div>
    );
  }

  return (
    <div className="ll-wrong-page content">
      <section className="page-head"><div><span className="eyebrow"><FolderOpen className="icon"/>복습 큐레이션</span><h1><span className="headline-accent">오답노트</span>에서<br/>틀린 흐름을 다시 잡습니다</h1><p className="lead">틀린 문제를 주제별로 모아 보고, 바로 다시 풀거나 유사문제를 만들어 약한 개념을 이어서 복습할 수 있어요.</p></div><div className="stats"><span className="stat-pill">총 <strong>{items.length}</strong>개</span><span className="stat-pill">자료 기반 <strong>{items.filter(i => i.isPrivate).length}</strong></span><span className="stat-pill">국가고시형 <strong>{items.filter(i => !i.isPrivate).length}</strong></span></div></section>

      {items.length === 0 ? (
        // ── Empty state
        <div className="ll-card flex flex-col items-center justify-center text-center py-20 px-6">
          <span
            className="ll-chip"
            style={{ width: '4rem', height: '4rem', borderRadius: '18px' }}
          >
            <BookOpen className="w-7 h-7" strokeWidth={1.9} />
          </span>
          <h2 className="mt-5 text-xl font-bold text-sage-800 tracking-tight">
            아직 오답노트에 담긴 문제가 없습니다
          </h2>
          <p className="mt-2 text-sm text-[var(--color-muted)] max-w-sm">
            국시 대비에서 문제를 풀고 오답을 담아보세요.
          </p>
        </div>
      ) : (
        <>
          {/* ── Type filter tab row */}
          <div className="filters">
            {TYPE_FILTERS.map((f) => {
              const active = typeFilter === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => setTypeFilter(f.id)}
                  className={`filter ${active ? 'active' : ''}`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          <div className="layout">
            {/* ── Left: SubTopic folder list */}
            <aside className="card sidebar">
                <div className="px-2.5 py-2">
                  <span className="ll-eyebrow">
                    <Folder className="w-3.5 h-3.5" strokeWidth={2.4} />
                    세부 주제
                  </span>
                </div>
                <ul className="topic-list">
                  {/* 전체 */}
                  <li>
                    <button
                      onClick={() => setSelectedSubTopicId(null)}
                      className={`topic ${
                        selectedSubTopicId === null
                          ? 'bg-[var(--color-sage-100)] text-sage-700 font-semibold'
                          : 'text-sage-800 hover:bg-sage-50'
                      }`}
                    >
                      {selectedSubTopicId === null
                        ? <FolderOpen className="w-4 h-4 flex-shrink-0 text-sage-700" />
                        : <Folder className="w-4 h-4 flex-shrink-0 text-[var(--color-sage-400)]" />}
                      <span className="flex-1 truncate">전체</span>
                      <span className={`text-xs tabular-nums px-2 py-0.5 rounded-full ${
                        selectedSubTopicId === null
                          ? 'bg-sage-700 text-white'
                          : 'bg-[var(--color-sage-100)] text-[var(--color-muted)]'
                      }`}>{typeFilteredItems.length}</span>
                    </button>
                  </li>
                  {/* SubTopic folders */}
                  {subTopics.map((st) => {
                    const active = selectedSubTopicId === st.id;
                    return (
                      <li key={st.id ?? '__null__'}>
                        <button
                          onClick={() => setSelectedSubTopicId(st.id)}
                          className={`topic ${
                            active
                              ? 'bg-[var(--color-sage-100)] text-sage-700 font-semibold'
                              : 'text-sage-800 hover:bg-sage-50'
                          }`}
                        >
                          {active
                            ? <FolderOpen className="w-4 h-4 flex-shrink-0 text-sage-700" />
                            : <Folder className="w-4 h-4 flex-shrink-0 text-[var(--color-sage-400)]" />}
                          <span className="flex-1 truncate">{st.name}</span>
                          <span className={`text-xs tabular-nums px-2 py-0.5 rounded-full ${
                            active
                              ? 'bg-sage-700 text-white'
                              : 'bg-[var(--color-sage-100)] text-[var(--color-muted)]'
                          }`}>{st.count}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
            </aside>

            {/* ── Right: content area */}
            <section className="main-list flex-1 min-w-0">
              {/* View mode toggle — segmented control */}
              <div className="viewbar">
                <div className="segmented">
                  <button
                    onClick={() => setViewMode('summary')}
                    className={viewMode === 'summary' ? 'active' : ''}
                  >
                    요약 보기
                  </button>
                  <button
                    onClick={() => setViewMode('full')}
                    className={viewMode === 'full' ? 'active' : ''}
                  >
                    전체 보기
                  </button>
                </div>
                <span className="result-count">
                  {filteredItems.length}개
                </span>
              </div>

              {filteredItems.length === 0 ? (
                <div className="ll-card text-center py-16 text-sm text-[var(--color-muted)]">
                  조건에 맞는 오답이 없습니다.
                </div>
              ) : viewMode === 'summary' ? (
                // ── Summary view
                <div className="wrong-grid">
                  {filteredItems.map((item) => (
                    <SummaryCard key={item.id} item={item} />
                  ))}
                </div>
              ) : (
                // ── Full view
                <div className="space-y-4">
                  {filteredItems.map((item) => (
                    <FullItem key={item.id} item={item} />
                  ))}
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

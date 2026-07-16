'use client';

import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api/client';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ImageAttribution } from '@/components/ui/ImageAttribution';
import { ChevronLeft, ChevronRight, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';

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
  attribution?: {
    text: string;
    license: string;
    originalUrl: string;
  };
}

interface RecommendResponse {
  questions: QuestionForUser[];
  rationale: {
    cohortUsed: string | null;
    allocations: Array<{ subTopicId: string; count: number; bucket: string }>;
    weakSubTopics: string[];
    excludedCount: number;
  };
}

interface AttemptResponse {
  attempt_id: string;
  is_correct: boolean;
  correct_index: number;
  explanation: string | null;
}

export default function PracticePage() {
  const [questions, setQuestions] = useState<QuestionForUser[]>([]);
  const [cohortId, setCohortId] = useState<string | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [result, setResult] = useState<AttemptResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [outOfScopeMarked, setOutOfScopeMarked] = useState(false);

  const current = questions[currentIdx];

  // 문항이 표시된 시각 — 제출 시 실제 소요 시간 계산용. 문항이 바뀔 때마다 재설정.
  const questionStartRef = useRef<number>(0);
  useEffect(() => {
    if (current) questionStartRef.current = Date.now();
  }, [current?.id]);

  // 초기 로드: 추천 받기
  useEffect(() => {
    loadQuestions();
  }, []);

  async function loadQuestions() {
    setLoading(true);
    try {
      // 먼저 본인 코호트 정보 가져오기 (가장 최근 attempt 의 cohort_id 사용 - 간단히)
      // 실제로는 사용자 프로필에서 직접 조회. 여기서는 추천 API 가 알아서 처리.
      const res = await api.get<RecommendResponse>('/api/questions/recommend?count=10');
      setQuestions(res.questions);
      setCohortId(res.rationale.cohortUsed);
      setCurrentIdx(0);
      resetQuestion();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '문항을 가져오지 못했습니다';
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  function resetQuestion() {
    setSelected(null);
    setResult(null);
    setOutOfScopeMarked(false);
  }

  async function handleSubmit() {
    if (selected === null || !current) return;
    setSubmitting(true);
    try {
      // 문항 표시 시점부터 제출까지 실제 경과 초(1~3600 범위로 클램프).
      const elapsedSeconds = questionStartRef.current
        ? Math.min(3600, Math.max(1, Math.round((Date.now() - questionStartRef.current) / 1000)))
        : 0;
      const res = await api.post<AttemptResponse>('/api/attempts', {
        question_id: current.id,
        selected_index: selected,
        time_spent_seconds: elapsedSeconds,
        track: 'smart_practice',
        cohort_id: cohortId,
      });
      setResult(res);
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

  async function handleOutOfScope() {
    if (!current || !cohortId) {
      alert('학교 코호트가 설정되어 있어야 사용 가능합니다. 온보딩을 먼저 완료하세요.');
      return;
    }
    try {
      await api.post('/api/feedback/out-of-scope', {
        question_id: current.id,
        cohort_id: cohortId,
      });
      setOutOfScopeMarked(true);
    } catch (e) {
      alert(e instanceof Error ? e.message : '저장 실패');
    }
  }

  function goNext() {
    if (currentIdx < questions.length - 1) {
      setCurrentIdx((i) => i + 1);
      resetQuestion();
    } else {
      // 마지막이면 새로운 추천 로드
      loadQuestions();
    }
  }

  function goPrev() {
    if (currentIdx > 0) {
      setCurrentIdx((i) => i - 1);
      resetQuestion();
    }
  }

  if (loading) {
    return <div className="text-center py-20 text-[var(--color-muted)]">문항 불러오는 중...</div>;
  }
  if (!current) {
    return <div className="text-center py-20 text-[var(--color-muted)]">표시할 문항이 없습니다.</div>;
  }

  const progress = ((currentIdx + 1) / questions.length) * 100;

  return (
    <div className="ll-system-page">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-sage-800 mb-1">맞춤 풀이</h1>
        <p className="text-sm text-[var(--color-muted)]">
          KMLE 가이드라인 기반 · 학교별 시험 범위 필터 적용 · 평소 학습 baseline
        </p>
      </div>

      {/* Progress */}
      <div className="flex items-center justify-between text-sm text-[var(--color-muted)] mb-2">
        <span>문항 <strong className="text-sage-800">{currentIdx + 1}</strong> / {questions.length}</span>
        <span>{current.subjectName} · {current.subTopicName}</span>
      </div>
      <div className="w-full h-1.5 bg-[var(--color-sage-200)] rounded-full mb-6 overflow-hidden">
        <div className="h-full bg-sage-700 transition-all" style={{ width: `${progress}%` }} />
      </div>

      {/* Question card */}
      <Card className="mb-4">
        <div className="flex items-center justify-between mb-4">
          <div className="flex gap-2 flex-wrap">
            <Badge>{current.subjectName}</Badge>
            <Badge variant="gray">{current.subTopicName}</Badge>
            <Badge variant="warn">난이도 {'★'.repeat(current.difficulty)}</Badge>
          </div>
          <Badge variant={current.badge.color}>{current.badge.label}</Badge>
        </div>

        <div className="text-[15px] leading-7 text-sage-800 mb-4">
          <strong>{currentIdx + 1}.</strong> {current.stem}
        </div>

        {current.imageUrl && (
          <div className="mb-3">
            <div className="bg-[var(--color-sage-100)] border border-[var(--color-border)] rounded-lg h-56 flex items-center justify-center overflow-hidden">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={current.imageUrl}
                alt={`${current.imageType ?? 'medical'} image`}
                className="max-h-full max-w-full object-contain"
              />
            </div>
            {current.attribution && (
              <ImageAttribution
                attributionText={current.attribution.text}
                license={current.attribution.license}
                originalUrl={current.attribution.originalUrl}
              />
            )}
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
                <span className={`w-6 h-6 rounded-full border flex items-center justify-center text-xs font-semibold flex-shrink-0 ${
                  isSelected || isCorrect
                    ? 'bg-sage-700 text-white border-sage-700'
                    : 'border-[var(--color-sage-400)] text-[var(--color-muted)]'
                }`}>
                  {i + 1}
                </span>
                <span className="text-sm text-sage-800 flex-1">{choice}</span>
                {isCorrect && <CheckCircle2 className="w-5 h-5 text-sage-700" />}
                {isWrong && <XCircle className="w-5 h-5 text-[var(--color-warn)]" />}
              </button>
            );
          })}
        </div>

        {/* Explanation (after submission) */}
        {result && result.explanation && (
          <div className="mt-4 p-4 bg-[var(--color-sage-100)] rounded-lg">
            <div className="text-xs font-bold text-sage-700 mb-2">해설</div>
            <div className="text-sm text-sage-800 leading-relaxed whitespace-pre-line">
              {result.explanation}
            </div>
          </div>
        )}
      </Card>

      {/* Out of scope */}
      {!result && (
        <div className="bg-[var(--color-note-bg)] border border-[var(--color-border)] rounded-lg p-3 flex items-center justify-between gap-3 mb-4">
          <div className="text-sm text-sage-800">
            {outOfScopeMarked
              ? '✓ 시험 범위 아님으로 표시되었습니다.'
              : '이 문제가 본인 학교 시험 범위에 해당하지 않나요?'}
          </div>
          {!outOfScopeMarked && (
            <Button variant="secondary" size="sm" onClick={handleOutOfScope}>
              <AlertTriangle className="w-3.5 h-3.5" />
              시험 범위 아니에요
            </Button>
          )}
        </div>
      )}

      {/* Nav */}
      <div className="grid grid-cols-3 gap-3 items-center">
        <Button variant="secondary" onClick={goPrev} disabled={currentIdx === 0}>
          <ChevronLeft className="w-4 h-4" />
          이전 문제
        </Button>

        <div className="text-center">
          {!result ? (
            <Button onClick={handleSubmit} disabled={selected === null} loading={submitting}>
              제출
            </Button>
          ) : (
            <div className={`text-xs font-semibold ${result.is_correct ? 'text-sage-700' : 'text-[var(--color-warn)]'}`}>
              {result.is_correct ? '✓ 정답' : '✗ 오답'}
            </div>
          )}
        </div>

        <Button onClick={goNext} disabled={!result}>
          {currentIdx === questions.length - 1 ? '새 문항 추천' : '다음 문제'}
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

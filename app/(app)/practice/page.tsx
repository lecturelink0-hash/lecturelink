'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api/client';
import { STUDY_SUBJECT_STORAGE_KEY } from '@/lib/study-settings';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ImageAttribution } from '@/components/ui/ImageAttribution';
import { QuestionStem } from '@/components/ui/QuestionStem';
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
    focusSubTopicId: string | null;
    focusSubTopicName: string | null;
    focusSubjectName: string | null;
    focusPoolEmpty: boolean;
  };
}

interface WeakAreaSetResponse {
  mode: 'pool' | 'generated';
  upload_id?: string;
  question_count: number;
  seeded_from?: 'sub_topic' | 'subject' | 'none';
}

interface AttemptResponse {
  attempt_id: string;
  is_correct: boolean;
  correct_index: number;
  explanation: string | null;
}

interface StudySettingsRes {
  school_id: string | null;
  grade: string | null;
  semester: 'spring' | 'fall' | null;
  year: number | null;
}

interface CohortLookupRes {
  cohort_id: string | null;
}

export default function PracticePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // 약점·오답 분석의 "집중 코스"에서 넘어온 경우 — 이 세부주제 문항만 푼다.
  const focusSubTopicId = searchParams.get('sub_topic_id');
  const focusSubjectId = searchParams.get('subject_id');

  const [questions, setQuestions] = useState<QuestionForUser[]>([]);
  const [cohortId, setCohortId] = useState<string | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [result, setResult] = useState<AttemptResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [settingsMissing, setSettingsMissing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outOfScopeMarked, setOutOfScopeMarked] = useState(false);
  const [focus, setFocus] = useState<{
    subTopicName: string | null;
    subjectName: string | null;
    poolEmpty: boolean;
  } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const current = questions[currentIdx];

  // 문항이 표시된 시각 — 제출 시 실제 소요 시간 계산용. 문항이 바뀔 때마다 재설정.
  const questionStartRef = useRef<number>(0);
  useEffect(() => {
    if (current) questionStartRef.current = Date.now();
  }, [current?.id]);

  // 초기 로드: 추천 받기
  useEffect(() => {
    loadQuestions();
    // 집중 코스 링크가 바뀌면(다른 약점 주제 선택) 다시 불러온다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSubTopicId]);

  async function loadQuestions() {
    setLoading(true);
    try {
      // ── 집중 코스: 학습 설정/코호트와 무관하게 지정된 세부주제 문항만 뽑는다 ──
      // 여기서 학습 설정의 수강 과목을 쓰면 "대동맥박리 집중 코스"인데 수강 과목
      // (예: 내분비) 문항이 나온다. 링크에 담긴 주제가 우선이다.
      if (focusSubTopicId) {
        setSettingsMissing(false);
        const query = [
          'count=10',
          `sub_topic_id=${focusSubTopicId}`,
          focusSubjectId ? `subject_id=${focusSubjectId}` : null,
        ]
          .filter(Boolean)
          .join('&');
        const res = await api.get<RecommendResponse>(`/api/questions/recommend?${query}`);
        setQuestions(res.questions);
        setCohortId(null);
        setFocus({
          subTopicName: res.rationale.focusSubTopicName,
          subjectName: res.rationale.focusSubjectName,
          poolEmpty: res.rationale.focusPoolEmpty,
        });
        setCurrentIdx(0);
        resetQuestion();
        return;
      }

      setFocus(null);

      // 프로필의 학습 설정(학교·학년·학기·연도)과 브라우저에 저장된 수강 과목으로
      // 코호트를 찾아 추천에 반영한다. 설정이 없으면 안내 화면을 보여준다.
      const subjectId = window.localStorage.getItem(STUDY_SUBJECT_STORAGE_KEY);
      const settings = await api
        .get<StudySettingsRes>('/api/me/study-settings')
        .catch(() => null);

      if (
        !subjectId
        || !settings?.school_id
        || !settings.grade
        || !settings.semester
        || !settings.year
      ) {
        setSettingsMissing(true);
        setQuestions([]);
        return;
      }
      setSettingsMissing(false);

      const lookup = await api
        .get<CohortLookupRes>(
          `/api/cohorts/lookup?school_id=${settings.school_id}&grade=${settings.grade}&year=${settings.year}&semester=${settings.semester}&subject_id=${subjectId}`,
        )
        .catch(() => null);
      const resolvedCohortId = lookup?.cohort_id ?? null;

      const query = [
        'count=10',
        resolvedCohortId ? `cohort_id=${resolvedCohortId}` : null,
        `subject_id=${subjectId}`,
      ]
        .filter(Boolean)
        .join('&');
      const res = await api.get<RecommendResponse>(`/api/questions/recommend?${query}`);
      setQuestions(res.questions);
      setCohortId(resolvedCohortId ?? res.rationale.cohortUsed);
      setCurrentIdx(0);
      resetQuestion();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : '문항을 가져오지 못했습니다';
      alert(msg);
    } finally {
      setLoading(false);
    }
  }

  /**
   * 공개 문제 풀에 이 세부주제 문항이 없을 때 —
   * 학생의 '내 문제집' 문항을 바탕으로 같은 주제 문항을 미리 만들어 두고
   * 바로 풀 수 있는 문제집으로 이동한다.
   */
  async function handleGenerateFromLibrary() {
    if (!focusSubTopicId) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const res = await api.post<WeakAreaSetResponse>('/api/questions/weak-area-set', {
        sub_topic_id: focusSubTopicId,
      });
      if (res.mode === 'generated' && res.upload_id) {
        router.push(`/similar-practice/${res.upload_id}`);
        return;
      }
      // 그 사이 풀에 문항이 생긴 경우 — 다시 불러오면 바로 풀 수 있다.
      await loadQuestions();
    } catch (e) {
      setGenerateError(e instanceof ApiError ? e.message : '문항 생성에 실패했습니다.');
    } finally {
      setGenerating(false);
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
    } else if (focus) {
      // 집중 코스는 주제 문항이 유한하다 — 다시 추천해도 같은 문항이라 분석으로 돌려보낸다.
      router.push('/analysis');
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
    // 집중 코스인데 공개 풀에 문항이 없음 → 내 문제집 기반으로 미리 생성해 주는 경로 안내
    if (focus) {
      return (
        <div className="ll-system-page max-w-lg mx-auto text-center py-16">
          <p className="text-[15px] font-semibold text-sage-800 mb-2">
            {focus.subTopicName ?? '이 주제'} 문항이 아직 문제 풀에 없습니다
          </p>
          <p className="text-sm text-[var(--color-muted)] mb-6 leading-relaxed">
            내 문제집에 있는 {focus.subjectName ?? '해당 과목'} 문항을 바탕으로
            <br />
            같은 주제의 새 문항을 만들어 미리 준비해 둘 수 있어요.
          </p>
          {generateError && (
            <p className="text-sm text-[var(--color-warn)] mb-4">{generateError}</p>
          )}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button onClick={handleGenerateFromLibrary} loading={generating}>
              내 문제집 기반으로 문항 만들기
            </Button>
            <Link href="/analysis">
              <Button variant="secondary">분석으로 돌아가기</Button>
            </Link>
          </div>
          <p className="text-[11px] text-[var(--color-muted)] mt-4">
            생성된 문항은 내 문제집에 저장되어 언제든 다시 풀 수 있습니다.
          </p>
        </div>
      );
    }
    if (settingsMissing) {
      return (
        <div className="max-w-md mx-auto text-center py-20">
          <p className="text-[15px] font-semibold text-sage-800 mb-2">
            학습 설정이 필요합니다
          </p>
          <p className="text-sm text-[var(--color-muted)] mb-6">
            계정 설정에서 학기와 수강 과목을 저장하면
            <br />
            같은 학교·학년 선배 데이터 기반 추천이 시작됩니다.
          </p>
          <Link
            href="/profile"
            className="inline-flex items-center gap-1.5 h-11 px-5 rounded-lg bg-sage-700 text-white text-sm font-semibold hover:bg-sage-800"
          >
            학습 설정 하러 가기
            <ChevronRight className="w-4 h-4" aria-hidden="true" />
          </Link>
        </div>
      );
    }
    return <div className="text-center py-20 text-[var(--color-muted)]">표시할 문항이 없습니다.</div>;
  }

  const progress = ((currentIdx + 1) / questions.length) * 100;

  return (
    <div className="ll-system-page">
      <div className="mb-6">
        {focus ? (
          <>
            <Link
              href="/analysis"
              className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--color-muted)] hover:text-sage-800 transition-colors mb-2"
            >
              <ChevronLeft className="w-4 h-4" /> 약점·오답 분석으로
            </Link>
            <h1 className="text-2xl font-bold text-sage-800 mb-1">
              {focus.subTopicName ?? '약점'} 집중 코스
            </h1>
            <p className="text-sm text-[var(--color-muted)]">
              {focus.subjectName ? `${focus.subjectName} · ` : ''}
              약점 세부주제 문항만 모아서 풉니다
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold text-sage-800 mb-1">맞춤 풀이</h1>
            <p className="text-sm text-[var(--color-muted)]">
              KMLE 가이드라인 기반 · 학교별 시험 범위 필터 적용 · 평소 학습 baseline
            </p>
          </>
        )}
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

        <div className="flex gap-2 text-[15px] leading-7 text-sage-800 mb-4">
          <strong className="shrink-0">{currentIdx + 1}.</strong>
          <QuestionStem className="flex-1" text={current.stem} />
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
            <div className="text-sm text-sage-800 leading-relaxed whitespace-pre-wrap">
              {result.explanation}
            </div>
          </div>
        )}
      </Card>

      {/* Out of scope — 집중 코스는 코호트 없이 도는 경로라 시험범위 피드백 대상이 아니다 */}
      {!result && !focus && (
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
          {currentIdx === questions.length - 1
            ? (focus ? '코스 완료' : '새 문항 추천')
            : '다음 문제'}
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

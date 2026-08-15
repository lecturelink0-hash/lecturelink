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
    focusPoolCount: number;
  };
}

/** 오답 사유 판정 결과 — 왜 이 문항들이 만들어졌는지 화면에서 밝힌다. */
interface ErrorAnalysisRes {
  primary_reason: string;
  primary_label: string;
  confidence: number;
  evidence: string;
  sample_size: number;
  confusion_pairs: Array<{ picked: string; correct: string; discriminator: string }>;
  applied_to_generation: boolean;
}

interface WeakAreaSetResponse {
  mode: 'pool' | 'generated' | 'topped_up';
  upload_id?: string;
  question_count: number;
  seeded_from?: 'sub_topic' | 'subject' | 'none';
  added?: number;
  rejected?: number;
  reached_minimum?: boolean;
  error_analysis: ErrorAnalysisRes | null;
}

/**
 * 약점 집중 코스가 보장해야 하는 최소 문항 수.
 * 서버(lib/recommend/engine.ts FOCUS_MIN_QUESTIONS)와 같은 값이어야 한다.
 */
const FOCUS_MIN_QUESTIONS = 3;

interface AttemptResponse {
  attempt_id: string;
  is_correct: boolean;
  correct_index: number;
  explanation: string | null;
}

/** 문항 하나의 풀이 상태. 문항 id 로 보관해 앞뒤로 오가도 살아남는다. */
interface AnswerState {
  selected: number | null;
  result: AttemptResponse | null;
  outOfScope: boolean;
}

const EMPTY_ANSWER: AnswerState = { selected: null, result: null, outOfScope: false };

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
  // 문항 id → 풀이 상태. 문항을 건너뛰거나 이전 문제로 되돌아와도 고른 선지·채점 결과·
  // 해설이 그대로 남는다(스칼라 한 벌로 두면 이동할 때마다 지워진다).
  const [answers, setAnswers] = useState<Record<string, AnswerState>>({});
  const [loading, setLoading] = useState(true);
  const [settingsMissing, setSettingsMissing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [focus, setFocus] = useState<{
    subTopicName: string | null;
    subjectName: string | null;
    poolEmpty: boolean;
    poolCount: number;
  } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [errorAnalysis, setErrorAnalysis] = useState<ErrorAnalysisRes | null>(null);
  const [shortNotice, setShortNotice] = useState<string | null>(null);
  // 같은 세부주제에 보충 생성을 두 번 걸지 않기 위한 표식.
  // 보충 후에도 하한을 못 채우는 주제가 있을 수 있는데, 그때 재요청이 계속 나가면
  // 학생 할당량만 태운다.
  const toppedUpRef = useRef<string | null>(null);

  const current = questions[currentIdx];
  const { selected, result, outOfScope: outOfScopeMarked } =
    (current ? answers[current.id] : undefined) ?? EMPTY_ANSWER;

  /** 현재 문항의 풀이 상태만 갈아끼운다. 다른 문항 상태는 건드리지 않는다. */
  function patchAnswer(questionId: string, patch: Partial<AnswerState>) {
    setAnswers((prev) => ({
      ...prev,
      [questionId]: { ...EMPTY_ANSWER, ...prev[questionId], ...patch },
    }));
  }

  // 문항이 표시된 시각 — 제출 시 실제 소요 시간 계산용. 문항이 바뀔 때마다 재설정.
  const questionStartRef = useRef<number>(0);
  useEffect(() => {
    if (current) questionStartRef.current = Date.now();
  }, [current?.id]);

  // 초기 로드: 추천 받기
  useEffect(() => {
    // 다른 약점 주제로 옮기면 이전 주제의 오답 사유·보충 안내는 거짓이 된다.
    // "감별진단의 오류를 겨냥했습니다"가 엉뚱한 주제 위에 남아 있으면 안 된다.
    setErrorAnalysis(null);
    setShortNotice(null);
    setGenerateError(null);
    loadQuestions();
    // 집중 코스 링크가 바뀌면(다른 약점 주제 선택) 다시 불러온다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSubTopicId]);

  async function loadQuestions() {
    setLoading(true);
    // 새 문항 세트가 오면 이전 세트의 풀이 상태는 의미가 없다(id 가 겹칠 수도 있다).
    clearAnswers();
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
          poolCount: res.rationale.focusPoolCount,
        });
        setCurrentIdx(0);

        // 풀에 문항이 있긴 한데 하한(3문항)에 못 미치면 그 자리에서 보충한다.
        // 종전에는 '완전히 빈 경우'만 보충 경로가 있어서 1문항짜리 주제는
        // 계속 1/1 로 떴다. 여기서 자동으로 거는 이유는, 학생이 이미 이 주제를
        // 약점으로 지목받아 들어온 상태라 한 번 더 물어봐야 할 결정이 아니기 때문.
        const poolCount = res.rationale.focusPoolCount;
        if (
          poolCount > 0
          && poolCount < FOCUS_MIN_QUESTIONS
          && toppedUpRef.current !== focusSubTopicId
        ) {
          toppedUpRef.current = focusSubTopicId;
          void topUpFocusPool();
        }
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
      setErrorAnalysis(res.error_analysis);
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

  /**
   * 집중 코스의 공개 풀이 하한(3문항)에 못 미칠 때 그 자리에서 채운다.
   *
   * 실패해도 이미 뽑아 둔 1~2문항은 그대로 풀 수 있어야 하므로, 오류는 배너로만
   * 알리고 화면을 비우지 않는다. 하한을 못 채웠으면 그 사실도 그대로 쓴다 —
   * 조용히 넘어가면 "AI가 약점 코스를 만들어 줬다"는 말이 또 거짓이 된다.
   */
  async function topUpFocusPool() {
    if (!focusSubTopicId) return;
    setGenerating(true);
    setGenerateError(null);
    setShortNotice(null);
    try {
      const res = await api.post<WeakAreaSetResponse>('/api/questions/weak-area-set', {
        sub_topic_id: focusSubTopicId,
      });
      setErrorAnalysis(res.error_analysis);
      if (res.reached_minimum === false) {
        setShortNotice(
          `이 주제는 지금 ${res.question_count}문항까지만 준비됐습니다`
          + `${res.rejected ? ` (품질 기준에 걸린 ${res.rejected}문항은 제외했습니다)` : ''}.`,
        );
      }
      await loadQuestions();
    } catch (e) {
      setGenerateError(
        e instanceof ApiError
          ? `약점 문항을 더 만들지 못했습니다 — ${e.message}`
          : '약점 문항을 더 만들지 못했습니다.',
      );
    } finally {
      setGenerating(false);
    }
  }

  /** 새 문항 세트를 받아올 때만 호출한다 — 문항 사이 이동으로는 절대 지우지 않는다. */
  function clearAnswers() {
    setAnswers({});
  }

  async function handleSubmit() {
    // 이미 채점된 문항은 다시 제출하지 않는다 — 되돌아왔을 때 중복 기록·쿼터 이중 차감 방지.
    if (selected === null || !current || result) return;
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
        // 약점 집중 코스는 코호트 없이 도는 경로다. 키를 null 로 실어 보내면 안 되고
        // 아예 빼야 한다(서버 스키마의 optional 은 undefined 만 허용).
        ...(cohortId ? { cohort_id: cohortId } : {}),
      });
      patchAnswer(current.id, { result: res });
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
      patchAnswer(current.id, { outOfScope: true });
    } catch (e) {
      alert(e instanceof Error ? e.message : '저장 실패');
    }
  }

  // 문항 사이 이동은 인덱스만 옮긴다. 풀이 상태는 answers 에 문항별로 남아 있다.
  function goNext() {
    if (currentIdx < questions.length - 1) {
      setCurrentIdx((i) => i + 1);
    } else if (focus) {
      // 집중 코스는 주제 문항이 유한하다 — 다시 추천해도 같은 문항이라 분석으로 돌려보낸다.
      router.push('/analysis');
    } else {
      // 마지막이면 새로운 추천 로드
      loadQuestions();
    }
  }

  function goPrev() {
    if (currentIdx > 0) setCurrentIdx((i) => i - 1);
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

      {/* 약점 코스 상태 — 무엇을 근거로 어떤 문항을 준비했는지 밝힌다 */}
      {focus && (generating || errorAnalysis || shortNotice || generateError) && (
        <div className="mb-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-sage-100)] px-4 py-3">
          {generating && (
            <p className="text-[13px] font-semibold text-sage-800">
              이 주제의 문항이 {focus.poolCount}개뿐이라 약점을 겨냥한 문항을 더 만들고 있습니다…
            </p>
          )}
          {!generating && errorAnalysis && (
            <>
              <p className="text-[13px] font-semibold text-sage-800">
                {errorAnalysis.applied_to_generation
                  ? `오답 사유 «${errorAnalysis.primary_label}» 를 겨냥해 문항을 준비했습니다`
                  : `오답 사유는 «${errorAnalysis.primary_label}» 로 추정되나 근거가 약해 출제에는 반영하지 않았습니다`}
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-muted)]">
                최근 오답 {errorAnalysis.sample_size}건 기준 · 확신도 {Math.round(errorAnalysis.confidence * 100)}%
              </p>
              <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-muted)]">
                {errorAnalysis.evidence}
              </p>
            </>
          )}
          {!generating && shortNotice && (
            <p className="mt-2 text-[12px] text-[var(--color-warn)]">{shortNotice}</p>
          )}
          {!generating && generateError && (
            <p className="mt-2 text-[12px] text-[var(--color-warn)]">{generateError}</p>
          )}
        </div>
      )}

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
                onClick={() => !result && patchAnswer(current.id, { selected: i })}
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

        {/* 채점하지 않아도 넘어갈 수 있다 — 모르는 문항에서 막히지 않게 한다. */}
        <Button onClick={goNext} disabled={submitting}>
          {currentIdx === questions.length - 1
            ? (focus ? '코스 완료' : '새 문항 추천')
            : '다음 문제'}
          <ChevronRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

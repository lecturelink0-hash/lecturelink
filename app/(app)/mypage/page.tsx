'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ChevronRight,
  CalendarDays,
  Trash2,
  Plus,
  User,
  UserCog,
  Check,
  AlertCircle,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PageHeader } from '@/components/ui/PageHeader';
import { StudyCalendar } from '@/components/ui/StudyCalendar';
import { api, ApiError } from '@/lib/api/client';
import { PLAN_CATALOG } from '@/lib/payment/plans';
import { calcStreak, diffDayKeys, formatStudyTime, kstTodayKey } from '@/lib/utils/kst';
import type { UserProfile } from '@/lib/types/domain';
import type { PlanTier } from '@/lib/types/database';

// ─── Types ───────────────────────────────────────────────────────────────────

interface StudyDay {
  date: string;   // 'YYYY-MM-DD'
  count: number;
  correct: number;
}

interface CalendarSummary {
  totalSolved: number;
  totalCorrect: number;
  accuracy: number;   // 0~1
  activeDays: number;
  totalStudySeconds?: number;
}

interface StudyCalendarResponse {
  days: StudyDay[];
  summary: CalendarSummary;
}

interface ExamSchedule {
  id: string;
  title: string;
  exam_date: string;  // 'YYYY-MM-DD'
  subject_id: string | null;
  memo: string | null;
  color: string;
}

interface Subject {
  id: string;
  code: string;
  name: string;
}

interface QuotaResource {
  limit: number;
  used: number;
  bonus: number;
  remaining: number;
}

interface QuotaResponse {
  plan_tier: PlanTier;
  questions: QuotaResource;
  uploads: QuotaResource;
  images: QuotaResource;
}

interface SubscriptionResponse {
  subscription: {
    id: string;
    plan_tier: PlanTier;
    status: string;
    started_at: string | null;
    expires_at: string | null;
    auto_renew: boolean;
  } | null;
  plan_tier: PlanTier;
}

// ─── Static maps ─────────────────────────────────────────────────────────────

const GRADE_LABEL: Record<string, string> = {
  pre_1: '예과 1학년',
  pre_2: '예과 2학년',
  med_1: '본과 1학년',
  med_2: '본과 2학년',
  med_3: '본과 3학년',
  med_4: '본과 4학년',
};

// ─── Main Page ───────────────────────────────────────────────────────────────
// 날짜·스트릭·D-day 계산은 전부 lib/utils/kst 의 KST 기준 공용 유틸 사용
// (데이터가 KST 로 집계되므로 브라우저 로컬 타임존을 쓰면 어긋난다).

export default function MyPage() {
  // Data state
  const [calendarData, setCalendarData] = useState<StudyCalendarResponse | null>(null);
  const [schedules, setSchedules] = useState<ExamSchedule[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [quota, setQuota] = useState<QuotaResponse | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [partialError, setPartialError] = useState(false);
  const [cancellingSubscription, setCancellingSubscription] = useState(false);

  // Calendar navigation — 초기 뷰는 KST 기준 오늘이 속한 달
  const [viewYear, setViewYear] = useState(() => Number(kstTodayKey().slice(0, 4)));
  const [viewMonth, setViewMonth] = useState(() => Number(kstTodayKey().slice(5, 7)));

  // Selected date
  const [selectedDate, setSelectedDate] = useState<string>(() => kstTodayKey());

  // Form state — 날짜는 캘린더에서 선택한 날을 따라가되 폼에서 직접 바꿀 수도 있다
  const [formTitle, setFormTitle] = useState('');
  const [formDate, setFormDate] = useState<string>(() => kstTodayKey());
  const [formSubjectId, setFormSubjectId] = useState('');
  const [formMemo, setFormMemo] = useState('');
  const [formLoading, setFormLoading] = useState(false);
  const [deleteLoadingId, setDeleteLoadingId] = useState<string | null>(null);
  const [scheduleFeedback, setScheduleFeedback] = useState<
    { type: 'success' | 'error'; text: string } | null
  >(null);
  const [pendingDelete, setPendingDelete] = useState<ExamSchedule | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);

  // ─── Fetch ──────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPartialError(false);
    // allSettled — 요청 하나가 실패해도 나머지 섹션은 렌더링한다(부분 실패 허용).
    const [cal, sched, subj, prof, qta, sub] = await Promise.allSettled([
      api.get<StudyCalendarResponse>('/api/study-calendar'),
      api.get<ExamSchedule[]>('/api/exam-schedules'),
      api.get<Subject[]>('/api/subjects?with_sub_topics=false'),
      api.get<UserProfile>('/api/me'),
      api.get<QuotaResponse>('/api/me/quota'),
      api.get<SubscriptionResponse>('/api/me/subscription'),
    ] as const);

    const results = [cal, sched, subj, prof, qta, sub];
    if (results.every((r) => r.status === 'rejected')) {
      const reason = (cal as PromiseRejectedResult).reason;
      setError(reason instanceof ApiError ? reason.message : '데이터를 불러오지 못했습니다.');
      setLoading(false);
      return;
    }

    if (cal.status === 'fulfilled') setCalendarData(cal.value);
    if (sched.status === 'fulfilled') setSchedules(sched.value);
    if (subj.status === 'fulfilled') setSubjects(subj.value);
    if (prof.status === 'fulfilled') setProfile(prof.value);
    if (qta.status === 'fulfilled') setQuota(qta.value);
    if (sub.status === 'fulfilled') setSubscription(sub.value);
    setPartialError(results.some((r) => r.status === 'rejected'));
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // 캘린더에서 날짜를 고르면 일정 추가 폼의 날짜도 따라간다
  useEffect(() => {
    setFormDate(selectedDate);
  }, [selectedDate]);

  const fetchSchedules = useCallback(async () => {
    try {
      const sched = await api.get<ExamSchedule[]>('/api/exam-schedules');
      setSchedules(sched);
    } catch {
      // silent
    }
  }, []);

  // ─── Derived ────────────────────────────────────────────────────────────

  const dayIndex: Record<string, StudyDay> = {};
  (calendarData?.days ?? []).forEach((d) => {
    dayIndex[d.date] = d;
  });

  const scheduleIndex: Record<string, ExamSchedule[]> = {};
  schedules.forEach((s) => {
    if (!scheduleIndex[s.exam_date]) scheduleIndex[s.exam_date] = [];
    scheduleIndex[s.exam_date].push(s);
  });

  const summary = calendarData?.summary;
  const streak = calendarData
    ? calcStreak(calendarData.days.filter((d) => d.count > 0).map((d) => d.date))
    : 0;
  const accuracyPct = summary ? Math.round((summary.accuracy ?? 0) * 100) : 0;
  const generatedQuestionCount = quota?.questions.used ?? 0;

  const today = kstTodayKey();

  // Profile / plan display
  const displayName = profile?.displayName ?? '학생';
  const planTier: PlanTier = profile?.planTier ?? quota?.plan_tier ?? 'free';
  const plan = PLAN_CATALOG[planTier];
  const schoolLabel = profile?.school?.shortName ?? profile?.school?.name ?? null;
  const gradeLabelText = profile?.grade ? (GRADE_LABEL[profile.grade] ?? profile.grade) : null;
  const identitySub = [schoolLabel, gradeLabelText].filter(Boolean).join(' · ');
  const nextBillingDate = subscription?.subscription?.expires_at
    ? subscription.subscription.expires_at.slice(0, 10).replace(/-/g, '.')
    : '—';
  const activeSubscription = subscription?.subscription?.status === 'active'
    ? subscription.subscription
    : null;

  async function cancelSubscription() {
    if (!activeSubscription?.auto_renew || cancellingSubscription) return;
    setCancellingSubscription(true);
    setSubscriptionError(null);
    try {
      await api.post('/api/me/subscription/cancel', {});
      setSubscription((current) => current?.subscription ? {
        ...current,
        subscription: { ...current.subscription, auto_renew: false },
      } : current);
    } catch (cause) {
      setSubscriptionError(
        cause instanceof ApiError ? cause.message : '자동 갱신을 해제하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      );
    } finally {
      setCancellingSubscription(false);
      setCancelDialogOpen(false);
    }
  }

  // Calendar cell data (그리드 구성·키보드 내비게이션은 StudyCalendar 담당)
  const getCalendarDay = (dateKey: string) => ({
    count: dayIndex[dateKey]?.count ?? 0,
    hasExam: (scheduleIndex[dateKey]?.length ?? 0) > 0,
  });

  // Selected date info
  const selectedStudy = dayIndex[selectedDate];
  const selectedSchedules = scheduleIndex[selectedDate] ?? [];
  const selectedAccuracy =
    selectedStudy && selectedStudy.count > 0
      ? Math.round((selectedStudy.correct / selectedStudy.count) * 100)
      : null;

  // 다가오는 일정 — 오늘 이후 최대 5건, 날짜순
  const upcomingSchedules = schedules
    .filter((s) => s.exam_date >= today)
    .sort((a, b) => a.exam_date.localeCompare(b.exam_date))
    .slice(0, 5);

  // ─── Handlers ───────────────────────────────────────────────────────────

  function goToDate(dateKey: string) {
    setViewYear(Number(dateKey.slice(0, 4)));
    setViewMonth(Number(dateKey.slice(5, 7)));
    setSelectedDate(dateKey);
  }

  function prevMonth() {
    if (viewMonth === 1) {
      setViewYear((y) => y - 1);
      setViewMonth(12);
    } else {
      setViewMonth((m) => m - 1);
    }
  }

  function nextMonth() {
    if (viewMonth === 12) {
      setViewYear((y) => y + 1);
      setViewMonth(1);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  async function handleAddSchedule() {
    if (!formTitle.trim() || !formDate) return;
    setFormLoading(true);
    setScheduleFeedback(null);
    try {
      await api.post('/api/exam-schedules', {
        title: formTitle.trim(),
        exam_date: formDate,
        subject_id: formSubjectId || null,
        memo: formMemo.trim() || null,
      });
      setFormTitle('');
      setFormSubjectId('');
      setFormMemo('');
      await fetchSchedules();
      // 추가한 날짜를 캘린더에서 바로 보여준다
      goToDate(formDate);
      setScheduleFeedback({ type: 'success', text: '일정이 추가되었습니다.' });
    } catch (cause) {
      setScheduleFeedback({
        type: 'error',
        text: cause instanceof ApiError
          ? cause.message
          : '일정을 추가하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      });
    } finally {
      setFormLoading(false);
    }
  }

  async function handleDeleteSchedule(id: string) {
    setDeleteLoadingId(id);
    setScheduleFeedback(null);
    try {
      await api.delete(`/api/exam-schedules/${id}`);
      await fetchSchedules();
      setScheduleFeedback({ type: 'success', text: '일정이 삭제되었습니다.' });
    } catch {
      setScheduleFeedback({
        type: 'error',
        text: '일정을 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      });
    } finally {
      setDeleteLoadingId(null);
      setPendingDelete(null);
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    // 실제 카드 골격과 같은 스켈레톤 — 로드 완료 시 레이아웃 점프를 막는다
    return (
      <div className="ll-system-page">
        <PageHeader
          title="마이페이지"
          description="학습 기록과 요금제·계정 정보를 한곳에서 확인하세요"
        />
        <p className="sr-only" role="status">불러오는 중</p>
        <div aria-hidden="true">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {[0, 1].map((i) => (
              <div key={i} className="ll-card p-5 animate-pulse">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-[var(--color-sage-100)]" />
                  <div className="flex-1 space-y-2 pt-1">
                    <div className="h-4 w-32 rounded bg-[var(--color-sage-100)]" />
                    <div className="h-3 w-44 rounded bg-[var(--color-sage-100)]" />
                  </div>
                </div>
                <div className="mt-4 h-[72px] rounded-xl bg-[var(--color-sage-100)]" />
                <div className="mt-3 h-10 rounded-xl bg-[var(--color-sage-100)]" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-6 mt-6">
            <div className="ll-card p-5 sm:p-6 animate-pulse">
              <div className="h-5 w-36 rounded bg-[var(--color-sage-100)]" />
              <div className="mt-5 h-[420px] rounded-xl bg-[var(--color-sage-100)]" />
            </div>
            <div className="ll-card p-5 sm:p-6 animate-pulse">
              <div className="h-5 w-28 rounded bg-[var(--color-sage-100)]" />
              <div className="mt-5 h-[420px] rounded-xl bg-[var(--color-sage-100)]" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader
          title="마이페이지"
          description="학습 기록과 요금제·계정 정보를 한곳에서 확인하세요"
        />
        <Card>
          <div className="flex items-center gap-2 text-[var(--color-warn)]">
            <AlertCircle size={18} />
            <span className="text-sm">{error}</span>
          </div>
          <Button variant="secondary" size="sm" className="mt-3" onClick={fetchAll}>
            다시 시도
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="ll-system-page">
      {/* ── Page Header ── */}
      <PageHeader
        title="마이페이지"
        description="학습 기록과 요금제·계정 정보를 한곳에서 확인하세요"
      />

      {/* 일부 요청 실패 시 재시도 배너 (나머지 섹션은 정상 렌더) */}
      {partialError && (
        <div className="mb-5 rounded-xl bg-[var(--color-warn-bg)] px-4 py-3 flex items-center gap-2.5">
          <AlertCircle size={16} className="text-[var(--color-warn)] flex-shrink-0" />
          <p className="text-[13px] text-sage-800">일부 정보를 불러오지 못했습니다.</p>
          <button
            type="button"
            onClick={fetchAll}
            className="ml-auto py-2 -my-2 text-[13px] font-semibold text-[var(--color-warn)] underline underline-offset-2"
          >
            다시 시도
          </button>
        </div>
      )}

      {/* ── Top: Profile + Plan ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Profile — 상·하단 카드가 같은 Card 규격(패딩·보더·그림자)을 쓰도록 통일 */}
        <Card className="flex flex-col justify-between">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <span className="w-10 h-10 rounded-full bg-sage-700 text-white flex items-center justify-center flex-shrink-0">
                <User className="w-5 h-5" strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-[17px] font-bold text-sage-800 tracking-tight leading-none">
                    {displayName}
                  </h2>
                  <Badge variant="default">{plan.name} 플랜</Badge>
                </div>
                {identitySub && (
                  <p className="text-[13px] text-[var(--color-muted)] mt-1.5">{identitySub}</p>
                )}
                <p className="text-[12px] text-[var(--color-muted)] mt-1">
                  {streak > 0 ? `${streak}일 연속 학습 중` : '오늘도 학습을 시작해보세요'}
                </p>
              </div>
            </div>
            <Link
              href="/profile"
              className="flex-shrink-0 inline-flex items-center gap-1 py-2.5 -my-1 px-1 text-[13px] text-[var(--color-muted)] hover:text-sage-800 transition-colors"
            >
              <UserCog className="w-4 h-4" />
              회원정보 수정
            </Link>
          </div>

          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs font-semibold text-sage-700">학습 통계</span>
            <Link
              href="/analysis"
              className="inline-flex items-center gap-0.5 py-2 -my-2 text-[13px] text-[var(--color-muted)] hover:text-sage-800 transition-colors"
            >
              상세 분석 <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          </div>
          <div className="mt-1.5 grid grid-cols-2 sm:grid-cols-4 gap-px overflow-hidden rounded-xl border border-[var(--color-sage-200)] bg-[var(--color-sage-200)]">
            <ProfileStat label="누적 학습시간" value={formatStudyTime(summary?.totalStudySeconds ?? 0)} />
            <ProfileStat label="이번 달 생성 문항" value={`${generatedQuestionCount}문항`} />
            <ProfileStat label="학습한 날" value={`${summary?.activeDays ?? 0}일`} />
            <ProfileStat label="평균 정답률" value={`${accuracyPct}%`} />
          </div>
        </Card>

        {/* Plan */}
        <Card className="flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold text-sage-800 tracking-tight">현재 요금제</h2>
            <Link
              href="/plan"
              className="inline-flex items-center gap-0.5 py-3 -my-3 px-1 -mx-1 text-[13px] text-[var(--color-muted)] hover:text-sage-800 transition-colors"
            >
              요금제 보기 <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          {/* Plan highlight */}
          <div className="rounded-xl bg-sage-700 text-white px-4 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[14px] font-bold leading-tight">{plan.name} 플랜</p>
              <p className="text-[11px] text-white/70 mt-0.5 truncate">{plan.desc}</p>
            </div>
            <p className="text-right flex-shrink-0">
              {activeSubscription && plan.price > 0 ? (
                <>
                  <span className="text-[16px] font-bold tnum">
                    {plan.price.toLocaleString()}원
                  </span>
                  <span className="text-[12px] text-white/70"> / 월</span>
                </>
              ) : planTier === 'free' ? (
                <span className="text-[15px] font-bold">무료</span>
              ) : subscription?.subscription ? (
                // 유료 티어인데 활성 구독이 없음 = 구독 이력이 있으나 만료·해지된 상태
                <span className="text-[14px] font-bold">구독 만료</span>
              ) : (
                // 구독 이력 없이 부여된 유료 티어 (베타·개발자 계정)
                <span className="text-[14px] font-bold">베타 제공</span>
              )}
            </p>
          </div>

          {/* Quota rows — 400px 미만에서는 세로로 쌓아 라벨 줄바꿈 방지 */}
          <div className="mt-3 grid grid-cols-1 min-[400px]:grid-cols-2 gap-4">
            <QuotaRow
              label="문항 생성 잔여량"
              remaining={quota?.questions.remaining ?? 0}
              total={(quota?.questions.limit ?? 0) + (quota?.questions.bonus ?? 0)}
            />
            <QuotaRow
              label="자료 업로드 잔여량"
              remaining={quota?.uploads.remaining ?? 0}
              total={(quota?.uploads.limit ?? 0) + (quota?.uploads.bonus ?? 0)}
            />
            <QuotaRow
              label="이미지 생성 잔여량"
              remaining={quota?.images.remaining ?? 0}
              total={(quota?.images.limit ?? 0) + (quota?.images.bonus ?? 0)}
            />
          </div>

          {/* Next billing / 업그레이드 CTA */}
          {activeSubscription ? (
            <>
              <div className="mt-auto pt-2.5 border-t border-[var(--color-border)] flex items-center justify-between text-[12px]">
                <span className="text-[var(--color-muted)]">{activeSubscription.auto_renew ? '다음 결제 예정일' : '이용 만료일'}</span>
                <span className="font-semibold text-sage-800 tnum">{nextBillingDate}</span>
              </div>
              {activeSubscription.auto_renew ? (
                <button type="button" onClick={() => setCancelDialogOpen(true)} disabled={cancellingSubscription} className="mt-2 text-left text-xs font-semibold text-[var(--color-muted)] underline underline-offset-2 disabled:opacity-50">
                  {cancellingSubscription ? '해지 처리 중...' : '자동 갱신 해제'}
                </button>
              ) : (
                <p className="mt-2 text-xs text-[var(--color-muted)]">
                  자동 갱신이 꺼져 있어요 ·{' '}
                  <Link href="/plan" className="font-semibold text-sage-700 underline underline-offset-2">
                    요금제에서 관리
                  </Link>
                </p>
              )}
            </>
          ) : planTier === 'free' ? (
            <div className="mt-auto pt-3">
              <Link
                href="/plan"
                className="inline-flex w-full items-center justify-center gap-1.5 h-11 px-5 rounded-xl bg-[var(--color-accent)] text-white text-sm font-bold hover:bg-[var(--color-accent-dark)] transition-colors"
              >
                플랜 업그레이드 <ChevronRight className="w-4 h-4" />
              </Link>
            </div>
          ) : (
            <div className="mt-auto pt-2.5 border-t border-[var(--color-border)] flex items-center justify-between text-[12px]">
              <span className="text-[var(--color-muted)]">자동 결제</span>
              <span className="font-semibold text-sage-800">없음</span>
            </div>
          )}
          <div aria-live="polite">
            {subscriptionError && (
              <p className="mt-2 text-xs text-[var(--color-warn)]">{subscriptionError}</p>
            )}
          </div>
        </Card>
      </div>

      {/* ── Calendar + Selected Date Panel (상단 2칸 바로 아래) ──
           id="calendar": 대시보드 D-day 칩·시험 일정 등록 버튼의 앵커 진입점 */}
      <div id="calendar" className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-6 mt-6 scroll-mt-24">
        {/* ── Calendar — 카드 제목은 Card 의 공통 규격(h2 · text-base)으로 ── */}
        <Card icon={<CalendarDays className="w-4 h-4" strokeWidth={2} />} title="학습 캘린더">
          <StudyCalendar
            viewYear={viewYear}
            viewMonth={viewMonth}
            selectedDate={selectedDate}
            todayKey={today}
            getDay={getCalendarDay}
            onSelectDate={setSelectedDate}
            onPrevMonth={prevMonth}
            onNextMonth={nextMonth}
            onGoToday={() => goToDate(today)}
          />
        </Card>

        {/* ── Selected Date Panel ── */}
        <Card>
          <div className="flex items-center gap-2.5 mb-4">
            <span className="ll-chip" style={{ width: '2.25rem', height: '2.25rem' }}>
              <CalendarDays className="w-4 h-4" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-bold text-sage-800 tracking-tight leading-tight">
                {selectedDate.replace(/-/g, '.')}
              </h2>
              {selectedDate === today && (
                <Badge variant="default" className="mt-1">오늘</Badge>
              )}
            </div>
          </div>

          {/* Study info */}
          <div className="mb-4 p-4 rounded-2xl ll-tint">
            {selectedStudy && selectedStudy.count > 0 ? (
              <div className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--color-muted)]">푼 문항</span>
                  <span className="font-semibold text-sage-800">{selectedStudy.count}문항</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--color-muted)]">정답</span>
                  <span className="font-semibold text-sage-800">{selectedStudy.correct}문항</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-[var(--color-muted)]">정답률</span>
                  <span className="font-semibold text-sage-800">{selectedAccuracy}%</span>
                </div>
                {/* Progress bar */}
                <div
                  role="progressbar"
                  aria-label="정답률"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={selectedAccuracy ?? 0}
                  className="mt-2 h-1.5 rounded-full bg-[var(--color-sage-200)] overflow-hidden"
                >
                  <div
                    className="h-full bg-sage-600 rounded-full transition-all"
                    style={{ width: `${selectedAccuracy ?? 0}%` }}
                  />
                </div>
                {/* 이 날의 학습에서 이어지는 다음 행동 */}
                <div className="mt-3 pt-2.5 border-t border-[var(--color-sage-200)] flex flex-wrap items-center gap-x-4 gap-y-1">
                  <Link
                    href="/wrong-notes"
                    className="inline-flex items-center gap-0.5 py-2 -my-2 text-xs font-semibold text-sage-700 hover:text-sage-900 transition-colors"
                  >
                    오답노트에서 복습 <ChevronRight className="w-3 h-3" />
                  </Link>
                  <Link
                    href="/analysis"
                    className="inline-flex items-center gap-0.5 py-2 -my-2 text-xs font-semibold text-sage-700 hover:text-sage-900 transition-colors"
                  >
                    상세 분석 <ChevronRight className="w-3 h-3" />
                  </Link>
                </div>
              </div>
            ) : (
              <p className="text-xs text-[var(--color-muted)] text-center py-2">
                이 날의 학습 기록이 없습니다
              </p>
            )}
          </div>

          {/* Exams on this date */}
          <div className="mb-4">
            <p className="text-xs font-semibold text-sage-700 mb-2">시험 일정</p>
            {selectedSchedules.length > 0 ? (
              <ul className="space-y-2">
                {selectedSchedules.map((s) => {
                  const diff = diffDayKeys(s.exam_date, today);
                  const dLabel = diff === 0 ? 'D-DAY' : diff > 0 ? `D-${diff}` : `D+${-diff}`;
                  return (
                    <li
                      key={s.id}
                      className="flex items-start justify-between gap-2 p-2 rounded-lg border border-[var(--color-border)] bg-white"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <Badge variant={diff >= 0 && diff <= 7 ? 'warn' : 'default'}>
                            {dLabel}
                          </Badge>
                          <p className="text-xs font-medium text-sage-800 truncate">{s.title}</p>
                        </div>
                        {s.memo && (
                          <p className="text-[11px] text-[var(--color-muted)] mt-0.5 truncate">
                            {s.memo}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => setPendingDelete(s)}
                        disabled={deleteLoadingId === s.id}
                        className="flex-shrink-0 p-3 -m-2 text-[var(--color-muted)] hover:text-[var(--color-warn)] transition-colors disabled:opacity-40"
                        aria-label={`${s.title} 일정 삭제`}
                      >
                        {deleteLoadingId === s.id ? (
                          <span className="inline-block w-3.5 h-3.5 border border-current border-t-transparent rounded-full animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-xs text-[var(--color-muted)]">이 날의 시험 일정이 없습니다</p>
            )}
          </div>

          {/* Upcoming schedules — 날짜를 클릭하지 않아도 D-day 를 한눈에 */}
          {upcomingSchedules.length > 0 && (
            <div className="mb-4">
              <p className="text-xs font-semibold text-sage-700 mb-2">다가오는 일정</p>
              <ul className="space-y-1.5">
                {upcomingSchedules.map((s) => {
                  const diff = diffDayKeys(s.exam_date, today);
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => goToDate(s.exam_date)}
                        className="w-full flex items-center gap-2 p-2 rounded-lg border border-[var(--color-border)] bg-white text-left hover:border-[var(--color-line-strong)] transition-colors"
                      >
                        <Badge variant={diff >= 0 && diff <= 7 ? 'warn' : 'default'}>
                          {diff === 0 ? 'D-DAY' : `D-${diff}`}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-sage-800">
                          {s.title}
                        </span>
                        <span className="flex-shrink-0 text-[11px] text-[var(--color-muted)] tnum">
                          {s.exam_date.slice(5).replace('-', '.')}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Add schedule form */}
          <form
            className="border-t border-[var(--color-border)] pt-4"
            aria-labelledby="add-schedule-heading"
            onSubmit={(event) => {
              event.preventDefault();
              handleAddSchedule();
            }}
          >
            <p id="add-schedule-heading" className="text-xs font-semibold text-sage-700 mb-2">
              일정 추가
            </p>
            <div className="space-y-2.5">
              <div>
                <label htmlFor="schedule-date" className="block text-xs font-medium text-sage-700 mb-1">
                  날짜{' '}
                  <span className="text-[var(--color-warn)]" aria-hidden="true">*</span>
                  <span className="sr-only">(필수)</span>
                </label>
                <input
                  id="schedule-date"
                  name="exam_date"
                  type="date"
                  required
                  aria-required="true"
                  value={formDate}
                  onChange={(e) => setFormDate(e.target.value)}
                  className="w-full h-11 text-sm border border-[var(--color-line-strong)] rounded-lg px-3 focus:outline-none focus:ring-1 focus:ring-sage-400 text-sage-800 bg-white"
                />
              </div>
              <div>
                <label htmlFor="schedule-title" className="block text-xs font-medium text-sage-700 mb-1">
                  제목{' '}
                  <span className="text-[var(--color-warn)]" aria-hidden="true">*</span>
                  <span className="sr-only">(필수)</span>
                </label>
                <input
                  id="schedule-title"
                  name="title"
                  type="text"
                  required
                  aria-required="true"
                  placeholder="예: 해부학 중간고사"
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  className="w-full h-11 text-sm border border-[var(--color-line-strong)] rounded-lg px-3 focus:outline-none focus:ring-1 focus:ring-sage-400 placeholder:text-[var(--color-muted)]"
                />
              </div>
              {subjects.length > 0 && (
                <div>
                  <label htmlFor="schedule-subject" className="block text-xs font-medium text-sage-700 mb-1">
                    과목 (선택)
                  </label>
                  <select
                    id="schedule-subject"
                    name="subject_id"
                    value={formSubjectId}
                    onChange={(e) => setFormSubjectId(e.target.value)}
                    className="w-full h-11 text-sm border border-[var(--color-line-strong)] rounded-lg px-3 focus:outline-none focus:ring-1 focus:ring-sage-400 text-sage-800 bg-white"
                  >
                    <option value="">선택 안 함</option>
                    {subjects.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label htmlFor="schedule-memo" className="block text-xs font-medium text-sage-700 mb-1">
                  메모 (선택)
                </label>
                <input
                  id="schedule-memo"
                  name="memo"
                  type="text"
                  placeholder="예: 3~5장 범위"
                  value={formMemo}
                  onChange={(e) => setFormMemo(e.target.value)}
                  className="w-full h-11 text-sm border border-[var(--color-line-strong)] rounded-lg px-3 focus:outline-none focus:ring-1 focus:ring-sage-400 placeholder:text-[var(--color-muted)]"
                />
              </div>
              <div aria-live="polite">
                {scheduleFeedback && (
                  <p
                    className={`text-xs ${
                      scheduleFeedback.type === 'error'
                        ? 'text-[var(--color-warn)]'
                        : 'text-sage-700'
                    }`}
                  >
                    {scheduleFeedback.text}
                  </p>
                )}
              </div>
              <Button
                type="submit"
                variant="primary"
                size="md"
                fullWidth
                loading={formLoading}
                disabled={!formTitle.trim() || !formDate}
              >
                <Plus size={14} />
                일정 추가
              </Button>
            </div>
          </form>
        </Card>
      </div>

      {/* ── Note banner (요금제 변경 안내) — 캘린더 아래로 이동 ── */}
      <div className="ll-tint rounded-xl px-4 py-3 flex items-start gap-2.5 mt-6">
        <Check className="w-4 h-4 text-sage-600 mt-0.5 flex-shrink-0" strokeWidth={2.6} />
        <p className="text-[13px] text-sage-700 leading-relaxed">
          요금제를 변경해도 이전 학습 기록은 그대로 보관됩니다. 다만 현재 요금제에 포함되지 않은
          모드의 새 문제 풀이나 추가 문제 생성은 제한됩니다.
        </p>
      </div>

      {/* ── 확인 다이얼로그 (window.confirm 대체) ── */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="일정을 삭제할까요?"
        description={pendingDelete ? `'${pendingDelete.title}' 일정이 바로 삭제됩니다.` : undefined}
        confirmLabel="삭제"
        danger
        loading={deleteLoadingId !== null}
        onConfirm={() => pendingDelete && handleDeleteSchedule(pendingDelete.id)}
        onCancel={() => setPendingDelete(null)}
      />
      <ConfirmDialog
        open={cancelDialogOpen}
        title="자동 갱신을 해제할까요?"
        description="이용 기간이 남아 있다면 만료일까지 그대로 사용할 수 있습니다."
        confirmLabel="자동 갱신 해제"
        loading={cancellingSubscription}
        onConfirm={cancelSubscription}
        onCancel={() => setCancelDialogOpen(false)}
      />
    </div>
  );
}

function ProfileStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 bg-[var(--color-sage-100)] px-3 py-3">
      <p className="truncate text-[11px] font-medium text-[var(--color-muted)]">{label}</p>
      <p className="ll-stat mt-1 whitespace-nowrap text-[16px] font-bold leading-none tracking-[-0.03em]">{value}</p>
    </div>
  );
}

// ─── Quota Row ───────────────────────────────────────────────────────────────

function QuotaRow({
  label,
  remaining,
  total,
}: {
  label: string;
  remaining: number;
  total: number;
}) {
  const unlimited = remaining >= 1_000_000 || total >= 1_000_000;
  const pct = unlimited ? 100 : total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
  // 잔여 20% 이하는 warn 색으로 — "잔여량" 막대임이 상태로 드러나게
  const low = !unlimited && total > 0 && remaining / total <= 0.2;
  return (
    <div>
      <div className="flex items-center justify-between text-[13px] mb-1.5">
        <span className="text-[var(--color-muted)]">{label}</span>
        {unlimited ? (
          <span className="font-semibold text-sage-800">무제한</span>
        ) : (
          <span className={`font-semibold tnum ${low ? 'text-[var(--color-warn)]' : 'text-sage-800'}`}>
            {remaining}
            <span className="text-[var(--color-muted)] font-normal"> / {total}개</span>
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={unlimited ? undefined : total}
        aria-valuenow={unlimited ? undefined : remaining}
        aria-valuetext={unlimited ? '무제한' : `${remaining} / ${total}개 남음`}
        className="h-1.5 rounded-full bg-[var(--color-sage-200)] overflow-hidden"
      >
        <div
          className={`h-full rounded-full transition-all ${low ? 'bg-[var(--color-warn)]' : 'bg-sage-600'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

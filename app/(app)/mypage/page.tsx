'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ChevronLeft,
  ChevronRight,
  CalendarDays,
  Trash2,
  Plus,
  User,
  Check,
  AlertCircle,
} from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/ui/PageHeader';
import { api, ApiError } from '@/lib/api/client';
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

/** 초 → "N시간 M분" (0 이면 "0분") */
function formatStudyTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return h > 0 ? `${h}시간 ${mm}분` : `${mm}분`;
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

const PLAN_DISPLAY: Record<PlanTier, { name: string; price: number; desc: string }> = {
  free:     { name: '무료 플랜',    price: 0,     desc: '기본 학습' },
  lite:     { name: '내신 대비',    price: 7900,  desc: '학교 시험·내신 위주' },
  standard: { name: '국가고시 대비', price: 9900,  desc: '국가고시형 집중' },
  pro:      { name: '통합형',       price: 14900, desc: '내신 + 국시 통합' },
};

const GRADE_LABEL: Record<string, string> = {
  pre_1: '예과 1학년',
  pre_2: '예과 2학년',
  med_1: '본과 1학년',
  med_2: '본과 2학년',
  med_3: '본과 3학년',
  med_4: '본과 4학년',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toDateKey(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function todayKey(): string {
  const now = new Date();
  return toDateKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function calcStreak(days: StudyDay[]): number {
  const activeSet = new Set(days.filter((d) => d.count > 0).map((d) => d.date));
  const today = todayKey();
  const msPerDay = 86400000;

  let streak = 0;
  let cur = activeSet.has(today)
    ? new Date(today)
    : (() => {
        const yesterday = new Date(new Date(today).getTime() - msPerDay);
        const yk = toDateKey(yesterday.getFullYear(), yesterday.getMonth() + 1, yesterday.getDate());
        return activeSet.has(yk) ? yesterday : null;
      })();

  if (!cur) return 0;

  while (true) {
    const key = toDateKey(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
    if (!activeSet.has(key)) break;
    streak++;
    cur = new Date(cur.getTime() - msPerDay);
  }
  return streak;
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

function firstDayOfWeek(y: number, m: number): number {
  return new Date(y, m - 1, 1).getDay();
}

function countBgClass(count: number): string {
  if (count === 0) return '';
  if (count < 10) return 'bg-[var(--color-sage-200)]';
  if (count < 30) return 'bg-sage-500 text-white';
  return 'bg-sage-700 text-white';
}

function diffDays(target: string): number {
  const today = new Date(todayKey());
  const t = new Date(target);
  return Math.round((t.getTime() - today.getTime()) / 86400000);
}

// ─── Main Page ───────────────────────────────────────────────────────────────

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

  // Calendar navigation
  const now = new Date();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth() + 1);

  // Selected date
  const [selectedDate, setSelectedDate] = useState<string>(todayKey());

  // Form state
  const [formTitle, setFormTitle] = useState('');
  const [formSubjectId, setFormSubjectId] = useState('');
  const [formMemo, setFormMemo] = useState('');
  const [formLoading, setFormLoading] = useState(false);
  const [deleteLoadingId, setDeleteLoadingId] = useState<string | null>(null);

  // ─── Fetch ──────────────────────────────────────────────────────────────

  const fetchAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [cal, sched, subj, prof, qta, sub] = await Promise.all([
        api.get<StudyCalendarResponse>('/api/study-calendar'),
        api.get<ExamSchedule[]>('/api/exam-schedules'),
        api.get<Subject[]>('/api/subjects?with_sub_topics=false'),
        api.get<UserProfile>('/api/me'),
        api.get<QuotaResponse>('/api/me/quota'),
        api.get<SubscriptionResponse>('/api/me/subscription'),
      ]);
      setCalendarData(cal);
      setSchedules(sched);
      setSubjects(subj);
      setProfile(prof);
      setQuota(qta);
      setSubscription(sub);
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message);
      } else {
        setError('데이터를 불러오지 못했습니다.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

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
  const streak = calendarData ? calcStreak(calendarData.days) : 0;
  const accuracyPct = summary ? Math.round((summary.accuracy ?? 0) * 100) : 0;

  const today = todayKey();

  // Profile / plan display
  const displayName = profile?.displayName ?? '학생';
  const planTier: PlanTier = profile?.planTier ?? quota?.plan_tier ?? 'free';
  const plan = PLAN_DISPLAY[planTier];
  const schoolLabel = profile?.school?.shortName ?? profile?.school?.name ?? null;
  const gradeLabelText = profile?.grade ? (GRADE_LABEL[profile.grade] ?? profile.grade) : null;
  const identitySub = [schoolLabel, gradeLabelText].filter(Boolean).join(' · ');
  const nextBillingDate = subscription?.subscription?.expires_at
    ? subscription.subscription.expires_at.slice(0, 10).replace(/-/g, '.')
    : '—';

  // Calendar grid
  const totalDays = daysInMonth(viewYear, viewMonth);
  const startDow = firstDayOfWeek(viewYear, viewMonth);
  const cells: (number | null)[] = [
    ...Array<null>(startDow).fill(null),
    ...Array.from({ length: totalDays }, (_, i) => i + 1),
  ];
  // pad to full rows
  while (cells.length % 7 !== 0) cells.push(null);

  // Selected date info
  const selectedStudy = dayIndex[selectedDate];
  const selectedSchedules = scheduleIndex[selectedDate] ?? [];
  const selectedAccuracy =
    selectedStudy && selectedStudy.count > 0
      ? Math.round((selectedStudy.correct / selectedStudy.count) * 100)
      : null;

  // ─── Handlers ───────────────────────────────────────────────────────────

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
    if (!formTitle.trim()) return;
    setFormLoading(true);
    try {
      await api.post('/api/exam-schedules', {
        title: formTitle.trim(),
        exam_date: selectedDate,
        subject_id: formSubjectId || null,
        memo: formMemo.trim() || null,
      });
      setFormTitle('');
      setFormSubjectId('');
      setFormMemo('');
      await fetchSchedules();
    } catch {
      // silent
    } finally {
      setFormLoading(false);
    }
  }

  async function handleDeleteSchedule(id: string) {
    setDeleteLoadingId(id);
    try {
      await api.delete(`/api/exam-schedules/${id}`);
      await fetchSchedules();
    } catch {
      // silent
    } finally {
      setDeleteLoadingId(null);
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div>
        <PageHeader
          eyebrow="마이페이지"
          title="안녕하세요"
          description="이번 주 학습 흐름과 요금제·개정 정보를 한곳에서 확인하세요"
        />
        <div className="flex items-center justify-center h-64 text-[var(--color-muted)]">
          <div className="text-center">
            <div className="inline-block w-6 h-6 border-2 border-sage-600 border-t-transparent rounded-full animate-spin mb-2" />
            <p className="text-sm">불러오는 중...</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <PageHeader
          eyebrow="마이페이지"
          title="안녕하세요"
          description="이번 주 학습 흐름과 요금제·개정 정보를 한곳에서 확인하세요"
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
        eyebrow="마이페이지"
        title={`${displayName}님 안녕하세요`}
        description="이번 주 학습 흐름과 요금제·개정 정보를 한곳에서 확인하세요"
      />

      {/* ── Top: Profile + Plan ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Profile */}
        <div className="ll-card p-6">
          <div className="flex items-start gap-4">
            <span className="w-12 h-12 rounded-full bg-sage-700 text-white flex items-center justify-center flex-shrink-0">
              <User className="w-6 h-6" strokeWidth={2} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-lg font-bold text-sage-800 tracking-tight leading-none">
                  {displayName}
                </h2>
                <Badge variant="default">{plan.name}</Badge>
              </div>
              {identitySub && (
                <p className="text-[13px] text-[var(--color-muted)] mt-1.5">{identitySub}</p>
              )}
              <p className="text-[12px] text-[var(--color-muted)] mt-1">
                {streak > 0 ? `${streak}일 연속 학습 중` : '오늘도 학습을 시작해보세요'}
              </p>
            </div>
          </div>

          {/* Cumulative study stat */}
          <div className="mt-5 rounded-xl ll-tint p-4">
            <p className="text-[12px] text-[var(--color-muted)] mb-1.5">
              LECTURELINK와 함께한 누적 학습시간
            </p>
            <p className="ll-stat text-[1.8rem] font-bold leading-none">
              {formatStudyTime(summary?.totalStudySeconds ?? 0)}
            </p>
            <p className="text-[12px] text-[var(--color-muted)] mt-2">
              누적 {summary?.totalSolved ?? 0}문항 · 학습한 날 {summary?.activeDays ?? 0}일 · 평균 정답률 {accuracyPct}%
            </p>
          </div>
        </div>

        {/* Plan */}
        <div className="ll-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[15px] font-bold text-sage-800">현재 요금제</h2>
            <Link
              href="/plan"
              className="inline-flex items-center gap-0.5 text-[13px] text-[var(--color-muted)] hover:text-sage-800 transition-colors"
            >
              안내 <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          {/* Plan highlight */}
          <div className="rounded-xl bg-sage-700 text-white px-4 py-3.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[15px] font-bold leading-tight">{plan.name}</p>
              <p className="text-[12px] text-white/70 mt-0.5 truncate">{plan.desc}</p>
            </div>
            <p className="text-right flex-shrink-0">
              {plan.price > 0 ? (
                <>
                  <span className="text-[17px] font-bold tnum">
                    {plan.price.toLocaleString()}원
                  </span>
                  <span className="text-[12px] text-white/70"> / 월</span>
                </>
              ) : (
                <span className="text-[15px] font-bold">무료</span>
              )}
            </p>
          </div>

          {/* Quota rows */}
          <div className="mt-4 space-y-3.5">
            <QuotaRow
              label="남은 문항 생성"
              remaining={quota?.questions.remaining ?? 0}
              total={(quota?.questions.limit ?? 0) + (quota?.questions.bonus ?? 0)}
            />
            <QuotaRow
              label="남은 자료 업로드"
              remaining={quota?.uploads.remaining ?? 0}
              total={(quota?.uploads.limit ?? 0) + (quota?.uploads.bonus ?? 0)}
            />
          </div>

          {/* Next billing */}
          <div className="mt-4 pt-3 border-t border-[var(--color-border)] flex items-center justify-between text-[13px]">
            <span className="text-[var(--color-muted)]">다음 결제일</span>
            <span className="font-semibold text-sage-800 tnum">{nextBillingDate}</span>
          </div>
        </div>
      </div>

      {/* ── Calendar + Selected Date Panel (상단 2칸 바로 아래) ── */}
      <div className="grid grid-cols-1 xl:grid-cols-[2fr_1fr] gap-6 mt-6">
        {/* ── Calendar ── */}
        <Card>
          <div className="flex items-center gap-2.5 mb-5">
            <span className="ll-chip" style={{ width: '2.25rem', height: '2.25rem' }}>
              <CalendarDays className="w-4 h-4" strokeWidth={2} />
            </span>
            <h2 className="text-lg font-bold text-sage-800 tracking-tight">학습 캘린더</h2>
          </div>
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-4">
            <button
              onClick={prevMonth}
              className="p-1.5 rounded-lg hover:bg-[var(--color-sage-100)] text-sage-700 transition-colors"
              aria-label="이전 달"
            >
              <ChevronLeft size={18} />
            </button>
            <span className="text-base font-bold text-sage-800">
              {viewYear}년 {viewMonth}월
            </span>
            <button
              onClick={nextMonth}
              className="p-1.5 rounded-lg hover:bg-[var(--color-sage-100)] text-sage-700 transition-colors"
              aria-label="다음 달"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          {/* Day-of-week header */}
          <div className="grid grid-cols-7 mb-1">
            {['일', '월', '화', '수', '목', '금', '토'].map((dow) => (
              <div
                key={dow}
                className="text-center text-[11px] font-semibold text-[var(--color-muted)] py-1"
              >
                {dow}
              </div>
            ))}
          </div>

          {/* Date cells */}
          <div className="grid grid-cols-7 gap-0.5">
            {cells.map((day, idx) => {
              if (day === null) {
                return <div key={`empty-${idx}`} className="aspect-square" />;
              }

              const dateKey = toDateKey(viewYear, viewMonth, day);
              const study = dayIndex[dateKey];
              const count = study?.count ?? 0;
              const hasExam = (scheduleIndex[dateKey]?.length ?? 0) > 0;
              const isToday = dateKey === today;
              const isSelected = dateKey === selectedDate;
              const bgClass = countBgClass(count);

              return (
                <button
                  key={dateKey}
                  onClick={() => setSelectedDate(dateKey)}
                  className={[
                    'relative aspect-square rounded-lg flex flex-col items-center justify-center transition-all text-xs font-medium',
                    bgClass,
                    !bgClass && 'hover:bg-[var(--color-sage-100)]',
                    isSelected && !bgClass && 'ring-2 ring-sage-500',
                    isSelected && bgClass && 'ring-2 ring-sage-800',
                    isToday && !isSelected && 'ring-2 ring-sage-400',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  aria-label={`${viewYear}년 ${viewMonth}월 ${day}일`}
                >
                  <span className={count >= 10 ? 'text-white' : 'text-sage-800'}>
                    {day}
                  </span>
                  {count > 0 && (
                    <span
                      className={`text-[9px] leading-none mt-0.5 ${
                        count >= 10 ? 'text-white/80' : 'text-sage-600'
                      }`}
                    >
                      {count}
                    </span>
                  )}
                  {hasExam && (
                    <span
                      className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full"
                      style={{ background: count > 0 ? 'var(--color-accent)' : 'var(--color-warn)' }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 mt-4 pt-3 border-t border-[var(--color-border)]">
            <span className="text-[11px] text-[var(--color-muted)]">학습량:</span>
            <div className="flex items-center gap-2">
              {[
                { label: '없음', cls: 'bg-[var(--color-bg)] border border-[var(--color-border)]' },
                { label: '1~9', cls: 'bg-[var(--color-sage-200)]' },
                { label: '10~29', cls: 'bg-sage-500' },
                { label: '30+', cls: 'bg-sage-700' },
              ].map((item) => (
                <div key={item.label} className="flex items-center gap-1">
                  <span className={`w-3 h-3 rounded-sm inline-block ${item.cls}`} />
                  <span className="text-[10px] text-[var(--color-muted)]">{item.label}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1 ml-2">
              <span className="w-2 h-2 rounded-full bg-[var(--color-warn)] inline-block" />
              <span className="text-[10px] text-[var(--color-muted)]">시험 일정</span>
            </div>
          </div>
        </Card>

        {/* ── Selected Date Panel ── */}
        <Card>
          <div className="flex items-center gap-2.5 mb-4">
            <span className="ll-chip" style={{ width: '2.25rem', height: '2.25rem' }}>
              <CalendarDays className="w-4 h-4" strokeWidth={2} />
            </span>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-sage-800 tracking-tight leading-tight">
                {selectedDate.replace(/-/g, '.')}
              </h3>
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
                <div className="mt-2 h-1.5 rounded-full bg-[var(--color-sage-200)] overflow-hidden">
                  <div
                    className="h-full bg-sage-600 rounded-full transition-all"
                    style={{ width: `${selectedAccuracy ?? 0}%` }}
                  />
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
                  const diff = diffDays(s.exam_date);
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
                        onClick={() => handleDeleteSchedule(s.id)}
                        disabled={deleteLoadingId === s.id}
                        className="flex-shrink-0 text-[var(--color-muted)] hover:text-[var(--color-warn)] transition-colors disabled:opacity-40"
                        aria-label="일정 삭제"
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

          {/* Add schedule form */}
          <div className="border-t border-[var(--color-border)] pt-4">
            <p className="text-xs font-semibold text-sage-700 mb-2">이 날짜에 일정 추가</p>
            <div className="space-y-2">
              <input
                type="text"
                placeholder="시험/일정 제목 *"
                value={formTitle}
                onChange={(e) => setFormTitle(e.target.value)}
                className="w-full text-xs border border-[var(--color-border)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-sage-400 placeholder:text-[var(--color-muted)]"
              />
              {subjects.length > 0 && (
                <select
                  value={formSubjectId}
                  onChange={(e) => setFormSubjectId(e.target.value)}
                  className="w-full text-xs border border-[var(--color-border)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-sage-400 text-sage-800 bg-white"
                >
                  <option value="">과목 선택 (선택)</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              )}
              <input
                type="text"
                placeholder="메모 (선택)"
                value={formMemo}
                onChange={(e) => setFormMemo(e.target.value)}
                className="w-full text-xs border border-[var(--color-border)] rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-sage-400 placeholder:text-[var(--color-muted)]"
              />
              <Button
                variant="primary"
                size="sm"
                fullWidth
                loading={formLoading}
                disabled={!formTitle.trim()}
                onClick={handleAddSchedule}
              >
                <Plus size={14} />
                일정 추가
              </Button>
            </div>
          </div>
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
  return (
    <div>
      <div className="flex items-center justify-between text-[13px] mb-1.5">
        <span className="text-[var(--color-muted)]">{label}</span>
        {unlimited ? (
          <span className="font-semibold text-sage-800">무제한</span>
        ) : (
          <span className="font-semibold text-sage-800 tnum">
            {remaining}
            <span className="text-[var(--color-muted)] font-normal"> / {total}개</span>
          </span>
        )}
      </div>
      <div className="h-1.5 rounded-full bg-[var(--color-sage-200)] overflow-hidden">
        <div className="h-full bg-sage-600 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

import { DashboardView } from './DashboardView';
import { getCurrentSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { GENERATED_SET_TYPES, isGeneratedSet } from '@/lib/generated-sets';
import type { SupabaseClient } from '@supabase/supabase-js';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 86400000;
const WEEKDAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'];

function pickOne(value: unknown): unknown {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function kstKey(iso: string): string {
  return new Date(new Date(iso).getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function startOfKstWeekUtc(): Date {
  const nowKst = new Date(Date.now() + KST_OFFSET_MS);
  const daysFromMonday = (nowKst.getUTCDay() + 6) % 7;
  const mondayKst = new Date(Date.UTC(
    nowKst.getUTCFullYear(),
    nowKst.getUTCMonth(),
    nowKst.getUTCDate(),
  ));
  mondayKst.setUTCDate(mondayKst.getUTCDate() - daysFromMonday);
  return new Date(mondayKst.getTime() - KST_OFFSET_MS);
}

function kstWeekDateKeys(startUtc: Date): string[] {
  return Array.from({ length: 7 }, (_, index) => (
    kstKey(new Date(startUtc.getTime() + index * DAY_MS).toISOString())
  ));
}

function computeStreak(dates: Set<string>): number {
  const nowKst = new Date(Date.now() + KST_OFFSET_MS);
  const cursor = new Date(Date.UTC(
    nowKst.getUTCFullYear(),
    nowKst.getUTCMonth(),
    nowKst.getUTCDate(),
  ));

  if (!dates.has(cursor.toISOString().slice(0, 10))) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }

  let streak = 0;
  while (dates.has(cursor.toISOString().slice(0, 10))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

// 스트릭용 학습 날짜 조회. 최근 60일 범위를 페이지 단위로 가져와
// 다작 사용자(row 수 > 1000)에서도 날짜가 잘리지 않게 한다.
const STREAK_WINDOW_DAYS = 60;
const STREAK_PAGE_SIZE = 1000;
const STREAK_MAX_PAGES = 5;

async function fetchStudyDates(
  supabase: SupabaseClient,
  userId: string,
): Promise<Set<string>> {
  const since = new Date(Date.now() - STREAK_WINDOW_DAYS * DAY_MS).toISOString();
  const dates = new Set<string>();

  for (let page = 0; page < STREAK_MAX_PAGES; page += 1) {
    const { data } = await supabase
      .from('user_attempts')
      .select('created_at')
      .eq('user_id', userId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(page * STREAK_PAGE_SIZE, (page + 1) * STREAK_PAGE_SIZE - 1);

    const rows = data ?? [];
    rows.forEach((row) => dates.add(kstKey(row.created_at as string)));
    if (rows.length < STREAK_PAGE_SIZE) break;
  }
  return dates;
}

function computeDday(examDate: string, todayKey: string): number {
  return Math.round((Date.parse(examDate) - Date.parse(todayKey)) / DAY_MS);
}

interface AttemptRow {
  created_at: string;
  time_spent_seconds: number | null;
  is_correct: boolean | null;
}

interface UploadSummary {
  id: string;
  file_name: string;
  file_type: string;
  completed_question_count: number | null;
}

function accuracyOf(rows: AttemptRow[]): number | null {
  if (rows.length === 0) return null;
  const correct = rows.filter((row) => row.is_correct === true).length;
  return Math.round((correct / rows.length) * 100);
}

export default async function DashboardPage() {
  const localPreview =
    process.env.NODE_ENV === 'development' &&
    process.env.LOCAL_STUDENT_UI_PREVIEW === 'true';

  if (localPreview) {
    return (
      <DashboardView
        displayName="의대생 미리보기"
        weekSeconds={5400}
        weekCount={28}
        streak={5}
        weekDays={[
          { label: '월', studied: true, isToday: false },
          { label: '화', studied: true, isToday: false },
          { label: '수', studied: false, isToday: false },
          { label: '목', studied: true, isToday: false },
          { label: '금', studied: true, isToday: true },
          { label: '토', studied: false, isToday: false },
          { label: '일', studied: false, isToday: false },
        ]}
        totalSolved={186}
        weekSecondsDelta={1500}
        weekCountDelta={9}
        recentAccuracy={74}
        recentAccuracyDelta={3}
        recentDaily={[
          { dayIndex: 0, accuracy: 66 },
          { dayIndex: 1, accuracy: 69 },
          { dayIndex: 2, accuracy: 68 },
          { dayIndex: 3, accuracy: 71 },
          { dayIndex: 4, accuracy: 70 },
          { dayIndex: 5, accuracy: 72 },
          { dayIndex: 6, accuracy: 74 },
        ]}
        examDday={{ title: '순환기 중간고사', dday: 7 }}
        unresolvedWrongCount={12}
        topWeakArea={{ name: '부정맥', accuracy: 42 }}
        nextLearningSet={{
          id: 'preview-cardiology-week3',
          fileName: '순환기학_3주차.pdf',
          fileType: 'application/pdf',
          questionCount: 24,
          attemptedCount: 13,
          href: '/library?set=preview-cardiology-week3&resume=1',
          hasProgress: true,
        }}
      />
    );
  }

  const session = await getCurrentSession();
  if (!session) return null;

  const supabase = await createServerClient();
  const nowMs = Date.now();
  const weekStart = startOfKstWeekUtc();
  const weekStartMs = weekStart.getTime();
  const todayKey = kstKey(new Date(nowMs).toISOString());

  const [
    recentAttemptsRes,
    totalAttemptsRes,
    recentUploadRes,
    recentPrivateAttemptRes,
    examScheduleRes,
    unresolvedWrongRes,
    topWeakAreaRes,
    studyDates,
  ] = await Promise.all([
    // 최근 14일 풀이: 이번 주/지난주 대비/최근 7일 정답률을 한 번에 계산
    supabase
      .from('user_attempts')
      .select('created_at, time_spent_seconds, is_correct')
      .eq('user_id', session.userId)
      .gte('created_at', new Date(nowMs - 14 * DAY_MS).toISOString()),
    supabase
      .from('user_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.userId),
    supabase
      .from('user_uploads')
      .select('id, file_name, file_type, completed_question_count')
      .eq('user_id', session.userId)
      .eq('status', 'completed')
      // 자동 생성 세트(오답 유사문항·약점 집중 코스)는 '이어서 학습' 후보에서 제외
      .not('file_type', 'in', `(${Object.values(GENERATED_SET_TYPES).join(',')})`)
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('user_attempts')
      .select(`
        created_at,
        private_question:private_questions(
          upload_id,
          upload:user_uploads(id, file_name, file_type, completed_question_count)
        )
      `)
      .eq('user_id', session.userId)
      .not('private_question_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1),
    supabase
      .from('exam_schedules')
      .select('title, exam_date')
      .eq('user_id', session.userId)
      .gte('exam_date', todayKey)
      .order('exam_date', { ascending: true })
      .limit(1),
    supabase
      .from('saved_wrong_questions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.userId)
      .eq('resolved', false),
    supabase
      .from('user_weak_areas')
      .select('error_rate, attempt_count, sub_topic:sub_topics(name)')
      .eq('user_id', session.userId)
      .order('severity', { ascending: false })
      .order('error_rate', { ascending: false })
      .limit(1),
    fetchStudyDates(supabase, session.userId),
  ]);

  const recentAttempts = (recentAttemptsRes.data ?? []) as AttemptRow[];
  const weekAttempts = recentAttempts.filter(
    (attempt) => new Date(attempt.created_at).getTime() >= weekStartMs,
  );
  const weekSeconds = weekAttempts.reduce(
    (total, attempt) => total + (attempt.time_spent_seconds ?? 0),
    0,
  );
  const weekDateKeys = kstWeekDateKeys(weekStart);
  const studiedDateKeys = new Set(weekAttempts.map((attempt) => kstKey(attempt.created_at)));
  const weekDays = weekDateKeys.map((key, index) => ({
    label: WEEKDAY_LABELS[index],
    studied: studiedDateKeys.has(key),
    isToday: key === todayKey,
  }));

  // 지난주 대비: 지난주 시작 ~ (지금 - 7일)까지, 같은 경과 시점끼리 비교
  const prevWeekStartMs = weekStartMs - 7 * DAY_MS;
  const prevWeekAttempts = recentAttempts.filter((attempt) => {
    const t = new Date(attempt.created_at).getTime();
    return t >= prevWeekStartMs && t < weekStartMs;
  });
  const prevWeekToDate = prevWeekAttempts.filter(
    (attempt) => new Date(attempt.created_at).getTime() <= nowMs - 7 * DAY_MS,
  );
  const prevWeekSeconds = prevWeekToDate.reduce(
    (total, attempt) => total + (attempt.time_spent_seconds ?? 0),
    0,
  );
  const hasPrevWeek = prevWeekAttempts.length > 0;
  const weekSecondsDelta = hasPrevWeek ? weekSeconds - prevWeekSeconds : null;
  const weekCountDelta = hasPrevWeek ? weekAttempts.length - prevWeekToDate.length : null;

  // 최근 7일 정답률 + 직전 7일 대비, 일자별 추이(스파크라인)
  const recent7 = recentAttempts.filter(
    (attempt) => new Date(attempt.created_at).getTime() >= nowMs - 7 * DAY_MS,
  );
  const prior7 = recentAttempts.filter((attempt) => {
    const t = new Date(attempt.created_at).getTime();
    return t >= nowMs - 14 * DAY_MS && t < nowMs - 7 * DAY_MS;
  });
  const recentAccuracy = accuracyOf(recent7);
  const priorAccuracy = accuracyOf(prior7);
  const recentAccuracyDelta =
    recentAccuracy !== null && priorAccuracy !== null
      ? recentAccuracy - priorAccuracy
      : null;

  const dailyBuckets = new Map<string, { total: number; correct: number }>();
  recent7.forEach((attempt) => {
    const key = kstKey(attempt.created_at);
    const bucket = dailyBuckets.get(key) ?? { total: 0, correct: 0 };
    bucket.total += 1;
    if (attempt.is_correct === true) bucket.correct += 1;
    dailyBuckets.set(key, bucket);
  });
  const recentDaily = Array.from({ length: 7 }, (_, index) => {
    const key = kstKey(new Date(nowMs - (6 - index) * DAY_MS).toISOString());
    const bucket = dailyBuckets.get(key);
    return bucket
      ? { dayIndex: index, accuracy: Math.round((bucket.correct / bucket.total) * 100) }
      : null;
  }).filter((point): point is { dayIndex: number; accuracy: number } => point !== null);

  const totalSolved = totalAttemptsRes.count ?? 0;

  const examRow = (examScheduleRes.data ?? [])[0] ?? null;
  const examDday = examRow
    ? { title: examRow.title as string, dday: computeDday(examRow.exam_date as string, todayKey) }
    : null;

  const unresolvedWrongCount = unresolvedWrongRes.count ?? 0;

  const weakRow = (topWeakAreaRes.data ?? [])[0] as
    | { error_rate: number; attempt_count: number; sub_topic: unknown }
    | undefined;
  const weakSubTopic = pickOne(weakRow?.sub_topic) as { name: string } | null;
  const topWeakArea = weakRow && weakSubTopic && weakRow.attempt_count > 0
    ? {
        name: weakSubTopic.name,
        accuracy: Math.round((1 - weakRow.error_rate) * 100),
      }
    : null;

  const recentUpload = ((recentUploadRes.data ?? [])[0] ?? null) as UploadSummary | null;
  const recentAttempt = ((recentPrivateAttemptRes.data ?? [])[0] ?? null) as Record<string, unknown> | null;
  const recentPrivateQuestion = pickOne(recentAttempt?.private_question) as Record<string, unknown> | null;
  const recentStudyUpload = pickOne(recentPrivateQuestion?.upload) as UploadSummary | null;
  const nextUpload = recentStudyUpload ?? recentUpload;

  let nextLearningSet = null;
  if (nextUpload) {
    const [{ count }, attemptedRes] = await Promise.all([
      supabase
        .from('private_questions')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', session.userId)
        .eq('upload_id', nextUpload.id),
      supabase
        .from('user_attempts')
        .select('private_question_id, private_question:private_questions!inner(upload_id)')
        .eq('user_id', session.userId)
        .eq('private_question.upload_id', nextUpload.id)
        .limit(5000),
    ]);

    const attemptedIds = new Set(
      (attemptedRes.data ?? [])
        .map((row) => row.private_question_id as string | null)
        .filter((id): id is string => id !== null),
    );

    nextLearningSet = {
      id: nextUpload.id,
      fileName: nextUpload.file_name,
      fileType: nextUpload.file_type,
      questionCount: count ?? nextUpload.completed_question_count ?? 0,
      attemptedCount: attemptedIds.size,
      href: isGeneratedSet(nextUpload.file_type)
        ? `/similar-practice/${nextUpload.id}`
        : `/library?set=${encodeURIComponent(nextUpload.id)}&resume=1`,
      hasProgress: Boolean(recentStudyUpload),
    };
  }

  return (
    <DashboardView
      displayName={session.profile.displayName ?? '학생'}
      weekSeconds={weekSeconds}
      weekCount={weekAttempts.length}
      streak={computeStreak(studyDates)}
      weekDays={weekDays}
      totalSolved={totalSolved}
      weekSecondsDelta={weekSecondsDelta}
      weekCountDelta={weekCountDelta}
      recentAccuracy={recentAccuracy}
      recentAccuracyDelta={recentAccuracyDelta}
      recentDaily={recentDaily}
      examDday={examDday}
      unresolvedWrongCount={unresolvedWrongCount}
      topWeakArea={topWeakArea}
      nextLearningSet={nextLearningSet}
    />
  );
}

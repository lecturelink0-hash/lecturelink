import type { Metadata } from 'next';
import { DashboardView } from './DashboardView';
import { getCurrentSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { KST_OFFSET_MS, calcStreak, kstDateKey } from '@/lib/utils/kst';

export const metadata: Metadata = { title: '홈' };

const WEEKDAY_LABELS = ['월', '화', '수', '목', '금', '토', '일'];

function pickOne(value: unknown): unknown {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
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
    kstDateKey(new Date(startUtc.getTime() + index * 86400000))
  ));
}

interface AttemptRow {
  created_at: string;
  time_spent_seconds: number | null;
}

interface UploadSummary {
  id: string;
  file_name: string;
  file_type: string;
  completed_question_count: number | null;
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
        streak={2}
        weekDays={[
          { label: '월', studied: true, isToday: false },
          { label: '화', studied: true, isToday: false },
          { label: '수', studied: false, isToday: false },
          { label: '목', studied: true, isToday: false },
          { label: '금', studied: true, isToday: true },
          { label: '토', studied: false, isToday: false },
          { label: '일', studied: false, isToday: false },
        ]}
        overallAccuracy={74}
        totalSolved={186}
        nextLearningSet={{
          id: 'preview-cardiology-week3',
          fileName: '순환기학_3주차.pdf',
          fileType: 'application/pdf',
          questionCount: 24,
          href: '/library?set=preview-cardiology-week3&resume=1',
          hasProgress: true,
        }}
      />
    );
  }

  const session = await getCurrentSession();
  if (!session) return null;

  const supabase = await createServerClient();
  const weekStart = startOfKstWeekUtc();

  const [
    weekAttemptsRes,
    allDatesRes,
    totalAttemptsRes,
    correctAttemptsRes,
    recentUploadRes,
    recentPrivateAttemptRes,
  ] = await Promise.all([
    supabase
      .from('user_attempts')
      .select('created_at, time_spent_seconds')
      .eq('user_id', session.userId)
      .gte('created_at', weekStart.toISOString()),
    supabase
      .from('user_attempts')
      .select('created_at')
      .eq('user_id', session.userId)
      .order('created_at', { ascending: false })
      .limit(400),
    supabase
      .from('user_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.userId),
    supabase
      .from('user_attempts')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.userId)
      .eq('is_correct', true),
    supabase
      .from('user_uploads')
      .select('id, file_name, file_type, completed_question_count')
      .eq('user_id', session.userId)
      .eq('status', 'completed')
      .neq('file_type', 'generated/similar')
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
  ]);

  const weekAttempts = (weekAttemptsRes.data ?? []) as AttemptRow[];
  const weekSeconds = weekAttempts.reduce(
    (total, attempt) => total + (attempt.time_spent_seconds ?? 0),
    0,
  );
  const weekDateKeys = kstWeekDateKeys(weekStart);
  const studiedDateKeys = new Set(weekAttempts.map((attempt) => kstDateKey(attempt.created_at)));
  const todayKey = kstDateKey(new Date());
  const weekDays = weekDateKeys.map((key, index) => ({
    label: WEEKDAY_LABELS[index],
    studied: studiedDateKeys.has(key),
    isToday: key === todayKey,
  }));

  const allDates = new Set(
    (allDatesRes.data ?? []).map((attempt) => kstDateKey(attempt.created_at as string)),
  );
  const totalSolved = totalAttemptsRes.count ?? 0;
  const totalCorrect = correctAttemptsRes.count ?? 0;
  const overallAccuracy = totalSolved > 0
    ? Math.round((totalCorrect / totalSolved) * 100)
    : 0;

  const recentUpload = ((recentUploadRes.data ?? [])[0] ?? null) as UploadSummary | null;
  const recentAttempt = ((recentPrivateAttemptRes.data ?? [])[0] ?? null) as Record<string, unknown> | null;
  const recentPrivateQuestion = pickOne(recentAttempt?.private_question) as Record<string, unknown> | null;
  const recentStudyUpload = pickOne(recentPrivateQuestion?.upload) as UploadSummary | null;
  const nextUpload = recentStudyUpload ?? recentUpload;

  let nextLearningSet = null;
  if (nextUpload) {
    const { count } = await supabase
      .from('private_questions')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', session.userId)
      .eq('upload_id', nextUpload.id);

    nextLearningSet = {
      id: nextUpload.id,
      fileName: nextUpload.file_name,
      fileType: nextUpload.file_type,
      questionCount: count ?? nextUpload.completed_question_count ?? 0,
      href: nextUpload.file_type === 'generated/similar'
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
      streak={calcStreak(allDates)}
      weekDays={weekDays}
      overallAccuracy={overallAccuracy}
      totalSolved={totalSolved}
      nextLearningSet={nextLearningSet}
    />
  );
}

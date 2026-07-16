/**
 * GET /api/study-calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * 날짜별 학습 진행도 집계 (열품타 스타일 캘린더 색칠용).
 * user_attempts 를 KST 기준 날짜로 그룹핑하여 푼 문항 수 / 정답 수를 반환.
 */

import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling } from '@/lib/utils/api';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstDateKey(iso: string): string {
  return new Date(new Date(iso).getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export const GET = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const { searchParams } = new URL(request.url);
  const supabase = await createServerClient();

  // 기본: 최근 120일
  const to = searchParams.get('to');
  const from = searchParams.get('from');

  let query = supabase
    .from('user_attempts')
    .select('created_at, is_correct, time_spent_seconds')
    .eq('user_id', session.userId)
    .order('created_at', { ascending: false })
    .limit(5000);

  if (from) query = query.gte('created_at', `${from}T00:00:00Z`);
  if (to) query = query.lte('created_at', `${to}T23:59:59Z`);

  const { data, error } = await query;
  if (error) throw error;

  const byDate: Record<string, { count: number; correct: number }> = {};
  for (const row of data ?? []) {
    const key = kstDateKey(row.created_at);
    if (!byDate[key]) byDate[key] = { count: 0, correct: 0 };
    byDate[key].count += 1;
    if (row.is_correct) byDate[key].correct += 1;
  }

  const days = Object.entries(byDate)
    .map(([date, v]) => ({ date, count: v.count, correct: v.correct }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const totalSolved = (data ?? []).length;
  const totalCorrect = (data ?? []).filter((r) => r.is_correct).length;
  const totalStudySeconds = (data ?? []).reduce(
    (s, r) => s + ((r as { time_spent_seconds: number | null }).time_spent_seconds ?? 0),
    0,
  );

  return ok({
    days,
    summary: {
      totalSolved,
      totalCorrect,
      accuracy: totalSolved === 0 ? 0 : totalCorrect / totalSolved,
      activeDays: days.length,
      totalStudySeconds,
    },
  });
});

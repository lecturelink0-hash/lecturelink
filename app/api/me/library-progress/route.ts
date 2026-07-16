/**
 * GET /api/me/library-progress
 *
 * 내 문제집(업로드=세트)별 학습 진행도/정답률 집계.
 *  · total     : 세트(업로드)에 속한 private 문항 수
 *  · attempted : 그중 한 번이라도 푼 문항 수(중복 제외)
 *  · correct   : 그중 "가장 최근 시도"가 정답인 문항 수
 *
 * accuracy = correct / attempted, progress = attempted / total (프론트에서 계산).
 * RLS 로 본인 데이터만 조회된다(server client).
 */

import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling } from '@/lib/utils/api';

export const GET = withErrorHandling(async () => {
  const session = await requireSession();
  const supabase = await createServerClient();

  // 본인 private 문항 → 업로드 매핑
  const { data: pqs, error: pqErr } = await supabase
    .from('private_questions')
    .select('id, upload_id')
    .limit(5000);
  if (pqErr) throw pqErr;

  // 본인 private 풀이 기록(최신순) — 문항별 첫 등장 = 최신 시도
  const { data: atts, error: aErr } = await supabase
    .from('user_attempts')
    .select('private_question_id, is_correct, selected_index, created_at')
    .not('private_question_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(10000);
  if (aErr) throw aErr;

  const uploadOf = new Map<string, string>();
  const byUpload: Record<string, { total: number; attempted: number; correct: number }> = {};
  for (const pq of pqs ?? []) {
    const uid = pq.upload_id as string;
    uploadOf.set(pq.id as string, uid);
    if (!byUpload[uid]) byUpload[uid] = { total: 0, attempted: 0, correct: 0 };
    byUpload[uid].total += 1;
  }

  // 문항별 최신 시도(정답 여부 + 선택지) — 이어풀기 시 이전 답 복원용
  const latestCorrect = new Map<string, boolean>();
  const byQuestion: Record<string, { selectedIndex: number; isCorrect: boolean }> = {};
  for (const a of atts ?? []) {
    const pid = a.private_question_id as string;
    if (!latestCorrect.has(pid)) {
      latestCorrect.set(pid, a.is_correct as boolean);
      byQuestion[pid] = {
        selectedIndex: (a.selected_index as number) ?? -1,
        isCorrect: a.is_correct as boolean,
      };
    }
  }

  let overallAttempted = 0;
  let overallCorrect = 0;
  for (const [pid, correct] of latestCorrect.entries()) {
    const uid = uploadOf.get(pid);
    if (!uid) continue; // 삭제됐거나 이 세트에 없는 문항
    byUpload[uid].attempted += 1;
    overallAttempted += 1;
    if (correct) {
      byUpload[uid].correct += 1;
      overallCorrect += 1;
    }
  }

  return ok({
    overall: { attempted: overallAttempted, correct: overallCorrect },
    byUpload,
    byQuestion,
  });
});

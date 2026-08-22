/**
 * POST /api/question-reports — 문항 오류 신고 (분담표 A14 · 가이드 §8.1)
 * GET  /api/question-reports — 내가 낸 신고 (관리자는 전체 + 상태 필터)
 *
 * 기존 out_of_scope_feedback 은 '범위 밖' 전용이고 공용 문항·코호트가 필수라
 * 개인 문항(private_questions)의 정답 오류·지문 오류를 담을 수 없다. 가이드가 요구하는
 * '오류 신고'는 그보다 넓어 별도 테이블을 쓴다(00044).
 *
 * 신고는 문항 통계와 함께 읽어야 의미가 있다 — point-biserial 이 음수인 문항에
 * '정답 오류' 신고가 겹치면 그건 거의 확실한 결함이다(A13 과 짝을 이룬다).
 */
import { z } from 'zod';
import { requireAuthUser } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, err, withErrorHandling } from '@/lib/utils/api';

const REASONS = [
  'wrong_answer',
  'multiple_answers',
  'stem_error',
  'choice_error',
  'explanation_error',
  'image_problem',
  'out_of_scope',
  'other',
] as const;

const bodySchema = z
  .object({
    question_id: z.string().uuid().optional(),
    private_question_id: z.string().uuid().optional(),
    attempt_id: z.string().uuid().nullable().optional(),
    reason: z.enum(REASONS),
    note: z.string().trim().max(1000).optional(),
  })
  // 정확히 한 종류의 문항을 가리켜야 한다 — DB 의 XOR 제약과 같은 규칙을 입구에서도 막는다.
  // 여기서 안 막으면 23514(check violation)가 그대로 500 이 되어 학생은 원인을 알 수 없다.
  .refine(
    (b) => Boolean(b.question_id) !== Boolean(b.private_question_id),
    { message: 'question_id 와 private_question_id 중 정확히 하나만 보내야 합니다.' },
  );

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireAuthUser();
  const body = bodySchema.parse(await request.json());
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from('question_reports')
    .insert({
      user_id: session.userId,
      question_id: body.question_id ?? null,
      private_question_id: body.private_question_id ?? null,
      attempt_id: body.attempt_id ?? null,
      reason: body.reason,
      note: body.note?.trim() || null,
    } as never)
    .select('id, created_at')
    .single();

  if (error) {
    // 같은 사람이 같은 문항을 같은 사유로 다시 신고 — 오류가 아니라 이미 접수된 것이다.
    // 집계가 부풀려지지 않게 DB 가 막고, 사용자에게는 정상으로 보이게 한다.
    if (error.code === '23505') return ok({ id: null, duplicate: true });
    if (error.code === '42P01') {
      return err('not_ready', '오류 신고 기능이 아직 준비되지 않았습니다.', 503);
    }
    throw error;
  }
  return ok({ id: data.id, duplicate: false, createdAt: data.created_at });
});

export const GET = withErrorHandling(async (request: Request) => {
  const session = await requireAuthUser();
  const supabase = await createServerClient();
  const status = new URL(request.url).searchParams.get('status');

  // RLS 가 본인 것만 보여준다. 관리자는 admin_read 정책으로 전체가 보인다 —
  // 여기서 user_id 로 다시 거르면 관리자가 검수 목록을 못 본다.
  let query = supabase
    .from('question_reports')
    .select('id, question_id, private_question_id, reason, note, status, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  const STATUSES = ['open', 'reviewing', 'resolved', 'rejected'] as const;
  const wanted = STATUSES.find((s) => s === status);
  if (wanted) query = query.eq('status', wanted);
  const { data, error } = await query;
  if (error) {
    if (error.code === '42P01') return ok({ reports: [] });
    throw error;
  }
  return ok({ reports: data ?? [], userId: session.userId });
});

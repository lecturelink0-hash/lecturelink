/**
 * GET  /api/mock-exams   — 본인 모의고사 세션 목록
 * POST /api/mock-exams   — 새 모의고사 세션 생성 (저장된 풀에서 문항 샘플)
 *
 * 기획서: 모의고사 문제 전체를 AI 신규 생성하면 느리고 비싸므로,
 *         웬만하면 저장된 서버 풀에서 적절히 가져온다. (국가고시 대비 이상)
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { createAdminClient } from '@/lib/db/admin';
import { requireQuota, consumeQuota } from '@/lib/quota/check';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

export const GET = withErrorHandling(async () => {
  await requireSession();
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from('mock_exam_sessions')
    .select('id, title, subject_ids, total, score, status, started_at, submitted_at, duration_seconds, created_at')
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) throw error;
  return ok(data ?? []);
});

const createSchema = z.object({
  subject_ids: z.array(z.string().uuid()).min(1).max(10),
  count: z.number().int().min(5).max(100).default(20),
  title: z.string().max(100).optional(),
  duration_seconds: z.number().int().min(0).max(36000).nullable().optional(),
});

// 모의고사는 "국가고시 대비(standard) 이상" 요금제에서만 이용 가능(기획서).
// 무료/내신 대비(lite) 는 요금제 업그레이드 유도.
const MOCK_ALLOWED_TIERS = new Set(['standard', 'pro', 'unlimited']);

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();

  // 티어 게이팅 — 서버측 강제 (admin 은 항상 허용).
  // 개발단계: env MOCK_UNLOCKED=true 면 전 요금제(무료 포함) 허용. 원복은 env 제거+재시작.
  const mockUnlocked = process.env.MOCK_UNLOCKED === 'true';
  if (!mockUnlocked && session.role !== 'admin' && !MOCK_ALLOWED_TIERS.has(session.profile.planTier)) {
    throw new ApiException(
      'tier_required',
      '모의고사는 국가고시 대비 이상 요금제에서 이용할 수 있어요.',
      403,
    );
  }

  const body = createSchema.parse(await request.json());
  const supabase = await createServerClient();
  const admin = createAdminClient();

  // 1) 선택 과목의 sub_topic 수집
  const { data: subTopics, error: stErr } = await admin
    .from('sub_topics')
    .select('id')
    .in('subject_id', body.subject_ids);
  if (stErr) throw stErr;

  const stIds = (subTopics ?? []).map((s) => s.id);
  if (stIds.length === 0) {
    throw new ApiException('no_content', '선택한 과목에 세부주제가 없습니다.', 400);
  }

  // 2) 활성 문항 풀에서 후보 수집 (curated 우선 노출되도록 정렬 후 셔플)
  const { data: pool, error: poolErr } = await admin
    .from('questions')
    .select('id, tier')
    .in('sub_topic_id', stIds)
    .eq('status', 'active')
    .limit(body.count * 5);
  if (poolErr) throw poolErr;

  if (!pool || pool.length === 0) {
    throw new ApiException('no_content', '선택한 과목에 출제 가능한 문항이 아직 없습니다.', 400);
  }

  // curated 가 앞에 오도록 가중 후 셔플
  const tierWeight: Record<string, number> = { curated: 0, community: 1, beta: 2 };
  const shuffled = [...pool]
    .sort((a, b) => (tierWeight[a.tier] ?? 1) - (tierWeight[b.tier] ?? 1) || Math.random() - 0.5)
    .slice(0, body.count);
  const questionIds = shuffled.map((q) => q.id);

  // 3) quota 차감 (저장 풀이므로 AI 비용 없음, 문항 제공 한도만 소비)
  await requireQuota(session.userId, 'questions', questionIds.length);

  // 4) 세션 생성
  const title =
    body.title ?? `모의고사 ${new Date().toISOString().slice(0, 10)} (${questionIds.length}문항)`;

  const { data: created, error: insErr } = await supabase
    .from('mock_exam_sessions')
    .insert({
      user_id: session.userId,
      title,
      subject_ids: body.subject_ids,
      question_ids: questionIds,
      answers: Array(questionIds.length).fill(-1),
      flagged: [],
      total: questionIds.length,
      duration_seconds: body.duration_seconds ?? null,
      status: 'in_progress',
    })
    .select('id, title, total')
    .single();
  if (insErr) throw insErr;

  await consumeQuota(session.userId, 'questions', questionIds.length);

  return ok({ id: created.id, title: created.title, total: created.total }, 201);
});

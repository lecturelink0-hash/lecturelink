/**
 * POST /api/questions/weak-area-set
 *
 * 약점 세부주제 집중 코스의 백업 경로.
 *
 * 공개 문제 풀에 해당 세부주제 문항이 하나도 없을 때, 그 학생의 '내 문제집'
 * (private_questions) 문항을 예시로 삼아 같은 주제 문항을 미리 생성해 둔다.
 * 생성물은 새 문제집(user_uploads 1건 + private_questions N건)으로 저장되고,
 * 클라이언트는 /similar-practice/{upload_id} 로 이동해 바로 풀 수 있다.
 *
 * Body:
 *   { sub_topic_id: uuid }
 *
 * 응답:
 *   { mode: 'pool',      question_count }              — 풀에 이미 문항이 있음(생성 안 함)
 *   { mode: 'generated', upload_id, question_count, seeded_from }
 */

import { z } from 'zod';
import { requireAuthUser } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { generateQuestions } from '@/lib/ai/generate';
import { recordAiCost, requireDailyCostCap } from '@/lib/ai/cost-cap';
import { requireQuota, consumeQuota } from '@/lib/quota/check';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const bodySchema = z.object({
  sub_topic_id: z.string().uuid(),
});

/** 한 번에 미리 만들어 두는 문항 수. */
const GENERATE_COUNT = 5;
/** 생성 프롬프트에 붙일 '내 문제집' 예시 최대 개수. */
const SEED_LIMIT = 3;

export const maxDuration = 120;

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireAuthUser();
  const body = bodySchema.parse(await request.json());
  const admin = createAdminClient();

  const { data: subTopic } = await admin
    .from('sub_topics')
    .select('id, name, exam_relevance, is_risk_category, subject_id, subject:subjects(id, name)')
    .eq('id', body.sub_topic_id)
    .maybeSingle();
  if (!subTopic) {
    throw new ApiException('sub_topic_not_found', '세부주제를 찾을 수 없습니다.', 404);
  }
  const subject = Array.isArray(subTopic.subject) ? subTopic.subject[0] : subTopic.subject;
  if (!subject) throw new ApiException('subject_not_found', '과목을 찾을 수 없습니다.', 404);

  // ── 1. 공개 풀 확인 — 있으면 생성하지 않고 그대로 쓰게 한다 ──
  const { count: poolCount } = await admin
    .from('questions')
    .select('id', { count: 'exact', head: true })
    .eq('sub_topic_id', subTopic.id)
    .eq('status', 'active');

  if ((poolCount ?? 0) > 0) {
    return ok({ mode: 'pool' as const, question_count: poolCount ?? 0 });
  }

  // ── 2. '내 문제집'에서 씨앗 문항 수집 ──
  // 같은 세부주제를 먼저 찾고, 없으면 같은 과목의 다른 세부주제로 넓힌다.
  let seededFrom: 'sub_topic' | 'subject' | 'none' = 'sub_topic';
  let { data: seeds } = await admin
    .from('private_questions')
    .select('stem, choices, explanation, difficulty')
    .eq('user_id', session.userId)
    .eq('sub_topic_id', subTopic.id)
    .order('created_at', { ascending: false })
    .limit(SEED_LIMIT);

  if (!seeds || seeds.length === 0) {
    const { data: siblingTopics } = await admin
      .from('sub_topics')
      .select('id')
      .eq('subject_id', subTopic.subject_id);
    const siblingIds = (siblingTopics ?? []).map((s) => s.id);

    if (siblingIds.length > 0) {
      const { data: subjectSeeds } = await admin
        .from('private_questions')
        .select('stem, choices, explanation, difficulty')
        .eq('user_id', session.userId)
        .in('sub_topic_id', siblingIds)
        .order('created_at', { ascending: false })
        .limit(SEED_LIMIT);
      seeds = subjectSeeds ?? [];
      seededFrom = seeds.length > 0 ? 'subject' : 'none';
    } else {
      seeds = [];
      seededFrom = 'none';
    }
  }

  await requireDailyCostCap();
  await requireQuota(session.userId, 'questions', GENERATE_COUNT);

  // 씨앗 문항의 평균 난이도를 따라간다(없으면 2).
  const difficulty = seeds.length > 0
    ? (Math.min(3, Math.max(1, Math.round(
        seeds.reduce((sum, s) => sum + (s.difficulty ?? 2), 0) / seeds.length,
      ))) as 1 | 2 | 3)
    : 2;

  const generated = await generateQuestions({
    subjectName: subject.name,
    subTopicName: subTopic.name,
    examRelevance: (subTopic.exam_relevance ?? 2) as 1 | 2 | 3,
    isRiskCategory: subTopic.is_risk_category,
    difficulty,
    // 내 문제집 예시가 있으면 그 출제 스타일을 따라가고, 없으면 국시 형식으로 만든다.
    style: seeds.length > 0 ? 'professor' : 'kmle',
    examples: seeds.length > 0
      ? seeds.map((s) => ({
          stem: s.stem,
          choices: s.choices as string[],
          explanation: s.explanation ?? '',
        }))
      : undefined,
    count: GENERATE_COUNT,
  });

  const questions = generated.questions.slice(0, GENERATE_COUNT);
  if (questions.length === 0) {
    throw new ApiException('generation_failed', '문항을 생성하지 못했습니다. 잠시 후 다시 시도해주세요.', 502);
  }

  const { data: upload, error: uploadError } = await admin
    .from('user_uploads')
    .insert({
      user_id: session.userId,
      file_name: `약점 집중 코스 · ${subTopic.name}`,
      file_type: 'generated/weak-area',
      file_size_bytes: 0,
      storage_path: '',
      status: 'completed',
      processed_at: new Date().toISOString(),
      page_count: 0,
    })
    .select('id')
    .single();
  if (uploadError || !upload) {
    throw new ApiException('set_create_failed', '문제집 생성에 실패했습니다.', 500);
  }

  const { data: saved, error: saveError } = await admin
    .from('private_questions')
    .insert(questions.map((question, index) => ({
      user_id: session.userId,
      upload_id: upload.id,
      sub_topic_id: subTopic.id,
      stem: question.stem,
      choices: question.choices,
      answer_index: question.answer_index,
      explanation: question.explanation,
      concepts: question.concepts ?? [],
      difficulty: question.difficulty,
      generation_slot: index + 1,
    })))
    .select('id');
  if (saveError || !saved || saved.length === 0) {
    await admin.from('user_uploads').delete().eq('id', upload.id);
    throw new ApiException('question_save_failed', '생성 문항 저장에 실패했습니다.', 500);
  }

  await consumeQuota(session.userId, 'questions', saved.length);
  await recordAiCost({
    userId: session.userId,
    endpoint: 'questions.weak-area-set',
    model: generated.usage.model,
    costUsd: generated.usage.costUSD,
    inputTokens: generated.usage.inputTokens,
    outputTokens: generated.usage.outputTokens,
    metadata: {
      subTopicId: subTopic.id,
      uploadId: upload.id,
      count: saved.length,
      seededFrom,
    },
  });

  return ok({
    mode: 'generated' as const,
    upload_id: upload.id,
    question_count: saved.length,
    seeded_from: seededFrom,
  });
});

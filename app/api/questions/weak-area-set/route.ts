/**
 * POST /api/questions/weak-area-set
 *
 * 약점 세부주제 집중 코스가 **최소 3문항**을 갖도록 채운다.
 *
 * 왜 3문항인가(2026-08-16):
 *   "마르판 증후군 집중 코스"가 문항 1/1 로 떴다. 운영 DB 실측 결과 그 세부주제의
 *   공개 풀에 active 문항이 1개뿐이었고, 1~2개뿐인 세부주제가 25개 더 있었다.
 *   종전 코드는 풀이 **완전히 비었을 때만** 생성했다(poolCount > 0 이면 즉시 반환).
 *   그래서 1개짜리 주제는 영원히 1개짜리로 남았다. 한 문항으로는 약점이 고쳐졌는지
 *   확인할 수 없으므로 하한을 둔다.
 *
 * 무엇을 겨냥해 만드는가:
 *   만들기 전에 그 학생의 오답과 **고른 선지**를 분석해 오답 사유를 판정하고
 *   (개념 부족 / 감별진단 / 검사 해석 / 치료 선택 / 조건 놓침), 그 사유를 겨냥한
 *   문항을 만든다. 판정 근거가 약하면(확신도 < 0.4) 브리프를 넘기지 않는다.
 *
 * 두 갈래:
 *   0 < 풀 < 3  → **공개 풀 보충**. admission 파이프라인(생성→형식교정→누출린트→
 *                 검증→태깅→중복제거)을 거쳐 questions 에 넣는다. 집중 코스가 읽는
 *                 곳이 바로 이 풀이라, 학생은 같은 화면에서 이어서 푼다.
 *   풀 == 0     → 기존 '내 문제집 기반 사전 생성' 경로. 씨앗이 있으면 교수 스타일을
 *                 따라가므로 개인화 가치가 있어 그대로 둔다.
 *
 * Body:
 *   { sub_topic_id: uuid }
 *
 * 응답:
 *   { mode: 'pool',      question_count }                          — 이미 3문항 이상
 *   { mode: 'topped_up', question_count, added, rejected, ... }    — 공개 풀 보충
 *   { mode: 'generated', upload_id, question_count, seeded_from }  — 내 문제집 기반 생성
 *   공통으로 error_analysis 를 함께 돌려준다(판정하지 못했으면 null).
 */

import { z } from 'zod';
import { requireAuthUser } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { generateQuestions } from '@/lib/ai/generate';
import { admitGeneratedQuestions } from '@/lib/ai/admission';
import { analyzeWrongAttempts, buildErrorFocus, type ErrorAnalysis } from '@/lib/ai/error-analysis';
import { collectWrongAttempts } from '@/lib/recommend/wrong-attempts';
import { recordAiCost, requireDailyCostCap } from '@/lib/ai/cost-cap';
import { requireQuota, consumeQuota } from '@/lib/quota/check';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
import { FOCUS_MIN_QUESTIONS } from '@/lib/recommend/engine';

const bodySchema = z.object({
  sub_topic_id: z.string().uuid(),
});

/** 풀이 비어 있을 때 '내 문제집' 기반으로 한 번에 만들어 두는 문항 수. */
const GENERATE_COUNT = 5;
/** 생성 프롬프트에 붙일 '내 문제집' 예시 최대 개수. */
const SEED_LIMIT = 3;
/**
 * 공개 풀 보충 시 부족분보다 몇 개 더 만들지.
 *
 * admission 은 정답 누출(F17 계열)·의학 검증·중복에서 문항을 떨어뜨린다. 부족분만큼만
 * 만들면 한 개만 떨어져도 3문항을 못 채운다. 여유분을 두고 만들어 통과한 것만 남긴다.
 */
const TOPUP_MARGIN = 3;
/** 오답 사유 판정에 넣을 오답 최대 개수. */
const WRONG_SAMPLE_LIMIT = 8;

export const maxDuration = 120;

/** 화면에 그대로 내려보낼 판정 요약. targeting_brief 원문은 내부용이라 뺀다. */
function serializeAnalysis(analysis: ErrorAnalysis | null) {
  if (!analysis) return null;
  return {
    primary_reason: analysis.primaryReason,
    primary_label: analysis.primaryLabel,
    confidence: analysis.confidence,
    evidence: analysis.evidence,
    sample_size: analysis.sampleSize,
    confusion_pairs: analysis.confusionPairs,
    /** 확신도가 낮아 생성에 반영하지 못했으면 false. 화면에서 과장하지 않기 위함. */
    applied_to_generation: buildErrorFocus(analysis) !== undefined,
  };
}

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

  // ── 1. 공개 풀 확인 — 하한(3문항)을 넘겼으면 만들지 않는다 ──
  const { count: poolCount } = await admin
    .from('questions')
    .select('id', { count: 'exact', head: true })
    .eq('sub_topic_id', subTopic.id)
    .eq('status', 'active');

  const pool = poolCount ?? 0;
  if (pool >= FOCUS_MIN_QUESTIONS) {
    return ok({ mode: 'pool' as const, question_count: pool, error_analysis: null });
  }

  // ── 2. 오답 사유 판정 — 무엇을 겨냥해 만들지 먼저 정한다 ──
  const { data: siblingTopics } = await admin
    .from('sub_topics')
    .select('id')
    .eq('subject_id', subTopic.subject_id);
  const siblingIds = (siblingTopics ?? []).map((s) => s.id);

  const wrong = await collectWrongAttempts(admin, {
    userId: session.userId,
    subTopicId: subTopic.id,
    siblingSubTopicIds: siblingIds.length > 0 ? siblingIds : [subTopic.id],
    limit: WRONG_SAMPLE_LIMIT,
  });

  let analysis: ErrorAnalysis | null = null;
  if (wrong.items.length > 0) {
    // 판정 실패가 문항 생성 자체를 막지 않게 한다 — 겨냥 없이라도 3문항은 채워야 한다.
    analysis = await analyzeWrongAttempts({
      subjectName: subject.name,
      subTopicName: subTopic.name,
      items: wrong.items,
    }).catch((e) => {
      console.error('[weak-area-set] 오답 사유 판정 실패:', e);
      return null;
    });
  }
  const errorFocus = buildErrorFocus(analysis);

  if (analysis) {
    await recordAiCost({
      userId: session.userId,
      endpoint: 'questions.weak-area-set.error-analysis',
      model: analysis.usage.model,
      costUsd: analysis.usage.costUSD,
      inputTokens: analysis.usage.inputTokens,
      outputTokens: analysis.usage.outputTokens,
      metadata: {
        subTopicId: subTopic.id,
        primaryReason: analysis.primaryReason,
        confidence: analysis.confidence,
        sampleSize: analysis.sampleSize,
      },
    });
  }

  // ── 3-A. 풀에 문항이 조금 있음 → 공개 풀을 3문항까지 보충 ──
  if (pool > 0) {
    const shortfall = FOCUS_MIN_QUESTIONS - pool;
    const requestCount = shortfall + TOPUP_MARGIN;

    await requireDailyCostCap();
    await requireQuota(session.userId, 'questions', requestCount);

    const result = await admitGeneratedQuestions({
      subjectId: subTopic.subject_id,
      subjectName: subject.name,
      subTopicId: subTopic.id,
      subTopicName: subTopic.name,
      examRelevance: (subTopic.exam_relevance ?? 2) as 1 | 2 | 3,
      isRiskCategory: subTopic.is_risk_category,
      // 약점 보완은 감별을 요구해야 의미가 있다. 개념 부족 판정일 때만 한 단계 낮춘다.
      difficulty: analysis?.primaryReason === 'concept_gap' ? 2 : 3,
      count: requestCount,
      style: 'kmle',
      source: 'ai_user_triggered',
      createdBy: session.userId,
      errorFocus,
    });

    await consumeQuota(session.userId, 'questions', result.admitted.length);

    const { count: afterCount } = await admin
      .from('questions')
      .select('id', { count: 'exact', head: true })
      .eq('sub_topic_id', subTopic.id)
      .eq('status', 'active');

    return ok({
      mode: 'topped_up' as const,
      question_count: afterCount ?? pool + result.admitted.length,
      added: result.admitted.length,
      rejected: result.totals.rejected,
      duplicates_skipped: result.totals.duplicatesSkipped,
      /** 하한을 못 채웠으면 화면이 그렇게 말해야 한다. 조용히 넘기지 않는다. */
      reached_minimum: (afterCount ?? 0) >= FOCUS_MIN_QUESTIONS,
      error_analysis: serializeAnalysis(analysis),
    });
  }

  // ── 3-B. 풀이 완전히 비어 있음 → '내 문제집' 기반 사전 생성 (기존 경로) ──
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
    errorFocus,
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
      errorFocusApplied: errorFocus !== undefined,
    },
  });

  return ok({
    mode: 'generated' as const,
    upload_id: upload.id,
    question_count: saved.length,
    seeded_from: seededFrom,
    reached_minimum: saved.length >= FOCUS_MIN_QUESTIONS,
    error_analysis: serializeAnalysis(analysis),
  });
});

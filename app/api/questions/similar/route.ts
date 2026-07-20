import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { generateQuestions } from '@/lib/ai/generate';
import { recordAiCost, requireDailyCostCap } from '@/lib/ai/cost-cap';
import { requireQuota, consumeQuota } from '@/lib/quota/check';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const bodySchema = z.object({
  source_question_id: z.string().uuid(),
  source_kind: z.enum(['public', 'private']),
});

export const maxDuration = 120;

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const body = bodySchema.parse(await request.json());
  const admin = createAdminClient();

  await requireDailyCostCap();
  await requireQuota(session.userId, 'questions', 3);

  const sourceResult = body.source_kind === 'private'
    ? await admin
        .from('private_questions')
        .select('id, stem, choices, answer_index, explanation, difficulty, sub_topic_id')
        .eq('id', body.source_question_id)
        .eq('user_id', session.userId)
        .maybeSingle()
    : await admin
        .from('questions')
        .select('id, stem, choices, answer_index, explanation, difficulty, sub_topic_id')
        .eq('id', body.source_question_id)
        .maybeSingle();
  const { data: source, error: sourceError } = sourceResult;
  if (sourceError || !source) {
    throw new ApiException('source_question_not_found', '기준 오답 문항을 찾을 수 없습니다.', 404);
  }
  if (!source.sub_topic_id) {
    throw new ApiException('sub_topic_not_found', '세부주제가 없는 문항은 유사 문항을 만들 수 없습니다.', 400);
  }

  const { data: subTopic, error: topicError } = await admin
    .from('sub_topics')
    .select('id, name, exam_relevance, is_risk_category, subject:subjects(id, name)')
    .eq('id', source.sub_topic_id)
    .maybeSingle();
  if (topicError || !subTopic) {
    throw new ApiException('sub_topic_not_found', '세부주제를 찾을 수 없습니다.', 404);
  }
  const subject = Array.isArray(subTopic.subject) ? subTopic.subject[0] : subTopic.subject;
  if (!subject) throw new ApiException('subject_not_found', '과목을 찾을 수 없습니다.', 404);

  // 내신 문제 생성과 같은 빠른 생성 모델(MODELS.generation)을 한 번만 호출한다.
  const generated = await generateQuestions({
    subjectName: subject.name,
    subTopicName: subTopic.name,
    examRelevance: subTopic.exam_relevance as 1 | 2 | 3,
    isRiskCategory: subTopic.is_risk_category,
    difficulty: source.difficulty as 1 | 2 | 3,
    style: 'professor',
    examples: [{
      stem: source.stem,
      choices: source.choices as string[],
      explanation: source.explanation ?? '',
    }],
    count: 3,
  });
  const questions = generated.questions.slice(0, 3);
  if (questions.length !== 3) {
    throw new ApiException('generation_failed', '유사 문항 3개를 생성하지 못했습니다. 다시 시도해주세요.', 502);
  }

  const title = `${subTopic.name} 오답 유사문항 3제`;
  const { data: upload, error: uploadError } = await admin
    .from('user_uploads')
    .insert({
      user_id: session.userId,
      file_name: title,
      file_type: 'generated/similar',
      file_size_bytes: 0,
      storage_path: '',
      status: 'completed',
      processed_at: new Date().toISOString(),
      page_count: 0,
    })
    .select('id')
    .single();
  if (uploadError || !upload) throw new ApiException('set_create_failed', '문제집 생성에 실패했습니다.', 500);

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
  if (saveError || !saved || saved.length !== 3) {
    await admin.from('user_uploads').delete().eq('id', upload.id);
    throw new ApiException('question_save_failed', '생성 문항 저장에 실패했습니다.', 500);
  }

  await consumeQuota(session.userId, 'questions', 3);
  await recordAiCost({
    userId: session.userId,
    endpoint: 'questions.similar-set',
    model: generated.usage.model,
    costUsd: generated.usage.costUSD,
    inputTokens: generated.usage.inputTokens,
    outputTokens: generated.usage.outputTokens,
    metadata: { sourceQuestionId: source.id, uploadId: upload.id, count: 3 },
  });

  return ok({ upload_id: upload.id, question_count: 3 });
});

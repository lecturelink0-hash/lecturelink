import { z } from 'zod';
import { requireAuthUser } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { generateQuestions } from '@/lib/ai/generate';
import type { UsageRecord } from '@/lib/ai/client';
import { recordAiCost, requireDailyCostCap } from '@/lib/ai/cost-cap';
import { requireQuota, consumeQuota } from '@/lib/quota/check';
import { STORAGE_BUCKET } from '@/lib/storage/paths';
import { validateImageUrl } from '@/lib/storage/url-safety';
import type { MedicalImageType } from '@/lib/types/database';
import type { GeneratedQuestion } from '@/lib/types/domain';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const bodySchema = z.object({
  source_question_id: z.string().uuid(),
  source_kind: z.enum(['public', 'private']),
});

export const maxDuration = 120;

type AdminClient = ReturnType<typeof createAdminClient>;

/** private 버킷 이미지를 Vision 입력으로 넘기기 위한 서명 URL 유효기간(초). */
const SIGNED_URL_TTL_SECONDS = 3600;

/** 원본 오답 문항 — 공유 풀(questions)·내 자료(private_questions) 를 한 형태로 맞춘 것. */
interface SourceQuestion {
  id: string;
  stem: string;
  choices: string[];
  explanation: string | null;
  difficulty: 1 | 2 | 3;
  subTopicId: string | null;
  /** 공개 URL 로 바로 볼 수 있는 이미지 (questions.image_url / private_questions.source_image_url). */
  externalImageUrl: string | null;
  externalImageType: MedicalImageType | null;
  /** private 버킷(user_uploads)에 있는 이미지 — 강의록에서 crop 된 것. sort_order 오름차순. */
  storedImages: { storagePath: string; kind: string | null }[];
}

/**
 * 유사문항 1개를 만들 때 실제로 모델에게 보여줄 원본 이미지.
 *
 * external — 공개 URL. 생성 문항에는 private_questions.source_image_url 로 그대로 달아 둔다.
 * stored   — 내 자료 이미지. private 버킷이라 Vision 입력은 서명 URL 이 필요하고,
 *            저장은 새 업로드 폴더로 **복사**해 연결한다. 같은 파일을 두 업로드가 공유하면
 *            한쪽을 지울 때 다른 쪽 이미지까지 사라지므로 경로를 반드시 분리한다.
 */
type SourceImage =
  | { kind: 'external'; visionUrl: string; imageType: MedicalImageType; publicUrl: string }
  | {
      kind: 'stored';
      visionUrl: string;
      imageType: MedicalImageType;
      storagePath: string;
      imageKind: string | null;
    };

/** 원본 오답 문항을 읽어 유사문항 생성에 필요한 형태로 정규화한다. */
async function loadSourceQuestion(
  admin: AdminClient,
  userId: string,
  body: z.infer<typeof bodySchema>,
): Promise<SourceQuestion> {
  if (body.source_kind === 'private') {
    const { data, error } = await admin
      .from('private_questions')
      .select(
        `
        id, stem, choices, answer_index, explanation, difficulty, sub_topic_id, source_image_url,
        images:private_question_images ( storage_path, kind, sort_order )
      `,
      )
      .eq('id', body.source_question_id)
      .eq('user_id', userId)
      .maybeSingle();
    if (error || !data) {
      throw new ApiException('source_question_not_found', '기준 오답 문항을 찾을 수 없습니다.', 404);
    }
    const stored = [...(data.images ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((image) => ({ storagePath: image.storage_path, kind: image.kind }));
    return {
      id: data.id,
      stem: data.stem,
      choices: data.choices as string[],
      explanation: data.explanation,
      difficulty: data.difficulty as 1 | 2 | 3,
      subTopicId: data.sub_topic_id,
      externalImageUrl: data.source_image_url,
      // 내 자료 문항은 이미지 종류를 따로 저장하지 않는다(crop kind 는 storedImages 쪽에 있다).
      externalImageType: null,
      storedImages: stored,
    };
  }

  const { data, error } = await admin
    .from('questions')
    .select('id, stem, choices, answer_index, explanation, difficulty, sub_topic_id, image_url, image_type')
    .eq('id', body.source_question_id)
    .maybeSingle();
  if (error || !data) {
    throw new ApiException('source_question_not_found', '기준 오답 문항을 찾을 수 없습니다.', 404);
  }
  return {
    id: data.id,
    stem: data.stem,
    choices: data.choices as string[],
    explanation: data.explanation,
    difficulty: data.difficulty as 1 | 2 | 3,
    subTopicId: data.sub_topic_id,
    externalImageUrl: data.image_url,
    externalImageType: data.image_type,
    storedImages: [],
  };
}

/**
 * 원본 이미지를 Vision 입력으로 쓸 수 있게 해석한다.
 *
 * 이미지가 없거나 URL 안전 검증·서명에 실패하면 null 을 돌려주고, 호출부는 예전처럼
 * 텍스트 3문항을 만든다. 여기서 요청 전체를 실패시키면 이미지 문항의 유사문제 생성이
 * 통째로 막히므로 조용히 텍스트로 물러난다.
 */
async function resolveSourceImage(
  admin: AdminClient,
  source: SourceQuestion,
): Promise<SourceImage | null> {
  if (source.externalImageUrl) {
    try {
      // 공유 풀 이미지는 Supabase Storage public URL 또는 오픈 라이선스 신뢰 호스트다.
      await validateImageUrl(source.externalImageUrl, { allowOpenImageHosts: true });
      return {
        kind: 'external',
        visionUrl: source.externalImageUrl,
        publicUrl: source.externalImageUrl,
        imageType: source.externalImageType ?? 'other',
      };
    } catch (error) {
      console.warn(
        '[questions/similar] 원본 이미지 URL 검증 실패 — 텍스트 문항으로 생성:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  const stored = source.storedImages[0];
  if (!stored) return null;

  const { data: signed, error } = await admin.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(stored.storagePath, SIGNED_URL_TTL_SECONDS);
  if (error || !signed?.signedUrl) {
    console.warn(
      '[questions/similar] 원본 이미지 서명 URL 생성 실패 — 텍스트 문항으로 생성:',
      error?.message ?? 'no signed url',
    );
    return null;
  }
  return {
    kind: 'stored',
    visionUrl: signed.signedUrl,
    storagePath: stored.storagePath,
    imageKind: stored.kind,
    imageType: isMedicalImageType(stored.kind) ? stored.kind : 'other',
  };
}

const MEDICAL_IMAGE_TYPES: readonly MedicalImageType[] = [
  'xray', 'ct', 'mri', 'ecg', 'pathology', 'microscope', 'ultrasound', 'other',
];

function isMedicalImageType(value: string | null): value is MedicalImageType {
  return value !== null && (MEDICAL_IMAGE_TYPES as readonly string[]).includes(value);
}

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireAuthUser();
  const body = bodySchema.parse(await request.json());
  const admin = createAdminClient();

  await requireDailyCostCap();
  await requireQuota(session.userId, 'questions', 3);

  const source = await loadSourceQuestion(admin, session.userId, body);
  if (!source.subTopicId) {
    throw new ApiException('sub_topic_not_found', '세부주제가 없는 문항은 유사 문항을 만들 수 없습니다.', 400);
  }

  const { data: subTopic, error: topicError } = await admin
    .from('sub_topics')
    .select('id, name, exam_relevance, is_risk_category, subject:subjects(id, name)')
    .eq('id', source.subTopicId)
    .maybeSingle();
  if (topicError || !subTopic) {
    throw new ApiException('sub_topic_not_found', '세부주제를 찾을 수 없습니다.', 404);
  }
  const subject = Array.isArray(subTopic.subject) ? subTopic.subject[0] : subTopic.subject;
  if (!subject) throw new ApiException('subject_not_found', '과목을 찾을 수 없습니다.', 404);

  const baseInput = {
    subjectName: subject.name,
    subTopicName: subTopic.name,
    examRelevance: subTopic.exam_relevance as 1 | 2 | 3,
    isRiskCategory: subTopic.is_risk_category,
    difficulty: source.difficulty,
    style: 'professor' as const,
    examples: [{
      stem: source.stem,
      choices: source.choices,
      explanation: source.explanation ?? '',
    }],
  };

  // 원본이 이미지 문항이면 3문항 중 1문항은 그 이미지를 실제로 보고 만든다.
  // (이미지 없이 만들면 "가슴 X선사진이다" 같은 지칭만 남고 사진이 없어 풀 수 없다 — F11·F23.)
  const sourceImage = await resolveSourceImage(admin, source);

  const usages: { usage: UsageRecord; mode: 'image' | 'text' | 'text-topup' }[] = [];
  let imageQuestion: GeneratedQuestion | null = null;
  const textQuestions: GeneratedQuestion[] = [];

  if (sourceImage) {
    // Vision(1문항)과 텍스트(2문항)를 동시에 호출해 체감 시간을 한 번 호출과 비슷하게 유지.
    const [imageResult, textResult] = await Promise.all([
      generateQuestions({
        ...baseInput,
        count: 1,
        imageContext: { imageUrl: sourceImage.visionUrl, imageType: sourceImage.imageType },
      }).catch((error: unknown) => {
        // Vision 실패로 유사문제 생성 전체를 막지 않는다 — 아래에서 텍스트 1문항으로 채운다.
        console.warn(
          '[questions/similar] 이미지 기반 생성 실패 — 텍스트 문항으로 대체:',
          error instanceof Error ? error.message : error,
        );
        return null;
      }),
      generateQuestions({ ...baseInput, count: 2 }),
    ]);
    if (imageResult) {
      imageQuestion = imageResult.questions[0];
      usages.push({ usage: imageResult.usage, mode: 'image' });
    }
    textQuestions.push(...textResult.questions.slice(0, 2));
    usages.push({ usage: textResult.usage, mode: 'text' });

    // Vision 이 실패했거나 텍스트 호출이 요청보다 적게 준 만큼만 한 번 더 채운다.
    const missing = 3 - (imageQuestion ? 1 : 0) - textQuestions.length;
    if (missing > 0) {
      const topUp = await generateQuestions({ ...baseInput, count: missing });
      textQuestions.push(...topUp.questions.slice(0, missing));
      usages.push({ usage: topUp.usage, mode: 'text-topup' });
    }
  } else {
    // 내신 문제 생성과 같은 빠른 생성 모델(MODELS.generation)을 한 번만 호출한다.
    const generated = await generateQuestions({ ...baseInput, count: 3 });
    textQuestions.push(...generated.questions.slice(0, 3));
    usages.push({ usage: generated.usage, mode: 'text' });
  }

  // 이미지 문항을 1번 슬롯에 둔다 — 원본과 같은 사진을 먼저 만나게.
  const questions = imageQuestion ? [imageQuestion, ...textQuestions] : textQuestions;
  if (questions.length !== 3) {
    throw new ApiException('generation_failed', '유사 문항 3개를 생성하지 못했습니다. 다시 시도해주세요.', 502);
  }

  const title = `오답 유사문항 · ${subTopic.name}`;
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

  // 공개 URL 이미지는 문항 행에 그대로 달아 두면 /api/private-questions 가 그대로 내려준다.
  const externalImageUrl =
    imageQuestion && sourceImage?.kind === 'external' ? sourceImage.publicUrl : null;

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
      source_image_url: index === 0 ? externalImageUrl : null,
    })))
    .select('id, generation_slot');
  if (saveError || !saved || saved.length !== 3) {
    await admin.from('user_uploads').delete().eq('id', upload.id);
    throw new ApiException('question_save_failed', '생성 문항 저장에 실패했습니다.', 500);
  }

  // 내 자료 이미지는 새 업로드 폴더로 복사한 뒤 연결한다. 원본 자료를 지워도 유사문항이,
  // 유사문항 세트를 지워도 원본 자료가 서로 영향을 받지 않는다(업로드 삭제가 storage_path 를 지운다).
  if (imageQuestion && sourceImage?.kind === 'stored') {
    const imageQuestionId = saved.find((row) => row.generation_slot === 1)?.id;
    const fileName = (sourceImage.storagePath.split('/').pop() ?? 'source.png')
      .replace(/[^A-Za-z0-9._-]/g, '_');
    const targetPath = `${session.userId}/${upload.id}/crops/${fileName}`;

    const { error: copyError } = imageQuestionId
      ? await admin.storage.from(STORAGE_BUCKET).copy(sourceImage.storagePath, targetPath)
      : { error: new Error('생성 문항 식별 실패') };

    const { error: linkError } = !copyError && imageQuestionId
      ? await admin.from('private_question_images').insert({
          private_question_id: imageQuestionId,
          user_id: session.userId,
          upload_id: upload.id,
          storage_path: targetPath,
          kind: sourceImage.imageKind,
          caption: null,
          sort_order: 0,
        })
      : { error: null };

    if (copyError || linkError) {
      // 사진을 가리키는 발문만 남으면 풀 수 없는 문항이 된다 — 저장분을 되돌리고 재시도를 요청한다.
      if (!copyError) await admin.storage.from(STORAGE_BUCKET).remove([targetPath]);
      await admin.from('user_uploads').delete().eq('id', upload.id);
      throw new ApiException(
        'question_image_link_failed',
        '원본 이미지를 유사문항에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.',
        500,
      );
    }
  }

  await consumeQuota(session.userId, 'questions', 3);
  for (const { usage, mode } of usages) {
    await recordAiCost({
      userId: session.userId,
      endpoint: 'questions.similar-set',
      model: usage.model,
      costUsd: usage.costUSD,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      metadata: { sourceQuestionId: source.id, uploadId: upload.id, count: 3, mode },
    });
  }

  return ok({ upload_id: upload.id, question_count: 3, image_question_included: !!imageQuestion });
});

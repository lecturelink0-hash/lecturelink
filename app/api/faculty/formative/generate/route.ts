import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getAnthropic, MODELS, createMessage, withRetry } from '@/lib/ai/client';
import { requireDailyCostCap } from '@/lib/ai/cost-cap';
import { parsePptx } from '@/lib/extract/pptx';
import { normalizeToPng } from '@/lib/extract/preprocess';
import { extractPdfTextPages, renderPdfPages } from '@/lib/extract/render-slides';
import { cropRegions, detectMedicalRegions } from '@/lib/extract/crop-medical-images';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MAX_VISION_IMAGES = 4;

type MaterialImage = { page: number | null; png: Uint8Array };
type ExtractedMaterial = {
  text: string;
  images: MaterialImage[];
  allowedPages: number[];
  imageWarnings: string[];
};

function parsePageRange(raw: string, maxPage: number): number[] {
  if (raw === '전체 자료') return Array.from({ length: maxPage }, (_, index) => index + 1);
  const pages = new Set<number>();
  for (const token of raw.split(',').map((item) => item.trim()).filter(Boolean)) {
    const match = token.match(/^(\d+)\s*(?:~|-)\s*(\d+)$/);
    if (match) {
      const start = Math.min(Number(match[1]), Number(match[2]));
      const end = Math.max(Number(match[1]), Number(match[2]));
      for (let page = start; page <= end && page <= maxPage; page += 1) {
        if (page >= 1) pages.add(page);
      }
      continue;
    }
    const page = Number(token);
    if (Number.isInteger(page) && page >= 1 && page <= maxPage) pages.add(page);
  }
  if (pages.size === 0) {
    throw new ApiException('invalid_page_range', '출제할 페이지 범위를 확인해주세요.', 400);
  }
  return [...pages].sort((a, b) => a - b);
}

async function prepareVisionImage(bytes: Uint8Array): Promise<Uint8Array | null> {
  const normalized = await normalizeToPng(bytes);
  if (!normalized) return null;
  try {
    const { createCanvas, loadImage } = await import('canvas');
    const image = await loadImage(Buffer.from(normalized));
    if (image.width < 240 || image.height < 180) return null;
    const scale = Math.min(1, 1024 / Math.max(image.width, image.height));
    const canvas = createCanvas(
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
    );
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return new Uint8Array(canvas.toBuffer('image/png'));
  } catch {
    return null;
  }
}

async function selectVisualPdfPages(
  pdfBuffer: ArrayBuffer,
  userId: string,
  allowedPages: number[],
  pageTexts: Map<number, string>,
  focusText: string,
): Promise<MaterialImage[]> {
  const previews = await renderPdfPages(pdfBuffer, {
    pages: allowedPages,
    maxPages: Math.min(60, allowedPages.length),
    maxEdgePx: 320,
  });
  const { createCanvas, loadImage } = await import('canvas');
  const scored: Array<{ page: number; score: number }> = [];
  const focusTerms = focusText.toLowerCase().split(/\s+/).filter((term) => term.length >= 2);
  for (const preview of previews) {
    try {
      const image = await loadImage(Buffer.from(preview.png));
      const width = 48;
      const height = Math.max(24, Math.round((image.height / image.width) * width));
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      let dark = 0;
      let colored = 0;
      let midtone = 0;
      const total = width * height;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const r = pixels[offset];
        const g = pixels[offset + 1];
        const b = pixels[offset + 2];
        const average = (r + g + b) / 3;
        if (average < 90) dark += 1;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 28 && average < 245) colored += 1;
        if (average >= 90 && average < 220) midtone += 1;
      }
      const relevance = focusTerms.filter((term) =>
        (pageTexts.get(preview.pageIndex) ?? '').toLowerCase().includes(term),
      ).length;
      const score =
        dark / total +
        (colored / total) * 1.5 +
        midtone / total +
        Math.min(0.4, relevance * 0.12);
      if (score > 0.08) scored.push({ page: preview.pageIndex, score });
    } catch {
      // 개별 페이지 판별 실패는 전체 이미지 생성을 막지 않는다.
    }
  }
  const pages = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_VISION_IMAGES)
    .map((item) => item.page);
  if (pages.length === 0) return [];
  const rendered = await renderPdfPages(pdfBuffer, {
    pages,
    maxPages: MAX_VISION_IMAGES,
    maxEdgePx: 1024,
  });
  const crops: MaterialImage[] = [];
  for (const page of rendered) {
    if (crops.length >= MAX_VISION_IMAGES) break;
    try {
      const detection = await detectMedicalRegions({
        slidePng: page.png,
        userIdForLog: userId,
      });
      const regions = detection.regions.filter(
        (region) =>
          region.kind !== 'text_slide' &&
          region.kind !== 'other' &&
          region.confidence >= 0.7,
      );
      const cropped = await cropRegions(page.png, regions);
      for (const image of cropped) {
        if (crops.length >= MAX_VISION_IMAGES) break;
        crops.push({ page: page.pageIndex, png: image.png });
      }
    } catch {
      // 영역 검출 실패 시 페이지 전체를 문항 이미지로 노출하지 않고 제외한다.
    }
  }
  return crops;
}

const settingsSchema = z.object({
  range: z.string().max(120).default('전체 자료'),
  objective: z.string().max(300).default(''),
  count: z.coerce.number().int().min(1).max(10),
  difficulty: z.enum(['하', '중', '상']),
  excluded: z.string().max(300).default(''),
  additionalPrompt: z.string().max(500).default(''),
  useImages: z.enum(['true', 'false']).transform((value) => value === 'true').default('false'),
});

const generatedQuestionSchema = z.object({
  stem: z.string().min(1),
  choices: z.array(z.string().min(1)).length(5),
  answerIndex: z.number().int().min(0).max(4),
  explanation: z.string().min(1),
  objective: z.string().min(1),
  sourcePages: z.array(z.number().int().min(1)).min(1).max(4),
  cognitiveLevel: z.enum(['회상', '이해', '적용']),
  qualityFlags: z.array(z.string()).max(3),
  imageIndex: z.number().int().min(0).max(MAX_VISION_IMAGES - 1).nullable().default(null),
});

const generatedAssessmentSchema = z.object({
  title: z.string().min(1),
  materialSummary: z.string().min(1),
  objectives: z.array(z.string().min(1)).min(1).max(5),
  questions: z.array(generatedQuestionSchema).min(1).max(10),
});

function createOutputSchema(count: number) {
  return {
  name: 'create_formative_assessment',
  description: 'Create a grounded formative assessment draft from lecture material.',
  input_schema: {
    type: 'object',
    required: ['title', 'materialSummary', 'objectives', 'questions'],
    properties: {
      title: { type: 'string' },
      materialSummary: { type: 'string' },
      objectives: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5 },
      questions: {
        type: 'array',
        minItems: count,
        maxItems: count,
        items: {
          type: 'object',
          required: ['stem', 'choices', 'answerIndex', 'explanation', 'objective', 'sourcePages', 'cognitiveLevel', 'qualityFlags', 'imageIndex'],
          properties: {
            stem: { type: 'string' },
            choices: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 5 },
            answerIndex: { type: 'integer', minimum: 0, maximum: 4 },
            explanation: { type: 'string' },
            objective: { type: 'string' },
            sourcePages: { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 4 },
            cognitiveLevel: { type: 'string', enum: ['회상', '이해', '적용'] },
            qualityFlags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
            imageIndex: {
              anyOf: [
                { type: 'integer', minimum: 0, maximum: MAX_VISION_IMAGES - 1 },
                { type: 'null' },
              ],
              description: '풀이에 이미지가 꼭 필요한 경우에만 제공된 이미지의 0부터 시작하는 번호를 지정한다.',
            },
          },
        },
      },
    },
  },
  } as const;
}

const verifiedAssessmentSchema = generatedAssessmentSchema.extend({
  reviewSummary: z.string().min(1),
});

function createVerificationTool(count: number) {
  return {
    ...createOutputSchema(count),
    name: 'verify_formative_assessment',
    description: 'Independently verify and correct a formative assessment.',
    input_schema: {
      ...createOutputSchema(count).input_schema,
      required: ['title', 'materialSummary', 'objectives', 'questions', 'reviewSummary'],
      properties: {
        ...createOutputSchema(count).input_schema.properties,
        reviewSummary: { type: 'string' },
      },
    },
  } as const;
}

async function extractMaterial(
  file: File,
  useImages: boolean,
  userId: string,
  requestedRange: string,
  focusText: string,
): Promise<ExtractedMaterial> {
  const buffer = await file.arrayBuffer();
  if (file.type === PPTX || file.name.toLowerCase().endsWith('.pptx')) {
    const parsed = parsePptx(buffer);
    const allowedPages = parsePageRange(requestedRange, parsed.slides.length);
    const allowedSet = new Set(allowedPages);
    const selectedSlides = parsed.slides.filter((slide) => allowedSet.has(slide.index));
    const content = selectedSlides.map((slide) => `[슬라이드 ${slide.index}] ${slide.text}`).filter((line) => line.trim()).join('\n');
    if (!content) throw new ApiException('empty_material', 'PPT에서 읽을 수 있는 텍스트를 찾지 못했습니다.', 400);
    const images: MaterialImage[] = [];
    if (useImages) {
      const terms = focusText.toLowerCase().split(/\s+/).filter((term) => term.length >= 2);
      const rankedSlides = [...selectedSlides].sort((a, b) => {
        const score = (text: string) => terms.filter((term) => text.toLowerCase().includes(term)).length;
        return score(b.text) - score(a.text);
      });
      for (const slide of rankedSlides) {
        for (const ref of slide.imageRefs) {
          if (images.length >= MAX_VISION_IMAGES) break;
          const bytes = parsed.media.get(ref);
          if (!bytes) continue;
          const png = await prepareVisionImage(bytes);
          if (png) images.push({ page: slide.index, png });
        }
        if (images.length >= MAX_VISION_IMAGES) break;
      }
    }
    return {
      text: content.slice(0, 120_000),
      images,
      allowedPages,
      imageWarnings: useImages && images.length === 0 ? ['선택 범위에서 사용 가능한 이미지를 찾지 못했습니다.'] : [],
    };
  }
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    const extractedPages = await extractPdfTextPages(buffer);
    const allowedPages = parsePageRange(requestedRange, extractedPages.length);
    const allowedSet = new Set(allowedPages);
    const pages = extractedPages
      .filter((page) => allowedSet.has(page.pageIndex))
      .map((page) => `[페이지 ${page.pageIndex}] ${page.text}`)
      .join('\n');
    if (!pages.trim()) throw new ApiException('empty_material', '선택 범위의 PDF에서 읽을 수 있는 텍스트를 찾지 못했습니다.', 400);
    const images = useImages
      ? await selectVisualPdfPages(
          buffer,
          userId,
          allowedPages,
          new Map(extractedPages.map((page) => [page.pageIndex, page.text])),
          focusText,
        )
      : [];
    return {
      text: pages.slice(0, 120_000),
      images,
      allowedPages,
      imageWarnings: useImages && images.length === 0 ? ['선택 범위에서 크롭 가능한 의료 이미지를 찾지 못했습니다.'] : [],
    };
  }
  throw new ApiException('unsupported_file', 'PPTX 또는 PDF 파일만 지원합니다.', 400);
}

export const maxDuration = 300;

const GENERATION_SYSTEM = `당신은 의과대학 수업 직후 학습 확인용 형성평가를 설계하는 전문 의학교육자다.
제공된 강의자료와 지정된 페이지 범위만 정답 근거로 사용한다. 외부 의학지식으로 빈칸을 추정하지 않는다.

문항 제작 원칙:
1. 정확히 요청된 수의 5지선다 단일최선정답(SBA) 문항을 만든다.
2. "모두 고르시오", 가/나/다 조합형, 복수선택형, OX형, 정답 없음/모두 정답 선택지는 금지한다.
3. 부정형("옳지 않은 것")은 꼭 필요한 경우가 아니면 피하고, 사용할 때는 부정어를 명확히 드러낸다.
4. 한 문항은 하나의 명확한 학습목표만 평가한다. 사소한 숫자·용량 암기보다 핵심 개념과 흔한 오개념 교정을 우선한다.
5. 선택지 5개는 같은 의미 범주와 비슷한 길이·문법 구조를 유지한다. 정답만 유난히 길거나 구체적이어서는 안 된다.
6. 오답은 자료에서 유추 가능한 흔한 혼동·오개념을 반영하되 명백한 농담, 중복, 부분 정답을 만들지 않는다.
7. 정답 위치는 전체 문항에서 고르게 분산하고 연속 반복을 피한다.
8. 해설에는 정답 근거와 핵심 오답이 틀린 이유를 간결하게 포함한다.
9. sourcePages에는 실제 근거가 있는 허용 페이지/슬라이드 번호만 기록한다.

난이도 기준:
- 하: 핵심 사실의 회상 또는 한 단계 이해. 불필요한 함정 금지.
- 중: 개념 비교, 기전 이해, 전형적 상황에 한 단계 적용.
- 상: 자료 안의 여러 단서를 통합하는 적용. 자료 밖 전문지식이나 애매한 예외로 어렵게 만들지 않는다.

이미지 원칙:
- imageIndex는 이미지를 직접 관찰해야 정답을 고를 수 있을 때만 지정한다.
- 이미지 없이도 지문만으로 답이 드러나면 imageIndex=null로 둔다.
- 이미지의 진단명·정답을 지문에서 그대로 말하지 않는다.
- 이미지 소견, 정답, 해설, 근거 페이지가 서로 일치해야 한다.
- 로고·장식·텍스트 캡처는 사용하지 않는다.

qualityFlags는 출판 전 교수 확인이 필요한 잔여 위험만 기록한다. 문제가 보이면 가능하면 먼저 문항을 수정하고, 수정해도 남는 위험만 표시한다.`;

const VERIFICATION_SYSTEM = `당신은 초안을 만든 사람과 독립된 의학교육 문항 편집자다.
강의자료와 허용 페이지를 근거로 초안을 한 문항씩 검증하고 필요한 경우 직접 수정한 최종본을 반환한다.

반드시 확인할 항목:
- 요청 수와 5개 선택지, 단일최선정답 형식
- 복수정답, 부분 정답, 모호한 한정어, 문법·길이 정답 단서
- 모두 고르시오/가나다 조합형/정답 없음/모두 정답 금지
- 자료 범위 밖 주장, 잘못된 sourcePages, 학습목표 불일치
- 난이도 기준과 인지수준의 적절성 및 문항 간 내용 중복
- 정답 위치의 과도한 편중
- 해설의 정답 근거와 핵심 오답 교정
- 이미지가 실제 풀이에 필수인지, 이미지 소견·정답·해설·페이지가 일치하는지

오류가 있으면 단순 경고에 그치지 말고 자료 안에서 수정한다. 자료로 확정할 수 없으면 해당 문항을 다른 근거 명확한 문항으로 교체한다.
reviewSummary에는 실제로 수행한 핵심 수정·검증 내용을 짧게 기록한다.`;

function assertAssessmentIntegrity(
  result: z.infer<typeof generatedAssessmentSchema>,
  count: number,
  allowedPages: number[],
  imageCount: number,
) {
  if (result.questions.length !== count) {
    throw new ApiException('generation_count_mismatch', '요청한 문항 수를 충족하지 못했습니다. 다시 생성해주세요.', 502);
  }
  const allowed = new Set(allowedPages);
  const answerPositionCounts = Array.from({ length: 5 }, () => 0);
  for (const question of result.questions) {
    const normalizedChoices = question.choices.map((choice) => choice.trim().toLowerCase());
    if (new Set(normalizedChoices).size !== 5) {
      throw new ApiException('duplicate_choices', '중복 선택지가 발견되어 문항 생성을 중단했습니다.', 502);
    }
    if (/모두\s*고르|옳은\s*것을\s*모두|^[가나다]\./m.test(question.stem)) {
      throw new ApiException('invalid_item_format', '복수선택 또는 조합형 문항이 발견되어 생성을 중단했습니다.', 502);
    }
    if (question.choices.some((choice) => /(?:^|\s)[가나다](?:\s*,\s*[가나다])+(?:\s|$)/u.test(choice))) {
      throw new ApiException('invalid_item_format', '조합형 선택지가 발견되어 생성을 중단했습니다.', 502);
    }
    if (question.sourcePages.length === 0) {
      throw new ApiException('missing_source_page', '근거 페이지가 없는 문항이 발견되어 생성을 중단했습니다.', 502);
    }
    if (question.sourcePages.some((page) => !allowed.has(page))) {
      throw new ApiException('source_out_of_range', '선택 범위를 벗어난 근거가 발견되어 생성을 중단했습니다.', 502);
    }
    if (question.imageIndex !== null && question.imageIndex >= imageCount) {
      throw new ApiException('invalid_image_reference', '문항의 이미지 연결을 확인하지 못했습니다.', 502);
    }
    answerPositionCounts[question.answerIndex] += 1;
  }
  if (count >= 5 && Math.max(...answerPositionCounts) > Math.ceil(count * 0.4)) {
    throw new ApiException('unbalanced_answers', '정답 위치가 한 번호에 지나치게 편중되어 생성을 중단했습니다.', 502);
  }
}

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  if (session.profile.accountType !== 'professor' && session.role !== 'admin') {
    throw new ApiException('professor_only', '교수 계정에서만 형성평가를 생성할 수 있습니다.', 403);
  }
  await requireDailyCostCap();
  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) throw new ApiException('file_required', '강의자료를 선택해주세요.', 400);
  if (file.size > MAX_FILE_BYTES) throw new ApiException('file_too_large', '파일은 25MB 이하만 업로드할 수 있습니다.', 400);

  const settings = settingsSchema.parse({
    range: form.get('range'), objective: form.get('objective'), count: form.get('count'),
    difficulty: form.get('difficulty'), excluded: form.get('excluded'),
    additionalPrompt: form.get('additionalPrompt'), useImages: form.get('useImages'),
  });
  const material = await extractMaterial(
    file,
    settings.useImages,
    session.userId,
    settings.range,
    `${settings.objective} ${settings.additionalPrompt}`,
  );
  const client = getAnthropic();
  const userText = `파일명: ${file.name}
허용된 근거 페이지/슬라이드: ${material.allowedPages.join(', ')}
꼭 포함할 내용: ${settings.objective || '자료의 핵심 학습목표에서 균형 있게 선정'}
문항 수: 정확히 ${settings.count}문항
난이도: ${settings.difficulty}
제외 내용: ${settings.excluded || '없음'}
추가 요청: ${settings.additionalPrompt || '없음'}
이미지 사용: ${settings.useImages ? `사용(후보 ${material.images.length}개)` : '사용 안 함'}
이미지 처리 참고: ${material.imageWarnings.join(' ') || '이상 없음'}

강의자료:
${material.text}`;
  const messageContent: Anthropic.MessageCreateParams['messages'][number]['content'] = [
    { type: 'text', text: userText },
    ...material.images.flatMap((image, index) => [
      { type: 'text' as const, text: `이미지 ${index}${image.page ? ` (근거 페이지/슬라이드 ${image.page})` : ''}` },
      {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: 'image/png' as const,
          data: Buffer.from(image.png).toString('base64'),
        },
      },
    ]),
  ];
  const response = await withRetry(() => createMessage(client, {
    model: MODELS.generation(),
    max_tokens: 7000,
    system: GENERATION_SYSTEM,
    tools: [createOutputSchema(settings.count)],
    tool_choice: { type: 'tool', name: 'create_formative_assessment' },
    messages: [{ role: 'user', content: messageContent }],
  }), { maxAttempts: 3 });

  const block = response.content.find((item): item is Anthropic.ToolUseBlock => item.type === 'tool_use');
  if (!block) throw new ApiException('generation_failed', '구조화된 문항 초안을 만들지 못했습니다.', 502);
  const draft = generatedAssessmentSchema.parse(block.input);
  if (draft.questions.length !== settings.count) {
    throw new ApiException('generation_count_mismatch', '요청한 문항 수를 만들지 못했습니다.', 502);
  }

  const verificationContent: Anthropic.MessageCreateParams['messages'][number]['content'] = [
    {
      type: 'text',
      text: `허용 페이지/슬라이드: ${material.allowedPages.join(', ')}
요청 난이도: ${settings.difficulty}
요청 문항 수: ${settings.count}
교수 요청: ${settings.objective || '없음'}
제외 내용: ${settings.excluded || '없음'}

강의자료:
${material.text}

검증하고 수정할 초안:
${JSON.stringify(draft)}`,
    },
    ...material.images.flatMap((image, index) => [
      { type: 'text' as const, text: `이미지 ${index}${image.page ? ` (근거 페이지/슬라이드 ${image.page})` : ''}` },
      {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: 'image/png' as const,
          data: Buffer.from(image.png).toString('base64'),
        },
      },
    ]),
  ];
  const verification = await withRetry(() => createMessage(client, {
    model: MODELS.generation(),
    max_tokens: 7000,
    system: VERIFICATION_SYSTEM,
    tools: [createVerificationTool(settings.count)],
    tool_choice: { type: 'tool', name: 'verify_formative_assessment' },
    messages: [{ role: 'user', content: verificationContent }],
  }), { maxAttempts: 3 });
  const verificationBlock = verification.content.find(
    (item): item is Anthropic.ToolUseBlock => item.type === 'tool_use',
  );
  if (!verificationBlock) {
    throw new ApiException('verification_failed', '생성 문항의 독립 검증을 완료하지 못했습니다.', 502);
  }
  const verified = verifiedAssessmentSchema.parse(verificationBlock.input);
  assertAssessmentIntegrity(verified, settings.count, material.allowedPages, material.images.length);
  return ok({
    ...verified,
    imageAnalysis: {
      requested: settings.useImages,
      candidateCount: material.images.length,
      warnings: material.imageWarnings,
    },
    questions: verified.questions.map((question, index) => {
      const selectedImage = question.imageIndex === null ? null : material.images[question.imageIndex];
      return {
        ...question,
        id: `draft-${index + 1}`,
        imageDataUrl: selectedImage
          ? `data:image/png;base64,${Buffer.from(selectedImage.png).toString('base64')}`
          : null,
      };
    }),
  });
});

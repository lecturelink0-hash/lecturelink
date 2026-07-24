import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getAnthropic, MODELS, createMessage, withRetry } from '@/lib/ai/client';
import { requireDailyCostCap } from '@/lib/ai/cost-cap';
import { parsePptx } from '@/lib/extract/pptx';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';
import { createServerClient } from '@/lib/db/server';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const settingsSchema = z.object({
  purpose: z.string().trim().min(1).max(100).default('의과대학 정규 강의'),
  mustKeep: z.string().trim().max(500).default(''),
  lockedPages: z.string().trim().max(200).default(''),
  additionalPrompt: z.string().trim().max(800).default(''),
});

const reviewSchema = z.object({
  deckTitle: z.string(),
  summary: z.string(),
  overallScore: z.number().int().min(0).max(100),
  strengths: z.array(z.string()).max(5),
  priorityActions: z.array(z.string()).max(5),
  slides: z.array(z.object({
    slide: z.number().int().min(1),
    title: z.string(),
    density: z.enum(['낮음', '적정', '높음']),
    issues: z.array(z.string()).max(4),
    recommendation: z.string(),
    safeActions: z.array(z.string()).max(4),
  })).max(80),
});

const tool = {
  name: 'review_lecture_slides',
  description: 'Return a grounded readability review.',
  input_schema: {
    type: 'object',
    required: ['deckTitle', 'summary', 'overallScore', 'strengths', 'priorityActions', 'slides'],
    properties: {
      deckTitle: { type: 'string' },
      summary: { type: 'string' },
      overallScore: { type: 'integer', minimum: 0, maximum: 100 },
      strengths: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      priorityActions: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      slides: {
        type: 'array',
        maxItems: 80,
        items: {
          type: 'object',
          required: ['slide', 'title', 'density', 'issues', 'recommendation', 'safeActions'],
          properties: {
            slide: { type: 'integer', minimum: 1 },
            title: { type: 'string' },
            density: { type: 'string', enum: ['낮음', '적정', '높음'] },
            issues: { type: 'array', items: { type: 'string' }, maxItems: 4 },
            recommendation: { type: 'string' },
            safeActions: { type: 'array', items: { type: 'string' }, maxItems: 4 },
          },
        },
      },
    },
  },
} as const;

async function extractPages(file: File) {
  const buffer = await file.arrayBuffer();
  const name = file.name.toLowerCase();

  if (file.type === PPTX_MIME || name.endsWith('.pptx')) {
    const parsed = parsePptx(buffer);
    const content = parsed.slides
      .map((slide) => `[슬라이드 ${slide.index}] 글자수=${slide.text.length} 이미지수=${slide.imageRefs.length}\n${slide.text}`)
      .join('\n');
    if (!content.trim()) {
      throw new ApiException('empty_material', 'PPTX에서 읽을 수 있는 텍스트를 찾지 못했습니다.', 400);
    }
    return { content: content.slice(0, 120_000), unit: '슬라이드', format: 'PPTX' };
  }

  if (file.type === 'application/pdf' || name.endsWith('.pdf')) {
    const { default: pdfParse } = await import('pdf-parse');
    let pageNumber = 0;
    const parsed = await pdfParse(Buffer.from(buffer), {
      pagerender: async (pageData: {
        getTextContent: () => Promise<{ items: Array<{ str?: string }> }>;
      }) => {
        pageNumber += 1;
        const textContent = await pageData.getTextContent();
        const text = textContent.items.map((item) => item.str ?? '').join(' ').replace(/\s+/g, ' ').trim();
        return `[페이지 ${pageNumber}] 글자수=${text.length}\n${text}\n`;
      },
    });
    if (!parsed.text.trim()) {
      throw new ApiException(
        'empty_material',
        'PDF에서 읽을 수 있는 텍스트를 찾지 못했습니다. 이미지로만 된 PDF는 현재 분석할 수 없습니다.',
        400,
      );
    }
    return { content: parsed.text.slice(0, 120_000), unit: '페이지', format: 'PDF' };
  }

  throw new ApiException('unsupported_file', 'PPTX 또는 PDF 파일만 지원합니다.', 400);
}

export const maxDuration = 120;

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  if (session.profile.accountType !== 'professor' && session.role !== 'admin') {
    throw new ApiException('professor_only', '교수 계정에서만 사용할 수 있습니다.', 403);
  }

  await requireDailyCostCap();
  const form = await request.formData();
  const file = form.get('file');
  const courseId = String(form.get('courseId') ?? '');
  const settings = settingsSchema.parse({
    purpose: form.get('purpose') || '의과대학 정규 강의',
    mustKeep: form.get('mustKeep') || '',
    lockedPages: form.get('lockedPages') || '',
    additionalPrompt: form.get('additionalPrompt') || '',
  });

  if (!(file instanceof File)) {
    throw new ApiException('file_required', 'PPTX 또는 PDF 파일을 선택해주세요.', 400);
  }
  if (!z.string().uuid().safeParse(courseId).success) {
    throw new ApiException('course_required', '저장할 차시를 선택해주세요.', 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new ApiException('file_too_large', '파일은 25MB 이하만 지원합니다.', 400);
  }

  const material = await extractPages(file);
  const response = await withRetry(() => createMessage(getAnthropic(), {
    model: MODELS.generation(),
    max_tokens: 7000,
    system: `당신은 의과대학 강의자료의 가독성과 교육 흐름을 검토하는 조교다. 의학 내용의 정확성을 새로 판정하거나 내용을 임의로 추가하지 않는다. 제공된 ${material.unit}별 텍스트 구조만 근거로 정보 과밀, 제목 위계, 반복, 분할 필요성을 진단한다. 잘 된 부분을 억지로 지적하지 않는다. PDF는 편집 가능한 원본 개체 정보가 없으므로 텍스트 배치와 교육 흐름 중심으로만 제안한다. 모든 답변은 한국어로 작성한다.`,
    tools: [tool],
    tool_choice: { type: 'tool', name: 'review_lecture_slides' },
    messages: [{
      role: 'user',
      content: `파일명: ${file.name}
파일 형식: ${material.format}
분석 단위: ${material.unit}
자료 사용 목적: ${settings.purpose}
항상 점검할 기준: 가독성, 핵심 강조, 적절한 분량, 수업 흐름, 내용 중복, 제목 위계
반드시 유지할 내용: ${settings.mustKeep || '별도 요청 없음'}
수정하지 않을 페이지: ${settings.lockedPages || '별도 요청 없음'}
추가 요청: ${settings.additionalPrompt || '별도 요청 없음'}

${material.content}`,
    }],
  }), { maxAttempts: 3 });

  const block = response.content.find((item): item is Anthropic.ToolUseBlock => item.type === 'tool_use');
  if (!block) throw new ApiException('analysis_failed', '구조화된 진단을 만들지 못했습니다.', 502);
  const result = reviewSchema.parse(block.input);

  const db = await createServerClient() as any;
  const { data: course } = await db.from('courses').select('id').eq('id', courseId).eq('professor_id', session.userId).maybeSingle();
  if (!course) throw new ApiException('course_not_found', '선택한 차시를 찾을 수 없습니다.', 404);

  const { data: artifact, error } = await db.from('learning_artifacts').insert({
    course_id: courseId,
    created_by: session.userId,
    type: 'material_review',
    title: result.deckTitle,
    status: 'review',
    source_name: file.name,
    summary: result.summary,
    content: { ...result, sourceFormat: material.format, sourceUnit: material.unit },
  }).select('id').single();

  if (error) throw new ApiException('artifact_save_failed', '자료 개선 결과를 차시에 저장하지 못했습니다.', 500);
  return ok({ ...result, artifactId: artifact.id, sourceFormat: material.format });
});

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getAnthropic, MODELS, createMessage, withRetry } from '@/lib/ai/client';
import { requireDailyCostCap } from '@/lib/ai/cost-cap';
import { parsePptx } from '@/lib/extract/pptx';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';

const MAX_FILE_BYTES = 25 * 1024 * 1024;

const requestSchema = z.object({
  courseTopic: z.string().trim().min(2).max(160),
  learnerLevel: z.enum(['의예과 2학년', '의학과 1학년', '의학과 2학년', '의학과 3학년', '의학과 4학년']),
  reviewLength: z.enum(['5분', '10분', '15분']),
  emphasis: z.string().trim().max(300).default(''),
});

const resultSchema = z.object({
  title: z.string().min(1),
  courseConnection: z.string().min(1),
  estimatedMinutes: z.number().int().min(3).max(20),
  prerequisiteConcepts: z.array(z.object({
    name: z.string().min(1),
    whyNeeded: z.string().min(1),
    quickReview: z.string().min(1),
    sourcePages: z.array(z.number().int().min(1)).max(4),
  })).min(2).max(5),
  coreFlow: z.array(z.string().min(1)).min(2).max(6),
  commonConfusions: z.array(z.object({
    confusion: z.string().min(1),
    correction: z.string().min(1),
  })).max(4),
  readinessCheck: z.array(z.object({
    question: z.string().min(1),
    answer: z.string().min(1),
  })).min(2).max(5),
});

const outputTool = {
  name: 'create_prerequisite_bridge',
  description: 'Create a concise pre-class prerequisite review handout grounded in lecture material.',
  input_schema: {
    type: 'object',
    required: ['title', 'courseConnection', 'estimatedMinutes', 'prerequisiteConcepts', 'coreFlow', 'commonConfusions', 'readinessCheck'],
    properties: {
      title: { type: 'string' },
      courseConnection: { type: 'string' },
      estimatedMinutes: { type: 'integer', minimum: 3, maximum: 20 },
      prerequisiteConcepts: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'object', required: ['name', 'whyNeeded', 'quickReview', 'sourcePages'], properties: { name: { type: 'string' }, whyNeeded: { type: 'string' }, quickReview: { type: 'string' }, sourcePages: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 4 } } } },
      coreFlow: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } },
      commonConfusions: { type: 'array', maxItems: 4, items: { type: 'object', required: ['confusion', 'correction'], properties: { confusion: { type: 'string' }, correction: { type: 'string' } } } },
      readinessCheck: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'object', required: ['question', 'answer'], properties: { question: { type: 'string' }, answer: { type: 'string' } } } },
    },
  },
} as const;

async function extractMaterial(file: File) {
  const buffer = await file.arrayBuffer();
  if (file.name.toLowerCase().endsWith('.pptx')) {
    const parsed = parsePptx(buffer);
    const text = parsed.slides.map((slide) => `[슬라이드 ${slide.index}] ${slide.text}`).join('\n');
    if (!text.trim()) throw new ApiException('empty_material', 'PPT에서 읽을 수 있는 텍스트를 찾지 못했습니다.', 400);
    return text.slice(0, 120_000);
  }
  if (file.name.toLowerCase().endsWith('.pdf')) {
    const { default: pdfParse } = await import('pdf-parse');
    const parsed = await pdfParse(Buffer.from(buffer));
    const text = parsed.text.split(/\f+/).map((page, index) => `[페이지 ${index + 1}] ${page.trim()}`).join('\n');
    if (!text.trim()) throw new ApiException('empty_material', 'PDF에서 읽을 수 있는 텍스트를 찾지 못했습니다.', 400);
    return text.slice(0, 120_000);
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
  if (!(file instanceof File)) throw new ApiException('file_required', '강의자료를 선택해주세요.', 400);
  if (file.size > MAX_FILE_BYTES) throw new ApiException('file_too_large', '파일은 25MB 이하만 업로드할 수 있습니다.', 400);
  const settings = requestSchema.parse({
    courseTopic: form.get('courseTopic'),
    learnerLevel: form.get('learnerLevel'),
    reviewLength: form.get('reviewLength'),
    emphasis: form.get('emphasis'),
  });
  const material = await extractMaterial(file);
  const response = await withRetry(() => createMessage(getAnthropic(), {
    model: MODELS.generation(),
    max_tokens: 6000,
    system: `당신은 의과대학 수업의 선수지식 복습자료를 설계하는 교육 조교다. 제공된 강의자료에서 이번 수업을 이해하는 데 실제로 필요한 기초의학 개념만 선별한다. 학생이 이미 배웠지만 잊었을 가능성이 높은 내용을 짧게 회복시키는 것이 목적이다. 새로운 강의를 만들거나 불필요한 범위를 넓히지 않는다. 모든 의학적 설명은 자료에 근거하고, 근거 슬라이드 또는 페이지를 표시한다. 결과는 수업 전 1페이지 복습자료로 읽을 수 있는 간결한 한국어로 작성한다.`,
    tools: [outputTool],
    tool_choice: { type: 'tool', name: 'create_prerequisite_bridge' },
    messages: [{ role: 'user', content: `이번 수업 주제: ${settings.courseTopic}\n학습자: ${settings.learnerLevel}\n목표 복습시간: ${settings.reviewLength}\n교수 강조사항: ${settings.emphasis || '없음'}\n파일명: ${file.name}\n\n강의자료:\n${material}` }],
  }), { maxAttempts: 3 });
  const block = response.content.find((item): item is Anthropic.ToolUseBlock => item.type === 'tool_use');
  if (!block) throw new ApiException('generation_failed', '선수지식 복습자료 초안을 만들지 못했습니다.', 502);
  return ok(resultSchema.parse(block.input));
});

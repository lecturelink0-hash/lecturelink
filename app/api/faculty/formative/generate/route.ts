import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getAnthropic, MODELS, createMessage, withRetry } from '@/lib/ai/client';
import { requireDailyCostCap } from '@/lib/ai/cost-cap';
import { parsePptx } from '@/lib/extract/pptx';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const settingsSchema = z.object({
  range: z.string().max(120).default('전체 자료'),
  objective: z.string().max(300).default(''),
  count: z.coerce.number().int().min(3).max(10),
  difficulty: z.enum(['하', '중', '상']),
  mix: z.enum(['핵심 회상 중심', '기전 이해 중심', '임상 적용 중심', '균형 있게']),
  excluded: z.string().max(300).default(''),
});

const generatedQuestionSchema = z.object({
  stem: z.string().min(1),
  choices: z.array(z.string().min(1)).length(5),
  answerIndex: z.number().int().min(0).max(4),
  explanation: z.string().min(1),
  objective: z.string().min(1),
  sourcePages: z.array(z.number().int().min(1)).max(4),
  cognitiveLevel: z.enum(['회상', '이해', '적용']),
  qualityFlags: z.array(z.string()).max(3),
});

const generatedAssessmentSchema = z.object({
  title: z.string().min(1),
  materialSummary: z.string().min(1),
  objectives: z.array(z.string().min(1)).min(1).max(5),
  questions: z.array(generatedQuestionSchema).min(1).max(10),
});

const outputSchema = {
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
        minItems: 3,
        maxItems: 10,
        items: {
          type: 'object',
          required: ['stem', 'choices', 'answerIndex', 'explanation', 'objective', 'sourcePages', 'cognitiveLevel', 'qualityFlags'],
          properties: {
            stem: { type: 'string' },
            choices: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 5 },
            answerIndex: { type: 'integer', minimum: 0, maximum: 4 },
            explanation: { type: 'string' },
            objective: { type: 'string' },
            sourcePages: { type: 'array', items: { type: 'integer', minimum: 1 }, maxItems: 4 },
            cognitiveLevel: { type: 'string', enum: ['회상', '이해', '적용'] },
            qualityFlags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          },
        },
      },
    },
  },
} as const;

async function extractMaterial(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  if (file.type === PPTX || file.name.toLowerCase().endsWith('.pptx')) {
    const parsed = parsePptx(buffer);
    const content = parsed.slides.map((slide) => `[슬라이드 ${slide.index}] ${slide.text}`).filter((line) => line.trim()).join('\n');
    if (!content) throw new ApiException('empty_material', 'PPT에서 읽을 수 있는 텍스트를 찾지 못했습니다.', 400);
    return content.slice(0, 120_000);
  }
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    const { default: pdfParse } = await import('pdf-parse');
    const parsed = await pdfParse(Buffer.from(buffer));
    const pages = parsed.text.split(/\f+/).map((text, index) => `[페이지 ${index + 1}] ${text.trim()}`).join('\n');
    if (!pages.trim()) throw new ApiException('empty_material', 'PDF에서 읽을 수 있는 텍스트를 찾지 못했습니다.', 400);
    return pages.slice(0, 120_000);
  }
  throw new ApiException('unsupported_file', 'PPTX 또는 PDF 파일만 지원합니다.', 400);
}

export const maxDuration = 120;

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
    difficulty: form.get('difficulty'), mix: form.get('mix'), excluded: form.get('excluded'),
  });
  const material = await extractMaterial(file);
  const client = getAnthropic();
  const response = await withRetry(() => createMessage(client, {
    model: MODELS.generation(),
    max_tokens: 7000,
    system: `당신은 의과대학 교수의 형성평가 제작을 돕는 교육설계 조교다. 반드시 제공된 강의자료만을 정답 근거로 사용한다. 고부담 시험문제가 아니라 수업 전후 복습용 5지선다 단일정답 문항을 만든다. 자료에서 확정할 수 없는 내용은 만들지 않는다. 모호성, 복수정답 가능성, 정답 단서가 남으면 qualityFlags에 짧게 알린다. 문항마다 근거 페이지/슬라이드와 학습목표를 남긴다. 학생에게 제공 가능한 정확하고 교육적인 한국어를 쓴다.`,
    tools: [outputSchema],
    tool_choice: { type: 'tool', name: 'create_formative_assessment' },
    messages: [{ role: 'user', content: `파일명: ${file.name}\n출제 범위: ${settings.range}\n교수 지정 학습목표: ${settings.objective || '자료에서 추출'}\n문항 수: ${settings.count}\n난이도: ${settings.difficulty}\n인지 수준: ${settings.mix}\n제외 내용: ${settings.excluded || '없음'}\n\n강의자료:\n${material}` }],
  }), { maxAttempts: 3 });

  const block = response.content.find((item): item is Anthropic.ToolUseBlock => item.type === 'tool_use');
  if (!block) throw new ApiException('generation_failed', '구조화된 문항 초안을 만들지 못했습니다.', 502);
  const result = generatedAssessmentSchema.parse(block.input);
  return ok({ ...result, questions: result.questions.slice(0, settings.count).map((question, index) => ({ ...question, id: `draft-${index + 1}` })) });
});

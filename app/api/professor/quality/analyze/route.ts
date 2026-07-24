import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getAnthropic, MODELS, createMessage, withRetry } from '@/lib/ai/client';
import { requireDailyCostCap } from '@/lib/ai/cost-cap';
import { parsePptx } from '@/lib/extract/pptx';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

const requestSchema = z.object({
  questions: z.string().trim().max(60_000).default(''),
  focusRequest: z.string().trim().max(500).default(''),
  excludedCriteria: z.string().trim().max(500).default(''),
  additionalPrompt: z.string().trim().max(800).default(''),
});

const resultSchema = z.object({
  overallVerdict: z.enum(['양호', '수정 권장', '검토 필요']),
  summary: z.string().min(1),
  distribution: z.object({
    recall: z.number().int().min(0),
    understanding: z.number().int().min(0),
    application: z.number().int().min(0),
  }),
  coverageNotes: z.array(z.string()).max(6),
  items: z.array(z.object({
    number: z.number().int().min(1),
    verdict: z.enum(['통과', '수정 권장', '검토 필요']),
    testedObjective: z.string().min(1),
    flags: z.array(z.object({
      category: z.enum(['복수정답', '모호성', '정답 단서', '선택지 구성', '문항 중복', '범위 밖', '목표 불일치', '내용 편중', '내용 정확성', '최신성 확인', '기타']),
      severity: z.enum(['낮음', '중간', '높음']),
      message: z.string().min(1),
      suggestion: z.string().min(1),
    })).max(6),
  })).min(1).max(60),
});

const outputTool = {
  name: 'review_formative_items',
  description: 'Review formative assessment items and provide evidence-based revision suggestions.',
  input_schema: {
    type: 'object',
    required: ['overallVerdict', 'summary', 'distribution', 'coverageNotes', 'items'],
    properties: {
      overallVerdict: { type: 'string', enum: ['양호', '수정 권장', '검토 필요'] },
      summary: { type: 'string' },
      distribution: {
        type: 'object',
        required: ['recall', 'understanding', 'application'],
        properties: { recall: { type: 'integer' }, understanding: { type: 'integer' }, application: { type: 'integer' } },
      },
      coverageNotes: { type: 'array', items: { type: 'string' }, maxItems: 6 },
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 60,
        items: {
          type: 'object',
          required: ['number', 'verdict', 'testedObjective', 'flags'],
          properties: {
            number: { type: 'integer', minimum: 1 },
            verdict: { type: 'string', enum: ['통과', '수정 권장', '검토 필요'] },
            testedObjective: { type: 'string' },
            flags: {
              type: 'array',
              maxItems: 6,
              items: {
                type: 'object',
                required: ['category', 'severity', 'message', 'suggestion'],
                properties: {
                  category: { type: 'string', enum: ['복수정답', '모호성', '정답 단서', '선택지 구성', '문항 중복', '범위 밖', '목표 불일치', '내용 편중', '내용 정확성', '최신성 확인', '기타'] },
                  severity: { type: 'string', enum: ['낮음', '중간', '높음'] },
                  message: { type: 'string' },
                  suggestion: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

async function extractPdf(file: File) {
  const { default: pdfParse } = await import('pdf-parse');
  const parsed = await pdfParse(Buffer.from(await file.arrayBuffer()));
  return parsed.text.trim();
}

async function extractDocx(file: File) {
  const os = await import('node:os');
  const path = await import('node:path');
  const fsp = await import('node:fs/promises');
  const { convertPptxToPdf } = await import('@/lib/extract/render-slides');
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lecturelink-quality-'));
  const inputPath = path.join(tempRoot, 'questions.docx');
  try {
    await fsp.writeFile(inputPath, new Uint8Array(await file.arrayBuffer()));
    const pdfPath = await convertPptxToPdf(inputPath, tempRoot);
    const pdf = await fsp.readFile(pdfPath);
    const { default: pdfParse } = await import('pdf-parse');
    return (await pdfParse(pdf)).text.trim();
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractQuestionFile(file: File) {
  if (file.size > MAX_FILE_BYTES) throw new ApiException('file_too_large', '파일은 25MB 이하만 지원합니다.', 400);
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return extractPdf(file);
  if (file.type === DOCX_MIME || name.endsWith('.docx')) return extractDocx(file);
  if (file.type === 'text/plain' || name.endsWith('.txt')) return (await file.text()).trim();
  throw new ApiException('unsupported_question_file', '문항 파일은 PDF, DOCX, TXT만 지원합니다.', 400);
}

async function extractMaterialFile(file: File) {
  if (file.size > MAX_FILE_BYTES) throw new ApiException('file_too_large', '파일은 25MB 이하만 지원합니다.', 400);
  const name = file.name.toLowerCase();
  if (file.type === 'application/pdf' || name.endsWith('.pdf')) return extractPdf(file);
  if (file.type === PPTX_MIME || name.endsWith('.pptx')) {
    const parsed = parsePptx(await file.arrayBuffer());
    return parsed.slides.map((slide) => `[슬라이드 ${slide.index}] ${slide.text}`).join('\n').trim();
  }
  throw new ApiException('unsupported_material_file', '수업자료는 PPTX 또는 PDF만 지원합니다.', 400);
}

export const maxDuration = 120;

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  if (session.profile.accountType !== 'professor' && session.role !== 'admin') {
    throw new ApiException('professor_only', '교수 계정에서만 사용할 수 있습니다.', 403);
  }
  await requireDailyCostCap();

  const form = await request.formData();
  const settings = requestSchema.parse({
    questions: form.get('questions') || '',
    focusRequest: form.get('focusRequest') || '',
    excludedCriteria: form.get('excludedCriteria') || '',
    additionalPrompt: form.get('additionalPrompt') || '',
  });
  const questionFile = form.get('questionFile');
  const materialFile = form.get('materialFile');

  const fileQuestions = questionFile instanceof File ? await extractQuestionFile(questionFile) : '';
  const questionText = [fileQuestions, settings.questions].filter(Boolean).join('\n\n').slice(0, 60_000);
  if (questionText.length < 20) throw new ApiException('questions_required', '검토할 문항을 입력하거나 파일로 올려주세요.', 400);

  const materialText = materialFile instanceof File ? (await extractMaterialFile(materialFile)).slice(0, 80_000) : '';
  if (materialFile instanceof File && !materialText) {
    throw new ApiException('empty_material', '수업자료에서 읽을 수 있는 텍스트를 찾지 못했습니다.', 400);
  }

  const response = await withRetry(() => createMessage(getAnthropic(), {
    model: MODELS.generation(),
    max_tokens: 7000,
    system: `당신은 의학교육 형성평가 문항을 함께 검토하는 교수지원 조교다. 교수나 문항을 평가하지 말고 학생 학습을 방해할 수 있는 위험 신호와 실행 가능한 수정 제안을 제공한다. 항상 복수정답 가능성, 모호한 표현, 정답 단서, 선택지 구성, 인지 수준 편중, 문항 중복을 보수적으로 살핀다. 수업자료가 제공된 경우에만 수업 범위, 학습목표 정렬, 내용 편중, 근거 페이지를 추가로 검토한다. 수업자료가 없으면 범위 밖이나 목표 불일치를 단정하지 않는다. 최신성은 확실한 근거가 없으면 '최신성 확인'으로만 표시한다.`,
    tools: [outputTool],
    tool_choice: { type: 'tool', name: 'review_formative_items' },
    messages: [{
      role: 'user',
      content: `분석 모드: ${materialText ? '문항 자체 + 수업자료 정렬' : '문항 자체만'}
특히 확인할 내용: ${settings.focusRequest || '없음'}
제외할 검토 기준: ${settings.excludedCriteria || '없음'}
추가 요청: ${settings.additionalPrompt || '없음'}

${materialText ? `수업자료:\n${materialText}\n\n` : ''}검토할 문항:
${questionText}`,
    }],
  }), { maxAttempts: 3 });

  const block = response.content.find((item): item is Anthropic.ToolUseBlock => item.type === 'tool_use');
  if (!block) throw new ApiException('analysis_failed', '문항 검토 결과를 만들지 못했습니다.', 502);
  return ok({ ...resultSchema.parse(block.input), analysisMode: materialText ? '문항 + 수업자료' : '문항 자체' });
});

/**
 * POST /api/uploads/analyze
 *
 * 업로드된 학습자료 텍스트 일부를 추출해 Claude(가벼운 모델)로 메타데이터를 제안한다.
 * 업로드 페이지의 "추천 설정 / 문제 세트 정보" 폼 자동 채움에 사용된다.
 *
 * Body:  { upload_ids: string[] }
 * 응답:  {
 *   title: string,
 *   subject: string,
 *   topic: string,
 *   keywords: string[],
 *   difficulty: '하' | '중' | '상',
 *   question_type: '지식형' | '임상형' | '이미지형',
 * }
 *
 * 비용 보호:
 *   - 첫 1~2개 업로드만, 앞부분 텍스트만 사용.
 *   - 입력 텍스트 길이 12000자 제한.
 *   - 파싱/모델 오류 시 안전한 기본값으로 폴백 (200 으로 응답).
 */

import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { requireSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import {
  getAnthropic,
  MODELS,
  calculateCost,
  withRetry,
  createMessage,
} from '@/lib/ai/client';
import { recordAiCost } from '@/lib/ai/cost-cap';
import { parsePptx } from '@/lib/extract/pptx';
import { STORAGE_BUCKET } from '@/lib/storage/paths';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

export const maxDuration = 60;

// ─────── 상한 (비용/메모리 보호) ───────
const MAX_UPLOADS = 2; // 분석에 사용할 최대 업로드 수
const MAX_INPUT_CHARS = 12_000; // Claude 입력 텍스트 길이 제한
const PER_FILE_CHARS = 8_000; // 파일 1개당 앞부분 추출 한도

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const bodySchema = z.object({
  upload_ids: z.array(z.string().uuid()).min(1).max(20),
});

const DIFFICULTIES = ['하', '중', '상'] as const;
const QUESTION_TYPES = ['지식형', '임상형', '이미지형'] as const;

type Difficulty = (typeof DIFFICULTIES)[number];
type QuestionType = (typeof QUESTION_TYPES)[number];

interface AnalyzeResult {
  title: string;
  subject: string;
  topic: string;
  keywords: string[];
  difficulty: Difficulty;
  question_type: QuestionType;
}

const FALLBACK: AnalyzeResult = {
  title: '',
  subject: '',
  topic: '',
  keywords: [],
  difficulty: '중',
  question_type: '임상형',
};

/**
 * 업로드 파일에서 텍스트 앞부분만 가볍게 추출.
 *  - PDF: pdf-parse 본문 텍스트
 *  - PPTX: 슬라이드 텍스트
 *  - DOCX: LibreOffice 로 PDF 변환 후 pdf-parse
 *  - 그 외(이미지/레거시 등): 추출 생략 (빈 문자열)
 * 실패는 빈 문자열로 폴백 — 분석은 best-effort.
 */
async function extractTextPreview(input: {
  buffer: ArrayBuffer;
  fileType: string;
}): Promise<string> {
  const { buffer, fileType } = input;
  try {
    if (fileType === 'application/pdf') {
      const { default: pdfParse } = await import('pdf-parse');
      const result = await pdfParse(Buffer.from(buffer));
      return (result.text ?? '').replace(/\s+/g, ' ').trim().slice(0, PER_FILE_CHARS);
    }
    if (fileType === DOCX_MIME) {
      // DOCX → LibreOffice PDF 변환 → pdf-parse (분석용 앞부분 텍스트).
      const os = await import('node:os');
      const path = await import('node:path');
      const fsp = await import('node:fs/promises');
      const { convertPptxToPdf } = await import('@/lib/extract/render-slides');
      const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'medai-analyze-'));
      const inputPath = path.join(tmpRoot, 'input.docx');
      try {
        await fsp.writeFile(inputPath, new Uint8Array(buffer));
        const pdfPath = await convertPptxToPdf(inputPath, tmpRoot);
        const pdfBuf = await fsp.readFile(pdfPath);
        const { default: pdfParse } = await import('pdf-parse');
        const result = await pdfParse(pdfBuf);
        return (result.text ?? '').replace(/\s+/g, ' ').trim().slice(0, PER_FILE_CHARS);
      } finally {
        await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (fileType === PPTX_MIME) {
      const parsed = parsePptx(buffer);
      return parsed.slides
        .map((s) => s.text)
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, PER_FILE_CHARS);
    }
  } catch (e) {
    console.warn(
      '[uploads/analyze] 텍스트 추출 실패:',
      e instanceof Error ? e.message : String(e),
    );
  }
  return '';
}

/** Claude 응답을 안전하게 AnalyzeResult 로 정규화. */
function normalize(raw: unknown): AnalyzeResult {
  const o = (raw ?? {}) as Record<string, unknown>;

  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  const keywords = Array.isArray(o.keywords)
    ? o.keywords
        .map((k) => (typeof k === 'string' ? k.trim() : ''))
        .filter((k) => k.length > 0)
        .slice(0, 8)
    : [];

  const difficulty: Difficulty = DIFFICULTIES.includes(o.difficulty as Difficulty)
    ? (o.difficulty as Difficulty)
    : FALLBACK.difficulty;

  const questionType: QuestionType = QUESTION_TYPES.includes(
    o.question_type as QuestionType,
  )
    ? (o.question_type as QuestionType)
    : FALLBACK.question_type;

  return {
    title: str(o.title).slice(0, 80),
    subject: str(o.subject).slice(0, 40),
    topic: str(o.topic).slice(0, 60),
    keywords,
    difficulty,
    question_type: questionType,
  };
}

const ANALYZE_TOOL = {
  name: 'suggest_meta',
  description:
    '의료 강의자료에서 추출한 텍스트를 분석해 문제 세트 메타데이터를 제안한다.',
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: '문제집 이름으로 쓸 간결한 한국어 제목 (예: "심부전 약물치료")',
      },
      subject: {
        type: 'string',
        description: '의학 과목명 (예: "순환기내과", "약리학")',
      },
      topic: {
        type: 'string',
        description: '구체적인 단원/주제 (예: "심부전", "베타차단제")',
      },
      keywords: {
        type: 'array',
        items: { type: 'string' },
        description: '핵심 키워드 3~6개',
      },
      difficulty: {
        type: 'string',
        enum: ['하', '중', '상'],
        description: '예상 난이도',
      },
      question_type: {
        type: 'string',
        enum: ['지식형', '임상형', '이미지형'],
        description:
          '적합한 문항 유형. 지식형=암기/개념, 임상형=증례/판단, 이미지형=영상/사진 판독',
      },
    },
    required: [
      'title',
      'subject',
      'topic',
      'keywords',
      'difficulty',
      'question_type',
    ],
  },
};

const SYSTEM_PROMPT =
  '당신은 한국 의과대학 강의자료를 분석하는 보조자입니다. ' +
  '제공된 자료 텍스트를 바탕으로 문제 세트 메타데이터를 제안하세요. ' +
  '반드시 suggest_meta 도구를 호출해 한국어로 응답하고, 추측이 어려운 필드는 빈 문자열 또는 가장 그럴듯한 값을 쓰세요.';

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const body = bodySchema.parse(await request.json());

  const admin = createAdminClient();

  // 1) 업로드 레코드 조회 (본인 소유만). 요청 순서를 보존해 앞쪽 1~2개 사용.
  const { data: uploads, error: uErr } = await admin
    .from('user_uploads')
    .select('id, user_id, file_type, storage_path')
    .in('id', body.upload_ids)
    .eq('user_id', session.userId);

  if (uErr) {
    throw new ApiException('upload_query_failed', '업로드 조회 실패', 500, uErr);
  }

  const byId = new Map((uploads ?? []).map((u) => [u.id, u]));
  const ordered = body.upload_ids
    .map((id) => byId.get(id))
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
    .slice(0, MAX_UPLOADS);

  // 소유 업로드가 하나도 없으면 분석 불가 → 안전 폴백 반환.
  if (ordered.length === 0) {
    return ok(FALLBACK);
  }

  // 2) 텍스트 앞부분 추출 (다운로드 실패는 무시).
  const texts: string[] = [];
  for (const u of ordered) {
    if (!u.storage_path) continue;
    const { data: blob, error: dlErr } = await admin.storage
      .from(STORAGE_BUCKET)
      .download(u.storage_path);
    if (dlErr || !blob) continue;
    const buffer = await blob.arrayBuffer();
    const text = await extractTextPreview({ buffer, fileType: u.file_type });
    if (text) texts.push(text);
  }

  const compositeText = texts.join('\n\n---\n\n').slice(0, MAX_INPUT_CHARS).trim();

  // 추출된 텍스트가 전혀 없으면 Claude 호출 없이 기본값.
  if (!compositeText) {
    return ok(FALLBACK);
  }

  // 3) Claude 호출 — 메타 제안 (가벼운 모델). 실패 시 폴백.
  const model = MODELS.verification();
  try {
    const client = getAnthropic();
    const response = await withRetry(() =>
      createMessage(client, {
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: [ANALYZE_TOOL],
        tool_choice: { type: 'tool', name: 'suggest_meta' },
        messages: [
          {
            role: 'user',
            content:
              '다음은 강의 자료에서 추출한 텍스트입니다. 분석해 메타데이터를 제안하세요.\n\n' +
              compositeText,
          },
        ],
      }),
    );

    const toolUse = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    const genCost = calculateCost(
      model,
      response.usage.input_tokens,
      response.usage.output_tokens,
      response.usage.cache_read_input_tokens ?? 0,
      response.usage.cache_creation_input_tokens ?? 0,
    );
    await recordAiCost({
      userId: session.userId,
      endpoint: 'uploads.analyze',
      model,
      costUsd: genCost,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      metadata: { uploads: ordered.length },
    });

    if (!toolUse) {
      return ok(FALLBACK);
    }
    return ok(normalize(toolUse.input));
  } catch (e) {
    console.warn(
      '[uploads/analyze] 모델 호출 실패 — 기본값 반환:',
      e instanceof Error ? e.message : String(e),
    );
    return ok(FALLBACK);
  }
});

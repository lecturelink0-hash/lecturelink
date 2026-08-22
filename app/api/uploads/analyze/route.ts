/**
 * POST /api/uploads/analyze
 *
 * 업로드된 학습자료 텍스트 일부를 추출해 가벼운 모델(기본 gemini-2.5-flash)로 메타데이터를 제안한다.
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
/**
 * '컬럼 없음' 코드 — SELECT 는 Postgres 가 42703, INSERT/UPDATE 본문은 PostgREST 가
 * 선차단해 PGRST204 를 준다. 둘 다 봐야 쓰기 경로에서 폴백이 사문이 되지 않는다.
 */
const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204']);
import { parsePptx } from '@/lib/extract/pptx';
import { STORAGE_BUCKET } from '@/lib/storage/paths';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

export const maxDuration = 60;

// ─────── 상한 (비용/메모리 보호) ───────
const MAX_UPLOADS = 2; // 분석에 사용할 최대 업로드 수
const MAX_INPUT_CHARS = 12_000; // 모델 입력 텍스트 길이 제한
const PER_FILE_CHARS = 9_000; // 파일 1개당 표본 총량(앞·중·뒤 3구간 합)
/** 3구간 표본 — 앞부분만 보면 목차·표지가 판정을 지배한다(P6). */
const SAMPLE_SEGMENTS = 3;
// 뒤쪽 구간을 보려면 앞 12쪽만 파싱해서는 안 된다. 다만 대용량 PDF 에서 pdf-parse 가
// 수 초씩 걸리므로 상한 자체는 유지하되, 판정에 필요한 만큼만 올린다.
const MAX_PDF_PAGES = 40;

/**
 * 텍스트를 앞·중·뒤 3구간에서 고르게 뽑는다(P6).
 *
 * 종전에는 앞 8,000자만 썼다. 강의록은 앞이 표지·목차·학습목표라 "무엇에 대한 자료인가"를
 * 판정하기에 가장 나쁜 구간이고, 기출 PDF 는 앞쪽에 표지·응시 안내가 있어 문항 형태가
 * 드러나지 않는다. 세 구간을 이으면 목차만 보고 판단하는 문제가 줄어든다.
 */
function sampleAcross(text: string, total = PER_FILE_CHARS, segments = SAMPLE_SEGMENTS): string {
  const t = text.trim();
  if (t.length <= total) return t;
  const per = Math.floor(total / segments);
  const parts: string[] = [];
  for (let i = 0; i < segments; i++) {
    // 구간 시작점을 균등 배치하되 마지막 구간은 끝에서 잘라 뒤쪽을 반드시 포함한다.
    const start =
      i === segments - 1
        ? Math.max(0, t.length - per)
        : Math.floor((t.length - per) * (i / (segments - 1)));
    parts.push(t.slice(start, start + per));
  }
  return parts.join('\n…\n');
}

/**
 * 텍스트 추출 결과 (P10). 텍스트만 돌려주던 것을 쪽 수·원본 글자 수까지 담게 바꿨다 —
 * 로딩 화면의 남은 시간이 그 둘을 필요로 한다(쪽 수는 소요와 r = 0.50, 본문 글자 수는
 * 스캔본 판정의 축이다).
 */
interface TextPreview {
  /** 모델에 넣을 표본 텍스트(구간별로 잘라 이어 붙인 것). */
  text: string;
  /** 문서 전체 쪽 수. PPTX 는 슬라이드 수. 모르면 0. */
  pageCount: number;
  /** 표본으로 자르기 **전** 추출 글자 수. 스캔본 판정은 이 값으로 한다. */
  rawChars: number;
}

function preview(raw: string, pageCount: number): TextPreview {
  const trimmed = raw.trim();
  return { text: sampleAcross(trimmed), pageCount, rawChars: trimmed.length };
}

/**
 * 스캔본 판정 임계(자). 이보다 본문이 적으면 페이지 전체 OCR 경로로 떨어진다 —
 * 실측에서 그 경로는 같은 요청의 텍스트본보다 8배 넘게 걸렸다(96.4초 vs 11초).
 */
const SCAN_TEXT_CHARS = 1_500;

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const bodySchema = z.object({
  upload_ids: z.array(z.string().uuid()).min(1).max(20),
});

const DIFFICULTIES = ['하', '중', '상'] as const;
const QUESTION_TYPES = ['지식형', '임상형', '이미지형'] as const;
/**
 * 자료 성격(P6). 지금은 판정만 하고 **막지 않는다** — 기출/족보는 "참고 자료로 옮기기"를
 * 권유하고 로그만 남긴다(강제 차단은 R6 콘텐츠 정책 게이트에서 결정).
 */
const MATERIAL_KINDS = ['lecture', 'exam', 'notes', 'checklist', 'textbook', 'other'] as const;

type Difficulty = (typeof DIFFICULTIES)[number];
type QuestionType = (typeof QUESTION_TYPES)[number];
type MaterialKind = (typeof MATERIAL_KINDS)[number];

interface AnalyzeResult {
  title: string;
  subject: string;
  topic: string;
  keywords: string[];
  difficulty: Difficulty;
  question_type: QuestionType;
  /**
   * 의학 자료로 보이는지(P6). false 면 화면이 생성 전에 확인을 받는다.
   * 지금은 차단하지 않는다 — 오탐으로 정상 강의록을 막는 쪽이 더 나쁘다.
   */
  is_medical: boolean;
  /** 자료 성격. 'exam' 이면 화면이 "참고 자료로 옮기기"를 권유한다. */
  material_kind: MaterialKind;
  /** 판정 확신도 0~1. 낮으면 화면이 확인을 받는다. */
  confidence: number;
  /**
   * 실제로 모델이 자료를 읽고 낸 제안인지. false 면 텍스트를 못 뽑았거나(이미지·스캔본·.ppt)
   * 모델 호출이 실패해 **기본값을 채운 것**이므로, 화면은 이 값을 "추천"으로 적용하면 안 된다
   * (2026-08-18 감사: 스캔본을 올린 사용자의 유형·난이도 선택이 매번 '임상형·중'으로 덮였다).
   */
  analyzed: boolean;
  /**
   * 자료 전체 쪽 수(PPTX 는 슬라이드 수). 모르면 0 (P10).
   * 로딩 화면의 남은 시간이 쓴다 — 이미지형 소요와 상관 r = 0.50 으로, 문항 수(r = 0.08)보다
   * 훨씬 강한 변수다.
   */
  page_count: number;
  /**
   * 본문 텍스트가 거의 없는 스캔본인지 (P10). 페이지 전체 OCR 경로라 소요 규모가 다르다.
   * 이 값을 안 쓰던 종전 예측은 실측 96.4초짜리 실행을 9초로 예고했다(10.7배).
   */
  is_scan: boolean;
}

const FALLBACK: AnalyzeResult = {
  title: '',
  subject: '',
  topic: '',
  keywords: [],
  difficulty: '중',
  question_type: '임상형',
  // 판정하지 못했을 때는 "의학 자료가 아니다"라고 단정하지 않는다 — 텍스트를 못 읽은 것과
  // 비의학인 것은 다르다. analyzed:false 가 이미 "판정 못 함"을 말하므로 여기서는
  // 화면이 막지 않도록 관대한 기본값을 둔다.
  is_medical: true,
  material_kind: 'other',
  confidence: 0,
  analyzed: false,
  page_count: 0,
  is_scan: false,
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
}): Promise<TextPreview> {
  const { buffer, fileType } = input;
  try {
    if (fileType === 'application/pdf') {
      const { default: pdfParse } = await import('pdf-parse');
      const result = await pdfParse(Buffer.from(buffer), { max: MAX_PDF_PAGES });
      // numpages 는 max 와 무관한 문서 전체 쪽 수다(max 는 텍스트를 뽑을 쪽만 제한한다).
      return preview((result.text ?? '').replace(/\s+/g, ' '), result.numpages ?? 0);
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
        const result = await pdfParse(pdfBuf, { max: MAX_PDF_PAGES });
        return preview((result.text ?? '').replace(/\s+/g, ' '), result.numpages ?? 0);
      } finally {
        await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (fileType === PPTX_MIME) {
      const parsed = parsePptx(buffer);
      const joined = parsed.slides
        .map((slide) => slide.text)
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim();
      // 슬라이드 1장을 1쪽으로 센다 — 소요 예측에서 PDF 쪽 수와 같은 축이다.
      return preview(joined, parsed.slides.length);
    }
  } catch (e) {
    console.warn(
      '[uploads/analyze] 텍스트 추출 실패:',
      e instanceof Error ? e.message : String(e),
    );
  }
  return { text: '', pageCount: 0, rawChars: 0 };
}

/** 모델 응답을 안전하게 AnalyzeResult 로 정규화. */
// page_count·is_scan 은 모델 응답이 아니라 파일에서 잰 사실이므로 여기서 채우지 않는다.
function normalize(raw: unknown): Omit<AnalyzeResult, 'page_count' | 'is_scan'> {
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
    is_medical: typeof o.is_medical === 'boolean' ? o.is_medical : true,
    material_kind: MATERIAL_KINDS.includes(o.material_kind as MaterialKind)
      ? (o.material_kind as MaterialKind)
      : 'other',
    confidence:
      typeof o.confidence === 'number' && Number.isFinite(o.confidence)
        ? Math.min(1, Math.max(0, o.confidence))
        : 0.5,
    analyzed: true,
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
      is_medical: {
        type: 'boolean',
        description:
          '의학·보건 계열 학습자료인가. 요리·법률·소설·일반 통계·회사 소개처럼 의학과 무관하면 false. 확실하지 않으면 true 로 두고 confidence 를 낮춘다.',
      },
      material_kind: {
        type: 'string',
        enum: ['lecture', 'exam', 'notes', 'checklist', 'textbook', 'other'],
        description:
          '자료의 성격. lecture=강의 슬라이드·강의록, exam=이미 문항 형태인 기출·족보·문제지(번호와 선지가 나열됨), notes=필기·요약, checklist=술기·OSCE 체크리스트, textbook=교과서 발췌, other=그 밖.',
      },
      confidence: {
        type: 'number',
        description:
          '위 판정(is_medical·material_kind)의 확신도 0~1. 텍스트가 짧거나 목차만 보이는 등 근거가 약하면 0.5 미만으로 낮춘다.',
      },
    },
    required: [
      'title',
      'subject',
      'topic',
      'keywords',
      'difficulty',
      'question_type',
      'is_medical',
      'material_kind',
      'confidence',
    ],
  },
};

const SYSTEM_PROMPT =
  '당신은 한국 의과대학 학습자료를 분석하는 보조자입니다. ' +
  '제공된 자료 텍스트를 바탕으로 문제 세트 메타데이터를 제안하세요. ' +
  '반드시 suggest_meta 도구를 호출해 한국어로 응답합니다.\n' +
  // 종전에는 "추측이 어려운 필드는 가장 그럴듯한 값을 쓰세요"라고만 했다. 그래서 요리책을
  // 넣어도 과목명을 지어냈고, 국시 기출 PDF 가 학습자료로 들어와 기출 문항이 그대로
  // 재생성됐다(2026-08-18 감사 실증). 이제 "모르면 모른다"고 말할 자리를 만든다.
  '- 의학·보건 계열 자료가 아니면 is_medical=false 로 두고 subject·topic 은 빈 문자열로 둡니다. ' +
  '억지로 의학 과목명을 지어내지 마세요.\n' +
  '- 이미 문항 형태인 자료(기출·족보·문제지 — 번호와 선지가 나열됨)는 material_kind="exam" 으로 표시합니다.\n' +
  '- 근거가 약하면(텍스트가 짧거나 목차·표지만 보임) confidence 를 0.5 미만으로 낮춥니다. ' +
  '나머지 필드는 추측이 어려우면 빈 문자열로 두어도 됩니다.';

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

  // 2) 텍스트 앞부분 추출 (다운로드 실패는 무시). 파일별 다운로드+파싱은 병렬.
  const previews = await Promise.all(
    ordered.map(async (u): Promise<TextPreview> => {
      if (!u.storage_path) return { text: '', pageCount: 0, rawChars: 0 };
      const { data: blob, error: dlErr } = await admin.storage
        .from(STORAGE_BUCKET)
        .download(u.storage_path);
      if (dlErr || !blob) return { text: '', pageCount: 0, rawChars: 0 };
      const buffer = await blob.arrayBuffer();
      return extractTextPreview({ buffer, fileType: u.file_type });
    }),
  );
  const texts = previews.map((p) => p.text).filter((text) => text.length > 0);

  // 소요 예측용 사실(P10). 쪽 수는 합, 스캔본 판정은 **쪽은 있는데 본문이 없는** 경우다.
  // 텍스트 추출이 실패해 아래에서 기본값을 돌려주는 경로에서도 이 둘은 함께 보낸다 —
  // 스캔본이 정확히 그 경로로 오기 때문에, 여기서 빠뜨리면 가장 오래 걸리는 실행이
  // 가장 짧은 예고를 받는다.
  const pageCount = previews.reduce((sum, p) => sum + p.pageCount, 0);
  const rawChars = previews.reduce((sum, p) => sum + p.rawChars, 0);
  const isScan = pageCount > 0 && rawChars < SCAN_TEXT_CHARS;

  const compositeText = texts.join('\n\n---\n\n').slice(0, MAX_INPUT_CHARS).trim();

  // 추출된 텍스트가 전혀 없으면 모델 호출 없이 기본값.
  if (!compositeText) {
    return ok({ ...FALLBACK, page_count: pageCount, is_scan: isScan });
  }

  // 3) 모델 호출 — 메타 제안 (가벼운 모델, 기본 gemini-2.5-flash). 실패 시 폴백.
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
      return ok({ ...FALLBACK, page_count: pageCount, is_scan: isScan });
    }
    const result: AnalyzeResult = { ...normalize(toolUse.input), page_count: pageCount, is_scan: isScan };

    // P6 — 판정을 남긴다(권유·로그, 차단 없음). 분석 대상이었던 업로드에 기록한다.
    //
    // ⚠️ **응답 전에 await 한다.** 처음에는 `void (async () => …)()` 로 띄워 보냈는데,
    // 서버리스에서는 응답을 돌려준 순간 함수가 얼어붙어(freeze) 그 뒤의 프로미스가
    // 실행되지 않는다 — 00041 적용 직후 실측에서 판정이 **한 건도 저장되지 않았다**.
    // 이 UPDATE 는 수십 ms 인데 요청은 이미 모델 호출로 수 초를 쓰므로 체감이 없다.
    //
    // 실패해도 추천 자체는 돌려준다: 판정 기록은 부가 정보이고, 그것 때문에 업로드
    // 화면이 멈추면 안 된다(00041 미적용 환경 포함 — 컬럼 없음이면 조용히 건너뛴다).
    try {
      const { error: verdictErr } = await admin
        .from('user_uploads')
        .update({
          is_medical: result.is_medical,
          material_kind: result.material_kind,
          analyze_confidence: result.confidence,
        })
        .in('id', ordered.map((u) => u.id));
      if (verdictErr && !MISSING_COLUMN_CODES.has(verdictErr.code ?? '')) {
        console.warn('[uploads/analyze] 자료 판정 기록 실패:', verdictErr.message);
      }
    } catch (verdictError) {
      console.warn(
        '[uploads/analyze] 자료 판정 기록 예외:',
        verdictError instanceof Error ? verdictError.message : String(verdictError),
      );
    }
    // 비의학·기출은 로그로 남겨 빈도를 보고 나중에 정책(R6)을 정한다.
    if (!result.is_medical || result.material_kind === 'exam') {
      console.warn(
        `[uploads/analyze] 자료 판정 주의 — is_medical=${result.is_medical} kind=${result.material_kind} conf=${result.confidence} uploads=${ordered.length}`,
      );
    }

    return ok(result);
  } catch (e) {
    console.warn(
      '[uploads/analyze] 모델 호출 실패 — 기본값 반환:',
      e instanceof Error ? e.message : String(e),
    );
    return ok({ ...FALLBACK, page_count: pageCount, is_scan: isScan });
  }
});

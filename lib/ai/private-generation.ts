/**
 * Track A — 업로드 자료 기반 Private 문항 생성 파이프라인 (v2)
 *
 * 흐름:
 *   1. user_uploads 행 조회 → storage_path 확보
 *   2. Supabase Storage 에서 파일 다운로드
 *   3. file_type 별 분기:
 *      - application/pdf                   → renderPdfPages → page-by-page
 *      - PPTX (application/vnd.openxmlformats-officedocument.presentationml.presentation)
 *        → parsePptx 로 ppt/media 이미지 우선 수집 + 슬라이드 텍스트
 *        (LibreOffice 가 있으면 전체 슬라이드도 렌더 — 본 함수는 미디어만 사용)
 *      - image/*                          → 단일 이미지로
 *   4. 각 페이지/슬라이드에 대해:
 *      4a. 의료 이미지 영역 검출 (Vision)
 *      4b. crop → 전처리 → OCR
 *   5. 슬라이드 텍스트 + crop+OCR 결과를 Claude 에 한꺼번에 전달해 문항 생성
 *   6. private_questions 일괄 저장 + 상태 업데이트
 *
 * 비용 추적: 모든 호출이 recordAiCost 로 ai_cost_log 에 기록됨.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { createAdminClient } from '@/lib/db/admin';
import {
  getAnthropic,
  MODELS,
  calculateCost,
  withRetry,
  createMessage,
  type UsageRecord,
} from './client';
import { recordAiCost } from './cost-cap';
import {
  PRIVATE_GENERATION_SYSTEM_PROMPT,
  PRIVATE_GENERATION_TOOL_SCHEMA,
  buildPrivateGenerationUserMessage,
} from './prompts/private-generation';
import { STORAGE_BUCKET } from '@/lib/storage/paths';
import { parsePptx } from '@/lib/extract/pptx';
import {
  renderPdfPages,
  convertPptxToPdf,
  isLibreOfficeAvailable,
} from '@/lib/extract/render-slides';
import {
  detectMedicalRegions,
  cropRegions,
  type CroppedImage,
} from '@/lib/extract/crop-medical-images';
import { extractEmbeddedPdfImages } from '@/lib/extract/pdf-embedded-images';
import { selectExamImages } from '@/lib/extract/select-exam-images';
import { inpaintRemoveText } from '@/lib/extract/inpaint-text';
import { preprocessForOcr, normalizeToPng } from '@/lib/extract/preprocess';
import { runOcr } from '@/lib/ocr/engine';

// ─────── 비용/메모리 보호용 상한 ───────
// 본문 텍스트는 pdf-parse 가 "전체 페이지"에서 추출(최대 15만자)하므로, 아래 페이지 상한은
// "의료 이미지 검출을 위한 페이지 렌더" 수만 제한한다. 텍스트 위주 강의자료/시험자료는
// 이 값을 낮춰도 내용 손실이 없고, 페이지별 vision(검출+OCR) 호출이 줄어 생성 속도가 크게 빨라진다.
// (25→10 으로 하향: 28p 대용량 PDF 도 수 분→~2분 수준으로 단축. 이미지가 많은 자료는 앞 10p 위주.)
// 스캔/이미지 위주(텍스트 레이어가 부족한) 자료는 "전 페이지"를 이미지 분석 대상으로 삼아
// 놓치는 페이지가 없게 한다. 페이지별 Vision/OCR 은 순차가 아니라 병렬(아래 VISION_CONCURRENCY)
// 로 처리해 대용량 스캔도 현실적인 시간 안에 완료한다.
// (텍스트 위주 자료는 앞서 text-only 경로로 빠지므로 여기 상한과 무관.)
const MAX_PDF_PAGES = 100;         // 이미지 검출용 페이지 렌더 상한
const PDF_RENDER_EDGE_PX = 1280;   // PDF 페이지 렌더 해상도 — 메모리·토큰 절감 (기본 1600 대비 하향)
const MAX_VISION_SLIDES = 100;     // detectMedicalRegions 대상 슬라이드 수
const MAX_FEATURED_IMAGES = 8;     // 문항에 투입하는 이미지 상한 — 과다·노이즈 방지(기존 15에서 하향)
// 생성에 투입하는 텍스트 상한(자). 유료 티어(대컨텍스트)이므로 상향해 대용량(30~50p) 강의록의
// 뒷부분 내용이 잘리지 않게 한다. (기존 40,000자 → 30페이지 뒷부분 누락 원인)
const MAX_GEN_TEXT_CHARS = 150_000;
const MAX_EMBEDDED_CANDIDATES = 40; // AI 선별에 넣을 후보(추출) 상한
const VISION_CONCURRENCY = 6;      // 페이지 vision/OCR 동시 처리 수 — 순차 대비 대용량 대폭 가속
const PDF_SCAN_EDGE_PX = 320;      // 전체 페이지 로컬 후보 선별용 저해상도
// crop 단위 OCR 동시 처리 수. OCR 은 슬라이드가 아니라 crop 이미지 1장당 1회 호출이므로
// crop 을 평탄화해 전역 동시성으로 돌린다. (슬라이드 단위 병렬로는 임베드 이미지 경로처럼
// 한 슬라이드에 crop 이 몰린 경우 사실상 순차가 되어 수십 초를 잃는다.)
const OCR_CONCURRENCY = 8;
// 생성 배치당 최대 문항 수. 생성 시간은 배치당 "출력 토큰 수"가 지배하므로 배치를 잘게
// 쪼개 병렬로 돌리면 체감 시간이 배치 1개 수준으로 줄어든다. 문항당 출력이 1천 토큰대라
// 4문항 배치는 디코딩만 1분+ 걸림 → 2문항으로 줄여 배치 1개를 ~30초대로.
// (배치 수만큼 입력 컨텍스트가 반복 과금되므로 무한정 쪼개지는 않는다.)
const GEN_BATCH_MAX_QUESTIONS = 2;
// 생성 배치 동시 실행 상한. 20문항(10배치) 요청 시 대형 입력의 동시 요청 폭주로
// 429(rate limit) 백오프가 걸리면 오히려 벽시계 시간이 늘어나므로 과도한 동시성만 제한.
const GEN_CONCURRENCY = 8;
// 요청 수를 못 채웠을 때 빈 슬롯을 다시 채우는 최대 라운드 수.
// (모델이 요청보다 적게 반환하거나, 이미지 문항이 정제 실패로 삭제되면 부족분이 생긴다.)
const GEN_BACKFILL_ROUNDS = 2;
// 보충 배치에 싣는 출제 근거 텍스트 상한(자). 본 배치(최대 15만 자)와 달리 보충은
// "빈 칸 몇 개만 빠르게" 채우는 호출이라 입력을 줄여 429·대기 시간을 피한다.
const GEN_BACKFILL_CONTEXT_CHARS = 30_000;
// 배치별 구간 분할: 이 길이 미만의 자료는 나눠도 이득이 없어 전체를 그대로 준다.
const GEN_SEGMENT_ENABLE_MIN_CHARS = 20_000;
// 구간 하나의 최소 길이. 구간이 이보다 얇아지면 구간 수를 줄여(여러 배치가 같은 구간 공유)
// 출제 근거가 부족해지는 것을 막는다.
const GEN_SEGMENT_MIN_CHARS = 6_000;
// 구간 경계 겹침 비율 — 경계에 걸친 내용이 어느 배치에도 안 잡히는 일을 방지.
const GEN_SEGMENT_OVERLAP_RATIO = 0.1;

async function selectLikelyImagePages(
  pages: Array<{ pageIndex: number; png: Uint8Array }>,
): Promise<number[]> {
  const { createCanvas, loadImage } = await import('canvas');
  const selected: number[] = [];
  for (const page of pages) {
    try {
      const image = await loadImage(Buffer.from(page.png));
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
      // Text glyphs mostly disappear at 48px width. Medical photos, radiology,
      // charts, and shaded diagrams retain contiguous dark/color/midtone mass.
      if (dark / total > 0.025 || colored / total > 0.035 || midtone / total > 0.11) {
        selected.push(page.pageIndex);
      }
    } catch {
      // A page that cannot be scored is kept so local selection never becomes
      // a silent content-loss mechanism.
      selected.push(page.pageIndex);
    }
  }
  return selected;
}

/**
 * items 를 최대 `limit` 개씩 동시에 처리하고, 입력 순서를 보존한 결과 배열을 반환한다.
 * 페이지별 Vision/OCR 호출을 병렬로 돌려 다중 페이지(스캔) 자료의 처리 시간을 단축한다.
 * 개별 작업의 예외는 fn 내부에서 처리(여기선 rethrow 안 함) — 한 페이지 실패가 전체를 막지 않게.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (completed: number, total: number) => Promise<void> | void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let completed = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
      completed += 1;
      await onProgress?.(completed, items.length);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * DB / UI 에 저장될 error_message 를 짧고 안전한 형태로 정리.
 * - 내부 stack trace, supabase 내부 디테일 노출 방지
 * - 200자 제한
 */
function sanitizeErrorMessage(raw: unknown): string {
  let m = raw instanceof Error ? raw.message : String(raw ?? '');
  m = m.replace(/\s+/g, ' ').trim();
  if (!m) return '알 수 없는 처리 오류';
  if (m.length > 200) m = m.slice(0, 197) + '...';
  return m;
}

/**
 * 발문이 "제시된 그림을 봐야만 풀리는" 문항인지 판정.
 *
 * 이미지가 정제(텍스트 제거) 실패나 재사용 상한으로 빠지면, 그림을 가리키는 발문은
 * 풀 수 없으므로 문항을 삭제해야 한다. 반대로 모델이 이미지를 곁들이기만 하고 발문은
 * 텍스트만으로 완결된 경우(흔함)까지 삭제하면 요청 수가 모자라 보충 생성이 돌고,
 * 그 보충 호출이 전체 시간을 수십 초 늘린다. 그래서 발문 표현으로 구분한다.
 * (판정이 애매하면 삭제 쪽으로 — 못 푸는 문항을 남기는 것이 더 나쁘다.)
 */
const IMAGE_DEIXIS =
  '다음|아래|위의|위에|제시된|해당|보이는|첨부된|주어진';
const IMAGE_NOUNS =
  '그림|사진|이미지|영상|심전도|ECG|EKG|방사선|엑스레이|X-?ray|CT|MRI|초음파|병리|현미경|소견';
const IMAGE_DEPENDENT_STEM_RE = new RegExp(
  // 지시어와 명사 사이에 수식어가 끼어드는 형태까지 잡는다("아래 흉부 X-ray 를 보고").
  `(?:${IMAGE_DEIXIS})\\s*(?:[가-힣A-Za-z0-9]{1,6}\\s*){0,2}(?:${IMAGE_NOUNS})|` +
    `(?:${IMAGE_NOUNS})\\s*(?:에서|에는|을|를|의|상)\\s*(?:관찰|보이|나타|판독|해석)|` +
    `판독(?:하|해)|사진\\s*판독`,
  'i',
);

function stemDependsOnImage(stem: string): boolean {
  return IMAGE_DEPENDENT_STEM_RE.test(String(stem ?? ''));
}

/**
 * 문두 종결어미를 국시체로 정규화(결정론적 후처리).
 * 프롬프트가 대부분 "~것은?"으로 유도하지만, 병렬 배치에서 간혹 구어체가 새어나오므로
 * 여기서 확실히 격식체로 변환한다. (문법이 깨지지 않는 안전한 변환만 수행.)
 */
function normalizeStemEnding(stem: string): string {
  let s = String(stem ?? '').replace(/\s+$/, '');
  // "...은/는 무엇인가요?/무엇입니까?/무엇인가?" → "...은/는?" (KMLE 표준 종결)
  s = s.replace(/([은는])\s*무엇(?:인가요|입니까|인가)\s*\?$/u, '$1?');
  // "...가요?"(정중 구어 의문) → "...가?"(격식 의문). 예: 인가요→인가, 하는가요→하는가
  s = s.replace(/가요\s*\?$/u, '가?');
  return s;
}

export interface PrivateGenerationInput {
  uploadId: string;
  userId: string;
  desiredCount?: number;
  style?: 'kmle' | 'professor' | 'internal';
  /** 사용자 지정 난이도(하/중/상) — 생성 프롬프트에 반영. */
  difficulty?: '하' | '중' | '상';
  /** 사용자 지정 문항 유형 — 생성 프롬프트에 반영. */
  questionTypes?: Array<'지식형' | '임상형' | '이미지형'>;
  /** 사용자 지정 문제집 이름 — 세트 표시명으로 저장. */
  title?: string;
  /** 기출 형식 참고 자료. 문항 구조만 참고하고 내용 근거로 사용하지 않는다. */
  referenceUploadIds?: string[];
}

export interface PrivateGenerationResult {
  generatedCount: number;
  privateQuestionIds: string[];
  contentSummary: string;
  unmatched: number;
  usage: UsageRecord;
  extractStats: {
    pages: number;
    croppedImages: number;
    ocrChars: number;
  };
}

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PPT_MIME = 'application/vnd.ms-powerpoint';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface ExtractedSlide {
  pageIndex: number;
  text: string;
  croppedImages: CroppedImage[];
}

const MAX_REFERENCE_IMAGES = 6;

async function loadReferenceImages(input: {
  uploadIds: string[];
  userId: string;
}): Promise<Uint8Array[]> {
  if (input.uploadIds.length === 0) return [];

  const admin = createAdminClient();
  const { data: uploads, error } = await admin
    .from('user_uploads')
    .select('id, user_id, file_type, storage_path')
    .in('id', input.uploadIds)
    .eq('user_id', input.userId);
  if (error) throw new Error(`Reference upload lookup failed: ${error.message}`);

  const byId = new Map((uploads ?? []).map((upload) => [upload.id, upload]));
  const images: Uint8Array[] = [];
  for (const id of input.uploadIds) {
    if (images.length >= MAX_REFERENCE_IMAGES) break;
    const upload = byId.get(id);
    if (!upload) continue;
    const { data: blob, error: downloadError } = await admin.storage
      .from(STORAGE_BUCKET)
      .download(upload.storage_path);
    if (downloadError || !blob) continue;
    const buffer = await blob.arrayBuffer();

    if (upload.file_type.startsWith('image/')) {
      const png = await normalizeToPng(new Uint8Array(buffer));
      if (png) images.push(png);
      continue;
    }
    if (upload.file_type === 'application/pdf') {
      try {
        const pages = await renderPdfPages(buffer, {
          maxPages: Math.min(3, MAX_REFERENCE_IMAGES - images.length),
          maxEdgePx: PDF_RENDER_EDGE_PX,
        });
        images.push(...pages.map((page) => page.png));
      } catch (error) {
        console.warn(
          '[private-generation] reference PDF render skipped:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }
  return images.slice(0, MAX_REFERENCE_IMAGES);
}

/**
 * PPTX 를 LibreOffice 로 PDF 변환 후 페이지별 PNG 렌더.
 * 환경에 LibreOffice 가 없으면 null 반환 — 호출자는 media-only fallback 사용.
 */
async function tryRenderPptxViaLibreOffice(
  buffer: ArrayBuffer,
  ext: 'pptx' | 'ppt' = 'pptx',
): Promise<Array<{ pageIndex: number; png: Uint8Array }> | null> {
  if (!(await isLibreOfficeAvailable())) return null;

  const os = await import('node:os');
  const path = await import('node:path');
  const fsp = await import('node:fs/promises');

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'medai-pptx-'));
  const inputPath = path.join(tmpRoot, `input.${ext}`);
  try {
    await fsp.writeFile(inputPath, new Uint8Array(buffer));
    const pdfPath = await convertPptxToPdf(inputPath, tmpRoot);
    const pdfBuf = await fsp.readFile(pdfPath);
    const pages = await renderPdfPages(
      pdfBuf.buffer.slice(
        pdfBuf.byteOffset,
        pdfBuf.byteOffset + pdfBuf.byteLength,
      ) as ArrayBuffer,
      { maxPages: MAX_PDF_PAGES },
    );
    return pages.map((p) => ({ pageIndex: p.pageIndex, png: p.png }));
  } finally {
    // 임시 디렉토리 정리. 실패 무시.
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Office 문서(buffer)를 LibreOffice 로 PDF 변환 후 PDF 버퍼를 반환.
 * DOCX 등 텍스트 중심 문서용 — 호출자는 결과 PDF 를 기존 PDF 파이프라인
 * (pdf-parse 텍스트 + renderPdfPages 이미지)에 그대로 태운다.
 * LibreOffice 가 없으면 null.
 */
async function convertOfficeToPdfBuffer(
  buffer: ArrayBuffer,
  ext: 'docx',
): Promise<ArrayBuffer | null> {
  if (!(await isLibreOfficeAvailable())) return null;

  const os = await import('node:os');
  const path = await import('node:path');
  const fsp = await import('node:fs/promises');

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'medai-doc-'));
  const inputPath = path.join(tmpRoot, `input.${ext}`);
  try {
    await fsp.writeFile(inputPath, new Uint8Array(buffer));
    const pdfPath = await convertPptxToPdf(inputPath, tmpRoot);
    const pdfBuf = await fsp.readFile(pdfPath);
    return pdfBuf.buffer.slice(
      pdfBuf.byteOffset,
      pdfBuf.byteOffset + pdfBuf.byteLength,
    ) as ArrayBuffer;
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractFromBuffer(input: {
  buffer: ArrayBuffer;
  fileType: string;
  userIdForLog: string;
  onVisionProgress?: (completed: number, total: number) => Promise<void> | void;
}): Promise<{ slides: ExtractedSlide[]; warnings: string[] }> {
  const { buffer, fileType, userIdForLog } = input;
  const warnings: string[] = [];

  // PDF 임베드 이미지(object dedup) — 있으면 Vision 검출/crop 대신 이걸 우선 사용.
  let pdfEmbeddedCrops: CroppedImage[] | null = null;
  let allowWholePageOcrFallback = fileType.startsWith('image/');

  // ── 슬라이드 / 페이지 텍스트 + PNG 산출
  let slidesData: Array<{ pageIndex: number; text: string; png: Uint8Array }> = [];

  if (fileType === 'application/pdf' || fileType === DOCX_MIME) {
    // 옵션 2 (text + image): worker(Render) 환경에서 실행 — Vercel 의 60초/SIGSEGV 제약 없음.
    //  (1) 본문 텍스트는 pdf-parse 로 안정적으로 추출.
    //  (2) 페이지 이미지는 renderPdfPages(@napi-rs/canvas)로 렌더 → 의료 이미지 검출/crop.
    // 메모리(512MB) 보호: MAX_PDF_PAGES / PDF_RENDER_EDGE_PX 로 페이지 수·해상도 제한.
    // OCR 은 OCR_BACKEND=claude 로 고정해 tesseract wasm 을 메모리에 올리지 않는다.
    //
    // DOCX 는 LibreOffice 로 PDF 변환 후 동일 파이프라인을 재사용한다.
    let pdfBuffer = buffer;
    if (fileType === DOCX_MIME) {
      const converted = await convertOfficeToPdfBuffer(buffer, 'docx');
      if (!converted) {
        throw new Error(
          'DOCX 를 변환하지 못했습니다 (LibreOffice 필요). PDF 로 저장 후 업로드해 주세요.',
        );
      }
      pdfBuffer = converted;
    }

    // (1) 본문 텍스트 + (1-b) 임베드 이미지 추출/선별 — 서로 독립이므로 병렬 수행.
    //     (임베드 선별은 Vision AI 호출이라 네트워크 대기가 길다. pdf-parse 와 겹쳐
    //      초기 추출 단계 시간을 줄인다.)
    const [parsedFullText, embeddedCropsResult] = await Promise.all([
      // (1) 본문 텍스트 — 실패(null)해도 이미지 경로는 계속 진행.
      (async (): Promise<string | null> => {
        try {
          const { default: pdfParse } = await import('pdf-parse');
          const result = await pdfParse(Buffer.from(pdfBuffer));
          return (result.text ?? '').trim();
        } catch (e) {
          warnings.push(
            `PDF 본문 텍스트 추출 실패 — 페이지 이미지만 사용. ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          return null;
        }
      })(),
      // (1-b) PDF 에 박힌 이미지 전부 직접 추출(object dedup) → AI 로 "시험용 의료 이미지"만 선별.
      //       텍스트 양과 무관하게 항상 수행 → 텍스트 위주 강의 PDF 에서도 X-ray/ECG 판독 문항 생성.
      (async (): Promise<CroppedImage[] | null> => {
        try {
          const candidates = await extractEmbeddedPdfImages(Buffer.from(pdfBuffer), {
            maxImages: MAX_EMBEDDED_CANDIDATES,
            maxOutEdgePx: 1024,
          });
          if (candidates.length === 0) return null;
          // AI 선별: 로고·장식·표지·순수 도표 제외, 판독 가치 있는 의료 이미지만(개수는 내용에 따라 가변).
          const selected = await selectExamImages(candidates, { max: MAX_FEATURED_IMAGES });
          const chosen =
            selected ??
            // 선별 실패(모델 오류/429) 시 면적 큰 순 폴백.
            candidates
              .slice(0, MAX_FEATURED_IMAGES)
              .map((im) => ({ image: im, kind: 'other' as const }));
          warnings.push(
            `임베드 이미지 ${candidates.length}개 추출 → 선별 ${chosen.length}개 사용${selected ? '' : '(선별 실패·폴백)'}.`,
          );
          if (chosen.length === 0) return null;
          return chosen.map(({ image, kind }) => ({
            region: { kind, x: 0, y: 0, width: 1, height: 1, confidence: 1 },
            png: image.png,
            widthPx: image.widthPx,
            heightPx: image.heightPx,
          }));
        } catch (e) {
          warnings.push(
            `임베드 이미지 추출/선별 실패 — Vision 경로로 폴백. ${e instanceof Error ? e.message : String(e)}`,
          );
          return null;
        }
      })(),
    ]);
    const fullText = parsedFullText ?? '';
    if (parsedFullText !== null) {
      allowWholePageOcrFallback = fullText.length < 1500;
    }
    pdfEmbeddedCrops = embeddedCropsResult;

    // (2) 페이지 이미지 — 의료 이미지 검출/crop 용.
    //
    // ★ 속도 최적화: 본문 텍스트가 충분히 추출된(=텍스트 위주) 자료는 페이지 렌더 +
    //   페이지별 Vision(의료이미지 검출) + OCR 을 통째로 생략하고 텍스트만으로 생성한다.
    //   강의록·시험 복기 같은 텍스트 위주 PDF 는 페이지가 많아도 이 경로로 1회 생성 호출만
    //   하게 되어 대용량(수십 페이지)도 빠르게 완료된다. (Vision 호출이 페이지 수만큼
    //   순차 누적돼 수 분씩 걸리던 문제 해소.)
    //   텍스트가 부족한(스캔/이미지 위주) 자료만 기존 페이지 렌더 + Vision 경로를 탄다.
    let pages: Awaited<ReturnType<typeof renderPdfPages>> = [];
    try {
      if (!pdfEmbeddedCrops) {
        if (allowWholePageOcrFallback) {
          pages = await renderPdfPages(pdfBuffer, {
            maxPages: MAX_PDF_PAGES,
            maxEdgePx: PDF_RENDER_EDGE_PX,
          });
        } else {
          const scanPages = await renderPdfPages(pdfBuffer, {
            maxPages: MAX_PDF_PAGES,
            maxEdgePx: PDF_SCAN_EDGE_PX,
          });
          const candidatePages = await selectLikelyImagePages(scanPages);
          if (candidatePages.length > 0) {
            pages = await renderPdfPages(pdfBuffer, {
              pages: candidatePages,
              maxPages: MAX_PDF_PAGES,
              maxEdgePx: PDF_RENDER_EDGE_PX,
            });
          }
          warnings.push(
            `로컬 이미지 후보 선별: 전체 ${scanPages.length}페이지 중 ${candidatePages.length}페이지 Vision 대상.`,
          );
        }
      }
      } catch (e) {
        warnings.push(
          `PDF 페이지 렌더 실패 — 텍스트만 사용. ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
    }

    if (slidesData.length > 0) {
      // 텍스트 위주 경로에서 이미 slidesData 를 채웠으면 그대로 사용.
    } else if (pages.length > 0) {
      // 본문 텍스트는 페이지 단위 분리가 어려워 첫 페이지에 부여, 이미지는 페이지별.
      slidesData = pages.map((p, i) => ({
        pageIndex: p.pageIndex,
        text: i === 0 ? fullText.slice(0, MAX_GEN_TEXT_CHARS) : '',
        png: p.png,
      }));
    } else {
      // 렌더 실패 폴백: 텍스트만 (이미지 단계는 png.length === 0 으로 자동 skip).
      if (!fullText) {
        warnings.push(
          'PDF 에서 텍스트·이미지를 모두 추출하지 못했습니다. 스캔 품질/파일 상태를 확인하세요.',
        );
      }
      slidesData = [{ pageIndex: 1, text: fullText.slice(0, MAX_GEN_TEXT_CHARS), png: new Uint8Array() }];
    }
  } else if (fileType === PPTX_MIME) {
    const parsed = parsePptx(buffer);
    warnings.push(...parsed.warnings);

    // 1) 환경에 LibreOffice 가 있으면 슬라이드 전체 렌더 시도.
    //    실패하면 media-only fallback 으로 떨어짐.
    let renderedPages: Array<{ pageIndex: number; png: Uint8Array }> | null = null;
    try {
      renderedPages = await tryRenderPptxViaLibreOffice(buffer);
    } catch (e) {
      warnings.push(
        `LibreOffice 변환 실패 — media 임베드 이미지만 사용. ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      renderedPages = null;
    }

    if (renderedPages && renderedPages.length > 0) {
      // 슬라이드 텍스트는 parsed.slides 에서 가져와 매핑 (페이지 순서 동일 가정).
      slidesData = renderedPages.map((p) => {
        const slideText = parsed.slides[p.pageIndex - 1]?.text ?? '';
        return { pageIndex: p.pageIndex, text: slideText, png: p.png };
      });
    } else {
      // 2) Fallback: ppt/media 임베드 이미지만 사용.
      //    Vision/crop/OCR 파이프라인이 모두 PNG (`media_type: 'image/png'`) 가정으로 동작하므로
      //    JPEG/WebP/BMP 같은 비-PNG 임베드 이미지는 normalizeToPng 으로 재인코딩한다.
      //    normalize 실패(EMF/WMF/손상) 는 warning 후 skip — 슬라이드 텍스트는 보존.
      for (const slide of parsed.slides) {
        if (slide.imageRefs.length === 0) {
          slidesData.push({
            pageIndex: slide.index,
            text: slide.text,
            png: new Uint8Array(),
          });
          continue;
        }
        let kept = 0;
        for (const ref of slide.imageRefs) {
          const bin = parsed.media.get(ref);
          if (!bin) continue;
          const png = await normalizeToPng(bin);
          if (!png) {
            warnings.push(
              `slide ${slide.index}: 임베드 이미지 ${ref} 를 PNG 로 변환 실패 — skip`,
            );
            continue;
          }
          slidesData.push({
            pageIndex: slide.index,
            text: slide.text,
            png,
          });
          kept += 1;
        }
        // 모든 이미지가 변환 실패였다면 텍스트만 진행할 수 있도록 빈 페이지 한 줄 추가.
        if (kept === 0) {
          slidesData.push({
            pageIndex: slide.index,
            text: slide.text,
            png: new Uint8Array(),
          });
        }
      }
    }
  } else if (fileType === PPT_MIME) {
    // 레거시 .ppt (OLE 바이너리) — PPTX 처럼 XML 파싱이 불가하므로
    // LibreOffice 렌더에 전적으로 의존한다. 변환 실패 시 폴백 없음 → 명확히 throw.
    let renderedPages: Array<{ pageIndex: number; png: Uint8Array }> | null = null;
    try {
      renderedPages = await tryRenderPptxViaLibreOffice(buffer, 'ppt');
    } catch (e) {
      throw new Error(
        `레거시 .ppt 변환 실패 — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!renderedPages || renderedPages.length === 0) {
      throw new Error(
        '레거시 .ppt 를 변환하지 못했습니다 (LibreOffice 필요). PDF 또는 .pptx 로 저장 후 업로드해 주세요.',
      );
    }
    slidesData = renderedPages.map((p) => ({
      pageIndex: p.pageIndex,
      text: '',
      png: p.png,
    }));
  } else if (
    fileType === 'image/png' ||
    fileType === 'image/jpeg' ||
    fileType === 'image/webp'
  ) {
    slidesData.push({
      pageIndex: 1,
      text: '',
      png: new Uint8Array(buffer),
    });
  } else {
    throw new Error(`Unsupported file_type: ${fileType}`);
  }

  // ── 각 슬라이드/페이지에서 의료 이미지 검출 + crop.
  //    png 가 있는(=이미지 분석 대상) 슬라이드 중 앞에서 MAX_VISION_SLIDES 개를 병렬 처리.
  //    입력 순서를 보존하기 위해 인덱스 기반으로 결과를 채운다.
  const slides: ExtractedSlide[] = new Array(slidesData.length);

  const visionIndices: number[] = [];
  for (let i = 0; i < slidesData.length; i++) {
    const s = slidesData[i];
    if (
      !pdfEmbeddedCrops &&
      s.png.length > 0 &&
      visionIndices.length < MAX_VISION_SLIDES
    ) {
      visionIndices.push(i);
    } else {
      // 텍스트만 슬라이드 또는 상한 초과 → 이미지 검출 skip(텍스트는 보존).
      slides[i] = { pageIndex: s.pageIndex, text: s.text, croppedImages: [] };
    }
  }

  // 선정된 페이지들의 검출+crop+전처리를 병렬로 수행 (순차 대비 대용량 스캔 대폭 가속).
  await mapWithConcurrency(
    visionIndices,
    VISION_CONCURRENCY,
    async (idx) => {
      const s = slidesData[idx];
      try {
        const det = await detectMedicalRegions({ slidePng: s.png, userIdForLog });
      // fallback: 의료 이미지 검출 0건인 페이지는 페이지 전체를 region 으로 잡아
      // OCR/Claude 가 슬라이드 텍스트·도표를 볼 수 있게 한다.
      // 단, 이 "페이지 전체" 크롭은 ocrOnly 로 표시해 문항 이미지로는 노출하지 않는다
      // (주석 텍스트·다중 그림·정답 단서 혼입 방지).
      const isWholePageFallback = det.regions.length === 0;
      const regionsToUse =
        det.regions.length > 0
          ? det.regions
          : allowWholePageOcrFallback
            ? [{ kind: 'other' as const, x: 0, y: 0, width: 1, height: 1, confidence: 1 }]
            : [];
      const cropped = await cropRegions(s.png, regionsToUse);
      const preprocessed: CroppedImage[] = [];
      for (const c of cropped) {
        try {
          // OCR 용 전처리(대비 정규화/흑백)는 별도 이미지(ocrPng)로 유지하고,
          // 표시·인페인팅에 쓰는 원본 색상 크롭(c.png)은 그대로 보존한다
          // (전처리본을 그대로 보여주면 컬러 다이어그램이 흑백/저채도로 표시되는 문제 방지).
          const ocrPng = await preprocessForOcr(c.png, {
            grayscale: c.region.kind === 'ecg' || c.region.kind === 'xray',
            normalizeContrast: true,
          });
          preprocessed.push({ ...c, ocrPng, ocrOnly: isWholePageFallback });
        } catch (e) {
          warnings.push(
            `slide ${s.pageIndex}: 전처리 실패 — ${e instanceof Error ? e.message : String(e)}`,
          );
          preprocessed.push({ ...c, ocrOnly: isWholePageFallback }); // 원본 그대로 진행
        }
      }
        slides[idx] = { pageIndex: s.pageIndex, text: s.text, croppedImages: preprocessed };
      } catch (e) {
        warnings.push(
          `slide ${s.pageIndex}: 영역 검출 실패 — ${e instanceof Error ? e.message : String(e)}`,
        );
        slides[idx] = { pageIndex: s.pageIndex, text: s.text, croppedImages: [] };
      }
      return null;
    },
    input.onVisionProgress,
  );

  const imagePages = slidesData.filter((s) => s.png.length > 0).length;
  if (imagePages > MAX_VISION_SLIDES) {
    warnings.push(
      `이미지 페이지 ${imagePages}장 중 ${MAX_VISION_SLIDES}장만 이미지 검출 수행 (상한).`,
    );
  }

  // PDF 임베드 추출이 있으면 그것을 featured 이미지로 우선 사용(Vision crop 결과는 중복 방지 위해 대체).
  if (pdfEmbeddedCrops && pdfEmbeddedCrops.length > 0 && slides.length > 0) {
    slides[0].croppedImages = pdfEmbeddedCrops;
    for (let i = 1; i < slides.length; i++) {
      if (slides[i]) slides[i].croppedImages = [];
    }
  }

  return { slides, warnings };
}

export async function generatePrivateQuestionsFromUpload(
  input: PrivateGenerationInput,
): Promise<PrivateGenerationResult> {
  const admin = createAdminClient();
  const desiredCount = input.desiredCount ?? 12;
  const style = input.style ?? 'kmle';

  const updateProgress = async (
    stage: string,
    current = 0,
    total = 0,
    extra: Record<string, unknown> = {},
  ) => {
    await admin
      .from('user_uploads')
      .update({
        processing_stage: stage,
        progress_current: current,
        progress_total: total,
        heartbeat_at: new Date().toISOString(),
        ...extra,
      })
      .eq('id', input.uploadId);
  };

  // 1) Upload 조회
  const { data: upload, error: uploadErr } = await admin
    .from('user_uploads')
    .select('id, user_id, file_name, file_type, storage_path, status')
    .eq('id', input.uploadId)
    .maybeSingle();

  if (uploadErr || !upload) {
    throw new Error(`Upload not found: ${input.uploadId}`);
  }
  if (upload.user_id !== input.userId) {
    throw new Error('Upload ownership mismatch');
  }
  // 아래 배치 생성 함수는 function 선언(호이스팅)이라 TS 가 upload 의 null 배제
  // 내로잉을 함수 본문에 전파하지 않는다 — non-null 로 확정된 별칭을 캡처시킨다.
  const uploadRow = upload;

  await admin
    .from('user_uploads')
    .update({
      status: 'processing',
      processing_stage: 'downloading',
      progress_current: 0,
      progress_total: 0,
      completed_question_count: 0,
      target_question_count: desiredCount,
      heartbeat_at: new Date().toISOString(),
      error_message: null,
    })
    .eq('id', upload.id);

  // 살아있는 동안 heartbeat 를 주기적으로 갱신한다. 큐의 고착 회복 로직이
  // "heartbeat 가 오래됨 = 워커가 죽음" 으로 판단하므로, 대용량 PDF 추출처럼 단계 갱신
  // 없이 수 분이 걸리는 구간에서도 살아있음을 알려야 멀쩡한 작업이 중복 실행되지 않는다.
  const heartbeatTimer = setInterval(() => {
    void admin
      .from('user_uploads')
      .update({ heartbeat_at: new Date().toISOString() })
      .eq('id', input.uploadId)
      .then(() => undefined, () => undefined);
  }, 20_000);

  const startTime = Date.now();
  let totalCost = 0;
  let aggInputTokens = 0;
  let aggOutputTokens = 0;
  let modelUsed = MODELS.generation();

  try {
    // 2) 다운로드
    const { data: fileBlob, error: dlErr } = await admin.storage
      .from(STORAGE_BUCKET)
      .download(upload.storage_path);
    if (dlErr || !fileBlob) {
      throw new Error(`Storage download failed: ${dlErr?.message}`);
    }
    const fileBuffer = await fileBlob.arrayBuffer();

    // 3) 추출 (페이지 텍스트 + crop 이미지) — 참고자료·분류 카탈로그 로드는 독립 작업이라
    //    병렬로 겹친다. (카탈로그를 미리 받아야 OCR 와중에 텍스트 선발사 배치를 띄울 수 있다.)
    await updateProgress('extracting');
    const [{ slides, warnings }, referenceImages, subTopicsRes] = await Promise.all([
      extractFromBuffer({
        buffer: fileBuffer,
        fileType: upload.file_type,
        userIdForLog: input.userId,
        onVisionProgress: async (completed, total) =>
          updateProgress('vision', completed, total),
      }),
      loadReferenceImages({
        uploadIds: input.referenceUploadIds ?? [],
        userId: input.userId,
      }),
      admin
        .from('sub_topics')
        .select('id, code, name, subject:subjects ( name )'),
    ]);

    // 4) 분류 카탈로그·생성 프롬프트·배치 계획을 OCR "이전"에 준비한다 — 본문 텍스트가
    //    충분한 자료는 아래 "텍스트 선발사 배치"가 OCR 과 병행으로 먼저 출발할 수 있게.
    type CatalogRow = {
      id: string;
      code: string;
      name: string;
      subject: { name: string } | { name: string }[] | null;
    };
    const catalog = (subTopicsRes.data ?? []).map((row) => {
      const s = row as CatalogRow;
      const subj = Array.isArray(s.subject) ? s.subject[0] : s.subject;
      return {
        id: s.id,
        code: s.code,
        name: s.name,
        subject_name: subj?.name ?? '',
      };
    });
    const codeToId = new Map(catalog.map((c) => [c.code, c.id]));

    const catalogText = catalog
      .map((c) => `  - ${c.subject_name} > ${c.name} (code: \`${c.code}\`)`)
      .join('\n');
    let systemPrompt = PRIVATE_GENERATION_SYSTEM_PROMPT.replace(
      '{SUB_TOPIC_CATALOG}',
      catalogText,
    );
    // 사용자 지정 난이도·문항유형을 생성 지시로 반영.
    const diffDirective =
      input.difficulty === '하'
        ? '전체 문항을 **쉬운(기본 개념) 난이도** 위주로 생성한다(difficulty 1~2).'
        : input.difficulty === '상'
          ? '전체 문항을 **어렵고 지엽적/응용 난이도** 위주로 생성한다(difficulty 2~3).'
          : input.difficulty === '중'
            ? '전체 문항을 **표준(중간) 난이도** 위주로 생성한다(difficulty 2).'
            : '';
    const typeDirectives: Record<string, string> = {
      '지식형': '**지식형**: 개념·정의·기전을 확인하는 단답/개념 확인 문항 위주로 만든다(긴 증례보다 핵심 지식).',
      '임상형': '**임상형**: 실제 환자 증례(vignette: 나이/증상/검사)를 제시하고 진단·처치·판단을 묻는 임상 문항 위주로 만든다.',
      '이미지형': '**이미지형**: 자료의 의료 이미지를 판독·해석해야 푸는 문항을 가능한 한 많이 만든다(이미지가 있으면 우선).',
    };
    const selectedTypes = input.questionTypes ?? [];
    const typeDirective = selectedTypes.length
      ? `선택된 문항 유형(${selectedTypes.join(', ')})을 전체 문항에 고르게 배분한다.\n${selectedTypes.map((type) => typeDirectives[type]).join('\n')}`
      : '';
    if (diffDirective || typeDirective) {
      systemPrompt += `\n\n## 사용자 지정 출제 조건\n${[diffDirective, typeDirective].filter(Boolean).join('\n')}`;
    }
    const client = getAnthropic();
    modelUsed = MODELS.generation();

    // 생성 시간은 배치당 출력 토큰(≈ 문항 수)이 지배한다. 문항을 GEN_BATCH_MAX_QUESTIONS
    // 이하의 균등한 소배치로 나눠 병렬 실행하면 전체 소요가 "가장 큰 배치 1개" 수준으로
    // 줄어든다. (4문항 배치도 디코딩만 1분+ 라 2문항으로 축소 — 상수 주석 참고.)
    const batchCount = Math.ceil(desiredCount / GEN_BATCH_MAX_QUESTIONS);
    const baseBatchSize = Math.floor(desiredCount / batchCount);
    const batchRemainder = desiredCount % batchCount;
    const batchSizes = Array.from(
      { length: batchCount },
      (_, i) => baseBatchSize + (i < batchRemainder ? 1 : 0),
    );
    const allCrops = slides.flatMap((s) =>
      s.croppedImages.map((c) => ({ slide: s, crop: c })),
    );
    const totalCropped = allCrops.length;
    let ocrChars = 0;
    let completedQuestions = 0;

    // ★ 텍스트 선(先)발사 — 본문 텍스트는 이미 준비된 시점이므로 첫 배치를 텍스트만으로
    //   즉시 출발시켜 crop OCR(이미지 자료에서 수십 초)과 생성 시간을 겹친다. 이미지 판독
    //   배치(나머지)는 OCR·이미지 선별 완료 후 실행한다. 텍스트가 빈약한(스캔 위주) 자료는
    //   선발사 컨텍스트가 부실하므로 기존 순서(OCR 후 일괄)를 유지한다.
    //   실패는 즉시 던지지 않고 감싸 두었다가(unhandled rejection 크래시 방지) 아래
    //   본배치 단계에서 전체 컨텍스트로 재시도한다.
    const slideTextTotal = slides.map((s) => s.text).join(' ').trim();
    const canPrefire = batchSizes.length > 1 && slideTextTotal.length >= 1000;
    // 선발사 컨텍스트: 자료가 커서 구간 분할이 적용될 규모면 앞쪽 구간(0번)만 맡는다.
    const prefireBlocks = slides
      .filter((s) => s.text.trim().length > 0)
      .map((s) => `## 슬라이드 ${s.pageIndex}\n텍스트: ${s.text}`);
    const prefireFull = prefireBlocks.join('\n\n');
    const prefireSegments =
      prefireFull.length < GEN_SEGMENT_ENABLE_MIN_CHARS
        ? 1
        : Math.max(
            1,
            Math.min(
              batchSizes.length,
              Math.floor(prefireFull.length / GEN_SEGMENT_MIN_CHARS),
            ),
          );
    const prefireSegmented = prefireSegments > 1;
    const prefireContext = (): string => {
      if (!prefireSegmented) return prefireFull;
      if (prefireBlocks.length >= prefireSegments) {
        const per = Math.ceil(prefireBlocks.length / prefireSegments);
        return prefireBlocks.slice(0, per + 1).join('\n\n');
      }
      const segLen = Math.ceil(prefireFull.length / prefireSegments);
      const end = Math.min(
        prefireFull.length,
        segLen + Math.round(segLen * GEN_SEGMENT_OVERLAP_RATIO),
      );
      const nl = prefireFull.lastIndexOf('\n', end);
      return prefireFull.slice(0, nl > segLen * 0.5 ? nl : end);
    };
    const prefired = canPrefire
      ? generateAndPersistBatch(0, Array.from({ length: batchSizes[0] }, (_, k) => k), batchSizes.length, {
          // 선발사는 OCR 이전이라 자기만의 컨텍스트를 만든다. 본 배치들과 마찬가지로
          // 자료 전체가 아니라 0번 구간만 맡아 입력을 줄이고 중복 출제도 피한다.
          // (OCR 후 구성되는 compositeText 와 분할 기준이 조금 달라도, 담당 범위가
          //  자료 앞부분이라는 점은 일치한다.)
          contextText: prefireContext(),
          featured: [],
          getDisplayPng: async () => null,
          segmented: prefireSegmented,
        }).then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        )
      : null;

    // 5) crop 이미지 OCR — crop 단위로 평탄화해 전역 병렬 처리.
    //    (슬라이드 단위 병렬은 임베드 이미지 경로처럼 crop 이 첫 슬라이드에 몰리면
    //     사실상 순차가 되어 crop 수 × 호출 지연만큼 느려진다.)
    await updateProgress('ocr', 0, allCrops.length, { page_count: slides.length });
    await mapWithConcurrency(
      allCrops,
      OCR_CONCURRENCY,
      async ({ slide, crop }) => {
        try {
          const r = await runOcr({
            png: crop.ocrPng ?? crop.png, // OCR 은 전처리본, 표시는 원본 색상 유지
            userIdForLog: input.userId,
            context: slide.text,
          });
          // 단일 동기 문장 += 는 JS 이벤트루프 상 원자적이라 병렬 누적에 안전.
          totalCost += r.costUsd;
          ocrChars += r.text.length;
          crop.ocrText = r.text; // 인페인팅 대상(주석 텍스트 유무) 선별에 사용
        } catch (e) {
          warnings.push(
            `slide ${slide.pageIndex}: OCR 실패 — ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return null;
      },
      async (completed, total) => updateProgress('ocr', completed, total),
    );
    const slideSummaries = slides.map((s) => ({
      pageIndex: s.pageIndex,
      slideText: s.text,
      ocrTexts: s.croppedImages
        .filter((c) => (c.ocrText ?? '').length > 0)
        .map((c) => `[${c.region.kind}] ${c.ocrText}`),
      cropCount: s.croppedImages.length,
    }));

    // 5.5) 추출 결과가 전부 비어 있으면 Claude 호출은 의미 없음 → 명확한 실패 메시지.
    const totalSlideText = slideSummaries
      .map((ss) => ss.slideText)
      .join(' ')
      .trim();
    const hasAnyContext =
      totalSlideText.length > 0 || ocrChars > 0 || totalCropped > 0;
    if (!hasAnyContext) {
      throw new Error(
        '추출된 텍스트·이미지가 없습니다. 자료에 본문 텍스트나 의료 이미지가 포함되어 있는지 확인하세요.',
      );
    }

    // 6) 통합 컨텍스트 구성 — 슬라이드 텍스트 + OCR 결과를 라벨링해 한 번에 전달
    const contextBlocks: string[] = [];
    for (const ss of slideSummaries) {
      const parts: string[] = [];
      if (ss.slideText) parts.push(`텍스트: ${ss.slideText}`);
      if (ss.ocrTexts.length > 0) parts.push(`이미지(OCR):\n${ss.ocrTexts.join('\n')}`);
      if (parts.length > 0) {
        contextBlocks.push(`## 슬라이드 ${ss.pageIndex} (이미지 ${ss.cropCount}장)\n${parts.join('\n')}`);
      }
    }
    const compositeText = contextBlocks.join('\n\n');

    // ── 배치별 구간 분할
    // 지금까지는 모든 배치가 자료 전체(최대 15만 자)를 실어 동시에 호출했다. 그래서
    // 배치 수만큼 입력 토큰이 중복 과금되고, 순간 입력량이 커져 429(rate limit)에 걸려
    // 백오프 대기가 전체 소요를 지배했다(실측: 배치 삽입이 49~105초로 흩어짐).
    // 각 배치에 자기 구간만 주면 배치당 입력이 구간 수만큼 줄고, 구간이 물리적으로
    // 분리돼 배치 간 문항 중복도 함께 줄어든다.
    //
    // 안전장치:
    //  - 자료가 작으면(GEN_SEGMENT_ENABLE_MIN_CHARS 미만) 분할하지 않는다(이득 없음).
    //  - 구간이 너무 얇아 출제 근거가 부족해지지 않게 구간당 최소 길이를 보장하고,
    //    필요하면 구간 수를 배치 수보다 적게 줄여 여러 배치가 같은 구간을 공유한다.
    //  - 경계에서 문맥이 끊기지 않게 앞뒤로 겹침을 둔다.
    const segmentCount = (() => {
      if (batchSizes.length <= 1) return 1;
      if (compositeText.length < GEN_SEGMENT_ENABLE_MIN_CHARS) return 1;
      const byLength = Math.floor(compositeText.length / GEN_SEGMENT_MIN_CHARS);
      return Math.max(1, Math.min(batchSizes.length, byLength));
    })();

    /** 문장/줄 경계에 맞춰 text 의 index/count 번째 구간을 잘라낸다(앞뒤 겹침 포함). */
    const sliceByChars = (
      text: string,
      index: number,
      count: number,
      maxChars = Number.POSITIVE_INFINITY,
    ): string => {
      if (count <= 1) return text;
      const segLen = Math.ceil(text.length / count);
      const pad = Math.round(segLen * GEN_SEGMENT_OVERLAP_RATIO);
      let start = Math.max(0, index * segLen - pad);
      let end = Math.min(text.length, index * segLen + segLen + pad);
      // 시작은 다음 줄바꿈까지 밀고, 끝은 이전 줄바꿈까지 당겨 문장이 잘리지 않게 한다.
      if (start > 0) {
        const nl = text.indexOf('\n', start);
        if (nl >= 0 && nl - start < 500) start = nl + 1;
      }
      if (end < text.length) {
        const nl = text.lastIndexOf('\n', end);
        if (nl > start && end - nl < 500) end = nl;
      }
      return text.slice(start, Math.min(end, start + maxChars));
    };

    /** 배치 index 가 볼 출제 근거. 분할이 필요 없으면 전체를 그대로 준다. */
    const segmentForBatch = (batchIndex: number, batchCount: number): string => {
      if (segmentCount <= 1) return compositeText;
      // 배치를 구간에 고르게 배분(구간 수 < 배치 수면 여러 배치가 같은 구간을 본다).
      const segIndex = Math.min(
        segmentCount - 1,
        Math.floor((batchIndex * segmentCount) / Math.max(1, batchCount)),
      );
      // 슬라이드 블록이 구간 수보다 많으면 블록 경계로 나눈다(문장이 잘리지 않는다).
      if (contextBlocks.length >= segmentCount) {
        const per = Math.ceil(contextBlocks.length / segmentCount);
        const from = Math.max(0, segIndex * per - 1); // 앞 블록 1개 겹침
        const to = Math.min(contextBlocks.length, segIndex * per + per + 1);
        return contextBlocks.slice(from, to).join('\n\n');
      }
      // 텍스트 위주 PDF 는 본문이 한 블록에 몰리므로 문자 단위로 나눈다.
      return sliceByChars(compositeText, segIndex, segmentCount);
    };
    if (segmentCount > 1) {
      warnings.push(
        `출제 근거 ${compositeText.length}자를 ${segmentCount}개 구간으로 분할해 배치별로 배정.`,
      );
    }

    // 7) Claude 호출 — 문항 생성 (프롬프트·배치 계획은 4)에서 준비됨)
    await updateProgress('generating', 0, desiredCount);

    // crop 된 의료 이미지 — 인덱스 라벨과 함께 제시.
    // Storage 업로드는 생성 응답에서 실제 사용된 이미지만 골라 나중에 수행한다 (고아·비용 방지).
    // 텍스트 캡처 검열: OCR 로 읽힌 "의미 있는 글자(문자·숫자)" 수 기준.
    // 강의록 본문/필기 캡처가 문항 이미지로 쓰이면 이미지 안 텍스트가 정답 단서가
    // 되므로 결정론적으로 배제한다 (vision 분류 오류에 대한 2차 방어선).
    const meaningfulOcrLen = (t?: string) =>
      (t ?? '').replace(/[^\p{L}\p{N}]/gu, '').length;
    const CLINICAL_KINDS = new Set([
      'xray', 'ct', 'mri', 'ecg', 'pathology', 'microscope', 'ultrasound',
    ]);
    const isTextCapture = (c: (typeof slides)[number]['croppedImages'][number]) => {
      if (c.region.kind === 'text_slide') return true; // vision 이 텍스트 캡처로 분류
      const len = meaningfulOcrLen(c.ocrText);
      // 실제 임상 영상(X-ray/CT 등)에는 판독 가능한 텍스트가 거의 없다 —
      // 글자가 많다면 "chest x-ray" 같은 단어 때문에 오분류된 텍스트 캡처다.
      if (CLINICAL_KINDS.has(c.region.kind) && len >= 80) return true;
      // 다이어그램류도 글자가 이 정도로 많으면 그림이 아니라 텍스트 슬라이드다
      // (인페인팅해도 빈 이미지만 남는다).
      if (len >= 250) return true;
      return false;
    };

    // gi = 전역 이미지 인덱스. 배치마다 서로 다른 이미지 묶음을 주더라도 인페인팅 캐시와
    // Storage 경로는 전역 인덱스로 통일해야 배치 간 중복 작업·경로 충돌이 없다.
    const featuredImages = slides
      .flatMap((s) => s.croppedImages.map((c) => ({ slide: s.pageIndex, c })))
      // 페이지 전체 OCR 폴백 크롭은 문항 이미지에서 제외(주석·다중 그림·정답 단서 혼입 방지).
      .filter((x) => !x.c.ocrOnly)
      // 강의록 텍스트 캡처는 문항 이미지 후보에서 원천 배제.
      .filter((x) => !isTextCapture(x.c))
      .slice(0, MAX_FEATURED_IMAGES)
      .map((x, gi) => ({ ...x, gi }));

    // 사용자가 '이미지형'을 선택하지 않았으면 이미지를 생성 배치에 아예 넣지 않는다.
    // 넣으면 시스템 프롬프트의 "이미지 판독 문항 우선" 지시 때문에 이미지 문항이 만들어지고,
    // 그 이미지가 정제(인페인팅) 검증에서 탈락하거나 "동일 이미지 최대 2문제" 정리에 걸리면
    // 문항이 통째로 삭제돼 요청 수보다 적게 남는다(10 요청 → 6 저장의 주 원인).
    const useImages = (input.questionTypes ?? []).includes('이미지형') && featuredImages.length > 0;
    if (!useImages) {
      systemPrompt +=
        '\n\n## 이미지 사용 금지(이번 요청)\n' +
        '이번 요청에서는 의료 이미지를 제공하지 않는다. 모든 문항은 제공된 텍스트 근거만으로 ' +
        '풀 수 있게 만들고, `image_indices` 는 **항상 빈 배열 []** 로 둔다. ' +
        '"다음 심전도에서", "아래 흉부 X-ray 를 보고" 처럼 제시되지 않은 그림을 가리키는 발문도 쓰지 않는다.';
    }

    // 선별 텍스트 인페인팅(비용 최적화): 모든 featured 를 미리 인페인팅하지 않고,
    // 생성이 "실제 참조한" 이미지에 한해 저장 직전 1회만 인페인팅한다(캐시로 배치 간 중복 방지).
    // 대상: 다이어그램/일러스트 유형(anatomy_diagram/chart_graph/other) + 주석 텍스트 감지.
    // 실제 임상 사진(xray/ct/mri/ecg/pathology/microscope/ultrasound)은 재생성 위험이라 제외.
    // 생성 모델은 원본(주석 포함)을 보고 문항을 만들고(내용 이해), 학생에게는 정제본이 저장된다.
    const inpaintKinds = new Set(['anatomy_diagram', 'chart_graph', 'other']);
    const inpaintEnabled = process.env.ENABLE_TEXT_INPAINT !== '0';
    // 인페인팅 결과에 글자가 이보다 많이 남아 있으면 "텍스트 잔존"으로 판단(정답 단서 위험).
    const RESIDUAL_TEXT_MAX = 8;

    // 인페인팅된 이미지를 다시 OCR 하여 남은 "의미 있는 글자(한글·라틴·숫자)" 개수를 센다.
    // OCR 실패 시 0 반환(판단 불가 → 과도한 제외 방지).
    const residualTextLen = async (png: Uint8Array): Promise<number> => {
      try {
        const r = await runOcr({ png, userIdForLog: input.userId });
        totalCost += r.costUsd;
        return (r.text ?? '').replace(/[^\p{L}\p{N}]/gu, '').length;
      } catch {
        return 0;
      }
    };

    // 표시용 이미지 반환. 인페인팅 대상은 (1차 인페인팅 → OCR 검증 → 필요 시 2차 인페인팅)
    // 을 거치고, 그래도 글자가 남거나 인페인팅이 실패하면 null 을 반환한다.
    // null = "정답 단서 텍스트를 못 지운 이미지" → 호출자는 업로드/문항 연결을 하지 않고 제외한다.
    const inpaintCache = new Map<number, Promise<Uint8Array | null>>();
    const getDisplayPng = (i: number): Promise<Uint8Array | null> => {
      const fi = featuredImages[i];
      const shouldInpaint =
        inpaintEnabled &&
        inpaintKinds.has(fi.c.region.kind) &&
        (fi.c.ocrText?.trim().length ?? 0) >= 8;
      if (!shouldInpaint) return Promise.resolve(fi.c.png);
      let p = inpaintCache.get(i);
      if (!p) {
        p = (async (): Promise<Uint8Array | null> => {
          try {
            let cleaned = await inpaintRemoveText(fi.c.png, { userId: input.userId });
            if (!cleaned) {
              // 인페인팅 자체 실패 — 원본에는 정답 단서 텍스트가 남아 있으므로 제외.
              warnings.push(`이미지 ${i}: 텍스트 제거 실패 — 정답 단서 노출 방지를 위해 문항에서 제외`);
              return null;
            }
            // 검증 1차: 글자가 남아 있으면 한 번 더 인페인팅.
            if ((await residualTextLen(cleaned)) > RESIDUAL_TEXT_MAX) {
              const again = await inpaintRemoveText(cleaned, { userId: input.userId });
              if (again) cleaned = again;
              // 검증 2차: 그래도 남으면 제외.
              if ((await residualTextLen(cleaned)) > RESIDUAL_TEXT_MAX) {
                warnings.push(`이미지 ${i}: 텍스트가 완전히 지워지지 않아 문항에서 제외`);
                return null;
              }
            }
            return cleaned;
          } catch {
            return null;
          }
        })();
        inpaintCache.set(i, p);
      }
      return p;
    };

    type GeneratedQuestion = {
      stem: string;
      choices: string[];
      answer_index: number;
      explanation: string;
      concepts: string[];
      difficulty: 1 | 2 | 3;
      image_indices: number[];
      sub_topic_code: string | null;
    };
    type BatchResult = {
      generatedCount: number;
      contentSummary: string;
      ids: string[];
      unmatched: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    };
    // 배치별 생성 컨텍스트 — "텍스트 선발사 배치"(이미지 없음)와 "전체 컨텍스트 배치"가
    // 같은 함수를 공유하기 위한 주입 지점.
    type GenContext = {
      contextText: string;
      /** 이 배치에 제시할 이미지. gi 는 전역 인덱스(인페인팅 캐시·Storage 경로 기준). */
      featured: Array<{ slide: number; c: CroppedImage; gi: number }>;
      getDisplayPng: (gi: number) => Promise<Uint8Array | null>;
      /**
       * 429(rate limit) 재시도 대기 상한. 보충 배치는 본 배치들이 방금 끝난 직후에
       * 실행돼 429 를 맞기 쉬운데, 기본 상한(45초)을 그대로 기다리면 그 대기가 전체
       * 소요를 지배한다(실측 66초 꼬리). 보충은 짧게 여러 번 재시도한다.
       */
      retryMaxDelayMs?: number;
      /**
       * contextText 가 자료 "전체"가 아니라 배정된 구간인지. true 면 배치 지시문에서
       * "구간을 스스로 골라 출제하라"는 문구를 쓰지 않는다(이미 구간만 받았으므로).
       */
      segmented?: boolean;
    };

    // 배치 1개 생성+저장. function 선언 호이스팅 덕분에 OCR 이전의 선발사 호출부에서도
    // 사용할 수 있다 (참조하는 카탈로그·프롬프트는 모두 4)에서 미리 준비됨).
    // slots: 이 배치가 채울 generation_slot 목록(연속이 아닐 수 있다 — 부족분 보충용).
    async function generateAndPersistBatch(
      batchIndex: number,
      slots: number[],
      batchCount: number,
      gen: GenContext,
    ): Promise<BatchResult> {
      const batchSize = slots.length;
      const validImageIndex = (i: number) => i >= 0 && i < gen.featured.length;
      const { data: existingBatch, error: existingBatchError } = await admin
        .from('private_questions')
        .select('id, generation_slot')
        .eq('upload_id', uploadRow.id)
        .in('generation_slot', slots);
      if (existingBatchError) throw existingBatchError;
      if ((existingBatch?.length ?? 0) >= batchSize) {
        completedQuestions += batchSize;
        await updateProgress('partially_completed', completedQuestions, desiredCount, {
          completed_question_count: completedQuestions,
        });
        return {
          generatedCount: batchSize,
          contentSummary: '',
          ids: (existingBatch ?? []).map((row) => row.id),
          unmatched: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
      }

      const userMessage = buildPrivateGenerationUserMessage({
        subTopicCatalog: catalog,
        desiredCount: batchSize,
        style,
      });
      const userContent: Anthropic.MessageParam['content'] = [];
      for (let i = 0; i < referenceImages.length; i++) {
        userContent.push({
          type: 'text',
          text: `[기출 형식 참고 ${i + 1}] 내용은 출제 근거로 사용하지 말고 문항의 구조, 질문 방식, 선지 구성 방식만 참고하세요.`,
        });
        userContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from(referenceImages[i]).toString('base64'),
          },
        } as Anthropic.ImageBlockParam);
      }
      for (let i = 0; i < gen.featured.length; i++) {
        userContent.push({ type: 'text', text: `[이미지 ${i}] (필수 자료에서 커팅)` });
        userContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from(gen.featured[i].c.png).toString('base64'),
          },
        } as Anthropic.ImageBlockParam);
      }
      // 병렬 배치 간 중복 방지.
      //  - 구간 분할이 적용된 경우(gen.segmented): 아래 근거 자체가 이 배치에 배정된
      //    구간이므로 "구간을 골라 출제하라"고 하지 않고 "받은 근거로만 출제"하게 한다.
      //  - 분할하지 않은 경우(자료가 작음): 종전처럼 구간을 스스로 나눠 맡게 안내한다.
      const batchDirective =
        batchCount === 1
          ? ''
          : (gen.segmented
              ? `\n\n아래 출제 근거는 전체 자료를 ${batchCount}묶음으로 나눠 이번 묶음(${batchIndex + 1}번째)에 배정된 구간입니다. ` +
                `다른 묶음이 나머지 구간을 담당하므로, 제시된 근거 안에서만 출제하고 정확히 지정된 수만큼 만드세요.`
              : `\n\n이번 묶음은 전체 출제 계획 ${batchCount}묶음 중 ${batchIndex + 1}번째 묶음입니다. ` +
                `자료를 ${batchCount}개 구간으로 나눴을 때 ${batchIndex + 1}번째 구간의 내용을 우선 출제해 다른 묶음과의 중복을 피하고, 정확히 지정된 수만큼 만드세요.`) +
            (batchIndex === 0
              ? ' 핵심·기본 개념 문항을 포함하세요.'
              : ' 전형적인 기본 정의 문항보다 응용·감별 문항을 우선하세요.');
      userContent.push({
        type: 'text',
        text:
          `다음은 필수 업로드 자료에서 추출한 출제 근거입니다. 기출 형식 참고 자료의 의학 내용은 사용하지 말고, 아래 내용과 필수 자료 이미지만으로 문항을 만드세요.\n\n` +
          (gen.contextText || '(추출된 텍스트·이미지 없음)') +
          `\n\n${userMessage}${batchDirective}`,
      });

      // 해설 길이 상한(350자) 적용 후 문항당 실출력은 ~1,000토큰대. 다만 지시 이탈로
      // 길어질 때 출력이 잘리면 함수호출(functionCall)이 통째로 사라져 "tool_use 블록이
      // 없음"으로 실패하므로 예산은 여유 있게(문항당 1,800) 잡는다. max_tokens 는 상한일
      // 뿐이라 실제 속도는 실출력 토큰 수가 결정한다.
      const genMaxTokens = Math.min(16000, Math.max(6000, batchSize * 1800));
      const callGenerate = (maxTokens: number) =>
        withRetry(
          () =>
            createMessage(client, {
              model: modelUsed,
              max_tokens: maxTokens,
              system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
              tools: [PRIVATE_GENERATION_TOOL_SCHEMA],
              tool_choice: { type: 'tool', name: 'generate_private_questions' },
              messages: [{ role: 'user', content: userContent }],
            }),
          gen.retryMaxDelayMs
            ? { maxAttempts: 4, backoffMs: 700, maxDelayMs: gen.retryMaxDelayMs }
            : {},
        );
      let response = await callGenerate(genMaxTokens);
      let toolUseBlock = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      if (!toolUseBlock) {
        // 도구 호출 누락 — 대부분 출력 잘림(max_tokens) 또는 모델의 간헐적 미준수.
        // 예산을 2배로 올려 1회 재시도한다.
        console.warn(
          `[private-gen] tool_use 누락 → 재시도 (batch=${batchIndex + 1}, stop=${response.stop_reason})`,
        );
        response = await callGenerate(Math.min(30000, genMaxTokens * 2));
        toolUseBlock = response.content.find(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
        );
      }
      if (!toolUseBlock) {
        throw new Error(
          `생성 응답에 도구 호출이 없습니다 (stop=${response.stop_reason ?? '?'}). 잠시 후 다시 시도해주세요.`,
        );
      }
      const parsed = toolUseBlock.input as {
        questions: GeneratedQuestion[];
        content_summary: string;
      };
      if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
        throw new Error(`Claude 생성 응답 파싱 실패 (batch=${batchIndex + 1})`);
      }

      const genCost = calculateCost(
        modelUsed,
        response.usage.input_tokens,
        response.usage.output_tokens,
        response.usage.cache_read_input_tokens ?? 0,
        response.usage.cache_creation_input_tokens ?? 0,
      );
      totalCost += genCost;
      aggInputTokens += response.usage.input_tokens;
      aggOutputTokens += response.usage.output_tokens;
      await recordAiCost({
        userId: input.userId,
        endpoint: 'private.generate',
        model: modelUsed,
        costUsd: genCost,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        metadata: {
          uploadId: uploadRow.id,
          batch: batchIndex + 1,
          batchCount,
          slides: slides.length,
          croppedImages: totalCropped,
          ocrChars,
        },
      });

      let unmatched = 0;
      const rows = parsed.questions.slice(0, batchSize).map((q, questionIndex) => {
        const subTopicId = q.sub_topic_code ? codeToId.get(q.sub_topic_code) ?? null : null;
        if (!subTopicId) unmatched += 1;
        return {
          user_id: input.userId,
          upload_id: uploadRow.id,
          sub_topic_id: subTopicId,
          stem: normalizeStemEnding(q.stem),
          choices: q.choices,
          answer_index: q.answer_index,
          explanation: q.explanation,
          concepts: q.concepts ?? [],
          difficulty: q.difficulty,
          generation_slot: slots[questionIndex],
        };
      });
      const { data: inserted, error: insertErr } = await admin
        .from('private_questions')
        .upsert(rows, { onConflict: 'upload_id,generation_slot' })
        .select('id');
      if (insertErr || !inserted) {
        throw new Error('생성된 문항을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.');
      }

      const usedIndices = new Set<number>();
      for (const q of parsed.questions) {
        for (const i of q.image_indices ?? []) if (validImageIndex(i)) usedIndices.add(i);
      }
      // key = 이 배치 안에서의 로컬 이미지 인덱스(모델이 응답한 image_indices 기준).
      const indexToPath = new Map<number, string>();
      // 이미지당 인페인팅(+검증 OCR)이 수십 초씩 걸릴 수 있어 직렬 대신 병렬로 정제·업로드.
      await Promise.all(
        [...usedIndices].map(async (i) => {
          const gi = gen.featured[i].gi;
          const display = await gen.getDisplayPng(gi);
          if (!display) return; // 텍스트 제거 실패로 제외된 이미지 — 업로드/연결 안 함
          const imgPath = `${uploadRow.user_id}/${uploadRow.id}/crops/q_image_${gi}.png`;
          const { error: upErr } = await admin.storage
            .from(STORAGE_BUCKET)
            .upload(imgPath, Buffer.from(display), {
              contentType: 'image/png',
              upsert: true,
            });
          if (upErr) warnings.push(`이미지 ${gi} Storage 저장 실패 — ${upErr.message}`);
          else indexToPath.set(i, imgPath);
        }),
      );
      const imageRows = parsed.questions.flatMap((q, qi) => {
        const qId = inserted[qi]?.id;
        if (!qId) return [];
        return (q.image_indices ?? [])
          .filter(validImageIndex)
          .map((i, order) => {
            const storagePath = indexToPath.get(i);
            if (!storagePath) return null;
            const fi = gen.featured[i];
            return {
              private_question_id: qId,
              user_id: input.userId,
              upload_id: uploadRow.id,
              storage_path: storagePath,
              source_page: fi.slide,
              kind: fi.c.region.kind,
              // 캡션(이미지 하단 작은 글자 설명)은 저장하지 않는다 — OCR 로 잡힌 주석이
              // 정답 단서로 노출되거나 UI 를 지저분하게 만들어 표시하지 않기로 함.
              caption: null,
              sort_order: order,
            };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null);
      });
      if (imageRows.length > 0) {
        const { error: imageError } = await admin
          .from('private_question_images')
          .upsert(imageRows, { onConflict: 'private_question_id,storage_path' });
        if (imageError) warnings.push(`이미지 연결 저장 실패 — ${imageError.message}`);
      }

      // 텍스트 제거 실패로 이미지가 제외된 문항 처리.
      // 발문이 그림을 가리키는(그림 없이는 못 푸는) 문항만 삭제하고, 텍스트만으로 완결된
      // 문항은 이미지 연결만 빠진 채로 살린다 — 불필요한 삭제는 요청 수 미달과
      // 보충 생성(수십 초 추가)을 유발한다.
      const orphanIds: string[] = [];
      parsed.questions.forEach((q, qi) => {
        const idx = (q.image_indices ?? []).filter(validImageIndex);
        if (idx.length === 0) return;
        if (idx.some((i) => indexToPath.has(i))) return; // 살아남은 이미지가 하나라도 있으면 유지
        const qid = inserted[qi]?.id;
        if (!qid) return;
        if (stemDependsOnImage(q.stem)) {
          orphanIds.push(qid);
        } else {
          warnings.push('이미지가 제외됐지만 발문이 텍스트만으로 완결돼 문항은 유지.');
        }
      });
      if (orphanIds.length > 0) {
        await admin.from('private_questions').delete().in('id', orphanIds);
      }
      const orphanSet = new Set(orphanIds);
      const keptIds = inserted
        .map((row) => row.id)
        .filter((id): id is string => !!id && !orphanSet.has(id));
      const keptCount = Math.max(0, rows.length - orphanIds.length);

      completedQuestions += keptCount;
      await updateProgress(
        completedQuestions < desiredCount ? 'partially_completed' : 'generating',
        completedQuestions,
        desiredCount,
        { completed_question_count: completedQuestions },
      );
      return {
        generatedCount: keptCount,
        contentSummary: parsed.content_summary,
        ids: keptIds,
        unmatched,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      };
    }

    // 선인페인팅: 인페인팅 대상 여부(다이어그램류 + 주석 텍스트)는 생성 응답 전에 알 수
    // 있으므로, 생성 호출과 병행해 미리 시작해 둔다(Promise 캐시라 중복 실행 없음).
    // 배치 완료 후 이미지 정제를 기다리던 수십 초 꼬리가 사라진다.
    // 이미지를 쓰지 않는 요청에서는 인페인팅 자체가 낭비(장당 수십 초·비용)라 건너뛴다.
    if (useImages) {
      for (const fi of featuredImages) void getDisplayPng(fi.gi);
    }

    // 배치별 이미지 배정: 같은 이미지를 여러 배치가 각자 문항으로 쓰면 "동일 이미지 최대
    // 2문제" 정리에서 초과분 문항이 삭제된다. 배치마다 겹치지 않는 이미지 묶음을 주면
    // 한 이미지를 참조하는 문항이 배치 크기(≤2) 이하로 제한돼 삭제가 발생하지 않는다.
    const featuredForBatch = (batchIndex: number, batchCount: number) => {
      if (!useImages) return [];
      if (batchCount <= 1) return featuredImages;
      // 텍스트 선발사 배치(0번)는 OCR 이전에 출발하므로 이미지를 받을 수 없다.
      // 그 경우 이미지는 1번 이후 배치들에만 분배해 어떤 이미지도 버려지지 않게 한다.
      const eligible = canPrefire
        ? Array.from({ length: batchCount - 1 }, (_, k) => k + 1)
        : Array.from({ length: batchCount }, (_, k) => k);
      const pos = eligible.indexOf(batchIndex);
      if (pos < 0) return [];
      const per = Math.ceil(featuredImages.length / eligible.length);
      // 이미지 수가 배치 수보다 적으면 뒤쪽 배치는 이미지 없이(텍스트 문항) 생성한다.
      return featuredImages.slice(pos * per, pos * per + per);
    };

    const genFor = (batchIndex: number, batchCount: number): GenContext => ({
      contextText: segmentForBatch(batchIndex, batchCount),
      featured: featuredForBatch(batchIndex, batchCount),
      getDisplayPng,
      segmented: segmentCount > 1,
    });

    const batchSettled = await mapWithConcurrency(
      batchSizes,
      GEN_CONCURRENCY,
      async (batchSize, batchIndex): Promise<BatchResult | null> => {
        const slots = Array.from(
          { length: batchSize },
          (_, k) => batchSizes.slice(0, batchIndex).reduce((sum, size) => sum + size, 0) + k,
        );
        try {
          if (batchIndex === 0 && prefired) {
            const settled = await prefired;
            if (settled.ok) return settled.v;
            // 선발사 실패(일시 오류·텍스트 컨텍스트 부족) → OCR 완료된 전체 컨텍스트로 재시도.
            // (부분 저장은 upsert(upload_id,generation_slot) + 기존 슬롯 조회로 안전하게 이어짐.)
            console.warn(
              '[private-gen] 텍스트 선발사 배치 실패 — 전체 컨텍스트로 재시도:',
              settled.e instanceof Error ? settled.e.message : String(settled.e),
            );
          }
          return await generateAndPersistBatch(
            batchIndex,
            slots,
            batchSizes.length,
            genFor(batchIndex, batchSizes.length),
          );
        } catch (e) {
          // 배치 1개 실패가 전체 생성을 실패시키지 않게 격리한다. 빈 슬롯은 아래 보충 단계가
          // 다시 채운다(이전에는 여기서 throw 되어 성공한 배치까지 'failed' 로 끝났다).
          warnings.push(
            `배치 ${batchIndex + 1} 생성 실패 — 보충 생성으로 대체 시도. ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          return null;
        }
      },
    );
    const batchResults = batchSettled.filter((r): r is BatchResult => r !== null);
    if (batchResults.length === 0) {
      throw new Error('문항 생성에 모두 실패했습니다. 잠시 후 다시 시도해주세요.');
    }
    const unmatched = batchResults.reduce((sum, result) => sum + result.unmatched, 0);

    // 동일 의료 이미지 최대 2문제: 병렬 배치라 같은 이미지가 여러 문항(2개 초과)에
    // 연결될 수 있다. 업로드 전체를 훑어 storage_path 당 문항이 2개를 넘으면 초과분의
    // 이미지 연결을 제거하고, 그 결과 이미지가 하나도 남지 않은(=이미지 판독 전용) 문항은
    // 발문이 실제 이미지 없이 이미지를 참조하게 되므로 통째로 삭제한다.
    try {
      const MAX_QUESTIONS_PER_IMAGE = 2;
      const [{ data: linkRows }, { data: slotRows }] = await Promise.all([
        admin
          .from('private_question_images')
          .select('id, private_question_id, storage_path')
          .eq('upload_id', upload.id),
        admin
          .from('private_questions')
          .select('id, generation_slot, stem')
          .eq('upload_id', upload.id),
      ]);
      const slotOf = new Map((slotRows ?? []).map((r) => [r.id, r.generation_slot ?? 0]));
      const byPath = new Map<string, { id: string; qid: string }[]>();
      for (const r of linkRows ?? []) {
        const arr = byPath.get(r.storage_path) ?? [];
        arr.push({ id: r.id, qid: r.private_question_id });
        byPath.set(r.storage_path, arr);
      }
      const removeLinkIds: string[] = [];
      for (const [, arr] of byPath) {
        // 오래된(먼저 생성된) 문항 우선 유지 — generation_slot 순.
        arr.sort((a, b) => (slotOf.get(a.qid) ?? 0) - (slotOf.get(b.qid) ?? 0));
        const keptQ = new Set<string>();
        for (const r of arr) {
          if (keptQ.size < MAX_QUESTIONS_PER_IMAGE || keptQ.has(r.qid)) keptQ.add(r.qid);
          else removeLinkIds.push(r.id);
        }
      }
      if (removeLinkIds.length > 0) {
        const removedSet = new Set(removeLinkIds);
        await admin.from('private_question_images').delete().in('id', removeLinkIds);
        // 링크 제거 후 이미지가 하나도 남지 않은 문항 = 삭제 대상.
        const remainingByQ = new Map<string, number>();
        for (const r of linkRows ?? []) {
          if (removedSet.has(r.id)) continue;
          remainingByQ.set(
            r.private_question_id,
            (remainingByQ.get(r.private_question_id) ?? 0) + 1,
          );
        }
        const affectedQ = new Set(
          (linkRows ?? []).filter((r) => removedSet.has(r.id)).map((r) => r.private_question_id),
        );
        // 링크가 모두 제거된 문항 중, 발문이 그림을 가리키는 것만 삭제한다.
        // (텍스트만으로 완결된 문항은 살려 요청 수 미달과 보충 생성을 피한다.)
        const stemOf = new Map((slotRows ?? []).map((r) => [r.id, r.stem ?? '']));
        const orphanQ = [...affectedQ]
          .filter((qid) => (remainingByQ.get(qid) ?? 0) === 0)
          .filter((qid) => stemDependsOnImage(stemOf.get(qid) ?? ''));
        if (orphanQ.length > 0) {
          await admin.from('private_questions').delete().in('id', orphanQ);
        }
      }
    } catch (cleanupErr) {
      warnings.push(
        `이미지 재사용 정리 실패 — ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      );
    }

    // ── 부족분 보충: 요청 수를 반드시 채운다.
    // 실제 저장 결과를 DB 에서 다시 읽어(누적 산술이 아니라 사실 기준) 빈 슬롯을 확인하고,
    // 남은 슬롯을 "이미지 없는 텍스트 문항"으로 다시 생성한다. 이미지를 주지 않으므로
    // 인페인팅 탈락·이미지 재사용 정리로 또 삭제되는 일이 없다.
    // 부족 원인: 모델이 요청 수보다 적게 반환 / 이미지 문항 삭제 / 배치 실패.
    const readSaved = async () => {
      const { data } = await admin
        .from('private_questions')
        .select('id, generation_slot')
        .eq('upload_id', uploadRow.id)
        .order('generation_slot', { ascending: true });
      return data ?? [];
    };

    /**
     * 보충 배치용 축약 컨텍스트. 빈 슬롯이 원래 속해 있던 구간(= 그 슬롯을 맡았던 배치의
     * 자료 구간)을 중심으로 잘라, 주제 다양성은 유지하면서 입력을 크게 줄인다.
     * 자료가 짧으면 그대로 전체를 쓴다.
     */
    const backfillContext = (slot: number): string => {
      if (compositeText.length <= GEN_BACKFILL_CONTEXT_CHARS) return compositeText;
      // 빈 슬롯을 원래 맡았던 배치와 같은 구간을 준다(본 배치와 동일한 분할 로직 재사용).
      const batchIndex = Math.min(
        batchSizes.length - 1,
        Math.floor((slot / Math.max(1, desiredCount)) * batchSizes.length),
      );
      const segment = segmentForBatch(batchIndex, batchSizes.length);
      return segment.length <= GEN_BACKFILL_CONTEXT_CHARS
        ? segment
        : sliceByChars(segment, 0, 1, GEN_BACKFILL_CONTEXT_CHARS).slice(
            0,
            GEN_BACKFILL_CONTEXT_CHARS,
          );
    };
    let saved = await readSaved();
    // 진행률 기준도 DB 사실값으로 맞춘다(삭제된 문항까지 세어 100%를 넘기지 않게).
    completedQuestions = saved.length;
    for (let round = 0; round < GEN_BACKFILL_ROUNDS && saved.length < desiredCount; round++) {
      const usedSlots = new Set(saved.map((r) => r.generation_slot));
      const missingSlots = Array.from({ length: desiredCount }, (_, s) => s).filter(
        (s) => !usedSlots.has(s),
      );
      if (missingSlots.length === 0) break;
      warnings.push(
        `보충 생성 ${round + 1}회차: ${saved.length}/${desiredCount} → 부족 ${missingSlots.length}문항 재생성.`,
      );
      const fillBatches: number[][] = [];
      for (let i = 0; i < missingSlots.length; i += GEN_BATCH_MAX_QUESTIONS) {
        fillBatches.push(missingSlots.slice(i, i + GEN_BATCH_MAX_QUESTIONS));
      }
      await mapWithConcurrency(fillBatches, GEN_CONCURRENCY, async (slots, i) => {
        try {
          await generateAndPersistBatch(i, slots, fillBatches.length, {
            // 보충은 "빠르게 빈 칸만 채우는" 호출이다. 본 배치들이 방금 끝난 직후라
            // 같은 대용량 컨텍스트를 다시 실으면 입력 처리량이 커져 429 를 맞고,
            // 기본 백오프(최대 45초)를 기다리며 전체 소요를 지배한다(실측 66초 꼬리).
            // → 빈 슬롯이 속한 구간의 컨텍스트만 잘라 싣고, 재시도 대기도 짧게 잡는다.
            contextText: backfillContext(slots[0]),
            featured: [], // 텍스트 전용 — 이미지 관련 삭제 경로를 원천 차단
            getDisplayPng: async () => null,
            retryMaxDelayMs: 6_000,
          });
        } catch (e) {
          warnings.push(
            `보충 배치 실패 — ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return null;
      });
      saved = await readSaved();
    }
    if (saved.length < desiredCount) {
      warnings.push(`최종 ${saved.length}/${desiredCount}문항 — 요청 수를 채우지 못했습니다.`);
    }
    const generatedCount = saved.length;
    const insertedIds = saved.map((r) => r.id);
    completedQuestions = generatedCount;
    const contentSummary = batchResults.map((result) => result.contentSummary).find(Boolean) ?? '';
    const cacheReadTokens = batchResults.reduce((sum, result) => sum + result.cacheReadTokens, 0);
    const cacheCreationTokens = batchResults.reduce(
      (sum, result) => sum + result.cacheCreationTokens,
      0,
    );

    const titleTrim = input.title?.trim();
    await admin
      .from('user_uploads')
      .update({
        status: 'completed',
        processing_stage: 'completed',
        progress_current: generatedCount,
        progress_total: desiredCount,
        completed_question_count: generatedCount,
        target_question_count: desiredCount,
        heartbeat_at: new Date().toISOString(),
        processed_at: new Date().toISOString(),
        extracted_text: contentSummary.slice(0, 2000),
        error_message: null,
        // 사용자가 지정한 문제집 이름이 있으면 세트 표시명으로 저장.
        ...(titleTrim ? { file_name: titleTrim } : {}),
      })
      .eq('id', upload.id);

    if (warnings.length > 0) {
      // 업로드 자체는 private 자료라 본문은 남기지 말고 메타만 기록.
      console.warn(
        `[private-gen] uploadId=${upload.id} warnings=${warnings.length}`,
      );
    }

    return {
      generatedCount,
      privateQuestionIds: insertedIds,
      contentSummary,
      unmatched,
      usage: {
        model: modelUsed,
        inputTokens: aggInputTokens,
        outputTokens: aggOutputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUSD: totalCost,
        durationMs: Date.now() - startTime,
      },
      extractStats: {
        pages: slides.length,
        croppedImages: totalCropped,
        ocrChars,
      },
    };
  } catch (error) {
    await admin
      .from('user_uploads')
      .update({
        status: 'failed',
        processing_stage: 'failed',
        heartbeat_at: new Date().toISOString(),
        error_message: sanitizeErrorMessage(error),
      })
      .eq('id', upload.id);
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}

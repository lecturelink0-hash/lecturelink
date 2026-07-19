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
const MAX_FEATURED_IMAGES = 15;    // 선별 후 생성에 투입하는 이미지 상한(내용에 따라 가변, 최대 15)
const MAX_EMBEDDED_CANDIDATES = 40; // AI 선별에 넣을 후보(추출) 상한
const VISION_CONCURRENCY = 6;      // 페이지 vision/OCR 동시 처리 수 — 순차 대비 대용량 대폭 가속

/**
 * items 를 최대 `limit` 개씩 동시에 처리하고, 입력 순서를 보존한 결과 배열을 반환한다.
 * 페이지별 Vision/OCR 호출을 병렬로 돌려 다중 페이지(스캔) 자료의 처리 시간을 단축한다.
 * 개별 작업의 예외는 fn 내부에서 처리(여기선 rethrow 안 함) — 한 페이지 실패가 전체를 막지 않게.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
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

export interface PrivateGenerationInput {
  uploadId: string;
  userId: string;
  desiredCount?: number;
  style?: 'kmle' | 'professor' | 'internal';
  /** 사용자 지정 난이도(하/중/상) — 생성 프롬프트에 반영. */
  difficulty?: '하' | '중' | '상';
  /** 사용자 지정 문항 유형 — 생성 프롬프트에 반영. */
  questionType?: '지식형' | '임상형' | '이미지형';
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

    // (1) 본문 텍스트 — 실패해도 이미지 경로는 계속 진행.
    let fullText = '';
    try {
      const { default: pdfParse } = await import('pdf-parse');
      const result = await pdfParse(Buffer.from(pdfBuffer));
      fullText = (result.text ?? '').trim();
      allowWholePageOcrFallback = fullText.length < 1500;
    } catch (e) {
      warnings.push(
        `PDF 본문 텍스트 추출 실패 — 페이지 이미지만 사용. ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    // (1-b) PDF 에 박힌 이미지 전부 직접 추출(object dedup) → AI 로 "시험용 의료 이미지"만 선별.
    //       텍스트 양과 무관하게 항상 수행 → 텍스트 위주 강의 PDF 에서도 X-ray/ECG 판독 문항 생성.
    try {
      const candidates = await extractEmbeddedPdfImages(Buffer.from(pdfBuffer), {
        maxImages: MAX_EMBEDDED_CANDIDATES,
        maxOutEdgePx: 1024,
      });
      if (candidates.length > 0) {
        // AI 선별: 로고·장식·표지·순수 도표 제외, 판독 가치 있는 의료 이미지만(개수는 내용에 따라 가변).
        const selected = await selectExamImages(candidates, { max: MAX_FEATURED_IMAGES });
        const chosen =
          selected ??
          // 선별 실패(모델 오류/429) 시 면적 큰 순 폴백.
          candidates
            .slice(0, MAX_FEATURED_IMAGES)
            .map((im) => ({ image: im, kind: 'other' as const }));
        if (chosen.length > 0) {
          pdfEmbeddedCrops = chosen.map(({ image, kind }) => ({
            region: { kind, x: 0, y: 0, width: 1, height: 1, confidence: 1 },
            png: image.png,
            widthPx: image.widthPx,
            heightPx: image.heightPx,
          }));
        }
        warnings.push(
          `임베드 이미지 ${candidates.length}개 추출 → 선별 ${chosen.length}개 사용${selected ? '' : '(선별 실패·폴백)'}.`,
        );
      }
    } catch (e) {
      warnings.push(
        `임베드 이미지 추출/선별 실패 — Vision 경로로 폴백. ${e instanceof Error ? e.message : String(e)}`,
      );
    }

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
        pages = await renderPdfPages(pdfBuffer, {
          maxPages: MAX_PDF_PAGES,
          maxEdgePx: PDF_RENDER_EDGE_PX,
        });
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
        text: i === 0 ? fullText.slice(0, 40_000) : '',
        png: p.png,
      }));
    } else {
      // 렌더 실패 폴백: 텍스트만 (이미지 단계는 png.length === 0 으로 자동 skip).
      if (!fullText) {
        warnings.push(
          'PDF 에서 텍스트·이미지를 모두 추출하지 못했습니다. 스캔 품질/파일 상태를 확인하세요.',
        );
      }
      slidesData = [{ pageIndex: 1, text: fullText.slice(0, 40_000), png: new Uint8Array() }];
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
  await mapWithConcurrency(visionIndices, VISION_CONCURRENCY, async (idx) => {
    const s = slidesData[idx];
    try {
      const det = await detectMedicalRegions({ slidePng: s.png, userIdForLog });
      // fallback: 의료 이미지 검출 0건인 페이지는 페이지 전체를 region 으로 잡아
      // OCR/Claude 가 슬라이드 텍스트·도표를 볼 수 있게 한다.
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
          const png = await preprocessForOcr(c.png, {
            grayscale: c.region.kind === 'ecg' || c.region.kind === 'xray',
            normalizeContrast: true,
          });
          preprocessed.push({ ...c, png });
        } catch (e) {
          warnings.push(
            `slide ${s.pageIndex}: 전처리 실패 — ${e instanceof Error ? e.message : String(e)}`,
          );
          preprocessed.push(c); // 원본 그대로 진행
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
  });

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

  await admin
    .from('user_uploads')
    .update({ status: 'processing' })
    .eq('id', upload.id);

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

    // 3) 추출 (페이지 텍스트 + crop 이미지)
    const { slides, warnings } = await extractFromBuffer({
      buffer: fileBuffer,
      fileType: upload.file_type,
      userIdForLog: input.userId,
    });
    const referenceImages = await loadReferenceImages({
      uploadIds: input.referenceUploadIds ?? [],
      userId: input.userId,
    });

    // 4) crop 이미지 OCR — 페이지 단위로 병렬 처리(대용량 스캔 가속). 순서는 보존.
    let ocrChars = 0;
    let totalCropped = 0;
    const slideSummaries = await mapWithConcurrency(
      slides,
      VISION_CONCURRENCY,
      async (s) => {
        const ocrTexts: string[] = [];
        for (const c of s.croppedImages) {
          try {
            const r = await runOcr({
              png: c.png,
              userIdForLog: input.userId,
              context: s.text,
            });
            // 단일 동기 문장 += 는 JS 이벤트루프 상 원자적이라 병렬 누적에 안전.
            totalCost += r.costUsd;
            ocrChars += r.text.length;
            if (r.text) ocrTexts.push(`[${c.region.kind}] ${r.text}`);
          } catch (e) {
            warnings.push(
              `slide ${s.pageIndex}: OCR 실패 — ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        return {
          pageIndex: s.pageIndex,
          slideText: s.text,
          ocrTexts,
          cropCount: s.croppedImages.length,
        };
      },
    );
    totalCropped = slides.reduce((n, s) => n + s.croppedImages.length, 0);

    // 4.5) 추출 결과가 전부 비어 있으면 Claude 호출은 의미 없음 → 명확한 실패 메시지.
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

    // 5) Sub_topic 카탈로그
    const { data: subTopics } = await admin
      .from('sub_topics')
      .select('id, code, name, subject:subjects ( name )');

    type CatalogRow = {
      id: string;
      code: string;
      name: string;
      subject: { name: string } | { name: string }[] | null;
    };
    const catalog = (subTopics ?? []).map((row) => {
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

    // 7) Claude 호출 — 문항 생성
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
    const typeDirective =
      input.questionType === '지식형'
        ? '**지식형**: 개념·정의·기전을 확인하는 단답/개념 확인 문항 위주로 만든다(긴 증례보다 핵심 지식).'
        : input.questionType === '임상형'
          ? '**임상형**: 실제 환자 증례(vignette: 나이/증상/검사)를 제시하고 진단·처치·판단을 묻는 임상 문항 위주로 만든다.'
          : input.questionType === '이미지형'
            ? '**이미지형**: 자료의 의료 이미지를 판독·해석해야 푸는 문항을 **가능한 한 많이** 만든다(이미지가 있으면 우선).'
            : '';
    if (diffDirective || typeDirective) {
      systemPrompt += `\n\n## 사용자 지정 출제 조건\n${[diffDirective, typeDirective].filter(Boolean).join('\n')}`;
    }
    const userMessage = buildPrivateGenerationUserMessage({
      subTopicCatalog: catalog,
      desiredCount,
      style,
    });

    const client = getAnthropic();
    modelUsed = MODELS.generation();

    // crop 된 의료 이미지 — Claude 에 인덱스 라벨과 함께 제시.
    // Storage 업로드는 생성 응답에서 실제 사용된 이미지만 골라 나중에 수행한다 (고아·비용 방지).
    const featuredImages = slides
      .flatMap((s) => s.croppedImages.map((c) => ({ slide: s.pageIndex, c })))
      .slice(0, MAX_FEATURED_IMAGES);

    // Claude 입력: [이미지 N] 라벨 + 이미지를 인덱스 순서로 넣고, 마지막에 텍스트 컨텍스트.
    // 라벨 덕분에 Claude 가 각 이미지를 image_indices 로 참조할 수 있다.
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
    for (let i = 0; i < featuredImages.length; i++) {
      userContent.push({ type: 'text', text: `[이미지 ${i}] (필수 자료에서 커팅)` });
      userContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from(featuredImages[i].c.png).toString('base64'),
        },
      } as Anthropic.ImageBlockParam);
    }
    userContent.push({
      type: 'text',
      text:
        `다음은 필수 업로드 자료에서 추출한 출제 근거입니다. 기출 형식 참고 자료의 의학 내용은 사용하지 말고, 아래 내용과 필수 자료 이미지만으로 문항을 만드세요.\n\n` +
        (compositeText || '(추출된 텍스트·이미지 없음)') +
        `\n\n${userMessage}`,
    });

    const response = await withRetry(() =>
      createMessage(client, {
        model: modelUsed,
        max_tokens: 16000,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [PRIVATE_GENERATION_TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: 'generate_private_questions' },
        messages: [{ role: 'user', content: userContent }],
      }),
    );

    const toolUseBlock = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );
    if (!toolUseBlock) {
      throw new Error('Claude 응답에 tool_use 블록이 없음');
    }

    const parsed = toolUseBlock.input as {
      questions: Array<{
        stem: string;
        choices: string[];
        answer_index: number;
        explanation: string;
        concepts: string[];
        difficulty: 1 | 2 | 3;
        image_indices: number[];
        sub_topic_code: string | null;
      }>;
      content_summary: string;
    };

    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      throw new Error(
        `Claude 생성 응답 파싱 실패: questions 배열 아님 (stop_reason=${response.stop_reason}, 응답이 max_tokens 로 잘렸을 수 있음)`,
      );
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
        uploadId: upload.id,
        slides: slides.length,
        croppedImages: totalCropped,
        ocrChars,
      },
    });

    // 8) DB 저장
    let unmatched = 0;
    const rows = parsed.questions.map((q) => {
      const subTopicId = q.sub_topic_code
        ? codeToId.get(q.sub_topic_code) ?? null
        : null;
      if (!subTopicId) unmatched += 1;
      return {
        user_id: input.userId,
        upload_id: upload.id,
        sub_topic_id: subTopicId,
        stem: q.stem,
        choices: q.choices,
        answer_index: q.answer_index,
        explanation: q.explanation,
        concepts: q.concepts ?? [],
        difficulty: q.difficulty,
      };
    });

    // 생성 결과가 0개면 사용자에게 의미 있는 실패 메시지를 남긴다.
    if (rows.length === 0) {
      throw new Error(
        '자료에서 문항을 생성하지 못했습니다. 자료의 길이/품질을 확인하거나 다른 자료를 시도해주세요.',
      );
    }

    const { data: inserted, error: insertErr } = await admin
      .from('private_questions')
      .insert(rows)
      .select('id');
    if (insertErr) {
      // 내부 supabase 에러 코드는 사용자에 노출하지 않음.
      throw new Error('생성된 문항을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.');
    }

    // 8-2) 의료 이미지 연결.
    //      inserted[idx] 는 parsed.questions[idx] 와 순서 동일 (Postgres INSERT RETURNING 보장).
    const validIndex = (i: number) => i >= 0 && i < featuredImages.length;

    // 실제 사용된 이미지 인덱스만 모아(중복 제거) Storage 에 업로드 — 미사용 crop 은 올리지 않음.
    const usedIndices = new Set<number>();
    for (const q of parsed.questions) {
      for (const i of q.image_indices ?? []) {
        if (validIndex(i)) usedIndices.add(i);
      }
    }

    const indexToPath = new Map<number, string>();
    for (const i of usedIndices) {
      const imgPath = `${upload.user_id}/${upload.id}/crops/q_image_${i}.png`;
      const { error: upErr } = await admin.storage
        .from(STORAGE_BUCKET)
        .upload(imgPath, Buffer.from(featuredImages[i].c.png), {
          contentType: 'image/png',
          upsert: true,
        });
      if (upErr) {
        warnings.push(`이미지 ${i} Storage 저장 실패 — ${upErr.message}`);
      } else {
        indexToPath.set(i, imgPath);
      }
    }

    // 각 문항의 image_indices → private_question_images 행들 (sort_order 로 순서 보존).
    const imageRows = parsed.questions.flatMap((q, qi) => {
      const qId = inserted?.[qi]?.id;
      if (!qId) return [];
      return (q.image_indices ?? [])
        .filter(validIndex)
        .map((i, order) => {
          const path = indexToPath.get(i);
          if (!path) return null;
          const fi = featuredImages[i];
          return {
            private_question_id: qId,
            user_id: input.userId,
            upload_id: upload.id,
            storage_path: path,
            source_page: fi.slide,
            kind: fi.c.region.kind,
            caption: fi.c.region.caption ?? null,
            sort_order: order,
          };
        })
        .filter((r): r is NonNullable<typeof r> => r !== null);
    });

    if (imageRows.length > 0) {
      const { error: imgErr } = await admin
        .from('private_question_images')
        .insert(imageRows);
      if (imgErr) {
        warnings.push(`이미지 연결 저장 실패 — ${imgErr.message}`);
      }
    }

    const titleTrim = input.title?.trim();
    await admin
      .from('user_uploads')
      .update({
        status: 'completed',
        processed_at: new Date().toISOString(),
        extracted_text: parsed.content_summary.slice(0, 2000),
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
      generatedCount: parsed.questions.length,
      privateQuestionIds: (inserted ?? []).map((r) => r.id),
      contentSummary: parsed.content_summary,
      unmatched,
      usage: {
        model: modelUsed,
        inputTokens: aggInputTokens,
        outputTokens: aggOutputTokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
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
        error_message: sanitizeErrorMessage(error),
      })
      .eq('id', upload.id);
    throw error;
  }
}

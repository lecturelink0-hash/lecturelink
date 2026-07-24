/**
 * 슬라이드/페이지 → 이미지(PNG) 렌더링.
 *
 * 입력 두 가지:
 *   - PDF 파일 (이미 ArrayBuffer 로 로드됨) → pdfjs-dist + @napi-rs/canvas 로 페이지별 PNG
 *   - PPTX 는 ppt/media 임베드 이미지를 우선 사용. 슬라이드 자체 렌더링은
 *     LibreOffice 변환이 필요해 별도 워커에서 수행 (이 함수에선 직접 호출하지 않음).
 *
 * 출력: { pageIndex, png: Uint8Array, widthPx, heightPx }[]
 *
 * 환경:
 *   - serverless: @napi-rs/canvas 가 Vercel 에서 동작하나 cold start 시 80MB 의존성. 큐 워커 권장.
 *   - 로컬: 그대로 작동.
 */

import { resolve } from 'node:path';

// pdfjs 3.x 를 Node 환경에서 쓸 때 worker 경로 설정.
// 3.x 는 worker 를 require() 로 로드하므로 file:// URL 이 아니라 absolute path 가 필요.
// (5.x 때 file:// URL 로 줬다가 "Cannot find module 'file:///...'" 에러로 회귀)
// 이 lib 은 server-only 코드(API route 에서만 호출)라 정적 import 로 안전하다.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';

const PDF_WORKER_PATH = resolve(
  process.cwd(),
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.js',
);
(pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } })
  .GlobalWorkerOptions.workerSrc = PDF_WORKER_PATH;

export interface RenderedPage {
  pageIndex: number;
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
}

export interface RenderOptions {
  /** 페이지 당 긴 변 픽셀. 기본 1600. */
  maxEdgePx?: number;
  /** 렌더할 페이지 인덱스 목록. undefined 면 전체(단 maxPages 까지). */
  pages?: number[];
  /** 처리할 최대 페이지 수 (Vision/OCR 비용 폭증 방지). 기본 50. */
  maxPages?: number;
}

export interface ExtractedPdfTextPage {
  pageIndex: number;
  text: string;
}

/** PDF 텍스트를 실제 페이지 경계대로 추출한다. */
export async function extractPdfTextPages(
  pdfBuffer: ArrayBuffer,
  maxPages = 200,
): Promise<ExtractedPdfTextPage[]> {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    cMapUrl: resolve(process.cwd(), 'node_modules/pdfjs-dist/cmaps') + '/',
    cMapPacked: true,
    standardFontDataUrl:
      resolve(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts') + '/',
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
  });
  const doc = await loadingTask.promise;
  const pages: ExtractedPdfTextPage[] = [];
  try {
    const count = Math.min(doc.numPages, maxPages);
    for (let pageIndex = 1; pageIndex <= count; pageIndex += 1) {
      const page = await doc.getPage(pageIndex);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      pages.push({ pageIndex, text });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

const DEFAULT_MAX_EDGE = 1600;
const DEFAULT_MAX_PAGES = 50;

/**
 * PDF ArrayBuffer 를 받아 페이지별 PNG 산출.
 *
 * 주의: pdfjs-dist 의 worker 는 Node 에서 false 로 설정해야 함.
 */
export async function renderPdfPages(
  pdfBuffer: ArrayBuffer,
  options: RenderOptions = {},
): Promise<RenderedPage[]> {
  const maxEdge = options.maxEdgePx ?? DEFAULT_MAX_EDGE;

  // pdfjsLib 는 파일 상단에서 정적 import + workerSrc 설정 완료.
  // canvas 백엔드는 node-canvas(cairo). @napi-rs/canvas 는 pdfjs 와 함께 쓰면
  // serverless/제약 환경에서 native crash(SIGSEGV) 또는 napi "CanvasElement unwrap"
  // 에러를 일으켜 폐기. node-canvas 는 pdfjs 공식 예제가 쓰는 조합으로 안정적이며,
  // Docker(cairo 설치)에서 동작한다.
  const { createCanvas } = await import('canvas');

  // 한국어/한자 PDF 처리를 위해 cMap + 표준 폰트 데이터 경로 명시.
  // 누락 시 pdfjs 가 외부 fetch 를 시도하다 폰트 처리 단계에서 canvas native crash 를 일으킨다.
  const CMAP_URL = resolve(process.cwd(), 'node_modules/pdfjs-dist/cmaps') + '/';
  const STANDARD_FONTS_URL =
    resolve(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts') + '/';

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONTS_URL,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
    // Node + node-canvas 환경: pdfjs 가 OffscreenCanvas/ImageBitmap 경로를 타면
    // node-canvas 의 drawImage 와 충돌("TypeError: Image or Canvas expected")한다.
    // OffscreenCanvas 를 비활성화해 일반 canvas 경로만 쓰게 강제.
    isOffscreenCanvasSupported: false,
  });

  const doc = await loadingTask.promise;
  const numPages = doc.numPages;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  // 페이지 목록 결정 + maxPages 제한 (비용 폭증 방지).
  const rawPages = options.pages ?? Array.from({ length: numPages }, (_, i) => i + 1);
  const targetPages = rawPages
    .filter((p) => p >= 1 && p <= numPages)
    .slice(0, maxPages);

  const out: RenderedPage[] = [];

  for (const pageNum of targetPages) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1 });
    const longEdge = Math.max(viewport.width, viewport.height);
    const scale = maxEdge / longEdge;
    const scaled = page.getViewport({ scale });

    const canvas = createCanvas(
      Math.ceil(scaled.width),
      Math.ceil(scaled.height),
    );
    const ctx = canvas.getContext('2d');

    await page.render({
      // @ts-expect-error pdfjs Node canvas 호환
      canvasContext: ctx,
      viewport: scaled,
    }).promise;

    const png = canvas.toBuffer('image/png');
    out.push({
      pageIndex: pageNum,
      png: new Uint8Array(png),
      widthPx: canvas.width,
      heightPx: canvas.height,
    });

    page.cleanup();
  }

  await doc.destroy();
  return out;
}

/**
 * PPTX → 슬라이드 PNG 렌더.
 *
 * MVP 전략: LibreOffice headless 가 PPTX→PDF 변환에 가장 안정적.
 * 큐 워커가 `soffice --headless --convert-to pdf` 호출 후 결과 PDF 를 renderPdfPages 로.
 *
 * 이 함수는 직접 LibreOffice 를 부르지 않고, **변환된 PDF 가 이미 있다는 가정**에서
 * renderPdfPages 로 위임. 큐 워커 컨텍스트에서 사용.
 */
export async function renderPptxPages(
  convertedPdfBuffer: ArrayBuffer,
  options: RenderOptions = {},
): Promise<RenderedPage[]> {
  return renderPdfPages(convertedPdfBuffer, options);
}

/**
 * LibreOffice headless 변환 헬퍼 (개발/큐 워커용).
 *
 * - LibreOffice 가 없으면 throw — 호출자가 try/catch 로 fallback 결정.
 * - shell injection 방지를 위해 `execFile` 사용 (`exec` 와 달리 shell 을 거치지 않음).
 * - 바이너리 경로는 `LIBREOFFICE_BIN` env 우선, 없으면 `soffice` (PATH).
 */
export async function convertPptxToPdf(
  inputPath: string,
  outputDir: string,
): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const binary = process.env.LIBREOFFICE_BIN || 'soffice';

  // 호출마다 LibreOffice 사용자 프로필을 격리한다. 공용 프로필(~/.config/libreoffice)
  // 을 공유하면 동시 변환 시 프로필 락 충돌로 "another instance" 에러가 난다.
  const profileUrl = `file://${resolve(outputDir, 'lo-profile')}`;

  await execFileAsync(
    binary,
    [
      `-env:UserInstallation=${profileUrl}`,
      '--headless',
      '--convert-to',
      'pdf',
      '--outdir',
      outputDir,
      inputPath,
    ],
    { timeout: 120_000 },
  );

  const path = await import('node:path');
  // soffice 는 basename 의 확장자만 .pdf 로 바꿔 출력한다.
  // .pptx / .ppt 등 어떤 확장자든 대응하도록 마지막 확장자를 .pdf 로 치환.
  const base = path.basename(inputPath).replace(/\.[^.]+$/, '.pdf');
  return resolve(outputDir, base);
}

/**
 * LibreOffice 사용 가능 여부를 빠르게 점검.
 *
 * - `LIBREOFFICE_BIN` 또는 `soffice --version` 호출 가능 여부로 판단.
 * - 실패 시 false 반환 (throw 안 함). 환경 없는 컨테이너에서도 호출 안전.
 */
export async function isLibreOfficeAvailable(): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const binary = process.env.LIBREOFFICE_BIN || 'soffice';
    await execFileAsync(binary, ['--version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

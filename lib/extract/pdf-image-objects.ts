/**
 * PDF 에 박혀 있는 이미지 객체를 pdfjs 로 직접 추출한다.
 *
 * 왜 필요한가
 * ─────────
 * 기존 임베드 추출은 외부 바이너리 `mutool`(mupdf-tools)에 의존하는데, 진단 결과
 * 프로덕션(Vercel)에는 그 바이너리가 없다(`ENOENT: spawn mutool ENOENT`, 매 실행 약 1초 낭비).
 * 그래서 이미지가 있는 모든 PDF 가 비싼 폴백 경로로 떨어졌다 —
 * 전체 페이지 저해상 렌더(2.9~3.1초) → 로컬 후보 선별 → 후보 고해상 렌더(5.4초) →
 * 페이지마다 Vision 호출(25페이지 19.1초). 실측 기준 전처리의 대부분이 여기였다.
 *
 * pdfjs 는 이미 렌더링에 쓰고 있으므로 추가 의존성 없이 같은 문서에서 이미지 객체를
 * 꺼낼 수 있다. 이 경로가 성공하면 렌더·Vision 을 통째로 건너뛴다.
 */

import { resolve } from 'node:path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';

const PDF_WORKER_PATH = resolve(
  process.cwd(),
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.js',
);
(pdfjsLib as unknown as { GlobalWorkerOptions: { workerSrc: string } })
  .GlobalWorkerOptions.workerSrc = PDF_WORKER_PATH;

export interface PdfImageObject {
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
  /** 1-based 페이지 번호(출처 표시·정렬용). */
  pageIndex: number;
}

export interface ExtractImageObjectsOptions {
  /** 짧은 변이 이 값보다 작으면 아이콘·장식으로 보고 버린다. 기본 300px. */
  minEdgePx?: number;
  /** 반환 최대 개수(면적 큰 순). 기본 12. */
  maxImages?: number;
  /** 출력 이미지 긴 변 상한(다운스케일). 기본 1024px. */
  maxOutEdgePx?: number;
  /** 훑을 최대 페이지 수. 기본 100. */
  maxPages?: number;
  /** 진단 수집기(선택). */
  diag?: {
    pagesScanned?: number;
    objectsFound?: number;
    kept?: number;
    ms?: number;
    error?: string;
  };
}

/** pdfjs 이미지 객체 → RGBA 픽셀 버퍼로 정규화. 지원 못 하는 형식은 null. */
function toRgba(
  img: { width: number; height: number; kind?: number; data?: Uint8ClampedArray | Uint8Array },
): { width: number; height: number; rgba: Uint8ClampedArray } | null {
  const { width, height, data } = img;
  if (!width || !height || !data) return null;
  const px = width * height;
  const out = new Uint8ClampedArray(px * 4);
  // pdfjs ImageKind: 1 = GRAYSCALE_1BPP, 2 = RGB_24BPP, 3 = RGBA_32BPP
  if (data.length === px * 4) {
    out.set(data.subarray(0, px * 4));
    return { width, height, rgba: out };
  }
  if (data.length === px * 3) {
    for (let i = 0, o = 0; i < px; i++, o += 3) {
      out[i * 4] = data[o];
      out[i * 4 + 1] = data[o + 1];
      out[i * 4 + 2] = data[o + 2];
      out[i * 4 + 3] = 255;
    }
    return { width, height, rgba: out };
  }
  if (data.length === px) {
    for (let i = 0; i < px; i++) {
      const v = data[i];
      out[i * 4] = v;
      out[i * 4 + 1] = v;
      out[i * 4 + 2] = v;
      out[i * 4 + 3] = 255;
    }
    return { width, height, rgba: out };
  }
  return null;
}

/**
 * 중복 판정 서명: 크기 + 픽셀 서브샘플(최대 4096포인트) FNV-1a 해시.
 * 종전 "가로x세로"만으로는 같은 크기의 서로 다른 이미지(슬라이드 템플릿의 동일
 * 플레이스홀더에 배치된 사진들)까지 오폐기해 문항 이미지 후보가 줄었다.
 * 데이터가 없으면 크기만으로 폴백.
 */
function contentSignature(img: {
  width: number;
  height: number;
  data?: Uint8ClampedArray | Uint8Array;
}): string {
  const dims = `${img.width}x${img.height}`;
  const d = img.data;
  if (!d || d.length === 0) return dims;
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(d.length / 4096));
  for (let i = 0; i < d.length; i += step) {
    h ^= d[i];
    h = Math.imul(h, 0x01000193);
  }
  return `${dims}:${(h >>> 0).toString(16)}`;
}

/**
 * PDF 안의 이미지 객체를 추출한다. 실패하면 빈 배열(호출자는 기존 렌더+Vision 경로로 폴백).
 * 같은 이미지가 여러 페이지에 반복되면(워터마크·템플릿) 내용 서명 기준으로 중복을 제거한다.
 */
export async function extractPdfImageObjects(
  pdfData: ArrayBuffer,
  opts: ExtractImageObjectsOptions = {},
): Promise<PdfImageObject[]> {
  const minEdge = opts.minEdgePx ?? 300;
  const maxImages = opts.maxImages ?? 12;
  const maxOutEdge = opts.maxOutEdgePx ?? 1024;
  const maxPages = opts.maxPages ?? 100;
  const diag = opts.diag;
  const startedAt = Date.now();

  try {
    const { createCanvas } = await import('canvas');
    const doc = await pdfjsLib.getDocument({
      data: new Uint8Array(pdfData.slice(0)),
      isEvalSupported: false,
    }).promise;

    const pageCount = Math.min(doc.numPages, maxPages);
    const found: (PdfImageObject & { area: number; sig: string })[] = [];
    const seen = new Set<string>();

    for (let n = 1; n <= pageCount; n++) {
      const page = await doc.getPage(n);
      const ops = await page.getOperatorList();
      const names = new Set<string>();
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        // pdfjs 버전에 따라 paintJpegXObject 가 없을 수 있어 이름으로 조회한다.
        const OPS = pdfjsLib.OPS as unknown as Record<string, number>;
        if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject) {
          const name = ops.argsArray[i]?.[0];
          if (typeof name === 'string') names.add(name);
        }
      }
      for (const name of names) {
        try {
          // objs.get 은 콜백형 — 준비되지 않았으면 대기한다.
          const raw: unknown = await new Promise((res, rej) => {
            try {
              (page.objs as { get: (k: string, cb: (v: unknown) => void) => void }).get(
                name,
                (v) => res(v),
              );
            } catch (e) {
              rej(e);
            }
          });
          const img = raw as { width: number; height: number; data?: Uint8ClampedArray };
          if (!img?.width || !img?.height) continue;
          if (Math.min(img.width, img.height) < minEdge) continue;

          const sig = contentSignature(img);
          if (seen.has(sig)) continue; // 반복 삽입된 동일 이미지(워터마크·템플릿) 제거
          const rgba = toRgba(img);
          if (!rgba) continue;
          seen.add(sig);

          // 원본 → 캔버스 → 다운스케일 → PNG
          const src = createCanvas(rgba.width, rgba.height);
          const sctx = src.getContext('2d');
          const imageData = sctx.createImageData(rgba.width, rgba.height);
          imageData.data.set(rgba.rgba);
          sctx.putImageData(imageData, 0, 0);

          const scale = Math.min(1, maxOutEdge / Math.max(rgba.width, rgba.height));
          const ow = Math.max(1, Math.round(rgba.width * scale));
          const oh = Math.max(1, Math.round(rgba.height * scale));
          const out = createCanvas(ow, oh);
          out.getContext('2d').drawImage(src, 0, 0, ow, oh);

          found.push({
            png: new Uint8Array(out.toBuffer('image/png')),
            widthPx: ow,
            heightPx: oh,
            pageIndex: n,
            area: rgba.width * rgba.height,
            sig,
          });
        } catch {
          // 개별 이미지 실패는 건너뛴다.
        }
      }
      page.cleanup();
    }
    await doc.destroy();

    found.sort((a, b) => b.area - a.area);
    const kept = found.slice(0, maxImages).map(({ png, widthPx, heightPx, pageIndex }) => ({
      png,
      widthPx,
      heightPx,
      pageIndex,
    }));
    if (diag) {
      diag.pagesScanned = pageCount;
      diag.objectsFound = found.length;
      diag.kept = kept.length;
      diag.ms = Date.now() - startedAt;
    }
    return kept;
  } catch (e) {
    if (diag) {
      diag.error = e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120);
      diag.ms = Date.now() - startedAt;
    }
    return [];
  }
}

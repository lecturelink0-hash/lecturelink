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
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const PDF_WORKER_PATH = resolve(
  process.cwd(),
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
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
  /**
   * 이미지 객체 1개를 기다리는 상한(ms). 기본 OBJECT_GET_TIMEOUT_MS.
   * pdfjs 의 objs.get 은 "영영 안 오는" 객체에 대해 콜백을 부르지 않으므로 상한이 없으면
   * 추출 전체가 멈춘다(아래 GLOBAL_OBJECT_PREFIX 주석 참고).
   */
  objectTimeoutMs?: number;
  /** 추출 전체 벽시계 상한(ms). 초과하면 그때까지 확보한 것만 반환. 기본 EXTRACT_BUDGET_MS. */
  budgetMs?: number;
  /** 진단 수집기(선택). */
  diag?: {
    pagesScanned?: number;
    objectsFound?: number;
    /** 실제로 디코드·PNG 인코드까지 수행한 수(상한만큼만). objectsFound 와의 차이가 아낀 비용. */
    encoded?: number;
    kept?: number;
    ms?: number;
    error?: string;
    /** 전역 스코프(g_) 라서 건너뛴 참조 수 — 이 PDF 가 그림을 여러 쪽에 재사용했다는 신호. */
    skippedGlobal?: number;
    /** 같은 객체를 다른 쪽에서 다시 만나 재처리를 생략한 횟수. */
    dedupedRefs?: number;
    /** 상한 안에 도착하지 않아 버린 객체 수(0 이 아니면 이 PDF 에 미지의 특성이 있다). */
    timedOut?: number;
    /** 벽시계 상한에 걸려 남은 쪽을 훑지 못했는지. */
    budgetExceeded?: boolean;
  };
}

/**
 * pdfjs 가 "여러 쪽이 공유하는" 이미지에 붙이는 전역 스코프 접두어.
 *
 * ★ 이 접두어가 붙은 객체는 `page.objs` 로도 `page.commonObjs` 로도 가져올 수 없다.
 *   둘 다 콜백을 영원히 부르지 않아, 상한 없이 await 하면 추출이 통째로 멈춘다.
 *
 * 실제 사고: 강의록 PDF(29쪽·이미지 객체 173개)에서 같은 그림을 여러 슬라이드에 재사용해
 * 6개 객체가 전역으로 승격됐고(참조 12건), 첫 참조에서 await 가 영구 정지했다.
 * 그 결과 문항 생성이 텍스트 선발사 배치 2문항만 남긴 채 끝나지 않았고,
 * user_uploads 행이 status=processing / partially_completed 로 영원히 남았다
 * (예외가 아니라 정지라 실패 처리·진단 기록도 돌지 않았다).
 * 쪽마다 새로 그려지는 그림은 쪽 스코프(`img_pN_M`)라 정상 조회된다 — 재사용 그림만 해당한다.
 */
const GLOBAL_OBJECT_PREFIX = 'g_';

/** 이미지 객체 1개를 기다리는 기본 상한. 정상 객체는 밀리초 단위로 도착한다. */
const OBJECT_GET_TIMEOUT_MS = 2_000;

/** 추출 전체 벽시계 상한. 미지의 PDF 특성이 단계를 붙잡지 못하게 하는 최후 방어선. */
const EXTRACT_BUDGET_MS = 45_000;

/**
 * `objs.get` 을 상한과 함께 호출한다. 상한을 넘으면 null.
 *
 * pdfjs 의 PDFObjects.get(name, cb) 은 객체가 준비되지 않았으면 콜백을 보관만 하고
 * 즉시 반환한다. 준비가 끝내 안 되면 콜백은 영영 호출되지 않는다 — 그래서 상한이 필수다.
 */
function getObjectWithTimeout(
  objs: { get: (k: string, cb: (v: unknown) => void) => void },
  name: string,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);
    try {
      objs.get(name, (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      });
    } catch {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    }
  });
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
  const objectTimeout = opts.objectTimeoutMs ?? OBJECT_GET_TIMEOUT_MS;
  const budgetMs = opts.budgetMs ?? EXTRACT_BUDGET_MS;
  const diag = opts.diag;
  const startedAt = Date.now();
  let skippedGlobal = 0;
  let dedupedRefs = 0;
  let timedOut = 0;
  let budgetExceeded = false;

  try {
    const { createCanvas } = await import('canvas');
    const doc = await pdfjsLib.getDocument({
      data: new Uint8Array(pdfData.slice(0)),
      isEvalSupported: false,
    }).promise;

    const pageCount = Math.min(doc.numPages, maxPages);

    // ── 1단계: 연산자 목록만 훑어 "후보 목록"을 만든다(객체는 하나도 가져오지 않는다).
    //
    // paintImageXObject 의 인자는 [objId, width, height] 라 원본 크기를 객체 조회 없이 알 수 있다.
    // 그래서 크기 미달(아이콘·장식)과 전역 스코프 객체를 여기서 전부 걸러내고,
    // 면적 순으로 상한(maxImages)만큼만 2단계에서 디코드·PNG 인코드한다.
    // 종전에는 통과한 이미지를 전부 인코드한 뒤 마지막에 잘라내서, 버릴 이미지까지
    // 인코드했다(실측: 강의록 PDF 에서 90장 인코드 → 40장만 사용). 인코드는 이 함수에서
    // 가장 비싼 구간이고 PNG 를 메모리에 그대로 쌓기 때문에 시간·메모리 양쪽에 불리했다.
    type Candidate = { name: string; pageIndex: number; area: number };
    const candidates: Candidate[] = [];
    const attempted = new Set<string>();

    for (let n = 1; n <= pageCount; n++) {
      if (Date.now() - startedAt > budgetMs) {
        budgetExceeded = true;
        break;
      }
      const page = await doc.getPage(n);
      const ops = await page.getOperatorList();
      const OPS = pdfjsLib.OPS as unknown as Record<string, number>;
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        // pdfjs 버전에 따라 paintJpegXObject 가 없을 수 있어 이름으로 조회한다.
        if (fn !== OPS.paintImageXObject && fn !== OPS.paintJpegXObject) continue;
        const args = ops.argsArray[i] as [string, number, number] | undefined;
        const name = args?.[0];
        if (typeof name !== 'string') continue;
        // 전역 스코프 객체는 조회 수단이 없다 — 기다리면 영구 정지한다(상수 주석 참고).
        if (name.startsWith(GLOBAL_OBJECT_PREFIX)) {
          skippedGlobal += 1;
          continue;
        }
        // 같은 그림을 여러 쪽에 재사용하는 강의록에서 같은 객체를 쪽마다 다시 다루지 않는다.
        if (attempted.has(name)) {
          dedupedRefs += 1;
          continue;
        }
        attempted.add(name);
        const w = Number(args?.[1]) || 0;
        const h = Number(args?.[2]) || 0;
        if (w > 0 && h > 0 && Math.min(w, h) < minEdge) continue;
        candidates.push({ name, pageIndex: n, area: w * h });
      }
      page.cleanup();
    }

    // 면적 큰 순으로 상한만큼만 남긴다. 내용 서명 중복 제거로 2단계에서 일부가 빠질 수 있어
    // 약간의 여유분을 둔다(여유분까지 다 쓰는 경우는 드물다 — 아래 루프가 상한에서 멈춘다).
    candidates.sort((a, b) => b.area - a.area);
    const shortlist = candidates.slice(0, Math.max(maxImages, Math.ceil(maxImages * 1.5)));
    // 2단계는 쪽 순서로 돌아야 같은 쪽의 객체를 한 번의 연산자 목록으로 처리할 수 있다.
    const byPage = new Map<number, Candidate[]>();
    for (const c of shortlist) {
      const arr = byPage.get(c.pageIndex) ?? [];
      arr.push(c);
      byPage.set(c.pageIndex, arr);
    }

    // ── 2단계: 추린 후보만 실제로 가져와 디코드·다운스케일·PNG 인코드.
    //
    // ★ 문서를 새로 연다. page.cleanup() 이 객체 저장소를 비우고 나면 같은 문서에서
    //   getOperatorList 를 다시 불러도 이미지 객체가 page.objs 에 다시 등재되지 않아
    //   전부 상한 대기로 빠진다(실측: 재사용 시 22/26 timeout). 문서 재파싱은 0.1초 수준이라
    //   버릴 이미지를 인코드하지 않아 아끼는 시간이 훨씬 크다.
    await doc.destroy();
    const doc2 = await pdfjsLib.getDocument({
      data: new Uint8Array(pdfData.slice(0)),
      isEvalSupported: false,
    }).promise;

    const found: (PdfImageObject & { area: number; sig: string })[] = [];
    const seen = new Set<string>();

    for (const n of [...byPage.keys()].sort((a, b) => a - b)) {
      if (found.length >= maxImages) break;
      if (Date.now() - startedAt > budgetMs) {
        budgetExceeded = true;
        break;
      }
      const page = await doc2.getPage(n);
      // 객체는 연산자 목록을 만드는 과정에서 page.objs 에 등재된다.
      await page.getOperatorList();
      for (const cand of byPage.get(n) ?? []) {
        if (found.length >= maxImages) break;
        try {
          // objs.get 은 콜백형 — 준비되지 않으면 콜백이 영영 안 올 수 있어 상한을 건다.
          const raw = await getObjectWithTimeout(
            page.objs as { get: (k: string, cb: (v: unknown) => void) => void },
            cand.name,
            objectTimeout,
          );
          if (raw === null) {
            timedOut += 1;
            continue;
          }
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
    await doc2.destroy();

    found.sort((a, b) => b.area - a.area);
    const kept = found.slice(0, maxImages).map(({ png, widthPx, heightPx, pageIndex }) => ({
      png,
      widthPx,
      heightPx,
      pageIndex,
    }));
    if (diag) {
      diag.pagesScanned = pageCount;
      // 크기 기준을 통과한 후보 수(=이 PDF 가 가진 쓸 만한 이미지의 총량).
      diag.objectsFound = candidates.length;
      // 실제로 디코드·인코드까지 한 수. objectsFound 보다 훨씬 작아야 정상이다.
      diag.encoded = found.length;
      diag.kept = kept.length;
      diag.ms = Date.now() - startedAt;
      diag.skippedGlobal = skippedGlobal;
      diag.dedupedRefs = dedupedRefs;
      diag.timedOut = timedOut;
      diag.budgetExceeded = budgetExceeded;
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

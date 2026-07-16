/**
 * PDF 임베드 이미지 직접 추출 (object 단위 dedup).
 *
 * 기존 "페이지 렌더 → Vision 으로 의료영역 검출/crop" 방식은 텍스트가 많은 강의 PDF 에서
 * 속도 최적화로 생략되어, 실제로 박혀 있는 X-ray/ECG 이미지를 놓쳤다.
 *
 * 여기서는 `mutool extract`(mupdf-tools)로 PDF 안의 이미지 XObject 를 **오브젝트 단위로
 * 중복 제거**해 추출한다(페이지마다 반복되는 워터마크/템플릿은 1개로 합쳐짐). 그중
 * 너무 작은 이미지(아이콘/장식)는 버리고, 면적이 큰 순으로 상위 N개를 골라 다운스케일 +
 * PNG 로 정규화해 반환한다.
 *
 * 텍스트 양과 무관하게 항상 동작하므로, 텍스트 위주 강의 PDF 에서도 이미지 판독 문항이 생긴다.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);

export interface EmbeddedImage {
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
}

export interface ExtractEmbeddedOptions {
  /** 이 값보다 짧은 변을 가진 이미지는 제외(아이콘/장식 컷). 기본 300px. */
  minEdgePx?: number;
  /** 최대 반환 개수(면적 큰 순). 기본 5. */
  maxImages?: number;
  /** 반환 이미지의 최대 변 길이(다운스케일). 기본 1024px. */
  maxOutEdgePx?: number;
}

/**
 * PDF 버퍼에서 임베드 이미지들을 추출한다. mutool 미설치/실패 시 빈 배열([]) 반환
 * (호출측이 기존 Vision 경로로 폴백).
 */
export async function extractEmbeddedPdfImages(
  pdfBuffer: Buffer,
  opts: ExtractEmbeddedOptions = {},
): Promise<EmbeddedImage[]> {
  const minEdge = opts.minEdgePx ?? 300;
  const maxImages = opts.maxImages ?? 5;
  const maxOutEdge = opts.maxOutEdgePx ?? 1024;

  const dir = await mkdtemp(path.join(tmpdir(), 'pdfimg-'));
  try {
    const pdfPath = path.join(dir, 'in.pdf');
    await writeFile(pdfPath, pdfBuffer);

    // mutool extract 는 cwd 에 image-NNNN.{png,jpg} / font-*.ttf 를 쏟아낸다(오브젝트 dedup).
    try {
      await execFileP('mutool', ['extract', pdfPath], {
        cwd: dir,
        timeout: 90_000,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      return [];
    }

    const files = (await readdir(dir)).filter((f) => /^image-\d+\.(png|jpe?g)$/i.test(f));
    if (files.length === 0) return [];

    const { loadImage, createCanvas } = await import('canvas');

    const candidates: (EmbeddedImage & { area: number })[] = [];
    for (const f of files) {
      try {
        const buf = await readFile(path.join(dir, f));
        const img = await loadImage(buf);
        const w = img.width;
        const h = img.height;
        if (w < minEdge || h < minEdge) continue; // 아이콘/장식/작은 마스크 제외

        const scale = Math.min(1, maxOutEdge / Math.max(w, h));
        const ow = Math.max(1, Math.round(w * scale));
        const oh = Math.max(1, Math.round(h * scale));
        const canvas = createCanvas(ow, oh);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, ow, oh);
        const png = canvas.toBuffer('image/png');
        candidates.push({ png: new Uint8Array(png), widthPx: ow, heightPx: oh, area: w * h });
      } catch {
        // 개별 이미지 로드/변환 실패는 건너뛴다.
      }
    }

    candidates.sort((a, b) => b.area - a.area);
    return candidates.slice(0, maxImages).map(({ png, widthPx, heightPx }) => ({ png, widthPx, heightPx }));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * PPTX 파서 — 슬라이드 텍스트 + ppt/media/* 임베드 이미지 추출
 *
 * PPTX 는 ZIP 컨테이너:
 *   ppt/slides/slide{N}.xml         — 슬라이드 본문 (a:t 가 텍스트)
 *   ppt/slides/_rels/slide{N}.xml.rels  — 이미지 관계 매핑
 *   ppt/media/image{N}.{png|jpg|...}    — 임베드 이미지
 *
 * 의존성: 외부 라이브러리 없이 fflate 만 사용 (압축 해제). package.json 에 추가 필요.
 *   npm install fflate
 *
 * 출력:
 *   {
 *     slides: [
 *       { index: 1, text: "...", imageRefs: ["image1.png", "image2.png"] },
 *       ...
 *     ],
 *     media: { "image1.png": Buffer, ... }
 *   }
 */

import { unzipSync, strFromU8 } from 'fflate';

export interface PptxSlide {
  index: number;
  text: string;
  imageRefs: string[]; // ppt/media 내 파일명 (예: "image1.png")
}

export interface PptxParseResult {
  slides: PptxSlide[];
  media: Map<string, Uint8Array>; // 파일명 → 바이너리
  warnings: string[];
}

function naturalSort(a: string, b: string): number {
  const re = /(\d+)/g;
  const aa = a.split(re);
  const bb = b.split(re);
  for (let i = 0; i < Math.max(aa.length, bb.length); i += 1) {
    const x = aa[i] ?? '';
    const y = bb[i] ?? '';
    const xn = Number(x);
    const yn = Number(y);
    if (!Number.isNaN(xn) && !Number.isNaN(yn) && x !== '' && y !== '') {
      if (xn !== yn) return xn - yn;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * XML/HTML entity 디코딩 (slide xml 의 a:t / .rels Target attribute 모두 사용).
 * 외부 라이브러리 없이 흔한 케이스만 처리.
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const cp = parseInt(n, 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff
        ? String.fromCodePoint(cp)
        : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      const cp = parseInt(h, 16);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff
        ? String.fromCodePoint(cp)
        : '';
    })
    // & 는 마지막에 — 그렇지 않으면 위 entity 들이 깨짐
    .replace(/&amp;/g, '&');
}

/**
 * <a:t>...</a:t> 텍스트 노드를 정규식으로 추출.
 * XML 파서 도입은 의존성 비용이 큰 데 비해 슬라이드 텍스트 추출은 거의 항상 a:t 만으로 충분.
 */
function extractTextFromSlideXml(xml: string): string {
  // self-closing <a:t/> 은 빈 텍스트라 제외
  const matches = xml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g) ?? [];
  return matches
    .map((m) => {
      const inner = m.replace(/^<a:t[^>]*>/, '').replace(/<\/a:t>$/, '');
      return decodeXmlEntities(inner);
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * relationship XML 에서 (rId → target) 맵 추출.
 * target 은 "../media/image1.png" 같은 상대 경로.
 * self-closing(`<Relationship .../>`) 와 paired(`<Relationship ...></Relationship>`) 모두 처리.
 */
function parseRels(relsXml: string): Map<string, string> {
  const map = new Map<string, string>();
  // self-closing 또는 paired 둘 다 매치
  const matches =
    relsXml.match(/<Relationship\b[^>]*(?:\/>|>[\s\S]*?<\/Relationship>)/g) ?? [];
  for (const m of matches) {
    const id = m.match(/\bId="([^"]+)"/)?.[1];
    const target = m.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) {
      map.set(id, decodeXmlEntities(target));
    }
  }
  return map;
}

// @napi-rs/canvas loadImage 가 안정적으로 처리하는 raster 포맷.
// EMF / WMF / TIFF / SVG 같은 vector / 비표준 포맷은 PPT 에서 가끔 들어오므로 skip + warning.
const SUPPORTED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']);

function imageExtFromName(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

/**
 * 슬라이드 XML 에서 사용된 r:embed/r:link 의 rId 추출.
 */
function extractImageRIds(slideXml: string): string[] {
  const rIds: string[] = [];
  const re = /r:(?:embed|link)="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(slideXml)) !== null) {
    rIds.push(m[1]);
  }
  return rIds;
}

export function parsePptx(buffer: ArrayBuffer): PptxParseResult {
  const warnings: string[] = [];

  // 압축 해제 실패는 전체 파이프라인을 죽이지 않고 warning + 빈 결과로 반환.
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch (e) {
    warnings.push(
      `PPTX 압축 해제 실패: ${e instanceof Error ? e.message : String(e)}`,
    );
    return { slides: [], media: new Map(), warnings };
  }

  // ── 미디어 수집 — 지원 포맷만, 나머지는 warning 후 skip
  const media = new Map<string, Uint8Array>();
  const skippedMedia: string[] = [];
  for (const [path, bytes] of Object.entries(entries)) {
    if (!path.startsWith('ppt/media/')) continue;
    const filename = path.slice('ppt/media/'.length);
    const ext = imageExtFromName(filename);
    if (!SUPPORTED_IMAGE_EXTS.has(ext)) {
      skippedMedia.push(filename);
      continue;
    }
    media.set(filename, bytes);
  }
  if (skippedMedia.length > 0) {
    warnings.push(
      `지원하지 않는 이미지 포맷 skip: ${skippedMedia.slice(0, 5).join(', ')}` +
        (skippedMedia.length > 5 ? ` 외 ${skippedMedia.length - 5}개` : ''),
    );
  }

  // ── 슬라이드 수집
  const slidePaths = Object.keys(entries)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort(naturalSort);

  const slides: PptxSlide[] = [];

  slidePaths.forEach((slidePath, idx) => {
    const slideBytes = entries[slidePath];
    if (!slideBytes) return;

    let slideXml: string;
    let text = '';
    try {
      slideXml = strFromU8(slideBytes);
      text = extractTextFromSlideXml(slideXml);
    } catch (e) {
      warnings.push(
        `slide ${idx + 1}: XML 파싱 실패 — ${e instanceof Error ? e.message : String(e)}`,
      );
      slides.push({ index: idx + 1, text: '', imageRefs: [] });
      return;
    }

    // 관계 파일
    const relsPath = slidePath
      .replace('/slides/', '/slides/_rels/')
      .replace('.xml', '.xml.rels');
    const relsBytes = entries[relsPath];
    let relsMap: Map<string, string>;
    try {
      relsMap = relsBytes ? parseRels(strFromU8(relsBytes)) : new Map();
    } catch (e) {
      warnings.push(
        `slide ${idx + 1}: rels 파싱 실패 — ${e instanceof Error ? e.message : String(e)}`,
      );
      relsMap = new Map();
    }

    const imageRefs: string[] = [];
    const seen = new Set<string>();
    const rIds = extractImageRIds(slideXml);
    for (const rId of rIds) {
      const target = relsMap.get(rId);
      if (!target) continue;
      // target = "../media/image1.png" 또는 "/ppt/media/image1.png" 등 → 파일명 추출
      const m = target.match(/media\/([^/]+)$/);
      if (!m) continue;
      const filename = m[1];
      if (seen.has(filename)) continue; // 같은 슬라이드 내 중복 ref 제거
      if (media.has(filename)) {
        seen.add(filename);
        imageRefs.push(filename);
      } else {
        warnings.push(
          `slide ${idx + 1}: rId=${rId} target=${target} 가 media 에서 발견되지 않음`,
        );
      }
    }

    slides.push({
      index: idx + 1,
      text,
      imageRefs,
    });
  });

  return { slides, media, warnings };
}

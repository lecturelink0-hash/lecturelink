/**
 * 강의자료 청킹 — 출처 추적의 단위 (성능지표 가이드 §4.3·§12.2 · 분담표 A8)
 *
 * 가이드 §4.3: "파일 해시, 페이지, 문단 ID의 존재 여부와 생성 시 사용 문단의 일치 여부를 검사한다."
 * 가이드 §12.2: 예상문제 벤치마크 레코드의 필수 필드에 `source_refs` 가 있다.
 *
 * ── 왜 청크가 필요한가 ───────────────────────────────────────────────────────
 * 지금도 프롬프트에는 `## 슬라이드 3` 헤더가 들어가서 모델은 출처를 **보고** 있다.
 * 없는 것은 두 가지다: 모델이 그것을 **보고하게** 하는 것, 그리고 나중에 사람이
 * "이 문항이 정말 3번 슬라이드에서 나왔나"를 **찾아볼 수 있게** 원문을 남기는 것.
 *
 * 청크를 저장해 두지 않으면 전문가 검수 때 검수자가 강의자료 전체를 매번 뒤져야 한다.
 * 분담표가 A8 을 2단계의 선행 조건으로 둔 이유가 이것이다 — 이게 없으면 검수 시간이
 * 몇 배로 늘어난다.
 *
 * ── 슬라이드 본문과 OCR 을 나누는 이유 ───────────────────────────────────────
 * 같은 페이지에서 나왔어도 출처의 성격이 다르다. 슬라이드 본문은 저자가 쓴 글이고,
 * OCR 은 그림 속 글자를 기계가 읽은 것이라 오독이 섞인다. 한 덩어리로 묶으면
 * "근거가 충분한가"를 판정할 때 검수자가 둘을 구분할 수 없다.
 *
 * import 를 두지 않는다 — 검사 스크립트가 이 파일만 불러 산식을 확인할 수 있어야 한다.
 */

export type ChunkKind = 'slide_text' | 'ocr';

export interface SlideSummaryInput {
  pageIndex: number;
  slideText?: string | null;
  ocrTexts?: string[];
}

export interface MaterialChunk {
  chunkIndex: number;
  pageIndex: number;
  kind: ChunkKind;
  text: string;
  charCount: number;
  /** 청크 내용 해시 — 자료가 조용히 바뀌었는지 판정한다(가이드 §4.3). */
  sha256: string;
}

/**
 * 한 청크의 최대 길이. 인용 단위로 쓸 수 있을 만큼 짧아야 하고,
 * 문맥을 잃을 만큼 짧아서도 안 된다.
 */
export const MAX_CHUNK_CHARS = 1200;
/** 이보다 짧은 꼬리는 앞 청크에 붙인다 — 한 문장짜리 청크는 인용해도 쓸모가 없다. */
export const MIN_TAIL_CHARS = 200;

/**
 * 의존성 없는 결정론 해시(FNV-1a 64bit 변형).
 *
 * node:crypto 를 쓰지 않는 이유: 이 모듈은 순수 함수만 두어 검사 스크립트가
 * 별칭·런타임 의존 없이 불러올 수 있어야 한다. 여기서 해시는 암호 용도가 아니라
 * "내용이 그대로인가"를 보는 지문이므로 충돌 저항이 이 정도면 충분하다.
 */
export function chunkHash(text: string): string {
  let h1 = 0xcbf29ce4;
  let h2 = 0x84222325;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (c << 5) | (c >>> 3);
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 긴 텍스트를 문단 → 문장 순으로 자른다.
 * 문단 경계를 먼저 쓰는 이유: 문장 단위로만 자르면 표나 목록이 조각나 인용해도 읽히지 않는다.
 */
export function splitText(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const normalized = normalize(text);
  if (normalized.length === 0) return [];
  if (normalized.length <= maxChars) return [normalized];

  const pieces: string[] = [];
  let current = '';
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) pieces.push(trimmed);
    current = '';
  };

  for (const paragraph of normalized.split(/\n{2,}/)) {
    const block = paragraph.trim();
    if (!block) continue;
    if (block.length > maxChars) {
      flush();
      // 문단 하나가 상한을 넘으면 문장 경계로 다시 쪼갠다.
      let sentence = '';
      for (const part of block.split(/(?<=[.!?。？！]|다\.)\s+/)) {
        if (sentence.length + part.length + 1 > maxChars && sentence) {
          pieces.push(sentence.trim());
          sentence = '';
        }
        sentence += (sentence ? ' ' : '') + part;
        // 문장 하나가 상한을 넘는 극단(줄바꿈 없는 표 등)은 문자로 끊는다.
        while (sentence.length > maxChars) {
          pieces.push(sentence.slice(0, maxChars).trim());
          sentence = sentence.slice(maxChars);
        }
      }
      if (sentence.trim()) pieces.push(sentence.trim());
      continue;
    }
    if (current.length + block.length + 2 > maxChars) flush();
    current += (current ? '\n\n' : '') + block;
  }
  flush();

  // 너무 짧은 꼬리는 앞에 붙인다.
  if (pieces.length >= 2) {
    const last = pieces[pieces.length - 1];
    if (last.length < MIN_TAIL_CHARS && pieces[pieces.length - 2].length + last.length <= maxChars * 1.5) {
      pieces[pieces.length - 2] = `${pieces[pieces.length - 2]}\n\n${last}`;
      pieces.pop();
    }
  }
  return pieces;
}

/**
 * 슬라이드 요약 → 저장할 청크 목록.
 *
 * 결정론이어야 한다. 같은 자료를 다시 처리했을 때 청크 id 가 달라지면
 * 이전에 저장된 문항의 출처가 통째로 끊긴다.
 */
export function buildChunks(slides: SlideSummaryInput[], options: { maxChars?: number } = {}): MaterialChunk[] {
  const maxChars = options.maxChars ?? MAX_CHUNK_CHARS;
  const chunks: MaterialChunk[] = [];
  let index = 0;

  // 페이지 순서를 고정한다 — 입력 순서가 흔들려도 같은 청크 번호가 나오게.
  const ordered = [...slides].sort((a, b) => a.pageIndex - b.pageIndex);

  for (const slide of ordered) {
    for (const text of splitText(slide.slideText ?? '', maxChars)) {
      chunks.push({
        chunkIndex: index, pageIndex: slide.pageIndex, kind: 'slide_text',
        text, charCount: text.length, sha256: chunkHash(text),
      });
      index += 1;
    }
    for (const ocr of slide.ocrTexts ?? []) {
      for (const text of splitText(ocr, maxChars)) {
        chunks.push({
          chunkIndex: index, pageIndex: slide.pageIndex, kind: 'ocr',
          text, charCount: text.length, sha256: chunkHash(text),
        });
        index += 1;
      }
    }
  }
  return chunks;
}

/** 자료 전체의 페이지 목록 — 출처 유효성 검사의 기준집합. */
export function pagesOf(chunks: MaterialChunk[]): number[] {
  return [...new Set(chunks.map((c) => c.pageIndex))].sort((a, b) => a - b);
}

/**
 * 배치별 출제 근거 구간 나누기 (RAG 실행계획 v1.1 · Phase 0-d · F2)
 *
 * 무엇이 문제였나
 * ──────────────
 * 1) 선발(prefire) 배치는 슬라이드 헤더가 없는 원문 한 덩어리를 받았다. 출처 검증은
 *    "그 배치가 본 `## 슬라이드 N` 헤더"를 기준집합으로 삼으므로(source-refs.ts), 선발 배치가
 *    신고한 페이지는 전부 무효 처리됐다 — 텍스트 전용 다배치 요청에서는 출처가 사실상 항상 빈 값.
 * 2) 본 배치도 슬라이드 블록이 구간 수보다 적으면 문자 단위로 잘랐는데, 두 번째 구간부터는
 *    헤더가 잘려 나가 같은 문제가 생겼다.
 *
 * 여기서는 두 경로가 같은 규칙으로 구간을 나누고, 문자 단위로 자를 때는 그 구간이 속한
 * 페이지의 헤더를 앞에 다시 붙인다. 블록 경계 분할(±1 블록 겹침)과 문자 분할(10% 겹침,
 * 줄 경계 맞춤)의 규칙 자체는 종전 private-generation.ts 와 같다.
 *
 * import 를 두지 않는다 — 검사 스크립트(`npm run check:page-text`)가 이 파일만 불러온다.
 */

export interface PageTextLike {
  pageIndex: number;
  text: string;
}

/** 본문만 있는 선발 배치용 블록. 헤더 형식은 source-refs 의 `## 슬라이드 N` 인식 규칙을 따른다. */
export function buildEarlyBlocks(pages: readonly PageTextLike[]): string[] {
  return pages
    .filter((p) => (p.text ?? '').trim().length > 0)
    .map((p) => `## 슬라이드 ${p.pageIndex}\n텍스트: ${p.text.trim()}`);
}

const PAGE_HEADER_RE = /^##\s*슬라이드\s*\d+[^\n]*$/gm;

/** offset 위치(포함)보다 앞에서 시작한 마지막 페이지 헤더 줄. 없으면 null. */
export function headerBefore(text: string, offset: number): string | null {
  let last: string | null = null;
  for (const m of text.matchAll(PAGE_HEADER_RE)) {
    if ((m.index ?? 0) > offset) break;
    last = m[0];
  }
  return last;
}

/**
 * 문장/줄 경계에 맞춘 index/count 번째 구간의 [start, end).
 * 종전 private-generation.ts 의 sliceByChars 와 같은 규칙이다.
 */
export function sliceRange(
  text: string,
  index: number,
  count: number,
  overlapRatio: number,
): { start: number; end: number } {
  if (count <= 1) return { start: 0, end: text.length };
  const segLen = Math.ceil(text.length / count);
  const pad = Math.round(segLen * overlapRatio);
  let start = Math.max(0, index * segLen - pad);
  let end = Math.min(text.length, index * segLen + segLen + pad);
  if (start > 0) {
    const nl = text.indexOf('\n', start);
    if (nl >= 0 && nl - start < 500) start = nl + 1;
  }
  if (end < text.length) {
    const nl = text.lastIndexOf('\n', end);
    if (nl > start && end - nl < 500) end = nl;
  }
  return { start, end };
}

/**
 * 블록 n 개를 구간 count 개로 **고르게** 나눈 index 번째 구간의 [from, to) (겹침 전).
 * n ≥ count 이면 모든 구간이 최소 1블록을 갖는다.
 *
 * 종전 규칙 `per = ceil(n / count)` 는 n 이 count 보다 조금 클 때 뒤쪽 구간이 비었다
 * (예: 블록 12·구간 8 → 마지막 구간 ''). 텍스트 PDF 가 한 블록이던 시절에는 이 경로를 거의
 * 타지 않아 드러나지 않았지만, 페이지 단위 블록이 된 뒤로는 빈 컨텍스트 배치가 생긴다.
 */
export function balancedBlockRange(n: number, index: number, count: number): { from: number; to: number } {
  const from = Math.floor((index * n) / count);
  const to = Math.max(from + 1, Math.floor(((index + 1) * n) / count));
  return { from: Math.min(from, n), to: Math.min(to, n) };
}

/**
 * segIndex 번째 구간의 출제 근거.
 *  - 구간이 1개면 전체.
 *  - 블록이 구간 수 이상이면 블록 경계로 고르게 나누고 앞뒤 1블록씩 겹친다.
 *  - 아니면 문자 단위로 나누고, 구간이 헤더로 시작하지 않으면 그 구간이 속한 페이지의
 *    헤더를 앞에 붙인다(출처 검증의 기준집합이 비지 않게).
 */
export function segmentContext(input: {
  blocks: readonly string[];
  /** blocks 를 `\n\n` 으로 이은 전체. 생략하면 여기서 만든다. */
  text?: string;
  segIndex: number;
  segCount: number;
  overlapRatio: number;
}): string {
  const text = input.text ?? input.blocks.join('\n\n');
  const { blocks, segCount } = input;
  if (segCount <= 1) return text;
  const segIndex = Math.min(segCount - 1, Math.max(0, input.segIndex));
  if (blocks.length >= segCount) {
    const { from, to } = balancedBlockRange(blocks.length, segIndex, segCount);
    return blocks.slice(Math.max(0, from - 1), Math.min(blocks.length, to + 1)).join('\n\n');
  }
  const { start, end } = sliceRange(text, segIndex, segCount, input.overlapRatio);
  // 줄 경계 맞춤 때문에 구간이 블록 사이 빈 줄에서 시작할 수 있다 — 앞 공백을 걷고 판단한다.
  // (걷지 않으면 바로 뒤에 헤더가 있는데도 앞 페이지의 헤더를 하나 더 붙이게 된다.)
  const raw = text.slice(start, end);
  const lead = raw.length - raw.trimStart().length;
  const slice = raw.slice(lead);
  if (/^##\s*슬라이드\s*\d+/.test(slice)) return slice;
  const header = headerBefore(text, start + lead);
  return header ? `${header}\n${slice}` : slice;
}

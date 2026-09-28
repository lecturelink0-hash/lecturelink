/**
 * 페이지 단위 본문 텍스트 (RAG 실행계획 v1.1 · Phase 0-b · F1)
 *
 * 왜 필요한가
 * ──────────
 * 종전 PDF 경로는 pdf-parse 의 전체 텍스트 한 덩어리를 첫 페이지(또는 첫 후보 페이지)
 * 하나에 붙였다. 그래서 텍스트 PDF·DOCX 에서는 프롬프트의 `## 슬라이드 N` 헤더,
 * material_chunks.page_index, 모델이 신고하는 source_pages 가 전부 "1"이거나 무의미했다.
 * 출처를 페이지로 추적하려면 추출 단계에서부터 페이지를 나눠 들고 있어야 한다.
 *
 * 추가 파싱 없이 나눈다: pdf-parse 는 페이지마다 `pagerender(pageData)` 를 부르고 그
 * 반환값을 `\n\n` 으로 이어 붙여 전체 텍스트를 만든다. 기본 렌더러와 똑같이 페이지 텍스트를
 * 만들면서 페이지별로 보관하면, 전체 텍스트는 종전과 한 글자도 다르지 않고 페이지 구조만
 * 덤으로 얻는다.
 *
 * import 를 두지 않는다 — 검사 스크립트(`npm run check:page-text`)가 이 파일만 불러온다.
 */

export interface PageText {
  /** 1-based 페이지 번호. */
  pageIndex: number;
  text: string;
}

/** pdf.js getTextContent() 의 항목 중 여기서 쓰는 부분. */
export interface TextContentItemLike {
  str: string;
  transform: number[];
}

/**
 * pdf-parse 1.1.1 의 기본 `render_page` 와 같은 규칙으로 한 페이지의 텍스트를 만든다.
 * 같은 줄(y 좌표 동일)이면 이어 붙이고, 줄이 바뀌면 개행한다.
 *
 * 규칙을 바꾸지 않는 이유: 전체 텍스트(= 페이지 텍스트를 `\n\n` 으로 이은 것)가 종전과 달라지면
 * 초점 추출·세션 간 중복 방지 등 전체 텍스트를 쓰는 기존 경로의 동작이 조용히 바뀐다.
 */
export function renderPageText(items: readonly TextContentItemLike[]): string {
  let lastY: number | undefined;
  let text = '';
  for (const item of items) {
    const y = item.transform[5];
    // pdf-parse 원문: `if (lastY == item.transform[5] || !lastY)` — y 가 0 이어도 "첫 줄" 취급.
    if (lastY === y || !lastY) {
      text += item.str;
    } else {
      text += '\n' + item.str;
    }
    lastY = y;
  }
  return text;
}

/** pdf-parse 가 만드는 전체 텍스트와 같은 모양으로 잇는다(앞뒤 공백 제거는 호출자와 동일하게). */
export function joinPageTexts(pages: readonly PageText[]): string {
  return pages.reduce((acc, p) => `${acc}\n\n${p.text}`, '').trim();
}

/**
 * 전체 글자 수 상한을 페이지 순서대로 적용한다.
 *
 * 종전에는 전체 텍스트를 앞에서 maxChars 자로 잘랐다. 같은 결과가 되도록 페이지 사이
 * 구분자(`\n\n`, 2자)도 글자 수에 넣어 누적하고, 상한에 걸린 페이지는 남은 만큼만 남긴다.
 * 상한 뒤의 페이지는 버린다(텍스트가 빈 페이지로 남기지 않는다 — 출처로 인용될 수 없다).
 *
 * 각 페이지 텍스트는 앞뒤 공백을 걷어 낸다. 빈 페이지는 그대로 두되 텍스트는 빈 문자열이다.
 */
export function capPageTexts(
  pages: readonly PageText[],
  maxChars: number,
): { pages: PageText[]; totalChars: number; truncatedChars: number } {
  const out: PageText[] = [];
  const trimmed = pages.map((p) => ({ pageIndex: p.pageIndex, text: (p.text ?? '').trim() }));
  const totalChars = joinPageTexts(trimmed).length;
  let used = 0;
  for (const page of trimmed) {
    if (used >= maxChars) break;
    const sep = used === 0 || page.text.length === 0 ? 0 : 2;
    const room = maxChars - used - sep;
    if (room <= 0) break;
    const text = page.text.length > room ? page.text.slice(0, room).trimEnd() : page.text;
    out.push({ pageIndex: page.pageIndex, text });
    used += sep + text.length;
  }
  return { pages: out, totalChars, truncatedChars: Math.max(0, totalChars - used) };
}

/**
 * 같은 페이지 번호가 여러 번 나오면(PPTX 미디어 폴백은 그림 1장마다 행을 만든다) 한 페이지로
 * 합친다. 텍스트는 처음 나온 비어 있지 않은 값, 나머지 필드는 호출자가 merge 로 합친다.
 * 페이지 순서는 처음 등장한 순서를 유지한다.
 */
export function mergeByPage<T extends { pageIndex: number; text: string }>(
  rows: readonly T[],
  merge: (into: T, from: T) => void,
): T[] {
  const byPage = new Map<number, T>();
  const order: T[] = [];
  for (const row of rows) {
    const existing = byPage.get(row.pageIndex);
    if (!existing) {
      const copy = { ...row };
      byPage.set(row.pageIndex, copy);
      order.push(copy);
      continue;
    }
    if (!existing.text && row.text) existing.text = row.text;
    merge(existing, row);
  }
  return order;
}

/**
 * PDF 한 건의 슬라이드 행을 만든다: 페이지별 본문 + (렌더된 페이지만) PNG.
 *
 * 렌더는 이미지 후보 페이지만 하므로(또는 아예 안 하므로) 본문이 있는 페이지와 PNG 가 있는
 * 페이지는 서로 다를 수 있다. 둘 중 하나라도 있는 페이지를 페이지 순으로 모두 둔다 — PNG 가
 * 빈 페이지는 이미지 단계가 알아서 건너뛰고, 본문이 빈 페이지는 컨텍스트·청크에 안 나온다.
 */
export function assemblePageSlides<P>(
  pageTexts: readonly PageText[],
  rendered: ReadonlyArray<{ pageIndex: number; png: P }>,
  emptyPng: () => P,
): Array<{ pageIndex: number; text: string; png: P }> {
  const textByPage = new Map(pageTexts.map((p) => [p.pageIndex, p.text]));
  const pngByPage = new Map(rendered.map((r) => [r.pageIndex, r.png]));
  const indices = [...new Set([...textByPage.keys(), ...pngByPage.keys()])].sort((a, b) => a - b);
  const out: Array<{ pageIndex: number; text: string; png: P }> = [];
  for (const pageIndex of indices) {
    const text = textByPage.get(pageIndex) ?? '';
    const png = pngByPage.get(pageIndex);
    if (!text && png === undefined) continue;
    out.push({ pageIndex, text, png: png ?? emptyPng() });
  }
  return out;
}

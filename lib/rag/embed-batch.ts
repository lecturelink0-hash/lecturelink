/**
 * 임베딩 배치 호출의 순수 계산 (RAG 실행계획 v1.1 · 0-g)
 *
 * 묶음 나누기·단가·재임베딩 판정을 여기 모아 둔다. 네트워크 호출은 lib/ai/embed.ts 의 embedTexts 가 한다.
 *
 * import 를 두지 않는다 — 검사 스크립트(`npm run check:rag-mode`)가 이 파일만 불러온다.
 */

/**
 * USD / 1M 입력 토큰. 2026-09-28 확인(Voyage 공식 요금표, Gemini Embedding 2 공개 요금).
 * 표에 없는 모델은 0 으로 기록하지 않고 호출 전에 막는다 — 모델을 바꾸면 비용이 조용히 사라지는
 * 사각지대(recordAiCost 주석)를 만들지 않기 위해서다.
 */
export const EMBED_PRICES_PER_M: Record<string, number> = {
  'voyage-4': 0.06,
  'voyage-3.5': 0.06,
  'voyage-3': 0.06,
  'gemini-embedding-2': 0.2,
};

export function embedPricePerM(model: string): number | null {
  return Object.prototype.hasOwnProperty.call(EMBED_PRICES_PER_M, model) ? EMBED_PRICES_PER_M[model] : null;
}

export function embedCostUsd(model: string, tokens: number): number {
  const p = embedPricePerM(model);
  return p === null ? 0 : (Math.max(0, tokens) * p) / 1_000_000;
}

/**
 * 토큰 수 근사. Gemini 배치 임베딩 응답에는 토큰 수가 없어 글자 수로 센다.
 * 한국어는 글자당 토큰이 1 안팎이라 보수적으로 글자 수를 그대로 쓴다(과소 추정보다 과대 추정이 낫다).
 */
export function approxTokens(text: string): number {
  return Math.max(1, (text ?? '').length);
}

/**
 * 텍스트 목록을 요청 단위로 나눈다. 순서를 보존하며, 각 묶음은 개수 상한과 글자 수 상한을 넘지 않는다.
 * 글자 수 상한보다 긴 텍스트 하나는 혼자 한 묶음이 된다(자르지 않는다 — 제공자가 알아서 절삭한다).
 */
export function batchTexts(
  texts: readonly string[],
  limits: { maxItems: number; maxChars: number },
): Array<{ start: number; texts: string[] }> {
  const out: Array<{ start: number; texts: string[] }> = [];
  let cur: string[] = [];
  let curChars = 0;
  let start = 0;
  texts.forEach((t, i) => {
    const len = (t ?? '').length;
    if (cur.length > 0 && (cur.length >= limits.maxItems || curChars + len > limits.maxChars)) {
      out.push({ start, texts: cur });
      cur = [];
      curChars = 0;
      start = i;
    }
    cur.push(t);
    curChars += len;
  });
  if (cur.length > 0) out.push({ start, texts: cur });
  return out;
}

/** 제공자별 요청 상한. Voyage 는 요청당 1,000건·토큰 상한, Gemini batchEmbedContents 는 100건. */
export const EMBED_BATCH_LIMITS = {
  voyage: { maxItems: 128, maxChars: 100_000 },
  gemini: { maxItems: 100, maxChars: 100_000 },
} as const;

export function l2normalize(v: readonly number[]): number[] {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return n === 0 ? v.map(() => 0) : v.map((x) => x / n);
}

/** pgvector 입력 형식. supabase-js 는 벡터를 문자열 '[…]' 로 넘긴다. */
export function toPgVector(v: readonly number[]): string {
  return `[${v.map((x) => (Number.isFinite(x) ? Number(x.toFixed(7)) : 0)).join(',')}]`;
}

/**
 * 이 청크를 (다시) 임베딩해야 하는가.
 * 임베딩한 모델이 다르거나, 임베딩할 때의 내용 지문이 지금 내용과 다르면 다시 한다.
 * 같은 업로드를 재처리해도 내용이 같은 청크는 호출하지 않는다(청크 id 안정화와 같은 원칙).
 */
export function needsEmbedding(
  row: { content_sha: string; embedding_model: string | null; embedding_sha: string | null },
  model: string,
): boolean {
  return row.embedding_model !== model || row.embedding_sha !== row.content_sha;
}

/**
 * 검색 평가 지표 (RAG 실행계획 v1.1 · 6.2 R1 · 실험 E1~E3)
 *
 * 정답(골드)은 청크 id 가 아니라 **원문 인용구**로 둔다. E2 는 청킹 방식을 바꿔 가며 비교하므로
 * 청크 경계가 조건마다 다르다. 인용구가 근거 팩 안에 그대로 들어 있으면 '회수됨'으로 본다.
 * 그래야 1,200자 청크로 만든 라벨로 600자 청크·페이지 단위 조건도 같은 잣대로 잴 수 있다.
 *
 * import 를 두지 않는다 — 검사 스크립트(`npm run check:rag-eval`)가 이 파일만 불러온다.
 */

/**
 * 대조용 정규화: 호환 문자 통일(NFKC), 소문자, 공백·줄바꿈 제거.
 * 공백을 없애는 이유: 추출기·청커가 줄바꿈과 공백을 다르게 남겨도 같은 글로 봐야 한다.
 */
export function normalizeForMatch(text: string): string {
  return (text ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** 인용구가 텍스트 중 하나에 그대로 들어 있는가(정규화 후 부분 문자열). 빈 인용구는 거짓. */
export function quoteCovered(quote: string, texts: ReadonlyArray<string>): boolean {
  const q = normalizeForMatch(quote);
  if (!q) return false;
  return texts.some((t) => normalizeForMatch(t).includes(q));
}

export interface UnitScore {
  /** 회수된 인용구 비율(0~1). 인용구가 없으면 null(평가 제외). */
  recall: number | null;
  /** 인용구가 하나라도 회수됐는가. */
  hit: boolean;
}

/** 한 출제 단위의 근거 팩 평가. */
export function scoreUnit(goldQuotes: ReadonlyArray<string>, packTexts: ReadonlyArray<string>): UnitScore {
  const quotes = goldQuotes.filter((q) => normalizeForMatch(q).length > 0);
  if (quotes.length === 0) return { recall: null, hit: false };
  const covered = quotes.filter((q) => quoteCovered(q, packTexts)).length;
  return { recall: covered / quotes.length, hit: covered > 0 };
}

/**
 * 역순위(reciprocal rank)@k: 순위 목록에서 인용구를 하나라도 담은 첫 항목의 1/순위. 없으면 0.
 * MRR@k 는 이 값의 평균.
 */
export function reciprocalRankAt(
  goldQuotes: ReadonlyArray<string>,
  rankedTexts: ReadonlyArray<string>,
  k: number,
): number {
  const quotes = goldQuotes.filter((q) => normalizeForMatch(q).length > 0);
  for (let i = 0; i < Math.min(k, rankedTexts.length); i += 1) {
    if (quotes.some((q) => quoteCovered(q, [rankedTexts[i]]))) return 1 / (i + 1);
  }
  return 0;
}

export function mean(values: ReadonlyArray<number>): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** nearest-rank 백분위(lib/metrics/upload-cost.ts 와 같은 규칙). */
export function percentile(values: ReadonlyArray<number>, p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}

/**
 * 근거 부족 임계 τ (E3 판정 기준): 정답을 회수한 단위들의 최고 검색 점수 분포에서,
 * 그 단위의 `keep` 비율(기본 0.9)이 τ 이상이 되는 가장 높은 값.
 * = 회수된 단위 최고 점수들의 하위 (1-keep) 분위수. τ 미만이면 '근거 부족'으로 보고 예비 단위로 바꾼다.
 * 회수된 단위가 없으면 null.
 */
export function chooseTau(topScoresOfHitUnits: ReadonlyArray<number>, keep = 0.9): number | null {
  if (topScoresOfHitUnits.length === 0) return null;
  const sorted = [...topScoresOfHitUnits].sort((a, b) => b - a);
  const idx = Math.max(0, Math.ceil(keep * sorted.length) - 1);
  return sorted[idx];
}

/** 인용구 위치 찾기에서 무시하는 글자: 공백과 목록 기호. LLM 이 인용할 때 흔히 빼먹거나 바꾼다. */
const SKIP_RE = /[\s•·▪◦‣∙●○■□►▶]/;

/** 원문 → (뼈대 문자열, 뼈대 글자별 원문 위치). 뼈대 = NFKC·소문자·SKIP_RE 제거. */
function skeleton(text: string): { flat: string; at: number[] } {
  let flat = '';
  const at: number[] = [];
  const src = text.normalize('NFKC');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i].toLowerCase();
    if (SKIP_RE.test(ch)) continue;
    flat += ch;
    at.push(i);
  }
  return { flat, at };
}

/**
 * 인용구가 청크 원문에 있는지 확인하고, 없으면 가장 가까운 원문 구간으로 바로잡는다(라벨 초안 검증용).
 * LLM 이 인용구의 공백·목록 기호를 빼거나 바꿔 내는 일이 흔해서, 둘 다 무시한 '뼈대'끼리 대조한다.
 * 그래도 없으면 원문에 있는 가장 긴 앞부분(최소 8자)을 앵커로 삼아 인용구 뼈대 길이만큼 원문에서
 * 잘라 온다(뒤쪽이 원문과 달랐던 경우). 결과는 항상 원문의 연속 구간이다. 못 찾으면 null.
 * 바로잡은 인용구는 원래 뜻과 달라졌을 수 있으므로 검토 도구에서 따로 표시한다.
 */
export function locateQuote(quote: string, chunkText: string): string | null {
  const q = skeleton(quote).flat;
  if (!q) return null;
  if (normalizeForMatch(chunkText).includes(normalizeForMatch(quote))) return quote.trim();
  const src = chunkText.normalize('NFKC');
  const { flat, at } = skeleton(src);
  let pos = flat.indexOf(q);
  let len = q.length;
  if (pos < 0) {
    for (let l = Math.min(q.length, 40); l >= Math.min(8, q.length); l -= 1) {
      pos = flat.indexOf(q.slice(0, l));
      if (pos >= 0) break;
    }
    if (pos < 0) return null;
    len = Math.min(q.length, flat.length - pos);
  }
  const start = at[pos];
  const end = at[pos + len - 1] + 1;
  const fixed = src.slice(start, end).trim();
  return fixed.length > 0 ? fixed : null;
}

/**
 * 검색 계층의 순수 산식 (RAG 실행계획 v1.1 · 5.2 E·F · 실험 E1~E3)
 *
 * 오프라인 평가 하네스(scripts/rag-eval)와 Phase 1 검색 단계가 같은 산식을 쓰도록 여기에 둔다.
 * 평가에서 고른 구성이 운영에서 다른 식으로 계산되면 평가 결과가 운영을 대변하지 못한다.
 *
 * import 를 두지 않는다 — 검사 스크립트(`npm run check:rag-eval`)가 이 파일만 불러온다.
 */

/** 코사인 유사도. 길이가 다르거나 영벡터면 0. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 단위 길이로 맞춘다. 차원을 잘라 쓰는(Matryoshka) 임베딩은 잘린 벡터를 다시 정규화해야 한다. */
export function l2normalize(v: ArrayLike<number>): number[] {
  let n = 0;
  for (let i = 0; i < v.length; i += 1) n += v[i] * v[i];
  const s = n > 0 ? 1 / Math.sqrt(n) : 0;
  return Array.from(v, (x) => x * s);
}

export interface Scored {
  id: string;
  score: number;
}

/** 정확 코사인 top-k(동점은 id 사전순으로 고정해 실행마다 같은 순서를 낸다). */
export function topKByCosine(
  query: ArrayLike<number>,
  docs: ReadonlyArray<{ id: string; vec: ArrayLike<number> }>,
  k: number,
): Scored[] {
  return docs
    .map((d) => ({ id: d.id, score: cosine(query, d.vec) }))
    .sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .slice(0, Math.max(0, k));
}

/** RRF 상수(5.2 E). */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion. 순위 목록 여러 개를 합친다(점수 척도가 다른 dense·sparse 를 합치는 용도).
 * score(d) = Σ 1 / (k + rank_i(d)), rank 는 1부터. 목록에 없으면 기여 0.
 * 동점은 id 사전순.
 */
export function rrfFuse(lists: ReadonlyArray<ReadonlyArray<string>>, k = RRF_K): Scored[] {
  const acc = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((id, i) => {
      if (seen.has(id)) return; // 한 목록 안의 중복은 첫 순위만 친다
      seen.add(id);
      acc.set(id, (acc.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...acc.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface PackItem {
  /** 근거 팩에 실제로 들어가는 단위의 id(청크 id 또는 부모 id). */
  id: string;
  /** 이 항목을 끌어온 검색 결과(청크) id. */
  sourceIds: string[];
  /** 부모로 확장됐는가. */
  expanded: boolean;
}

/**
 * 근거 팩 조립 — 검색 순위(청크)에서 최대 `size` 개 항목을 고른다(5.2 F · E2).
 *
 *  - expandTop: 순위 상위 몇 개를 부모(level 0, 페이지)로 넓힐지. 0 이면 확장 없음(E2-a),
 *    Infinity 면 전부 부모로(E2-b small-to-big), 2 면 상위 2개만(E2-c·5.2 F).
 *  - 이미 넣은 부모에 속한 청크는 다시 넣지 않는다(같은 글을 두 번 보내지 않게).
 *  - 부모가 없는 청크는 확장 대상이어도 청크 그대로 둔다.
 */
export function assemblePack(
  rankedChunkIds: ReadonlyArray<string>,
  parentOf: (chunkId: string) => string | null,
  options: { size: number; expandTop: number },
): PackItem[] {
  const out: PackItem[] = [];
  const byId = new Map<string, PackItem>();
  const coveredParents = new Set<string>();
  for (let i = 0; i < rankedChunkIds.length && out.length < options.size; i += 1) {
    const cid = rankedChunkIds[i];
    const parent = parentOf(cid);
    if (parent && coveredParents.has(parent)) {
      byId.get(parent)?.sourceIds.push(cid);
      continue;
    }
    if (byId.has(cid)) continue;
    if (parent && out.length < options.expandTop) {
      const item: PackItem = { id: parent, sourceIds: [cid], expanded: true };
      out.push(item);
      byId.set(parent, item);
      coveredParents.add(parent);
      continue;
    }
    const item: PackItem = { id: cid, sourceIds: [cid], expanded: false };
    out.push(item);
    byId.set(cid, item);
  }
  return out;
}

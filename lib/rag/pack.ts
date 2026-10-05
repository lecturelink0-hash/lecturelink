/**
 * 단위 검색·근거 팩의 순수 계산 (RAG 실행계획 v1.1 · 5.2 E·F · PR H)
 *
 * 출제 단위(PR G)마다 질의 4개로 업로드 청크를 검색해 근거 팩을 만들고, 근거가 모자란 단위를 예비 단위로
 * 바꿔 끼운다(D3). 네트워크·DB 는 lib/rag/retrieve.ts 가 하고, 산식은 전부 여기 둔다 — 오프라인 평가
 * (scripts/rag-eval/pack-eval.ts)와 운영이 같은 식을 쓴다.
 *
 * 구성(E1~E3 확정 + PR H 판정, docs/naesin-rag-candidates/h-pack-results.md)
 *  - dense 단독: 질의마다 정확 코사인 top-20 → RRF 로 합침. sparse·리랭커 없음.
 *  - 근거 팩: RRF 상위 20개를 MMR(λ 0.7)로 다시 줄 세워 1,200자 청크 6개(난이도 '상'은 8개)를 글자 상한
 *    (4,500자, '상' 6,000자) 안에서 담는다. 부모 확장 없음.
 *  - 충분성: 단위의 최고 유사도(질의 4개 중 최대) ≥ τ.
 *  - 이미지 단위: 단위 질의와 그 그림 캡션 청크의 최고 유사도 ≥ τ 여야 이미지 칸에 들어간다(R5).
 *
 * 외부 모듈은 잎 모듈만 불러온다 — 검사 스크립트(`npm run check:rag-pack`)가 이 파일을 직접 불러온다.
 */
import { cosine, rrfFuse, topKByCosine } from './retrieval-math.ts';
import { unitFits, type PlanUnit, type SlotAssignment } from './plan.ts';
import { RAG_DEFAULTS } from './mode.ts';

export interface ChunkVec {
  id: string;
  chunkIndex: number;
  pageIndex: number;
  kind: string;
  modality: string;
  text: string;
  vec: ArrayLike<number>;
  imageId?: string | null;
}

/** pgvector 값은 PostgREST 로 '[0.1,0.2,…]' 문자열로 온다. 배열이면 그대로 쓴다. 못 읽으면 null. */
export function parseVector(v: unknown): number[] | null {
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === 'string' && v.startsWith('[')) {
    try {
      return (JSON.parse(v) as unknown[]).map(Number);
    } catch {
      return null;
    }
  }
  return null;
}

export const PACK_LIMITS = {
  /** 질의마다 가져오는 후보 수. */
  candidateK: RAG_DEFAULTS.candidateK,
  size: RAG_DEFAULTS.packSize,
  /** 근거 팩 글자 상한 ≈ 3k 토큰(계획 콜 실측 1.5자/토큰). */
  chars: RAG_DEFAULTS.packChars,
  /** 난이도 '상': 서로 다른 조건 3개를 결합해야 해 근거를 더 싣는다(5.2 F). */
  sizeHard: RAG_DEFAULTS.packSizeHard,
  charsHard: RAG_DEFAULTS.packCharsHard,
  /** 상한 때문에 잘라 담을 때 이보다 짧게 남으면 담지 않는다(인용할 수 없는 꼬리). */
  minTailChars: 200,
} as const;

export function packSizeFor(difficulty: string | null | undefined): { size: number; chars: number } {
  return difficulty === '상'
    ? { size: PACK_LIMITS.sizeHard, chars: PACK_LIMITS.charsHard }
    : { size: PACK_LIMITS.size, chars: PACK_LIMITS.chars };
}

export interface PackEntry {
  /** 근거 팩 안 표기(E1, E2 …). 생성이 인용할 때 쓰는 이름이다. */
  ref: string;
  chunkId: string;
  pageIndex: number;
  kind: string;
  /** 단위 질의 4개와의 최고 코사인. */
  score: number;
  text: string;
  truncated: boolean;
}

export interface UnitRetrieval {
  unitId: string;
  /** 질의 4개 각각의 1위 유사도 중 최대. τ 와 비교한다. */
  topScore: number;
  sufficient: boolean;
  /** 합친 후보 순위(최대 candidateK). */
  ranked: string[];
  pack: PackEntry[];
  packChars: number;
  /** 이미지 단위만: 그 그림 캡션 청크와의 최고 유사도와 일치 여부(R5). 캡션 청크가 없으면 null. */
  captionScore: number | null;
  captionMatch: boolean | null;
}

/**
 * MMR 순서 — 관련도(rel)와 이미 고른 것과의 중복을 저울질해 n 개를 고른다.
 * score = λ·rel − (1−λ)·max_sim(이미 고른 것). PR H 평가에서 채택 여부를 정한다(옵션).
 */
export function mmrOrder(
  candidates: readonly string[],
  rel: ReadonlyMap<string, number>,
  vecOf: (id: string) => ArrayLike<number> | undefined,
  lambda: number,
  n: number,
): string[] {
  const left = [...candidates];
  const out: string[] = [];
  while (out.length < n && left.length > 0) {
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < left.length; i += 1) {
      const v = vecOf(left[i]);
      let maxSim = 0;
      if (v) for (const s of out) {
        const w = vecOf(s);
        if (w) maxSim = Math.max(maxSim, cosine(v, w));
      }
      const score = lambda * (rel.get(left[i]) ?? 0) - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    out.push(left.splice(best, 1)[0]);
  }
  return out;
}

/**
 * 근거 팩 조립 — 순위대로 최대 size 개를 담되 글자 상한을 넘지 않게 한다. 상한을 넘는 항목은 남은 글자만큼
 * 잘라 담고(minTailChars 미만이면 담지 않음) 거기서 멈춘다. 순위가 낮은 근거부터 빠진다.
 */
export function buildPack(
  ordered: ReadonlyArray<Pick<ChunkVec, 'id' | 'pageIndex' | 'kind' | 'text'> & { score: number }>,
  size: number,
  charLimit: number,
): PackEntry[] {
  const out: PackEntry[] = [];
  let used = 0;
  for (const c of ordered) {
    if (out.length >= size) break;
    const room = charLimit - used;
    if (room <= 0) break;
    const truncated = c.text.length > room;
    if (truncated && room < PACK_LIMITS.minTailChars) break;
    const text = truncated ? `${c.text.slice(0, room - 1).trimEnd()}…` : c.text;
    out.push({ ref: `E${out.length + 1}`, chunkId: c.id, pageIndex: c.pageIndex, kind: c.kind, score: c.score, text, truncated });
    used += text.length;
    if (truncated) break;
  }
  return out;
}

/** 생성 입력용 근거 팩 텍스트. `[E1] (p.12, OCR) …` — 출처 종류가 다르면 표기한다(검수자·모델이 구분하게). */
export function formatPack(entries: readonly PackEntry[]): string {
  const label = (k: string) => (k === 'ocr' ? ', 그림 속 글자(OCR)' : k === 'image_caption' ? ', 그림 설명' : '');
  return entries.map((e) => `[${e.ref}] (p.${e.pageIndex}${label(e.kind)}) ${e.text}`).join('\n\n');
}

/**
 * 단위 하나를 검색한다. 질의 벡터 4개 → 질의별 top-k → RRF → MMR(RAG_DEFAULTS.mmrLambda, mmr 로 끄고 켬) → 근거 팩.
 * 근거 팩에는 본문·OCR 청크만 들어간다. figureImageIds 가 있으면(이미지 단위) 그 그림 캡션 청크와의 유사도로
 * R5 일치를 판정한다.
 */
export function retrieveUnit(
  unitId: string,
  queryVecs: ReadonlyArray<ArrayLike<number>>,
  chunks: readonly ChunkVec[],
  opts: { tau: number; size: number; chars: number; k?: number; mmr?: boolean; lambda?: number; figureImageIds?: readonly string[] },
): UnitRetrieval {
  const k = opts.k ?? PACK_LIMITS.candidateK;
  // 캡션 청크는 모델이 쓴 그림 설명이라 근거 팩에 넣지 않는다(자료 기반 원칙). 이미지 단위의 그림 일치 판정에만 쓴다.
  const docs = chunks.filter((c) => c.kind !== 'image_caption').map((c) => ({ id: c.id, vec: c.vec }));
  const byId = new Map(chunks.map((c) => [c.id, c]));
  const lists = queryVecs.map((q) => topKByCosine(q, docs, k));
  const topScore = lists.length > 0 ? Math.max(...lists.map((l) => l[0]?.score ?? 0)) : 0;
  const ranked = rrfFuse(lists.map((l) => l.map((s) => s.id))).slice(0, k).map((s) => s.id);
  const rel = new Map<string, number>();
  for (const id of ranked) {
    const v = byId.get(id)!.vec;
    rel.set(id, Math.max(0, ...queryVecs.map((q) => cosine(q, v))));
  }
  const lambda = opts.mmr === undefined ? RAG_DEFAULTS.mmrLambda : opts.mmr ? (opts.lambda ?? RAG_DEFAULTS.mmrLambda ?? 0.7) : null;
  const order = lambda !== null ? mmrOrder(ranked, rel, (id) => byId.get(id)?.vec, lambda, opts.size) : ranked;
  const pack = buildPack(
    order.map((id) => ({ ...byId.get(id)!, score: rel.get(id) ?? 0 })),
    opts.size,
    opts.chars,
  );
  let captionScore: number | null = null;
  if (opts.figureImageIds && opts.figureImageIds.length > 0) {
    const caps = chunks.filter((c) => c.kind === 'image_caption' && c.imageId && opts.figureImageIds!.includes(c.imageId));
    if (caps.length > 0) captionScore = Math.max(...caps.flatMap((c) => queryVecs.map((q) => cosine(q, c.vec))));
  }
  return {
    unitId,
    topScore,
    sufficient: topScore >= opts.tau,
    ranked,
    pack,
    packChars: pack.reduce((a, e) => a + e.text.length, 0),
    captionScore,
    captionMatch: captionScore === null ? (opts.figureImageIds?.length ? false : null) : captionScore >= opts.tau,
  };
}

export interface ReplacementResult {
  slots: SlotAssignment[];
  /** 근거가 모자라 예비 단위로 바꾼 칸 수. */
  replaced: number;
  /** 바꿀 예비가 없어 빈 칸이 된 수(D3 — 요청보다 적게 제공). */
  shortfall: number;
  /** 이미지 칸인데 캡션 일치(R5)를 못 해 텍스트로 넘긴 수. */
  imageSpilled: number;
}

/**
 * 근거 부족(D3) 처리 — 칸의 단위가 근거 부족이면 예비 단위 중 근거가 충분하고 칸 유형에 맞는 것을 앞에서부터
 * 바꿔 끼운다. 맞는 예비가 없으면 근거가 충분한 아무 예비나(유형 불일치), 그것도 없으면 빈 칸(shortfall).
 * 이미지 칸은 캡션 일치(R5)까지 해야 근거가 충분한 것으로 본다. 끝내 이미지 단위를 못 구하면 그 칸은 텍스트
 * 몫으로 넘긴다(imageSpilled, 묶음 시작 때 spillImageShortfall 과 같은 처리).
 */
export function replaceInsufficient(
  slots: readonly SlotAssignment[],
  units: readonly PlanUnit[],
  retrievals: ReadonlyMap<string, UnitRetrieval>,
): ReplacementResult {
  const okFor = (id: string, type: SlotAssignment['type']) => {
    const r = retrievals.get(id);
    if (!r?.sufficient) return false;
    return type === 'image' ? r.captionMatch === true : true;
  };
  const used = new Set(slots.map((s) => s.unitId).filter((x): x is string => Boolean(x)));
  const reserve = units.filter((u) => !used.has(u.id));
  const take = (type: SlotAssignment['type'], requireFit: boolean) =>
    reserve.find((u) => !used.has(u.id) && okFor(u.id, type) && (!requireFit || unitFits(u, type)));
  let replaced = 0;
  let shortfall = 0;
  let imageSpilled = 0;
  const out = slots.map((s) => ({ ...s }));
  for (const s of out) {
    if (s.unitId && okFor(s.unitId, s.type)) continue;
    if (s.type === 'image') {
      const img = take('image', true);
      if (img) {
        used.add(img.id);
        s.unitId = img.id;
        s.fit = true;
        replaced += 1;
        continue;
      }
      // 이미지 단위를 못 구하면 텍스트 몫으로 넘긴다. 지금 단위가 텍스트로는 근거가 충분하면 그대로 둔다.
      imageSpilled += 1;
      s.type = 'free';
      s.fit = false;
      if (s.unitId && okFor(s.unitId, 'free')) continue;
    }
    const fitting = take(s.type, true);
    const pick = fitting ?? take(s.type, false);
    if (pick) {
      used.add(pick.id);
      s.unitId = pick.id;
      s.fit = Boolean(fitting);
      replaced += 1;
    } else {
      s.unitId = null;
      s.fit = false;
      shortfall += 1;
    }
  }
  return { slots: out, replaced, shortfall, imageSpilled };
}

/** 진단용 요약(수치만). */
export function retrievalStats(retrievals: readonly UnitRetrieval[]) {
  const scores = retrievals.map((r) => r.topScore).sort((a, b) => a - b);
  const chars = retrievals.map((r) => r.packChars);
  const img = retrievals.filter((r) => r.captionMatch !== null);
  const q = (p: number) => (scores.length ? Math.round(scores[Math.min(scores.length - 1, Math.floor(p * scores.length))] * 1000) / 1000 : 0);
  return {
    units: retrievals.length,
    sufficient: retrievals.filter((r) => r.sufficient).length,
    topScoreMin: q(0),
    topScoreP50: q(0.5),
    packCharsAvg: chars.length ? Math.round(chars.reduce((a, b) => a + b, 0) / chars.length) : 0,
    packCharsMax: chars.length ? Math.max(...chars) : 0,
    packTruncated: retrievals.filter((r) => r.pack.some((e) => e.truncated)).length,
    imageUnits: img.length,
    imageCaptionMatch: img.filter((r) => r.captionMatch === true).length,
  };
}

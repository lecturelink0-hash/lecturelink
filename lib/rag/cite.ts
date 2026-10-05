/**
 * 인용 검증 — 생성 문항의 evidence_refs 를 근거 팩 원문과 대조한다 (RAG 실행계획 v1.1 · 5.2 H · PR I)
 *
 * LLM 을 부르지 않는다. 판정은 "quote 가 그 청크에서 왔는가"(구조적 출처 유효성)까지만이다. 그 구절이 정말
 * 정답의 근거인지(의미상 유효성)는 사람 라벨(R3·E4)의 몫이고, 여기서 판정하는 척하지 않는다.
 *
 * 규칙 (사전 판정 기준에 고정, docs/naesin-rag-candidates/i-cite-results.md)
 *  - 정규화: NFKC → 소문자 → 따옴표·대시·가운뎃점 통일 → 공백(폭 없는 공백 포함) 전부 제거.
 *    PDF 추출본과 모델 출력은 띄어쓰기가 자주 달라 공백을 비교에서 뺀다.
 *  - 부분 일치율 = 1 − (quote 를 청크의 어떤 부분 문자열로 바꾸는 최소 편집 거리 / quote 길이).
 *    청크 안에 그대로 있으면 1. 임계 0.90(E4 에서 다시 정함).
 *  - 정규화 후 8자 미만 quote 는 불합격(짧은 약어 하나는 어디에나 있다).
 *  - 같은 묶음의 다른 근거에서 일치하면 그 근거로 바로잡는다(재귀속). 원문에서 온 구절이라는 사실은 같다.
 *  - 문항 판정: 엄격(인용 1개 이상 + 모든 인용 합격)과 관대(합격 인용 1개 이상)를 둘 다 낸다. 생성 경로는 citationAccepted 로
 *    고른다 — PR I 은 엄격, PR J 부터 관대(틀린 인용은 저장하지 않으므로 저장되는 인용은 전부 검증된 것). j-dedup-results.md 4장.
 *
 * 외부 모듈은 타입만 불러온다 — 검사 스크립트(`npm run check:rag-cite`)가 이 파일을 직접 불러온다.
 */
import type { SourceRefs } from '../ai/source-refs.ts';

export const CITE_LIMITS = {
  /** 부분 일치율 임계(E4 초기값). */
  threshold: 0.9,
  /** 정규화 후 최소 글자 수. */
  minQuoteChars: 8,
  /** 문항당 검사하는 인용 수 상한(도구 스키마 maxItems 와 같다). 넘치는 것은 보지 않는다. */
  maxRefs: 3,
  /** 정규화 후 이보다 긴 quote 는 검사하지 않고 불합격(비정상 출력 방어 — 지시는 120자 이내). */
  maxQuoteChars: 1_500,
  /** 저장하는 quote 상한(원문 그대로, 정규화 전). */
  storedQuoteChars: 300,
  /**
   * 문항을 남기는 기준. 'lenient' = 원문과 맞는 인용이 1개 이상(틀린 인용은 버림), 'strict' = 모든 인용이 맞아야 함.
   * PR J 수정(1회): 엄격 기준의 교정 뒤 폐기가 6.0~6.6% 로 I5(≤5%)를 넘었고, 실패 인용은 거의 다 "여러 줄을 건너뛰며 이어 붙인"
   * 구절이라 정규화로 구제되지 않았다(재생 160문항 중 0). 관대 기준의 첫 응답 통과는 0.99.
   */
  questionRule: 'lenient' as 'lenient' | 'strict',
} as const;

/** 생성 경로가 문항을 남길지 — CITE_LIMITS.questionRule 을 따른다. */
export function citationAccepted(v: { ok: boolean; lenientOk: boolean }, rule: 'lenient' | 'strict' = CITE_LIMITS.questionRule): boolean {
  return rule === 'strict' ? v.ok : v.lenientOk;
}

/** 생성에 준 근거 청크 하나. text 는 모델에게 실제로 보인 글(팩에 잘려 담겼으면 잘린 글)이다. */
export interface EvidenceChunk {
  ref: string;
  chunkId: string;
  pageIndex: number;
  kind: string;
  text: string;
  /** 단위 질의와의 최고 코사인(PR H). */
  score: number;
  /** 처음 담긴 단위 팩 안 순위(1부터). */
  rank: number;
  /** 처음 담긴 단위. */
  unitId: string;
}

export type CiteFailReason = 'unknown_ref' | 'short_quote' | 'long_quote' | 'mismatch';

export interface VerifiedCitation {
  ref: string;
  chunkId: string;
  pageIndex: number;
  /** 모델이 쓴 구절(정규화 전, 앞뒤 공백·따옴표만 걷음). */
  quote: string;
  match: number;
  score: number;
  rank: number;
  /** 모델이 적은 번호가 틀려 다른 근거로 바로잡았으면 그 원래 번호. */
  reattributedFrom?: string;
}

export interface CitationVerdict {
  /** 엄격 판정 — 인용 1개 이상 + 모든 인용 합격. */
  ok: boolean;
  /** 관대 판정 — 합격 인용 1개 이상(보고용). */
  lenientOk: boolean;
  /** 합격한 인용(엄격 판정이 불합격이어도 합격분은 담는다). */
  citations: VerifiedCitation[];
  failures: Array<{ ref: string; reason: CiteFailReason; match: number }>;
  /** 인용이 하나도 없었는가. */
  empty: boolean;
  reattributed: number;
}

const QUOTE_CHARS = /[‘’‚‛′`´]/g;
const DQUOTE_CHARS = /[“”„‟″«»「」『』]/g;
const DASH_CHARS = /[‐‑‒–—―−﹘﹣－]/g;
const DOT_CHARS = /[·•∙・ㆍ･]/g;
const SPACE_CHARS = /[\s​‌‍⁠﻿]+/g;

/** 비교용 정규화. 저장·표시에는 쓰지 않는다. */
export function normalizeForCite(s: string): string {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(QUOTE_CHARS, "'")
    .replace(DQUOTE_CHARS, '"')
    .replace(DASH_CHARS, '-')
    .replace(DOT_CHARS, '·')
    .replace(SPACE_CHARS, '');
}

/** p 를 t 의 어떤 부분 문자열로 바꾸는 최소 편집 거리(Sellers 반전역 정렬). O(|p|·|t|). */
export function substringEditDistance(p: string, t: string): number {
  const m = p.length;
  const n = t.length;
  if (m === 0) return 0;
  if (n === 0) return m;
  let prev = new Int32Array(n + 1); // i=0 행: 어디서 시작해도 비용 0
  let cur = new Int32Array(n + 1);
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    const pc = p.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      const sub = prev[j - 1] + (pc === t.charCodeAt(j - 1) ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  let best = m;
  for (let j = 0; j <= n; j += 1) if (prev[j] < best) best = prev[j];
  return best;
}

/** 정규화한 두 글의 부분 일치율(0~1). 이미 정규화된 글을 받는다. */
export function partialMatchNormalized(qn: string, tn: string): number {
  if (qn.length === 0) return 0;
  if (tn.includes(qn)) return 1;
  const ratio = 1 - substringEditDistance(qn, tn) / qn.length;
  return Math.max(0, Math.round(ratio * 10_000) / 10_000);
}

/** quote 가 text 안에 얼마나 그대로 있는가(0~1). */
export function partialMatchRatio(quote: string, text: string): number {
  return partialMatchNormalized(normalizeForCite(quote), normalizeForCite(text));
}

/** "E1", "[E1]", "e 1", "E-1", "근거 E1" → "E1". 못 읽으면 null. */
export function normalizeRefId(raw: unknown): string | null {
  const m = /e\s*[-_]?\s*(\d{1,3})/i.exec(String(raw ?? '').normalize('NFKC'));
  return m ? `E${Number(m[1])}` : null;
}

/** 모델 출력의 evidence_refs 를 {ref, quote} 목록으로 읽는다. 형식이 틀린 항목은 버린다. */
export function parseEvidenceRefs(raw: unknown): Array<{ ref: string | null; rawRef: string; quote: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ ref: string | null; rawRef: string; quote: string }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const rawRef = String(rec.id ?? rec.ref ?? '').trim();
    const quote = String(rec.quote ?? '')
      .trim()
      .replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '')
      .trim();
    if (!rawRef && !quote) continue;
    const ref = normalizeRefId(rawRef);
    const key = `${ref ?? rawRef}\u0000${normalizeForCite(quote)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref, rawRef, quote });
    if (out.length >= CITE_LIMITS.maxRefs) break;
  }
  return out;
}

/** 한 문항의 인용을 그 묶음의 근거와 대조한다. */
export function verifyCitations(
  raw: unknown,
  evidence: ReadonlyMap<string, EvidenceChunk>,
  opts: { threshold?: number; minQuoteChars?: number } = {},
): CitationVerdict {
  const threshold = opts.threshold ?? CITE_LIMITS.threshold;
  const minChars = opts.minQuoteChars ?? CITE_LIMITS.minQuoteChars;
  const refs = parseEvidenceRefs(raw);
  const normCache = new Map<string, string>();
  const normOf = (c: EvidenceChunk) => {
    let v = normCache.get(c.ref);
    if (v === undefined) {
      v = normalizeForCite(c.text);
      normCache.set(c.ref, v);
    }
    return v;
  };
  const citations: VerifiedCitation[] = [];
  const failures: CitationVerdict['failures'] = [];
  let reattributed = 0;
  for (const r of refs) {
    const label = r.ref ?? (r.rawRef || '?');
    const qn = normalizeForCite(r.quote);
    if (qn.length < minChars) {
      failures.push({ ref: label, reason: 'short_quote', match: 0 });
      continue;
    }
    if (qn.length > CITE_LIMITS.maxQuoteChars) {
      failures.push({ ref: label, reason: 'long_quote', match: 0 });
      continue;
    }
    const cited = r.ref ? evidence.get(r.ref) : undefined;
    const citedMatch = cited ? partialMatchNormalized(qn, normOf(cited)) : 0;
    let chosen: EvidenceChunk | undefined = citedMatch >= threshold ? cited : undefined;
    let match = citedMatch;
    if (!chosen) {
      // 다른 근거에서 왔는지 본다 — 번호만 틀린 인용을 버리지 않는다.
      for (const c of evidence.values()) {
        if (c === cited) continue;
        const m = partialMatchNormalized(qn, normOf(c));
        if (m >= threshold && (!chosen || m > match)) {
          chosen = c;
          match = m;
        }
      }
      if (chosen) reattributed += 1;
    }
    if (!chosen) {
      failures.push({ ref: label, reason: cited ? 'mismatch' : 'unknown_ref', match: citedMatch });
      continue;
    }
    citations.push({
      ref: chosen.ref,
      chunkId: chosen.chunkId,
      pageIndex: chosen.pageIndex,
      quote: r.quote.slice(0, CITE_LIMITS.storedQuoteChars),
      match,
      score: chosen.score,
      rank: chosen.rank,
      ...(chosen !== cited ? { reattributedFrom: label } : {}),
    });
  }
  return {
    ok: refs.length > 0 && failures.length === 0,
    lenientOk: citations.length > 0,
    citations,
    failures,
    empty: refs.length === 0,
    reattributed,
  };
}

/** 인용에서 파생한 출처(source_refs) — 페이지는 인용 청크의 쪽, 청크 id 는 인용 청크만. */
export function sourceRefsFromCitations(citations: readonly VerifiedCitation[], fileSha256: string | null): SourceRefs {
  const pages = [...new Set(citations.map((c) => c.pageIndex))].sort((a, b) => a - b);
  const chunkIds = [...new Set(citations.map((c) => c.chunkId))];
  return { fileSha256, pages, chunkIds, reportedPages: pages, invalidPages: [] };
}

/** private_questions.evidence 저장 형태(계획서 5.2 K): [{chunk_id, page, quote, match, score, rank, role}]. */
export function storedEvidence(citations: readonly VerifiedCitation[]): Array<Record<string, unknown>> {
  return citations.map((c) => ({
    chunk_id: c.chunkId,
    page: c.pageIndex,
    quote: c.quote,
    match: c.match,
    score: Math.round(c.score * 10_000) / 10_000,
    rank: c.rank,
    role: 'cite',
    ...(c.reattributedFrom ? { reattributed_from: c.reattributedFrom } : {}),
  }));
}

/** 묶음 진단용 집계(수치만 — 인용 문구 없음). */
export function citationStats(verdicts: readonly CitationVerdict[]) {
  const n = verdicts.length;
  const reasons: Record<CiteFailReason, number> = { unknown_ref: 0, short_quote: 0, long_quote: 0, mismatch: 0 };
  for (const v of verdicts) for (const f of v.failures) reasons[f.reason] += 1;
  return {
    questions: n,
    ok: verdicts.filter((v) => v.ok).length,
    lenientOk: verdicts.filter((v) => v.lenientOk).length,
    empty: verdicts.filter((v) => v.empty).length,
    citations: verdicts.reduce((a, v) => a + v.citations.length, 0),
    reattributed: verdicts.reduce((a, v) => a + v.reattributed, 0),
    reasons,
  };
}

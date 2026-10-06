/**
 * 세트 전체 중복 — 문항 임베딩으로 같은 세트 안·같은 자료의 이전 세트와 겹치는 문항을 찾는다
 * (RAG 실행계획 v1.1 · 5.2 J · PR J)
 *
 * 판정 규칙(J1 보정, docs/naesin-rag-candidates/j-dedup-results.md)
 *  - 문항 임베딩 입력: DEDUP_DEFAULTS.input (발문 + 정답 선지 등) — J1 에서 LLM 라벨 AUC 로 고름
 *  - 폐기 임계: DEDUP_DEFAULTS.threshold — 라벨 정밀도 0.90 이상인 가장 낮은 코사인
 *  - 세트 안: generation_slot 순으로 보며 앞 문항과 임계 이상이면 뒤 문항이 중복(먼저 만든 것을 남긴다)
 *  - 세트 간: 같은 사용자·같은 자료(content_sha256)의 다른 업로드 문항과 임계 이상이면 이번 문항이 중복
 *    (DB 함수 match_private_questions — 이 파일 밖)
 *
 * 외부 모듈을 불러오지 않는다 — 검사 스크립트(`npm run check:rag-dedup`)가 이 파일을 직접 불러온다.
 */

export const DEDUP_DEFAULTS = {
  /** 문항 임베딩 입력(J1): 'stem' | 'stem_answer' | 'stem_choices'. 라벨 AUC 0.673 / 0.862 / 0.764 → 발문 + 정답 선지. */
  input: 'stem_answer' as 'stem' | 'stem_answer' | 'stem_choices',
  /**
   * 폐기 임계(코사인, J1 — 골든셋 519문항·라벨 669쌍). 정밀도 0.90 이상인 가장 낮은 값 = 0.93(정밀도 0.917, 라벨 중복의 44% 회수).
   * 0.92 는 정밀도 0.839 라 멀쩡한 문항을 6개 중 1개꼴로 지운다.
   */
  threshold: 0.93,
  /** G1 '중복 문항률'의 정의 임계(계획서 7장) — 폐기 임계와 별개로 계측에 쓴다. */
  g1Threshold: 0.92,
  /** 세트 간 조회 수(문항당). 하나만 있어도 중복이라 1 이면 충분하다. */
  crossK: 1,
} as const;

export interface DedupQuestion {
  stem: string;
  choices: string[];
  answer_index: number;
}

/** 문항 임베딩 입력 글. 강의 원문이 아니라 문항 글이다. */
export function questionEmbeddingText(q: DedupQuestion, input: (typeof DEDUP_DEFAULTS)['input'] = DEDUP_DEFAULTS.input): string {
  const stem = String(q.stem ?? '').trim();
  const choices = (q.choices ?? []).map((c) => String(c ?? '').trim());
  if (input === 'stem') return stem;
  if (input === 'stem_choices') return `${stem}\n선지: ${choices.join(' | ')}`;
  return `${stem}\n정답: ${choices[q.answer_index] ?? ''}`;
}

export interface DedupItem {
  id: string;
  slot: number;
  /** L2 정규화된 벡터. */
  vec: number[];
}

export interface DuplicateHit {
  id: string;
  slot: number;
  /** 겹친 상대 문항 id. */
  of: string;
  cos: number;
  scope: 'within' | 'cross';
}

export function cosineUnit(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}

/**
 * 세트 안 중복 — slot 오름차순으로 보며, 이미 남기기로 한 앞 문항과 임계 이상이면 중복으로 표시한다.
 * 중복으로 표시된 문항은 비교 기준에서 빠진다(A≈B≈C 사슬에서 B 를 지우면 C 는 A 와 직접 비교한다).
 */
export function findWithinSetDuplicates(items: readonly DedupItem[], threshold: number = DEDUP_DEFAULTS.threshold): DuplicateHit[] {
  const sorted = [...items].sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id));
  const kept: DedupItem[] = [];
  const hits: DuplicateHit[] = [];
  for (const it of sorted) {
    let best: { of: DedupItem; cos: number } | null = null;
    for (const k of kept) {
      const c = cosineUnit(it.vec, k.vec);
      if (c >= threshold && (!best || c > best.cos)) best = { of: k, cos: c };
    }
    if (best) hits.push({ id: it.id, slot: it.slot, of: best.of.id, cos: Math.round(best.cos * 10_000) / 10_000, scope: 'within' });
    else kept.push(it);
  }
  return hits;
}

/** 세트 안 쌍 가운데 임계 이상인 문항 수(뒤 문항 기준) — G1 '중복 문항률' 계측용. */
export function duplicateRate(items: readonly DedupItem[], threshold: number = DEDUP_DEFAULTS.g1Threshold): { duplicates: number; questions: number; rate: number | null } {
  const sorted = [...items].sort((a, b) => a.slot - b.slot || a.id.localeCompare(b.id));
  let duplicates = 0;
  sorted.forEach((it, i) => {
    if (sorted.slice(0, i).some((p) => cosineUnit(it.vec, p.vec) >= threshold)) duplicates += 1;
  });
  return { duplicates, questions: sorted.length, rate: sorted.length ? Math.round((duplicates / sorted.length) * 10_000) / 10_000 : null };
}

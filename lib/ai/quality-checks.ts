/**
 * 품질 게이트의 순수 판정부 — 스키마 검사와 중복 탐지 (분담표 A4)
 *
 * 계측·DB 에 기대지 않는 함수만 둔다. scripts/check-metrics.mjs 가 이 파일만 불러
 * 산식 회귀를 잡는다. 부수효과가 있는 실행부는 quality-gate.ts 에 있다.
 *
 * 중복 판정 두 가지 모드:
 *   - embedding: 벡터가 있는 경로(공용 문제은행)는 코사인 유사도.
 *   - lexical:   벡터가 없는 경로(내신대비 private_questions 에는 embedding 컬럼이 없다)는
 *                문자 트라이그램 Jaccard. 임베딩을 새로 뽑으면 문항마다 API 비용이 붙는데,
 *                재생성 중복은 표현까지 거의 같게 나오는 편이라 어휘 유사도로 충분히 잡힌다.
 *                다만 **근사**다 — 뜻만 같고 표현이 다른 중복은 놓친다. 이 한계는 지표를
 *                보고할 때 함께 밝힌다.
 *
 * import 에 .ts 확장자를 붙인 이유: node --experimental-strip-types 로 도는 검사
 * 스크립트가 확장자 없는 상대 경로를 해석하지 못한다. tsconfig 가 noEmit +
 * moduleResolution:bundler 라 타입체크와 Next 빌드 양쪽에서 유효하다.
 */
import { lintKmleQuestion } from './kmle-format.ts';
import { DUPLICATE_SIMILARITY_THRESHOLD } from './versions.ts';

export interface GateQuestion {
  stem?: unknown;
  choices?: unknown;
  answer_index?: unknown;
  explanation?: unknown;
}

export interface SchemaViolation {
  index: number;
  code: string;
}

export interface DuplicatePair {
  index: number;
  /** 비교 대상. 같은 배치 안이면 문항 번호, 기존 문항이면 그 식별자. */
  against: string;
  similarity: number;
}

export interface GateResult {
  questions: number;
  schemaViolations: SchemaViolation[];
  duplicates: DuplicatePair[];
  /** 위반이 하나도 없으면 true. 계측의 schema_valid 로 들어간다. */
  valid: boolean;
  mode: 'embedding' | 'lexical';
  threshold: number;
}

// 선지 수는 KMLE 규격상 5개다. 4개나 6개는 화면이 조용히 깨지는 자리다.
const REQUIRED_CHOICES = 5;
const MAX_STEM_CHARS = 4000;
const MIN_STEM_CHARS = 5;

/**
 * 문항 하나의 계약 검사 — 필수 필드, 자료형, 허용 범위.
 * 형식(선지 정렬·표현 규칙) 위반은 lintKmleQuestion 이 이미 판정하므로 재사용한다.
 */
export function checkQuestionSchema(question: GateQuestion): string[] {
  const problems: string[] = [];
  const { stem, choices, answer_index: answerIndex, explanation } = question;

  if (typeof stem !== 'string') problems.push('type:stem');
  else if (stem.trim().length < MIN_STEM_CHARS) problems.push('empty:stem');
  else if (stem.length > MAX_STEM_CHARS) problems.push('range:stem');

  if (!Array.isArray(choices)) {
    problems.push('type:choices');
  } else {
    if (choices.length !== REQUIRED_CHOICES) problems.push('range:choices');
    if (choices.some((c) => typeof c !== 'string' || !c.trim())) problems.push('empty:choice');
    const seen = new Set(choices.map((c) => String(c).trim()));
    // 같은 선지가 두 번 있으면 정답이 둘이 되거나 오답이 기능하지 않는다.
    if (seen.size !== choices.length) problems.push('duplicate:choice');
  }

  if (typeof answerIndex !== 'number' || !Number.isInteger(answerIndex)) {
    problems.push('type:answer_index');
  } else if (!Array.isArray(choices) || answerIndex < 0 || answerIndex >= choices.length) {
    // 범위를 벗어난 정답 인덱스는 화면상 멀쩡한데 채점만 틀리는 사고다.
    problems.push('range:answer_index');
  }

  if (typeof explanation !== 'string') problems.push('type:explanation');
  else if (!explanation.trim()) problems.push('empty:explanation');

  // 형식 규격 위반 — 자동 교정이 위험해 지적만 하는 항목들.
  if (typeof stem === 'string' && Array.isArray(choices) && typeof answerIndex === 'number') {
    for (const issue of lintKmleQuestion({
      stem,
      choices: choices.map((c) => String(c)),
      answer_index: answerIndex,
    })) {
      problems.push(`format:${issue.rule}`);
    }
  }
  return problems;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 비교용 정규화 — 공백·문장부호·번호 매김을 걷어낸다. 표현 차이가 아니라 내용을 본다. */
export function normalizeForCompare(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[①②③④⑤]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

function trigrams(text: string): Set<string> {
  const normalized = normalizeForCompare(text);
  const out = new Set<string>();
  if (normalized.length < 3) {
    if (normalized) out.add(normalized);
    return out;
  }
  for (let i = 0; i <= normalized.length - 3; i += 1) out.add(normalized.slice(i, i + 3));
  return out;
}

/** 문자 트라이그램 Jaccard. 한국어는 공백 분절이 불안정해 어절보다 문자 n-gram 이 안정적이다. */
export function lexicalSimilarity(a: string, b: string): number {
  const setA = trigrams(a);
  const setB = trigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const gram of setA) if (setB.has(gram)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

export interface DuplicateCandidate {
  index: number;
  text: string;
  embedding?: number[] | null;
}

export interface PriorItem {
  id: string;
  text: string;
  embedding?: number[] | null;
}

/**
 * 중복 탐지. 같은 배치 안끼리, 그리고 기존 문항과 비교한다.
 * 배치 안 비교를 빠뜨리면 "한 번에 10개를 뽑았는데 그중 3개가 같은 문제"를 못 잡는다.
 */
export function findDuplicates(
  candidates: DuplicateCandidate[],
  priors: PriorItem[] = [],
  threshold = DUPLICATE_SIMILARITY_THRESHOLD,
): { duplicates: DuplicatePair[]; mode: 'embedding' | 'lexical' } {
  const useEmbedding =
    candidates.length > 0 &&
    candidates.every((c) => Array.isArray(c.embedding) && c.embedding.length > 0);
  const mode: 'embedding' | 'lexical' = useEmbedding ? 'embedding' : 'lexical';
  const score = (a: DuplicateCandidate, b: { text: string; embedding?: number[] | null }): number =>
    useEmbedding && Array.isArray(b.embedding) && b.embedding.length > 0
      ? cosineSimilarity(a.embedding as number[], b.embedding)
      : lexicalSimilarity(a.text, b.text);

  const duplicates: DuplicatePair[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    let best: DuplicatePair | null = null;
    for (let j = 0; j < i; j += 1) {
      const similarity = score(candidates[i], candidates[j]);
      if (similarity >= threshold && (!best || similarity > best.similarity)) {
        best = { index: candidates[i].index, against: `#${candidates[j].index}`, similarity };
      }
    }
    for (const prior of priors) {
      const similarity = score(candidates[i], prior);
      if (similarity >= threshold && (!best || similarity > best.similarity)) {
        best = { index: candidates[i].index, against: prior.id, similarity };
      }
    }
    if (best) duplicates.push({ ...best, similarity: Math.round(best.similarity * 10000) / 10000 });
  }
  return { duplicates, mode };
}

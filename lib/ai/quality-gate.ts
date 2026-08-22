/**
 * 저장 직전 품질 게이트 — 실행부 (성능지표 가이드 §2.1 · 분담표 A4)
 *
 * 가이드가 요구하는 두 지표:
 *   - 스키마 준수율: 필수 필드, 자료형, 허용 범위 검사
 *   - 중복 문항률: 높은 유사도 표본은 사람이 재확인
 *
 * **막지 않고 표시한다.** 여기서 저장을 거절하면 이미 생성 비용을 치른 문항이 통째로
 * 사라지고 사용자는 "10문항 요청했는데 7개만 나왔다"를 보게 된다. 위반은 계측에 남기고
 * 임계를 넘은 표본만 사람이 다시 보게 표시하는 것이 가이드의 지시이기도 하다.
 *
 * 판정 산식은 quality-checks.ts 에 있다(검사 스크립트가 그 파일만 불러 회귀를 잡는다).
 */
import { recordQuality } from '../metrics/request-context';
import { DUPLICATE_SIMILARITY_THRESHOLD } from './versions';
import {
  checkQuestionSchema,
  findDuplicates,
  type GateQuestion,
  type GateResult,
  type PriorItem,
  type SchemaViolation,
} from './quality-checks';

export {
  checkQuestionSchema,
  findDuplicates,
  cosineSimilarity,
  lexicalSimilarity,
  normalizeForCompare,
} from './quality-checks';
export type {
  GateQuestion,
  GateResult,
  PriorItem,
  SchemaViolation,
  DuplicateCandidate,
  DuplicatePair,
} from './quality-checks';

/**
 * 게이트 실행 + 계측 기록.
 *
 * 계측에는 **개수만** 남긴다 — 발문이나 선지를 계측 테이블에 넣으면 강의 내용이
 * 운영 로그로 새고, 그 테이블은 관리자 전체가 본다.
 */
export function runQualityGate(input: {
  questions: GateQuestion[];
  texts?: string[];
  embeddings?: Array<number[] | null>;
  priors?: PriorItem[];
  threshold?: number;
}): GateResult {
  const threshold = input.threshold ?? DUPLICATE_SIMILARITY_THRESHOLD;
  const schemaViolations: SchemaViolation[] = [];
  input.questions.forEach((question, index) => {
    for (const code of checkQuestionSchema(question)) schemaViolations.push({ index, code });
  });

  const texts =
    input.texts ??
    input.questions.map((q) =>
      [q.stem, ...(Array.isArray(q.choices) ? q.choices : [])].map((v) => String(v ?? '')).join(' '),
    );
  const { duplicates, mode } = findDuplicates(
    texts.map((text, index) => ({ index, text, embedding: input.embeddings?.[index] ?? null })),
    input.priors ?? [],
    threshold,
  );

  const result: GateResult = {
    questions: input.questions.length,
    schemaViolations,
    duplicates,
    valid: schemaViolations.length === 0,
    mode,
    threshold,
  };

  recordQuality(result.valid, {
    questions: result.questions,
    schemaViolations: schemaViolations.length,
    duplicates: duplicates.length,
    duplicateMode: mode,
    duplicateThreshold: threshold,
    // 어떤 위반이 얼마나 났는지는 원인 파악에 필요하다. 코드만 세므로 내용은 새지 않는다.
    violationCodes: tally(schemaViolations.map((v) => v.code)),
  });
  return result;
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

/** 사람이 다시 볼 표본을 사람이 읽을 문장으로. 생성 경고(warnings)에 넣는다. */
export function describeGate(result: GateResult): string[] {
  const messages: string[] = [];
  if (result.schemaViolations.length > 0) {
    const codes = tally(result.schemaViolations.map((v) => v.code));
    messages.push(
      `품질 게이트: 형식·계약 위반 ${result.schemaViolations.length}건 ` +
        `(${Object.entries(codes).map(([c, n]) => `${c}×${n}`).join(', ')})`,
    );
  }
  if (result.duplicates.length > 0) {
    messages.push(
      `품질 게이트: 중복 의심 ${result.duplicates.length}문항 ` +
        `(${result.mode} 유사도 ≥ ${result.threshold}) — 사람이 재확인 필요`,
    );
  }
  return messages;
}

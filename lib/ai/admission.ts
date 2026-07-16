/**
 * Admission Gate — 문항 생성·검증·태깅·저장 통합 파이프라인
 *
 * 흐름:
 *   1. Sonnet 으로 N개 문항 생성
 *   2. 각 문항을 Haiku 로 검증 (severity 판정)
 *   3. 통과한 문항은 Haiku 로 메타데이터 태깅
 *   4. 검증 등급에 따라 tier 결정:
 *      - severity 'none'    & score >= 0.85 → community
 *      - severity 'minor'   or score 0.6~0.85 → beta (사람 검수 대기)
 *      - severity 'major'   or 'critical' → reject (admission 안 함)
 *   5. questions 테이블에 admission
 *
 * 모든 단계의 토큰 비용 추적.
 */

import { generateQuestions, type GenerationInput } from './generate';
import { verifyQuestion } from './verify';
import { tagQuestion } from './tag';
import { embedText, buildEmbeddingText } from './embed';
import { recordAiCost } from './cost-cap';
import { createAdminClient } from '@/lib/db/admin';
import type {
  ContentSource,
  ContentTier,
  MedicalImageType,
} from '@/lib/types/database';
import type { GeneratedQuestion } from '@/lib/types/domain';

export interface AdmissionInput {
  subjectId: string;
  subjectName: string;
  subTopicId: string;
  subTopicName: string;
  examRelevance: 1 | 2 | 3;
  isRiskCategory: boolean;
  difficulty: 1 | 2 | 3;
  count: number;
  style: 'kmle' | 'professor' | 'internal';
  source: ContentSource;            // 출처 (보통 'ai_generated' or 'ai_user_triggered')
  examples?: Array<{ stem: string; choices: string[]; explanation: string }>;
  imageContext?: {
    imageUrl: string;
    imageType: MedicalImageType;
  };
  createdBy?: string;              // 트리거한 사용자 (있을 경우)
  saveToDb?: boolean;              // 기본 true. false 면 시뮬레이션만.
}

export interface AdmittedQuestion {
  question: GeneratedQuestion;
  tier: ContentTier;
  verificationScore: number;
  verificationIssues: string[];
  concepts: string[];
  examRelevance: 1 | 2 | 3;
  imageDependency: 'required' | 'helpful' | 'none';
  clinicalSetting?: string;
  embedding: number[];
  dbId?: string;                   // DB 저장 후 부여된 ID
}

export interface RejectedQuestion {
  question: GeneratedQuestion;
  reason: string;
  severity: 'major' | 'critical';
  score: number;
  issues: string[];
}

export interface AdmissionResult {
  admitted: AdmittedQuestion[];
  rejected: RejectedQuestion[];
  totals: {
    generated: number;
    admittedCommunity: number;
    admittedBeta: number;
    rejected: number;
    duplicatesSkipped: number;
    totalCostUSD: number;
    totalDurationMs: number;
  };
}

/** 임베딩 코사인 유사도 — 중복 체크 임계값 */
const DUPLICATE_SIMILARITY_THRESHOLD = 0.93;

export async function admitGeneratedQuestions(
  input: AdmissionInput,
): Promise<AdmissionResult> {
  const startTime = Date.now();
  let totalCost = 0;

  // ───── 1. 생성 ─────
  const generation = await generateQuestions({
    subjectName: input.subjectName,
    subTopicName: input.subTopicName,
    examRelevance: input.examRelevance,
    isRiskCategory: input.isRiskCategory,
    difficulty: input.difficulty,
    style: input.style,
    examples: input.examples,
    imageContext: input.imageContext,
    count: input.count,
  });
  totalCost += generation.usage.costUSD;

  const admitted: AdmittedQuestion[] = [];
  const rejected: RejectedQuestion[] = [];

  // ───── 2. 각 문항 검증·태깅 (병렬 처리) ─────
  await Promise.all(
    generation.questions.map(async (question) => {
      // 검증
      const verification = await verifyQuestion({
        subjectName: input.subjectName,
        subTopicName: input.subTopicName,
        isRiskCategory: input.isRiskCategory,
        question,
      });
      totalCost += verification.usage.costUSD;

      // critical/major 는 reject
      if (
        verification.severity === 'critical' ||
        verification.severity === 'major' ||
        verification.score < 0.6
      ) {
        rejected.push({
          question,
          reason: verification.issues.join(' / ') || '품질 미달',
          severity:
            verification.severity === 'critical' ? 'critical' : 'major',
          score: verification.score,
          issues: verification.issues,
        });
        return;
      }

      // 태깅 + 임베딩 (병렬)
      const [tagging, embedding] = await Promise.all([
        tagQuestion({
          subjectName: input.subjectName,
          subTopicName: input.subTopicName,
          question,
        }),
        embedText({
          text: buildEmbeddingText({
            stem: question.stem,
            choices: question.choices,
            concepts: question.concepts,
            explanation: question.explanation,
          }),
          inputType: 'document',
        }),
      ]);
      totalCost += tagging.usage.costUSD + embedding.usage.costUSD;

      // tier 결정 (MVP 단계: severity·score 만으로 판정. 위험 영역 강제 beta 는 정식 출시 후 추가)
      let tier: ContentTier;
      if (verification.severity === 'none' && verification.score >= 0.85) {
        tier = 'community';
      } else {
        tier = 'beta';
      }

      admitted.push({
        question,
        tier,
        verificationScore: verification.score,
        verificationIssues: verification.issues,
        concepts: tagging.concepts,
        examRelevance: tagging.exam_relevance,
        imageDependency: tagging.image_dependency,
        clinicalSetting: tagging.clinical_setting,
        embedding: embedding.embedding,
      });
    }),
  );

  // ───── 2.5. 중복 체크 — pgvector RPC 호출 ─────
  let duplicatesSkipped = 0;
  if (input.saveToDb !== false && admitted.length > 0) {
    const admin = createAdminClient();
    const survivors: AdmittedQuestion[] = [];

    for (const a of admitted) {
      const { data: matches } = await admin.rpc('match_questions', {
        query_embedding: a.embedding,
        match_threshold: DUPLICATE_SIMILARITY_THRESHOLD,
        match_count: 1,
        exclude_ids: [],
        sub_topic_filter: [input.subTopicId],
      });

      if (matches && matches.length > 0) {
        duplicatesSkipped += 1;
        rejected.push({
          question: a.question,
          reason: `중복 (similarity ${(matches[0].similarity as number).toFixed(3)})`,
          severity: 'major',
          score: 1 - (matches[0].similarity as number),
          issues: ['풀에 유사도 0.93 이상인 문항이 이미 존재함'],
        });
      } else {
        survivors.push(a);
      }
    }

    admitted.length = 0;
    admitted.push(...survivors);
  }

  // ───── 3. DB 저장 (중복 통과한 문항만) ─────
  if (input.saveToDb !== false && admitted.length > 0) {
    const admin = createAdminClient();
    const rows = admitted.map((a) => ({
      sub_topic_id: input.subTopicId,
      stem: a.question.stem,
      choices: a.question.choices,
      answer_index: a.question.answer_index,
      explanation: a.question.explanation,
      concepts: a.concepts,
      difficulty: a.question.difficulty,
      image_url: input.imageContext?.imageUrl ?? null,
      image_type: input.imageContext?.imageType ?? null,
      source: input.source,
      tier: a.tier,
      status: 'active' as const,
      created_by: input.createdBy ?? null,
      embedding: a.embedding,
    }));

    const { data, error } = await admin
      .from('questions')
      .insert(rows)
      .select('id');

    if (error) {
      console.error('[admission] DB insert error:', error);
      throw new Error(`Admission DB 저장 실패: ${error.message}`);
    }

    // DB ID 매핑
    (data ?? []).forEach((row, i) => {
      if (admitted[i]) admitted[i].dbId = row.id;
    });
  }

  // ───── 4. 비용 로그 (캡 추적용) ─────
  await recordAiCost({
    userId: input.createdBy ?? null,
    endpoint: 'questions.admission',
    model: generation.usage.model,
    costUsd: totalCost,
    inputTokens: generation.usage.inputTokens,
    outputTokens: generation.usage.outputTokens,
    metadata: {
      subTopicId: input.subTopicId,
      count: input.count,
      admitted: admitted.length,
      rejected: rejected.length,
    },
  });

  return {
    admitted,
    rejected,
    totals: {
      generated: generation.questions.length,
      admittedCommunity: admitted.filter((a) => a.tier === 'community').length,
      admittedBeta: admitted.filter((a) => a.tier === 'beta').length,
      rejected: rejected.length - duplicatesSkipped,
      duplicatesSkipped,
      totalCostUSD: totalCost,
      totalDurationMs: Date.now() - startTime,
    },
  };
}

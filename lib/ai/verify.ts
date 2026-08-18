/**
 * 2-pass 검증 — Haiku 4.5
 *
 * 생성된 문항을 의학적 정확성 + 형식 측면에서 검수.
 * 결과에 따라 admission 등급 결정:
 *  - severity: critical / major → reject + 재생성
 *  - severity: minor → admission with 'beta' tier
 *  - severity: none → admission with 'community' tier
 *  - score > 0.85 → community
 *  - score 0.6~0.85 → beta (사람 검수 대기)
 *  - score < 0.6 → reject
 */

import type Anthropic from '@anthropic-ai/sdk';
import {
  getAnthropic,
  MODELS,
  calculateCost,
  withRetry,
  createMessage,
  type UsageRecord,
} from './client';
import {
  VERIFICATION_SYSTEM_PROMPT,
  VERIFICATION_TOOL_SCHEMA,
  PRIVATE_VERIFICATION_SYSTEM_PROMPT,
  buildVerificationUserMessage,
  buildPrivateVerificationUserMessage,
} from './prompts/verification';
import type { GeneratedQuestion, VerificationResult } from '@/lib/types/domain';
// 폐기 판정은 무거운 의존이 없는 잎 모듈에 둔다(스크립트가 그것만 import 해 검사한다).
export {
  isPrivateVerifyFailure,
  PRIVATE_VERIFY_REJECT_SCORE,
  type VerificationSeverity,
} from './verify-policy';
import type { VerificationSeverity } from './verify-policy';

export interface VerificationResponse extends VerificationResult {
  severity: VerificationSeverity;
  usage: UsageRecord;
}

export interface VerificationInput {
  subjectName: string;
  subTopicName: string;
  isRiskCategory: boolean;
  question: GeneratedQuestion;
  /**
   * 'shared'(기본) — 공유풀 admission 용. F 규격까지 본다.
   * 'private'      — 내신대비용. 형식은 코드가 보므로 **의학 내용 4가지만** 본다.
   *                  (형식을 섞으면 모델이 형식 지적으로 issues 를 채우고 의학 오류를 놓친다)
   */
  mode?: 'shared' | 'private';
  /** private 모드에서 "정답 근거가 자료에 있는가"를 대조할 원문. 앞부분만 실린다. */
  sourceText?: string;
}

export async function verifyQuestion(
  input: VerificationInput,
): Promise<VerificationResponse> {
  const client = getAnthropic();
  const model = MODELS.verification();
  const startTime = Date.now();

  const isPrivate = input.mode === 'private';
  const userMessage = isPrivate
    ? buildPrivateVerificationUserMessage({
        question: input.question,
        sourceText: input.sourceText,
      })
    : buildVerificationUserMessage({
        subjectName: input.subjectName,
        subTopicName: input.subTopicName,
        isRiskCategory: input.isRiskCategory,
        question: input.question,
      });

  const response = await withRetry(
    () =>
      createMessage(client, {
        model,
        max_tokens: 1500,
        system: [
          {
            type: 'text',
            text: isPrivate ? PRIVATE_VERIFICATION_SYSTEM_PROMPT : VERIFICATION_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [VERIFICATION_TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: 'verify_question' },
        messages: [{ role: 'user', content: userMessage }],
      }),
    // 내신 경로는 사용자가 화면 앞에서 기다리는 생성 흐름 안에서 돈다.
    // 5회 재시도는 그 자리에서 수십 초를 쓴다 — 짧게 끊고 호출자가 통과로 처리한다.
    { maxAttempts: isPrivate ? 2 : 5 },
  );

  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (!toolUseBlock) {
    throw new Error('[ai/verify] 도구 호출 응답이 없음');
  }

  const parsed = toolUseBlock.input as {
    passed: boolean;
    score: number;
    issues: string[];
    suggested_fixes?: string[];
    severity: VerificationSeverity;
  };

  const usage: UsageRecord = {
    model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    costUSD: calculateCost(
      model,
      response.usage.input_tokens,
      response.usage.output_tokens,
      response.usage.cache_read_input_tokens ?? 0,
      response.usage.cache_creation_input_tokens ?? 0,
    ),
    durationMs: Date.now() - startTime,
  };

  // MVP 단계: 일반 기준만 적용 (위험 영역 강화는 정식 출시 후 추가)
  const adjustedPassed = parsed.passed && parsed.score >= 0.6;

  return {
    passed: adjustedPassed,
    score: parsed.score,
    issues: parsed.issues,
    suggestedFixes: parsed.suggested_fixes,
    severity: parsed.severity,
    usage,
  };
}

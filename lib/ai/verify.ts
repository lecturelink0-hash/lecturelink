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
  buildVerificationUserMessage,
} from './prompts/verification';
import type { GeneratedQuestion, VerificationResult } from '@/lib/types/domain';

export type VerificationSeverity = 'none' | 'minor' | 'major' | 'critical';

export interface VerificationResponse extends VerificationResult {
  severity: VerificationSeverity;
  usage: UsageRecord;
}

export interface VerificationInput {
  subjectName: string;
  subTopicName: string;
  isRiskCategory: boolean;
  question: GeneratedQuestion;
}

export async function verifyQuestion(
  input: VerificationInput,
): Promise<VerificationResponse> {
  const client = getAnthropic();
  const model = MODELS.verification();
  const startTime = Date.now();

  const userMessage = buildVerificationUserMessage({
    subjectName: input.subjectName,
    subTopicName: input.subTopicName,
    isRiskCategory: input.isRiskCategory,
    question: input.question,
  });

  const response = await withRetry(() =>
    createMessage(client, {
      model,
      max_tokens: 1500,
      system: [
        {
          type: 'text',
          text: VERIFICATION_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [VERIFICATION_TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: 'verify_question' },
      messages: [{ role: 'user', content: userMessage }],
    }),
    { maxAttempts: 5 },
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

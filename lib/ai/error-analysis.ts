/**
 * 오답 사유 분석 — Haiku 4.5
 *
 * 약점 세부주제에서 학생이 틀린 문항과 **고른 선지**를 모아 오답 사유를 판정한다.
 * 결과의 targeting_brief 는 그대로 문항 생성 프롬프트에 실려, 그 사유를 겨냥한
 * 문항이 나오게 한다.
 *
 * 판정에 쓸 오답이 없으면 모델을 부르지 않고 null 을 돌려준다 — 근거 없는 사유를
 * 지어내 그걸로 문항을 만들면 "AI가 분석해줬다"는 또 하나의 거짓이 된다.
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
import { lintChoiceLeakage } from './kmle-format';
import {
  ERROR_ANALYSIS_SYSTEM_PROMPT,
  ERROR_ANALYSIS_TOOL_SCHEMA,
  ERROR_REASON_LABELS,
  buildErrorAnalysisUserMessage,
  type ErrorReason,
  type WrongAttemptItem,
} from './prompts/error-analysis';

export type { ErrorReason, WrongAttemptItem };
export { ERROR_REASON_LABELS };

export interface ConfusionPair {
  picked: string;
  correct: string;
  discriminator: string;
}

export interface ErrorAnalysis {
  primaryReason: ErrorReason;
  primaryLabel: string;
  secondaryReason?: ErrorReason;
  confidence: number;
  evidence: string;
  confusionPairs: ConfusionPair[];
  /** 문항 자체 결함으로 판정 근거에서 뺀 오답 번호(1-base). */
  flawedItems: number[];
  targetingBrief: string;
  /** 판정에 실제로 사용한 오답 수. 화면에 "오답 N건 기준"으로 밝히기 위함. */
  sampleSize: number;
  usage: UsageRecord;
}

/** 한 번의 판정에 넣는 오답 최대 개수. 프롬프트 비용과 판정 안정성의 절충. */
export const ERROR_ANALYSIS_SAMPLE_LIMIT = 8;

export interface ErrorAnalysisInput {
  subjectName: string;
  subTopicName: string;
  items: WrongAttemptItem[];
}

/**
 * 오답 사유를 판정한다. 판정할 오답이 없으면 null.
 *
 * 선지 누출이 심한 문항(F17 계열 위반)은 학생의 약점이 아니라 문항의 결함을
 * 반영하므로 입력에서 미리 걸러낸다. 전부 걸러지면 남은 것으로 판정하지 않는다.
 */
export async function analyzeWrongAttempts(
  input: ErrorAnalysisInput,
): Promise<ErrorAnalysis | null> {
  const usable = input.items.filter(
    (item) =>
      Array.isArray(item.choices) &&
      item.choices.length >= 2 &&
      item.selectedIndex !== item.answerIndex &&
      lintChoiceLeakage({
        stem: item.stem,
        choices: item.choices,
        answer_index: item.answerIndex,
      }).length === 0,
  );

  const items = (usable.length > 0 ? usable : []).slice(0, ERROR_ANALYSIS_SAMPLE_LIMIT);
  if (items.length === 0) return null;

  const client = getAnthropic();
  const model = MODELS.verification();
  const startTime = Date.now();

  const response = await withRetry(
    () =>
      createMessage(client, {
        model,
        max_tokens: 2000,
        system: [
          {
            type: 'text',
            text: ERROR_ANALYSIS_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [ERROR_ANALYSIS_TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: 'analyze_wrong_answers' },
        messages: [
          {
            role: 'user',
            content: buildErrorAnalysisUserMessage({
              subjectName: input.subjectName,
              subTopicName: input.subTopicName,
              items,
            }),
          },
        ],
      }),
    { maxAttempts: 5 },
  );

  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  if (!toolUseBlock) {
    throw new Error('[ai/error-analysis] 도구 호출 응답이 없음');
  }

  const parsed = toolUseBlock.input as {
    primary_reason: ErrorReason;
    secondary_reason?: ErrorReason;
    confidence: number;
    evidence: string;
    confusion_pairs?: ConfusionPair[];
    flawed_items?: number[];
    targeting_brief: string;
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

  return {
    primaryReason: parsed.primary_reason,
    primaryLabel: ERROR_REASON_LABELS[parsed.primary_reason] ?? '오답 사유 미상',
    secondaryReason: parsed.secondary_reason,
    confidence: parsed.confidence,
    evidence: parsed.evidence,
    confusionPairs: parsed.confusion_pairs ?? [],
    flawedItems: parsed.flawed_items ?? [],
    targetingBrief: parsed.targeting_brief,
    sampleSize: items.length,
    usage,
  };
}

/**
 * 판정 결과를 생성 프롬프트에 실을 문자열로 만든다.
 *
 * confidence 가 낮으면 브리프를 그대로 넘기지 않는다. 근거가 약한 판정으로 문항
 * 방향을 고정하면 엉뚱한 곳을 겨냥한 문항이 나온다.
 */
export const MIN_TARGETING_CONFIDENCE = 0.4;

export function buildErrorFocus(analysis: ErrorAnalysis | null): string | undefined {
  if (!analysis) return undefined;
  if (analysis.confidence < MIN_TARGETING_CONFIDENCE) return undefined;

  const pairs = analysis.confusionPairs
    .slice(0, 3)
    .map((p) => `- "${p.picked}"(학생 선택) vs "${p.correct}"(정답) — 가르는 소견: ${p.discriminator}`)
    .join('\n');

  return [
    `이 학생의 오답 사유: **${analysis.primaryLabel}** (오답 ${analysis.sampleSize}건 분석, 확신도 ${analysis.confidence.toFixed(2)})`,
    `판정 근거: ${analysis.evidence}`,
    pairs ? `혼동한 쌍:\n${pairs}` : '',
    `출제 지침: ${analysis.targetingBrief}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

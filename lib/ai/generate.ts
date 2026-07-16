/**
 * 문항 생성 — Sonnet 4.6
 *
 * 텍스트 기반 / Vision(이미지 기반) 두 모드 지원.
 * Tool use 로 구조화된 JSON 출력 강제.
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
  GENERATION_SYSTEM_PROMPT,
  GENERATION_TOOL_SCHEMA,
  buildGenerationUserMessage,
} from './prompts/generation';
import type { GeneratedQuestion, QuestionGenerationContext } from '@/lib/types/domain';

export interface GenerationResult {
  questions: GeneratedQuestion[];
  usage: UsageRecord;
}

export interface GenerationInput extends QuestionGenerationContext {
  count: number;  // 한 번에 생성할 문항 수
}

export async function generateQuestions(
  input: GenerationInput,
): Promise<GenerationResult> {
  const client = getAnthropic();
  const model = input.imageContext ? MODELS.vision() : MODELS.generation();
  const startTime = Date.now();

  const userMessage = buildGenerationUserMessage({
    subjectName: input.subjectName,
    subTopicName: input.subTopicName,
    examRelevance: input.examRelevance,
    isRiskCategory: input.isRiskCategory,
    difficulty: input.difficulty,
    style: input.style,
    examples: input.examples,
    count: input.count,
  });

  // SDK 0.32 의 ImageBlockParam.source 는 base64 만 모델돼 있고 url source 는 누락.
  // 런타임 API 는 url source 지원하므로 unknown 캐스팅으로 우회.
  const content = input.imageContext
    ? [
        {
          type: 'image',
          source: {
            type: 'url',
            url: input.imageContext.imageUrl,
          },
        },
        { type: 'text', text: userMessage },
      ]
    : userMessage;

  const response = await withRetry(() =>
    createMessage(client, {
      model,
      max_tokens: 8000,
      system: [
        {
          type: 'text',
          text: GENERATION_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [GENERATION_TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: 'generate_questions' },
      messages: [{ role: 'user', content }],
    }),
    // 무료 티어 429(분당 한도) 대응 — 서버 지시 대기 존중하며 더 오래 재시도.
    { maxAttempts: 5 },
  );

  // tool_use 블록 추출
  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (!toolUseBlock) {
    throw new Error('[ai/generate] 도구 호출 응답이 없음');
  }

  const parsed = toolUseBlock.input as { questions: GeneratedQuestion[] };

  if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
    throw new Error('[ai/generate] 빈 문항 배열');
  }

  // 형식 검증 (가벼운 sanity check)
  for (const q of parsed.questions) {
    if (q.choices.length !== 5) {
      throw new Error(
        `[ai/generate] 선지 개수 오류: ${q.choices.length}개 (5개여야 함)`,
      );
    }
    if (q.answer_index < 0 || q.answer_index > 4) {
      throw new Error(`[ai/generate] 정답 인덱스 범위 초과: ${q.answer_index}`);
    }
  }

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
    questions: parsed.questions,
    usage,
  };
}

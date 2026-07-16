/**
 * 메타데이터 태깅 — Haiku 4.5
 *
 * 생성된 문항에서 검색·추천에 사용할 메타데이터 추출.
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
  TAGGING_SYSTEM_PROMPT,
  TAGGING_TOOL_SCHEMA,
  buildTaggingUserMessage,
} from './prompts/tagging';
import type { GeneratedQuestion } from '@/lib/types/domain';

export interface TaggingResult {
  concepts: string[];
  exam_relevance: 1 | 2 | 3;
  image_dependency: 'required' | 'helpful' | 'none';
  clinical_setting?: string;
  usage: UsageRecord;
}

export interface TaggingInput {
  subjectName: string;
  subTopicName: string;
  question: GeneratedQuestion;
}

export async function tagQuestion(input: TaggingInput): Promise<TaggingResult> {
  const client = getAnthropic();
  const model = MODELS.verification(); // 태깅도 Haiku 사용 (저렴)
  const startTime = Date.now();

  const userMessage = buildTaggingUserMessage({
    subjectName: input.subjectName,
    subTopicName: input.subTopicName,
    question: input.question,
  });

  const response = await withRetry(() =>
    createMessage(client, {
      model,
      max_tokens: 800,
      system: [
        {
          type: 'text',
          text: TAGGING_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [TAGGING_TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: 'tag_question' },
      messages: [{ role: 'user', content: userMessage }],
    }),
    { maxAttempts: 5 },
  );

  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

  if (!toolUseBlock) {
    throw new Error('[ai/tag] 도구 호출 응답이 없음');
  }

  const parsed = toolUseBlock.input as {
    concepts: string[];
    exam_relevance: 1 | 2 | 3;
    image_dependency: 'required' | 'helpful' | 'none';
    clinical_setting?: string;
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
    concepts: parsed.concepts,
    exam_relevance: parsed.exam_relevance,
    image_dependency: parsed.image_dependency,
    clinical_setting: parsed.clinical_setting,
    usage,
  };
}

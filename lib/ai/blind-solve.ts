/**
 * 블라인드 풀이 호출 (P9) — 이미지형 문항을 그림 없이 풀려 본다.
 *
 * 호출 틀은 검증(P1, verify.ts)과 같다: 같은 provider(기본 Gemini flash)·같은 도구 강제·
 * 짧은 재시도. 다른 점은 **같은 문항을 여러 번 독립적으로 푼다**는 것뿐이다.
 * 판정(몇 번 맞아야 폐기인가)은 blind-policy.ts 가 갖는다 — 여기는 "풀어 보기"만 한다.
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
  BLIND_SOLVE_SYSTEM_PROMPT,
  BLIND_SOLVE_TOOL_SCHEMA,
  buildBlindSolveUserMessage,
} from './prompts/blind-solve';

export interface BlindSolveAttempt {
  /** 모델이 고른 0-based 선지 번호. 도구 응답이 없거나 범위를 벗어나면 null. */
  answerIndex: number | null;
  /** 무엇을 보고 골랐는지 한 문장(사람이 폐기를 재검토할 때 쓴다). */
  basis: string;
  usage: UsageRecord;
}

/**
 * 그림 없이 한 번 풀어 본다.
 *
 * temperature 1: 같은 문항을 두 번 물을 때 **독립 시도**여야 우연 정답률 계산(0.2² = 4 %)이
 * 성립한다. 온도를 0 으로 두면 두 번째 시도가 첫 번째의 복사본이라 시도를 늘린 의미가
 * 사라진다(우연 정답률이 20 % 그대로다).
 */
export async function blindSolveOnce(input: {
  stem: string;
  choices: string[];
  choiceCount?: number;
}): Promise<BlindSolveAttempt> {
  const client = getAnthropic();
  const model = MODELS.verification();
  const startTime = Date.now();

  const response = await withRetry(
    () =>
      createMessage(client, {
        model,
        max_tokens: 300,
        temperature: 1,
        system: [
          {
            type: 'text',
            text: BLIND_SOLVE_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [BLIND_SOLVE_TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: 'solve_without_image' },
        messages: [
          {
            role: 'user',
            content: buildBlindSolveUserMessage({
              stem: input.stem,
              choices: input.choices,
            }),
          },
        ],
      }),
    // 생성 흐름 안에서 사용자가 기다리는 호출이다 — 검증과 같은 이유로 짧게 끊는다.
    { maxAttempts: 2 },
  );

  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );

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

  if (!toolUseBlock) return { answerIndex: null, basis: '', usage };

  const parsed = toolUseBlock.input as { answer_index?: unknown; basis?: unknown };
  const raw = Number(parsed.answer_index);
  const limit = input.choiceCount ?? input.choices.length;
  // 범위를 벗어난 값은 "안 푼 것"으로 본다. 억지로 0 으로 접으면 우연히 정답과 맞아
  // 멀쩡한 문항을 버릴 수 있다 — 판정을 못 한 쪽이 안전하다.
  const answerIndex = Number.isInteger(raw) && raw >= 0 && raw < limit ? raw : null;

  return {
    answerIndex,
    basis: typeof parsed.basis === 'string' ? parsed.basis.slice(0, 200) : '',
    usage,
  };
}

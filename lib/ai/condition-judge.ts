/**
 * 조건 판정기 호출 — 문항의 "결합해야 하는 조건·지식 수"를 생성 모델과 **독립적으로** 센다.
 *
 * 호출 틀은 블라인드 풀이(blind-solve.ts)와 같다: 같은 provider(기본 Gemini flash)·도구 강제·
 * 짧은 재시도. 판정 결과를 난이도로 바꾸는 규칙은 difficulty-conditions.ts(잎 모듈)가 갖는다 —
 * 여기는 "세어 보기"만 한다. 실패·시간 초과는 호출자가 null 로 받아 "판정 불가 → 자기신고만
 * 사용"으로 처리한다(가용성 우선, 검증·블라인드와 같은 원칙).
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
  CONDITION_JUDGE_SYSTEM_PROMPT,
  CONDITION_JUDGE_TOOL_SCHEMA,
  buildConditionJudgeUserMessage,
} from './prompts/condition-judge';

export interface ConditionJudgeResult {
  /** 판정기가 센 서로 다른 조건·지식 수. 도구 응답이 없으면 null. */
  count: number | null;
  /** 판정기가 열거한 조건(사람이 재검토할 때 쓴다). */
  conditions: Array<{ text: string; source: 'given' | 'knowledge' }>;
  basis: string;
  usage: UsageRecord;
}

/**
 * 한 문항의 조건 수를 판정한다.
 *
 * temperature 0: 블라인드 풀이와 달리 독립 시도를 여러 번 합치지 않는다 — 판정은
 * 결정론적일수록 재현 가능하고, 부풀림을 잡는 데는 한 번의 엄격한 심사면 충분하다.
 */
export async function judgeConditionsOnce(input: {
  stem: string;
  choices: string[];
  answerIndex: number;
}): Promise<ConditionJudgeResult> {
  const client = getAnthropic();
  const model = MODELS.verification();
  const startTime = Date.now();

  const response = await withRetry(
    () =>
      createMessage(client, {
        model,
        max_tokens: 600,
        temperature: 0,
        system: [
          {
            type: 'text',
            text: CONDITION_JUDGE_SYSTEM_PROMPT,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [CONDITION_JUDGE_TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: 'count_solution_conditions' },
        messages: [{ role: 'user', content: buildConditionJudgeUserMessage(input) }],
      }),
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

  if (!toolUseBlock) return { count: null, conditions: [], basis: '', usage };

  const parsed = toolUseBlock.input as {
    conditions?: unknown;
    count?: unknown;
    basis?: unknown;
  };
  const conditions = Array.isArray(parsed.conditions)
    ? parsed.conditions
        .filter(
          (c): c is { text: string; source: 'given' | 'knowledge' } =>
            !!c &&
            typeof c === 'object' &&
            typeof (c as { text?: unknown }).text === 'string' &&
            ((c as { source?: unknown }).source === 'given' ||
              (c as { source?: unknown }).source === 'knowledge'),
        )
        .map((c) => ({ text: c.text.slice(0, 200), source: c.source }))
    : [];
  // 목록과 숫자가 어긋나면 **목록** 을 믿는다 — 숫자만 크게 적는 것이 바로 부풀림이다.
  const reported = Number(parsed.count);
  const count =
    conditions.length > 0
      ? conditions.length
      : Number.isInteger(reported) && reported >= 1
        ? reported
        : null;

  return {
    count,
    conditions,
    basis: typeof parsed.basis === 'string' ? parsed.basis.slice(0, 200) : '',
    usage,
  };
}

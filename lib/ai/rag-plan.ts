/**
 * 출제 계획 콜 — LLM 1콜로 출제 단위와 단위별 검색 질의를 만든다 (RAG 실행계획 v1.1 · 5.2 C·D · PR G)
 *
 * 입력은 페이지 요약 + 그림 캡션 목록(lib/rag/plan.ts 의 buildPlanInput, 12,000자 이하)이다.
 * 생성 모델(MODELS.generation, 운영 gemini-2.5-flash)을 쓰고 비용은 recordAiCost(rag.plan)로 남긴다
 * (업로드 귀속은 비용 귀속 컨텍스트가 자동으로 붙인다).
 *
 * 던지지 않는다. 실패하면 ok=false 와 오류 문구를 돌려주고, 호출자가 현행 초점으로 폴백한다.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropic, MODELS, calculateCost, withRetry, createMessage } from './client';
import { recordAiCost } from './cost-cap';
import type { BatchQuota } from './type-plan';
import {
  PLAN_SYSTEM,
  PLAN_TOOL,
  assignUnitsToSlots,
  buildPlanInput,
  buildPlanPrompt,
  fallbackUnitsFromTopics,
  parsePlan,
  planStats,
  planUnitCount,
  type PlanCaption,
  type PlanInput,
  type PlanPage,
  type PlanRequest,
  type PlanUnit,
  type SlotAssignment,
} from '../rag/plan.ts';

export interface PlanCallResult {
  ok: boolean;
  units: PlanUnit[];
  /** 입력 규모(진단용). 그림 목록 자체는 싣지 않고 수만 남긴다(captionsIncluded). */
  input: Omit<PlanInput, 'text' | 'figures'> & { chars: number };
  /** 그림 id(F1 …) → 출처(쪽·크롭 지문). 진단에는 싣지 않고 검색(이미지 단위의 캡션 청크 찾기)에만 쓴다. */
  figures: PlanInput['figures'];
  dropped: number;
  repaired: number;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  error?: string;
}

export async function planExamUnits(args: {
  pages: readonly PlanPage[];
  captions?: readonly PlanCaption[];
  request: PlanRequest;
  userIdForLog?: string;
}): Promise<PlanCallResult> {
  const t0 = Date.now();
  const model = MODELS.generation();
  const input = buildPlanInput(args.pages, args.captions ?? []);
  const { text: _text, figures: _figures, ...inputMeta } = input;
  const base: PlanCallResult = {
    ok: false,
    units: [],
    input: { ...inputMeta, chars: input.text.length },
    figures: input.figures,
    dropped: 0,
    repaired: 0,
    model,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    ms: 0,
  };
  try {
    if (input.pagesIncluded === 0) {
      return { ...base, ms: Date.now() - t0, error: '본문 페이지 없음' };
    }
    const response = await withRetry(() =>
      createMessage(getAnthropic(), {
        model,
        max_tokens: 8192,
        system: PLAN_SYSTEM,
        tools: [PLAN_TOOL as unknown as Anthropic.Tool],
        tool_choice: { type: 'tool', name: PLAN_TOOL.name },
        messages: [{ role: 'user', content: buildPlanPrompt(args.request, input) }],
      }),
    );
    const usage = response.usage;
    const cost = calculateCost(
      model,
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_input_tokens ?? 0,
      usage.cache_creation_input_tokens ?? 0,
    );
    await recordAiCost({
      userId: args.userIdForLog ?? null,
      endpoint: 'rag.plan',
      model,
      costUsd: cost,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    });
    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    const parsed = parsePlan(toolUse?.input, {
      validPages: args.pages.map((p) => p.pageIndex),
      figureIds: input.figures.map((f) => f.id),
      maxUnits: planUnitCount(args.request.desiredCount) + 2,
    });
    return {
      ...base,
      ok: parsed.units.length > 0,
      units: parsed.units,
      dropped: parsed.dropped,
      repaired: parsed.repaired,
      costUsd: cost,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      ms: Date.now() - t0,
      ...(parsed.units.length === 0 ? { error: toolUse ? '유효한 단위 없음' : '도구 호출 응답 없음' } : {}),
    };
  } catch (e) {
    return {
      ...base,
      ms: Date.now() - t0,
      error: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200),
    };
  }
}

/**
 * 진단에 싣는 계획 요약(shadow·on). 강의 내용(주제·질의 문구)은 넣지 않는다 — 진단은 운영 ai_cost_log 에
 * 남고, 경고·진단에 강의 본문을 싣지 않는다는 원칙(writeDiagnostics 주석)을 따른다.
 */
export interface PlanDiag {
  ok: boolean;
  /** 계획 콜이 실패해 현행 초점으로 대신했는가. */
  fallback: boolean;
  error?: string;
  timedOut?: boolean;
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
  input: PlanCallResult['input'] | null;
  dropped: number;
  repaired: number;
  stats: ReturnType<typeof planStats> | null;
  /** type-plan 쿼터 칸 배정 결과(칸 수·채운 칸·유형이 맞는 칸·빈 칸). */
  assignment: { slots: number; filled: number; fit: number; empty: number } | null;
  /** 칸에 들어가지 않은 예비 단위 수(근거 부족 D3 때 바꿔 끼울 몫). */
  reserve: number;
}

/** 계획 한 번의 결과 — 진단 요약과, 검색(PR H)·생성(PR I)이 쓸 단위·칸 배정. */
export interface PlanRun {
  diag: PlanDiag;
  units: PlanUnit[];
  slots: SlotAssignment[];
  figures: PlanInput['figures'];
}

/**
 * 계획 콜 → (실패 시 초점 폴백) → 쿼터 칸 배정까지 한다. 던지지 않는다.
 * fallbackTopics 는 함수로 받는다 — 초점 목록은 계획 콜이 도는 사이에 OCR 포함 텍스트로 다시 뽑힐 수 있다.
 */
export async function runPlan(args: {
  pages: readonly PlanPage[];
  captions?: readonly PlanCaption[];
  request: PlanRequest;
  quotas: readonly BatchQuota[];
  fallbackTopics: () => readonly string[];
  userIdForLog?: string;
}): Promise<PlanRun> {
  const r = await planExamUnits(args);
  try {
    const units = r.ok ? r.units : fallbackUnitsFromTopics(args.fallbackTopics(), planUnitCount(args.request.desiredCount));
    const a = assignUnitsToSlots(units, args.quotas);
    return {
      diag: {
        ok: r.ok,
        fallback: !r.ok,
        ...(r.error ? { error: r.error } : {}),
        model: r.model,
        costUsd: r.costUsd,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        ms: r.ms,
        input: r.input,
        dropped: r.dropped,
        repaired: r.repaired,
        stats: planStats(units, r.input),
        assignment: a.stats,
        reserve: a.reserve.length,
      },
      units,
      slots: a.slots,
      figures: r.figures,
    };
  } catch (e) {
    return {
      diag: {
        ok: false,
        fallback: true,
        error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
        model: r.model,
        costUsd: r.costUsd,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        ms: r.ms,
        input: r.input,
        dropped: r.dropped,
        repaired: r.repaired,
        stats: null,
        assignment: null,
        reserve: 0,
      },
      units: [],
      slots: [],
      figures: [],
    };
  }
}

/** 진단 기록 전에 계획을 기다리되 상한을 둔다. 넘기면 timedOut 으로 남기고 비용은 뒤늦게 기록된다. */
export async function settlePlan(pending: Promise<PlanRun>, waitMs: number, model: string): Promise<PlanDiag> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PlanDiag>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          ok: false,
          fallback: false,
          timedOut: true,
          model,
          costUsd: 0,
          inputTokens: 0,
          outputTokens: 0,
          ms: waitMs,
          input: null,
          dropped: 0,
          repaired: 0,
          stats: null,
          assignment: null,
          reserve: 0,
        }),
      waitMs,
    );
  });
  try {
    return await Promise.race([pending.then((r) => r.diag), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Gemini (Google Generative Language API) 어댑터
 *
 * Claude 연동 로직은 그대로 두고, 환경변수 `AI_PROVIDER=gemini` 일 때만
 * `createMessage` 가 이 모듈로 라우팅된다. Anthropic `messages.create` 파라미터를
 * Gemini `generateContent` 요청으로 변환하고, 응답을 다시 Anthropic `Message`
 * (tool_use 블록 포함) 형태로 되돌려 기존 소비자 코드가 수정 없이 동작하게 한다.
 *
 * 필요한 환경변수:
 *  - AI_PROVIDER=gemini            (미설정/anthropic 이면 이 모듈은 비활성 — 기존 Claude 경로)
 *  - GEMINI_API_KEY                (Google AI Studio 키)
 *  - GEMINI_GEN_MODEL     (기본: gemini-2.5-pro)
 *  - GEMINI_VERIFY_MODEL  (기본: gemini-2.5-flash)
 *  - GEMINI_VISION_MODEL  (기본: gemini-2.5-flash)
 */

import type { ExtendedMessage, MessageCreateParams } from './client';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** 현재 활성 provider 가 Gemini 인지 */
export function isGeminiProvider(): boolean {
  return (process.env.AI_PROVIDER ?? 'anthropic').toLowerCase() === 'gemini';
}

const GEMINI_TIMEOUT_MS = parseInt(process.env.ANTHROPIC_TIMEOUT_MS ?? '60000', 10);

/** 429 응답 본문의 RetryInfo.retryDelay("36s" / "1.5s") → ms. 없으면 undefined. */
function parseGeminiRetryDelayMs(body: string): number | undefined {
  const m = body.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (!m) return undefined;
  const sec = parseFloat(m[1]);
  return Number.isFinite(sec) ? Math.round(sec * 1000) : undefined;
}

export const GEMINI_MODELS = {
  // 무료 티어 기준 2.5-flash 가 quota·품질 균형이 좋아 기본값. 결제 활성화 시
  // GEMINI_GEN_MODEL=gemini-2.5-pro 로 상향 가능.
  generation: () => process.env.GEMINI_GEN_MODEL ?? 'gemini-2.5-flash',
  verification: () => process.env.GEMINI_VERIFY_MODEL ?? 'gemini-2.5-flash',
  vision: () => process.env.GEMINI_VISION_MODEL ?? 'gemini-2.5-flash',
} as const;

/** 호출부가 Claude 모델 id 를 직접 넘긴 경우에도 안전하게 Gemini 모델로 매핑. */
function resolveModel(model: string | undefined): string {
  const m = model ?? '';
  if (m.startsWith('gemini')) return m;
  if (m.includes('haiku')) return GEMINI_MODELS.verification();
  if (m === '') return GEMINI_MODELS.generation();
  // claude-* / 알 수 없음 → 생성 모델 기본값
  return GEMINI_MODELS.generation();
}

// ───────────── 스키마 변환 (JSON Schema → Gemini function parameters) ─────────────

const TYPE_MAP: Record<string, string> = {
  string: 'STRING',
  integer: 'INTEGER',
  number: 'NUMBER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

/**
 * Anthropic tool 의 input_schema(표준 JSON Schema) 를 Gemini functionDeclarations 의
 * parameters(OpenAPI subset) 로 정제한다. Gemini 가 거부하는 키
 * (minItems/maxItems/minimum/maximum/additionalProperties/$schema 등) 는 제거한다.
 * (문항 개수·범위 검증은 애플리케이션 레벨에서 별도로 수행하므로 손실 없음.)
 */
function sanitizeSchema(node: unknown): Record<string, unknown> | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const n = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (n.type && typeof n.type === 'string') {
    out.type = TYPE_MAP[n.type.toLowerCase()] ?? n.type.toUpperCase();
  }
  if (typeof n.description === 'string') out.description = n.description;
  if (Array.isArray(n.enum)) out.enum = n.enum;
  if (n.nullable === true) out.nullable = true;

  if (n.properties && typeof n.properties === 'object') {
    const props = n.properties as Record<string, unknown>;
    const outProps: Record<string, unknown> = {};
    for (const key of Object.keys(props)) {
      const child = sanitizeSchema(props[key]);
      if (child) outProps[key] = child;
    }
    out.properties = outProps;
    if (Array.isArray(n.required)) out.required = n.required;
  }

  if (n.items) {
    const items = sanitizeSchema(n.items);
    if (items) out.items = items;
  }

  return out;
}

// ───────────── 메시지/콘텐츠 변환 ─────────────

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
}

async function fetchImageBase64(url: string): Promise<{ mimeType: string; data: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS) });
  if (!res.ok) {
    const e = new Error(`Gemini 어댑터: 이미지 fetch 실패 (${res.status})`) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
  const buf = Buffer.from(await res.arrayBuffer());
  return { mimeType, data: buf.toString('base64') };
}

async function toGeminiParts(content: unknown): Promise<GeminiPart[]> {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [];

  const parts: GeminiPart[] = [];
  for (const raw of content) {
    const block = raw as Record<string, unknown>;
    const t = block.type;
    if (t === 'text' && typeof block.text === 'string') {
      parts.push({ text: block.text });
    } else if (t === 'image') {
      const src = (block.source ?? {}) as Record<string, unknown>;
      if (src.type === 'base64' && typeof src.data === 'string') {
        parts.push({
          inlineData: {
            mimeType: (src.media_type as string) ?? 'image/png',
            data: src.data,
          },
        });
      } else if (src.type === 'url' && typeof src.url === 'string') {
        const img = await fetchImageBase64(src.url);
        parts.push({ inlineData: img });
      }
    } else if (t === 'tool_result') {
      const c = block.content;
      parts.push({
        functionResponse: {
          name: (block.name as string) ?? 'tool',
          response: { content: typeof c === 'string' ? c : JSON.stringify(c) },
        },
      });
    } else if (t === 'tool_use') {
      parts.push({
        functionCall: {
          name: (block.name as string) ?? 'tool',
          args: (block.input as Record<string, unknown>) ?? {},
        },
      });
    }
  }
  return parts;
}

function flattenSystem(system: unknown): string | undefined {
  if (!system) return undefined;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    const text = system
      .map((b) => (typeof b === 'string' ? b : ((b as Record<string, unknown>)?.text as string) ?? ''))
      .filter(Boolean)
      .join('\n\n');
    return text || undefined;
  }
  return undefined;
}

// ───────────── 응답 변환 (Gemini → Anthropic Message) ─────────────

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  responseId?: string;
}

function toAnthropicMessage(json: GeminiResponse, model: string): ExtendedMessage {
  const cand = json.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const content: Array<Record<string, unknown>> = [];
  let hasFunc = false;
  let counter = 0;

  for (const p of parts) {
    if (p.functionCall) {
      hasFunc = true;
      content.push({
        type: 'tool_use',
        id: `toolu_gemini_${counter++}`,
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
      });
    } else if (typeof p.text === 'string' && p.text.length > 0) {
      content.push({ type: 'text', text: p.text });
    }
  }

  const um = json.usageMetadata ?? {};
  const finish = cand?.finishReason;
  const stopReason = hasFunc ? 'tool_use' : finish === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';

  return {
    id: json.responseId ?? `msg_gemini_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: um.promptTokenCount ?? 0,
      output_tokens: um.candidatesTokenCount ?? 0,
      cache_read_input_tokens: um.cachedContentTokenCount ?? 0,
      cache_creation_input_tokens: 0,
    },
  } as unknown as ExtendedMessage;
}

// ───────────── 진입점 ─────────────

/**
 * Anthropic `createMessage` 와 동일한 시그니처(파라미터)로 호출되며,
 * Gemini 를 호출하고 Anthropic `Message` 형태로 반환한다.
 * (client.ts 의 createMessage 가 provider=gemini 일 때 이 함수로 위임)
 */
export async function geminiCreateMessage(params: MessageCreateParams): Promise<ExtendedMessage> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');

  const p = params as unknown as Record<string, unknown>;
  const model = resolveModel(p.model as string | undefined);

  const contents: Array<{ role: string; parts: GeminiPart[] }> = [];
  for (const raw of (p.messages as unknown[]) ?? []) {
    const m = raw as Record<string, unknown>;
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: await toGeminiParts(m.content),
    });
  }

  // gemini-2.5-* 는 기본 "thinking" 이 켜져 있어, max_tokens 예산이 작은 검증/태깅
  // 호출에서 사고 토큰이 예산을 모두 소진하면 functionCall(도구 호출)을 못 내보낸다
  // ("도구 호출 응답이 없음" 에러). thinkingBudget=0 으로 꺼서 구조화 출력을 보장한다.
  // 품질을 위해 사고를 켜려면 GEMINI_THINKING_BUDGET 를 양수로 설정(단, max_tokens 여유 필요).
  const thinkingBudget = parseInt(process.env.GEMINI_THINKING_BUDGET ?? '0', 10);
  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: (p.max_tokens as number) ?? 4096,
      thinkingConfig: { thinkingBudget },
      ...(typeof p.temperature === 'number' ? { temperature: p.temperature } : {}),
    },
  };

  const sys = flattenSystem(p.system);
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };

  const tools = p.tools as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: sanitizeSchema(t.input_schema),
        })),
      },
    ];
    const tc = p.tool_choice as Record<string, unknown> | undefined;
    if (tc?.type === 'tool' && typeof tc.name === 'string') {
      body.toolConfig = {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tc.name] },
      };
    } else if (tc?.type === 'any') {
      body.toolConfig = { functionCallingConfig: { mode: 'ANY' } };
    }
  }

  const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });

  const text = await res.text();
  if (!res.ok) {
    // withRetry 가 429/5xx 를 재시도할 수 있도록 status 부착.
    const err = new Error(`Gemini API ${res.status}: ${text.slice(0, 300)}`) as Error & {
      status?: number;
      retryAfterMs?: number;
    };
    err.status = res.status;
    // 무료 티어 분당 한도(429)는 보통 RetryInfo.retryDelay(예: "36s")를 준다 → 존중.
    if (res.status === 429) {
      err.retryAfterMs = parseGeminiRetryDelayMs(text) ?? 20_000;
    }
    throw err;
  }

  let json: GeminiResponse;
  try {
    json = JSON.parse(text) as GeminiResponse;
  } catch {
    throw new Error(`Gemini 응답 파싱 실패: ${text.slice(0, 200)}`);
  }
  return toAnthropicMessage(json, model);
}

/**
 * Anthropic Claude 클라이언트
 *
 * 환경변수로 모델을 분리하여 운영 중 모델 교체 가능:
 *  - ANTHROPIC_GEN_MODEL    : 문항 생성 (기본: claude-sonnet-4-6)
 *  - ANTHROPIC_VERIFY_MODEL : 검증 (기본: claude-haiku-4-5-20251001)
 *  - ANTHROPIC_VISION_MODEL : 의료 이미지 처리 (기본: claude-sonnet-4-6)
 *
 * 모든 호출은 sdk-wrapper 를 거치므로 비용 추적 / 재시도 / 캐싱이 통합 적용된다.
 */

import Anthropic from '@anthropic-ai/sdk';
import { isGeminiProvider, geminiCreateMessage, GEMINI_MODELS } from './gemini';

let cachedClient: Anthropic | undefined;
// 폴백(secondary) 키 클라이언트. primary 가 크레딧 소진/인증 실패일 때만 사용.
let cachedFallback: Anthropic | undefined | null;
// primary 가 한 번 키-레벨 실패(크레딧/인증)로 죽으면 true — 이후 호출은 바로 fallback.
let primaryKeyDisabled = false;

/** ANTHROPIC_API_KEY_FALLBACK 로 만든 폴백 클라이언트. 미설정이면 null. */
function getAnthropicFallback(): Anthropic | null {
  if (cachedFallback !== undefined) return cachedFallback;
  const key = process.env.ANTHROPIC_API_KEY_FALLBACK;
  if (!key) {
    cachedFallback = null;
    return null;
  }
  cachedFallback = new Anthropic({
    apiKey: key,
    timeout: ANTHROPIC_TIMEOUT_MS,
    maxRetries: 0,
  });
  return cachedFallback;
}

/**
 * primary 키를 폴백으로 전환해야 하는 "키-레벨" 실패인지 판단.
 *  - 401/403 : 잘못/비활성 키
 *  - 400 + "credit balance ... too low" / billing : 크레딧 소진
 * (그 외 400 은 정상적인 요청 오류이므로 폴백하지 않는다.)
 */
function isKeyLevelFailure(error: unknown): boolean {
  if (error instanceof Anthropic.APIError) {
    if (error.status === 401 || error.status === 403) return true;
    if (error.status === 400) {
      const msg = (error.message ?? '').toLowerCase();
      return (
        msg.includes('credit balance') ||
        msg.includes('too low') ||
        msg.includes('billing')
      );
    }
  }
  return false;
}

/**
 * messages.create 호출 헬퍼.
 *
 * SDK 0.32.x 는 prompt caching (`cache_control`) 과 image URL source 가 안정 namespace
 * 타입에 아직 노출되지 않아 컴파일 시 타입 오류가 난다. 그러나 런타임 API 는 이미
 * 두 기능을 모두 받아들인다. SDK 가 따라잡힐 때까지 본 헬퍼로 한 곳에서 안전하게 캐스팅.
 *
 * - 입력: 느슨한 객체(streaming 사용 안 함) — cache_control / url source 허용.
 * - 출력: `Anthropic.Message` (NonStreaming 보장).
 *
 * 호출자는 `client.messages.create(...)` 대신 `createMessage(client, {...})` 를 사용한다.
 */
export type MessageCreateParams = Omit<
  Anthropic.MessageCreateParamsNonStreaming,
  'system' | 'messages' | 'tools' | 'tool_choice'
> & {
  system?: Anthropic.MessageCreateParamsNonStreaming['system'] | unknown;
  messages: Anthropic.MessageCreateParamsNonStreaming['messages'] | unknown[];
  tools?: Anthropic.MessageCreateParamsNonStreaming['tools'] | unknown[];
  tool_choice?: Anthropic.MessageCreateParamsNonStreaming['tool_choice'];
};

/**
 * SDK 0.32 의 안정 namespace 가 `cache_read_input_tokens` / `cache_creation_input_tokens`
 * 를 누락하고 있어 (beta 에만 존재) Usage 를 그대로 쓰면 calculateCost 호출 시점에 TS 오류.
 * runtime API 는 두 필드를 반환하므로 옵셔널로 확장만 한다.
 */
export type ExtendedUsage = Anthropic.Usage & {
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export type ExtendedMessage = Omit<Anthropic.Message, 'usage'> & {
  usage: ExtendedUsage;
};

export async function createMessage(
  client: Anthropic,
  params: MessageCreateParams,
): Promise<ExtendedMessage> {
  // provider 스위치: AI_PROVIDER=gemini 이면 Gemini 로 위임(응답은 Anthropic 형태로 반환).
  // 그 외에는 아래 기존 Claude 경로를 그대로 사용한다.
  if (isGeminiProvider()) {
    return geminiCreateMessage(params);
  }

  const raw = params as unknown as Anthropic.MessageCreateParamsNonStreaming;
  const fallback = getAnthropicFallback();

  // primary 가 이미 키-레벨 실패로 죽었고 폴백이 있으면 곧바로 폴백 사용
  // (매 호출마다 실패하는 primary 를 다시 때리지 않도록).
  const isPrimary = client === cachedClient;
  const useClient =
    primaryKeyDisabled && fallback && isPrimary ? fallback : client;

  try {
    return (await useClient.messages.create(raw)) as unknown as ExtendedMessage;
  } catch (error) {
    // primary 키가 크레딧 소진/인증 실패면 → secondary 키로 1회 전환 재시도.
    if (fallback && useClient !== fallback && isKeyLevelFailure(error)) {
      primaryKeyDisabled = true;
      console.warn(
        '[ai/client] primary 키 실패 — secondary(fallback) 키로 전환:',
        error instanceof Error ? error.message.slice(0, 140) : String(error),
      );
      return (await fallback.messages.create(raw)) as unknown as ExtendedMessage;
    }
    throw error;
  }
}

/**
 * Anthropic SDK 호출 timeout. 외부 API hang 으로 라우트가 묶이는 것 방지.
 * SDK 기본 timeout 은 길어서 (분 단위) 사용자 체감 응답 보장에 부족 — 60s 권장.
 * 운영 중 조정이 필요하면 `ANTHROPIC_TIMEOUT_MS` 만 바꾸면 된다.
 */
const ANTHROPIC_TIMEOUT_MS = parseInt(
  process.env.ANTHROPIC_TIMEOUT_MS ?? '60000',
  10,
);

export function getAnthropic(): Anthropic {
  if (cachedClient) return cachedClient;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Gemini 모드에서는 Anthropic 키가 없어도 동작해야 한다. createMessage 가 Gemini 로
    // 라우팅하므로 이 client 객체는 실제 호출에 쓰이지 않는다(참조용 placeholder).
    if (isGeminiProvider()) {
      cachedClient = new Anthropic({
        apiKey: 'gemini-mode-placeholder',
        timeout: ANTHROPIC_TIMEOUT_MS,
        maxRetries: 0,
      });
      return cachedClient;
    }
    throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
  }

  // maxRetries: 0 — SDK 자체 재시도를 끄고 본 모듈의 `withRetry` 한 곳으로 일원화.
  // (둘 다 켜져 있으면 9 회까지 중첩 재시도돼 사용자 체감 응답이 비정상적으로 늦어진다.)
  cachedClient = new Anthropic({
    apiKey,
    timeout: ANTHROPIC_TIMEOUT_MS,
    maxRetries: 0,
  });
  return cachedClient;
}

// ───────────── 모델 ID 헬퍼 ─────────────

export const MODELS = {
  generation: () =>
    isGeminiProvider()
      ? GEMINI_MODELS.generation()
      : process.env.ANTHROPIC_GEN_MODEL ?? 'claude-sonnet-4-6',
  verification: () =>
    isGeminiProvider()
      ? GEMINI_MODELS.verification()
      : process.env.ANTHROPIC_VERIFY_MODEL ?? 'claude-haiku-4-5-20251001',
  vision: () =>
    isGeminiProvider()
      ? GEMINI_MODELS.vision()
      : process.env.ANTHROPIC_VISION_MODEL ?? 'claude-sonnet-4-6',
} as const;

// ───────────── 비용 추적 ─────────────

export interface UsageRecord {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUSD: number;
  durationMs: number;
}

// 백만 토큰당 단가 (USD, 2026-05 기준)
const PRICING: Record<string, { input: number; output: number; cache_write: number; cache_read: number }> = {
  'claude-sonnet-4-6':           { input: 3.0,  output: 15.0, cache_write: 3.75, cache_read: 0.30 },
  'claude-opus-4-7':             { input: 15.0, output: 75.0, cache_write: 18.75, cache_read: 1.50 },
  'claude-haiku-4-5-20251001':   { input: 1.0,  output: 5.0,  cache_write: 1.25, cache_read: 0.10 },
  // Gemini (2026 기준 근사 단가, USD / 1M tokens) — 비용 로그 경고 방지용
  'gemini-2.5-pro':              { input: 1.25, output: 10.0, cache_write: 0,    cache_read: 0.31 },
  'gemini-2.5-flash':            { input: 0.30, output: 2.50, cache_write: 0,    cache_read: 0.075 },
  'gemini-2.5-flash-lite':       { input: 0.10, output: 0.40, cache_write: 0,    cache_read: 0.025 },
  'gemini-2.0-flash':            { input: 0.10, output: 0.40, cache_write: 0,    cache_read: 0.025 },
  'gemini-2.0-flash-lite':       { input: 0.075,output: 0.30, cache_write: 0,    cache_read: 0 },
};

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0,
): number {
  const pricing = PRICING[model];
  if (!pricing) {
    console.warn(`[ai/cost] 알 수 없는 모델: ${model}`);
    return 0;
  }
  return (
    (inputTokens * pricing.input +
      outputTokens * pricing.output +
      cacheReadTokens * pricing.cache_read +
      cacheCreationTokens * pricing.cache_write) /
    1_000_000
  );
}

// ───────────── 재시도 헬퍼 ─────────────

export interface RetryOptions {
  maxAttempts?: number;
  backoffMs?: number;
  /** 대기 상한(ms). 서버가 지시한 retry-after 가 이보다 길어도 이 값으로 캡. 기본 45s. */
  maxDelayMs?: number;
}

/** 에러에 부착된 서버 지시 재시도 대기(ms) — Gemini 429 RetryInfo 등. */
function getRetryAfterMs(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'retryAfterMs' in error) {
    const v = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof v === 'number' && v > 0) return v;
  }
  return undefined;
}

/**
 * 에러에서 HTTP-style status code 를 뽑는다.
 *  - Anthropic SDK: `Anthropic.APIError.status`
 *  - fetch 기반 호출 (Voyage 등): 호출자가 `(err as any).status = res.status` 로 붙임
 *  - Node fetch timeout: `AbortError` (status 없음) — 별도 분기에서 retryable 처리
 */
function getRetryStatus(error: unknown): number | undefined {
  if (error instanceof Anthropic.APIError) {
    return error.status ?? undefined;
  }
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const s = (error as { status?: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return undefined;
}

/**
 * 일시적인 네트워크 / 서비스 에러는 retry, 4xx 비즈니스 에러는 즉시 throw.
 *  - HTTP 429 (rate limit) 또는 >= 500 → retry
 *  - Anthropic SDK 의 connection timeout → retry (SDK 자체 retry 는 끈 상태)
 *  - AbortError / TimeoutError (fetch timeout) → retry
 *  - 그 외 → 즉시 throw
 */
function isRetryableError(error: unknown): boolean {
  const status = getRetryStatus(error);
  if (status !== undefined) {
    return status === 429 || status >= 500;
  }
  // Anthropic SDK timeout — status 가 없는 connection 계열 에러.
  if (error instanceof Anthropic.APIConnectionTimeoutError) return true;
  // AbortSignal.timeout() 가 throw 하는 에러 — Node 는 DOMException('TimeoutError')
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  }
  return false;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffMs = options.backoffMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 45_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === maxAttempts) {
        throw error;
      }
      // 서버가 알려준 재시도 대기(예: Gemini 429 RetryInfo)를 우선 존중, 없으면 지수 백오프.
      const hinted = getRetryAfterMs(error);
      const delay = Math.min(maxDelayMs, hinted ?? backoffMs * Math.pow(2, attempt - 1));
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

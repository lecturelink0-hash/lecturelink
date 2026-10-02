/**
 * 임베딩 생성 — Voyage AI
 *
 * Anthropic 권장 임베딩 제공자.
 * 기본 모델: voyage-3 (1024 차원, 의학 도메인에서도 강력)
 *
 * 용도:
 *  - 문항 풀에서 유사 문항 검색 (중복 admission 방지)
 *  - 사용자 약점 영역과 매칭되는 문항 추천
 */

import { calculateCost, withRetry, type UsageRecord } from './client';
import { recordAiCost } from './cost-cap';
import { RAG_DEFAULTS, embedProvider, ragEmbedModel } from '../rag/mode.ts';
import {
  EMBED_BATCH_LIMITS,
  approxTokens,
  batchTexts,
  embedCostUsd,
  embedPricePerM,
  l2normalize,
} from '../rag/embed-batch.ts';

export interface EmbedInput {
  text: string;
  /** 'query' (검색용) 또는 'document' (저장용). Voyage 권장. */
  inputType?: 'query' | 'document';
}

export interface EmbedResult {
  embedding: number[];
  usage: UsageRecord;
}

// Voyage AI 단가 (USD per 1M tokens, 2026-05 기준)
const VOYAGE_PRICING: Record<string, number> = {
  'voyage-3': 0.06,
  'voyage-3-lite': 0.02,
  'voyage-3-large': 0.18,
};

export async function embedText(input: EmbedInput): Promise<EmbedResult> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) {
    throw new Error('VOYAGE_API_KEY 환경변수가 설정되지 않았습니다.');
  }

  const model = process.env.VOYAGE_EMBED_MODEL ?? 'voyage-3';
  const outputDim = parseInt(process.env.VOYAGE_EMBED_DIM ?? '1024', 10);
  const startTime = Date.now();

  // 외부 API hang 방지 — withRetry 가 TimeoutError 도 retryable 로 본다 (lib/ai/client.ts)
  const VOYAGE_TIMEOUT_MS = 15_000;

  const response = await withRetry(async () => {
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: input.text,
        model,
        input_type: input.inputType ?? 'document',
        output_dimension: outputDim,
      }),
      signal: AbortSignal.timeout(VOYAGE_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errorText = await res.text();
      const error = new Error(
        `[voyage] ${res.status} ${res.statusText}: ${errorText}`,
      );
      // Voyage 의 429·5xx 도 재시도 대상 — withRetry 의 isRetryableError 가 본다.
      (error as Error & { status?: number }).status = res.status;
      throw error;
    }

    return res.json() as Promise<{
      data: Array<{ embedding: number[] }>;
      usage: { total_tokens: number };
    }>;
  });

  const embedding = response.data?.[0]?.embedding;
  if (!embedding || embedding.length !== outputDim) {
    throw new Error(
      `[voyage] 임베딩 차원 불일치: 기대 ${outputDim}, 실제 ${embedding?.length ?? 0}`,
    );
  }

  const pricePerM = VOYAGE_PRICING[model] ?? VOYAGE_PRICING['voyage-3'];
  const costUSD = (response.usage.total_tokens * pricePerM) / 1_000_000;

  return {
    embedding,
    usage: {
      model,
      inputTokens: response.usage.total_tokens,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUSD,
      durationMs: Date.now() - startTime,
    },
  };
}

// ── 배치 임베딩 (RAG 실행계획 v1.1 · 0-g) ──────────────────────────────────────
//
// embedText 는 호출당 1건이라 청크 수십 개를 인덱싱하면 호출이 청크 수만큼 생긴다. embedTexts 는
// 제공자 한도 안에서 묶어 부르고, 비용 기록(recordAiCost)도 함수 안에서 한다. 업로드 처리 중이면
// 비용 귀속 컨텍스트(lib/metrics/cost-attribution)가 uploadId 를 붙인다.
//
// 기존 embedText(문항 은행 중복 검사용, voyage-3)와 모델을 섞지 않는다. 같은 벡터 컬럼에 다른 모델의
// 벡터가 섞이면 유사도가 무의미해지므로, 청크·문항 RAG 임베딩은 ragEmbedModel() 로 따로 정하고
// 행마다 embedding_model 을 남긴다.

export interface EmbedTextsInput {
  texts: string[];
  inputType: 'query' | 'document';
  /** 기본값 ragEmbedModel()(PRIVATE_RAG 구성, voyage-4). */
  model?: string;
  /** ai_cost_log.endpoint. 기본 'rag.embed'. */
  endpoint?: string;
  /** 비용 기록의 user_id. 비우면 비용 귀속 컨텍스트의 userId 를 쓴다. */
  userId?: string | null;
}

export interface EmbedTextsResult {
  /** 입력 순서대로, L2 정규화된 1024차원 벡터. */
  embeddings: number[][];
  model: string;
  tokens: number;
  /** Gemini 는 응답에 토큰 수가 없어 글자 수로 근사한다. */
  tokensEstimated: boolean;
  costUsd: number;
  calls: number;
  durationMs: number;
}

const EMBED_TIMEOUT_MS = 30_000;

async function postEmbedJson(url: string, body: unknown, headers: Record<string, string>, label: string): Promise<any> {
  return withRetry(async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text();
      const error = new Error(`[${label}] ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
      (error as Error & { status?: number }).status = res.status;
      throw error;
    }
    return res.json();
  });
}

export async function embedTexts(input: EmbedTextsInput): Promise<EmbedTextsResult> {
  const model = input.model ?? ragEmbedModel();
  const provider = embedProvider(model);
  if (!provider) throw new Error(`[embed] 지원하지 않는 임베딩 모델: ${model}`);
  if (embedPricePerM(model) === null) throw new Error(`[embed] 단가표에 없는 임베딩 모델: ${model}`);
  const dim = RAG_DEFAULTS.dim;
  const t0 = Date.now();
  const out: number[][] = new Array(input.texts.length);
  let tokens = 0;
  let calls = 0;

  if (input.texts.length > 0) {
    if (provider === 'voyage') {
      const apiKey = process.env.VOYAGE_API_KEY;
      if (!apiKey) throw new Error('VOYAGE_API_KEY 환경변수가 설정되지 않았습니다.');
      for (const b of batchTexts(input.texts, EMBED_BATCH_LIMITS.voyage)) {
        const r = (await postEmbedJson(
          'https://api.voyageai.com/v1/embeddings',
          { input: b.texts, model, input_type: input.inputType, output_dimension: dim },
          { Authorization: `Bearer ${apiKey}` },
          `voyage ${model}`,
        )) as { data: Array<{ embedding: number[]; index: number }>; usage?: { total_tokens?: number } };
        calls += 1;
        tokens += r.usage?.total_tokens ?? 0;
        for (const d of r.data) out[b.start + d.index] = d.embedding;
      }
    } else {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error('GEMINI_API_KEY 환경변수가 설정되지 않았습니다.');
      const taskType = input.inputType === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
      for (const b of batchTexts(input.texts, EMBED_BATCH_LIMITS.gemini)) {
        const r = (await postEmbedJson(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
          {
            requests: b.texts.map((t) => ({
              model: `models/${model}`,
              content: { parts: [{ text: t }] },
              taskType,
              outputDimensionality: dim,
            })),
          },
          { 'x-goog-api-key': apiKey },
          `gemini ${model}`,
        )) as { embeddings: Array<{ values: number[] }> };
        calls += 1;
        tokens += b.texts.reduce((a, t) => a + approxTokens(t), 0);
        r.embeddings.forEach((e, j) => {
          out[b.start + j] = e.values;
        });
      }
    }
  }

  for (let i = 0; i < out.length; i += 1) {
    const v = out[i];
    if (!v || v.length !== dim) {
      throw new Error(`[embed] ${model} 임베딩 ${i}번 차원 불일치: 기대 ${dim}, 실제 ${v?.length ?? 0}`);
    }
    out[i] = l2normalize(v);
  }

  const costUsd = embedCostUsd(model, tokens);
  const tokensEstimated = provider === 'gemini';
  if (calls > 0) {
    await recordAiCost({
      userId: input.userId ?? null,
      endpoint: input.endpoint ?? 'rag.embed',
      model,
      costUsd,
      inputTokens: tokens,
      outputTokens: 0,
      metadata: { texts: input.texts.length, calls, inputType: input.inputType, ...(tokensEstimated ? { tokensEstimated: true } : {}) },
    });
  }
  return { embeddings: out, model, tokens, tokensEstimated, costUsd, calls, durationMs: Date.now() - t0 };
}

/**
 * 문항의 임베딩용 표준 텍스트 빌더
 * stem + choices + concepts 를 결합하여 의미 검색에 적합한 단일 텍스트 생성.
 */
export function buildEmbeddingText(question: {
  stem: string;
  choices: string[];
  concepts?: string[];
  explanation?: string | null;
}): string {
  const parts = [
    `문제: ${question.stem}`,
    `선지: ${question.choices.join(' | ')}`,
  ];
  if (question.concepts && question.concepts.length > 0) {
    parts.push(`개념: ${question.concepts.join(', ')}`);
  }
  if (question.explanation) {
    parts.push(`해설: ${question.explanation.slice(0, 500)}`);
  }
  return parts.join('\n');
}

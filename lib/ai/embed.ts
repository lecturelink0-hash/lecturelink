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

/**
 * 오프라인 평가용 모델 호출 (RAG 실행계획 v1.1 · 0-i · E1~E3 · R1 라벨)
 *
 * 임베딩(Voyage·Gemini), 리랭크(Voyage), 구조화 생성(Gemini)을 부른다. 운영 경로
 * (lib/ai/embed.ts 의 embedText, recordAiCost)와 분리해 둔다 — 평가는 운영 DB 의 비용 기록이나
 * 일일 상한에 섞이면 안 되고, 운영 임베딩 배치 호출(0-g)은 E1 결과로 모델을 고른 뒤 PR D 에서 만든다.
 *
 * - 디스크 캐시: 같은 (모델, 입력 종류, 차원, 텍스트)는 다시 부르지 않는다. 조건을 바꿔 가며
 *   여러 번 돌려도 청크 임베딩 비용은 한 번만 든다.
 * - 비용: 호출마다 토큰 수를 모아 아래 단가표로 계산해 보고한다(청구액이 아니라 추정치).
 * - 네트워크: 프록시 뒤에서 node fetch 가 환경 프록시를 따르게 하려면 NODE_USE_ENV_PROXY=1.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * USD / 1M 토큰. 2026-09-28 확인: Voyage 공식 요금표, Gemini 3.1 Pro Preview 공식 요금표(≤200k 프롬프트),
 * Gemini 2.5 는 lib/ai/client.ts 단가표, gemini-embedding-2 는 공개 요금 보도($0.20).
 */
export const PRICES: Record<string, { input: number; output?: number }> = {
  'voyage-3': { input: 0.06 },
  'voyage-4': { input: 0.06 },
  'voyage-3.5': { input: 0.06 },
  'gemini-embedding-2': { input: 0.2 },
  'rerank-2.5': { input: 0.05 },
  'rerank-3': { input: 0.05 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-3.1-pro-preview': { input: 2, output: 12 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
};

export const EMBED_DIM = 1024;

export class Meter {
  tokens: Record<string, { input: number; output: number; calls: number }> = {};
  add(model: string, input: number, output = 0) {
    const t = (this.tokens[model] ??= { input: 0, output: 0, calls: 0 });
    t.input += input;
    t.output += output;
    t.calls += 1;
  }
  usd(): number {
    return Object.entries(this.tokens).reduce((a, [m, t]) => {
      const p = PRICES[m];
      return a + (p ? (t.input * p.input + t.output * (p.output ?? 0)) / 1e6 : 0);
    }, 0);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJson(url: string, body: unknown, headers: Record<string, string>, label: string): Promise<any> {
  let lastErr = '';
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if (res.ok) return res.json();
    const text = await res.text();
    lastErr = `${label} ${res.status}: ${text.slice(0, 300)}`;
    // 402(결제)·400(요청 오류)은 재시도해도 소용없다.
    if (res.status === 402 || res.status === 400 || res.status === 401 || res.status === 403) break;
    await sleep(Math.min(30_000, 1500 * 2 ** attempt));
  }
  throw new Error(lastErr);
}

export type InputType = 'query' | 'document';

/** 임베딩 캐시 — 파일 하나에 모델별로 {해시: 벡터}. */
export class EmbedCache {
  private data: Record<string, Record<string, number[]>> = {};
  constructor(private readonly path: string) {
    if (existsSync(path)) this.data = JSON.parse(readFileSync(path, 'utf8'));
  }
  key(model: string, type: InputType, text: string) {
    return createHash('sha256').update(`${model}|${type}|${EMBED_DIM}|${text}`).digest('hex').slice(0, 32);
  }
  get(model: string, k: string) {
    return this.data[model]?.[k];
  }
  set(model: string, k: string, v: number[]) {
    (this.data[model] ??= {})[k] = v;
  }
  save() {
    mkdirSync(join(this.path, '..'), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data));
  }
}

async function voyageEmbed(model: string, texts: string[], type: InputType, meter: Meter): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const r = await postJson(
      'https://api.voyageai.com/v1/embeddings',
      { input: batch, model, input_type: type, output_dimension: EMBED_DIM },
      { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
      `voyage ${model}`,
    );
    meter.add(model, r.usage?.total_tokens ?? 0);
    for (const d of r.data) out[i + d.index] = d.embedding;
  }
  return out;
}

async function geminiEmbed(model: string, texts: string[], type: InputType, meter: Meter): Promise<number[][]> {
  const out: number[][] = [];
  const taskType = type === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT';
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64);
    const r = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${process.env.GEMINI_API_KEY}`,
      {
        requests: batch.map((t) => ({
          model: `models/${model}`,
          content: { parts: [{ text: t }] },
          taskType,
          outputDimensionality: EMBED_DIM,
        })),
      },
      {},
      `gemini ${model}`,
    );
    // 응답에 토큰 수가 없어 글자 수로 근사한다(보고서에 근사임을 적는다).
    meter.add(model, Math.ceil(batch.reduce((a, t) => a + t.length, 0) / 2));
    r.embeddings.forEach((e: { values: number[] }, j: number) => {
      out[i + j] = e.values;
    });
  }
  return out;
}

/** 캐시를 거쳐 임베딩한다. 벡터는 호출자가 필요하면 정규화한다(코사인은 척도 무관). */
export async function embed(
  model: string,
  texts: string[],
  type: InputType,
  cache: EmbedCache | null,
  meter: Meter,
): Promise<number[][]> {
  const call = model.startsWith('gemini') ? geminiEmbed : voyageEmbed;
  // 캐시 없음 = 지연 실측용 실호출.
  if (!cache) return call(model, texts, type, meter);
  const keys = texts.map((t) => cache.key(model, type, t));
  const missing = [...new Set(keys.map((k, i) => (cache.get(model, k) ? -1 : i)).filter((i) => i >= 0))];
  if (missing.length > 0) {
    const vecs = await call(model, missing.map((i) => texts[i]), type, meter);
    missing.forEach((idx, j) => cache.set(model, keys[idx], vecs[j]));
    cache.save();
  }
  return keys.map((k) => cache.get(model, k)!);
}

/** Voyage 리랭크 → 입력 순서의 인덱스와 점수(내림차순). */
export async function rerank(
  model: string,
  query: string,
  documents: string[],
  topK: number,
  meter: Meter,
): Promise<Array<{ index: number; score: number }>> {
  if (documents.length === 0) return [];
  const r = await postJson(
    'https://api.voyageai.com/v1/rerank',
    { query, documents, model, top_k: Math.min(topK, documents.length) },
    { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}` },
    `voyage ${model}`,
  );
  meter.add(model, r.usage?.total_tokens ?? 0);
  return r.data.map((d: { index: number; relevance_score: number }) => ({ index: d.index, score: d.relevance_score }));
}

/** Gemini 구조화 생성(JSON 스키마). thinkingBudget 은 모델 기본값을 쓴다. */
export async function geminiJson(
  model: string,
  prompt: string,
  schema: Record<string, unknown>,
  meter: Meter,
  opts: { temperature?: number; maxOutputTokens?: number } = {},
): Promise<any> {
  const r = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: opts.temperature ?? 0.2,
        maxOutputTokens: opts.maxOutputTokens ?? 32768,
      },
    },
    {},
    `gemini ${model}`,
  );
  const um = r.usageMetadata ?? {};
  meter.add(model, um.promptTokenCount ?? 0, (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0));
  const text = r.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`gemini ${model} JSON 파싱 실패: ${text.slice(0, 200)}`);
  }
}

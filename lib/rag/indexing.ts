/**
 * 강의자료 청크 인덱싱 — 임베딩을 만들어 material_chunks 에 저장 (RAG 실행계획 v1.1 · 0-g · 0-h)
 *
 * PRIVATE_RAG_MODE 가 shadow·on 일 때 생성 파이프라인이 청크 저장 직후 부른다. 생성은 이 작업을
 * 기다리지 않고, 진단을 쓰기 직전에 합류해 결과(청크 수·임베딩 수·시간·비용)를 진단에 남긴다.
 *
 * 원칙
 *  - 절대 던지지 않는다. 인덱싱 실패는 결과의 error 로만 돌려준다(shadow 는 생성에 영향이 없어야 한다).
 *  - 내용이 같고 같은 모델로 이미 임베딩한 청크는 다시 부르지 않는다(needsEmbedding).
 *  - 00045 가 적용되지 않은 DB 에서는 unsupported 로 끝낸다(컬럼·함수 없음).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { embedTexts } from '../ai/embed.ts';
import { needsEmbedding } from './embed-batch.ts';
import { ragEmbedModel, type RagMode } from './mode.ts';

export interface RagIndexResult {
  mode: RagMode;
  model: string;
  /** 이 업로드의 청크 수. */
  chunks: number;
  /** 이번에 임베딩해 저장한 청크 수. */
  embedded: number;
  /** 이미 같은 모델·같은 내용으로 임베딩돼 있어 건너뛴 청크 수. */
  reused: number;
  ms: number;
  costUsd: number;
  tokens: number;
  tokensEstimated: boolean;
  unsupported?: boolean;
  timedOut?: boolean;
  error?: string;
}

/** 한 번의 RPC 에 싣는 행 수. 1024차원 벡터 50개면 요청 본문이 약 0.5MB 다. */
const RPC_ROWS = 50;

function isSchemaMissing(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  // 42703 컬럼 없음, 42883 함수 없음, PGRST202 RPC 없음, PGRST204 스키마 캐시에 컬럼 없음
  return ['42703', '42883', 'PGRST202', 'PGRST204'].includes(String(err.code ?? '')) ||
    /embedding_model|rag_set_chunk_embeddings|schema cache/i.test(String(err.message ?? ''));
}

const shortError = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200);

export async function indexMaterialChunks(opts: {
  admin: SupabaseClient;
  uploadId: string;
  mode: RagMode;
  model?: string;
}): Promise<RagIndexResult> {
  const model = opts.model ?? ragEmbedModel();
  const t0 = Date.now();
  const result: RagIndexResult = {
    mode: opts.mode,
    model,
    chunks: 0,
    embedded: 0,
    reused: 0,
    ms: 0,
    costUsd: 0,
    tokens: 0,
    tokensEstimated: false,
  };
  try {
    const { data, error } = await opts.admin
      .from('material_chunks')
      .select('id, chunk_index, content_sha, text, embedding_model, embedding_sha')
      .eq('upload_id', opts.uploadId)
      .order('chunk_index', { ascending: true });
    if (error) {
      if (isSchemaMissing(error)) result.unsupported = true;
      result.error = isSchemaMissing(error) ? '마이그레이션 00045 미적용' : shortError(error.message);
      return result;
    }
    const rows = (data ?? []) as Array<{
      id: string;
      content_sha: string;
      text: string;
      embedding_model: string | null;
      embedding_sha: string | null;
    }>;
    result.chunks = rows.length;
    const todo = rows.filter((r) => needsEmbedding(r, model) && (r.text ?? '').trim().length > 0);
    result.reused = rows.length - todo.length;
    if (todo.length === 0) return result;

    const emb = await embedTexts({ texts: todo.map((r) => r.text), inputType: 'document', model });
    result.costUsd = emb.costUsd;
    result.tokens = emb.tokens;
    result.tokensEstimated = emb.tokensEstimated;

    for (let i = 0; i < todo.length; i += RPC_ROWS) {
      const part = todo.slice(i, i + RPC_ROWS).map((r, j) => ({
        id: r.id,
        sha: r.content_sha,
        embedding: emb.embeddings[i + j],
      }));
      const { data: n, error: setErr } = await opts.admin.rpc('rag_set_chunk_embeddings', {
        p_upload_id: opts.uploadId,
        p_model: model,
        p_rows: part,
      });
      if (setErr) {
        if (isSchemaMissing(setErr)) result.unsupported = true;
        result.error = isSchemaMissing(setErr) ? '마이그레이션 00045 미적용' : shortError(setErr.message);
        return result;
      }
      result.embedded += Number(n ?? 0);
    }
    return result;
  } catch (e) {
    result.error = shortError(e);
    return result;
  } finally {
    result.ms = Date.now() - t0;
  }
}

/**
 * 인덱싱 결과를 기다리되 상한을 둔다. 상한을 넘으면 timedOut 으로 돌려주고, 작업은 뒤에서 계속된다
 * (그 경우 비용 행은 진단보다 늦게 기록되어 업로드 원가 교차 검증에서 차이로 드러난다).
 */
export async function settleRagIndex(
  pending: Promise<RagIndexResult>,
  waitMs: number,
  fallback: { mode: RagMode; model: string },
): Promise<RagIndexResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RagIndexResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          mode: fallback.mode,
          model: fallback.model,
          chunks: 0,
          embedded: 0,
          reused: 0,
          ms: waitMs,
          costUsd: 0,
          tokens: 0,
          tokensEstimated: false,
          timedOut: true,
        }),
      waitMs,
    );
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

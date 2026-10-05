/**
 * 단위 검색·근거 팩 — 업로드 청크 벡터를 한 번 읽어 계획 단위의 질의로 검색한다 (RAG 실행계획 v1.1 · 5.2 E·F · PR H)
 *
 * shadow·on 에서 계획(PR G)과 인덱싱이 끝난 뒤 돈다. 지금은 진단에만 남긴다 — 생성이 근거 팩을 쓰는 것은 PR I 부터다.
 *
 * 청크 벡터를 앱에서 읽어 계산하는 이유
 *  - MMR 은 후보끼리의 유사도가 필요해 벡터가 있어야 한다(match_material_chunks 는 벡터를 돌려주지 않는다).
 *  - 단위 15개 × 질의 4개를 RPC 로 부르면 왕복이 60번이다. 업로드 하나의 청크는 수십~수백 개라 한 번 읽는 편이 싸다.
 *  - 산식은 lib/rag/pack.ts 하나라 오프라인 평가(pack-eval)와 운영이 같은 결과를 낸다.
 *
 * 던지지 않는다. 실패는 진단의 error 로만 남는다.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { embedTexts } from '../ai/embed.ts';
import { RAG_DEFAULTS } from './mode.ts';
import { unitQueries, type PlanInput, type PlanUnit, type SlotAssignment } from './plan.ts';
import {
  packSizeFor,
  parseVector,
  replaceInsufficient,
  retrieveUnit,
  retrievalStats,
  type ChunkVec,
  type UnitRetrieval,
} from './pack.ts';

/** 이 업로드에서 지금 내용과 맞는(embedding_sha = content_sha) 같은 모델의 청크 벡터. */
export async function loadChunkVectors(admin: SupabaseClient, uploadId: string, model: string): Promise<ChunkVec[]> {
  const { data, error } = await admin
    .from('material_chunks')
    .select('id, chunk_index, page_index, kind, modality, text, embedding, embedding_sha, content_sha, image_id')
    .eq('upload_id', uploadId)
    .eq('embedding_model', model)
    .order('chunk_index', { ascending: true });
  if (error) throw new Error(error.message);
  const out: ChunkVec[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    if (r.embedding_sha !== r.content_sha) continue;
    const vec = parseVector(r.embedding);
    if (!vec || vec.length !== RAG_DEFAULTS.dim) continue;
    out.push({
      id: String(r.id),
      chunkIndex: Number(r.chunk_index),
      pageIndex: Number(r.page_index),
      kind: String(r.kind),
      modality: String(r.modality ?? 'text'),
      text: String(r.text ?? ''),
      vec,
      imageId: (r.image_id as string | null) ?? null,
    });
  }
  return out;
}

/** 진단 요약(수치만 — 강의 문구 없음). */
export interface RetrievalDiag {
  ok: boolean;
  /** 돌지 않은 이유(index: 인덱싱 실패·미적용, plan: 단위 없음, vectors: 벡터 없음). */
  skipped?: 'index' | 'plan' | 'vectors';
  error?: string;
  timedOut?: boolean;
  ms: number;
  chunks: number;
  queries: number;
  embedTokens: number;
  costUsd: number;
  tau: number;
  mmrLambda: number | null;
  packSize: number;
  stats: ReturnType<typeof retrievalStats> | null;
  /** 근거 부족(D3) 모의 — 칸 단위가 근거 부족이면 예비로 바꿔 끼운 결과. */
  d3: { replaced: number; shortfall: number; imageSpilled: number } | null;
}

export interface RetrievalRun {
  diag: RetrievalDiag;
  retrievals: UnitRetrieval[];
  /** D3 교체를 반영한 칸 배정(생성 단계가 쓴다, PR I). */
  slots: SlotAssignment[];
}

const emptyDiag = (extra: Partial<RetrievalDiag>): RetrievalDiag => ({
  ok: false,
  ms: 0,
  chunks: 0,
  queries: 0,
  embedTokens: 0,
  costUsd: 0,
  tau: RAG_DEFAULTS.tau,
  mmrLambda: RAG_DEFAULTS.mmrLambda,
  packSize: RAG_DEFAULTS.packSize,
  stats: null,
  d3: null,
  ...extra,
});

export async function runRetrieval(args: {
  admin: SupabaseClient;
  uploadId: string;
  /** 인덱싱 결과. 실패·미적용이면 검색하지 않는다. */
  index: { model: string; error?: string; unsupported?: boolean } | null;
  plan: { units: PlanUnit[]; slots: SlotAssignment[]; figures: PlanInput['figures'] };
  difficulty?: string | null;
  /** 크롭 지문 → material_chunks.image_id (materialImageId). */
  imageIdOf: (imageKey: string) => string;
  userIdForLog?: string;
}): Promise<RetrievalRun> {
  const t0 = Date.now();
  const { size, chars } = packSizeFor(args.difficulty);
  const fail = (extra: Partial<RetrievalDiag>): RetrievalRun => ({
    diag: emptyDiag({ packSize: size, ms: Date.now() - t0, ...extra }),
    retrievals: [],
    slots: args.plan.slots,
  });
  if (!args.index || args.index.unsupported || args.index.error) return fail({ skipped: 'index' });
  if (args.plan.units.length === 0) return fail({ skipped: 'plan' });
  try {
    const chunks = await loadChunkVectors(args.admin, args.uploadId, args.index.model);
    if (chunks.length === 0) return fail({ skipped: 'vectors' });
    const texts = args.plan.units.flatMap((u) => unitQueries(u));
    const emb = await embedTexts({
      texts,
      inputType: 'query',
      model: args.index.model,
      endpoint: 'rag.query',
      userId: args.userIdForLog ?? null,
    });
    const keyOf = new Map(args.plan.figures.filter((f) => f.imageKey).map((f) => [f.id, f.imageKey!]));
    const retrievals = args.plan.units.map((u, i) =>
      retrieveUnit(u.id, emb.embeddings.slice(i * 4, i * 4 + 4), chunks, {
        tau: RAG_DEFAULTS.tau,
        size,
        chars,
        ...(u.needsImage
          ? { figureImageIds: u.figures.map((f) => keyOf.get(f)).filter((k): k is string => Boolean(k)).map(args.imageIdOf) }
          : {}),
      }),
    );
    const d3 = replaceInsufficient(args.plan.slots, args.plan.units, new Map(retrievals.map((r) => [r.unitId, r])));
    return {
      diag: {
        ok: true,
        ms: Date.now() - t0,
        chunks: chunks.length,
        queries: texts.length,
        embedTokens: emb.tokens,
        costUsd: emb.costUsd,
        tau: RAG_DEFAULTS.tau,
        mmrLambda: RAG_DEFAULTS.mmrLambda,
        packSize: size,
        stats: retrievalStats(retrievals),
        d3: { replaced: d3.replaced, shortfall: d3.shortfall, imageSpilled: d3.imageSpilled },
      },
      retrievals,
      slots: d3.slots,
    };
  } catch (e) {
    return fail({ error: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 200) });
  }
}

/** 진단 기록 전에 검색을 기다리되 상한을 둔다. 넘기면 timedOut 으로 남긴다. */
export async function settleRetrieval(pending: Promise<RetrievalRun>, waitMs: number): Promise<RetrievalDiag> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<RetrievalDiag>((resolve) => {
    timer = setTimeout(() => resolve(emptyDiag({ timedOut: true, ms: waitMs })), waitMs);
  });
  try {
    return await Promise.race([pending.then((r) => r.diag), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

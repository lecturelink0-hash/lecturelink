/**
 * RAG 동작 모드와 검색 구성 (RAG 실행계획 v1.1 · 0-h · E1~E3 확정값)
 *
 * PRIVATE_RAG_MODE
 *   off    (기본) 현행 그대로. 청크 임베딩도 만들지 않는다.
 *   shadow 생성은 현행 그대로, 뒤에서 청크 임베딩(인덱싱)만 만든다. 원가·지연·인덱스 품질을
 *          운영 경로에서 재기 위한 단계이며 문항에는 영향이 없다.
 *   on     Phase 1 검색·근거 팩 생성을 쓴다(PR G~J 이후에만 의미가 있음).
 * 알 수 없는 값은 off 로 본다 — 오타 하나로 운영 생성 경로가 바뀌면 안 된다.
 *
 * 검색 구성은 오프라인 실험(E1~E3·E2, docs/naesin-rag-candidates/e1-e3-results.md)에서
 * 사전 판정 기준으로 고른 값이다. 바꾸려면 같은 하네스로 다시 재고 문서를 고친 뒤 바꾼다.
 *
 * import 를 두지 않는다 — 검사 스크립트(`npm run check:rag-mode`)가 이 파일만 불러온다.
 */

export type RagMode = 'off' | 'shadow' | 'on';

export function parseRagMode(raw: string | null | undefined): { mode: RagMode; invalid: boolean } {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return { mode: 'off', invalid: false };
  if (v === 'shadow' || v === 'on') return { mode: v, invalid: false };
  return { mode: 'off', invalid: true };
}

export function ragMode(env: Record<string, string | undefined> = process.env): RagMode {
  return parseRagMode(env.PRIVATE_RAG_MODE).mode;
}

/** 청크 임베딩을 만드는가. shadow·on. */
export const ragIndexingEnabled = (mode: RagMode): boolean => mode !== 'off';
/** 생성이 검색 결과(근거 팩)를 쓰는가. on 만. */
export const ragGenerationEnabled = (mode: RagMode): boolean => mode === 'on';

/**
 * E1~E3·E2 확정 구성 (2026-09-28, 사람 검토 라벨 59단위 기준, 초안 149단위로 교차 확인).
 *  - 임베딩 voyage-4: dense Recall@6 0.983. gemini-embedding-2(0.941)보다 0.042 높아 0.03 기준을 넘음.
 *  - sparse(pg_trgm) 불채택: RRF 가 dense 보다 0.017 손해(기준 0.01 초과).
 *  - 리랭커 불채택: +0.009(기준 +0.03 미달).
 *  - 청킹 1,200자 단독: 부모 확장 조건과 Recall 이 같고 근거 팩이 가장 작음.
 *  - τ 0.61: 단위 최고 코사인 분포에서 Recall 0.9 를 남기는 가장 높은 값(149단위 0.607, 검토 59단위 0.626).
 */
export const RAG_DEFAULTS = {
  embedModel: 'voyage-4',
  dim: 1024,
  packSize: 6,
  candidateK: 20,
  tau: 0.61,
  sparse: false,
  reranker: null as string | null,
  chunkChars: 1200,
  parentExpandTop: 0,
} as const;

export function ragEmbedModel(env: Record<string, string | undefined> = process.env): string {
  const m = (env.RAG_EMBED_MODEL ?? '').trim();
  return m || RAG_DEFAULTS.embedModel;
}

export type EmbedProvider = 'voyage' | 'gemini';

/** 모델 이름으로 제공자를 정한다. 모르는 이름은 null — 호출하지 않고 오류로 끝낸다. */
export function embedProvider(model: string): EmbedProvider | null {
  if (/^voyage-/i.test(model)) return 'voyage';
  if (/^gemini-embedding-/i.test(model)) return 'gemini';
  return null;
}

/** 진단·결과 보고에 싣는 검색 구성 스냅샷(가이드 §10.2 — 재현 조건을 남긴다). */
export function ragConfigSnapshot(env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const parsed = parseRagMode(env.PRIVATE_RAG_MODE);
  return {
    mode: parsed.mode,
    ...(parsed.invalid ? { invalidModeValue: String(env.PRIVATE_RAG_MODE).slice(0, 20) } : {}),
    embedModel: ragEmbedModel(env),
    dim: RAG_DEFAULTS.dim,
    candidateK: RAG_DEFAULTS.candidateK,
    packSize: RAG_DEFAULTS.packSize,
    tau: RAG_DEFAULTS.tau,
    sparse: RAG_DEFAULTS.sparse,
    reranker: RAG_DEFAULTS.reranker,
    chunkChars: RAG_DEFAULTS.chunkChars,
    parentExpandTop: RAG_DEFAULTS.parentExpandTop,
  };
}

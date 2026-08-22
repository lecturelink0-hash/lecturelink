/**
 * 프롬프트·모델 버전 레지스트리 (성능지표 가이드 §10.2 · 분담표 A7)
 *
 * 가이드 §10.2 '데이터 누수 방지':
 *   모델 버전, 임베딩 모델, 청킹 규칙, Top-K와 리랭커 버전을 기록한다.
 *
 * 왜 필요한가: 지표는 "어느 조합에서 잰 값인가"가 붙어야 의미가 있다. 프롬프트를 고친
 * 뒤의 p95 와 그 전의 p95 를 같은 칸에 넣으면 개선인지 악화인지 알 수 없고, 대외 발표에서
 * "그때 어떤 설정이었나"를 물으면 답할 수 없다. 계측 레코드의 version 컬럼이 이 값을 받는다.
 *
 * **프롬프트를 고치면 여기 버전을 올린다.** 올리지 않으면 서로 다른 두 설정의 수치가
 * 한 축으로 뭉쳐, 그 이후의 모든 비교가 조용히 틀린다.
 *
 * 버전 표기: `<기능>-p<프롬프트>` — 모델 id 는 런타임에 환경변수로 갈리므로 계측 레코드의
 * models 컬럼에 따로 남기고, 여기서는 우리가 통제하는 프롬프트 세대만 센다.
 */

/**
 * 기능별 프롬프트 세대.
 *
 * 올리는 기준: 모델에게 주는 지시가 **판정이나 산출물의 성격을 바꾸는** 정도로 달라졌을 때.
 * 오타 수정이나 표현 다듬기는 올리지 않는다 — 버전이 의미 없이 늘면 비교축이 부서진다.
 */
export const PROMPT_VERSIONS = {
  /** 내신대비 업로드 → 문항 생성 (lib/ai/private-generation.ts) */
  private_generation: 4,
  /** 공용 문제은행 생성 (lib/ai/generate.ts) */
  question_generation: 2,
  /** 문항 검증 (lib/ai/verify.ts) */
  verification: 2,
  /** 문항 태깅 (lib/ai/tag.ts) */
  tagging: 1,
  /** 강의자료 OCR·추출 (lib/extract) */
  extraction: 2,
  /** 교수 기능 (formative·bridge 등) */
  faculty: 1,
} as const;

export type PromptFeature = keyof typeof PROMPT_VERSIONS;

/** 문항 임베딩 모델 — 중복 판정(A4)과 약점 매칭의 기준이라 바뀌면 임계값도 다시 잡아야 한다. */
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small';

/**
 * 중복 문항 판정 임계 (코사인 유사도). 이 값을 넘으면 사람이 다시 본다.
 * 임계를 바꾸면 중복률 수치의 의미가 바뀌므로 계측에 함께 기록한다.
 */
export const DUPLICATE_SIMILARITY_THRESHOLD = 0.92;

/** 계측 레코드에 실을 버전 문자열. 기능이 레지스트리에 없으면 기능 이름만 남긴다. */
export function versionFor(feature: string): string {
  const key = feature as PromptFeature;
  const prompt = PROMPT_VERSIONS[key];
  return prompt === undefined ? `${feature}-p0` : `${feature}-p${prompt}`;
}

/**
 * 기능 이름 → 프롬프트 버전 축.
 * 계측의 version 은 "이 요청이 어느 프롬프트 세대에서 돌았나"를 뜻한다.
 * 경로 계열마다 담당 프롬프트가 다르므로 여기서 한 번에 맵핑한다.
 */
export function versionForFeature(feature: string): string {
  if (feature.startsWith('uploads') || feature.startsWith('private_questions')) {
    return versionFor('private_generation');
  }
  if (feature.startsWith('questions_generate')) return versionFor('question_generation');
  if (feature.startsWith('professor') || feature.startsWith('faculty')) return versionFor('faculty');
  if (feature.startsWith('queue_process')) return versionFor('private_generation');
  return versionFor(feature);
}

/**
 * 실제로 돌아간 모델 id 를 이름으로 남긴다.
 *
 * 종전에는 환경변수가 비어 있으면 `'default'` 라는 문자열을 남겼다. 그 값으로는 나중에
 * "그때 어떤 모델이었나"에 답할 수 없다 — 기본값이 바뀌면 같은 `'default'` 가 서로 다른
 * 모델을 뜻하게 되어 §10.2 가 막으려던 바로 그 혼선이 생긴다. 활성 제공자의 기본 모델을
 * 그대로 적는다. **기본 제공자는 Gemini 이므로 미설정 시 gemini-2.5-flash 다.**
 *
 * lib/ai/client.ts 를 import 하지 않는 이유: 이 파일은 검사 스크립트가 SDK·API 키 없이
 * 불러 산식을 확인할 수 있어야 한다(sibling 잎 모듈과 같은 원칙). 그래서 기본값 판정만
 * 여기 옮겨 적는다 — 바꿀 때 client.ts 와 gemini.ts 를 함께 고쳐야 한다.
 */
function resolveModels(): Record<string, string> {
  const anthropic = (process.env.AI_PROVIDER ?? 'gemini').toLowerCase() === 'anthropic';
  return anthropic
    ? {
        genModel: process.env.ANTHROPIC_GEN_MODEL ?? 'claude-sonnet-4-6',
        verifyModel: process.env.ANTHROPIC_VERIFY_MODEL ?? 'claude-haiku-4-5-20251001',
        visionModel: process.env.ANTHROPIC_VISION_MODEL ?? 'claude-sonnet-4-6',
      }
    : {
        genModel: process.env.GEMINI_GEN_MODEL ?? 'gemini-2.5-flash',
        verifyModel: process.env.GEMINI_VERIFY_MODEL ?? 'gemini-2.5-flash',
        visionModel: process.env.GEMINI_VISION_MODEL ?? 'gemini-2.5-flash',
      };
}

/**
 * 결과 보고에 함께 싣는 설정 스냅샷 (가이드 §10.2).
 * 지표 파일이나 보고서에 이 객체를 그대로 붙이면 재현 조건이 남는다.
 */
export function configSnapshot(): Record<string, unknown> {
  return {
    promptVersions: { ...PROMPT_VERSIONS },
    embeddingModel: EMBEDDING_MODEL,
    duplicateThreshold: DUPLICATE_SIMILARITY_THRESHOLD,
    ...resolveModels(),
    // RAG 는 아직 없다. 검색 계층(A9)이 들어오면 topK·리랭커 버전이 여기 붙는다.
    retrieval: null,
  };
}

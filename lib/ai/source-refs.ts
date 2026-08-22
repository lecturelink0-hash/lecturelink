/**
 * 출처 위치 유효성 (성능지표 가이드 §2.1·§4.3 · 분담표 A8)
 *
 * 가이드 §4.3 이 분명히 갈라 놓은 두 가지를 코드에서도 갈라 둔다.
 *
 *   **구조적으로 존재하는 출처** — 문항이 가리킨 페이지가 그 자료에 실제로 있는가.
 *      자동 검사 대상이다. 이 파일이 그것을 한다.
 *   **의미상 뒷받침하는 출처** — 그 페이지의 내용이 정말 이 문항의 근거인가.
 *      전문가 검증 대상이다. 코드가 판정할 수 없고, 판정하는 척해서도 안 된다.
 *
 * 둘을 섞으면 "출처 유효성 98%" 같은 수치가 나오는데, 그건 페이지 번호가 존재한다는
 * 뜻일 뿐 근거가 맞다는 뜻이 아니다. 대외 발표에서 그렇게 읽히면 위험하다.
 *
 * import 를 두지 않는다 — 검사 스크립트가 이 파일만 불러 산식을 확인할 수 있어야 한다.
 */

export interface QuestionSourceInput {
  /** 모델이 보고한 출처 페이지(슬라이드 번호). */
  sourcePages?: unknown;
}

export interface SourceRefs {
  /** 원본 파일 내용 해시 — 자료가 바뀌면 이 출처는 더 이상 같은 곳을 가리키지 않는다. */
  fileSha256: string | null;
  /** 검증을 통과한 페이지만 남긴다. */
  pages: number[];
  /** 그 페이지에 해당하는 청크 id. 검수자가 원문을 바로 열 수 있게 한다. */
  chunkIds: string[];
  /** 모델이 보고한 원본 값 — 걸러지기 전. 무엇이 왜 빠졌는지 추적할 수 있어야 한다. */
  reportedPages: number[];
  /** 자료에 없는 페이지를 가리킨 값들. */
  invalidPages: number[];
}

export interface SourceValidation {
  refs: SourceRefs[];
  stats: {
    questions: number;
    /** 출처를 하나라도 보고한 문항 수. */
    withSource: number;
    sourceReportRate: number | null;
    /** 보고된 페이지 참조 총 개수. */
    referencesReported: number;
    referencesValid: number;
    /** 구조적 출처 유효성 — 존재하는 페이지를 가리킨 비율(가이드 §2.1). */
    locationValidRate: number | null;
    /** 존재하지 않는 페이지를 가리킨 문항 수. */
    questionsWithInvalidRef: number;
  };
  warnings: string[];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10000) / 10000 : null;
}

/** 모델이 뭘 넣든 정수 페이지 배열로 정규화한다. 문자열 "3", 3.0, 중복, 음수를 정리한다. */
export function normalizeReportedPages(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const out: number[] = [];
  for (const value of raw) {
    const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
    if (!Number.isFinite(n)) continue;
    const page = Math.trunc(n);
    if (page <= 0) continue;
    if (!out.includes(page)) out.push(page);
  }
  return out.sort((a, b) => a - b);
}

export interface ChunkLocator {
  id: string;
  pageIndex: number;
}

/**
 * 문항별 출처를 검증하고 저장 가능한 형태로 만든다.
 *
 * `availablePages` 는 **실제로 프롬프트에 실린 페이지**여야 한다. 자료 전체 페이지 수를
 * 쓰면, 배치별 구간 분할로 그 배치가 보지도 못한 페이지를 인용해도 통과해 버린다.
 */
export function validateSourceRefs(
  questions: QuestionSourceInput[],
  context: {
    fileSha256?: string | null;
    availablePages: number[];
    chunks?: ChunkLocator[];
  },
): SourceValidation {
  const available = new Set(context.availablePages);
  const chunksByPage = new Map<number, string[]>();
  for (const chunk of context.chunks ?? []) {
    const list = chunksByPage.get(chunk.pageIndex);
    if (list) list.push(chunk.id);
    else chunksByPage.set(chunk.pageIndex, [chunk.id]);
  }

  const refs: SourceRefs[] = [];
  const warnings: string[] = [];
  let withSource = 0;
  let referencesReported = 0;
  let referencesValid = 0;
  let questionsWithInvalidRef = 0;

  questions.forEach((question, index) => {
    const reportedPages = normalizeReportedPages(question.sourcePages);
    const pages = reportedPages.filter((p) => available.has(p));
    const invalidPages = reportedPages.filter((p) => !available.has(p));

    referencesReported += reportedPages.length;
    referencesValid += pages.length;
    if (reportedPages.length > 0) withSource += 1;
    if (invalidPages.length > 0) {
      questionsWithInvalidRef += 1;
      warnings.push(
        `${index + 1}번 문항이 자료에 없는 페이지 ${invalidPages.join('·')} 를 출처로 신고했다.`,
      );
    }

    refs.push({
      fileSha256: context.fileSha256 ?? null,
      pages,
      chunkIds: pages.flatMap((p) => chunksByPage.get(p) ?? []),
      reportedPages,
      invalidPages,
    });
  });

  const missing = questions.length - withSource;
  if (missing > 0) {
    warnings.push(`출처를 신고하지 않은 문항 ${missing}개 — 근거 충실도 검수에서 원문을 찾을 수 없다.`);
  }

  return {
    refs,
    stats: {
      questions: questions.length,
      withSource,
      sourceReportRate: ratio(withSource, questions.length),
      referencesReported,
      referencesValid,
      locationValidRate: ratio(referencesValid, referencesReported),
      questionsWithInvalidRef,
    },
    warnings,
  };
}

/**
 * 저장용으로 줄인 형태. 계측·DB 에는 필요한 것만 넣는다 —
 * 원문 텍스트를 여기 실으면 강의 내용이 계측 테이블로 샌다.
 */
export function toStoredRefs(ref: SourceRefs): Record<string, unknown> | null {
  if (ref.pages.length === 0 && ref.reportedPages.length === 0) return null;
  return {
    fileSha256: ref.fileSha256,
    pages: ref.pages,
    chunkIds: ref.chunkIds,
    ...(ref.invalidPages.length > 0 ? { invalidPages: ref.invalidPages } : {}),
  };
}

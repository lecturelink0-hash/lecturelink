/**
 * AI 가 만들어 준 문제집(user_uploads)의 종류.
 *
 * 강의자료 업로드로 만든 문제집과 달리 원본 파일이 없고, private_questions 만 들어 있어
 * /similar-practice/{uploadId} 로 푼다. 목록 라벨·이동 경로가 갈리는 지점마다
 * file_type 문자열을 흩뿌리지 않도록 여기서 한 번에 판정한다.
 */
export const GENERATED_SET_TYPES = {
  /** 오답노트에서 만든 유사문항 세트 */
  similar: 'generated/similar',
  /** 약점·오답 분석의 집중 코스 — 풀에 문항이 없어 내 문제집 기반으로 미리 생성한 세트 */
  weakArea: 'generated/weak-area',
} as const;

const GENERATED_SET_TYPE_LIST: string[] = Object.values(GENERATED_SET_TYPES);

/** private_questions 로만 이뤄진 AI 생성 세트인지 (= /similar-practice 로 푸는 세트) */
export function isGeneratedSet(fileType: string | null | undefined): boolean {
  return GENERATED_SET_TYPE_LIST.includes(fileType ?? '');
}

/** 문제집 카드에 표시할 출처 라벨 */
export function generatedSetLabel(fileType: string | null | undefined): string | null {
  if (fileType === GENERATED_SET_TYPES.similar) return '오답노트에서 생성';
  if (fileType === GENERATED_SET_TYPES.weakArea) return '약점 분석에서 생성';
  return null;
}

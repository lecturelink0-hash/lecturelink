/**
 * 사진을 붙여 만드는 문항의 few-shot 예시 정리
 *
 * 유사문항 생성은 **원본 문항 자체**를 예시로 넣는다. 원본 해설이
 * "제시된 흉부 X-ray 영상에서는 종격동 확장 소견이 관찰되며…" 처럼 소견을 글로 적으면,
 * 사진을 붙여 만드는 문항이 그 문구를 발문으로 옮겨 **사진을 보지 않고도 풀리는 문항**이
 * 된다(운영 실측 — 프롬프트로 금지해도 예시 쪽 앵커가 이겼다).
 *
 * 예시는 형식 전달용이므로 영상 검사를 말하는 문장만 빼고 나머지는 남긴다.
 * 사진이 없는 문항의 예시는 손대지 않는다 — F23 상 그쪽은 소견을 글로 쓰는 게 맞다.
 */

/**
 * 영상 검사를 말하는 문장을 가려내는 낱말들.
 * 한글 문항에도 `X-ray`·`CXR`·`EKG` 같은 원어가 섞여 나오므로 함께 본다.
 */
const IMAGING_TERMS = new RegExp(
  [
    '사진', '영상', '엑스선', 'X-?선', '컴퓨터단층', '자기공명', '초음파', '심전도',
    '내시경', '조영', '스캔', '도말', '현미경', '판독',
    'X-?ray', 'CXR', 'CT', 'MRI', 'EKG', 'ECG', 'echocardiograph', 'sonograph',
    'radiograph', 'ultrasound', 'imaging',
  ].join('|'),
  'i',
);

/** 마침표 뒤가 공백이거나 끝일 때만 자른다 — `크레아티닌 1.4 mg/dL` 의 소수점에서 잘리면 안 된다. */
function splitSentences(text: string): string[] {
  return text.split(/(?<=\.)(?=\s|$)/);
}

/**
 * 영상 검사를 말하는 문장을 걷어낸다.
 *
 * `keepLastSentence` 는 발문 보호용이다. 발문은 대개 마지막 문장이고
 * ("다음 흉부 X-ray 소견과 같은 환자에게 …것은?") 이걸 지우면 예시가 발문 없는 글이 된다.
 */
export function stripImagingSentences(
  text: string,
  options: { keepLastSentence?: boolean } = {},
): string {
  const sentences = splitSentences(text);
  const lastIndex = sentences.length - 1;
  const kept = sentences.filter(
    (sentence, index) =>
      (options.keepLastSentence && index === lastIndex) || !IMAGING_TERMS.test(sentence),
  );
  if (kept.length === sentences.length) return text;
  return kept.join('').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 이 길이에 못 미치게 깎이면 형식 예시 구실을 못 한다 — 그럴 땐 예시 없이 생성한다. */
const MIN_EXAMPLE_STEM_LENGTH = 40;

export interface QuestionExample {
  stem: string;
  choices: string[];
  explanation: string;
}

/**
 * 사진을 붙여 만드는 문항에 넘길 few-shot 예시.
 * 남는 게 너무 적으면 예시를 아예 넘기지 않는다 — 나쁜 패턴을 다시 가르치는 것보다 낫다.
 */
export function buildImageExamples(source: {
  stem: string;
  choices: string[];
  explanation: string | null;
}): QuestionExample[] | undefined {
  const stem = stripImagingSentences(source.stem, { keepLastSentence: true });
  if (stem.length < MIN_EXAMPLE_STEM_LENGTH) return undefined;
  return [{
    stem,
    choices: source.choices,
    explanation: stripImagingSentences(source.explanation ?? ''),
  }];
}

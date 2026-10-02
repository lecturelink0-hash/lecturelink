/**
 * 이미지 캡션 청크의 순수 계산 (RAG 실행계획 v1.1 · 0-f)
 *
 * 이미지형 요청에서 문항 이미지 후보(크롭)마다 "무엇을 보여 주는 그림인가"를 한두 문장으로 남겨
 * 청크(kind = image_caption)로 저장한다. Phase 1 의 출제 계획(5.2 C)이 캡션 목록으로 이미지 단위를
 * 정하고, 검색(5.2 E)이 modality = image_caption 으로 그림을 찾는다. 캡션 청크가 검색에 걸리지 않으면
 * 이미지 단위를 배정하지 않는다(R5).
 *
 * 캡션은 학생에게 보이지 않는다. 검색·출제 계획 전용이다.
 *
 * import 를 두지 않는다 — 검사 스크립트(`npm run check:rag-caption`)가 이 파일만 불러온다.
 */

export interface ImageCaption {
  /** 그림 종류(예: 흉부 X-ray, H&E 조직 사진, 해부도). 비어 있을 수 있다. */
  imageType: string;
  /** 그림이 보여 주는 것 한두 문장. 비어 있으면 캡션이 없는 것으로 본다. */
  caption: string;
  /** 그림에서 직접 보이는 소견·특징. */
  findings: string[];
}

/** 모델이 길게 써도 청크 하나(1,200자)를 넘지 않게 자른다. */
export const CAPTION_LIMITS = {
  imageTypeChars: 40,
  captionChars: 300,
  findings: 5,
  findingChars: 80,
} as const;

const clean = (s: unknown, max: number): string =>
  typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '';

/**
 * 모델 응답의 캡션 객체를 검사해 정리한다. 형식이 틀리거나 캡션이 비면 null.
 * 키 이름은 image_type·imageType 둘 다 받는다. findings 가 문자열 하나로 오면 배열로 감싼다.
 */
export function parseImageCaption(raw: unknown): ImageCaption | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const caption = clean(o.caption, CAPTION_LIMITS.captionChars);
  if (!caption) return null;
  const imageType = clean(o.image_type ?? o.imageType, CAPTION_LIMITS.imageTypeChars);
  const rawFindings = Array.isArray(o.findings) ? o.findings : typeof o.findings === 'string' ? [o.findings] : [];
  const findings: string[] = [];
  for (const f of rawFindings) {
    const t = clean(f, CAPTION_LIMITS.findingChars);
    if (t && !findings.includes(t)) findings.push(t);
    if (findings.length >= CAPTION_LIMITS.findings) break;
  }
  return { imageType, caption, findings };
}

/**
 * 캡션 → 청크 본문. 그림 종류를 머리에 두어 "X-ray 사진", "조직 사진" 같은 질의가 걸리게 한다.
 *   [이미지: 흉부 X-ray] 우하엽 경화가 보이는 흉부 X-ray.
 *   소견: 우하엽 경화; 공기기관지조영
 */
export function captionChunkText(c: ImageCaption): string {
  const head = c.imageType ? `[이미지: ${c.imageType}]` : '[이미지]';
  const body = `${head} ${c.caption}`;
  return c.findings.length > 0 ? `${body}\n소견: ${c.findings.join('; ')}` : body;
}

/**
 * 캡션을 만들 크롭인가. 페이지 전체 OCR 폴백 크롭(ocrOnly)과 텍스트 캡처로 분류된 크롭은
 * 문항 이미지가 될 수 없으므로 캡션도 만들지 않는다(출력 토큰만 든다).
 */
export function captionEligible(crop: { ocrOnly?: boolean; region: { kind: string } }): boolean {
  return !crop.ocrOnly && crop.region.kind !== 'text_slide';
}

/**
 * 캡션 작성 규칙(captionPrompt). 비교 실험의 후보 A·C 가 같은 규칙을 썼다.
 * 맥락을 주면 모델이 그림에 없는 진단명을 맥락에서 옮겨 적는다(OCR 에서 실측된 맥락 복창과 같은 현상).
 */
export const CAPTION_RULES = [
  '- image_type: 그림 종류를 짧게 쓴다(예: 흉부 X-ray, 복부 CT, 12유도 심전도, H&E 조직 사진, 내시경 사진, 해부도, 모식도, 그래프).',
  '- caption: 이 그림이 무엇을 보여 주는지 한두 문장(200자 이내). 보이는 부위·구조·과정·인쇄된 라벨을 근거로 쓴다.',
  '- findings: 그림에서 직접 보이는 소견·특징 최대 5개(각 40자 이내). 판독할 소견이 없으면 [].',
  '- 주변 맥락은 용어(철자·약어) 참고용이다. 그림에 보이지 않는 진단명·내용을 맥락에서 가져와 쓰지 않는다.',
].join('\n');

/** 캡션 콜 프롬프트에 싣는 주변 맥락(페이지 본문) 상한. OCR 콜과 같다. */
export const CAPTION_CONTEXT_CHARS = 500;

/**
 * 크롭당 캡션 콜의 프롬프트(f-caption-results.md 의 후보 C). 그림 다음에 붙는 텍스트다.
 * 크롭 OCR 콜에 캡션을 덧붙이는 안(후보 A)은 OCR 글자·박스를 눈에 띄게 망가뜨려 채택하지 않았다 —
 * 박스는 정답 단서 라벨을 지우는 마스킹 좌표라 OCR 콜은 건드리지 않는다.
 */
export function captionPrompt(context?: string | null): string {
  const ctx = (context ?? '').slice(0, CAPTION_CONTEXT_CHARS);
  return (
    '이 그림은 의대 강의자료에서 잘라 낸 것이다. 검색용 설명을 JSON 하나로만 출력하라(코드펜스·설명 금지):\n' +
    '{"image_type":"<그림 종류>","caption":"<그림 설명>","findings":["<소견>"]}\n' +
    CAPTION_RULES +
    (ctx ? `\n\n주변 맥락:\n${ctx}` : '')
  );
}

/** 캡션 콜 응답(코드펜스·앞뒤 말이 붙을 수 있음)에서 JSON 객체를 꺼내 검사한다. 실패하면 null. */
export function parseCaptionResponse(raw: string): ImageCaption | null {
  const s = (raw ?? '').indexOf('{');
  const e = (raw ?? '').lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try {
    return parseImageCaption(JSON.parse(raw.slice(s, e + 1)));
  } catch {
    return null;
  }
}

/**
 * OCR 어댑터 — 한·영 동시 인식.
 *
 * 백엔드:
 *   - 'tesseract'         : tesseract.js (브라우저·Node 둘 다, kor+eng traineddata 자동 로드)
 *   - 'claude'            : Claude Vision 호출 (의학 약어·표 구조 가장 강함, 비용 ↑)
 *   - 'auto'              : Claude 우선, 실패 시 Tesseract 폴백
 *
 * 환경변수:
 *   OCR_BACKEND=tesseract|claude|auto    (기본 claude — worker 512MB 메모리 보호: tesseract wasm 미로드)
 *
 * 의존성:
 *   npm install tesseract.js
 *   (Claude 백엔드는 기존 @anthropic-ai/sdk 재사용)
 */

import type Anthropic from '@anthropic-ai/sdk';
import {
  getAnthropic,
  MODELS,
  calculateCost,
  withRetry,
  createMessage,
} from '@/lib/ai/client';
import { recordAiCost } from '@/lib/ai/cost-cap';
import { postprocessText } from './medical-lexicon';

export type OcrBackend = 'tesseract' | 'claude' | 'auto';

/** OCR 이 찾은 텍스트 한 덩어리와 그 위치(원본 픽셀 좌표). */
export interface OcrTextBox {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrResult {
  text: string;
  confidence: number; // 0~1
  backend: 'tesseract' | 'claude';
  costUsd: number;
  durationMs: number;
  /**
   * 텍스트 위치 목록. withBoxes 옵션을 켜고 이미지 크기를 넘긴 경우에만 채워진다.
   * 이미지 속 정답 단서 텍스트를 "덮어서" 지우는 데 사용한다(생성형 인페인팅 대체).
   * 좌표를 위해 별도 호출을 하지 않고, 원래 하던 OCR 호출 1회에서 함께 받아온다.
   */
  boxes?: OcrTextBox[];
}

function pickBackend(): OcrBackend {
  const v = process.env.OCR_BACKEND;
  if (v === 'tesseract' || v === 'claude' || v === 'auto') return v;
  // 기본 claude: tesseract.js(wasm + 한국어 데이터 수백 MB)를 동적 import 하지 않아
  // worker(512MB) 메모리를 아낀다. 폴백이 필요하면 OCR_BACKEND=auto 로 명시.
  return 'claude';
}

async function ocrTesseract(png: Uint8Array): Promise<OcrResult> {
  const t0 = Date.now();
  const tesseract = await import('tesseract.js').catch(() => null);
  if (!tesseract) {
    throw new Error(
      'tesseract.js 가 설치되어 있지 않습니다. `npm install tesseract.js` 후 다시 시도하세요.',
    );
  }

  const { data } = await tesseract.recognize(Buffer.from(png), 'kor+eng', {
    logger: () => {},
  });

  return {
    text: data.text.trim(),
    confidence: (data.confidence ?? 0) / 100,
    backend: 'tesseract',
    costUsd: 0,
    durationMs: Date.now() - t0,
  };
}

async function ocrClaude(input: {
  png: Uint8Array;
  userIdForLog?: string;
  context?: string; // 슬라이드 텍스트 등 힌트
  withBoxes?: boolean;
  widthPx?: number;
  heightPx?: number;
}): Promise<OcrResult> {
  const t0 = Date.now();
  const client = getAnthropic();
  const model = MODELS.verification(); // Haiku
  const base64 = Buffer.from(input.png).toString('base64');

  const wantBoxes = input.withBoxes === true && !!input.widthPx && !!input.heightPx;
  const basePrompt = `이 이미지의 모든 텍스트를 한국어와 영어를 그대로 보존하며 추출하라.

규칙:
- 의학 약어(MI, COPD, ARDS, NSTEMI 등)는 원형 그대로
- 단위(mmHg, mg/dL, bpm 등)는 정확히
- 표·차트 안의 라벨도 포함
- 텍스트가 없으면 빈 문자열
- **이미지에 실제로 보이는 글자만 출력한다.** 추측·보완·번역으로 글자를 만들어내지 마라.
${
  input.context
    ? // 맥락은 철자·약어 표기를 맞추는 데만 쓴다. 이 단서가 없으면 모델이 글자가 거의
      // 없는 영상(조영술·CT 등)에서 맥락 문장을 그대로 복창해 OCR 결과로 내놓는다
      // (실측: 글자 0자인 대동맥 조영술이 맥락 주입 시 247자로 부풀었고, 그 값이
      //  '텍스트 캡처' 판정을 넘겨 멀쩡한 임상영상이 문항에서 제외됐다).
      `- **아래 맥락은 표기(철자·약어) 참고용일 뿐이다. 맥락에 있는 단어라도 이미지에 보이지 않으면 절대 출력하지 마라.**

주변 맥락:
${input.context.slice(0, 500)}`
    : ''
}`;

  // 좌표 모드: 같은 호출에서 위치까지 받는다(추가 호출 0). 좌표계는 모델이 학습한
  // 관례를 그대로 쓴다 — [ymin, xmin, ymax, xmax], 0~1000 정규화.
  const prompt = wantBoxes
    ? `${basePrompt}

출력 형식(JSON 하나만, 코드펜스·설명 금지):
{"full_text":"<전체 텍스트>","items":[{"t":"<텍스트 조각>","box":[ymin,xmin,ymax,xmax]}]}
- box 는 0~1000 으로 정규화한 정수 좌표다.
- **items 는 "한 줄" 단위로 나눈다.** 여러 줄을 하나의 box 로 묶지 마라.
  (묶으면 그 영역을 통째로 덮어야 해서 그림이 손상된다.)
- box 는 그 줄의 글자를 빠짐없이 감싸되 여백은 최소로 한다. 글자 일부가 box 밖으로
  나가면 안 된다 — 특히 줄의 시작·끝 글자와 위아래 획이 잘리지 않게 하라.
- **인쇄된 라벨·캡션·표 안의 글자도 반드시 포함**한다(손글씨 주석만이 아니다).
- 그림의 선·도형·화살표는 텍스트가 아니므로 items 에 넣지 않는다.`
    : `${basePrompt}

OCR 결과만 출력. 설명·머리말 금지.`;

  const response = await withRetry(() =>
    createMessage(client, {
      model,
      max_tokens: 4096,
      // OCR 은 창작이 아니라 판독이다. 기본 temperature(제공자 기본값 1.0)로 두면 같은
      // 이미지에서도 실행마다 좌표 묶음이 달라져(실측: 같은 크롭이 5개/7개) 어떤 실행은
      // 글자를 덜 덮는다. 재현 가능하게 0 으로 고정한다.
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: base64,
              },
            },
            { type: 'text', text: prompt },
          ],
        },
      ],
    }),
  );

  const raw = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  // 좌표 모드 응답 파싱. 실패하면 원문을 그대로 텍스트로 쓴다(기존 동작으로 자연 폴백).
  let text = raw;
  let boxes: OcrTextBox[] | undefined;
  if (wantBoxes) {
    const parsed = parseBoxedOcr(raw, input.widthPx!, input.heightPx!);
    if (parsed) {
      text = parsed.text;
      boxes = parsed.boxes;
    } else {
      console.warn('[ocr] 좌표 JSON 파싱 실패 — 텍스트만 사용');
      text = stripStructuredArtifacts(raw);
    }
  } else {
    text = stripStructuredArtifacts(raw);
  }

  const cost = calculateCost(
    model,
    response.usage.input_tokens,
    response.usage.output_tokens,
    response.usage.cache_read_input_tokens ?? 0,
    response.usage.cache_creation_input_tokens ?? 0,
  );

  await recordAiCost({
    userId: input.userIdForLog ?? null,
    endpoint: 'ocr.claude',
    model,
    costUsd: cost,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  return {
    text,
    // Claude 는 confidence 를 직접 주지 않음 — 텍스트 길이/응답 일관성으로 휴리스틱
    confidence: text.length > 5 ? 0.9 : 0.4,
    backend: 'claude',
    costUsd: cost,
    durationMs: Date.now() - t0,
    boxes,
  };
}

/**
 * 평문 OCR 응답에 섞여 나오는 구조화 출력 잔해를 제거한다.
 *
 * 평문 모드로 요청해도 모델이 간헐적으로 코드펜스 + JSON(box_2d / text_content 등)을
 * 뱉는다. 그대로 두면 실제로는 글자가 없는 이미지가 "글자 60자"로 집계돼 텍스트 캡처
 * 판정·정제 대상 판정을 왜곡한다(실측: 글자 0자인 조영술이 60자로 잡힘).
 * 파싱되면 텍스트 필드만 이어 붙이고, 아니면 코드펜스만 벗겨 돌려준다.
 */
function stripStructuredArtifacts(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith('```') && !/"(?:box_2d|text_content|full_text)"/.test(t)) return raw;
  const body = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(body) as unknown;
    const texts: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        v.forEach(walk);
      } else if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          if (typeof val === 'string') {
            if (k === 'text_content' || k === 't' || k === 'text' || k === 'full_text') {
              texts.push(val);
            }
          } else {
            walk(val);
          }
        }
      }
    };
    walk(parsed);
    return texts.join('\n').trim();
  } catch {
    // JSON 으로 못 읽으면 최소한 코드펜스만 벗긴다.
    return body;
  }
}

/**
 * 좌표 모드 응답을 파싱해 픽셀 좌표 박스로 변환한다.
 * 모델이 코드펜스를 붙이거나 앞뒤에 말을 덧붙이는 경우까지 방어적으로 처리한다.
 */
function parseBoxedOcr(
  raw: string,
  widthPx: number,
  heightPx: number,
): { text: string; boxes: OcrTextBox[] } | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj: { full_text?: unknown; items?: unknown };
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const items = Array.isArray(obj.items) ? obj.items : [];
  const boxes: OcrTextBox[] = [];
  for (const it of items) {
    const o = it as { t?: unknown; box?: unknown };
    const t = typeof o.t === 'string' ? o.t.trim() : '';
    const b = Array.isArray(o.box) ? o.box.map(Number) : null;
    if (!t || !b || b.length !== 4 || b.some((n) => !Number.isFinite(n))) continue;
    // [ymin, xmin, ymax, xmax] (0~1000) → 픽셀
    const [ymin, xmin, ymax, xmax] = b;
    const x0 = Math.max(0, Math.min(widthPx - 1, Math.round((xmin / 1000) * widthPx)));
    const y0 = Math.max(0, Math.min(heightPx - 1, Math.round((ymin / 1000) * heightPx)));
    const x1 = Math.max(0, Math.min(widthPx - 1, Math.round((xmax / 1000) * widthPx)));
    const y1 = Math.max(0, Math.min(heightPx - 1, Math.round((ymax / 1000) * heightPx)));
    if (x1 <= x0 || y1 <= y0) continue;
    boxes.push({ text: t, x0, y0, x1, y1 });
  }
  const text =
    typeof obj.full_text === 'string' && obj.full_text.trim()
      ? obj.full_text.trim()
      : boxes.map((b) => b.text).join('\n');
  return { text, boxes };
}

export async function runOcr(input: {
  png: Uint8Array;
  backend?: OcrBackend;
  userIdForLog?: string;
  context?: string;
  /** 텍스트 위치(박스)도 함께 받는다. widthPx/heightPx 가 있어야 동작. */
  withBoxes?: boolean;
  widthPx?: number;
  heightPx?: number;
}): Promise<OcrResult> {
  const backend = input.backend ?? pickBackend();

  let raw: OcrResult;
  if (backend === 'tesseract') {
    raw = await ocrTesseract(input.png);
  } else if (backend === 'claude') {
    raw = await ocrClaude(input);
  } else {
    // auto: Claude 우선
    try {
      raw = await ocrClaude(input);
    } catch (e) {
      console.warn('[ocr] Claude 실패, Tesseract 로 폴백:', e);
      raw = await ocrTesseract(input.png);
    }
  }

  // P1-A6 후처리 사전 적용
  return {
    ...raw,
    text: postprocessText(raw.text),
  };
}

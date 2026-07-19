/**
 * 이미지에서 "모든 글자"를 지우고 순수한 의학 일러스트/도해 그래픽만 남긴다.
 * (강의 슬라이드의 다이어그램 위/주변에 겹쳐진 한글·영문 설명이 문항의 정답 단서가 되는 문제 대응.)
 *
 * 사용자 요구: 일러스트 이미지는 이미지 내 "모든 텍스트를 빠짐없이" 제거해야 한다.
 * (해부 라벨/영문 용어 포함 — Open surgery, Endovascular repair 같은 라벨이 곧 정답 단서이므로 예외 없이 삭제)
 *
 * Gemini 이미지 편집 모델(gemini-3-pro-image-preview)로 인페인팅한다. 이 모델은 이미지를
 * "재생성"하므로 실제 임상 사진(X-ray/CT/병리 등)에는 적용하지 않는다 — 호출자가
 * 다이어그램/일러스트 유형(anatomy_diagram/chart_graph/other)에만 선별 적용한다.
 */
import { recordAiCost } from '@/lib/ai/cost-cap';

const IMAGE_MODEL = () =>
  process.env.GEMINI_IMAGE_MODEL ?? 'gemini-3-pro-image-preview';

// 이미지 1장당 대략 비용(추정) — 정확한 정산은 provider 청구서 기준. 가시성 목적.
const INPAINT_COST_USD = 0.04;

// 모든 글자를 예외 없이 제거하도록 지시하는 프롬프트. (해부 라벨/영문 용어 포함)
const INPAINT_PROMPT =
  '이 이미지 안에 있는 "모든 글자"를 하나도 빠짐없이 완전히 제거하라. ' +
  '대상: 인쇄된 텍스트, 손으로 쓴 글씨, 한글·영문·숫자·기호, 제목, 캡션, 화살표에 붙은 라벨, ' +
  '해부학 명칭(예: Aorta, Intima, Open surgery, Endovascular repair 등)까지 언어·크기·위치를 불문하고 전부. ' +
  '형광펜/밑줄 등으로 강조된 글자도 그 강조 표시와 함께 제거하라. ' +
  '글자가 있던 자리는 주변 배경(대개 흰색 슬라이드 배경 또는 그림의 인접 색·질감)으로 자연스럽게 메워라. ' +
  '단, 글자가 아닌 순수한 의학 그림·도해·구조·선·화살표 도형·색상은 절대 바꾸거나 지우지 말고 그대로 유지하라. ' +
  '새로운 글자나 요소를 절대 추가하지 마라. 이미지의 크기·비율도 그대로 유지하라. ' +
  '결과 이미지에는 어떤 글자도 남아 있으면 안 된다.';

interface GeminiImageResponse {
  candidates?: Array<{
    content?: { parts?: Array<Record<string, unknown>> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

async function callInpaint(
  model: string,
  key: string,
  png: Uint8Array,
): Promise<Uint8Array | null> {
  const body = JSON.stringify({
    contents: [
      {
        parts: [
          { text: INPAINT_PROMPT },
          { inline_data: { mime_type: 'image/png', data: Buffer.from(png).toString('base64') } },
        ],
      },
    ],
    // 이미지 편집 모델은 responseModalities 를 지정해야 이미지를 반환한다.
    // (미지정 시 텍스트만 반환되어 인페인팅이 조용히 실패하고 원본으로 폴백됨)
    generationConfig: { responseModalities: ['IMAGE'] },
  });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(90_000),
    },
  );

  const json = (await res.json().catch(() => null)) as GeminiImageResponse | null;
  if (!res.ok) {
    console.warn(
      `[inpaint] http ${res.status} model=${model} err=${json?.error?.message ?? ''}`.slice(0, 300),
    );
    return null;
  }
  if (!json) return null;
  const cand = json.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const imgPart = parts.find((p) => 'inlineData' in p || 'inline_data' in p) as
    | { inlineData?: { data?: string }; inline_data?: { data?: string } }
    | undefined;
  const data = imgPart?.inlineData?.data ?? imgPart?.inline_data?.data;
  if (!data) {
    console.warn(
      `[inpaint] no image in response model=${model} finish=${cand?.finishReason ?? ''} block=${json.promptFeedback?.blockReason ?? ''}`,
    );
    return null;
  }
  return new Uint8Array(Buffer.from(data, 'base64'));
}

/**
 * 이미지의 모든 글자를 제거한 PNG 를 반환. 실패 시 null (호출자는 원본 유지).
 * 이미지 모델이 간헐적으로 이미지를 반환하지 않을 수 있어 1회 재시도한다.
 */
export async function inpaintRemoveText(
  png: Uint8Array,
  opts?: { userId?: string },
): Promise<Uint8Array | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  if (process.env.ENABLE_TEXT_INPAINT === '0') return null;

  const model = IMAGE_MODEL();
  let out: Uint8Array | null = null;
  for (let attempt = 0; attempt < 2 && !out; attempt += 1) {
    try {
      out = await callInpaint(model, key, png);
    } catch (e) {
      console.warn(`[inpaint] attempt ${attempt} error: ${e instanceof Error ? e.message : e}`);
      out = null;
    }
  }
  if (!out) return null;

  if (opts?.userId) {
    try {
      await recordAiCost({
        userId: opts.userId,
        endpoint: 'extract.inpaint-text',
        model,
        costUsd: INPAINT_COST_USD,
        inputTokens: 0,
        outputTokens: 0,
      });
    } catch {
      /* 비용 기록 실패는 무시 */
    }
  }
  return out;
}

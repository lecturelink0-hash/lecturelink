/**
 * 이미지에서 "사람이 덧붙인 주석/설명 텍스트"만 제거하고 배경을 자연스럽게 복원한다.
 * (강의 슬라이드의 다이어그램 위에 겹쳐진 한글 설명이 문항의 정답 단서가 되는 문제 대응.)
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

const INPAINT_PROMPT =
  '이 이미지에서 사람이 덧붙인 주석·설명 텍스트(타이핑되거나 손으로 쓴 라벨·문구, 특히 한글 설명 문장)만 ' +
  '완전히 제거하고, 그 자리를 주변 배경 색·질감으로 자연스럽게 채워라. ' +
  '원래의 의학 그림·도표·구조·선·색상, 그리고 그림에 원래 포함된 영문 해부학 라벨(예: Intima, Media)은 ' +
  '절대 바꾸거나 지우지 말고 픽셀 그대로 유지하라. 새로운 요소를 추가하지 마라. 이미지 크기·비율도 유지하라.';

/**
 * 주석 텍스트를 제거한 PNG 를 반환. 실패 시 null (호출자는 원본 유지).
 */
export async function inpaintRemoveText(
  png: Uint8Array,
  opts?: { userId?: string },
): Promise<Uint8Array | null> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  if (process.env.ENABLE_TEXT_INPAINT === '0') return null;

  const model = IMAGE_MODEL();
  const body = JSON.stringify({
    contents: [
      {
        parts: [
          { text: INPAINT_PROMPT },
          { inline_data: { mime_type: 'image/png', data: Buffer.from(png).toString('base64') } },
        ],
      },
    ],
  });

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(75_000),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }>;
    };
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const imgPart = parts.find((p) => 'inlineData' in p || 'inline_data' in p) as
      | { inlineData?: { data?: string }; inline_data?: { data?: string } }
      | undefined;
    const data = imgPart?.inlineData?.data ?? imgPart?.inline_data?.data;
    if (!data) return null;

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
    return new Uint8Array(Buffer.from(data, 'base64'));
  } catch {
    return null;
  }
}

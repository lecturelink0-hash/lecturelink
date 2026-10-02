/**
 * 문항 이미지 후보(크롭) 캡션 — 크롭당 Vision 1콜 (RAG 실행계획 v1.1 · 0-f)
 *
 * 이미지형 요청 + PRIVATE_RAG_MODE shadow·on 에서만 부른다. 결과는 material_chunks 의 image_caption
 * 청크가 되어 Phase 1 의 출제 계획·검색이 그림을 찾는 데 쓴다. 학생에게는 보이지 않는다.
 *
 * 왜 따로 부르나(docs/naesin-rag-candidates/f-caption-results.md)
 *  - 크롭 OCR 콜에 캡션 필드를 덧붙이면(후보 A) 추가 콜은 없지만, 같은 크롭의 OCR 글자 유사도가 1.00 →
 *    0.77, 글자 박스 면적 재현율이 1.00 → 0.76 으로 떨어졌고 캡션도 44% 만 돌아왔다. 박스는 정답 단서
 *    라벨을 지우는 마스킹 좌표라 OCR 콜은 건드리지 않는다.
 *  - 이 콜은 크롭당 $0.0001 안팎(gemini-2.5-flash-lite), 지연 중앙값 1.4초로 OCR 과 나란히 돈다.
 *
 * 모델은 OCR·검출과 같은 검증 모델(MODELS.verification)이다. 표시용 원본 색상 크롭을 넣는다
 * (OCR 전처리본은 심전도·X-ray 를 흑백으로 바꾸고 대비를 늘려 색 정보가 사라진다).
 */

import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropic, MODELS, calculateCost, withRetry, createMessage } from '@/lib/ai/client';
import { recordAiCost } from '@/lib/ai/cost-cap';
import { captionPrompt, parseCaptionResponse, type ImageCaption } from '@/lib/rag/caption';

export interface CaptionImageResult {
  /** 형식이 틀리면 null(호출 비용은 그래도 든다). */
  caption: ImageCaption | null;
  costUsd: number;
  durationMs: number;
}

export async function captionImage(input: {
  png: Uint8Array;
  /** 크롭이 나온 페이지 본문. 용어(철자·약어) 참고용으로만 쓰라고 프롬프트에 적는다. */
  context?: string;
  userIdForLog?: string;
}): Promise<CaptionImageResult> {
  const t0 = Date.now();
  const model = MODELS.verification();
  const response = await withRetry(() =>
    createMessage(getAnthropic(), {
      model,
      max_tokens: 1024,
      // 캡션은 검색용 기술이라 재현 가능해야 한다. 같은 그림이면 같은 캡션(= 같은 청크 id)이 나오게.
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: Buffer.from(input.png).toString('base64') },
            },
            { type: 'text', text: captionPrompt(input.context) },
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
  const cost = calculateCost(
    model,
    response.usage.input_tokens,
    response.usage.output_tokens,
    response.usage.cache_read_input_tokens ?? 0,
    response.usage.cache_creation_input_tokens ?? 0,
  );
  await recordAiCost({
    userId: input.userIdForLog ?? null,
    endpoint: 'extract.caption',
    model,
    costUsd: cost,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });
  return { caption: parseCaptionResponse(raw), costUsd: cost, durationMs: Date.now() - t0 };
}

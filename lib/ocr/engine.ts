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

export interface OcrResult {
  text: string;
  confidence: number; // 0~1
  backend: 'tesseract' | 'claude';
  costUsd: number;
  durationMs: number;
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
}): Promise<OcrResult> {
  const t0 = Date.now();
  const client = getAnthropic();
  const model = MODELS.verification(); // Haiku
  const base64 = Buffer.from(input.png).toString('base64');

  const prompt = `이 이미지의 모든 텍스트를 한국어와 영어를 그대로 보존하며 추출하라.

규칙:
- 의학 약어(MI, COPD, ARDS, NSTEMI 등)는 원형 그대로
- 단위(mmHg, mg/dL, bpm 등)는 정확히
- 표·차트 안의 라벨도 포함
- 텍스트가 없으면 빈 문자열
${input.context ? `\n주변 맥락:\n${input.context.slice(0, 500)}` : ''}

OCR 결과만 출력. 설명·머리말 금지.`;

  const response = await withRetry(() =>
    createMessage(client, {
      model,
      max_tokens: 4096,
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

  const text = response.content
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
  };
}

export async function runOcr(input: {
  png: Uint8Array;
  backend?: OcrBackend;
  userIdForLog?: string;
  context?: string;
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

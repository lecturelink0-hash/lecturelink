/**
 * 슬라이드 이미지에서 의료 이미지(ECG·X-ray·CT·MRI·병리·해부 등) 영역 자동 절단.
 *
 * 전략:
 *   1. 슬라이드 PNG 를 Claude Vision 에 넘겨 의료 이미지 영역의 정규화 좌표 [0..1] 요청
 *   2. tool_use 로 구조화 응답 받기
 *   3. @napi-rs/canvas 로 해당 영역만 잘라 PNG 산출
 *
 * 비용: 슬라이드당 1회 Vision 호출. Haiku 4.5 사용으로 비용 최소화.
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

export type MedicalImageKind =
  | 'xray'
  | 'ct'
  | 'mri'
  | 'ecg'
  | 'pathology'
  | 'microscope'
  | 'ultrasound'
  | 'anatomy_diagram'
  | 'chart_graph'
  // 강의록 본문/필기 텍스트 캡처 — 의료 이미지가 아님. 문항 이미지로 절대 사용 금지
  // (텍스트 안에 정답 단서가 그대로 들어 있음). 검출 모델이 애매한 영역을 여기로
  // 분류하게 해서 xray/ct 등으로 오분류되는 것을 막는다.
  | 'text_slide'
  | 'other';

export interface CropRegion {
  kind: MedicalImageKind;
  /** 정규화 좌표 (0~1). x,y 는 좌상단. */
  x: number;
  y: number;
  width: number;
  height: number;
  caption?: string;
  /** Claude 의 자신감 0~1 */
  confidence: number;
}

export interface DetectionResult {
  regions: CropRegion[];
  costUsd: number;
}

const TOOL_SCHEMA = {
  name: 'report_medical_regions',
  description:
    '슬라이드 이미지에서 의료 이미지(EKG, 영상의학, 병리, 해부 diagram, 임상 사진) 영역의 위치를 보고',
  input_schema: {
    type: 'object',
    properties: {
      regions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            kind: {
              type: 'string',
              enum: [
                'xray',
                'ct',
                'mri',
                'ecg',
                'pathology',
                'microscope',
                'ultrasound',
                'anatomy_diagram',
                'chart_graph',
                'text_slide',
                'other',
              ],
            },
            x: { type: 'number', description: '좌상단 x (0~1)' },
            y: { type: 'number', description: '좌상단 y (0~1)' },
            width: { type: 'number', description: '너비 (0~1)' },
            height: { type: 'number', description: '높이 (0~1)' },
            caption: {
              type: 'string',
              description: '주변 텍스트에서 찾은 캡션 또는 라벨 (없으면 생략)',
            },
            confidence: {
              type: 'number',
              description: '0~1. 0.7 미만이면 호출자가 무시 권장',
            },
          },
          required: ['kind', 'x', 'y', 'width', 'height', 'confidence'],
        },
      },
    },
    required: ['regions'],
  },
} as const;

const SYSTEM = `너는 의대 강의 슬라이드 이미지를 분석해 의료 이미지(EKG/심전도, X-ray, CT, MRI, 초음파, 병리·현미경 사진, 임상 사진, 해부도/diagram, 그래프/차트)의 위치를 보고하는 도구다.

규칙:
- 텍스트 설명·제목·머리글·꼬리글 영역은 보고하지 말 것
- **텍스트가 주된 내용인 영역은 절대 의료 이미지 유형으로 분류하지 말 것.**
  본문 문단, 형광펜/밑줄 강조된 강의 텍스트, 손필기·타이핑 주석, 표(텍스트 표),
  bullet 목록 등은 그 안에 "X-ray", "CT", "MRI" 같은 단어가 있어도 실제 영상이
  아니다 — 굳이 보고해야 한다면 kind='text_slide' 로 분류하라 (호출자가 제외한다).
- xray/ct/mri/ecg/pathology/microscope/ultrasound 는 **실제 사진·영상이 픽셀로
  보이는 경우에만** 사용한다. 내용을 설명하는 텍스트만 있는 영역은 해당되지 않는다.
- 슬라이드 배경·로고는 보고하지 말 것
- 의료 이미지가 없는 슬라이드면 regions=[] 로 반환
- 좌표는 0~1 정규화 (슬라이드 좌상단=0,0 / 우하단=1,1)
- 여러 이미지가 한 슬라이드에 있으면 각각 별도 region
- confidence 가 낮으면 솔직히 낮게 보고 (0.5 이하 가능)`;

/**
 * 단일 슬라이드 PNG 에서 의료 이미지 영역 검출.
 */
export async function detectMedicalRegions(input: {
  slidePng: Uint8Array;
  userIdForLog?: string;
}): Promise<DetectionResult> {
  const client = getAnthropic();
  const model = MODELS.verification(); // Haiku (저비용)
  const base64 = Buffer.from(input.slidePng).toString('base64');

  const response = await withRetry(() =>
    createMessage(client, {
      model,
      max_tokens: 2048,
      system: SYSTEM,
      tools: [TOOL_SCHEMA],
      tool_choice: { type: 'tool', name: 'report_medical_regions' },
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
            {
              type: 'text',
              text: '이 슬라이드의 의료 이미지 영역을 보고하라.',
            },
          ],
        },
      ],
    }),
  );

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
  );

  const regionsRaw =
    (toolUse?.input as { regions?: CropRegion[] } | undefined)?.regions ?? [];

  // 유효성 필터링
  const regions = regionsRaw
    .filter(
      (r) =>
        r.x >= 0 &&
        r.x < 1 &&
        r.y >= 0 &&
        r.y < 1 &&
        r.width > 0.02 &&
        r.height > 0.02 &&
        r.x + r.width <= 1.01 &&
        r.y + r.height <= 1.01 &&
        r.confidence >= 0.6,
    )
    .map((r) => ({
      ...r,
      width: Math.min(r.width, 1 - r.x),
      height: Math.min(r.height, 1 - r.y),
    }));

  const cost = calculateCost(
    model,
    response.usage.input_tokens,
    response.usage.output_tokens,
    response.usage.cache_read_input_tokens ?? 0,
    response.usage.cache_creation_input_tokens ?? 0,
  );

  await recordAiCost({
    userId: input.userIdForLog ?? null,
    endpoint: 'extract.detect-regions',
    model,
    costUsd: cost,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  return { regions, costUsd: cost };
}

export interface CroppedImage {
  region: CropRegion;
  png: Uint8Array;
  widthPx: number;
  heightPx: number;
  /**
   * 페이지 전체를 잡은 OCR 폴백 크롭 여부. true 면 OCR(텍스트 추출)용으로만 쓰고
   * 학생에게 보여주는 문항 이미지 후보(featured)에서는 제외한다.
   * (페이지 전체 크롭은 주석 텍스트·여러 그림이 섞여 정답 단서·지저분한 크롭의 원인이 됨.)
   */
  ocrOnly?: boolean;
  /** 이 크롭에서 OCR 로 추출된 텍스트(주석 유무 판정·인페인팅 대상 선별에 사용). */
  ocrText?: string;
  /** OCR 전용 전처리본(대비 정규화/흑백). 표시·인페인팅은 원본 색상 png 를 쓴다. */
  ocrPng?: Uint8Array;
}

/**
 * 슬라이드 PNG + region 정규화 좌표 → 절단된 PNG 들.
 */
export async function cropRegions(
  slidePng: Uint8Array,
  regions: CropRegion[],
): Promise<CroppedImage[]> {
  if (regions.length === 0) return [];

  // canvas 백엔드는 node-canvas(cairo) — @napi-rs/canvas 의 napi 충돌 회피.
  const { loadImage, createCanvas } = await import('canvas');
  const img = await loadImage(Buffer.from(slidePng));
  const W = img.width;
  const H = img.height;

  // 박스 여백 보정용 파라미터.
  const PAD_FRAC = 0.02; // Vision 박스가 그림 가장자리를 살짝 잘라내는 경우 대비 — 2% 확장 후 트림.
  const sharpMod = (await import('sharp')).default;

  const out: CroppedImage[] = [];
  for (const r of regions) {
    // 페이지 전체(≈full-page, OCR 폴백) 크롭은 정밀화하지 않는다 — 텍스트 전체 보존.
    const isFullPage = r.width >= 0.98 && r.height >= 0.98;

    // (1) 소량 패딩으로 확장 후 이미지 경계로 클램프 — 그림 가장자리 유실 방지.
    const pad = isFullPage ? 0 : PAD_FRAC;
    const x0 = Math.max(0, Math.floor((r.x - pad) * W));
    const y0 = Math.max(0, Math.floor((r.y - pad) * H));
    const x1 = Math.min(W, Math.ceil((r.x + r.width + pad) * W));
    const y1 = Math.min(H, Math.ceil((r.y + r.height + pad) * H));
    let w = x1 - x0;
    let h = y1 - y0;
    if (w < 16 || h < 16) continue;

    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, x0, y0, w, h, 0, 0, w, h);
    let png: Buffer = canvas.toBuffer('image/png');

    // (2) 콘텐츠 기반 트림 — 균일 배경 테두리(추가한 패딩 여백·기존 여백·이웃 그림과의
    //     배경 간격)를 제거해 그림에 딱 맞게 정리한다. 전체 페이지 크롭은 트림하지 않는다.
    if (!isFullPage) {
      try {
        const trimmed = await sharpMod(png).trim({ threshold: 12 }).png().toBuffer();
        const meta = await sharpMod(trimmed).metadata();
        if ((meta.width ?? 0) >= 16 && (meta.height ?? 0) >= 16) {
          png = trimmed;
          w = meta.width ?? w;
          h = meta.height ?? h;
        }
      } catch {
        // 트림 실패(단색 이미지 등) 시 패딩 크롭 원본 유지.
      }
    }

    out.push({
      region: r,
      png: new Uint8Array(png),
      widthPx: w,
      heightPx: h,
    });
  }
  return out;
}

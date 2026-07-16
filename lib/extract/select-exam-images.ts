/**
 * 추출된 후보 이미지 중 "시험 문항(이미지 판독형)에 쓸 만한 실제 의료 이미지"만 AI로 선별.
 *
 * PDF 임베드 이미지를 전부 뽑으면 로고·아이콘·장식·표지·순수 도표도 섞인다. 여기서
 * 후보 썸네일들을 한 번의 Vision 호출로 배치 판정해, 판독 가치가 있는 의료 이미지만 고른다.
 * (kind 도 함께 받아 캡션/표시에 활용.)
 *
 * 실패(모델 오류/429)해도 생성은 계속되도록, 실패 시 면적 큰 순 폴백을 호출측이 쓰게 한다.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropic, MODELS, withRetry, createMessage } from '@/lib/ai/client';
import type { MedicalImageKind } from './crop-medical-images';
import type { EmbeddedImage } from './pdf-embedded-images';

const KINDS: MedicalImageKind[] = [
  'xray', 'ct', 'mri', 'ecg', 'pathology', 'microscope',
  'ultrasound', 'anatomy_diagram', 'chart_graph', 'other',
];

const SELECT_TOOL = {
  name: 'select_exam_images',
  description: '각 이미지가 의대 시험의 이미지 판독형 문항에 쓸 만한 실제 의료 이미지인지 판정',
  input_schema: {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: '제시된 [이미지 N] 의 번호' },
            useful: {
              type: 'boolean',
              description:
                '판독·해석해서 푸는 문항에 쓸 만한 실제 의료 이미지면 true. 로고/아이콘/장식/배경/표지/순수 텍스트·표/의미없는 그래프/저품질·잘림이면 false',
            },
            kind: { type: 'string', enum: KINDS },
          },
          required: ['index', 'useful', 'kind'],
        },
      },
    },
    required: ['results'],
  },
} as const;

const SELECT_SYSTEM = `너는 의대 시험 문항 제작을 돕는 이미지 선별 도구다. 여러 이미지가 [이미지 0], [이미지 1] ... 순서로 주어진다.
각 이미지가 "이미지를 직접 보고 판독·해석해야 풀 수 있는 시험 문항"에 쓸 만한 실제 의료 이미지인지 판정하라.

- useful=true: X-ray, CT, MRI, 초음파, 심전도(ECG), 병리·현미경 사진, 임상 사진, 판독 가치가 있는 해부도/모식도 등
- useful=false: 로고·아이콘·장식·배경·표지, 순수 텍스트/표, 의미 없는 장식 그래프, 잘리거나 저품질이라 판독 불가한 이미지
- 제시된 모든 이미지에 대해 index 를 하나씩 빠짐없이 판정 결과에 포함하라.`;

interface Classified {
  index: number;
  useful: boolean;
  kind: MedicalImageKind;
}

/** 후보 이미지를 배치 판정해, useful 로 선별된 것만 kind 와 함께 반환. 실패 시 null(폴백 신호). */
export async function selectExamImages(
  candidates: EmbeddedImage[],
  opts: { max?: number; thumbEdgePx?: number } = {},
): Promise<{ image: EmbeddedImage; kind: MedicalImageKind }[] | null> {
  if (candidates.length === 0) return [];
  const max = opts.max ?? 15;
  const thumbEdge = opts.thumbEdgePx ?? 320;

  // 판정 비용을 낮추기 위해 작은 썸네일로 다운스케일해 배치 전송.
  const { loadImage, createCanvas } = await import('canvas');
  const thumbs: string[] = [];
  for (const c of candidates) {
    try {
      const img = await loadImage(Buffer.from(c.png));
      const scale = Math.min(1, thumbEdge / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = createCanvas(w, h);
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      thumbs.push(canvas.toBuffer('image/png').toString('base64'));
    } catch {
      thumbs.push(''); // 로드 실패 → 빈 자리(아래에서 skip)
    }
  }

  const content: Anthropic.MessageParam['content'] = [];
  for (let i = 0; i < thumbs.length; i++) {
    if (!thumbs[i]) continue;
    content.push({ type: 'text', text: `[이미지 ${i}]` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: thumbs[i] },
    } as Anthropic.ImageBlockParam);
  }
  content.push({
    type: 'text',
    text: '위 각 이미지가 시험 문항에 쓸 만한 의료 이미지인지 모두 판정하라.',
  });

  let classified: Classified[];
  try {
    const client = getAnthropic();
    const response = await withRetry(
      () =>
        createMessage(client, {
          model: MODELS.verification(),
          max_tokens: 4000,
          system: SELECT_SYSTEM,
          tools: [SELECT_TOOL],
          tool_choice: { type: 'tool', name: 'select_exam_images' },
          messages: [{ role: 'user', content }],
        }),
      { maxAttempts: 4 },
    );
    const tool = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!tool) return null;
    classified = ((tool.input as { results?: Classified[] }).results ?? []).filter(
      (r) => typeof r?.index === 'number',
    );
  } catch {
    return null; // 판정 실패 → 호출측 폴백
  }

  const byIndex = new Map<number, Classified>();
  for (const r of classified) byIndex.set(r.index, r);

  // 선별: useful=true 인 후보만, 원래 면적(큰 순) 유지, 상한 적용.
  const selected: { image: EmbeddedImage; kind: MedicalImageKind }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const r = byIndex.get(i);
    if (r?.useful) {
      selected.push({ image: candidates[i], kind: KINDS.includes(r.kind) ? r.kind : 'other' });
    }
  }
  return selected.slice(0, max);
}

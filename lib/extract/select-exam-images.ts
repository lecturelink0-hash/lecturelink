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
            score: {
              type: 'integer',
              description:
                '판독·해석 가치 1~5. 5=그 이미지를 직접 판독해야만 풀리는 전형적 시험 자료(뚜렷한 소견의 영상·병리 사진), ' +
                '3=문항에 쓸 수 있으나 텍스트로도 대체 가능, 1=거의 가치 없음. useful=false 면 1.',
            },
          },
          required: ['index', 'useful', 'kind', 'score'],
        },
      },
    },
    required: ['results'],
  },
} as const;

const SELECT_SYSTEM = `너는 의대 시험 문항 제작을 돕는 이미지 선별 도구다. 여러 이미지가 [이미지 0], [이미지 1] ... 순서로 주어진다.
각 이미지가 "이미지를 직접 보고 판독·해석해야 풀 수 있는 시험 문항"에 쓸 만한 실제 의료 이미지인지 판정하라.

- useful=true: X-ray, CT, MRI, 초음파, 심전도(ECG), 병리·현미경 사진, 임상 사진, 판독 가치가 있는 해부도/모식도, 수치·데이터를 읽어야 해석되는 도표/그래프 등
- useful=false: 로고·아이콘·장식·배경·표지, 순수 텍스트/표, 의미 없는 장식 그래프, 잘리거나 저품질이라 판독 불가한 이미지
- score(1~5): 판독 가치. 5 = 그 이미지를 직접 판독해야만 풀리는 전형적 시험 자료, 3 = 쓸 수 있으나 텍스트로도 대체 가능,
  1 = 거의 가치 없음. 크기·해상도가 아니라 **판독 가치**로만 매겨라(작아도 소견이 뚜렷하면 높게).
  같은 그림을 쪼갠 조각이나 거의 같은 내용이 여러 장이면 가장 완전한 1장만 높게 주고 나머지는 낮춰라.
- 제시된 모든 이미지에 대해 index 를 하나씩 빠짐없이 판정 결과에 포함하라.`;

/**
 * 한 번의 판정 호출에 넣는 후보 수. 판정은 이미지별 독립이라 나눠도 결과가 같고,
 * 응답 길이에 비례하는 지연만 줄어든다.
 *
 * 같은 후보 26장으로 A/B 실측(각 2회):
 *   1콜(26장)  8.0 / 8.2초
 *   2콜(13장)  7.0 / 5.9초
 *   4콜(8장)   6.6 / 5.0초   ← 채택
 * 이미지 업로드·전처리 같은 고정 비용이 있어 호출 수에 반비례하지는 않는다(절반까지는
 * 줄지 않는다). 더 잘게 쪼개면 병렬 호출만 늘어 레이트리밋 압력이 커지므로 4묶음 선에서 멈춘다.
 */
const SELECT_CHUNK_SIZE = 8;

interface Classified {
  index: number;
  useful: boolean;
  kind: MedicalImageKind;
  score?: number;
}

/** 선별 진단 — 상한 절삭 "이전"의 판정 결과를 호출측이 기록할 수 있게 한다. */
export interface SelectExamImagesDiag {
  /** 판정에 넣은 후보 수. */
  candidates?: number;
  /** useful=true 판정 수(상한 절삭 전). */
  usefulCount?: number;
  /** 상한 절삭 후 반환 수. */
  returned?: number;
  /** 절삭으로 버려진 useful 이미지 수. */
  droppedByCap?: number;
  /** 반환분의 kind 분포. */
  kinds?: Record<string, number>;
  /** 판정에 실패해 '판정 불가'로 살린 묶음 수(0 이면 전부 정상 판정). */
  failedChunks?: number;
  /** 판정 호출을 몇 묶음으로 나눴는지. */
  chunks?: number;
}

/**
 * useful 후보를 상한(max)까지 고르되, "점수 높은 순 + kind 다양성"을 함께 만족시킨다.
 *
 * 종전에는 후보 배열 순서(= 면적 내림차순)를 그대로 유지한 채 앞에서 잘랐다. 그래서
 * 작지만 판독 가치가 큰 영상(심초음파 등)이 밀려나고, 같은 그림을 쪼갠 조각들이 면적만으로
 * 상위를 독식했다(실측: 26장 전부 useful 인데 면적 상위 8장만 생존, 버려진 18장 중 9장이
 * 진짜 임상영상). kind 별 버킷을 라운드로빈으로 돌면서 각 버킷 내부는 점수 우선으로 뽑아
 * 영상·모식도가 고르게 섞이게 한다.
 */
function pickDiverse<T>(
  items: Array<{ image: T; kind: MedicalImageKind; score: number; order: number }>,
  max: number,
): Array<{ image: T; kind: MedicalImageKind }> {
  const buckets = new Map<MedicalImageKind, typeof items>();
  for (const it of items) {
    const arr = buckets.get(it.kind) ?? [];
    arr.push(it);
    buckets.set(it.kind, arr);
  }
  // 버킷 내부: 점수 높은 순 → 동점이면 원래 순서(면적 큰 순) 유지.
  for (const arr of buckets.values()) {
    arr.sort((a, b) => b.score - a.score || a.order - b.order);
  }
  // 버킷 순회 순서: 각 버킷 최고 점수가 높은 kind 부터.
  const order = [...buckets.entries()].sort(
    (a, b) => (b[1][0]?.score ?? 0) - (a[1][0]?.score ?? 0) || a[1][0].order - b[1][0].order,
  );
  const picked: Array<{ image: T; kind: MedicalImageKind }> = [];
  for (let round = 0; picked.length < max; round++) {
    let progressed = false;
    for (const [, arr] of order) {
      if (picked.length >= max) break;
      const it = arr[round];
      if (!it) continue;
      picked.push({ image: it.image, kind: it.kind });
      progressed = true;
    }
    if (!progressed) break; // 모든 버킷 소진
  }
  return picked;
}

/**
 * 후보 이미지를 배치 판정해, useful 로 선별된 것만 kind 와 함께 반환. 실패 시 null(폴백 신호).
 * 제네릭: 후보에 부가 필드(pageIndex 등)가 있으면 그대로 보존해 돌려준다.
 */
export async function selectExamImages<T extends EmbeddedImage>(
  candidates: T[],
  opts: { max?: number; thumbEdgePx?: number; diag?: SelectExamImagesDiag } = {},
): Promise<{ image: T; kind: MedicalImageKind }[] | null> {
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

  // ── 판정을 여러 묶음으로 쪼개 병렬 호출한다.
  //
  // 판정은 이미지별로 독립이라 나눠도 결과가 달라지지 않는데, 한 번에 몰아 보내면
  // 응답(=출력 토큰) 길이에 비례해 지연이 커진다. 이 호출은 임계경로 위에 있다
  // (끝나야 크롭이 확정되고 OCR·정제·이미지 배치가 시작). 실측 A/B 는 위 상수 주석 참고
  // — 26장 기준 8.1초(1콜) → 5.8초(4콜). 총 토큰량이 같아 비용은 동일하다.
  const chunkStarts: number[] = [];
  for (let i = 0; i < candidates.length; i += SELECT_CHUNK_SIZE) chunkStarts.push(i);

  const judgeChunk = async (start: number): Promise<Classified[] | null> => {
    const end = Math.min(candidates.length, start + SELECT_CHUNK_SIZE);
    const content: Anthropic.MessageParam['content'] = [];
    for (let i = start; i < end; i++) {
      if (!thumbs[i]) continue;
      // 묶음 안에서는 0부터 다시 번호를 매기고, 응답을 전역 인덱스로 되돌린다.
      content.push({ type: 'text', text: `[이미지 ${i - start}]` });
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: thumbs[i] },
      } as Anthropic.ImageBlockParam);
    }
    if (content.length === 0) return [];
    content.push({
      type: 'text',
      text: '위 각 이미지가 시험 문항에 쓸 만한 의료 이미지인지 모두 판정하라.',
    });

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
    return ((tool.input as { results?: Classified[] }).results ?? [])
      .filter((r) => typeof r?.index === 'number')
      .map((r) => ({ ...r, index: r.index + start }));
  };

  let classified: Classified[];
  {
    const settled = await Promise.all(
      chunkStarts.map((start) =>
        judgeChunk(start).catch(() => null as Classified[] | null),
      ),
    );
    // 전 묶음 실패 = 판정 자체가 불가 → 호출측 폴백(면적 큰 순)에 맡긴다.
    if (settled.every((r) => r === null)) return null;
    classified = settled.flatMap((r, i) => {
      if (r !== null) return r;
      // 일부 묶음만 실패하면 그 구간은 "판정 불가"로 두고 후보를 살린다.
      // (버리면 멀쩡한 의료 이미지가 통째로 사라진다. 호출측 전체 폴백과 같은 취급.)
      const start = chunkStarts[i];
      const end = Math.min(candidates.length, start + SELECT_CHUNK_SIZE);
      if (opts.diag) opts.diag.failedChunks = (opts.diag.failedChunks ?? 0) + 1;
      return Array.from({ length: end - start }, (_, k) => ({
        index: start + k,
        useful: true,
        kind: 'other' as MedicalImageKind,
        score: 2,
      }));
    });
  }

  const byIndex = new Map<number, Classified>();
  for (const r of classified) byIndex.set(r.index, r);

  // useful=true 후보를 점수와 함께 모은다(order = 원래 순서 = 면적 내림차순).
  const usefulItems: Array<{
    image: T;
    kind: MedicalImageKind;
    score: number;
    order: number;
  }> = [];
  for (let i = 0; i < candidates.length; i++) {
    const r = byIndex.get(i);
    if (!r?.useful) continue;
    // 점수 누락(구 응답·스키마 미준수)은 중립값으로 — 점수 없다고 버리지 않는다.
    const raw = typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : 3;
    usefulItems.push({
      image: candidates[i],
      kind: KINDS.includes(r.kind) ? r.kind : 'other',
      score: Math.min(5, Math.max(1, Math.round(raw))),
      order: i,
    });
  }

  const picked = pickDiverse(usefulItems, max);
  if (opts.diag) {
    opts.diag.candidates = candidates.length;
    opts.diag.chunks = chunkStarts.length;
    opts.diag.usefulCount = usefulItems.length;
    opts.diag.returned = picked.length;
    opts.diag.droppedByCap = Math.max(0, usefulItems.length - picked.length);
    opts.diag.kinds = picked.reduce<Record<string, number>>((acc, p) => {
      acc[p.kind] = (acc[p.kind] ?? 0) + 1;
      return acc;
    }, {});
  }
  return picked;
}

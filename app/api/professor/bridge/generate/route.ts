import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getAnthropic, MODELS, createMessage, withRetry } from '@/lib/ai/client';
import { requireDailyCostCap } from '@/lib/ai/cost-cap';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';
import { createServerClient } from '@/lib/db/server';
import { extractTeachingMaterial, loadTeachingMaterialFile } from '@/lib/teaching/materials';
import { findVerifiedPubMedSources } from '@/lib/medical-sources/pubmed';
import { repairInfographicText, type InfographicTextPatch } from '@/lib/ai/infographic-text-repair';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_INFOGRAPHIC_BYTES = 900_000;

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function optimizeInfographic(dataUrl: string) {
  const match = dataUrl.match(/^data:image\/(?:png|jpeg|webp);base64,(.+)$/s);
  if (!match) return dataUrl;
  const original = Buffer.from(match[1], 'base64');
  if (original.byteLength <= MAX_INFOGRAPHIC_BYTES) return dataUrl;

  try {
    const { createCanvas, loadImage } = await import('canvas');
    const image = await loadImage(original);
    for (const maxWidth of [1440, 1280, 1120, 960]) {
      const scale = Math.min(1, maxWidth / image.width);
      const canvas = createCanvas(
        Math.max(1, Math.round(image.width * scale)),
        Math.max(1, Math.round(image.height * scale)),
      );
      const context = canvas.getContext('2d');
      context.fillStyle = '#fffdf7';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      for (const quality of [0.86, 0.76, 0.66, 0.56]) {
        const compressed = canvas.toBuffer('image/jpeg', { quality, progressive: true });
        if (compressed.byteLength <= MAX_INFOGRAPHIC_BYTES) {
          return `data:image/jpeg;base64,${compressed.toString('base64')}`;
        }
      }
    }
  } catch {
    return null;
  }

  return null;
}

function escapeSvg(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character] ?? character);
}

function svgText(value: string, x: number, y: number, options: { size?: number; weight?: number; color?: string; width?: number; lineHeight?: number } = {}) {
  const size = options.size ?? 30;
  const width = options.width ?? 28;
  const lineHeight = options.lineHeight ?? Math.round(size * 1.35);
  const words = value.replace(/\s+/g, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return `<text x="${x}" y="${y}" font-family="Arial, 'Noto Sans KR', sans-serif" font-size="${size}" font-weight="${options.weight ?? 500}" fill="${options.color ?? '#203039'}">${lines.slice(0, 3).map((item, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeSvg(item)}</tspan>`).join('')}</text>`;
}

function generateFallbackInfographic(result: z.infer<typeof resultSchema>) {
  const concepts = result.prerequisiteConcepts.slice(0, 4);
  const reminders = result.mustRemember.slice(0, 5);
  const questions = result.readinessCheck.slice(0, 2);
  const conceptCards = concepts.map((concept, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 80 + column * 550;
    const y = 510 + row * 285;
    return `<g><rect x="${x}" y="${y}" width="500" height="235" rx="32" fill="${column === 0 ? '#EAF5F1' : '#EEF2FA'}" stroke="#C7D8D3" stroke-width="2"/>${svgText(concept.name, x + 30, y + 54, { size: 30, weight: 800, color: '#155D62', width: 23 })}${svgText(concept.quickReview, x + 30, y + 110, { size: 23, width: 32, lineHeight: 31 })}</g>`;
  }).join('');
  const reminderLines = reminders.map((item, index) => `${index + 1}. ${item}`).join('   •   ');
  const questionLines = questions.map((item, index) => `Q${index + 1}. ${item.question}`).join('     ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1800" viewBox="0 0 1200 1800">
    <rect width="1200" height="1800" fill="#FFFCF5"/>
    <path d="M80 190 C250 90 360 240 520 150 S830 85 1120 175" fill="none" stroke="#D5E8E2" stroke-width="18" stroke-linecap="round" opacity=".75"/>
    <circle cx="1050" cy="130" r="62" fill="#E85555" opacity=".95"/><path d="M1018 132 h22 l12 -23 18 49 15 -26 h28" fill="none" stroke="white" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
    ${svgText('수업 전 1페이지 예습 지도', 80, 90, { size: 26, weight: 800, color: '#C05A3B', width: 40 })}
    ${svgText(result.title, 80, 165, { size: 55, weight: 900, color: '#173943', width: 25, lineHeight: 66 })}
    ${svgText(result.courseConnection, 82, 305, { size: 27, color: '#53656D', width: 54, lineHeight: 38 })}
    <rect x="80" y="390" width="1040" height="82" rx="41" fill="#173943"/>
    ${svgText(result.lectureMap.join('  →  '), 120, 442, { size: 24, weight: 700, color: '#FFFFFF', width: 68 })}
    ${conceptCards}
    <rect x="80" y="1100" width="1040" height="250" rx="36" fill="#FFF0B8" stroke="#E8C85E" stroke-width="3"/>
    ${svgText('시험 직전, 이것만은 기억!', 120, 1160, { size: 34, weight: 900, color: '#7A4C00', width: 35 })}
    ${svgText(reminderLines, 120, 1220, { size: 23, color: '#5F4A15', width: 64, lineHeight: 34 })}
    ${questions.length ? `<rect x="80" y="1400" width="1040" height="245" rx="34" fill="#F4EFE8"/>${svgText('선수지식 확인', 120, 1460, { size: 30, weight: 900, color: '#6B4D3A', width: 30 })}${svgText(questionLines, 120, 1520, { size: 23, width: 65, lineHeight: 34 })}${svgText(questions.map((item, index) => `${index + 1}) ${item.answer}`).join('   '), 120, 1610, { size: 17, color: '#8B8178', width: 80, lineHeight: 24 })}</rect>` : ''}
    <text x="80" y="1735" font-family="Arial, 'Noto Sans KR', sans-serif" font-size="22" font-weight="900" fill="#173943">LectureLink</text>
    <text x="1120" y="1735" text-anchor="end" font-family="Arial, 'Noto Sans KR', sans-serif" font-size="18" fill="#7A898E">자동 구성 시각자료</text>
  </svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

async function generateMedicalArtwork(result: z.infer<typeof resultSchema>, deadlineAt: number) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || process.env.ENABLE_BRIDGE_ARTWORK === '0') return null;
  const model = process.env.GEMINI_IMAGE_MODEL ?? 'gemini-3-pro-image-preview';
  const prompt = `Create a complete, fully rendered Korean medical-study infographic as ONE finished raster image. This is not supporting artwork, not a website, not a PDF layout, and not a mockup.

GOAL
A medical student should understand the conceptual structure by scanning illustrations and arrows for 1–2 minutes. Prioritize: 전체 구조 → 핵심 기전 → 대표 예시 → 시험 포인트. Do not force every detail into the page.

CONTENT — use these Korean strings accurately and do not invent facts:
Title: ${result.title}
Topic: ${result.topic}
Exam scope: ${result.examScope}
Lecture map: ${result.lectureMap.join(' → ')}
Prerequisites:
${result.prerequisiteConcepts.map((item, index) => `${index + 1}. ${item.name}: ${item.quickReview} | visual: ${item.visualCue}`).join('\n')}
Core relationship:
${result.coreFlow.join(' → ')}
Representative examples:
${result.representativeExamples.map((item) => `${item.group}: ${item.examples.join(' / ')}`).join('\n')}
Exam-eve points:
${result.mustRemember.map((item, index) => `${index + 1}. ${item}`).join('\n')}
${result.readinessCheck.length === 2 ? `Two prerequisite questions:
Q1. ${result.readinessCheck[0].question}
Q2. ${result.readinessCheck[1].question}
Tiny answer line: 정답 1) ${result.readinessCheck[0].answer}  2) ${result.readinessCheck[1].answer}` : 'Do not add any prerequisite questions or answer section.'}

VISUAL DESIGN
- Vertical 2:3 portrait, high resolution, bright ivory/white background.
- Premium medical textbook illustration mixed with elegant hand-drawn study notes, similar in spirit to a polished NotebookLM learning infographic.
- Style direction: ${result.designStyle}.
- Use a central medically accurate anatomical/physiologic illustration, direct labels with leader lines, mini graphs, pathways, color-coded mechanisms, curved arrows, icons, and highlighting strokes.
- Visuals must dominate. Use short labels, generous whitespace, and large legible type.
- Turn classification into a branching map, mechanisms into cause→effect arrows, and comparisons into side-by-side visuals.
- Add a highlighted handwritten area titled exactly “시험 직전, 이것만은 기억!” containing the exam-eve points.
${result.readinessCheck.length === 2 ? '- Put the two questions at the bottom; answers must be faint and small.' : '- Do not reserve space for questions or answers.'}
- Put a small tasteful LectureLink book-and-ECG logo with exact text “LectureLink” in one bottom corner.

AVOID
- Repetitive rectangular text cards, PowerPoint slide appearance, dense prose, tiny text, tables filling the page, equal emphasis for every fact, pseudo-Korean, garbled Hangul, duplicated sections, invented drug names, citations, watermarks.
- If space becomes tight, remove decoration rather than shrinking text.

TEXT ACCURACY IS CRITICAL. Spell every Korean/English term supplied above exactly. Do not introduce any content outside the analyzed lecture scope.`;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs < 15_000) {
      console.warn('[bridge-generation]', { stage: 'artwork_skipped_for_deadline', attempt, remainingMs });
      return null;
    }
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ['IMAGE'],
            imageConfig: { aspectRatio: '2:3' },
          },
        }),
        signal: AbortSignal.timeout(Math.min(80_000, Math.max(12_000, remainingMs - 5_000))),
      });
      if (!response.ok) {
        console.warn('[bridge-generation]', { stage: 'artwork_http_failed', attempt, status: response.status });
        if (response.status < 500 && response.status !== 429) return null;
      } else {
        const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }> } }> };
        const parts = json.candidates?.[0]?.content?.parts ?? [];
        const image = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
        const data = image?.inlineData?.data ?? image?.inline_data?.data;
        const mime = image?.inlineData?.mimeType ?? image?.inline_data?.mime_type ?? 'image/png';
        const optimized = data ? await optimizeInfographic(`data:${mime};base64,${data}`) : null;
        if (optimized) return optimized;
        console.warn('[bridge-generation]', { stage: 'artwork_payload_missing', attempt });
      }
    } catch (error) {
      console.warn('[bridge-generation]', {
        stage: 'artwork_request_failed',
        attempt,
        cause: error instanceof Error ? error.name : 'unknown',
      });
    }
    if (attempt < 2) await sleep(750);
  }
  return null;
}

const auditSchema = z.object({
  status: z.enum(['passed', 'needs_review']),
  issues: z.array(z.string()).max(12),
  requiredElementsPresent: z.boolean(),
  repairable: z.boolean(),
  patches: z.array(z.object({
    observedText: z.string().max(120),
    replacementText: z.string().max(120),
    confidence: z.number().min(0).max(1),
    backgroundComplexity: z.enum(['simple', 'complex']),
    box: z.object({
      x: z.number().min(0).max(1000),
      y: z.number().min(0).max(1000),
      width: z.number().min(0).max(1000),
      height: z.number().min(0).max(1000),
    }),
  })).max(8),
});

const auditTool = {
  name: 'audit_infographic',
  description: 'Audit Korean infographic text, required elements, and return exact repair boxes for malformed glyphs.',
  input_schema: {
    type: 'object',
    required: ['status', 'issues', 'requiredElementsPresent', 'repairable', 'patches'],
    properties: {
      status: { type: 'string', enum: ['passed', 'needs_review'] },
      issues: { type: 'array', maxItems: 12, items: { type: 'string' } },
      requiredElementsPresent: { type: 'boolean' },
      repairable: { type: 'boolean' },
      patches: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          required: ['observedText', 'replacementText', 'confidence', 'backgroundComplexity', 'box'],
          properties: {
            observedText: { type: 'string' },
            replacementText: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            backgroundComplexity: { type: 'string', enum: ['simple', 'complex'] },
            box: {
              type: 'object',
              required: ['x', 'y', 'width', 'height'],
              properties: {
                x: { type: 'number', minimum: 0, maximum: 1000 },
                y: { type: 'number', minimum: 0, maximum: 1000 },
                width: { type: 'number', minimum: 0, maximum: 1000 },
                height: { type: 'number', minimum: 0, maximum: 1000 },
              },
            },
          },
        },
      },
    },
  },
} as const;

const failedAudit = (issue: string) => ({
  status: 'needs_review' as const,
  issues: [issue],
  requiredElementsPresent: false,
  repairable: false,
  patches: [] as InfographicTextPatch[],
});

async function auditInfographic(result: z.infer<typeof resultSchema>, visualDataUrl: string | null) {
  if (!visualDataUrl) return failedAudit('완성형 이미지가 생성되지 않았습니다.');
  const match = visualDataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
  if (!match) return failedAudit('이미지 형식을 검수할 수 없습니다.');
  try {
    const expected = [
      result.title, result.examScope,
      ...result.lectureMap,
      ...result.prerequisiteConcepts.flatMap((item) => [item.name, item.quickReview]),
      ...result.representativeExamples.flatMap((item) => [item.group, ...item.examples]),
      ...result.mustRemember,
      ...result.readinessCheck.flatMap((item) => [item.question, item.answer]),
      '시험 직전, 이것만은 기억!',
      'LectureLink',
    ].join('\n');
    const response = await withRetry(() => createMessage(getAnthropic(), {
      model: MODELS.vision(),
      max_tokens: 1800,
      tools: [auditTool],
      tool_choice: { type: 'tool', name: 'audit_infographic' },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } },
        { type: 'text', text: `당신은 생성 AI와 독립적으로 결과물을 검수하는 의학교육 편집자이자 OCR 교정자다. 이미지 속 모든 한글과 의학용어를 읽고 아래 승인 원문과 대조하라.

검수 규칙:
- 글자 깨짐, 가짜 한글, 한자/특수문자 혼입, 오탈자, 누락, 중복, 잘못된 화살표, 의학적 모순, 범위 밖 내용, 너무 작은 글씨가 있으면 needs_review다.
- 제목, "시험 직전, 이것만은 기억!", 설정된 확인문항과 정답, 책+심전도 로고와 "LectureLink"는 필수다. 모두 있으면 requiredElementsPresent=true다.
- patches에는 실제 이미지에 보이는 잘못된 글자만 넣는다. 누락 문구 전체나 의미 변경은 패치하지 않는다.
- 각 box는 이미지 전체를 0..1000으로 정규화한 x,y,width,height다. 잘못된 문자열의 글자 영역에 딱 맞게 잡는다.
- observedText는 이미지에서 읽힌 문자열, replacementText는 승인 원문에 따른 정확한 대체 문자열이다.
- 단색/옅은 종이/빈 카드 배경이면 simple, 그림·선·화살표·복잡한 질감 위면 complex다.
- simple 배경의 확실한 오류가 1~4개이고 필수 요소가 모두 있으면 repairable=true다. 그 외에는 false다.
- 정상 글자는 절대 patches에 넣지 않는다. 장식적 축약은 허용하지만 의미 변화는 허용하지 않는다.

승인 원문:
${expected}` },
      ] }],
    }), { maxAttempts: 2 });
    const block = response.content.find((item): item is Anthropic.ToolUseBlock => item.type === 'tool_use');
    return block ? auditSchema.parse(block.input) : failedAudit('검수 응답을 해석하지 못했습니다.');
  } catch {
    return failedAudit('자동 글자 검수를 완료하지 못해 추가 확인이 필요합니다.');
  }
}

async function auditAndRepairArtwork(
  result: z.infer<typeof resultSchema>,
  generatedArtwork: string,
  deadlineAt: number,
) {
  let visualDataUrl = generatedArtwork;
  let textAudit = await auditInfographic(result, visualDataUrl);
  let textRepair = { applied: false, patchCount: 0, regenerated: false };

  if (textAudit.status === 'needs_review' && !textAudit.requiredElementsPresent
      && Date.now() < deadlineAt - 75_000) {
    const regenerated = await generateMedicalArtwork(result, deadlineAt - 20_000);
    if (regenerated) {
      const regeneratedAudit = Date.now() < deadlineAt - 25_000
        ? await auditInfographic(result, regenerated)
        : failedAudit('필수 요소를 포함해 다시 생성했으며 시간 제한으로 재검수를 건너뛰었습니다.');
      visualDataUrl = regenerated;
      textAudit = regeneratedAudit;
      textRepair = { applied: false, patchCount: 0, regenerated: true };
    }
  }

  if (visualDataUrl && textAudit.status === 'needs_review' && textAudit.patches.length > 0) {
    const corrected = await repairInfographicText(visualDataUrl, textAudit.patches);
    const optimized = corrected ? await optimizeInfographic(corrected.dataUrl) : null;
    if (optimized && corrected) {
      visualDataUrl = optimized;
      textRepair = {
        applied: true,
        patchCount: corrected.appliedCount,
        regenerated: textRepair.regenerated,
      };

      if (Date.now() < deadlineAt - 25_000) {
        textAudit = await auditInfographic(result, optimized);
      } else {
        textAudit = {
          ...textAudit,
          issues: [
            `깨진 글자 ${corrected.appliedCount}곳을 승인된 문구로 교정했습니다.`,
            ...textAudit.issues,
          ].slice(0, 12),
        };
      }
    }
  }

  return { visualDataUrl, textAudit, textRepair };
}

const requestSchema = z.object({
  learnerLevel: z.string().trim().min(2).max(100),
  reviewLength: z.enum(['5분', '10분', '15분']),
  designStyle: z.enum(['auto', 'medical-clean', 'hand-drawn', 'blueprint', 'editorial']),
  emphasis: z.string().trim().max(300).default(''),
  includeReadiness: z.boolean(),
});

const sourcePlanSchema = z.object({
  topicEnglish: z.string().min(2).max(120),
  searchQueries: z.array(z.string().min(2).max(160)).min(2).max(4),
});

function readTextField(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function parseBridgeSettings(form: FormData) {
  const learnerLevel = readTextField(form, 'learnerLevel') || '의학과 2학년';
  const reviewInput = readTextField(form, 'reviewLength').replace(/\s+/g, '');
  const reviewMinutes = reviewInput.match(/^(5|10|15)(?:분|min(?:ute)?s?)?$/i)?.[1] ?? '10';
  const reviewLength = `${reviewMinutes}분`;
  const designInput = readTextField(form, 'designStyle');
  const designStyle = ['auto', 'medical-clean', 'hand-drawn', 'blueprint', 'editorial'].includes(designInput)
    ? designInput
    : 'auto';
  const readinessInput = readTextField(form, 'includeReadiness').toLowerCase();

  const parsed = requestSchema.safeParse({
    learnerLevel,
    reviewLength,
    designStyle,
    emphasis: readTextField(form, 'emphasis').slice(0, 300),
    includeReadiness: !['false', '0', 'off', 'no'].includes(readinessInput),
  });
  if (!parsed.success) {
    console.error('[bridge-generation]', {
      stage: 'request_validation_failed',
      fields: parsed.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    });
    throw new ApiException('invalid_bridge_settings', '예습자료 설정을 확인해주세요.', 400);
  }
  return parsed.data;
}

function normalizeSourcePlan(input: unknown, fileName: string) {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const rawTopic = typeof record.topicEnglish === 'string' ? record.topicEnglish.trim() : '';
  const rawQueries = Array.isArray(record.searchQueries) ? record.searchQueries : [];
  const searchQueries = Array.from(new Set(
    rawQueries
      .filter((query): query is string => typeof query === 'string')
      .map((query) => query.replace(/\s+/g, ' ').trim().slice(0, 160))
      .filter((query) => query.length >= 2),
  )).slice(0, 4);
  const fallbackTopic = rawTopic.slice(0, 120)
    || searchQueries[0]?.replace(/\b(anatomy|physiology|pathophysiology|imaging|differential diagnosis)\b/gi, '').trim().slice(0, 120)
    || fileName.replace(/\.(pdf|pptx)$/i, '').trim().slice(0, 120);

  for (const suffix of ['anatomy physiology', 'pathophysiology differential diagnosis']) {
    if (searchQueries.length >= 2) break;
    const fallbackQuery = `${fallbackTopic} ${suffix}`.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (fallbackQuery.length >= 2 && !searchQueries.includes(fallbackQuery)) searchQueries.push(fallbackQuery);
  }

  const parsed = sourcePlanSchema.safeParse({
    topicEnglish: fallbackTopic,
    searchQueries,
  });
  if (!parsed.success) {
    console.error('[bridge-generation]', {
      stage: 'source_plan_validation_failed',
      fields: parsed.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    });
    throw new ApiException('source_verification_failed', '외부 의학자료 검색 계획을 정리하지 못했습니다. 다시 생성해주세요.', 502);
  }
  return parsed.data;
}

function findStructuredInput(
  response: Awaited<ReturnType<typeof createMessage>>,
  toolName: string,
) {
  const toolBlock = response.content.find(
    (item): item is Anthropic.ToolUseBlock => item.type === 'tool_use' && item.name === toolName,
  );
  if (toolBlock) return toolBlock.input;

  const text = response.content
    .filter((item): item is Anthropic.TextBlock => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
    .trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const candidate = fenced ?? (start >= 0 && end > start ? text.slice(start, end + 1) : '');
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

async function requestStructuredInput(
  request: () => Promise<Awaited<ReturnType<typeof createMessage>>>,
  options: { toolName: string; stage: string; failureMessage: string },
) {
  let lastFailure = 'structured_output_missing';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const response = await request();
      const input = findStructuredInput(response, options.toolName);
      if (input) return input;
      lastFailure = 'structured_output_missing';
    } catch (error) {
      lastFailure = error instanceof Error ? `${error.name}:${error.message}`.slice(0, 240) : String(error).slice(0, 240);
    }
    console.warn('[bridge-generation]', { stage: options.stage, attempt, cause: lastFailure });
    if (attempt < 2) await sleep(600);
  }
  console.error('[bridge-generation]', { stage: `${options.stage}_exhausted`, cause: lastFailure });
  throw new ApiException(`${options.stage}_failed`, options.failureMessage, 503);
}

const sourcePlanTool = {
  name: 'plan_verified_medical_sources',
  description: 'Plan precise English PubMed searches for prerequisite medical knowledge needed before a lecture.',
  input_schema: {
    type: 'object',
    required: ['topicEnglish', 'searchQueries'],
    properties: {
      topicEnglish: { type: 'string' },
      searchQueries: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' } },
    },
  },
} as const;

const resultSchema = z.object({
  title: z.string().min(1),
  topic: z.string().min(1),
  examScope: z.string().min(1),
  designStyle: z.enum(['medical-clean', 'hand-drawn', 'blueprint', 'editorial']),
  courseConnection: z.string().min(1),
  lectureMap: z.array(z.string().min(1)).min(3).max(5),
  professorEmphasis: z.array(z.string().min(1)).max(6),
  estimatedMinutes: z.number().int().min(3).max(20),
  prerequisiteConcepts: z.array(z.object({
    name: z.string().min(1),
    whyNeeded: z.string().min(1),
    quickReview: z.string().min(1),
    visualCue: z.string().min(1),
  })).min(2).max(5),
  coreFlow: z.array(z.string().min(1)).min(2).max(6),
  representativeExamples: z.array(z.object({
    group: z.string().min(1),
    examples: z.array(z.string().min(1)).min(1).max(4),
  })).min(2).max(5),
  mustRemember: z.array(z.string().min(1)).min(4).max(7),
  commonConfusions: z.array(z.object({
    confusion: z.string().min(1),
    correction: z.string().min(1),
  })).max(4),
  readinessCheck: z.array(z.object({
    question: z.string().min(1),
    answer: z.string().min(1),
  })).max(2),
  sourceSearchQueries: z.array(z.string().min(2)).min(2).max(4),
  externalSources: z.array(z.object({
    title: z.string().min(1),
    organization: z.string().min(1),
    url: z.string().url(),
  })).max(5).default([]),
});

const RESULT_STYLES = ['medical-clean', 'hand-drawn', 'blueprint', 'editorial'] as const;

function cleanGeneratedText(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : fallback;
}

function cleanGeneratedList(value: unknown, maximum: number) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => cleanGeneratedText(item)).filter(Boolean))).slice(0, maximum);
}

function normalizeGeneratedResult(
  input: unknown,
  context: {
    fileName: string;
    reviewLength: string;
    requestedStyle: z.infer<typeof requestSchema>['designStyle'];
    includeReadiness: boolean;
    sourceSearchQueries: string[];
  },
) {
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const fileTopic = context.fileName.replace(/\.(pdf|pptx)$/i, '').trim() || '이번 강의';
  const rawPrerequisites = Array.isArray(raw.prerequisiteConcepts) ? raw.prerequisiteConcepts : [];
  const prerequisiteConcepts = rawPrerequisites.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const name = cleanGeneratedText(value.name);
    const quickReview = cleanGeneratedText(value.quickReview);
    if (!name || !quickReview) return [];
    return [{
      name,
      quickReview,
      whyNeeded: cleanGeneratedText(value.whyNeeded, '이번 강의의 핵심 관계를 이해하는 데 필요한 선수지식입니다.'),
      visualCue: cleanGeneratedText(value.visualCue, `${name}의 핵심 관계를 간단한 화살표 도식으로 표시`),
    }];
  }).slice(0, 5);

  const rawCoreFlow = cleanGeneratedList(raw.coreFlow, 6);
  const rawLectureMap = cleanGeneratedList(raw.lectureMap, 5);
  for (const candidate of [...rawCoreFlow, ...rawLectureMap]) {
    if (prerequisiteConcepts.length >= 2) break;
    if (!candidate || prerequisiteConcepts.some((item) => item.name === candidate)) continue;
    prerequisiteConcepts.push({
      name: candidate.slice(0, 80),
      quickReview: candidate,
      whyNeeded: '이번 강의의 개념 흐름을 연결하는 데 필요한 선수지식입니다.',
      visualCue: '핵심 원인과 결과를 화살표로 연결',
    });
  }
  if (prerequisiteConcepts.length < 2) {
    throw new ApiException('generation_format_invalid', 'AI가 핵심 선수지식을 충분히 구성하지 못했습니다. 자동 재생성이 필요합니다.', 502);
  }

  const coreFlow = Array.from(new Set([
    ...rawCoreFlow,
    ...prerequisiteConcepts.map((item) => item.quickReview),
    ...prerequisiteConcepts.map((item) => item.name),
  ])).filter(Boolean).slice(0, 6);
  const lectureMap = Array.from(new Set([
    ...rawLectureMap,
    ...prerequisiteConcepts.map((item) => item.name),
    ...coreFlow,
  ])).filter(Boolean).slice(0, 5);
  for (const fallback of [`${fileTopic} 전체 구조`, `${fileTopic} 핵심 기전`, `${fileTopic} 시험 연결`]) {
    if (lectureMap.length >= 3) break;
    if (!lectureMap.includes(fallback)) lectureMap.push(fallback);
  }

  const rawExamples = Array.isArray(raw.representativeExamples) ? raw.representativeExamples : [];
  const representativeExamples = rawExamples.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const group = cleanGeneratedText(value.group);
    const examples = cleanGeneratedList(value.examples, 4);
    return group && examples.length ? [{ group, examples }] : [];
  }).slice(0, 5);
  for (const concept of prerequisiteConcepts) {
    if (representativeExamples.length >= 2) break;
    if (representativeExamples.some((item) => item.group === concept.name)) continue;
    representativeExamples.push({ group: concept.name, examples: [concept.quickReview] });
  }

  const mustRemember = Array.from(new Set([
    ...cleanGeneratedList(raw.mustRemember, 7),
    ...coreFlow,
    ...prerequisiteConcepts.map((item) => item.quickReview),
  ])).filter(Boolean).slice(0, 7);
  while (mustRemember.length < 4) {
    const concept = prerequisiteConcepts[mustRemember.length % prerequisiteConcepts.length];
    const fallback = `${concept.name}: ${concept.quickReview}`;
    if (!mustRemember.includes(fallback)) mustRemember.push(fallback);
    else break;
  }

  const commonConfusions = (Array.isArray(raw.commonConfusions) ? raw.commonConfusions : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const confusion = cleanGeneratedText(value.confusion);
    const correction = cleanGeneratedText(value.correction);
    return confusion && correction ? [{ confusion, correction }] : [];
  }).slice(0, 4);

  const readinessCheck = (Array.isArray(raw.readinessCheck) ? raw.readinessCheck : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const question = cleanGeneratedText(value.question);
    const answer = cleanGeneratedText(value.answer);
    return question && answer ? [{ question, answer }] : [];
  }).slice(0, 2);
  if (context.includeReadiness) {
    for (const concept of prerequisiteConcepts) {
      if (readinessCheck.length >= 2) break;
      readinessCheck.push({
        question: `${concept.name}이 이번 강의를 이해하는 데 필요한 이유는 무엇인가?`,
        answer: concept.whyNeeded,
      });
    }
  } else {
    readinessCheck.length = 0;
  }

  const rawMinutes = typeof raw.estimatedMinutes === 'number'
    ? raw.estimatedMinutes
    : Number.parseInt(cleanGeneratedText(raw.estimatedMinutes), 10);
  const requestedMinutes = Number.parseInt(context.reviewLength, 10) || 10;
  const estimatedMinutes = Math.max(3, Math.min(20, Number.isFinite(rawMinutes) ? Math.round(rawMinutes) : requestedMinutes));
  const rawStyle = cleanGeneratedText(raw.designStyle);
  const designStyle = RESULT_STYLES.includes(rawStyle as typeof RESULT_STYLES[number])
    ? rawStyle as typeof RESULT_STYLES[number]
    : context.requestedStyle === 'auto' ? 'medical-clean' : context.requestedStyle;

  const parsed = resultSchema.safeParse({
    title: cleanGeneratedText(raw.title, `${fileTopic} 예습 핵심 지도`),
    topic: cleanGeneratedText(raw.topic, fileTopic),
    examScope: cleanGeneratedText(raw.examScope, '강의자료에 별도로 표시된 시험 범위를 우선 확인하세요.'),
    designStyle,
    courseConnection: cleanGeneratedText(raw.courseConnection, '핵심 선수지식에서 이번 강의의 전체 흐름으로 연결합니다.'),
    lectureMap,
    professorEmphasis: cleanGeneratedList(raw.professorEmphasis, 6),
    estimatedMinutes,
    prerequisiteConcepts,
    coreFlow,
    representativeExamples,
    mustRemember,
    commonConfusions,
    readinessCheck,
    sourceSearchQueries: context.sourceSearchQueries,
    externalSources: [],
  });
  if (!parsed.success) {
    console.error('[bridge-generation]', {
      stage: 'generated_result_validation_failed',
      fields: parsed.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    });
    throw new ApiException('generation_format_invalid', '생성된 예습자료의 형식을 자동 보정하지 못했습니다. 다시 생성해주세요.', 502);
  }
  return parsed.data;
}

const outputTool = {
  name: 'create_prerequisite_bridge',
  description: 'Create a concise pre-class prerequisite review handout grounded in lecture material.',
  input_schema: {
    type: 'object',
    required: ['title', 'topic', 'examScope', 'designStyle', 'courseConnection', 'lectureMap', 'professorEmphasis', 'estimatedMinutes', 'prerequisiteConcepts', 'coreFlow', 'representativeExamples', 'mustRemember', 'commonConfusions', 'readinessCheck', 'sourceSearchQueries'],
    properties: {
      title: { type: 'string' },
      topic: { type: 'string' },
      examScope: { type: 'string' },
      designStyle: { type: 'string', enum: ['medical-clean', 'hand-drawn', 'blueprint', 'editorial'] },
      courseConnection: { type: 'string' },
      lectureMap: { type: 'array', minItems: 3, maxItems: 5, items: { type: 'string' } },
      professorEmphasis: { type: 'array', maxItems: 6, items: { type: 'string' } },
      estimatedMinutes: { type: 'integer', minimum: 3, maximum: 20 },
      prerequisiteConcepts: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'object', required: ['name', 'whyNeeded', 'quickReview', 'visualCue'], properties: { name: { type: 'string' }, whyNeeded: { type: 'string' }, quickReview: { type: 'string' }, visualCue: { type: 'string' } } } },
      coreFlow: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } },
      representativeExamples: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'object', required: ['group', 'examples'], properties: { group: { type: 'string' }, examples: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } } } } },
      mustRemember: { type: 'array', minItems: 4, maxItems: 7, items: { type: 'string' } },
      commonConfusions: { type: 'array', maxItems: 4, items: { type: 'object', required: ['confusion', 'correction'], properties: { confusion: { type: 'string' }, correction: { type: 'string' } } } },
      readinessCheck: { type: 'array', maxItems: 2, items: { type: 'object', required: ['question', 'answer'], properties: { question: { type: 'string' }, answer: { type: 'string' } } } },
      sourceSearchQueries: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'string' } },
      externalSources: { type: 'array', maxItems: 5, items: { type: 'object', required: ['title', 'organization', 'url'], properties: { title: { type: 'string' }, organization: { type: 'string' }, url: { type: 'string' } } } },
    },
  },
} as const;

async function extractMaterial(file: File) {
  try {
    const extracted = await extractTeachingMaterial(file);
    return extracted.text.slice(0, 120_000);
  } catch (error) {
    if (error instanceof ApiException) throw error;
    console.error('[bridge-generation]', {
      stage: 'material_extraction_failed',
      cause: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
    throw new ApiException('material_extraction_failed', '강의자료 내용을 읽지 못했습니다. 저장된 자료를 다시 선택해주세요.', 422);
  }
}

export const maxDuration = 300;

export const POST = withErrorHandling(async (request: Request) => {
  try {
    const generationStartedAt = Date.now();
  const session = await requireSession();
  if (session.profile.accountType !== 'professor' && session.role !== 'admin') {
    throw new ApiException('professor_only', '교수 계정에서만 사용할 수 있습니다.', 403);
  }
  await requireDailyCostCap();
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiException('invalid_bridge_request', '예습자료 요청을 읽지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.', 400);
  }
  const submittedFile = form.get('file');
  const materialId = String(form.get('materialId') ?? '');
  const courseId = String(form.get('courseId') ?? '');
  const submittedRequestId = readTextField(form, 'requestId');
  const requestId = z.string().uuid().safeParse(submittedRequestId).success
    ? submittedRequestId
    : crypto.randomUUID();
  let loaded: Awaited<ReturnType<typeof loadTeachingMaterialFile>> | null = null;
  if (z.string().uuid().safeParse(materialId).success) {
    let lastLoadError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        loaded = await loadTeachingMaterialFile(materialId, session.userId);
        break;
      } catch (error) {
        lastLoadError = error;
        console.warn('[bridge-generation]', {
          stage: 'material_load_failed',
          attempt,
          code: error instanceof ApiException ? error.code : error instanceof Error ? error.name : 'unknown',
        });
        if (attempt < 2) await sleep(400);
      }
    }
    if (!loaded && lastLoadError) throw lastLoadError;
  }
  const cached = loaded?.material ?? null;
  const file = loaded?.file ?? submittedFile;
  if (!(file instanceof File)) throw new ApiException('file_required', '강의자료를 선택해주세요.', 400);
  if (!z.string().uuid().safeParse(courseId).success) throw new ApiException('course_required', '저장할 차시를 선택해주세요.', 400);
  if (cached && cached.course_id !== courseId) {
    throw new ApiException('material_course_mismatch', '선택한 차시와 강의자료가 일치하지 않습니다. 강의자료를 다시 선택해주세요.', 400);
  }
  if (file.size > MAX_FILE_BYTES) throw new ApiException('file_too_large', '파일은 25MB 이하만 업로드할 수 있습니다.', 400);
  const settings = parseBridgeSettings(form);
  const existingDb = await createServerClient() as any;
  const { data: existingArtifact } = await existingDb
    .from('learning_artifacts')
    .select('id,content')
    .eq('id', requestId)
    .eq('created_by', session.userId)
    .maybeSingle();
  if (existingArtifact?.id && existingArtifact.content && typeof existingArtifact.content === 'object') {
    console.info('[bridge-generation]', { stage: 'idempotent_replay', artifactId: existingArtifact.id });
    return ok({ ...(existingArtifact.content as Record<string, unknown>), artifactId: existingArtifact.id });
  }
  const material = (cached?.extracted_text || await extractMaterial(file)).slice(0, 120_000);
  const sourcePlanInput = await requestStructuredInput(
    () => withRetry(() => createMessage(getAnthropic(), {
      model: MODELS.verification(),
      max_tokens: 900,
      system: `You are a medical librarian. Identify the lecture topic and write 2–4 concise English PubMed queries for the prerequisite anatomy, physiology, pathophysiology, imaging, or differential-diagnosis knowledge a medical student must review before this lecture. Do not search for the lecture's drug list or minor details. Return only the tool call.`,
      tools: [sourcePlanTool],
      tool_choice: { type: 'tool', name: 'plan_verified_medical_sources' },
      messages: [{ role: 'user', content: `File: ${file.name}\n\nLecture material:\n${material.slice(0, 40_000)}` }],
    }), { maxAttempts: 1 }),
    {
      toolName: 'plan_verified_medical_sources',
      stage: 'source_plan_generation',
      failureMessage: '외부 의학자료 검색 계획을 만들지 못했습니다. 잠시 후 다시 생성해주세요.',
    },
  );
  const sourcePlan = normalizeSourcePlan(sourcePlanInput, file.name);
  let pubMedEvidence = [] as Awaited<ReturnType<typeof findVerifiedPubMedSources>>;
  try {
    pubMedEvidence = await findVerifiedPubMedSources(sourcePlan.searchQueries, 5);
  } catch (error) {
    console.error('[bridge-generation]', {
      stage: 'pubmed_source_lookup_failed',
      cause: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
  }
  if (pubMedEvidence.length < 2) {
    throw new ApiException('source_verification_failed', '검증된 외부 의학자료를 충분히 확인하지 못했습니다. 다시 생성해주세요.', 502);
  }
  const groundedEvidence = pubMedEvidence.map((source, index) =>
    `[${index + 1}] ${source.title}\n기관/저널: ${source.organization}\nURL: ${source.url}\n초록 근거: ${source.evidence}`,
  ).join('\n\n');
  const generatedInput = await requestStructuredInput(
    () => withRetry(() => createMessage(getAnthropic(), {
      model: MODELS.generation(),
      max_tokens: 6000,
      system: `당신은 의과대학 수업용 1페이지 예습 인포그래픽을 설계하는 의학교육 전문가다.

강의자료는 '오늘 무엇을 배울지'를 파악하는 데 사용한다. 본문은 강의 요약이 아니라 그 수업을 이해하기 전에 반드시 회복해야 할 선수지식으로 구성한다. 예를 들어 부정맥 약물 수업이면 부정맥 분류, 심장 전도계, 활동전위와 이온채널을 먼저 설명하고 약물 강의로 연결한다. 흉수 수업이면 흉막 구조, 정상 흉부영상, 흉수와 기흉의 구별을 먼저 설명한다.

규칙:
- lectureMap은 이번 수업의 전체 개요를 한눈에 보여주는 3~5단계 지도다.
- examScope에는 강의자료에 명시된 시험 범위만 쓴다. “여기까지 시험 범위” 같은 표시는 절대 놓치지 않는다.
- professorEmphasis에는 별표, 밑줄, 색상 강조, 반복 언급, “중요/주의/금기/시험” 표시가 있는 내용을 우선 수집한다.
- prerequisiteConcepts는 해부·생리·병태생리·영상 또는 감별에 필요한 3~5개 핵심 선수지식이다.
- visualCue에는 각 개념을 설명할 정확한 그림/도식 지시를 한 문장으로 쓴다.
- readinessCheck는 사용자가 포함을 선택했을 때만 강의록 암기가 아닌 선수지식 이해 문항을 정확히 2개 만든다. 선택하지 않았다면 반드시 빈 배열로 둔다. 답은 하단에 작게 넣을 수 있도록 한두 문장으로 쓴다.
- representativeExamples는 분류별 대표 예시만 1~4개 고르고 세부 항목을 전부 나열하지 않는다.
- mustRemember는 시험 직전 확인할 4~7개의 짧은 문구다. 교수 강조, 금기, 대표 부작용, 비교 포인트, 인과 연결을 우선한다.
- 외부 근거는 NCBI/NIH, WHO, CDC, 전문학회 공식 가이드라인, Merck Manual Professional 등 검증된 기관 자료만 사용한다. 존재 여부가 불확실한 URL은 만들지 말고 안정적인 공식 페이지 URL만 제시한다.
- sourceSearchQueries에는 각 선수지식을 검증할 수 있는 PubMed 검색어를 간결한 영어로 2~4개 작성한다. 질환명만 쓰지 말고 anatomy, physiology, pathophysiology, imaging, differential diagnosis처럼 실제 선수지식 주제를 포함한다.
- 아래에 제공된 PubMed 초록 근거만 외부 선수지식의 사실 근거로 사용한다. 초록이 뒷받침하지 않는 수치·기전·진단 기준을 새로 만들지 않는다.
- externalSources에는 제공된 검증 완료 목록의 제목·기관·URL을 그대로 복사한다. URL을 새로 만들거나 바꾸지 않는다.
- 업로드 자료의 페이지를 외부 선수지식의 근거인 것처럼 표시하지 않는다.
- 강의자료에 없는 내용을 임의로 추가하지 않는다. PDF의 표현과 범위를 우선한다. 외부 자료는 선수지식 사실 확인에만 사용하고 이미지 본문에 새로운 범위를 더하지 않는다.
- 간결하고 정확한 한국어를 사용하며 1페이지 이미지에 들어갈 양만 선별한다.
- 디자인이 auto이면 주제의 정보 구조에 맞춰 스타일을 선택한다: 기전/경로는 blueprint, 해부/임상 흐름은 medical-clean, 기억법은 hand-drawn, 비교/개요는 editorial.`,
      tools: [outputTool],
      tool_choice: { type: 'tool', name: 'create_prerequisite_bridge' },
      messages: [{ role: 'user', content: `수업 주제: 강의자료에서 자동 추출\n학습자: ${settings.learnerLevel}\n목표 복습시간: ${settings.reviewLength}\n디자인: ${settings.designStyle === 'auto' ? '주제에 맞게 자동 추천' : settings.designStyle}\n교수 강조사항: ${settings.emphasis || '없음'}\n선수지식 확인 문항: ${settings.includeReadiness ? '정확히 2개 포함' : '포함하지 않음, readinessCheck는 빈 배열'}\nPubMed 검색어(sourceSearchQueries에 그대로 사용): ${sourcePlan.searchQueries.join(' | ')}\n\n검증 완료된 외부 의학 근거:\n${groundedEvidence}\n\n파일명: ${file.name}\n\n강의자료:\n${material}` }],
    }), { maxAttempts: 1 }),
    {
      toolName: 'create_prerequisite_bridge',
      stage: 'content_generation',
      failureMessage: '예습자료 초안을 만들지 못했습니다. 잠시 후 다시 생성해주세요.',
    },
  );
  const result = normalizeGeneratedResult(generatedInput, {
    fileName: file.name,
    reviewLength: settings.reviewLength,
    requestedStyle: settings.designStyle,
    includeReadiness: settings.includeReadiness,
    sourceSearchQueries: sourcePlan.searchQueries,
  });
  const externalSources = pubMedEvidence.map(({ evidence: _evidence, ...source }) => source);
  console.info('[bridge-generation]', {
    stage: 'source_verification_complete',
    searchQueryCount: sourcePlan.searchQueries.length,
    pubMedCount: pubMedEvidence.length,
    selectedCount: externalSources.length,
  });
  const verifiedResult = { ...result, externalSources };
  // 전체 실행 시간 중 마지막 구간은 글자 검수와 픽셀 단위 교정에 확보한다.
  const generatedArtwork = await generateMedicalArtwork(verifiedResult, generationStartedAt + 205_000);
  let visualDataUrl = generatedArtwork ?? generateFallbackInfographic(verifiedResult);
  let textAudit: z.infer<typeof auditSchema> = !generatedArtwork
    ? failedAudit('AI 이미지 생성이 완료되지 않아 자동 구성한 대체 시각자료를 사용했습니다.')
    : failedAudit('전체 생성 시간을 지키기 위해 자동 글자 검수를 건너뛰었습니다.');
  let textRepair = { applied: false, patchCount: 0, regenerated: false };
  if (generatedArtwork) {
    ({ visualDataUrl, textAudit, textRepair } = await auditAndRepairArtwork(
      verifiedResult,
      generatedArtwork,
      generationStartedAt + 285_000,
    ));
  }
  const artifactContent = { ...verifiedResult, visualDataUrl, textAudit, textRepair };
  const db = await createServerClient() as any;
  let courseFound = false;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { data: course, error: courseError } = await db.from('courses').select('id').eq('id', courseId).eq('professor_id', session.userId).maybeSingle();
    if (course) {
      courseFound = true;
      break;
    }
    if (!courseError) break;
    console.warn('[bridge-generation]', { stage: 'course_lookup_failed', attempt, code: courseError.code });
    if (attempt < 2) await sleep(350);
  }
  if (!courseFound) throw new ApiException('course_not_found', '선택한 차시를 찾을 수 없습니다. 차시를 다시 선택해주세요.', 404);

  const artifactId = requestId;
  let savedArtifactId = '';
  let lastSaveCode = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { data: artifact, error } = await db.from('learning_artifacts').insert({
      id: artifactId,
      course_id: courseId,
      created_by: session.userId,
      material_id: cached?.id ?? null,
      type: 'preview',
      title: verifiedResult.title,
      status: 'review',
      source_name: file.name,
      summary: verifiedResult.courseConnection,
      content: artifactContent,
    }).select('id').single();
    if (artifact?.id) {
      savedArtifactId = artifact.id;
      break;
    }
    lastSaveCode = error?.code ?? 'no_row';
    if (error?.code === '23505') {
      const { data: existing } = await db.from('learning_artifacts').select('id').eq('id', artifactId).maybeSingle();
      if (existing?.id) {
        savedArtifactId = existing.id;
        break;
      }
    }
    console.warn('[bridge-generation]', { stage: 'artifact_save_failed', attempt, code: lastSaveCode });
    if (attempt < 2) await sleep(400);
  }
  if (!savedArtifactId) {
    console.error('[bridge-generation]', { stage: 'artifact_save_exhausted', code: lastSaveCode });
    throw new ApiException('artifact_save_failed', '예습자료 저장이 지연되고 있습니다. 잠시 후 다시 생성해주세요.', 503);
  }
  console.info('[bridge-generation]', {
    stage: 'generation_complete',
    durationMs: Date.now() - generationStartedAt,
    artworkMode: generatedArtwork ? 'ai' : 'fallback_svg',
    artifactId: savedArtifactId,
  });
    return ok({ ...artifactContent, artifactId: savedArtifactId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error('[bridge-generation]', {
        stage: 'unexpected_schema_validation_failed',
        fields: error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
        issueCodes: error.issues.map((issue) => issue.code),
      });
      throw new ApiException(
        'bridge_generation_validation_failed',
        '예습자료 생성 결과의 형식을 정리하지 못했습니다. 입력값 문제가 아니며, 잠시 후 다시 생성해주세요.',
        502,
      );
    }
    throw error;
  }
});

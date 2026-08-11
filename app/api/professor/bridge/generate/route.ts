import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { getAnthropic, MODELS, createMessage, withRetry } from '@/lib/ai/client';
import { requireDailyCostCap } from '@/lib/ai/cost-cap';
import { parsePptx } from '@/lib/extract/pptx';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';
import { createServerClient } from '@/lib/db/server';
import { loadTeachingMaterialFile } from '@/lib/teaching/materials';
import { findVerifiedPubMedSources } from '@/lib/medical-sources/pubmed';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_INFOGRAPHIC_BYTES = 1_500_000;

async function optimizeInfographic(dataUrl: string) {
  const match = dataUrl.match(/^data:image\/(?:png|jpeg|webp);base64,(.+)$/s);
  if (!match) return dataUrl;
  const original = Buffer.from(match[1], 'base64');
  if (original.byteLength <= MAX_INFOGRAPHIC_BYTES) return dataUrl;

  try {
    const { createCanvas, loadImage } = await import('canvas');
    const image = await loadImage(original);
    const maxWidth = 1440;
    const scale = Math.min(1, maxWidth / image.width);
    const canvas = createCanvas(
      Math.max(1, Math.round(image.width * scale)),
      Math.max(1, Math.round(image.height * scale)),
    );
    const context = canvas.getContext('2d');
    context.fillStyle = '#fffdf7';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    for (const quality of [0.88, 0.78, 0.68, 0.58]) {
      const compressed = canvas.toBuffer('image/jpeg', { quality, progressive: true });
      if (compressed.byteLength <= MAX_INFOGRAPHIC_BYTES) {
        return `data:image/jpeg;base64,${compressed.toString('base64')}`;
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function generateMedicalArtwork(result: z.infer<typeof resultSchema>) {
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
- Put a small tasteful LectureLink book-and-ECG logo with exact text “LECTURELINK” in one bottom corner.

AVOID
- Repetitive rectangular text cards, PowerPoint slide appearance, dense prose, tiny text, tables filling the page, equal emphasis for every fact, pseudo-Korean, garbled Hangul, duplicated sections, invented drug names, citations, watermarks.
- If space becomes tight, remove decoration rather than shrinking text.

TEXT ACCURACY IS CRITICAL. Spell every Korean/English term supplied above exactly. Do not introduce any content outside the analyzed lecture scope.`;
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
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok) return null;
    const json = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }> } }> };
    const parts = json.candidates?.[0]?.content?.parts ?? [];
    const image = parts.find((part) => part.inlineData?.data || part.inline_data?.data);
    const data = image?.inlineData?.data ?? image?.inline_data?.data;
    const mime = image?.inlineData?.mimeType ?? image?.inline_data?.mime_type ?? 'image/png';
    return data ? await optimizeInfographic(`data:${mime};base64,${data}`) : null;
  } catch {
    return null;
  }
}

const auditSchema = z.object({
  status: z.enum(['passed', 'needs_review']),
  issues: z.array(z.string()).max(12),
});

const auditTool = {
  name: 'audit_infographic',
  description: 'Audit generated Korean medical infographic text and content against the approved source plan.',
  input_schema: {
    type: 'object',
    required: ['status', 'issues'],
    properties: {
      status: { type: 'string', enum: ['passed', 'needs_review'] },
      issues: { type: 'array', maxItems: 12, items: { type: 'string' } },
    },
  },
} as const;

async function auditInfographic(result: z.infer<typeof resultSchema>, visualDataUrl: string | null) {
  if (!visualDataUrl) return { status: 'needs_review' as const, issues: ['완성형 이미지가 생성되지 않았습니다.'] };
  const match = visualDataUrl.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
  if (!match) return { status: 'needs_review' as const, issues: ['이미지 형식을 검수할 수 없습니다.'] };
  try {
    const expected = [
      result.title, result.examScope,
      ...result.lectureMap,
      ...result.prerequisiteConcepts.flatMap((item) => [item.name, item.quickReview]),
      ...result.representativeExamples.flatMap((item) => [item.group, ...item.examples]),
      ...result.mustRemember,
      ...result.readinessCheck.flatMap((item) => [item.question, item.answer]),
    ].join('\n');
    const response = await withRetry(() => createMessage(getAnthropic(), {
      model: MODELS.vision(),
      max_tokens: 1800,
      tools: [auditTool],
      tool_choice: { type: 'tool', name: 'audit_infographic' },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } },
        { type: 'text', text: `당신은 생성 AI와 독립적으로 결과물을 검수하는 의학교육 편집자다. 이미지 속 모든 한글과 의학용어를 읽고 아래 승인 원문과 대조하라. 글자 깨짐, 오탈자, 누락, 중복, 잘못된 화살표, 의학적 모순, 강의 범위 밖 내용, 너무 작은 글씨가 하나라도 있으면 needs_review다. 장식적 축약은 허용하지만 의미 변화는 허용하지 않는다.\n\n승인 원문:\n${expected}` },
      ] }],
    }), { maxAttempts: 2 });
    const block = response.content.find((item): item is Anthropic.ToolUseBlock => item.type === 'tool_use');
    return block ? auditSchema.parse(block.input) : { status: 'needs_review' as const, issues: ['검수 응답을 해석하지 못했습니다.'] };
  } catch {
    return { status: 'needs_review' as const, issues: ['자동 글자 검수를 완료하지 못했습니다. 교수 검토가 필요합니다.'] };
  }
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
  const buffer = await file.arrayBuffer();
  if (file.name.toLowerCase().endsWith('.pptx')) {
    const parsed = parsePptx(buffer);
    const text = parsed.slides.map((slide) => `[슬라이드 ${slide.index}] ${slide.text}`).join('\n');
    if (!text.trim()) throw new ApiException('empty_material', 'PPT에서 읽을 수 있는 텍스트를 찾지 못했습니다.', 400);
    return text.slice(0, 120_000);
  }
  if (file.name.toLowerCase().endsWith('.pdf')) {
    const { default: pdfParse } = await import('pdf-parse');
    const parsed = await pdfParse(Buffer.from(buffer));
    const text = parsed.text.split(/\f+/).map((page, index) => `[페이지 ${index + 1}] ${page.trim()}`).join('\n');
    if (!text.trim()) throw new ApiException('empty_material', 'PDF에서 읽을 수 있는 텍스트를 찾지 못했습니다.', 400);
    return text.slice(0, 120_000);
  }
  throw new ApiException('unsupported_file', 'PPTX 또는 PDF 파일만 지원합니다.', 400);
}

export const maxDuration = 300;

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  if (session.profile.accountType !== 'professor' && session.role !== 'admin') {
    throw new ApiException('professor_only', '교수 계정에서만 사용할 수 있습니다.', 403);
  }
  await requireDailyCostCap();
  const form = await request.formData();
  const submittedFile = form.get('file');
  const materialId = String(form.get('materialId') ?? '');
  const courseId = String(form.get('courseId') ?? '');
  const loaded = z.string().uuid().safeParse(materialId).success
    ? await loadTeachingMaterialFile(materialId, session.userId)
    : null;
  const cached = loaded?.material ?? null;
  const file = loaded?.file ?? submittedFile;
  if (!(file instanceof File)) throw new ApiException('file_required', '강의자료를 선택해주세요.', 400);
  if (!z.string().uuid().safeParse(courseId).success) throw new ApiException('course_required', '저장할 차시를 선택해주세요.', 400);
  if (file.size > MAX_FILE_BYTES) throw new ApiException('file_too_large', '파일은 25MB 이하만 업로드할 수 있습니다.', 400);
  const settings = parseBridgeSettings(form);
  const material = cached?.extracted_text || await extractMaterial(file);
  const sourcePlanResponse = await withRetry(() => createMessage(getAnthropic(), {
    model: MODELS.verification(),
    max_tokens: 900,
    system: `You are a medical librarian. Identify the lecture topic and write 2–4 concise English PubMed queries for the prerequisite anatomy, physiology, pathophysiology, imaging, or differential-diagnosis knowledge a medical student must review before this lecture. Do not search for the lecture's drug list or minor details. Return only the tool call.`,
    tools: [sourcePlanTool],
    tool_choice: { type: 'tool', name: 'plan_verified_medical_sources' },
    messages: [{ role: 'user', content: `File: ${file.name}\n\nLecture material:\n${material.slice(0, 40_000)}` }],
  }), { maxAttempts: 2 });
  const sourcePlanBlock = sourcePlanResponse.content.find((item): item is Anthropic.ToolUseBlock => item.type === 'tool_use');
  if (!sourcePlanBlock) {
    throw new ApiException('source_verification_failed', '외부 의학자료 검색 주제를 정하지 못했습니다. 다시 생성해주세요.', 502);
  }
  const sourcePlan = normalizeSourcePlan(sourcePlanBlock.input, file.name);
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
  const response = await withRetry(() => createMessage(getAnthropic(), {
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
  }), { maxAttempts: 3 });
  const block = response.content.find((item): item is Anthropic.ToolUseBlock => item.type === 'tool_use');
  if (!block) throw new ApiException('generation_failed', '선수지식 복습자료 초안을 만들지 못했습니다.', 502);
  const parsedResult = resultSchema.safeParse({
    ...(block.input as Record<string, unknown>),
    sourceSearchQueries: sourcePlan.searchQueries,
  });
  if (!parsedResult.success) {
    console.error('[bridge-generation]', {
      stage: 'generated_result_validation_failed',
      fields: parsedResult.error.issues.map((issue) => issue.path.join('.')).filter(Boolean),
    });
    throw new ApiException('generation_format_invalid', '생성된 예습자료의 형식을 정리하지 못했습니다. 다시 생성해주세요.', 502);
  }
  const result = parsedResult.data;
  if (settings.includeReadiness && result.readinessCheck.length !== 2) {
    throw new ApiException('generation_failed', '선수지식 확인 문항 2개를 만들지 못했습니다. 다시 시도해주세요.', 502);
  }
  if (!settings.includeReadiness && result.readinessCheck.length !== 0) {
    result.readinessCheck = [];
  }
  const externalSources = pubMedEvidence.map(({ evidence: _evidence, ...source }) => source);
  console.info('[bridge-generation]', {
    stage: 'source_verification_complete',
    searchQueryCount: sourcePlan.searchQueries.length,
    pubMedCount: pubMedEvidence.length,
    selectedCount: externalSources.length,
  });
  const verifiedResult = { ...result, externalSources };
  const visualDataUrl = await generateMedicalArtwork(verifiedResult);
  const textAudit = await auditInfographic(verifiedResult, visualDataUrl);
  const artifactContent = { ...verifiedResult, visualDataUrl, textAudit };
  const db = await createServerClient() as any;
  const { data: course } = await db.from('courses').select('id').eq('id', courseId).eq('professor_id', session.userId).maybeSingle();
  if (!course) throw new ApiException('course_not_found', '선택한 차시를 찾을 수 없습니다.', 404);
  const { data: artifact, error } = await db.from('learning_artifacts').insert({ course_id: courseId, created_by: session.userId, material_id: cached?.id ?? null, type: 'preview', title: verifiedResult.title, status: 'review', source_name: file.name, summary: verifiedResult.courseConnection, content: artifactContent }).select('id').single();
  if (error) throw new ApiException('artifact_save_failed', '예습자료를 차시에 저장하지 못했습니다.', 500);
  return ok({ ...artifactContent, artifactId: artifact.id });
});

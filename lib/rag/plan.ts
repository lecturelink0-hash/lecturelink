/**
 * 출제 계획·질의 생성의 순수 계산 (RAG 실행계획 v1.1 · 5.2 C·D · PR G)
 *
 * 계획 콜(LLM 1콜, lib/ai/rag-plan.ts)이 자료 요약을 보고 출제 단위를 만든다. 단위마다 검색 질의 3개와
 * HyDE 가상 발문 1개가 함께 나온다(추가 콜 없음). 이 파일은 그 콜의 입력 조립·출력 검사·쿼터 칸 배정만 한다.
 *
 * 권한 분담(5.2 C)
 *  - 유형 쿼터(전역 목표·묶음별 쿼터·보충 쿼터)의 권한은 계속 type-plan.ts 가 가진다.
 *  - 계획 콜은 출제 단위만 만든다. 단위를 type-plan 이 준 쿼터 칸에 배정하는 것은 여기(assignUnitsToSlots)다.
 *  - 단위는 요청 수의 1.5배를 만든다. 남는 단위는 근거 부족(D3) 때 바꿔 끼울 예비 단위다.
 *  - 계획 콜이 실패하면 현행 extractFocusTopics() 초점으로 만든 단위로 대신한다(fallbackUnitsFromTopics).
 *
 * HyDE 발문은 검색에만 쓰고 생성 입력에는 넣지 않는다(자료 밖 지식이 섞이는 것을 막기 위해).
 *
 * 외부 모듈은 잎 모듈(knowledge-rules·type-plan)만 불러온다 — 검사 스크립트(`npm run check:rag-plan`)가
 * 이 파일을 직접 불러온다.
 */
import { CLINICAL_ASK_KINDS, IMAGE_ASK_KINDS, KNOWLEDGE_ASK_KINDS } from '../ai/prompts/knowledge-rules.ts';
import type { BatchQuota, TypeTargets } from '../ai/type-plan.ts';

export interface PlanPage {
  pageIndex: number;
  text: string;
}

/** 캡션 청크 본문(captionChunkText)과 그 그림의 페이지·지문. */
export interface PlanCaption {
  pageIndex: number;
  text: string;
  imageKey?: string;
}

export interface PlanRequest {
  desiredCount: number;
  selectedTypes: readonly string[];
  difficulty: string;
  targets: TypeTargets;
}

export interface PlanUnit {
  id: string;
  topic: string;
  objective: string;
  /** 이 단위로 만들 수 있는 발문 유형 후보(knowledge-rules 카탈로그 값). */
  askKinds: string[];
  /** 그림을 판독해야 하는 단위인가. figures 가 하나 이상일 때만 true. */
  needsImage: boolean;
  /** 계획 입력의 그림 id(F1, F2 …). */
  figures: string[];
  /** 근거가 있다고 본 페이지(계획 입력에 있던 번호만). */
  pages: number[];
  queries: { concept: string; clinical: string; compare: string };
  /** 검색 전용 가상 발문. 생성 입력에는 넣지 않는다. */
  hydeStem: string;
}

export const PLAN_LIMITS = {
  /** 계획 입력 상한(글자). 계획서의 "8k 토큰 이하"를 한국어·영어 혼합 기준으로 글자 수로 둔다. */
  inputChars: 12_000,
  /** 페이지 요약 상한. 페이지가 적으면 첫 문장들을 이만큼까지 싣는다(상한 안에서 페이지 수로 나눈다). */
  pageDigestMaxChars: 600,
  pageDigestMinChars: 50,
  captionMaxChars: 180,
  /** 캡션 목록이 입력에서 차지할 수 있는 몫. 나머지는 페이지 요약이다. */
  captionShare: 0.25,
  topicChars: 60,
  objectiveChars: 160,
  queryChars: 120,
  hydeChars: 200,
  pagesPerUnit: 3,
  unitsFactor: 1.5,
} as const;

export const ALL_PLAN_ASK_KINDS: readonly string[] = [
  ...KNOWLEDGE_ASK_KINDS,
  ...CLINICAL_ASK_KINDS,
  ...IMAGE_ASK_KINDS,
];

const KNOWLEDGE_SET = new Set<string>(KNOWLEDGE_ASK_KINDS);
const IMAGE_SET = new Set<string>(IMAGE_ASK_KINDS);
const CLINICAL_SET = new Set<string>(CLINICAL_ASK_KINDS);

/** 요청 문항 수 → 만들 단위 수(1.5배, 남는 0.5N 은 예비). */
export function planUnitCount(desiredCount: number): number {
  return Math.max(1, Math.ceil(Math.max(0, desiredCount) * PLAN_LIMITS.unitsFactor));
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const clean = (v: unknown, max: number): string => (typeof v === 'string' ? squash(v).slice(0, max).trim() : '');

/**
 * 페이지 요약 — 첫 내용 줄(대개 제목) + 그다음 문장들(슬라이드는 줄들)을 maxChars 까지. 숫자만 있는 줄은
 * 건너뛴다. 계획서 5.2 C 의 "헤딩 경로 + 페이지별 첫 2문장"이 출발점이지만, 2문장만 주면 계획 콜이 주제는
 * 맞혀도 검색어가 막연해져 근거 유사도가 τ 아래로 떨어졌다(f-plan-results.md 1차). 8k 토큰 상한 안에서
 * 페이지 수로 나눈 만큼 첫 문장들을 더 싣는다(페이지가 많으면 결국 첫 1~2문장이 된다).
 */
export function pageDigest(text: string, maxChars: number = PLAN_LIMITS.pageDigestMaxChars): string {
  const lines = String(text ?? '')
    .split('\n')
    .map(squash)
    .filter((l) => /[가-힣A-Za-z]/.test(l));
  if (lines.length === 0) return '';
  const title = lines[0];
  const units: string[] = [];
  let len = title.length + 3;
  outer: for (const line of lines.slice(1)) {
    for (const s of line.split(/(?<=[.!?。])\s+/)) {
      const t = s.trim();
      if (!t) continue;
      // 첫 두 문장은 상한을 넘더라도 넣고(잘라서), 그 뒤로는 상한 안에서만 더한다.
      if (units.length >= 2 && len + t.length + 1 > maxChars) break outer;
      units.push(t);
      len += t.length + 1;
    }
  }
  const digest = units.length > 0 ? `${title} — ${units.join(' ')}` : title;
  return digest.length > maxChars ? `${digest.slice(0, maxChars - 1).trimEnd()}…` : digest;
}

export interface PlanInput {
  text: string;
  /** 그림 id → 출처. 계획 콜이 고른 그림을 크롭으로 되돌릴 때 쓴다. */
  figures: Array<{ id: string; pageIndex: number; imageKey?: string }>;
  pagesIncluded: number;
  pagesTotal: number;
  captionsIncluded: number;
  /** 상한 때문에 빠진 페이지가 있으면 true(고르게 솎아 낸다). */
  truncated: boolean;
}

/**
 * 계획 콜 입력 — `p{번호} 요약` 줄과 `[그림 F{n}] p{번호} 캡션` 줄. 캡션을 먼저 몫 안에서 싣고,
 * 남은 글자를 내용 있는 페이지에 고르게 나눈다. 페이지가 너무 많아 최소 길이로도 넘치면 고르게 솎는다
 * (앞에서부터 자르면 뒤쪽 내용이 계획에서 통째로 빠진다 — 초점 편중 L5 와 같은 실패).
 */
export function buildPlanInput(
  pages: readonly PlanPage[],
  captions: readonly PlanCaption[] = [],
  budgetChars: number = PLAN_LIMITS.inputChars,
): PlanInput {
  const figures: PlanInput['figures'] = [];
  const capLines: string[] = [];
  let capChars = 0;
  const capBudget = Math.floor(budgetChars * PLAN_LIMITS.captionShare);
  for (const c of [...captions].sort((a, b) => a.pageIndex - b.pageIndex)) {
    const id = `F${figures.length + 1}`;
    const body = clean(c.text, PLAN_LIMITS.captionMaxChars);
    if (!body) continue;
    const line = `[그림 ${id}] p${c.pageIndex} ${body}`;
    if (capChars + line.length + 1 > capBudget) break;
    capLines.push(line);
    capChars += line.length + 1;
    figures.push({ id, pageIndex: c.pageIndex, ...(c.imageKey ? { imageKey: c.imageKey } : {}) });
  }

  const ordered = [...pages].sort((a, b) => a.pageIndex - b.pageIndex);
  const content = ordered.filter((p) => pageDigest(p.text, 1_000).length > 0);
  const pageBudget = Math.max(0, budgetChars - capChars - 200);
  let chosen = content;
  let per = content.length > 0 ? Math.floor(pageBudget / content.length) - 6 : 0;
  let truncated = false;
  if (per < PLAN_LIMITS.pageDigestMinChars && content.length > 0) {
    // 최소 길이로도 넘치면 페이지를 고르게 솎는다.
    const keep = Math.max(1, Math.floor(pageBudget / (PLAN_LIMITS.pageDigestMinChars + 6)));
    const step = content.length / keep;
    chosen = Array.from({ length: Math.min(keep, content.length) }, (_, i) => content[Math.floor(i * step)]);
    per = PLAN_LIMITS.pageDigestMinChars;
    truncated = chosen.length < content.length;
  }
  per = Math.min(PLAN_LIMITS.pageDigestMaxChars, per);
  const pageLines = chosen.map((p) => `p${p.pageIndex} ${pageDigest(p.text, per)}`);

  const parts = ['## 자료 요약 (p쪽번호 제목 — 첫 문장)', ...pageLines];
  if (capLines.length > 0) parts.push('', '## 그림 (문항 이미지 후보의 설명)', ...capLines);
  return {
    text: parts.join('\n'),
    figures,
    pagesIncluded: chosen.length,
    pagesTotal: content.length,
    captionsIncluded: capLines.length,
    truncated,
  };
}

/** 계획 콜 도구 스키마. 질의는 중첩 객체보다 평평한 필드가 모델이 덜 틀린다. */
export const PLAN_TOOL = {
  name: 'report_exam_plan',
  description: '강의자료 요약을 보고 시험 출제 단위와 단위별 근거 검색 질의를 보고',
  input_schema: {
    type: 'object',
    properties: {
      units: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            topic: { type: 'string', description: '출제 주제(짧은 명사구, 60자 이내)' },
            objective: { type: 'string', description: '학습목표 한 문장(~을 안다/설명할 수 있다/구별할 수 있다)' },
            ask_kinds: { type: 'array', items: { type: 'string', enum: [...ALL_PLAN_ASK_KINDS] } },
            needs_image: { type: 'boolean' },
            figures: { type: 'array', items: { type: 'string' }, description: '판독할 그림 id(F1 …). 없으면 []' },
            pages: { type: 'array', items: { type: 'integer' }, description: '근거가 있는 쪽 번호 1~3개' },
            query_concept: { type: 'string', description: '핵심 개념 검색어' },
            query_clinical: { type: 'string', description: '임상 맥락 검색어(증상·검사·치료 상황)' },
            query_compare: { type: 'string', description: '감별·비교 검색어' },
            hyde_stem: { type: 'string', description: '이 단위로 낼 법한 시험 발문 한 줄(선지·정답 없이)' },
          },
          required: [
            'topic',
            'objective',
            'ask_kinds',
            'needs_image',
            'pages',
            'query_concept',
            'query_clinical',
            'query_compare',
            'hyde_stem',
          ],
        },
      },
    },
    required: ['units'],
  },
} as const;

export const PLAN_SYSTEM = `너는 의대 내신 시험 출제 계획을 세우는 도구다. 강의자료 요약을 보고 출제 단위를 정하고, 단위마다 강의자료에서 근거를 찾을 검색어를 만든다. 문항 자체는 만들지 않는다.

규칙:
- 단위는 **자료 요약에 보이는 내용**으로만 만든다. 요약에 없는 주제, 자료 밖 교과서 지식으로 단위를 만들지 않는다.
- 단위는 자료 전체에 고르게 퍼뜨린다. 앞부분에 몰지 않는다. 표지·목차·참고문헌 쪽은 근거로 쓰지 않는다.
- 단위끼리 같은 사실을 묻지 않게 한다. 한 개념을 말만 바꿔 두 단위로 쪼개지 않는다.
- topic 은 짧은 명사구, objective 는 학습목표 한 문장으로 쓴다.
- ask_kinds 는 그 단위로 실제로 만들 수 있는 발문 유형 후보 1~3개를 카탈로그에서 고른다. 자료에 수치가 없으면 number_criteria 를 고르지 않는다.
- needs_image 는 [그림 F#] 목록의 그림을 판독해야 풀 수 있는 단위만 true 로 하고 figures 에 그 id 를 적는다. 그림 목록이 없으면 항상 false, figures 는 [].
- pages 는 근거가 있는 쪽 번호를 요약의 p 번호에서 1~3개 고른다.
- 검색어 3개(query_concept·query_clinical·query_compare)는 각 120자 이내로, 그 단위의 pages 요약에 실제로 쓰인 단어(한국어, 영어 약어)를 그대로 넣어 그 쪽의 구체적인 사실 하나를 겨냥한다. 여러 주제를 한 검색어에 나열하지 않는다. 임상 맥락이나 비교 대상이 자료에 없으면 핵심 개념을 다른 표현으로 쓴다.
- hyde_stem 은 이 단위로 낼 법한 시험 발문 한 줄(60자 이내)이다. 선지·정답·해설은 쓰지 않는다.
- 자료가 짧아 근거가 겹치지 않는 단위를 요청한 수만큼 만들 수 없으면 단위 수를 줄인다(최소 개수는 요청에 적힌 대로). 근거가 같은 단위를 말만 바꿔 채우지 않는다.`;

/** 계획 콜 사용자 메시지. 요청 조건과 유형별로 필요한 후보 수를 적는다. */
export function buildPlanPrompt(request: PlanRequest, input: PlanInput): string {
  const units = planUnitCount(request.desiredCount);
  const need = (n: number) => Math.min(units, Math.ceil(n * PLAN_LIMITS.unitsFactor));
  const lines = [
    `## 요청`,
    `- 출제 단위 **${units}개**를 만든다(요청 ${request.desiredCount}문항 + 근거가 부족할 때 쓸 예비 ${units - request.desiredCount}개). 자료가 짧아 서로 다른 근거가 모자라면 줄여도 되지만 ${request.desiredCount}개보다 적게 만들지 않는다.`,
    `- 요청 유형: ${request.selectedTypes.length > 0 ? request.selectedTypes.join('·') : '제한 없음'} · 난이도 ${request.difficulty}`,
  ];
  const t = request.targets;
  if (t.clinical > 0)
    lines.push(`- 임상형 ${t.clinical}문항 몫: ask_kinds 에 임상형 유형(${CLINICAL_ASK_KINDS.join(', ')})이 든 단위를 ${need(t.clinical)}개 이상.`);
  if (t.knowledge > 0)
    lines.push(`- 지식형 ${t.knowledge}문항 몫: ask_kinds 에 지식형 유형(${KNOWLEDGE_ASK_KINDS.join(', ')})이 든 단위를 ${need(t.knowledge)}개 이상.`);
  if (t.image > 0 && input.figures.length > 0)
    lines.push(`- 이미지형 ${t.image}문항 몫: needs_image 단위를 ${Math.min(need(t.image), input.figures.length * 2)}개 이상(이미지형 유형: ${IMAGE_ASK_KINDS.join(', ')}). 그림 하나는 최대 2단위까지.`);
  if (input.truncated)
    lines.push(`- 요약은 ${input.pagesTotal}쪽 중 ${input.pagesIncluded}쪽만 실었다. 실린 쪽 번호만 pages 에 쓴다.`);
  lines.push('', input.text);
  return lines.join('\n');
}

export interface ParsedPlan {
  units: PlanUnit[];
  /** 검사에서 버린 단위 수(주제 없음·중복). */
  dropped: number;
  /** 고쳐 쓴 항목 수(빈 질의를 주제로 채움, 없는 쪽 번호 제거 등). */
  repaired: number;
}

/**
 * 계획 콜 출력 검사. 주제가 없거나 같은 주제가 반복된 단위는 버리고, 나머지는 고쳐 쓴다.
 *  - ask_kinds 는 카탈로그 값만, pages 는 입력에 있던 쪽만, figures 는 입력에 있던 그림만 남긴다.
 *  - figures 가 비면 needs_image 는 false 다(가리킬 그림 없는 이미지 단위는 만들 수 없다).
 *  - 빈 검색어는 주제로, 빈 HyDE 발문은 학습목표(없으면 주제)로 채운다 — 검색은 늘 질의 4개로 한다.
 */
export function parsePlan(
  raw: unknown,
  ctx: { validPages: readonly number[]; figureIds: readonly string[]; maxUnits: number },
): ParsedPlan {
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { units?: unknown }).units)
    ? ((raw as { units: unknown[] }).units)
    : [];
  const pageSet = new Set(ctx.validPages);
  const figSet = new Set(ctx.figureIds);
  const kindSet = new Set(ALL_PLAN_ASK_KINDS);
  const seen = new Set<string>();
  const units: PlanUnit[] = [];
  let dropped = 0;
  let repaired = 0;
  for (const item of list) {
    if (units.length >= ctx.maxUnits) {
      dropped += 1;
      continue;
    }
    const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const topic = clean(o.topic, PLAN_LIMITS.topicChars);
    const key = topic.replace(/\s+/g, '').toLowerCase();
    if (!topic || seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    const objective = clean(o.objective, PLAN_LIMITS.objectiveChars);
    const kindsRaw = Array.isArray(o.ask_kinds) ? o.ask_kinds : [];
    const askKinds = [...new Set(kindsRaw.filter((k): k is string => typeof k === 'string' && kindSet.has(k)))];
    if (askKinds.length !== kindsRaw.length) repaired += 1;
    const pagesRaw = Array.isArray(o.pages) ? o.pages : [];
    const pages = [...new Set(pagesRaw.map(Number).filter((p) => Number.isInteger(p) && pageSet.has(p)))].slice(
      0,
      PLAN_LIMITS.pagesPerUnit,
    );
    if (pages.length !== pagesRaw.length) repaired += 1;
    const figsRaw = Array.isArray(o.figures) ? o.figures : [];
    const figures = [...new Set(figsRaw.filter((f): f is string => typeof f === 'string' && figSet.has(f)))];
    const needsImage = o.needs_image === true && figures.length > 0;
    if ((o.needs_image === true) !== needsImage) repaired += 1;
    // 그림이 없는 단위에 이미지형 발문 유형을 남기면 쿼터 칸 배정이 그 단위를 이미지 몫으로 잘못 본다.
    if (!needsImage && askKinds.some((k) => IMAGE_SET.has(k))) {
      repaired += 1;
      for (let i = askKinds.length - 1; i >= 0; i -= 1) if (IMAGE_SET.has(askKinds[i])) askKinds.splice(i, 1);
    }
    const q = (v: unknown) => clean(v, PLAN_LIMITS.queryChars);
    let concept = q(o.query_concept);
    let clinical = q(o.query_clinical);
    let compare = q(o.query_compare);
    let hydeStem = clean(o.hyde_stem, PLAN_LIMITS.hydeChars);
    if (!concept || !clinical || !compare || !hydeStem) repaired += 1;
    concept ||= topic;
    clinical ||= topic;
    compare ||= topic;
    hydeStem ||= objective || topic;
    units.push({
      id: `u${units.length + 1}`,
      topic,
      objective,
      askKinds,
      needsImage,
      figures: needsImage ? figures : [],
      pages,
      queries: { concept, clinical, compare },
      hydeStem,
    });
  }
  return { units, dropped, repaired };
}

/** 검색에 쓰는 질의 4개 — E1~E3 하네스와 같은 순서(개념·임상·비교·HyDE). */
export function unitQueries(u: PlanUnit): [string, string, string, string] {
  return [u.queries.concept, u.queries.clinical, u.queries.compare, u.hydeStem];
}

/**
 * 계획 콜이 실패했을 때의 단위 — 현행 초점(extractFocusTopics) 하나하나를 질의로 쓴다.
 * 발문 유형 후보를 모르므로 askKinds 는 비고, 쿼터 칸 배정에서 유형 불일치로 센다.
 */
export function fallbackUnitsFromTopics(topics: readonly string[], maxUnits: number): PlanUnit[] {
  const out: PlanUnit[] = [];
  const seen = new Set<string>();
  for (const t of topics) {
    const topic = clean(t, PLAN_LIMITS.topicChars);
    const key = topic.replace(/\s+/g, '').toLowerCase();
    if (!topic || seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `f${out.length + 1}`,
      topic,
      objective: '',
      askKinds: [],
      needsImage: false,
      figures: [],
      pages: [],
      queries: { concept: topic, clinical: topic, compare: topic },
      hydeStem: topic,
    });
    if (out.length >= maxUnits) break;
  }
  return out;
}

export type SlotType = 'image' | 'clinical' | 'knowledge' | 'free';

export interface SlotAssignment {
  batch: number;
  type: SlotType;
  unitId: string | null;
  /** 단위가 칸의 유형을 지원하는가(발문 유형 후보·그림 여부). */
  fit: boolean;
}



export function unitFits(u: PlanUnit, type: SlotType): boolean {
  if (type === 'image') return u.needsImage;
  if (type === 'clinical') return u.askKinds.some((k) => CLINICAL_SET.has(k));
  if (type === 'knowledge') return u.askKinds.some((k) => KNOWLEDGE_SET.has(k));
  return true;
}

/**
 * type-plan 의 묶음별 쿼터 칸에 단위를 배정한다. 묶음 순서대로, 묶음 안에서는 이미지 → 임상 → 지식 → free
 * 칸 순으로, 칸마다 아직 안 쓴 단위 중 **앞에서부터 맞는 것**을 고른다. 단위는 계획 콜이 대개 자료 순서로
 * 내므로 앞 묶음이 앞부분을, 뒤 묶음이 뒷부분을 맡게 된다(구간 분할과 같은 효과).
 *  - 맞는 단위가 없으면 그림이 필요 없는 아무 단위나 넣고 fit=false 로 둔다(이미지 칸이면 묶음 시작 때
 *    spillImageShortfall 이 텍스트 몫으로 옮긴다).
 *  - 남은 단위는 예비(reserve)다. 근거 부족(D3)으로 버린 단위를 이 순서대로 바꿔 끼운다.
 */
export function assignUnitsToSlots(
  units: readonly PlanUnit[],
  quotas: readonly BatchQuota[],
): { slots: SlotAssignment[]; reserve: string[]; stats: { slots: number; filled: number; fit: number; empty: number } } {
  const used = new Set<string>();
  const slots: SlotAssignment[] = [];
  quotas.forEach((q, batch) => {
    const types: SlotType[] = [
      ...Array<SlotType>(Math.max(0, q.image)).fill('image'),
      ...Array<SlotType>(Math.max(0, q.clinical)).fill('clinical'),
      ...Array<SlotType>(Math.max(0, q.knowledge)).fill('knowledge'),
      ...Array<SlotType>(Math.max(0, q.free)).fill('free'),
    ];
    for (const type of types) {
      const fitting = units.find((u) => !used.has(u.id) && unitFits(u, type));
      const pick =
        fitting ?? units.find((u) => !used.has(u.id) && !u.needsImage) ?? units.find((u) => !used.has(u.id));
      if (pick) used.add(pick.id);
      slots.push({ batch, type, unitId: pick?.id ?? null, fit: Boolean(fitting) });
    }
  });
  const reserve = units.filter((u) => !used.has(u.id)).map((u) => u.id);
  const filled = slots.filter((s) => s.unitId !== null).length;
  return {
    slots,
    reserve,
    stats: { slots: slots.length, filled, fit: slots.filter((s) => s.fit).length, empty: slots.length - filled },
  };
}

/** 진단용 계획 통계 — 강의 내용(주제·질의 문구)은 넣지 않는다. */
export function planStats(units: readonly PlanUnit[], input: Pick<PlanInput, 'pagesTotal'>) {
  const hinted = new Set(units.flatMap((u) => u.pages));
  return {
    units: units.length,
    knowledgeCapable: units.filter((u) => unitFits(u, 'knowledge')).length,
    clinicalCapable: units.filter((u) => unitFits(u, 'clinical')).length,
    needsImage: units.filter((u) => u.needsImage).length,
    withPages: units.filter((u) => u.pages.length > 0).length,
    hintedPageShare: input.pagesTotal > 0 ? Math.round((hinted.size / input.pagesTotal) * 1000) / 1000 : 0,
  };
}

/**
 * R1 검색 골드 라벨 초안 (RAG 실행계획 v1.1 · 6.2 R1)
 *
 * 1) 초안: gemini-3.1-pro-preview(계획서의 2.5-pro 는 신규 프로젝트에서 사용 불가)가 자료의 운영 청크(L1_1200)를 읽고 '출제 단위'와 그 근거를 만든다.
 *    출제 단위 = Phase 1 C단계 계획 콜이 만들 단위와 같은 모양(주제·학습목표·질의 3종·HyDE 발문).
 *    근거 = 문항을 쓰는 데 꼭 필요한 사실(fact)별로 {청크, 원문 인용구}, 같은 사실이 다른 청크에도
 *    있으면 대체 위치(alternates).
 * 2) 검증: 인용구가 그 청크 원문에 실제로 있는지 코드로 확인하고, 공백·기호 차이는 원문 구간으로
 *    바로잡는다(바로잡은 것은 표시). 못 찾은 인용구는 버린다.
 * 3) 교차검증: gemini-2.5-flash 가 같은 자료에서 단위마다 근거 청크를 독립적으로 다시 찾는다.
 *    초안과 어긋나거나 초안에 없는 청크를 찾은 단위는 사람이 먼저 보도록 표시한다(자동 반영 안 함).
 *
 * 사람 검토(전재현 전수 확인)는 review-labels.ts 가 만드는 페이지에서 한다. 이 파일의 출력은 초안이다.
 *
 *   cd <체크아웃> && npx tsx scripts/rag-eval/draft-labels.ts --corpus <작업>/corpus.json --out <작업>/labels-draft.json [--only SL1,NT2]
 *
 * 출력에는 강의 원문 인용이 들어가므로 저장소 밖에 둔다(v1.1 R3·D6).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { geminiJson, Meter } from './providers.ts';

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const corpusPath = opt('--corpus');
const outPath = opt('--out');
const only = (opt('--only') ?? '').split(',').filter(Boolean);
// 계획서(6.2 R1)는 gemini-2.5-pro 였으나 이 키(신규 프로젝트)에서는 더 이상 쓸 수 없어 후속 모델로 바꿨다.
const DRAFT_MODEL = opt('--draft-model') ?? 'gemini-3.1-pro-preview';
const CHECK_MODEL = opt('--check-model') ?? 'gemini-2.5-flash';
if (!corpusPath || !outPath) {
  console.error('필수: --corpus <corpus.json> --out <labels-draft.json>');
  process.exit(1);
}

interface Chunk {
  id: string;
  chunkIndex: number;
  pageIndex: number;
  text: string;
}
interface Material {
  key: string;
  kind: string;
  subject: string | null;
  L1_1200: Chunk[];
}

/** 자료 분량에 맞춘 단위 수: 700자당 1개, 최소 4·최대 20(6.2 R1 은 자료당 20개 목표, 작은 자료는 줄임). */
export function targetUnits(totalChars: number): number {
  return Math.max(4, Math.min(20, Math.round(totalChars / 700)));
}

const unitSchema = {
  type: 'object',
  properties: {
    units: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          objective: { type: 'string' },
          ask_kind: { type: 'string', enum: ['지식', '임상', '감별'] },
          queries: {
            type: 'object',
            properties: { concept: { type: 'string' }, clinical: { type: 'string' }, compare: { type: 'string' } },
            required: ['concept', 'clinical', 'compare'],
          },
          hyde_stem: { type: 'string' },
          facts: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                chunk: { type: 'string' },
                quote: { type: 'string' },
                alternates: {
                  type: 'array',
                  items: { type: 'object', properties: { chunk: { type: 'string' }, quote: { type: 'string' } }, required: ['chunk', 'quote'] },
                },
              },
              required: ['chunk', 'quote'],
            },
          },
        },
        required: ['topic', 'objective', 'ask_kind', 'queries', 'hyde_stem', 'facts'],
      },
    },
  },
  required: ['units'],
};

function chunkBlock(m: Material): string {
  return m.L1_1200.map((c) => `[C${c.chunkIndex}] (p.${c.pageIndex})\n${c.text}`).join('\n\n');
}

function draftPrompt(m: Material, n: number): string {
  return `당신은 의대 내신 시험 출제자다. 아래는 한 강의자료를 청크로 나눈 것이다(각 청크 앞의 [C번호]가 청크 id, p.는 쪽).
이 자료만으로 문항을 낼 수 있는 '출제 단위'를 정확히 ${n}개 만들어라. 자료 분량이 모자라면 그보다 적게 만들어도 된다.

출제 단위 규칙
- 자료 전체에 고르게 퍼지게 고른다. 같은 사실을 묻는 단위를 두 번 만들지 않는다.
- topic: 출제 주제(짧게). objective: 이 단위로 확인할 학습 목표 한 문장.
- ask_kind: 지식 / 임상(증례형으로 낼 만한 것) / 감별(비교·구별) 중 하나.
- queries: 출제자가 이 단위의 근거를 자료에서 찾으려고 검색창에 입력할 질의 3개.
  concept = 핵심 개념을 묻는 질의, clinical = 임상 맥락(증상·검사·치료 상황)으로 표현한 질의, compare = 감별·비교 관점 질의.
  근거 인용구를 그대로 베끼지 말고, 자료의 용어(영문 의학용어 포함)를 섞어 자연스러운 검색어로 쓴다.
- hyde_stem: 이 단위로 만들 법한 5지선다 문항의 발문 한 문장(선지 없이).
- facts: 문항을 쓰는 데 꼭 필요한 사실마다 하나씩(1~3개). chunk 는 "C번호", quote 는 그 청크 원문에서 **한 글자도 바꾸지 않고 그대로 복사한** 15~120자 구간.
  같은 사실이 다른 청크에도 나오면 alternates 에 같은 형식으로 적는다(없으면 빈 배열).
- 그림 설명이나 자료 밖 지식에 기대는 단위는 만들지 않는다.

자료 (${m.key}, ${m.subject ?? m.kind})
${chunkBlock(m)}`;
}

const checkSchema = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          unit: { type: 'integer' },
          answerable: { type: 'boolean' },
          evidence: {
            type: 'array',
            items: { type: 'object', properties: { chunk: { type: 'string' }, quote: { type: 'string' } }, required: ['chunk', 'quote'] },
          },
        },
        required: ['unit', 'answerable', 'evidence'],
      },
    },
  },
  required: ['results'],
};

function checkPrompt(m: Material, units: Array<{ topic: string; objective: string }>): string {
  const list = units.map((u, i) => `${i}. ${u.topic} — ${u.objective}`).join('\n');
  return `아래 강의자료 청크를 읽고, 번호 매긴 출제 단위마다 그 단위로 문항을 쓰는 데 필요한 근거가 들어 있는 청크를 모두 찾아라.
- answerable: 이 자료만으로 그 단위의 문항을 쓸 수 있으면 true.
- evidence: 근거 청크마다 {chunk: "C번호", quote: 그 청크 원문 그대로 복사한 15~120자}. 근거가 여러 청크에 나뉘어 있거나 반복되면 전부 적는다.

출제 단위
${list}

자료 (${m.key})
${chunkBlock(m)}`;
}

(async () => {
  const { locateQuote } = await import(pathToFileURL(join(process.cwd(), 'lib/rag/eval-metrics.ts')).href);
  const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { materials: Material[] };
  const prev = existsSync(outPath) ? JSON.parse(readFileSync(outPath, 'utf8')) : { materials: {} };
  const meter = new Meter();

  for (const m of corpus.materials) {
    if (only.length && !only.includes(m.key)) continue;
    if (prev.materials[m.key] && !only.length) {
      console.log(`${m.key}: 이미 있음(건너뜀)`);
      continue;
    }
    const byRef = new Map(m.L1_1200.map((c) => [`C${c.chunkIndex}`, c]));
    const totalChars = m.L1_1200.reduce((a, c) => a + c.text.length, 0);
    const n = targetUnits(totalChars);

    const draft = await geminiJson(DRAFT_MODEL, draftPrompt(m, n), unitSchema, meter, { temperature: 0.3 });
    let fixedQuotes = 0;
    let droppedQuotes = 0;
    const fix = (e: { chunk: string; quote: string }) => {
      const c = byRef.get(String(e.chunk).trim().replace(/^\[|\]$/g, ''));
      if (!c) {
        droppedQuotes += 1;
        return null;
      }
      const q = locateQuote(e.quote, c.text) as string | null;
      if (!q) {
        droppedQuotes += 1;
        return null;
      }
      const corrected = q !== e.quote.trim();
      if (corrected) fixedQuotes += 1;
      return { chunkId: c.id, chunkRef: `C${c.chunkIndex}`, pageIndex: c.pageIndex, quote: q, corrected, ...(corrected ? { originalQuote: e.quote } : {}) };
    };
    const units = (draft.units ?? []).map((u: any, i: number) => {
      const facts = (u.facts ?? [])
        .map((f: any) => {
          const main = fix(f);
          const alternates = (f.alternates ?? []).map(fix).filter(Boolean);
          if (!main && alternates.length === 0) return null;
          return main ? { ...main, alternates } : { ...alternates[0], alternates: alternates.slice(1) };
        })
        .filter(Boolean);
      return {
        id: `${m.key}-u${String(i + 1).padStart(2, '0')}`,
        topic: u.topic,
        objective: u.objective,
        askKind: u.ask_kind,
        queries: u.queries,
        hydeStem: u.hyde_stem,
        facts,
      };
    });

    // 교차검증
    const check = await geminiJson(CHECK_MODEL, checkPrompt(m, units), checkSchema, meter, { temperature: 0 });
    const checkBy = new Map<number, any>((check.results ?? []).map((r: any) => [Number(r.unit), r]));
    let flagged = 0;
    for (const [i, u] of units.entries()) {
      const r = checkBy.get(i);
      const draftChunks = new Set<string>(u.facts.flatMap((f: any) => [f.chunkId, ...f.alternates.map((a: any) => a.chunkId)]));
      const checkEvidence = (r?.evidence ?? []).map(fix).filter(Boolean) as Array<{ chunkId: string; quote: string }>;
      const checkChunks = new Set(checkEvidence.map((e) => e.chunkId));
      const missingInCheck = [...draftChunks].filter((c) => !checkChunks.has(c));
      const extraInCheck = checkEvidence.filter((e) => !draftChunks.has(e.chunkId));
      const flags: string[] = [];
      if (u.facts.length === 0) flags.push('근거 없음(인용구 검증 실패)');
      if (r && r.answerable === false) flags.push('교차검증: 자료만으로 출제 불가 판정');
      if (!r) flags.push('교차검증 응답 없음');
      if (missingInCheck.length) flags.push(`교차검증이 초안 근거 ${missingInCheck.length}개를 찾지 못함`);
      if (extraInCheck.length) flags.push(`교차검증이 추가 근거 후보 ${extraInCheck.length}개 제시`);
      if (u.facts.some((f: any) => f.corrected || f.alternates.some((a: any) => a.corrected))) flags.push('인용구 자동 보정');
      (u as any).crossCheck = { answerable: r?.answerable ?? null, extraCandidates: extraInCheck, missingChunkIds: missingInCheck };
      (u as any).flags = flags;
      if (flags.length) flagged += 1;
    }

    prev.materials[m.key] = { key: m.key, kind: m.kind, subject: m.subject, draftModel: DRAFT_MODEL, checkModel: CHECK_MODEL, requested: n, units };
    writeFileSync(outPath, JSON.stringify(prev, null, 1));
    console.log(
      `${m.key.padEnd(4)} 단위 ${units.length}/${n} · 사실 ${units.reduce((a: number, u: any) => a + u.facts.length, 0)} · 인용 보정 ${fixedQuotes} · 버림 ${droppedQuotes} · 검토 우선 ${flagged} · 누적 $${meter.usd().toFixed(3)}`,
    );
  }
  console.log(`비용 추정 $${meter.usd().toFixed(3)} ${JSON.stringify(meter.tokens)}`);
  process.exit(0);
})().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});

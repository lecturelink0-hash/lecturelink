/**
 * R2 근거 충실도 판정기 (RAG 실행계획 v1.1 · 6.2 R2 · PR K E5·E5-b)
 *
 * 골든셋 실행 기록의 문항마다 "정답 근거 주장"을 나누고, 각 주장이 근거 자료로 뒷받침되는지 LLM 이 판정한다.
 *  - on 문항의 근거 = 그 문항이 인용한 청크(private_questions.evidence 의 chunk_id) 전문
 *  - off 문항의 근거 = 그 문항 source_refs.chunkIds(모델이 보고한 출처 쪽의 청크) 전문
 *    근거가 하나도 없으면 판정하지 않고 '근거 없음'으로 센다(미지지와 따로 보고).
 * 문항 판정: 주장이 전부 지지 → 지지, 미지지가 하나라도 → 미지지, 나머지 → 부분. 충실도 = 지지 문항 비율.
 * 의학 전문가 라벨이 아니다. 판정기(gemini-2.5-flash)는 생성 모델과 같은 계열이라 자기 선호가 섞일 수 있다.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/rag-eval/faithfulness.ts --out <골든셋 결과 폴더> --labels e5-on,g0-off \
 *     --cache <판정 캐시.jsonl> [--json <요약 파일>] [--concurrency 4]
 * 캐시가 있으면 끝난 판정은 건너뛴다(중간에 끊겨도 이어서). 출력은 집계치만(강의 원문 없음).
 */
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const outRoot = resolve(opt('--out') ?? '');
const labels = (opt('--labels') ?? '').split(',').filter(Boolean);
const cachePath = opt('--cache');
const jsonOut = opt('--json');
const concurrency = Number(opt('--concurrency', '4'));
/** 점검용 — 라벨마다 앞 n 문항만. */
const limit = Number(opt('--limit', '0'));
const MODEL = opt('--model', 'gemini-2.5-flash')!;
const MAX_EVIDENCE_CHARS = 9_000;
const PRICE: Record<string, { in: number; out: number }> = {
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-2.5-flash-lite': { in: 0.1, out: 0.4 },
};
if (!opt('--out') || labels.length === 0 || !cachePath) {
  console.error('필수: --out --labels --cache');
  process.exit(1);
}

type Rec = Record<string, any>;
export type Verdict = '지지' | '부분' | '미지지';
export interface Judgement {
  key: string;
  label: string;
  material: string;
  run: number;
  questionId: string;
  evidenceChunks: number;
  noEvidence: boolean;
  claims: Array<{ claim: string; verdict: Verdict }>;
  overall: Verdict | null;
  usd: number;
}

function load(label: string): Rec[] {
  const dir = join(outRoot, label);
  const out: Rec[] = [];
  for (const k of readdirSync(dir)) {
    const kd = join(dir, k);
    if (k.endsWith('.json') || !existsSync(kd)) continue;
    for (const f of readdirSync(kd)) if (/^run\d+\.json$/.test(f)) out.push(JSON.parse(readFileSync(join(kd, f), 'utf8')));
  }
  return out.sort((a, b) => String(a.key).localeCompare(String(b.key)) || a.run - b.run);
}

/** 문항의 근거 청크 id — on 은 인용, off 는 source_refs. */
export function evidenceChunkIds(q: Rec): string[] {
  const cited = Array.isArray(q.evidence) ? q.evidence.map((e: Rec) => String(e.chunk_id ?? '')).filter(Boolean) : [];
  if (cited.length > 0) return [...new Set<string>(cited)];
  const refs = Array.isArray(q.source_refs?.chunkIds) ? q.source_refs.chunkIds.map(String) : [];
  return [...new Set<string>(refs)];
}

export function buildJudgePrompt(q: Rec, evidence: string): string {
  const choices = (q.choices ?? []).map((c: unknown, i: number) => `${i + 1}. ${String(c)}`).join('\n');
  return (
    '다음은 의학 5지선다 문항과, 이 문항의 근거로 제시된 강의자료 발췌입니다.\n\n' +
    `### 문항\n${String(q.stem ?? '')}\n\n### 선지\n${choices}\n\n### 정답\n${Number(q.answer_index) + 1}번\n\n` +
    `### 해설\n${String(q.explanation ?? '').slice(0, 1200)}\n\n### 근거 자료\n${evidence}\n\n` +
    '### 할 일\n' +
    '정답이 정답이 되는 데 필요한 핵심 주장(정답 선지의 내용, 정답을 가르는 조건·소견·기준·기전)을 1~4개로 나누고, ' +
    '각 주장이 위 근거 자료로 뒷받침되는지 판정하세요.\n' +
    '- 지지: 근거 자료에 그 내용이 명시되어 있거나 바로 도출됩니다.\n' +
    '- 부분: 일부만 있거나, 근거 자료가 더 약하거나 다른 조건으로 말합니다.\n' +
    '- 미지지: 근거 자료에 없습니다. 일반 의학 지식으로 옳더라도 근거 자료에 없으면 미지지입니다.\n' +
    '환자 나이·성별·내원 경위 같은 증례 설정은 주장에 넣지 않습니다. 그림에서 읽어야 하는 소견은 그림이 주어지지 않았으므로 주장에 넣지 않습니다.\n' +
    'overall 은 주장이 전부 지지이면 지지, 미지지가 하나라도 있으면 미지지, 나머지는 부분입니다.'
  );
}

const SCHEMA = {
  type: 'OBJECT',
  properties: {
    claims: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { claim: { type: 'STRING' }, verdict: { type: 'STRING', enum: ['지지', '부분', '미지지'] } },
        required: ['claim', 'verdict'],
      },
    },
    overall: { type: 'STRING', enum: ['지지', '부분', '미지지'] },
  },
  required: ['claims', 'overall'],
};

/** 주장 판정에서 문항 판정을 다시 계산한다(모델의 overall 과 다르면 규칙을 따른다). */
export function overallFromClaims(claims: ReadonlyArray<{ verdict: Verdict }>): Verdict | null {
  if (claims.length === 0) return null;
  if (claims.some((c) => c.verdict === '미지지')) return '미지지';
  if (claims.every((c) => c.verdict === '지지')) return '지지';
  return '부분';
}

async function judge(prompt: string): Promise<{ claims: Array<{ claim: string; verdict: Verdict }>; usd: number }> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCHEMA, maxOutputTokens: 8000 },
      }),
    });
    if (res.ok) {
      const j: any = await res.json();
      const um = j.usageMetadata ?? {};
      const p = PRICE[MODEL] ?? PRICE['gemini-2.5-flash'];
      const usd = ((um.promptTokenCount ?? 0) * p.in + ((um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0)) * p.out) / 1e6;
      const text = j.candidates?.[0]?.content?.parts?.map((x: any) => x.text ?? '').join('') ?? '';
      try {
        const parsed = JSON.parse(text);
        const claims = (Array.isArray(parsed.claims) ? parsed.claims : [])
          .filter((c: any) => ['지지', '부분', '미지지'].includes(c?.verdict))
          .map((c: any) => ({ claim: String(c.claim ?? '').slice(0, 300), verdict: c.verdict as Verdict }));
        return { claims, usd };
      } catch {
        // 잘린 JSON — 다시
      }
      continue;
    }
    if (res.status !== 429 && res.status < 500) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
  }
  throw new Error('판정 실패(재시도 소진)');
}

(async () => {
  const done = new Map<string, Judgement>();
  if (existsSync(cachePath!)) {
    for (const line of readFileSync(cachePath!, 'utf8').split('\n')) if (line.trim()) {
      const j = JSON.parse(line) as Judgement;
      done.set(j.key, j);
    }
  }
  const jobs: Array<{ key: string; label: string; r: Rec; q: Rec }> = [];
  for (const label of labels) {
    let n = 0;
    for (const r of load(label)) for (const q of r.questions ?? []) {
      if (limit > 0 && n >= limit) break;
      n += 1;
      jobs.push({ key: `${label}|${r.key}|${r.run}|${q.id}`, label, r, q });
    }
  }
  let usd = 0;
  let next = 0;
  const work = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (done.has(job.key)) continue;
      const chunkText = new Map<string, string>((job.r.chunks ?? []).map((c: Rec) => [String(c.id), String(c.text ?? '')]));
      const ids = evidenceChunkIds(job.q).filter((id) => chunkText.has(id));
      let evidence = '';
      for (const id of ids) {
        const add = `[근거] ${chunkText.get(id)}\n\n`;
        if (evidence.length + add.length > MAX_EVIDENCE_CHARS) break;
        evidence += add;
      }
      const base = { key: job.key, label: job.label, material: String(job.r.key), run: Number(job.r.run), questionId: String(job.q.id), evidenceChunks: ids.length };
      let rec: Judgement;
      if (!evidence.trim()) {
        rec = { ...base, noEvidence: true, claims: [], overall: null, usd: 0 };
      } else {
        const out = await judge(buildJudgePrompt(job.q, evidence.trim()));
        usd += out.usd;
        rec = { ...base, noEvidence: false, claims: out.claims, overall: overallFromClaims(out.claims), usd: out.usd };
      }
      done.set(job.key, rec);
      appendFileSync(cachePath!, JSON.stringify(rec) + '\n');
      if (done.size % 20 === 0) process.stdout.write(`\r판정 ${done.size}/${jobs.length} · 이번 $${usd.toFixed(3)}`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, work));
  process.stdout.write('\n');

  const summary: Record<string, unknown> = {};
  for (const label of labels) {
    const js = jobs.map((j) => done.get(j.key)).filter((x): x is Judgement => Boolean(x) && x!.label === label);
    const judged = js.filter((j) => !j.noEvidence && j.overall);
    const count = (v: Verdict) => judged.filter((j) => j.overall === v).length;
    const claims = judged.flatMap((j) => j.claims);
    const byMat: Record<string, { n: number; supported: number }> = {};
    for (const j of js) {
      const m = (byMat[j.material] ??= { n: 0, supported: 0 });
      m.n += 1;
      if (j.overall === '지지') m.supported += 1;
    }
    summary[label] = {
      questions: js.length,
      noEvidence: js.filter((j) => j.noEvidence).length,
      judged: judged.length,
      supported: count('지지'),
      partial: count('부분'),
      unsupported: count('미지지'),
      // 충실도: 근거 없음도 분모에 넣는다(근거를 못 대는 문항은 충실하지 않다). 판정분만의 비율도 함께.
      faithfulness: js.length ? Math.round((count('지지') / js.length) * 1000) / 1000 : null,
      faithfulnessJudgedOnly: judged.length ? Math.round((count('지지') / judged.length) * 1000) / 1000 : null,
      claimSupport: claims.length ? Math.round((claims.filter((c) => c.verdict === '지지').length / claims.length) * 1000) / 1000 : null,
      byMaterial: Object.fromEntries(Object.entries(byMat).map(([k, v]) => [k, Math.round((v.supported / v.n) * 1000) / 1000])),
      usd: Math.round(js.reduce((a, j) => a + j.usd, 0) * 10_000) / 10_000,
    };
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 1));
})();

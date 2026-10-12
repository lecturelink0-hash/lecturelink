/**
 * R3 인용 적합 라벨 표본·LLM 교차 라벨·E4 임계 판정 (RAG 실행계획 v1.1 · 6.2 R3 · 6.3 E4 · PR K)
 *
 * 1) 표본: 일치율 구간별로 인용을 뽑는다(시드 고정).
 *      npx tsx scripts/rag-eval/cite-labels.ts sample --out <골든셋 결과 폴더> --on e5-on \
 *        --capture <J2 수집 capture.jsonl> --replay <J2 응답 j2.json.calls.jsonl> --to <표본.json>
 *    [0.80, 0.90) 40개는 J2 재생 응답(첫 응답, 교정 전)에서, [0.90, 0.95) 30개·[0.95, 1.00] 30개는 on 실행의 저장 인용에서.
 *    저장 인용은 전부 합격분(≥ 0.90)이라 0.90 아래는 재생 응답에만 있다.
 * 2) LLM 교차 라벨: NODE_USE_ENV_PROXY=1 npx tsx scripts/rag-eval/cite-labels.ts llm --sample <표본.json> --to <LLM 라벨.json>
 * 3) 판정: npx tsx scripts/rag-eval/cite-labels.ts judge --sample <표본.json> --llm <LLM 라벨.json> [--human <사람 라벨.json>]
 *    임계 0.80/0.90/0.95 각각 그 이상 인용의 정밀도(사람 라벨 우선, 없으면 LLM) + 사람–LLM κ.
 *
 * 표본·라벨에는 강의 원문이 들어가므로 저장소 밖에 둔다(D6). 출력(판정)은 집계치만.
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cohenKappa, pick, rng } from './stats-util.ts';

const [mode, ...rest] = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = rest.indexOf(n);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : d;
};

export interface CiteSample {
  id: string;
  source: 'replay' | 'stored';
  bin: '0.80-0.90' | '0.90-0.95' | '0.95-1.00';
  match: number;
  quote: string;
  chunkText: string;
  material?: string;
}

export function binOf(m: number): CiteSample['bin'] | null {
  if (m >= 0.95) return '0.95-1.00';
  if (m >= 0.9) return '0.90-0.95';
  if (m >= 0.8) return '0.80-0.90';
  return null;
}

/** 임계별 정밀도: 일치율 ≥ t 인 표본 중 적합 비율. */
export function precisionAt(samples: ReadonlyArray<{ match: number; ok: boolean }>, t: number) {
  const s = samples.filter((x) => x.match >= t);
  return { n: s.length, ok: s.filter((x) => x.ok).length, precision: s.length ? s.filter((x) => x.ok).length / s.length : null };
}

const BIN_LOW: Record<CiteSample['bin'], number> = { '0.80-0.90': 0.8, '0.90-0.95': 0.9, '0.95-1.00': 0.95 };

/** 구간별 정밀도를 모집단 구간 비율로 가중한 정밀도(임계 t 이상 구간만). 라벨이 없는 구간은 빼고 다시 정규화. */
export function weightedPrecisionAt(
  rows: ReadonlyArray<{ bin: CiteSample['bin']; ok: boolean | undefined }>,
  population: Record<string, number>,
  t: number,
): number | null {
  let w = 0;
  let acc = 0;
  for (const bin of Object.keys(BIN_LOW) as CiteSample['bin'][]) {
    if (BIN_LOW[bin] < t - 1e-9) continue;
    const s = rows.filter((r) => r.bin === bin && r.ok !== undefined);
    const pop = population[bin] ?? 0;
    if (s.length === 0 || pop === 0) continue;
    w += pop;
    acc += pop * (s.filter((r) => r.ok).length / s.length);
  }
  return w > 0 ? acc / w : null;
}

async function sample() {
  const root = process.cwd();
  const { parseEvidenceRefs, partialMatchRatio } = await import(pathToFileURL(join(root, 'lib/rag/cite.ts')).href);
  const outRoot = resolve(opt('--out') ?? '');
  const onLabel = opt('--on')!;
  const rand = rng(Number(opt('--seed', '20261012')));
  // (a) J2 재생 응답 — 첫 응답 인용, 묶음 근거 청크와 대조(재귀속과 같은 뜻으로 묶음 안 최고 일치)
  const lines = readFileSync(opt('--capture')!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const batches: Array<Map<string, string>> = [];
  for (const l of lines) {
    const parts = l.body.contents?.[0]?.parts ?? [];
    const p = parts.find((x: any) => typeof x.text === 'string' && x.text.includes('### 근거 자료'));
    if (!p) continue;
    const text: string = p.text;
    if (Number(/전체 출제 계획 (\d+)묶음 중/.exec(text)?.[1] ?? 0) !== 5) continue;
    const ev = text.slice(text.indexOf('### 근거 자료'), text.indexOf('### 출제 단위'));
    const chunks = new Map<string, string>();
    for (const m of ev.matchAll(/\[(E\d+)\] \(p\.(\d+)[^)]*\) ([\s\S]*?)(?=\n\n\[E\d+\] \(p\.|\n*$)/g)) chunks.set(m[1], m[3]);
    batches.push(chunks);
  }
  const replay: CiteSample[] = [];
  const calls = readFileSync(opt('--replay')!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const c of calls) {
    const bi = Number(String(c.key).split('|')[0]);
    const chunks = batches[bi];
    if (!chunks) continue;
    (c.args?.questions ?? []).forEach((q: any, qi: number) => {
      for (const r of parseEvidenceRefs(q.evidence_refs)) {
        let best = 0;
        let bestText = '';
        for (const t of chunks.values()) {
          const m = partialMatchRatio(r.quote, t);
          if (m > best) {
            best = m;
            bestText = t;
          }
        }
        const bin = binOf(best);
        if (bin) replay.push({ id: `R:${c.key}:${qi}:${r.ref}`, source: 'replay', bin, match: Math.round(best * 1000) / 1000, quote: r.quote, chunkText: bestText });
      }
    });
  }
  // (b) on 실행의 저장 인용
  const stored: CiteSample[] = [];
  const dir = join(outRoot, onLabel);
  for (const k of readdirSync(dir)) {
    const kd = join(dir, k);
    if (k.endsWith('.json') || !existsSync(kd)) continue;
    for (const f of readdirSync(kd)) {
      if (!/^run\d+\.json$/.test(f)) continue;
      const r = JSON.parse(readFileSync(join(kd, f), 'utf8'));
      const chunkText = new Map<string, string>((r.chunks ?? []).map((c: any) => [String(c.id), String(c.text ?? '')]));
      for (const q of r.questions ?? []) for (const e of q.evidence ?? []) {
        const t = chunkText.get(String(e.chunk_id));
        if (!t) continue;
        const m = partialMatchRatio(String(e.quote ?? ''), t);
        const bin = binOf(m);
        if (bin) stored.push({ id: `S:${r.key}:${r.run}:${q.id}:${e.chunk_id}`, source: 'stored', bin, match: Math.round(m * 1000) / 1000, quote: String(e.quote ?? ''), chunkText: t, material: String(r.key) });
      }
    }
  }
  // 첫 응답 인용은 거의 다 ≥ 0.95 라(PREREG E4 표본 수정) [0.80, 0.95) 는 있는 것 전부, 나머지는 ≥ 0.95 저장 인용에서 자료별 층화.
  const total = Number(opt('--n', '100'));
  const low = [...replay, ...stored].filter((x) => x.bin !== '0.95-1.00');
  const out: CiteSample[] = [...low];
  const high = stored.filter((x) => x.bin === '0.95-1.00');
  const byMat = new Map<string, CiteSample[]>();
  for (const x of high) (byMat.get(x.material ?? '') ?? byMat.set(x.material ?? '', []).get(x.material ?? '')!).push(x);
  const mats = [...byMat.keys()].sort();
  const need = Math.max(0, total - out.length);
  const shuffled = new Map(mats.map((m) => [m, pick(byMat.get(m)!, byMat.get(m)!.length, rand)]));
  for (let i = 0; out.length < low.length + need && mats.some((m) => (shuffled.get(m) ?? []).length > 0); i += 1) {
    const m = mats[i % mats.length];
    const x = shuffled.get(m)!.shift();
    if (x) out.push(x);
  }
  // 가중치: 첫 응답 인용(재생) 분포의 구간 비율
  const population: Record<string, number> = { '0.80-0.90': 0, '0.90-0.95': 0, '0.95-1.00': 0 };
  for (const x of replay) population[x.bin] += 1;
  writeFileSync(opt('--to')!, JSON.stringify({ seed: Number(opt('--seed', '20261012')), population, samples: out }, null, 1));
  const counts: Record<string, number> = {};
  for (const x of out) counts[x.bin] = (counts[x.bin] ?? 0) + 1;
  console.log(JSON.stringify({ replayRefs: replay.length, storedRefs: stored.length, population, sampled: out.length, byBin: counts }));
}

async function llm() {
  const { samples } = JSON.parse(readFileSync(opt('--sample')!, 'utf8')) as { samples: CiteSample[] };
  const toPath = opt('--to')!;
  const prev: Record<string, { ok: boolean; reason: string }> = existsSync(toPath) ? JSON.parse(readFileSync(toPath, 'utf8')).labels : {};
  let usd = 0;
  for (const s of samples) {
    if (prev[s.id]) continue;
    const prompt =
      '아래 "인용구"가 "원문 청크"에서 온 구절인지, 그리고 원문과 뜻이 같은지 판정하세요. 띄어쓰기·기호·줄바꿈 차이와 아주 작은 오타는 괜찮습니다. ' +
      '여러 곳을 이어 붙였거나, 바꿔 썼거나, 번역했거나, 원문에 없는 말이 더해져 뜻이 달라졌으면 부적합입니다.\n\n' +
      `### 인용구\n${s.quote}\n\n### 원문 청크\n${s.chunkText.slice(0, 4000)}`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            responseSchema: { type: 'OBJECT', properties: { verdict: { type: 'STRING', enum: ['적합', '부적합'] }, reason: { type: 'STRING' } }, required: ['verdict', 'reason'] },
            maxOutputTokens: 4000,
          },
        }),
      });
      if (res.ok) {
        const j: any = await res.json();
        const um = j.usageMetadata ?? {};
        usd += ((um.promptTokenCount ?? 0) * 0.3 + ((um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0)) * 2.5) / 1e6;
        try {
          const p = JSON.parse(j.candidates?.[0]?.content?.parts?.map((x: any) => x.text ?? '').join('') ?? '');
          prev[s.id] = { ok: p.verdict === '적합', reason: String(p.reason ?? '').slice(0, 200) };
          break;
        } catch {
          continue;
        }
      }
      if (res.status !== 429 && res.status < 500) throw new Error(`gemini ${res.status}`);
      await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
    }
    writeFileSync(toPath, JSON.stringify({ model: 'gemini-2.5-flash', labels: prev }, null, 1));
  }
  console.log(JSON.stringify({ labeled: Object.keys(prev).length, usd: Math.round(usd * 10_000) / 10_000 }));
}

function judge() {
  const { samples } = JSON.parse(readFileSync(opt('--sample')!, 'utf8')) as { samples: CiteSample[] };
  const llmLabels: Record<string, { ok: boolean }> = JSON.parse(readFileSync(opt('--llm')!, 'utf8')).labels;
  const humanPath = opt('--human');
  const human: Record<string, { ok: boolean }> | null = humanPath ? JSON.parse(readFileSync(humanPath, 'utf8')).labels : null;
  const rows = samples.map((s) => ({
    id: s.id,
    bin: s.bin,
    match: s.match,
    llm: llmLabels[s.id]?.ok,
    human: human?.[s.id]?.ok,
  }));
  const primary = rows
    .filter((r) => (human ? r.human !== undefined : r.llm !== undefined))
    .map((r) => ({ match: r.match, ok: Boolean(human ? r.human : r.llm) }));
  const thresholds = [0.8, 0.9, 0.95];
  const population: Record<string, number> | undefined = JSON.parse(readFileSync(opt('--sample')!, 'utf8')).population;
  const at = Object.fromEntries(
    thresholds.map((t) => [t.toFixed(2), { ...precisionAt(primary, t), weighted: population ? weightedPrecisionAt(rows.map((r) => ({ bin: r.bin, ok: human ? r.human : r.llm })), population, t) : null }]),
  );
  const chosen = thresholds.find((t) => (at[t.toFixed(2)].weighted ?? at[t.toFixed(2)].precision ?? 0) >= 0.95) ?? null;
  const both = rows.filter((r) => r.llm !== undefined && r.human !== undefined);
  const byBin = Object.fromEntries(
    ['0.80-0.90', '0.90-0.95', '0.95-1.00'].map((b) => {
      const s = rows.filter((r) => r.bin === b);
      return [b, { n: s.length, llmOk: s.filter((r) => r.llm).length, humanOk: human ? s.filter((r) => r.human).length : null }];
    }),
  );
  console.log(
    JSON.stringify(
      {
        basis: human ? 'human' : 'llm',
        precisionAt: at,
        chosenThreshold: chosen,
        byBin,
        kappa: both.length ? cohenKappa(both.map((r) => r.llm), both.map((r) => r.human)) : null,
        agreement: both.length ? both.filter((r) => r.llm === r.human).length / both.length : null,
        pairs: both.length,
      },
      null,
      1,
    ),
  );
}

(async () => {
  if (mode === 'sample') await sample();
  else if (mode === 'llm') await llm();
  else if (mode === 'judge') judge();
  else {
    console.error('모드: sample | llm | judge');
    process.exit(1);
  }
})();

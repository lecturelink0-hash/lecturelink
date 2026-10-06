/**
 * 세트 중복 보정 (RAG 실행계획 v1.1 · 5.2 J · PR J · J1)
 *
 * 골든셋 실행 기록의 문항으로 "중복 문항" 판정에 쓸 임베딩 입력과 폐기 임계를 정한다. 운영 DB·운영 비용 기록을 건드리지 않는다.
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/rag-eval/dedup-eval.ts --runs <골든셋 결과 폴더> --labels g0-off,i-on,i-on-2,i-on-im \
 *     --cache <캐시 폴더> --out <결과 JSON> [--base g0-off]
 *
 * 절차(사전 판정 기준, docs/naesin-rag-candidates/j-dedup-results.md 1장)
 *  1. 문항 임베딩(voyage-4 document) — 입력 후보 (a) 발문 (b) 발문 + 정답 선지 (c) 발문 + 선지 5개
 *  2. 같은 자료 안의 모든 쌍 코사인
 *  3. LLM 라벨(gemini-2.5-flash, temperature 0): 세 입력 중 하나라도 ≥ 0.80 인 쌍(최대 600, 넘으면 구간 층화) + 0.70~0.80 무작위 80쌍
 *  4. 입력 = ROC-AUC 최고(0.02 이내면 짧은 입력), 임계 = 정밀도 ≥ 0.90 인 가장 낮은 값(0.85~0.98)
 *  5. 기준선: --base 실행 묶음의 세트 안·실행 간 중복률
 * 출력 JSON 은 집계치만 담는다. 쌍 원문 표본은 --pairs-out(저장소 밖)에만 쓴다.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EmbedCache, Meter, embed, geminiJson, PRICES } from './providers.ts';

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const runsDir = opt('--runs');
const labels = (opt('--labels') ?? '').split(',').filter(Boolean);
const cacheDir = opt('--cache');
const outPath = opt('--out');
const pairsOut = opt('--pairs-out');
const baseLabel = opt('--base', 'g0-off')!;
if (!runsDir || labels.length === 0 || !cacheDir || !outPath) {
  console.error('필수: --runs --labels --cache --out');
  process.exit(1);
}

type Q = { idx: number; key: string; label: string; run: number; slot: number; stem: string; choices: string[]; answer: number };
const qs: Q[] = [];
for (const label of labels) {
  const dir = join(runsDir, label);
  for (const key of readdirSync(dir)) {
    const kd = join(dir, key);
    if (key.endsWith('.json') || !existsSync(kd)) continue;
    for (const f of readdirSync(kd)) {
      if (!/^run\d+\.json$/.test(f)) continue;
      const r = JSON.parse(readFileSync(join(kd, f), 'utf8'));
      for (const q of r.questions ?? []) {
        qs.push({
          idx: qs.length,
          key: r.key,
          label,
          run: r.run,
          slot: Number(q.generation_slot ?? 0),
          stem: String(q.stem ?? ''),
          choices: (q.choices ?? []).map(String),
          answer: Number(q.answer_index ?? 0),
        });
      }
    }
  }
}

const VARIANTS = {
  a: (q: Q) => q.stem,
  b: (q: Q) => `${q.stem}\n정답: ${q.choices[q.answer] ?? ''}`,
  c: (q: Q) => `${q.stem}\n선지: ${q.choices.join(' | ')}`,
} as const;
type V = keyof typeof VARIANTS;
const VS = Object.keys(VARIANTS) as V[];

const dot = (x: number[], y: number[]) => {
  let s = 0;
  for (let i = 0; i < x.length; i += 1) s += x[i] * y[i];
  return s;
};
const norm = (x: number[]) => {
  const n = Math.sqrt(dot(x, x)) || 1;
  return x.map((v) => v / n);
};

function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

(async () => {
  const meter = new Meter();
  const cache = new EmbedCache(join(cacheDir, 'dedup-embed.json'));
  const vecs: Record<V, number[][]> = { a: [], b: [], c: [] };
  for (const v of VS) vecs[v] = (await embed('voyage-4', qs.map(VARIANTS[v]), 'document', cache, meter)).map(norm);

  // 같은 자료 안 쌍
  type P = { i: number; j: number; cos: Record<V, number>; sameSet: boolean };
  const pairs: P[] = [];
  const byKey = new Map<string, Q[]>();
  for (const q of qs) (byKey.get(q.key) ?? byKey.set(q.key, []).get(q.key)!).push(q);
  for (const list of byKey.values()) {
    for (let x = 0; x < list.length; x += 1) {
      for (let y = x + 1; y < list.length; y += 1) {
        const i = list[x].idx;
        const j = list[y].idx;
        pairs.push({
          i,
          j,
          cos: { a: dot(vecs.a[i], vecs.a[j]), b: dot(vecs.b[i], vecs.b[j]), c: dot(vecs.c[i], vecs.c[j]) },
          sameSet: list[x].label === list[y].label && list[x].run === list[y].run,
        });
      }
    }
  }

  // 라벨 대상
  const rnd = seededRandom(20261005);
  const high = pairs.filter((p) => VS.some((v) => p.cos[v] >= 0.8));
  let toLabel: P[] = high;
  if (high.length > 600) {
    const bins = [0.8, 0.85, 0.9, 0.95, 1.01];
    toLabel = [];
    for (let b = 0; b < bins.length - 1; b += 1) {
      const inBin = high.filter((p) => Math.max(...VS.map((v) => p.cos[v])) >= bins[b] && Math.max(...VS.map((v) => p.cos[v])) < bins[b + 1]);
      inBin.sort(() => rnd() - 0.5);
      toLabel.push(...inBin.slice(0, 150));
    }
  }
  const mid = pairs.filter((p) => !VS.some((v) => p.cos[v] >= 0.8) && p.cos.b >= 0.7);
  mid.sort(() => rnd() - 0.5);
  const midSample = mid.slice(0, 80);
  const labelSet = [...toLabel, ...midSample];

  // LLM 라벨(10쌍씩) — 캐시
  const labelCachePath = join(cacheDir, 'dedup-labels.json');
  const labelCache: Record<string, { dup: boolean; why: string }> = existsSync(labelCachePath)
    ? JSON.parse(readFileSync(labelCachePath, 'utf8'))
    : {};
  const fmtQ = (q: Q) =>
    `발문: ${q.stem}\n선지: ${q.choices.map((c, k) => `${k + 1}) ${c}`).join(' / ')}\n정답: ${q.answer + 1}) ${q.choices[q.answer] ?? ''}`;
  const pairKey = (p: P) => [qs[p.i], qs[p.j]].map((q) => `${q.label}/${q.key}/${q.run}/${q.slot}`).sort().join('|');
  const pending = labelSet.filter((p) => !labelCache[pairKey(p)]);
  const SCHEMA = {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: { n: { type: 'INTEGER' }, duplicate: { type: 'BOOLEAN' }, reason: { type: 'STRING' } },
      required: ['n', 'duplicate', 'reason'],
    },
  };
  for (let s = 0; s < pending.length; s += 10) {
    const chunk = pending.slice(s, s + 10);
    const prompt =
      '다음은 같은 강의자료로 만든 의학 객관식 문항 쌍들이다. 쌍마다 "중복"인지 판정하라.\n' +
      '중복 = 같은 개념·사실을 같은 방향으로 묻고 정답의 근거가 같아, 하나를 풀면 다른 하나의 답을 바로 아는 경우. ' +
      '지문 표현·환자 나이·선지 구성이 달라도 묻는 점과 정답 근거가 같으면 중복이다. ' +
      '같은 주제라도 묻는 점(진단 vs 치료, 기전 vs 분류, 다른 수치 기준)이나 정답 근거가 다르면 중복이 아니다.\n' +
      'reason 은 한 문장.\n\n' +
      chunk.map((p, k) => `## 쌍 ${k + 1}\n[A]\n${fmtQ(qs[p.i])}\n[B]\n${fmtQ(qs[p.j])}`).join('\n\n');
    // 2.5-flash 는 사고 토큰도 출력 상한에 든다 — 넉넉히 잡고, JSON 이 잘리면 한 번 더 부른다.
    let out: Array<{ n: number; duplicate: boolean; reason: string }> = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        out = await geminiJson('gemini-2.5-flash', prompt, SCHEMA, meter, { temperature: 0, maxOutputTokens: 24_000 });
        break;
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }
    for (const o of out) {
      const p = chunk[o.n - 1];
      if (p) labelCache[pairKey(p)] = { dup: Boolean(o.duplicate), why: String(o.reason ?? '').slice(0, 200) };
    }
    writeFileSync(labelCachePath, JSON.stringify(labelCache));
    process.stdout.write(`\r라벨 ${Math.min(s + 10, pending.length)}/${pending.length}`);
  }
  if (pending.length) process.stdout.write('\n');
  const labeled = labelSet
    .map((p) => ({ p, l: labelCache[pairKey(p)] }))
    .filter((x): x is { p: P; l: { dup: boolean; why: string } } => Boolean(x.l));

  // AUC
  const auc = (v: V) => {
    const pos = labeled.filter((x) => x.l.dup).map((x) => x.p.cos[v]);
    const neg = labeled.filter((x) => !x.l.dup).map((x) => x.p.cos[v]);
    let s = 0;
    for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
    return pos.length && neg.length ? s / (pos.length * neg.length) : null;
  };
  const aucs = Object.fromEntries(VS.map((v) => [v, auc(v)])) as Record<V, number | null>;
  const order: V[] = ['a', 'b', 'c']; // 짧은 입력 순
  const best = Math.max(...VS.map((v) => aucs[v] ?? 0));
  const chosen = order.find((v) => (aucs[v] ?? 0) >= best - 0.02)!;

  const totalDup = labeled.filter((x) => x.l.dup).length;
  const curve = [];
  for (let t = 0.8; t <= 0.981; t += 0.01) {
    const th = Math.round(t * 100) / 100;
    const sel = labeled.filter((x) => x.p.cos[chosen] >= th);
    const tp = sel.filter((x) => x.l.dup).length;
    curve.push({ t: th, flagged: sel.length, tp, precision: sel.length ? tp / sel.length : null, recall: totalDup ? tp / totalDup : null });
  }
  const pick = curve.find((c) => c.t >= 0.85 && c.precision !== null && c.precision >= 0.9);
  const threshold = pick ? pick.t : 0.98;

  // 기준선 중복률(세트 안·실행 간) — 같은 자료·같은 실행 묶음
  const rate = (label: string, th: number, v: V) => {
    const inLabel = qs.filter((q) => q.label === label);
    let within = 0;
    let cross = 0;
    for (const q of inLabel) {
      const earlierSame = inLabel.filter((o) => o.key === q.key && o.run === q.run && o.slot < q.slot);
      if (earlierSame.some((o) => dot(vecs[v][o.idx], vecs[v][q.idx]) >= th)) within += 1;
      const earlierRuns = inLabel.filter((o) => o.key === q.key && o.run < q.run);
      if (earlierRuns.some((o) => dot(vecs[v][o.idx], vecs[v][q.idx]) >= th)) cross += 1;
    }
    const n = inLabel.length;
    const crossN = inLabel.filter((q) => q.run > 1).length;
    return { questions: n, withinSet: within, withinRate: n ? within / n : null, crossRun: cross, crossRate: crossN ? cross / crossN : null };
  };
  const baseline = Object.fromEntries(
    labels.map((l) => [l, { at092: rate(l, 0.92, chosen), atChosen: rate(l, threshold, chosen) }]),
  );

  const usd = Object.entries(meter.tokens).reduce((a, [m, t]) => {
    const p = PRICES[m];
    return a + (p ? (t.input * p.input + t.output * (p.output ?? 0)) / 1e6 : 0);
  }, 0);
  const result = {
    questions: qs.length,
    pairs: pairs.length,
    labeled: labeled.length,
    labeledDuplicates: totalDup,
    labeledFromHigh: toLabel.length,
    labeledFromMid: midSample.length,
    midDuplicates: labeled.filter((x) => midSample.includes(x.p) && x.l.dup).length,
    auc: aucs,
    chosenInput: chosen,
    curve: curve.map((c) => ({ ...c, precision: c.precision === null ? null : Math.round(c.precision * 1000) / 1000, recall: c.recall === null ? null : Math.round(c.recall * 1000) / 1000 })),
    threshold,
    baseline,
    base: baseLabel,
    meter: meter.tokens,
    estUsd: Math.round(usd * 10000) / 10000,
  };
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, curve: undefined, meter: undefined }, null, 1));
  if (pairsOut) {
    const sample = labeled
      .sort((x, y) => y.p.cos[chosen] - x.p.cos[chosen])
      .map((x) => ({ cos: Math.round(x.p.cos[chosen] * 1000) / 1000, dup: x.l.dup, why: x.l.why, a: qs[x.p.i].stem.slice(0, 120), b: qs[x.p.j].stem.slice(0, 120), sameSet: x.p.sameSet }));
    writeFileSync(pairsOut, JSON.stringify(sample, null, 1));
  }
})();

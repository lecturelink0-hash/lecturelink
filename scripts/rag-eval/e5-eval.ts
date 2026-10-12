/**
 * E5 A/B 집계 — G1 지표 중 cite-eval(I1~I8)·dedup-check(중복률)가 다루지 않는 것 (RAG 실행계획 v1.1 · 7장 G1 · PR K)
 *
 *   npx tsx scripts/rag-eval/e5-eval.ts --out <골든셋 결과 폴더> --on e5-on --off g0-off [--json <파일>]
 *
 * - 주제 커버리지: 진단 ragCoverage(본 칸 단위 중 저장 문항이 그 단위 팩 청크를 인용한 비율), 실행 합
 * - 블라인드 통과율: 이미지 문항 블라인드 첫 판정 통과(1 − 탈락/대상), 조건별 합
 * - 반복 안정성: 자료별 회차 묶음의 summarizeGenerationRuns 계약 판정 통과 자료 수
 * - 제공·원가·시간·형식 위반: 조건별 값, 자료별 개선 건수, 부트스트랩 95% 구간(자료 단위 재표집, 시드 고정)
 * - 유형 수확: 최종 유형 합과 목표(typeTargetsFinal) 합
 * 모델 호출 없음. 출력은 집계치만.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { rng } from './stats-util.ts';

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const outRoot = resolve(opt('--out') ?? '');
const onLabel = opt('--on', 'e5-on')!;
const offLabel = opt('--off', 'g0-off')!;
type Rec = Record<string, any>;

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
const median = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const p95 = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : null;
};
const r4 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10_000) / 10_000);
const sum = (xs: number[]) => xs.reduce((a, b) => a + (Number(b) || 0), 0);
const byKey = (rs: Rec[]) => {
  const m = new Map<string, Rec[]>();
  for (const r of rs) (m.get(r.key) ?? m.set(r.key, []).get(r.key)!).push(r);
  return m;
};

/** 자료 단위 부트스트랩: 자료별 (on 값, off 값) 쌍에서 평균 차이의 95% 구간. */
function bootstrapDiff(pairs: Array<[number, number]>, iters = 5000, seed = 20261012) {
  const rand = rng(seed);
  const diffs: number[] = [];
  for (let i = 0; i < iters; i += 1) {
    let d = 0;
    for (let j = 0; j < pairs.length; j += 1) {
      const [a, b] = pairs[Math.floor(rand() * pairs.length)];
      d += a - b;
    }
    diffs.push(d / pairs.length);
  }
  diffs.sort((a, b) => a - b);
  return { lo: r4(diffs[Math.floor(0.025 * iters)]), hi: r4(diffs[Math.floor(0.975 * iters) - 1]) };
}

(async () => {
  const root = process.cwd();
  const { checkQuestionSchema } = await import(pathToFileURL(join(root, 'lib/ai/quality-checks.ts')).href);
  const { summarizeGenerationRuns, contractVerdicts } = await import(pathToFileURL(join(root, 'lib/ai/generation-repeatability.ts')).href);
  const on = load(onLabel);
  const off = load(offLabel);

  const fmtBad = (q: Rec) => (checkQuestionSchema(q) as string[]).some((c) => c.startsWith('format:'));
  const perRun = (r: Rec) => {
    const qs: Rec[] = r.questions ?? [];
    const B: Rec[] = r.diagnostics?.batches ?? [];
    return {
      delivered: qs.length / Number(r.request?.desiredCount ?? 10),
      usdPerQ: Number(r.cost?.perQuestionUsd),
      totalMs: Number(r.diagnostics?.timings?.totalMs ?? NaN),
      fmt: qs.length ? qs.filter(fmtBad).length / qs.length : 0,
      blindTargets: sum(B.map((b) => Number(b.blindTargets ?? 0))),
      blindFailed: sum(B.map((b) => Number(b.blindFailed ?? 0))),
    };
  };
  const cond = (rs: Rec[]) => {
    const pr = rs.map(perRun);
    const kinds: Record<string, number> = {};
    const targets: Record<string, number> = {};
    for (const r of rs) {
      for (const q of r.questions ?? []) kinds[q.kind] = (kinds[q.kind] ?? 0) + 1;
      const t = r.diagnostics?.generation?.typeTargetsFinal ?? r.diagnostics?.generation?.typeTargets ?? {};
      for (const [k, v] of Object.entries(t)) targets[k] = (targets[k] ?? 0) + Number(v);
    }
    const bt = sum(pr.map((p) => p.blindTargets));
    const bf = sum(pr.map((p) => p.blindFailed));
    return {
      runs: rs.length,
      deliveredMean: r4(sum(pr.map((p) => p.delivered)) / Math.max(1, pr.length)),
      usdPerQMedian: r4(median(pr.map((p) => p.usdPerQ))),
      totalMsP95: p95(pr.map((p) => p.totalMs)),
      totalMsMedian: median(pr.map((p) => p.totalMs)),
      formatRate: r4(sum(rs.map((r) => (r.questions ?? []).filter(fmtBad).length)) / Math.max(1, sum(rs.map((r) => (r.questions ?? []).length)))),
      blind: { targets: bt, failed: bf, passRate: bt ? r4(1 - bf / bt) : null },
      kinds,
      targets,
    };
  };

  // 커버리지(on)
  const cov = on.map((r) => r.diagnostics?.generation?.ragCoverage).filter(Boolean);
  const coverage = {
    runs: cov.length,
    units: sum(cov.map((c: Rec) => c.units)),
    covered: sum(cov.map((c: Rec) => c.covered)),
    rate: r4(sum(cov.map((c: Rec) => c.covered)) / Math.max(1, sum(cov.map((c: Rec) => c.units)))),
    minRun: r4(Math.min(...cov.map((c: Rec) => Number(c.rate)))),
  };

  // 반복 안정성 — 자료별 회차 묶음
  const repeat = (rs: Rec[]) => {
    const out: Record<string, { pass: boolean; failed: string[]; crossRunOverlap: number | null }> = {};
    for (const [key, list] of byKey(rs)) {
      const st = summarizeGenerationRuns(
        list.map((r) => ({ ok: (r.questions ?? []).length > 0, elapsedMs: Number(r.wallMs ?? 0), questions: r.questions ?? [] })),
        { requestedCount: Number(list[0]?.request?.desiredCount ?? 10) },
      );
      const v = contractVerdicts(st);
      out[key] = { pass: v.every((x: Rec) => x.pass), failed: v.filter((x: Rec) => !x.pass).map((x: Rec) => x.metric), crossRunOverlap: r4(st.distribution.crossRunOverlapMean) };
    }
    return out;
  };
  const repOn = repeat(on);
  const repOff = repeat(off);

  // 자료별 일관성·부트스트랩
  const mats = [...new Set([...on.map((r) => r.key), ...off.map((r) => r.key)])].sort();
  const matMean = (rs: Rec[], f: (p: ReturnType<typeof perRun>) => number) => {
    const xs = rs.map(perRun).map(f).filter(Number.isFinite);
    return xs.length ? sum(xs) / xs.length : NaN;
  };
  const onBy = byKey(on);
  const offBy = byKey(off);
  const consistency = (f: (p: ReturnType<typeof perRun>) => number, betterLower: boolean) => {
    const pairs: Array<[number, number]> = [];
    let better = 0;
    let worse = 0;
    for (const m of mats) {
      const a = matMean(onBy.get(m) ?? [], f);
      const b = matMean(offBy.get(m) ?? [], f);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      pairs.push([a, b]);
      if (Math.abs(a - b) < 1e-9) continue;
      if (betterLower ? a < b : a > b) better += 1;
      else worse += 1;
    }
    return { materials: pairs.length, onBetter: better, onWorse: worse, meanDiff: r4(sum(pairs.map(([a, b]) => a - b)) / Math.max(1, pairs.length)), ci95: bootstrapDiff(pairs) };
  };

  const result = {
    on: onLabel,
    off: offLabel,
    conditions: { on: cond(on), off: cond(off) },
    coverage,
    repeatability: {
      onPassMaterials: Object.values(repOn).filter((x) => x.pass).length,
      offPassMaterials: Object.values(repOff).filter((x) => x.pass).length,
      on: repOn,
      off: repOff,
    },
    byMaterial: {
      usdPerQ: consistency((p) => p.usdPerQ, true),
      totalMs: consistency((p) => p.totalMs, true),
      formatRate: consistency((p) => p.fmt, true),
      delivered: consistency((p) => p.delivered, false),
    },
  };
  if (opt('--json')) writeFileSync(opt('--json')!, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 1));
})();

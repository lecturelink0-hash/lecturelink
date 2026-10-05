/**
 * PR I 판정 집계 — on 실행 묶음(인용 강제 생성·인용 검증·검증기 근거 팩)을 G0 off 기준선과 나란히 센다.
 * 모델 호출 없음, golden-run.ts 결과 폴더를 읽기만 한다. 출력은 집계치만(강의 문구 없음).
 *
 *   cd <lecturelink 체크아웃> && npx tsx scripts/rag-eval/cite-eval.ts --out <결과 폴더> --on i-on --base g0-off [--json <파일>]
 *
 * 판정 기준(I1~I8)은 docs/naesin-rag-candidates/i-cite-results.md 1장(실행 전 기록)과 같다.
 *  - I3 은 진단을 믿지 않고 저장된 evidence 를 청크 원문과 다시 대조한다(같은 산식, lib/rag/cite.ts).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const outRoot = resolve(opt('--out') ?? '');
const onLabel = opt('--on');
const baseLabel = opt('--base', 'g0-off')!;
const jsonOut = opt('--json');
if (!opt('--out') || !onLabel) {
  console.error('필수: --out <결과 폴더> --on <label> [--base g0-off]');
  process.exit(1);
}

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
  if (s.length === 0) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const p95 = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : null;
};
const r4 = (x: number | null) => (x === null ? null : Math.round(x * 10_000) / 10_000);
const sum = (xs: number[]) => xs.reduce((a, b) => a + (Number(b) || 0), 0);

(async () => {
  const root = process.cwd();
  const { checkQuestionSchema } = await import(pathToFileURL(join(root, 'lib/ai/quality-checks.ts')).href);
  const { partialMatchRatio, CITE_LIMITS } = await import(pathToFileURL(join(root, 'lib/rag/cite.ts')).href);

  const fmtRate = (rs: Rec[]) => {
    let q = 0;
    let bad = 0;
    for (const r of rs) for (const x of r.questions ?? []) {
      q += 1;
      if ((checkQuestionSchema(x) as string[]).some((c) => c.startsWith('format:'))) bad += 1;
    }
    return { questions: q, violations: bad, rate: q ? bad / q : null };
  };
  const genCalls = (rs: Rec[]) => {
    const rows = rs.flatMap((r) => (r.costRows ?? []).filter((c: Rec) => c.endpoint === 'private.generate' && !c.metadata?.hedgeLoser));
    return {
      calls: rows.length,
      callsPerRun: rows.length / Math.max(1, rs.length),
      meanInputTokens: rows.length ? sum(rows.map((c: Rec) => Number(c.input_tokens ?? c.inputTokens ?? 0))) / rows.length : null,
      correctionCalls: rows.filter((c: Rec) => c.metadata?.imageQuotaFix || c.metadata?.difficultyFix || c.metadata?.blindRepair || c.metadata?.citeFix).length,
      citeFixCalls: rows.filter((c: Rec) => c.metadata?.citeFix).length,
    };
  };
  const verifyRate = (rs: Rec[]) => {
    const g = rs.map((r) => r.diagnostics?.generation ?? {});
    const batches = rs.flatMap((r) => r.diagnostics?.batches ?? []);
    const scored = sum(batches.map((b: Rec) => Number(b.verifyScored ?? 0)));
    const flagged = sum(g.map((x: Rec) => Number(x.verifyFlagged ?? 0)));
    return { scored, flagged, rate: scored ? flagged / scored : null };
  };

  const on = load(onLabel);
  const base = load(baseLabel);
  if (on.length === 0) throw new Error(`실행 기록 없음: ${onLabel}`);

  // I1 근거 경로 진입
  const engaged = on.filter((r) => r.diagnostics?.generation?.ragOn?.engaged === true);
  const fallbacks = on.map((r) => r.diagnostics?.generation?.ragOn?.fallback).filter(Boolean);
  const fallbackBatches = sum(on.map((r) => Number(r.diagnostics?.generation?.ragFallbackBatches ?? 0)));
  // I2 제공 문항 수
  const deliveredRatio = on.map((r) => (r.questions ?? []).length / Number(r.request?.desiredCount ?? 10));
  // I3 인용 불변식 — 저장된 evidence 를 청크 원문과 다시 대조
  let stored = 0;
  let invariantOk = 0;
  let citations = 0;
  let recheckFail = 0;
  for (const r of on) {
    const chunkText = new Map((r.chunks ?? []).map((c: Rec) => [c.id, String(c.text ?? '')]));
    for (const q of r.questions ?? []) {
      stored += 1;
      const ev = Array.isArray(q.evidence) ? q.evidence : [];
      let ok = ev.length > 0;
      for (const e of ev) {
        citations += 1;
        const text = chunkText.get(e.chunk_id);
        const m = text === undefined ? 0 : partialMatchRatio(String(e.quote ?? ''), text as string);
        if (m < CITE_LIMITS.threshold) {
          ok = false;
          recheckFail += 1;
        }
      }
      if (ok) invariantOk += 1;
    }
  }
  // I4·I5 인용 통과·폐기 (진단 합계)
  const G = on.map((r) => r.diagnostics?.generation ?? {});
  const citeChecked = sum(G.map((g) => g.citeChecked));
  const citeFirstOk = sum(G.map((g) => g.citeFirstOk));
  const citeLenient = sum(G.map((g) => g.citeFirstLenientOk));
  const citeDiscarded = sum(G.map((g) => g.citeDiscarded));
  const citeRepairAttempted = sum(G.map((g) => g.citeRepairAttempted));
  const citeRepaired = sum(G.map((g) => g.citeRepaired));
  const citeFixChecked = sum(G.map((g) => g.citeFixChecked));
  const citeFixOk = sum(G.map((g) => g.citeFixOk));
  const citeDroppedInFix = sum(G.map((g) => g.citeDroppedInFix));
  const citeReattributed = sum(G.map((g) => g.citeReattributed));
  const reasons: Record<string, number> = {};
  for (const r of on) for (const b of r.diagnostics?.batches ?? []) for (const [k, v] of Object.entries(b.citeFirst?.reasons ?? {})) reasons[k] = (reasons[k] ?? 0) + Number(v);
  // I6·I7 원가·시간
  const perQ = on.map((r) => Number(r.cost?.perQuestionUsd)).filter(Number.isFinite);
  const totalMs = on.map((r) => Number(r.diagnostics?.timings?.totalMs ?? r.cost?.totalMs ?? NaN));
  const wall = on.map((r) => Number(r.wallMs));
  // I8 형식 위반율 — G0 회차별 최댓값
  const fOn = fmtRate(on);
  const baseRuns = [...new Set(base.map((r) => r.run))];
  const fBaseByRun = baseRuns.map((run) => ({ run, ...fmtRate(base.filter((r) => r.run === run)) }));
  const baseMax = Math.max(...fBaseByRun.map((x) => x.rate ?? 0));

  const crit = {
    I1: { pass: engaged.length === on.length, engaged: engaged.length, runs: on.length, fallbacks, fallbackBatches },
    I2: { pass: sum(deliveredRatio) / on.length >= 0.95, mean: r4(sum(deliveredRatio) / on.length), perRun: on.map((r) => `${r.key}:${(r.questions ?? []).length}`) },
    I3: { pass: stored > 0 && invariantOk === stored, stored, invariantOk, citations, recheckFail },
    I4: { pass: citeChecked > 0 && citeFirstOk / citeChecked >= 0.8, rate: r4(citeChecked ? citeFirstOk / citeChecked : null), citeChecked, citeFirstOk },
    I5: { pass: citeChecked > 0 && citeDiscarded / citeChecked <= 0.05, rate: r4(citeChecked ? citeDiscarded / citeChecked : null), citeDiscarded },
    I6: { pass: (median(perQ) ?? Infinity) <= 0.0362, medianPerQuestionUsd: r4(median(perQ)), baseMedian: r4(median(base.map((r) => Number(r.cost?.perQuestionUsd)))) },
    I7: { pass: (p95(totalMs) ?? Infinity) <= 219_000, p95TotalMs: p95(totalMs), p95WallMs: p95(wall), medianTotalMs: median(totalMs) },
    I8: { pass: fOn.rate !== null && fOn.rate <= baseMax + 0.05, rate: r4(fOn.rate), violations: fOn.violations, questions: fOn.questions, baseByRun: fBaseByRun.map((x) => ({ run: x.run, rate: r4(x.rate) })), limit: r4(baseMax + 0.05) },
  };
  const report = {
    lenientFirstRate: r4(citeChecked ? citeLenient / citeChecked : null),
    reattributed: citeReattributed,
    firstFailReasons: reasons,
    repair: { attempted: citeRepairAttempted, repaired: citeRepaired, fixChecked: citeFixChecked, fixOk: citeFixOk, droppedInLaterFixes: citeDroppedInFix },
    verify: { on: verifyRate(on), base: verifyRate(base) },
    generateCalls: { on: genCalls(on), base: genCalls(base) },
    evidenceWaitMs: { median: median(on.map((r) => Number(r.diagnostics?.generation?.ragOn?.waitMs))), max: Math.max(...on.map((r) => Number(r.diagnostics?.generation?.ragOn?.waitMs ?? 0))) },
    d3: { slotsWithoutUnit: sum(on.map((r) => Number(r.diagnostics?.generation?.ragOn?.slotsWithoutUnit ?? 0))), insufficientUnitsInBatches: sum(on.flatMap((r) => (r.diagnostics?.batches ?? []).map((b: Rec) => Number(b.evidenceInsufficient ?? 0)))) },
    evidenceChars: { median: median(on.flatMap((r) => (r.diagnostics?.batches ?? []).map((b: Rec) => Number(b.evidenceChars)))) },
    kinds: on.flatMap((r) => (r.questions ?? []).map((q: Rec) => q.kind)).reduce((a: Rec, k: string) => ((a[k] = (a[k] ?? 0) + 1), a), {}),
    totalUsd: r4(sum(on.map((r) => Number(r.cost?.totalUsd ?? 0)))),
    // 원가 귀속 교차 검증(G0 기준과 같음): |ai_cost_log 합계 / 진단 totalCost − 1| ≤ 1%.
    costCrossCheck: `${on.filter((r) => Number.isFinite(Number(r.cost?.gapRatio)) && Math.abs(Number(r.cost?.gapRatio)) <= 0.01).length}/${on.filter((r) => r.cost?.gapRatio !== undefined && r.cost?.gapRatio !== null).length}`,
    perMaterial: on.map((r) => ({
      key: r.key,
      q: (r.questions ?? []).length,
      usdPerQ: r4(Number(r.cost?.perQuestionUsd)),
      s: Math.round(Number(r.diagnostics?.timings?.totalMs ?? 0) / 1000),
      citeFirst: `${r.diagnostics?.generation?.citeFirstOk ?? 0}/${r.diagnostics?.generation?.citeChecked ?? 0}`,
      discarded: r.diagnostics?.generation?.citeDiscarded ?? 0,
      waitS: Math.round(Number(r.diagnostics?.generation?.ragOn?.waitMs ?? 0) / 1000),
      engaged: r.diagnostics?.generation?.ragOn?.engaged === true,
    })),
  };
  const out = { on: onLabel, base: baseLabel, criteria: crit, report };
  console.log(JSON.stringify(out, null, 1));
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 2));
})();

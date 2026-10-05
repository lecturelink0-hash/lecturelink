/**
 * PR J J3 집계 — 저장된 문항 임베딩으로 세트 안 중복률(G1)과 세트 간 중복(같은 자료 연속 실행)을 다시 잰다. 모델 호출 없음.
 *   npx tsx scripts/rag-eval/dedup-check.ts --out <골든셋 결과 폴더> --on j-on [--cross j-cross]
 * 출력은 집계치만.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const outRoot = resolve(opt('--out') ?? '');
const onLabel = opt('--on');
const crossLabel = opt('--cross');

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
const vecOf = (q: Rec): number[] | null => {
  const e = q.embedding;
  if (Array.isArray(e)) return e.map(Number);
  if (typeof e === 'string' && e.startsWith('[')) return JSON.parse(e);
  return null;
};

(async () => {
  const { DEDUP_DEFAULTS, duplicateRate, cosineUnit } = await import(pathToFileURL(join(process.cwd(), 'lib/rag/dedup.ts')).href);
  const out: Record<string, unknown> = {};
  if (onLabel) {
    const rs = load(onLabel);
    let dup = 0;
    let n = 0;
    let missing = 0;
    const per: unknown[] = [];
    for (const r of rs) {
      const items = (r.questions ?? []).flatMap((q: Rec) => {
        const v = vecOf(q);
        if (!v) missing += 1;
        return v ? [{ id: String(q.id), slot: Number(q.generation_slot ?? 0), vec: v }] : [];
      });
      const g1 = duplicateRate(items, DEDUP_DEFAULTS.g1Threshold);
      dup += g1.duplicates;
      n += g1.questions;
      const d = r.diagnostics?.generation?.dedup ?? {};
      per.push({ key: r.key, g1: g1.duplicates, deleted: d.deleted ?? 0, within: d.withinFound ?? 0, cross: d.crossFound ?? 0, embedded: d.embedded ?? 0 });
    }
    const sum = (k: string) => (per as Rec[]).reduce((a, x) => a + Number(x[k] ?? 0), 0);
    out.on = {
      runs: rs.length,
      questions: n,
      embeddingMissing: missing,
      g1Duplicates: dup,
      g1Rate: n ? Math.round((dup / n) * 10_000) / 10_000 : null,
      deleted: sum('deleted'),
      withinFound: sum('within'),
      crossFound: sum('cross'),
      embedded: sum('embedded'),
      embedCostUsd: Math.round(rs.reduce((a, r) => a + Number(r.diagnostics?.generation?.dedup?.embedCostUsd ?? 0), 0) * 1e6) / 1e6,
      per,
    };
  }
  if (crossLabel) {
    const rs = load(crossLabel);
    const byKey = new Map<string, Rec[]>();
    for (const r of rs) (byKey.get(r.key) ?? byKey.set(r.key, []).get(r.key)!).push(r);
    const res: unknown[] = [];
    for (const [key, list] of byKey) {
      list.sort((a, b) => a.run - b.run);
      for (let i = 1; i < list.length; i += 1) {
        const prev = list.slice(0, i).flatMap((r) => (r.questions ?? []).map(vecOf).filter(Boolean)) as number[][];
        const cur = (list[i].questions ?? []).map(vecOf).filter(Boolean) as number[][];
        const over = (th: number) => cur.filter((v) => prev.some((p) => cosineUnit(v, p) >= th)).length;
        const d = list[i].diagnostics?.generation?.dedup ?? {};
        res.push({
          key,
          run: list[i].run,
          questions: cur.length,
          overThreshold: over(DEDUP_DEFAULTS.threshold),
          over092: over(0.92),
          crossFoundInRun: d.crossFound ?? 0,
          deletedInRun: d.deleted ?? 0,
          priorStems: (list[i].diagnostics?.batches ?? []).some((b: Rec) => Number(b.priorStems ?? 0) > 0),
        });
      }
    }
    out.cross = res;
  }
  console.log(JSON.stringify(out, null, 1));
})();

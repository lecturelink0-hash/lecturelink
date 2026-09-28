/**
 * 골든셋 실행 묶음 비교 (G0 'off 회귀' · G1 '형식 위반율·제공 문항 수')
 *
 * golden-run.ts 결과 폴더의 label 들을 나란히 놓고 회차별로 센다. 모델 호출 없음, 읽기만 함.
 *   cd <lecturelink 체크아웃> && npx tsx scripts/rag-eval/compare-runs.ts --out <결과 폴더> --labels pre-c,g0-off
 *
 * 형식 위반 = checkQuestionSchema 의 'format:' 코드(F01~F17 결정론 검사)가 하나라도 있는 문항.
 * 계약 위반 = 그 밖의 코드(필수 필드·선지 수 등). 출처 = source_refs.pages 가 있는 문항.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const outRoot = resolve(opt('--out') ?? '');
const labels = (opt('--labels') ?? '').split(',').filter(Boolean);
if (!opt('--out') || labels.length === 0) {
  console.error('필수: --out <결과 폴더> --labels a,b');
  process.exit(1);
}

type Rec = { key: string; kind: string; run: number; questions: any[]; cost?: { totalUsd?: number } };

function load(label: string): Rec[] {
  const dir = join(outRoot, label);
  const out: Rec[] = [];
  for (const k of readdirSync(dir)) {
    const kd = join(dir, k);
    if (k.endsWith('.json') || !existsSync(kd)) continue;
    for (const f of readdirSync(kd)) if (/^run\d+\.json$/.test(f)) out.push(JSON.parse(readFileSync(join(kd, f), 'utf8')));
  }
  return out;
}

(async () => {
  const { checkQuestionSchema } = await import(pathToFileURL(join(process.cwd(), 'lib/ai/quality-checks.ts')).href);
  const summarize = (rs: Rec[]) => {
    let q = 0, fmt = 0, contract = 0, withPages = 0, page1Only = 0, multiPage = 0;
    const codes: Record<string, number> = {};
    for (const r of rs) {
      for (const x of r.questions) {
        q += 1;
        const problems = checkQuestionSchema(x) as string[];
        const f = problems.filter((c) => c.startsWith('format:'));
        if (f.length) fmt += 1;
        for (const c of new Set(f)) codes[c] = (codes[c] ?? 0) + 1;
        if (problems.some((c) => !c.startsWith('format:'))) contract += 1;
        const pages = (x.source_refs?.pages ?? []) as number[];
        if (pages.length) withPages += 1;
        if (pages.length && pages.every((n) => n === 1)) page1Only += 1;
        if (new Set(pages).size > 1) multiPage += 1;
      }
    }
    const pct = (n: number) => `${((100 * n) / Math.max(1, q)).toFixed(1)}%`;
    return {
      runs: rs.length,
      questions: q,
      perRun: +(q / Math.max(1, rs.length)).toFixed(2),
      formatViolation: pct(fmt),
      contractViolation: pct(contract),
      withSourcePages: pct(withPages),
      page1Only: pct(page1Only),
      multiPage: pct(multiPage),
      topFormatCodes: Object.entries(codes).sort((a, b) => b[1] - a[1]).slice(0, 5),
      costUsd: +rs.reduce((a, r) => a + (r.cost?.totalUsd ?? 0), 0).toFixed(4),
    };
  };
  const report: Record<string, unknown> = {};
  for (const label of labels) {
    const rs = load(label);
    report[label] = summarize(rs);
    const rounds = [...new Set(rs.map((r) => r.run))].sort((a, b) => a - b);
    if (rounds.length > 1) for (const n of rounds) report[`${label} · ${n}회차`] = summarize(rs.filter((r) => r.run === n));
  }
  console.log(JSON.stringify(report, null, 1));
})();

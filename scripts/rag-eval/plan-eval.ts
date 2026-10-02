/**
 * 출제 계획·질의 평가 (RAG 실행계획 v1.1 · 5.2 C·D · PR G)
 *
 * 골든셋 코퍼스(build-corpus.ts 출력)의 페이지 본문으로 운영 계획 콜(lib/ai/rag-plan.ts)을 부르고, 나온 단위를
 * E1~E3 확정 검색 구성(voyage-4 dense, 질의 4개 각 top-20 → RRF → 근거 팩 6)으로 검색해 잰다.
 * 비교 기준은 현행 초점(extractFocusTopics)을 주제 하나짜리 질의로 쓴 것이다.
 *
 *  - 형식: 유효 단위 수, 버림·고침 수
 *  - R1 일치: R1 단위(사람이 검토한 출제 단위) 중 어떤 단위의 1위 청크가 그 정답 인용구를 담은 비율
 *  - 근거 충분: 단위 최고 유사도 ≥ τ(0.61) 비율 — on 에서 근거 부족(D3)으로 버려질 단위의 반대
 *  - 중복: 1위 청크가 다른 단위와 겹치지 않는 비율, 1위 청크가 덮는 페이지 비율
 *  - 쿼터 칸 배정: type-plan 쿼터(10문항, 2문항 × 5묶음)에 맞는 단위로 채운 비율
 *  - 원가·지연(계획 콜)
 *
 * --abbrev 를 주면 약어 확장(5.2 D) 실험을 함께 한다: R1 정답 질의를 자료 안 정의("약어(풀이)",
 * "풀이(약어)")로 넓혔을 때 Recall@6 이 달라지는가.
 *
 * 운영 DB 에 비용 행을 남기지 않는다(caption-eval.ts 와 같은 방식).
 *
 *   cd <체크아웃> && NODE_USE_ENV_PROXY=1 npx tsx scripts/rag-eval/plan-eval.ts \
 *     --corpus <작업>/corpus.json --labels <작업>/labels-reviewed.json --cache <작업>/results/embed-cache.json \
 *     --out <작업>/plan-eval [--captions IM1=<caption-eval>/IM1/records.json] [--runs 2] [--only SL1,IM1] [--abbrev]
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EmbedCache, Meter, embed } from './providers';

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (n: string) => argv.includes(n);
const corpusPath = opt('--corpus');
const labelsPath = opt('--labels');
const cachePath = opt('--cache');
const outDir = opt('--out');
const runs = Number(opt('--runs', '2'));
const only = (opt('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const captionArgs = Object.fromEntries(
  (opt('--captions') ?? '')
    .split(',')
    .filter(Boolean)
    .map((s) => s.split('=')),
) as Record<string, string>;
const doAbbrev = flag('--abbrev');
const skipPlan = flag('--abbrev-only');
const providerRetries = Number(opt('--provider-retries', '4'));
if (!corpusPath || !labelsPath || !outDir) {
  console.error('필수: --corpus --labels --out');
  process.exit(1);
}
if (resolve(outDir).startsWith(process.cwd() + '/')) {
  console.error('출력이 저장소 안입니다. 강의 원문이 들어가므로 저장소 밖에 두세요.');
  process.exit(1);
}
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-eval';
const origError = console.error;
console.error = (...a: unknown[]) => {
  if (typeof a[0] === 'string' && a[0].startsWith('[cost-cap] insert error')) return;
  origError(...a);
};

const MODEL = 'voyage-4';
const TOP_EACH = 20;
const PACK = 6;
const TAU = 0.61;

interface Fact { quote: string; alternates: Array<{ quote: string }>; chunkId: string }
interface R1Unit { id: string; topic: string; objective: string; queries: { concept: string; clinical: string; compare: string }; hydeStem: string; facts: Fact[]; review?: { status?: string } }

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN;
};

/** 자료 안 약어 정의를 모은다. "LES (lower esophageal sphincter)" / "하부식도괄약근(LES)". */
function extractDefinitions(text: string): Map<string, Set<string>> {
  const defs = new Map<string, Set<string>>();
  const add = (abbr: string, full: string) => {
    const a = abbr.trim();
    const f = full.replace(/\s+/g, ' ').trim();
    if (!/^[A-Z][A-Za-z0-9-]{1,9}$/.test(a) || (a.match(/[A-Z]/g) ?? []).length < 2) return;
    if (f.length < 3 || f.length > 60 || !/[A-Za-z가-힣]{2}/.test(f) || f === a) return;
    if (/^[A-Z0-9\s,;-]+$/.test(f)) return; // 풀이가 또 약어·번호면 버린다
    (defs.get(a) ?? defs.set(a, new Set()).get(a)!).add(f);
  };
  for (const m of text.matchAll(/\b([A-Z][A-Za-z0-9-]{1,9})\s*\(\s*([^()\n]{3,60}?)\s*\)/g)) add(m[1], m[2]);
  for (const m of text.matchAll(/((?:[A-Za-z가-힣][A-Za-z가-힣-]*\s?){1,5})\s*\(\s*([A-Z][A-Za-z0-9-]{1,9})\s*\)/g)) add(m[2], m[1]);
  return defs;
}
function expandQuery(q: string, defs: Map<string, Set<string>>): string {
  const extra: string[] = [];
  for (const [abbr, fulls] of defs) {
    const hasAbbr = new RegExp(`(^|[^A-Za-z0-9])${abbr.replace(/[-]/g, '\\-')}([^A-Za-z0-9]|$)`).test(q);
    const lower = q.toLowerCase();
    const hasFull = [...fulls].some((f) => lower.includes(f.toLowerCase()));
    if (hasAbbr && !hasFull) extra.push(...fulls);
    else if (hasFull && !hasAbbr) extra.push(abbr);
  }
  return extra.length ? `${q} (${[...new Set(extra)].slice(0, 4).join(', ')})` : q;
}

(async () => {
  const imp = (rel: string) => import(pathToFileURL(join(process.cwd(), rel)).href);
  const { planExamUnits } = await imp('lib/ai/rag-plan.ts');
  const plan = await imp('lib/rag/plan.ts');
  const { planTypeTargets, planBatchQuotas } = await imp('lib/ai/type-plan.ts');
  const { extractFocusTopics } = await imp('lib/ai/material-outline.ts');
  const { topKByCosine, rrfFuse } = await imp('lib/rag/retrieval-math.ts');
  const { quoteCovered } = await imp('lib/rag/eval-metrics.ts');
  const { runWithCostAttribution } = await imp('lib/metrics/cost-attribution.ts');
  const { captionChunkText } = await imp('lib/rag/caption.ts');

  const corpus = JSON.parse(readFileSync(corpusPath!, 'utf8')) as {
    materials: Array<{ key: string; pages: Array<{ pageIndex: number; text: string }>; L1_1200: Array<{ id: string; pageIndex: number; text: string }> }>;
  };
  const labels = JSON.parse(readFileSync(labelsPath!, 'utf8')) as { materials: Record<string, { units: R1Unit[] }> };
  mkdirSync(outDir!, { recursive: true });
  const cache = new EmbedCache(cachePath ?? join(outDir!, 'embed-cache.json'));
  const meter = new Meter();
  const mats = corpus.materials.filter((m) => only.length === 0 || only.includes(m.key));

  const factHit = (f: Fact, texts: string[]) => [f.quote, ...(f.alternates ?? []).map((a) => a.quote)].some((q) => quoteCovered(q, texts));

  /** 단위 목록을 검색한다 — E1~E3 와 같은 방식. */
  async function retrieve(key: string, queryLists: string[][]) {
    const m = corpus.materials.find((x) => x.key === key)!;
    const docs = m.L1_1200;
    const dv = await embed(MODEL, docs.map((c) => c.text), 'document', cache, meter);
    const vecs = docs.map((c, i) => ({ id: c.id, vec: dv[i] }));
    const flat = queryLists.flat();
    const qv = flat.length ? await embed(MODEL, flat, 'query', cache, meter) : [];
    let k = 0;
    return queryLists.map((qs) => {
      const lists = qs.map(() => topKByCosine(qv[k++], vecs, TOP_EACH));
      const topScore = Math.max(...lists.map((l: Array<{ score: number }>) => l[0]?.score ?? 0));
      const ranked = rrfFuse(lists.map((l: Array<{ id: string }>) => l.map((s) => s.id))).map((s: { id: string }) => s.id);
      const pack = ranked.slice(0, PACK);
      return { topScore, top1: ranked[0] as string, pack };
    });
  }
  const textOf = new Map(corpus.materials.flatMap((m) => m.L1_1200.map((c) => [c.id, c.text] as const)));
  const pageOf = new Map(corpus.materials.flatMap((m) => m.L1_1200.map((c) => [c.id, c.pageIndex] as const)));

  function score(key: string, units: Array<{ pages?: number[] }>, res: Array<{ topScore: number; top1: string; pack: string[] }>) {
    const r1 = (labels.materials[key]?.units ?? []).filter((u) => u.review?.status !== 'deleted' && u.facts?.length);
    const r1rev = r1.filter((u) => u.review?.status === 'accepted');
    const top1Texts = res.map((r) => textOf.get(r.top1) ?? '');
    const packTexts = res.map((r) => r.pack.map((id) => textOf.get(id) ?? ''));
    const covered = (list: R1Unit[], texts: string[][]) => list.filter((u) => texts.some((t) => u.facts.some((f) => factHit(f, t))));
    const top1Count = new Map<string, number>();
    for (const r of res) top1Count.set(r.top1, (top1Count.get(r.top1) ?? 0) + 1);
    const contentPages = new Set(corpus.materials.find((m) => m.key === key)!.L1_1200.map((c) => c.pageIndex));
    return {
      units: res.length,
      r1: { total: r1.length, top1: covered(r1, top1Texts.map((t) => [t])).length, pack: covered(r1, packTexts).length },
      r1rev: { total: r1rev.length, top1: covered(r1rev, top1Texts.map((t) => [t])).length, pack: covered(r1rev, packTexts).length },
      sufficient: res.filter((r) => r.topScore >= TAU).length,
      uniqueTop1: res.filter((r) => top1Count.get(r.top1) === 1).length,
      top1PageShare: r3(new Set(res.map((r) => pageOf.get(r.top1))).size / Math.max(1, contentPages.size)),
      hintInPack: units.filter((u, i) => (u.pages ?? []).length > 0 && res[i].pack.some((id) => (u.pages ?? []).includes(pageOf.get(id)!))).length,
      withHint: units.filter((u) => (u.pages ?? []).length > 0).length,
    };
  }

  const out: any = { generatedAt: new Date().toISOString(), runs: [], baseline: {} };
  if (!skipPlan) {
    for (const m of mats) {
      const pages = m.pages.map((p) => ({ pageIndex: p.pageIndex, text: p.text }));
      // 현행 초점: pdf-parse 전체 텍스트(페이지를 빈 줄로 이어 붙인 것)에서 뽑는다.
      const topics: string[] = extractFocusTopics(m.pages.map((p) => p.text).join('\n\n'));
      const base = plan.fallbackUnitsFromTopics(topics, 24);
      const baseRes = await retrieve(m.key, base.map((u: any) => [u.topic]));
      out.baseline[m.key] = { topics: base.length, ...score(m.key, base, baseRes) };
      const capPath = captionArgs[m.key];
      const captions = capPath && existsSync(capPath)
        ? (JSON.parse(readFileSync(capPath, 'utf8')) as Array<{ page: number; cap: { caption: any } }>)
            .filter((r) => r.cap?.caption)
            .map((r) => ({ pageIndex: r.page, text: captionChunkText(r.cap.caption) }))
        : [];
      const types = captions.length > 0 ? ['지식형', '임상형', '이미지형'] : ['지식형', '임상형'];
      const targets = planTypeTargets(10, types, captions.length > 0 ? 20 : 0);
      for (let run = 1; run <= runs; run++) {
        // 제공자 과부하(503·429)는 계획 품질이 아니라 가용성 문제라 다시 부른다. 횟수는 기록에 남긴다.
        let r: any;
        let attempts = 0;
        for (;;) {
          attempts += 1;
          r = await runWithCostAttribution({ uploadId: randomUUID(), userId: null }, () =>
            planExamUnits({ pages, captions, request: { desiredCount: 10, selectedTypes: types, difficulty: '중', targets } }),
          );
          if (r.ok || attempts >= providerRetries || !/\b(503|429)\b|UNAVAILABLE|RESOURCE_EXHAUSTED/.test(r.error ?? '')) break;
          console.log(`  · ${m.key} #${run}: 제공자 과부하 — 30초 뒤 다시(${attempts}/${providerRetries})`);
          await new Promise((res) => setTimeout(res, 30_000));
        }
        const units = r.ok ? r.units : plan.fallbackUnitsFromTopics(topics, plan.planUnitCount(10));
        const res = await retrieve(m.key, units.map((u: any) => plan.unitQueries(u)));
        // 운영과 같은 묶음 구성: 10문항 → 2문항 × 5묶음, 이미지형이면 선발사 1묶음을 뺀 나머지가 이미지 자격.
        const sizes = [2, 2, 2, 2, 2];
        const eligible = sizes.map((_, i) => captions.length > 0 && i >= 1);
        const assignment = plan.assignUnitsToSlots(units, planBatchQuotas(sizes, targets, eligible));
        const rec = {
          key: m.key,
          run,
          ok: r.ok,
          attempts,
          error: r.error ?? null,
          input: r.input,
          dropped: r.dropped,
          repaired: r.repaired,
          costUsd: r.costUsd,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          ms: r.ms,
          stats: plan.planStats(units, r.input),
          assignment: assignment.stats,
          score: score(m.key, units, res),
        };
        out.runs.push(rec);
        writeFileSync(join(outDir!, `${m.key}-run${run}.json`), JSON.stringify({ ...rec, units, retrieval: res }, null, 1));
        console.log(
          `- ${m.key} #${run}: ${r.ok ? 'ok' : `폴백(${r.error})`} 단위 ${units.length} · R1 1위 ${rec.score.r1.top1}/${rec.score.r1.total} (현행 ${out.baseline[m.key].r1.top1}) · 충분 ${rec.score.sufficient}/${units.length} · 고유 ${rec.score.uniqueTop1} · $${r.costUsd.toFixed(4)} · ${(r.ms / 1000).toFixed(1)}s · 입력 ${r.inputTokens}tok`,
        );
      }
    }
    // ── 집계
    const R = out.runs as any[];
    const B = Object.values(out.baseline) as any[];
    const sum = (xs: any[], f: (x: any) => number) => xs.reduce((a, x) => a + f(x), 0);
    out.summary = {
      P1_validRuns: `${R.filter((r) => r.ok).length}/${R.length}`,
      providerRetries: R.reduce((a, r) => a + (r.attempts - 1), 0),
      unitsRange: [Math.min(...R.map((r) => r.score.units)), Math.max(...R.map((r) => r.score.units))],
      P2_r1Top1: {
        plan: r3(sum(R, (r) => r.score.r1.top1) / sum(R, (r) => r.score.r1.total)),
        baseline: r3(sum(B, (b) => b.r1.top1) / sum(B, (b) => b.r1.total)),
        planReviewed: r3(sum(R, (r) => r.score.r1rev.top1) / Math.max(1, sum(R, (r) => r.score.r1rev.total))),
        baselineReviewed: r3(sum(B, (b) => b.r1rev.top1) / Math.max(1, sum(B, (b) => b.r1rev.total))),
        planPack: r3(sum(R, (r) => r.score.r1.pack) / sum(R, (r) => r.score.r1.total)),
        baselinePack: r3(sum(B, (b) => b.r1.pack) / sum(B, (b) => b.r1.total)),
        materialsPlanGeBaseline: `${mats.filter((m) => mean(R.filter((r) => r.key === m.key).map((r) => r.score.r1.top1)) >= out.baseline[m.key].r1.top1).length}/${mats.length}`,
      },
      P3_sufficient: { plan: r3(sum(R, (r) => r.score.sufficient) / sum(R, (r) => r.score.units)), baseline: r3(sum(B, (b) => b.sufficient) / sum(B, (b) => b.units)) },
      P4_uniqueTop1: { plan: r3(sum(R, (r) => r.score.uniqueTop1) / sum(R, (r) => r.score.units)), baseline: r3(sum(B, (b) => b.uniqueTop1) / sum(B, (b) => b.units)) },
      top1PageShare: { plan: r3(mean(R.map((r) => r.score.top1PageShare))), baseline: r3(mean(B.map((b) => b.top1PageShare))) },
      hintInPack: r3(sum(R, (r) => r.score.hintInPack) / Math.max(1, sum(R, (r) => r.score.withHint))),
      assignmentFit: r3(sum(R, (r) => r.assignment.fit) / sum(R, (r) => r.assignment.slots)),
      P5: {
        costMedian: r3(pct(R.map((r) => r.costUsd), 50) * 1000) / 1000,
        costMax: r3(Math.max(...R.map((r) => r.costUsd)) * 1000) / 1000,
        msP50: pct(R.map((r) => r.ms), 50),
        msP95: pct(R.map((r) => r.ms), 95),
        inputTokensMax: Math.max(...R.map((r) => r.inputTokens)),
        outputTokensMedian: pct(R.map((r) => r.outputTokens), 50),
      },
    };
  }

  // ── 약어 확장 실험 (R1 정답 질의, E1~E3 와 같은 검색)
  if (doAbbrev) {
    const ab: any = { byMaterial: {} };
    let base = 0, exp = 0, n = 0, baseRev = 0, expRev = 0, nRev = 0, changedQueries = 0, totalQueries = 0;
    for (const m of mats) {
      const defs = extractDefinitions(m.pages.map((p) => p.text).join('\n'));
      const r1 = (labels.materials[m.key]?.units ?? []).filter((u) => u.review?.status !== 'deleted' && u.facts?.length);
      if (r1.length === 0) continue;
      const qBase = r1.map((u) => [u.queries.concept, u.queries.clinical, u.queries.compare, u.hydeStem]);
      const qExp = qBase.map((qs) => qs.map((q) => expandQuery(q, defs)));
      totalQueries += qBase.flat().length;
      changedQueries += qExp.flat().filter((q, i) => q !== qBase.flat()[i]).length;
      const rb = await retrieve(m.key, qBase);
      const re = await retrieve(m.key, qExp);
      const rec = (u: R1Unit, pack: string[]) => u.facts.filter((f) => factHit(f, pack.map((id) => textOf.get(id) ?? ''))).length / u.facts.length;
      const mb = r1.map((u, i) => rec(u, rb[i].pack));
      const me = r1.map((u, i) => rec(u, re[i].pack));
      base += mb.reduce((a, b) => a + b, 0); exp += me.reduce((a, b) => a + b, 0); n += r1.length;
      r1.forEach((u, i) => { if (u.review?.status === 'accepted') { baseRev += mb[i]; expRev += me[i]; nRev += 1; } });
      ab.byMaterial[m.key] = { defs: defs.size, units: r1.length, base: r3(mean(mb)), expanded: r3(mean(me)), sample: [...defs].slice(0, 5).map(([a, f]) => `${a}=${[...f][0]}`) };
      console.log(`- 약어 ${m.key}: 정의 ${defs.size} · Recall@6 ${r3(mean(mb))} → ${r3(mean(me))}`);
    }
    ab.overall = { base: r3(base / n), expanded: r3(exp / n), delta: r3((exp - base) / n), reviewedBase: r3(baseRev / nRev), reviewedExpanded: r3(expRev / nRev), changedQueries: `${changedQueries}/${totalQueries}` };
    ab.worstMaterialDelta = r3(Math.min(...Object.values(ab.byMaterial).map((x: any) => x.expanded - x.base)));
    out.abbrev = ab;
  }
  out.embedUsd = r3(meter.usd() * 1000) / 1000;
  writeFileSync(join(outDir!, 'summary.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ summary: out.summary, abbrev: out.abbrev?.overall, worst: out.abbrev?.worstMaterialDelta }, null, 2));
})().catch((e) => {
  origError(e);
  process.exit(1);
});

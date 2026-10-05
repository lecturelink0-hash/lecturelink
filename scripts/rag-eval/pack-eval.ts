/**
 * 검색·근거 팩 평가 (RAG 실행계획 v1.1 · 5.2 E·F · PR H)
 *
 * 운영과 같은 산식(lib/rag/pack.ts)으로 다음을 잰다. 모델 호출은 임베딩뿐이고 대부분 캐시에서 나온다.
 *  H1 MMR: R1 정답 질의(149단위)로 RRF 순서와 MMR 순서의 Recall@6·팩 안 청크 간 평균 코사인
 *  H2 근거 팩 글자 상한: 상한 없는 팩 대비 Recall@6
 *  H3 계획 질의용 τ: PR G 계획 단위의 최고 유사도 분포 — 근거 확인 단위(1위 청크가 R1 정답 인용구를 담음)와
 *     음성 대조군(장기 계통이 다른 자료의 청크로 검색). 음성 통과율 ≤ 5% 인 가장 작은 τ 와 그때의 양성 통과율
 *  H4 '상' 팩(8개·6,000자) Recall@8
 *  H5 이미지 단위 캡션 일치(IM1)
 *  + τ 후보별 근거 부족(D3) 모의: 계획 단위를 쿼터 칸에 배정한 뒤 예비로 바꿔 끼우고 남는 빈 칸
 *
 *   cd <체크아웃> && NODE_USE_ENV_PROXY=1 npx tsx scripts/rag-eval/pack-eval.ts \
 *     --corpus <작업>/corpus.json --labels <작업>/labels-reviewed.json --cache <작업>/embed-cache.json \
 *     --plan-runs <plan-eval 결과 폴더> --captions IM1=<caption-eval>/IM1/records.json --out <작업>/pack-eval
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EmbedCache, Meter, embed } from './providers';

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const corpusPath = opt('--corpus');
const labelsPath = opt('--labels');
const cachePath = opt('--cache');
const planRuns = opt('--plan-runs');
const outDir = opt('--out');
const captionArgs = Object.fromEntries((opt('--captions') ?? '').split(',').filter(Boolean).map((s) => s.split('='))) as Record<string, string>;
if (!corpusPath || !labelsPath || !cachePath || !planRuns || !outDir) {
  console.error('필수: --corpus --labels --cache --plan-runs --out');
  process.exit(1);
}
if (resolve(outDir).startsWith(process.cwd() + '/')) {
  console.error('출력이 저장소 안입니다.');
  process.exit(1);
}

const MODEL = 'voyage-4';
/** 장기 계통(H3 음성 대조군). 같은 계통끼리는 대조군으로 쓰지 않는다. */
const GROUP: Record<string, string> = {
  SL1: 'gi', SL2: 'gi', NT3: 'gi', SC2: 'gi', IM1: 'gi',
  SL3: 'cardio', NT1: 'cardio', NT2: 'cardio',
  SC1: 'resp',
  SL4: 'lab',
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

(async () => {
  const imp = (rel: string) => import(pathToFileURL(join(process.cwd(), rel)).href);
  const pack = await imp('lib/rag/pack.ts');
  const plan = await imp('lib/rag/plan.ts');
  const { cosine } = await imp('lib/rag/retrieval-math.ts');
  const { quoteCovered } = await imp('lib/rag/eval-metrics.ts');
  const { planTypeTargets, planBatchQuotas } = await imp('lib/ai/type-plan.ts');
  const { captionChunkText } = await imp('lib/rag/caption.ts');
  const { materialImageId } = await imp('lib/extract/chunk-id.ts');

  const corpus = JSON.parse(readFileSync(corpusPath!, 'utf8')) as {
    materials: Array<{ key: string; pages: Array<{ pageIndex: number; text: string }>; L1_1200: Array<{ id: string; chunkIndex: number; pageIndex: number; text: string }> }>;
  };
  const labels = JSON.parse(readFileSync(labelsPath!, 'utf8')) as { materials: Record<string, { units: any[] }> };
  const cache = new EmbedCache(cachePath!);
  const meter = new Meter();
  mkdirSync(outDir!, { recursive: true });

  // 자료별 청크 벡터(IM1 은 캡션 청크까지)
  const chunksOf = new Map<string, any[]>();
  const figuresOf = new Map<string, Array<{ id: string; pageIndex: number; imageKey: string }>>();
  for (const m of corpus.materials) {
    const vecs = await embed(MODEL, m.L1_1200.map((c) => c.text), 'document', cache, meter);
    const chunks = m.L1_1200.map((c, i) => ({ id: c.id, chunkIndex: c.chunkIndex, pageIndex: c.pageIndex, kind: 'slide_text', modality: 'text', text: c.text, vec: vecs[i], imageId: null }));
    const capPath = captionArgs[m.key];
    if (capPath && existsSync(capPath)) {
      const recs = (JSON.parse(readFileSync(capPath, 'utf8')) as Array<{ page: number; idx: number; cap: { caption: any } }>).filter((r) => r.cap?.caption);
      const caps = recs.map((r) => ({ pageIndex: r.page, text: captionChunkText(r.cap.caption), imageKey: `${m.key}-crop-${r.idx}` }));
      // 계획 입력과 같은 규칙으로 그림 id(F1…)를 매긴다.
      const input = plan.buildPlanInput(m.pages, caps);
      figuresOf.set(m.key, input.figures);
      const cv = await embed(MODEL, caps.map((c) => c.text), 'document', cache, meter);
      caps.forEach((c, i) =>
        chunks.push({ id: `${m.key}#cap:${i}`, chunkIndex: 10_000 + i, pageIndex: c.pageIndex, kind: 'image_caption', modality: 'image_caption', text: c.text, vec: cv[i], imageId: materialImageId('eval', c.imageKey) }),
      );
    }
    chunksOf.set(m.key, chunks);
  }
  const textOf = new Map([...chunksOf.values()].flat().map((c) => [c.id, c.text]));
  const factHit = (f: any, texts: string[]) => [f.quote, ...(f.alternates ?? []).map((a: any) => a.quote)].some((q: string) => quoteCovered(q, texts));
  const recallOf = (u: any, ids: string[]) => u.facts.filter((f: any) => factHit(f, ids.map((id) => textOf.get(id) ?? ''))).length / u.facts.length;
  const packSim = (ids: string[], key: string) => {
    const byId = new Map(chunksOf.get(key)!.map((c) => [c.id, c.vec]));
    const sims: number[] = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) sims.push(cosine(byId.get(ids[i]), byId.get(ids[j])));
    return sims.length ? mean(sims) : 0;
  };

  // ── H1·H2·H4: R1 정답 질의
  const r1 = Object.entries(labels.materials).flatMap(([key, ml]) =>
    ml.units.filter((u: any) => u.review?.status !== 'deleted' && u.facts?.length).map((u: any) => ({ ...u, key })),
  );
  const qv = await embed(MODEL, r1.flatMap((u: any) => [u.queries.concept, u.queries.clinical, u.queries.compare, u.hydeStem]), 'query', cache, meter);
  const cfgs = {
    rrf: { mmr: false, size: 6, chars: 1e9 },
    mmr: { mmr: true, size: 6, chars: 1e9 },
    rrf4500: { mmr: false, size: 6, chars: 4500 },
    rrf6000: { mmr: false, size: 6, chars: 6000 },
    mmr4500: { mmr: true, size: 6, chars: 4500 },
    hard8: { mmr: false, size: 8, chars: 6000 },
  } as const;
  const h: Record<string, { recall: number[]; recallRev: number[]; sim: number[]; chars: number[]; truncated: number }> = {};
  r1.forEach((u: any, i: number) => {
    const vecs = qv.slice(i * 4, i * 4 + 4);
    for (const [name, c] of Object.entries(cfgs)) {
      const r = pack.retrieveUnit(u.id, vecs, chunksOf.get(u.key)!.filter((x: any) => x.kind !== 'image_caption'), { tau: 0.61, ...c });
      const ids = r.pack.map((e: any) => e.chunkId);
      const texts = r.pack.map((e: any) => e.text);
      const rec = u.facts.filter((f: any) => factHit(f, texts)).length / u.facts.length;
      const t = (h[name] ??= { recall: [], recallRev: [], sim: [], chars: [], truncated: 0 });
      t.recall.push(rec);
      if (u.review?.status === 'accepted') t.recallRev.push(rec);
      t.sim.push(packSim(ids, u.key));
      t.chars.push(r.packChars);
      if (r.pack.some((e: any) => e.truncated)) t.truncated += 1;
    }
  });
  const hSummary = Object.fromEntries(
    Object.entries(h).map(([k, t]) => [k, { recall: r3(mean(t.recall)), recallReviewed: r3(mean(t.recallRev)), packSim: r3(mean(t.sim)), charsAvg: Math.round(mean(t.chars)), charsMax: Math.max(...t.chars), truncatedUnits: t.truncated }]),
  );
  console.log('H1·H2·H4', JSON.stringify(hSummary, null, 1));

  // ── H3·H5: 계획 단위
  const files = readdirSync(planRuns!).filter((f) => /-run\d+\.json$/.test(f));
  const pos: number[] = [];
  const allPlan: number[] = [];
  const neg: number[] = [];
  /** 참고: 같은 계통의 다른 자료(내용이 실제로 겹칠 수 있어 판정에는 쓰지 않는다). */
  const negSame: number[] = [];
  const r1Pos: number[] = [];
  const runs: any[] = [];
  for (const f of files) {
    const d = JSON.parse(readFileSync(join(planRuns!, f), 'utf8'));
    const key = d.key as string;
    const units = d.units as any[];
    const vecs = await embed(MODEL, units.flatMap((u) => plan.unitQueries(u)), 'query', cache, meter);
    const r1Units = r1.filter((u: any) => u.key === key);
    const figs = figuresOf.get(key) ?? [];
    const retrievals = new Map<string, any>();
    units.forEach((u, i) => {
      const qs = vecs.slice(i * 4, i * 4 + 4);
      const figureImageIds = u.needsImage ? u.figures.map((fid: string) => figs.find((x) => x.id === fid)).filter(Boolean).map((x: any) => materialImageId('eval', x.imageKey)) : undefined;
      const r = pack.retrieveUnit(u.id, qs, chunksOf.get(key)!, { tau: 0.61, size: 6, chars: 4500, figureImageIds });
      retrievals.set(u.id, r);
      allPlan.push(r.topScore);
      const grounded = r1Units.some((ru: any) => ru.facts.some((ff: any) => factHit(ff, [textOf.get(r.ranked[0]) ?? ''])));
      if (grounded) pos.push(r.topScore);
      for (const [other, chunks] of chunksOf) {
        if (other === key) continue;
        const n = pack.retrieveUnit(u.id, qs, chunks.filter((x: any) => x.kind !== 'image_caption'), { tau: 0.61, size: 6, chars: 4500 });
        (GROUP[other] === GROUP[key] ? negSame : neg).push(n.topScore);
      }
    });
    const types = figs.length > 0 ? ['지식형', '임상형', '이미지형'] : ['지식형', '임상형'];
    const targets = planTypeTargets(10, types, figs.length > 0 ? 20 : 0);
    const sizes = [2, 2, 2, 2, 2];
    const quotas = planBatchQuotas(sizes, targets, sizes.map((_, i) => figs.length > 0 && i >= 1));
    runs.push({ key, run: d.run, units, retrievals, slots: plan.assignUnitsToSlots(units, quotas).slots });
  }
  // R1 질의도 양성으로(참고): 정답 인용구가 1위 청크에 있는 R1 단위의 최고 유사도
  r1.forEach((u: any, i: number) => {
    const r = pack.retrieveUnit(u.id, qv.slice(i * 4, i * 4 + 4), chunksOf.get(u.key)!.filter((x: any) => x.kind !== 'image_caption'), { tau: 0.61, size: 6, chars: 1e9 });
    if (recallOf(u, [r.ranked[0]]) > 0) r1Pos.push(r.topScore);
  });
  const passRate = (xs: number[], t: number) => xs.filter((x) => x >= t).length / Math.max(1, xs.length);
  const grid: any[] = [];
  for (let t = 0.4; t <= 0.8001; t += 0.01) {
    const tau = Math.round(t * 100) / 100;
    // D3 모의: 이 τ 로 충분성을 다시 매기고 예비로 바꿔 끼운다.
    let shortfall = 0, replaced = 0, imageSpilled = 0, runsShort = 0;
    for (const run of runs) {
      const re = new Map([...run.retrievals].map(([id, r]: [string, any]) => [id, { ...r, sufficient: r.topScore >= tau, captionMatch: r.captionScore === null ? r.captionMatch : r.captionScore >= tau }]));
      const res = pack.replaceInsufficient(run.slots, run.units, re);
      shortfall += res.shortfall; replaced += res.replaced; imageSpilled += res.imageSpilled;
      if (res.shortfall > 0) runsShort += 1;
    }
    grid.push({ tau, negPass: r3(passRate(neg, tau)), negSameGroupPass: r3(passRate(negSame, tau)), groundedPass: r3(passRate(pos, tau)), planPass: r3(passRate(allPlan, tau)), r1Pass: r3(passRate(r1Pos, tau)), shortfall, replaced, imageSpilled, runsShort });
  }
  const chosen = grid.find((g) => g.negPass <= 0.05) ?? null;
  const at061 = grid.find((g) => g.tau === 0.61);
  const imageUnits = runs.flatMap((r) => [...r.retrievals.values()].filter((x: any) => x.captionMatch !== null));
  const out = {
    generatedAt: new Date().toISOString(),
    h1h2h4: hSummary,
    h3: {
      positives: pos.length, negatives: neg.length, negativesSameGroup: negSame.length, planUnits: allPlan.length, r1Positives: r1Pos.length,
      chosen, at061,
      adopt: chosen ? chosen.groundedPass >= 0.9 : false,
      grid,
    },
    h5: { imageUnits: imageUnits.length, captionScores: imageUnits.map((x: any) => r3(x.captionScore ?? -1)) },
    embedUsd: r3(meter.usd() * 1000) / 1000,
  };
  writeFileSync(join(outDir!, 'summary.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ h3: { ...out.h3, grid: undefined }, h5: out.h5 }, null, 1));
  console.log(grid.filter((g) => g.tau >= 0.5 && g.tau <= 0.68).map((g) => `τ ${g.tau.toFixed(2)} 음성 ${g.negPass} 같은계통 ${g.negSameGroupPass} 양성 ${g.groundedPass} 전체 ${g.planPass} R1 ${g.r1Pass} 빈칸 ${g.shortfall}(${g.runsShort}회) 교체 ${g.replaced} 이미지넘김 ${g.imageSpilled}`).join('\n'));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

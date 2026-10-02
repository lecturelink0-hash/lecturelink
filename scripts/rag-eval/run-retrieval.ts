/**
 * 오프라인 검색 실험 E1~E3 (RAG 실행계획 v1.1 · 0-i · 6.3)
 *
 * 골든셋 코퍼스(build-corpus.ts)와 R1 라벨(draft-labels.ts / 검토본)로 검색만 돌려 근거 회수율을 잰다.
 * 운영 DB 는 건드리지 않는다. dense 는 메모리에서 정확 코사인, sparse 는 로컬 Postgres 의 pg_trgm 으로
 * 계산한다(운영 설계 5.2 E 와 같은 연산자·RRF 상수).
 *
 *   cd <체크아웃> && npx tsx scripts/rag-eval/run-retrieval.ts --corpus <작업>/corpus.json \
 *     --labels <작업>/labels-draft.json --out <작업>/results --pg "host=… port=… user=… dbname=…" \
 *     [--models voyage-3,voyage-4,gemini-embedding-2] [--rerankers rerank-2.5,rerank-3] \
 *     [--e2-model voyage-4 --e2-config rrf] [--live-latency] [--reviewed-only] [--tag <출력 파일 꼬리표>]
 *
 * --reviewed-only: 검토본에서 사람이 '채택'한 단위만 평가한다(미검토 초안 제외).
 *
 * 한 출제 단위 = 질의 4개(개념·임상·감별·HyDE 발문, 5.2 D). 각 질의로 dense top-20·sparse top-20 을
 * 뽑아 RRF(k=60)로 합친다(dense 만 쓰는 구성은 dense 목록끼리 RRF). 리랭커는 합친 상위 20개를
 * 개념 질의+학습목표로 다시 매긴다. 구성 이름: dense · rrf(=dense+sparse) · <기준>+<리랭커> · -1q(개념 질의 하나만).
 *
 * 지표
 *   Recall@6 = 근거 팩(상위 6개)에 들어간 사실 비율의 평균(사실 = 원문 인용구, 대체 위치 중 하나면 회수)
 *   Hit@6    = 사실을 하나라도 회수한 단위 비율
 *   MRR@10   = 순위 상위 10개 중 사실을 담은 첫 항목의 역순위 평균
 *   지연     = 단위당 질의 임베딩 + 리랭크 호출 시간(--live-latency 일 때만 실측, sparse 는 로컬이라 제외)
 * E2 조건: a = 1,200자 청크 6개, b = 1,200자 청크 순위로 부모(페이지) 6개, c = 600자 청크 + 상위 2개만 부모.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EmbedCache, embed, Meter, rerank } from './providers.ts';

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const corpusPath = opt('--corpus');
const labelsPath = opt('--labels');
const outDir = resolve(opt('--out') ?? '');
const pg = opt('--pg');
const models = (opt('--models', 'voyage-3,voyage-4,gemini-embedding-2') ?? '').split(',').filter(Boolean);
const rerankers = (opt('--rerankers', 'rerank-2.5,rerank-3') ?? '').split(',').filter(Boolean);
const e2Model = opt('--e2-model');
const e2Config = opt('--e2-config', 'rrf');
const liveLatency = argv.includes('--live-latency');
const reviewedOnly = argv.includes('--reviewed-only');
const tag = opt('--tag');
if (!corpusPath || !labelsPath || !opt('--out')) {
  console.error('필수: --corpus --labels --out (파일 머리말 참고)');
  process.exit(1);
}

const TOP_EACH = 20;
const PACK = 6;
const MRR_K = 10;

interface Chunk { id: string; pageIndex: number; parentId: string; text: string }
interface Material { key: string; kind: string; pages: Array<{ id: string; text: string }>; L1_1200: Chunk[]; L1_600: Chunk[] }
interface Fact { quote: string; alternates: Array<{ quote: string }> }
interface Unit {
  id: string;
  material: string;
  topic: string;
  objective: string;
  queries: { concept: string; clinical: string; compare: string };
  hydeStem: string;
  facts: Fact[];
}

type SetName = 'L1_1200' | 'L1_600';

(async () => {
  const imp = (rel: string) => import(pathToFileURL(join(process.cwd(), rel)).href);
  const { topKByCosine, rrfFuse, assemblePack } = await imp('lib/rag/retrieval-math.ts');
  const { quoteCovered, reciprocalRankAt, mean, percentile, chooseTau } = await imp('lib/rag/eval-metrics.ts');

  mkdirSync(outDir, { recursive: true });
  const corpus = JSON.parse(readFileSync(corpusPath!, 'utf8')) as { materials: Material[] };
  const labels = JSON.parse(readFileSync(labelsPath!, 'utf8')) as { materials: Record<string, { units: any[] }> };
  const mats = new Map(corpus.materials.map((m) => [m.key, m]));

  // 평가 대상 단위: 사실이 하나 이상, 검토에서 삭제되지 않은 것. --reviewed-only 면 사람이 채택한 것만.
  const units: Unit[] = [];
  for (const [key, ml] of Object.entries(labels.materials)) {
    for (const u of ml.units) {
      if (u.review?.status === 'deleted') continue;
      if (reviewedOnly && u.review?.status !== 'accepted') continue;
      if (!u.facts?.length) continue;
      units.push({ id: u.id, material: key, topic: u.topic, objective: u.objective, queries: u.queries, hydeStem: u.hydeStem, facts: u.facts });
    }
  }
  const unitQueries = (u: Unit) => [u.queries.concept, u.queries.clinical, u.queries.compare, u.hydeStem];
  console.log(`단위 ${units.length}개 (자료 ${new Set(units.map((u) => u.material)).size}건)`);

  const textOf = new Map<string, string>();
  const parentOf = new Map<string, string>();
  for (const m of corpus.materials) {
    for (const p of m.pages) textOf.set(p.id, p.text);
    for (const s of ['L1_1200', 'L1_600'] as const) for (const c of m[s]) { textOf.set(c.id, c.text); parentOf.set(c.id, c.parentId); }
  }
  const factHit = (f: Fact, texts: string[]) => [f.quote, ...f.alternates.map((a) => a.quote)].some((q) => quoteCovered(q, texts));
  const scoreUnitPack = (u: Unit, packTexts: string[]) => {
    const covered = u.facts.filter((f) => factHit(f, packTexts)).length;
    return { recall: covered / u.facts.length, hit: covered > 0 };
  };
  const rrUnit = (u: Unit, rankedTexts: string[]) =>
    Math.max(
      0,
      ...u.facts.map((f) => reciprocalRankAt([f.quote, ...f.alternates.map((a) => a.quote)], rankedTexts, MRR_K)),
    );

  // ── sparse: 로컬 pg_trgm (질의 전부를 한 번에)
  const sparse = new Map<string, string[]>(); // `${set}|${unit}|${qi}` → ranked chunk ids
  if (pg) {
    for (const set of ['L1_1200', 'L1_600'] as SetName[]) {
      const tmp = join(outDir, `_sparse_${set}`);
      mkdirSync(tmp, { recursive: true });
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\t/g, ' ').replace(/\r?\n/g, '\\n');
      writeFileSync(join(tmp, 'chunks.tsv'), corpus.materials.flatMap((m) => m[set].map((c) => `${c.id}\t${m.key}\t${esc(c.text)}`)).join('\n') + '\n');
      writeFileSync(
        join(tmp, 'queries.tsv'),
        units.flatMap((u) => unitQueries(u).map((q, qi) => `${u.id}|${qi}\t${u.material}\t${esc(q)}`)).join('\n') + '\n',
      );
      // psql 메타 명령(\\copy)은 줄 맨 앞에 있어야 한다 — 들여쓰기 없이 조립한다.
      const sql = [
        'create temp table c(id text, mat text, body text);',
        'create temp table q(id text, mat text, qtext text);',
        `\\copy c from '${join(tmp, 'chunks.tsv')}'`,
        `\\copy q from '${join(tmp, 'queries.tsv')}'`,
        `\\copy (select q.id, t.id, t.s from q cross join lateral (select c.id, word_similarity(q.qtext, c.body) s from c where c.mat = q.mat order by s desc, c.id limit ${TOP_EACH}) t where t.s > 0 order by q.id, t.s desc, t.id) to stdout with csv`,
      ].join('\n') + '\n';
      const outCsv = execFileSync('psql', [pg, '-X', '-q', '-v', 'ON_ERROR_STOP=1'], { input: sql, encoding: 'utf8', maxBuffer: 1 << 28 });
      for (const line of outCsv.split('\n')) {
        if (!line) continue;
        const [qid, cid] = line.split(',');
        const [uid, qi] = qid.split('|');
        const k = `${set}|${uid}|${qi}`;
        if (!sparse.has(k)) sparse.set(k, []);
        sparse.get(k)!.push(cid);
      }
    }
    console.log(`sparse 목록 ${sparse.size}개 (pg_trgm word_similarity)`);
  } else {
    console.log('--pg 없음: sparse(RRF) 조건은 건너뜀');
  }

  const cache = new EmbedCache(join(outDir, 'embed-cache.json'));
  const meter = new Meter();

  /** 모델·청크 세트별 문서 벡터와 단위 질의 벡터. */
  async function vectors(model: string, set: SetName) {
    const docs = corpus.materials.flatMap((m) => m[set]);
    const dv = await embed(model, docs.map((d) => d.text), 'document', cache, meter);
    const byMat = new Map<string, Array<{ id: string; vec: number[] }>>();
    docs.forEach((d, i) => {
      const key = d.id.split('#')[0];
      if (!byMat.has(key)) byMat.set(key, []);
      byMat.get(key)!.push({ id: d.id, vec: dv[i] });
    });
    const qTexts = units.flatMap(unitQueries);
    const qv = await embed(model, qTexts, 'query', cache, meter);
    const qvByUnit = new Map(units.map((u, i) => [u.id, qv.slice(i * 4, i * 4 + 4)]));
    return { byMat, qvByUnit };
  }

  type Config = 'dense' | 'rrf' | `rrf+${string}` | `dense+${string}` | 'dense-1q' | 'rrf-1q';
  interface UnitRun { unit: string; material: string; recall: number; hit: boolean; rr: number; topScore: number | null; latencyMs: number | null; embedMs: number | null; rerankMs: number | null; packChars: number }

  async function runConfig(model: string, set: SetName, config: Config, v: Awaited<ReturnType<typeof vectors>>, expandTop: number): Promise<UnitRun[]> {
    const out: UnitRun[] = [];
    for (const u of units) {
      const docs = v.byMat.get(u.material) ?? [];
      const qvs = v.qvByUnit.get(u.id)!;
      const single = config.endsWith('-1q');
      const qIdx = single ? [0] : [0, 1, 2, 3];
      let latency = 0;
      let embedMs: number | null = null;
      let rerankMs: number | null = null;
      if (liveLatency) {
        const t0 = Date.now();
        await embed(model, qIdx.map((qi) => unitQueries(u)[qi]), 'query', null, meter);
        embedMs = Date.now() - t0;
        latency += embedMs;
      }
      const denseLists = qIdx.map((i) => topKByCosine(qvs[i], docs, TOP_EACH));
      const topDense = Math.max(...denseLists.map((l: any[]) => l[0]?.score ?? 0));
      const lists: string[][] = denseLists.map((l: any[]) => l.map((s) => s.id));
      if (config.startsWith('rrf')) for (const i of qIdx) lists.push(sparse.get(`${set}|${u.id}|${i}`) ?? []);
      let ranked: string[] = rrfFuse(lists).map((s: { id: string }) => s.id);
      let topScore: number | null = topDense;
      if (config.includes('+')) {
        const rr = config.split('+')[1];
        const cand = ranked.slice(0, 20);
        const t0 = Date.now();
        const res = await rerank(rr, `${u.queries.concept} — ${u.objective}`, cand.map((id) => textOf.get(id)!), 20, meter);
        rerankMs = Date.now() - t0;
        latency += rerankMs;
        ranked = res.map((r) => cand[r.index]);
        topScore = res[0]?.score ?? null;
      }
      const pack = assemblePack(ranked, (id: string) => parentOf.get(id) ?? null, { size: PACK, expandTop });
      const packTexts = pack.map((p: { id: string }) => textOf.get(p.id)!);
      const s = scoreUnitPack(u, packTexts);
      out.push({
        unit: u.id,
        material: u.material,
        recall: s.recall,
        hit: s.hit,
        rr: rrUnit(u, ranked.slice(0, MRR_K).map((id) => textOf.get(id)!)),
        topScore,
        latencyMs: liveLatency ? latency : null,
        embedMs,
        rerankMs,
        packChars: packTexts.reduce((a: number, t: string) => a + t.length, 0),
      });
    }
    return out;
  }

  // 재현 가능한 부트스트랩(단위 단위로 다시 뽑기) — 두 조건의 Recall@6 차이의 95% 구간.
  function bootstrapDiff(a: UnitRun[], b: UnitRun[], n = 2000): [number, number] {
    let seed = 20260928;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const diffs: number[] = [];
    for (let r = 0; r < n; r += 1) {
      let s = 0;
      for (let i = 0; i < a.length; i += 1) {
        const j = Math.floor(rnd() * a.length);
        s += a[j].recall - b[j].recall;
      }
      diffs.push(s / a.length);
    }
    diffs.sort((x, y) => x - y);
    return [diffs[Math.floor(0.025 * n)], diffs[Math.floor(0.975 * n)]];
  }

  const summarize = (rs: UnitRun[]) => ({
    units: rs.length,
    recall6: +(mean(rs.map((r) => r.recall)) ?? 0).toFixed(4),
    hit6: +(rs.filter((r) => r.hit).length / Math.max(1, rs.length)).toFixed(4),
    mrr10: +(mean(rs.map((r) => r.rr)) ?? 0).toFixed(4),
    p95LatencyMs: liveLatency ? percentile(rs.map((r) => r.latencyMs ?? 0), 95) : null,
    // 임베딩 API 지연은 호출마다 흔들려 구성 간 비교를 가린다. 리랭커 판정(p95 증가 ≤ 1.5초)은 리랭크 호출만 본다.
    p95RerankMs: rs.some((r) => r.rerankMs !== null) ? percentile(rs.filter((r) => r.rerankMs !== null).map((r) => r.rerankMs!), 95) : null,
    p50EmbedMs: rs.some((r) => r.embedMs !== null) ? percentile(rs.filter((r) => r.embedMs !== null).map((r) => r.embedMs!), 50) : null,
    avgPackChars: Math.round(mean(rs.map((r) => r.packChars)) ?? 0),
    byMaterial: Object.fromEntries(
      [...new Set(rs.map((r) => r.material))].map((m) => [m, +(mean(rs.filter((r) => r.material === m).map((r) => r.recall)) ?? 0).toFixed(3)]),
    ),
  });

  const results: Record<string, any> = { generatedAt: new Date().toISOString(), units: units.length, sparse: pg ? 'pg_trgm word_similarity' : null, runs: {} };
  const runsByKey: Record<string, UnitRun[]> = {};

  // ── E1 × E3 (1,200자 청크, 확장 없음)
  if (!e2Model) {
    for (const model of models) {
      const v = await vectors(model, 'L1_1200');
      const configs: Config[] = ['dense', 'dense-1q', ...rerankers.map((r) => `dense+${r}` as Config)];
      if (pg) configs.push('rrf', 'rrf-1q', ...rerankers.map((r) => `rrf+${r}` as Config));
      for (const config of configs) {
        const rs = await runConfig(model, 'L1_1200', config, v, 0);
        const key = `${model} · ${config}`;
        runsByKey[key] = rs;
        results.runs[key] = summarize(rs);
        console.log(`${key.padEnd(36)} R@6 ${results.runs[key].recall6.toFixed(3)} Hit@6 ${results.runs[key].hit6.toFixed(3)} MRR@10 ${results.runs[key].mrr10.toFixed(3)}${liveLatency ? ` 임베딩p50 ${results.runs[key].p50EmbedMs}ms 리랭크p95 ${results.runs[key].p95RerankMs ?? "—"}ms` : ''}`);
      }
    }
    // 주요 비교의 부트스트랩 구간
    const cmp: Record<string, [number, number]> = {};
    for (const model of models) {
      const d = runsByKey[`${model} · dense`];
      const r = runsByKey[`${model} · rrf`];
      if (d && r) cmp[`${model}: rrf − dense`] = bootstrapDiff(r, d);
      for (const rr of rerankers) {
        const x = runsByKey[`${model} · rrf+${rr}`];
        if (x && r) cmp[`${model}: rrf+${rr} − rrf`] = bootstrapDiff(x, r);
        const y = runsByKey[`${model} · dense+${rr}`];
        if (y && d) cmp[`${model}: dense+${rr} − dense`] = bootstrapDiff(y, d);
      }
    }
    for (let i = 0; i < models.length; i += 1) for (let j = i + 1; j < models.length; j += 1) {
      const a = runsByKey[`${models[i]} · dense`];
      const b = runsByKey[`${models[j]} · dense`];
      if (a && b) cmp[`dense: ${models[i]} − ${models[j]}`] = bootstrapDiff(a, b);
    }
    results.bootstrap95 = cmp;
    // τ: dense 코사인·리랭커 점수 각각
    results.tau = Object.fromEntries(
      Object.entries(runsByKey)
        .filter(([k]) => !k.endsWith('-1q'))
        .map(([k, rs]) => [k, chooseTau(rs.filter((r) => r.hit && r.topScore !== null).map((r) => r.topScore!), 0.9)]),
    );
  } else {
    // ── E2 (모델·구성 고정, 청킹만 바꿈)
    const conds: Array<[string, SetName, number]> = [
      ['a: 1200 단독', 'L1_1200', 0],
      ['b: 1200 → 부모 전부', 'L1_1200', Infinity],
      ['c: 600 + 상위 2 부모', 'L1_600', 2],
    ];
    for (const [name, set, expandTop] of conds) {
      const v = await vectors(e2Model, set);
      const rs = await runConfig(e2Model, set, e2Config as Config, v, expandTop);
      runsByKey[name] = rs;
      results.runs[`${e2Model} · ${e2Config} · ${name}`] = summarize(rs);
      const s = results.runs[`${e2Model} · ${e2Config} · ${name}`];
      console.log(`${name.padEnd(22)} R@6 ${s.recall6.toFixed(3)} Hit@6 ${s.hit6.toFixed(3)} 팩 평균 ${s.avgPackChars}자`);
    }
    const names = conds.map((c) => c[0]);
    results.bootstrap95 = {
      'b − a': bootstrapDiff(runsByKey[names[1]], runsByKey[names[0]]),
      'c − a': bootstrapDiff(runsByKey[names[2]], runsByKey[names[0]]),
    };
  }

  results.cost = { usd: +meter.usd().toFixed(4), tokens: meter.tokens };
  results.perUnit = runsByKey;
  const file = join(outDir, `${e2Model ? `e2-${e2Model}-${e2Config}` : 'e1e3'}${tag ? `-${tag}` : ''}.json`);
  writeFileSync(file, JSON.stringify(results, null, 1));
  console.log(`비용 추정 $${meter.usd().toFixed(4)} → ${file}`);
  process.exit(0);
})().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});

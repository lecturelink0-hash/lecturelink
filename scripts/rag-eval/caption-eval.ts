/**
 * 이미지 캡션 평가 (RAG 실행계획 v1.1 · 0-f)
 *
 * 골든셋 자료를 운영과 같은 추출 경로(extractFromBuffer, 이미지형)로 돌려 문항 이미지 후보(크롭)를 모으고,
 * 크롭마다 운영 캡션 콜(lib/extract/caption-image.ts)을 부른다. 비교 기준으로 운영 크롭 OCR 콜도 1번 부른다.
 *  - 원가·지연: 호출별 실제 토큰(비용 귀속 집계)
 *  - 캡션 생성률(형식 통과)·길이
 *  - 페이지 정합: 캡션으로 같은 자료의 본문 청크를 찾았을 때 크롭 페이지(±1)가 1위·3위 안에 드는 비율.
 *    캡션이 강의 내용과 이어지는가의 대리 지표다. OCR 글자로 찾은 값과 나란히 보고, 글자가 거의 없는
 *    그림(OCR 20자 미만)은 따로 센다 — 캡션이 필요한 쪽은 그쪽이다.
 *
 * 2026-10-02 PR F 착수 비교에서는 이 스크립트의 전신으로 후보 A(크롭 OCR 콜에 캡션 필드 덧붙이기)도 쟀다.
 * A 는 OCR 글자·박스를 망가뜨려 불채택했고(f-caption-results.md), 운영 코드에 남기지 않았다. 덧붙인
 * 문구는 결과 문서에 그대로 적어 두었다.
 *
 * 운영 DB 에 비용 행을 남기지 않는다(평가는 운영 비용 기록·일일 상한과 섞지 않는다 — providers.ts 와 같은
 * 원칙). SUPABASE URL 을 닿지 않는 주소로 바꿔 실행하고, 비용은 귀속 컨텍스트 집계로 센다.
 *
 *   cd <체크아웃> && NODE_USE_ENV_PROXY=1 GEMINI_VERIFY_MODEL=gemini-2.5-flash-lite \
 *     npx tsx scripts/rag-eval/caption-eval.ts --manifest <골든셋>/manifest.json \
 *     --only IM1,SL4 --out <작업 폴더>/caption-eval [--max-crops 15]
 *
 * 출력(크롭 PNG·OCR·캡션)에는 강의 원문이 들어가므로 저장소 밖에 둔다(v1.1 R3).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EmbedCache, Meter, embed } from './providers';

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};
const manifestPath = opt('--manifest');
const outDir = opt('--out');
const only = (opt('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const maxCrops = Number(opt('--max-crops', '15'));
const concurrency = Number(opt('--concurrency', '6'));
// 비용 행을 남기지 않으므로 계정 id 는 호출 인자 형식만 맞춘다(기록되지 않는다).
const USER_ID = opt('--user', '00000000-0000-0000-0000-000000000000')!;
if (!manifestPath || !outDir) {
  console.error('필수: --manifest <manifest.json> --out <폴더>');
  process.exit(1);
}
if (resolve(outDir).startsWith(process.cwd() + '/')) {
  console.error('출력이 저장소 안입니다. 강의 원문이 들어가므로 저장소 밖에 두세요.');
  process.exit(1);
}
// 운영 비용 기록에 섞지 않는다 — 닿지 않는 주소로 돌린다(recordAiCost 의 insert 는 실패만 하고 넘어간다).
process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'offline-eval';
const origError = console.error;
console.error = (...a: unknown[]) => {
  if (typeof a[0] === 'string' && a[0].startsWith('[cost-cap] insert error')) return;
  origError(...a);
};

interface Caption { imageType: string; caption: string; findings: string[] }
interface CallRec { text?: string; caption?: Caption | null; usd: number; inTok: number; outTok: number; ms: number; error?: string }
interface CropRec { key: string; idx: number; page: number; kind: string; source: 'embedded' | 'detected'; ocr: CallRec; cap: CallRec }

async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return d / Math.sqrt(na * nb);
};

(async () => {
  const imp = (rel: string) => import(pathToFileURL(join(process.cwd(), rel)).href);
  const { extractFromBuffer } = await imp('lib/ai/private-generation.ts');
  const { runOcr } = await imp('lib/ocr/engine.ts');
  const { captionImage } = await imp('lib/extract/caption-image.ts');
  const { runWithCostAttribution, attributedCostSnapshot } = await imp('lib/metrics/cost-attribution.ts');
  const cap = await imp('lib/rag/caption.ts');
  const { buildTextFirstChunks } = await imp('lib/extract/chunk.ts');

  /** 호출 하나를 독립 귀속 컨텍스트에서 돌려 그 호출의 실제 토큰·비용만 센다. */
  async function measured(fn: () => Promise<{ text?: string; caption?: Caption | null }>): Promise<CallRec> {
    return runWithCostAttribution({ uploadId: randomUUID(), userId: USER_ID }, async () => {
      const t0 = Date.now();
      try {
        const r = await fn();
        const tallies = Object.values(attributedCostSnapshot()?.byEndpoint ?? {}) as Array<{ costUsd: number; inputTokens: number; outputTokens: number }>;
        return {
          ...r,
          usd: tallies.reduce((a, t) => a + t.costUsd, 0),
          inTok: tallies.reduce((a, t) => a + t.inputTokens, 0),
          outTok: tallies.reduce((a, t) => a + t.outputTokens, 0),
          ms: Date.now() - t0,
        };
      } catch (e) {
        return { usd: 0, inTok: 0, outTok: 0, ms: Date.now() - t0, error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
      }
    });
  }

  const manifest = JSON.parse(readFileSync(manifestPath!, 'utf8')) as { materials: Array<{ key: string; file: string }> };
  const base = dirname(resolve(manifestPath!));
  const materials = manifest.materials.filter((m) => only.length === 0 || only.includes(m.key));
  mkdirSync(outDir!, { recursive: true });
  const cache = new EmbedCache(join(outDir!, 'embed-cache.json'));
  const meter = new Meter();
  const records: CropRec[] = [];
  const pageChunks: Record<string, Array<{ page: number; text: string }>> = {};

  for (const m of materials) {
    const file = isAbsolute(m.file) ? m.file : join(base, m.file);
    if (!existsSync(file)) {
      console.log(`- ${m.key}: 파일 없음`);
      continue;
    }
    const buf = readFileSync(file);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const seen: Array<{ crop: any; pageText: string; page: number }> = [];
    const t0 = Date.now();
    const result = await runWithCostAttribution({ uploadId: randomUUID(), userId: USER_ID }, () =>
      extractFromBuffer({
        buffer: ab,
        fileType: 'application/pdf',
        userIdForLog: USER_ID,
        wantsImages: true,
        maxFeatured: 10, // featuredBudget(10) — 골든셋 E5 조건(10문항)
        warnings: [],
        startOcr: (pageText: string, page: number, crop: any) => seen.push({ crop, pageText, page }),
      }),
    );
    const embedded: Set<unknown> = result.embeddedCrops ?? new Set();
    pageChunks[m.key] = buildTextFirstChunks(
      result.slides.map((s: { pageIndex: number; text: string }) => ({ pageIndex: s.pageIndex, slideText: s.text })),
    ).map((c: { pageIndex: number; text: string }) => ({ page: c.pageIndex, text: c.text }));
    const eligibleAll = seen.filter((s) => cap.captionEligible(s.crop));
    const eligible = eligibleAll.slice(0, maxCrops);
    console.log(`- ${m.key}: 크롭 ${seen.length}개(캡션 대상 ${eligibleAll.length}, 측정 ${eligible.length}) · 추출 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    const dir = join(outDir!, m.key);
    mkdirSync(dir, { recursive: true });
    const recs = await pool(eligible, concurrency, async (s, idx) => {
      const crop = s.crop;
      const ocr = await measured(async () => {
        const r = await runOcr({ png: crop.ocrPng ?? crop.png, userIdForLog: USER_ID, context: s.pageText, withBoxes: true, widthPx: crop.widthPx, heightPx: crop.heightPx });
        return { text: r.text };
      });
      const c = await measured(async () => ({ caption: (await captionImage({ png: crop.png, context: s.pageText, userIdForLog: USER_ID })).caption }));
      writeFileSync(join(dir, `${idx}.png`), Buffer.from(crop.png));
      return { key: m.key, idx, page: s.page, kind: crop.region.kind, source: embedded.has(crop) ? 'embedded' : 'detected', ocr, cap: c } as CropRec;
    });
    records.push(...recs);
    writeFileSync(join(dir, 'records.json'), JSON.stringify(recs, null, 1));
  }

  // ── 페이지 정합
  const capText = (c: Caption | null | undefined) => (c ? cap.captionChunkText(c) : '');
  const tallies: Record<string, Record<string, { top1: number; top3: number; n: number }>> = { all: {}, textless: {}, texty: {} };
  for (const key of Object.keys(pageChunks)) {
    const chunks = pageChunks[key];
    const recs = records.filter((r) => r.key === key);
    if (chunks.length === 0 || recs.length === 0) continue;
    const vChunks = await embed('voyage-4', chunks.map((c) => c.text), 'document', cache, meter);
    for (const [name, get] of [
      ['ocr', (r: CropRec) => r.ocr.text ?? ''],
      ['caption', (r: CropRec) => capText(r.cap.caption)],
    ] as const) {
      const qs = recs.map((r) => ({ r, q: get(r) })).filter((x) => x.q.trim().length > 0);
      if (qs.length === 0) continue;
      const vq = await embed('voyage-4', qs.map((x) => x.q), 'query', cache, meter);
      qs.forEach((x, i) => {
        const ranked = vChunks.map((v, j) => ({ j, s: cos(vq[i], v) })).sort((p, q) => q.s - p.s);
        const near = (j: number) => Math.abs(chunks[j].page - x.r.page) <= 1;
        const textless = (x.r.ocr.text ?? '').replace(/[^\p{L}\p{N}]/gu, '').length < 20;
        for (const g of ['all', textless ? 'textless' : 'texty']) {
          const t = (tallies[g][name] ??= { top1: 0, top3: 0, n: 0 });
          t.top1 += near(ranked[0].j) ? 1 : 0;
          t.top3 += ranked.slice(0, 3).some((p) => near(p.j)) ? 1 : 0;
          t.n += 1;
        }
      });
    }
  }
  const rate = (o?: { top1: number; top3: number; n: number }) => (o ? { top1: +(o.top1 / o.n).toFixed(3), top3: +(o.top3 / o.n).toFixed(3), n: o.n } : null);
  const n = records.length;
  const sum = (k: 'ocr' | 'cap', f: 'usd' | 'inTok' | 'outTok') => records.reduce((s, r) => s + r[k][f], 0);
  const summary = {
    generatedAt: new Date().toISOString(),
    model: process.env.GEMINI_VERIFY_MODEL ?? '(기본 검증 모델)',
    crops: n,
    bySource: { embedded: records.filter((r) => r.source === 'embedded').length, detected: records.filter((r) => r.source === 'detected').length },
    cost: {
      captionPerCropUsd: +(sum('cap', 'usd') / n).toFixed(6),
      ocrPerCropUsd: +(sum('ocr', 'usd') / n).toFixed(6),
      captionTokens: { in: Math.round(sum('cap', 'inTok') / n), out: Math.round(sum('cap', 'outTok') / n) },
    },
    latencyMs: { captionMedian: median(records.map((r) => r.cap.ms)), ocrMedian: median(records.map((r) => r.ocr.ms)) },
    captionRate: +(records.filter((r) => r.cap.caption).length / Math.max(1, n)).toFixed(3),
    captionErrors: records.filter((r) => r.cap.error).length,
    captionCharsMedian: median(records.filter((r) => r.cap.caption).map((r) => capText(r.cap.caption).length)),
    pageCoherence: Object.fromEntries(
      Object.entries(tallies).map(([g, t]) => [g, { ocr: rate(t.ocr), caption: rate(t.caption) }]),
    ),
    embedUsd: +meter.usd().toFixed(6),
  };
  writeFileSync(join(outDir!, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir!, 'records.json'), JSON.stringify(records, null, 1));
  console.log(JSON.stringify(summary, null, 2));
})().catch((e) => {
  origError(e);
  process.exit(1);
});

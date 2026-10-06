/**
 * 유형 수확 묶음 재생 실험 (RAG 실행계획 v1.1 · PR J · J2)
 *
 * on 실행에서 저장해 둔 "묶음 첫 생성 요청" 원문을 지시만 바꿔 다시 보내고, 임상 증례형 쿼터 충족·인용 통과·그림 부착을 잰다.
 * 같은 근거 팩·같은 이미지·같은 다른 지시로 비교하므로(짝지은 비교) 실행 간 잡음이 빠진다. 운영 DB·비용 기록은 건드리지 않는다.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/rag-eval/type-replay.ts --capture <capture.jsonl> --out <결과 JSON> [--samples 2]
 *
 * 변형
 *  - V0: 저장한 요청 그대로(PR I 인용 지시)
 *  - V1: 인용 지시를 칸 유형별로 바꾼 것(lib/ai/prompts/rag-cite-directive.ts 의 buildRagCiteDirective)
 * 판정(사전 기준, j-dedup-results.md 1장): V1 이 임상 쿼터 충족 +0.10 이상 AND 엄격 인용 통과율 하락 ≤ 0.05 이면 채택.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const capturePath = opt('--capture');
const outPath = opt('--out');
const samples = Number(opt('--samples', '2'));
// 본 묶음만(사전 기준: "본 묶음의 첫 생성 요청"). 본 묶음 지시는 "전체 출제 계획 N묶음 중" — N = 본 묶음 수.
const mainBatches = Number(opt('--main-batches', '0'));
// 응답 캐시(JSONL) — 중간에 끊겨도(402·429) 다시 돌리면 끝난 호출은 건너뛴다.
const cachePath = opt('--cache', `${outPath}.calls.jsonl`)!;
if (!capturePath || !outPath) {
  console.error('필수: --capture --out');
  process.exit(1);
}

const PRICE = { in: 0.3, out: 2.5 }; // gemini-2.5-flash USD/1M

(async () => {
  const root = process.cwd();
  const { isClinicalVignette } = await import(pathToFileURL(join(root, 'lib/ai/clinical-shape.ts')).href);
  const { verifyCitations } = await import(pathToFileURL(join(root, 'lib/rag/cite.ts')).href);
  const { buildRagCiteDirective, RAG_CITE_DIRECTIVE_V0 } = await import(pathToFileURL(join(root, 'lib/ai/prompts/rag-cite-directive.ts')).href);

  const lines = readFileSync(capturePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  type Batch = { body: any; partIndex: number; text: string; quotaClinical: number; quotaImage: number; size: number; chunks: Map<string, any> };
  const batches: Batch[] = [];
  for (const l of lines) {
    const parts = l.body.contents?.[0]?.parts ?? [];
    const partIndex = parts.findIndex((p: any) => typeof p.text === 'string' && p.text.includes('### 근거 자료'));
    if (partIndex < 0) continue;
    const text: string = parts[partIndex].text;
    if (!text.includes(RAG_CITE_DIRECTIVE_V0.slice(0, 40))) continue;
    if (mainBatches > 0 && Number(/전체 출제 계획 (\d+)묶음 중/.exec(text)?.[1] ?? 0) !== mainBatches) continue;
    const ev = text.slice(text.indexOf('### 근거 자료'), text.indexOf('### 출제 단위'));
    const chunks = new Map<string, any>();
    for (const m of ev.matchAll(/\[(E\d+)\] \(p\.(\d+)[^)]*\) ([\s\S]*?)(?=\n\n\[E\d+\] \(p\.|\n*$)/g)) {
      chunks.set(m[1], { ref: m[1], chunkId: m[1], pageIndex: Number(m[2]), kind: 'x', text: m[3], score: 0, rank: 0, unitId: '' });
    }
    batches.push({
      body: l.body,
      partIndex,
      text,
      quotaClinical: Number(/\*\*임상 증례형 최소 (\d+)문항\*\*/.exec(text)?.[1] ?? 0),
      quotaImage: Number(/\*\*이미지 판독 문항 최소 (\d+)문항\*\*/.exec(text)?.[1] ?? 0),
      size: Number(/(\d+)개의 의학 문항을 생성하세요/.exec(text)?.[1] ?? 2),
      chunks,
    });
  }

  const variants: Record<string, (t: string) => string> = {
    V0: (t) => t,
    V1: (t) => {
      const start = t.indexOf(RAG_CITE_DIRECTIVE_V0);
      if (start < 0) throw new Error('V0 지시를 찾지 못함');
      return t.slice(0, start) + buildRagCiteDirective('v1') + t.slice(start + RAG_CITE_DIRECTIVE_V0.length);
    },
  };

  let usd = 0;
  const done = new Map<string, any>();
  if (existsSync(cachePath)) {
    for (const line of readFileSync(cachePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      done.set(r.key, r.args);
    }
  }
  const call = async (body: any) => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
        method: 'POST',
        headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY ?? '', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const j: any = await res.json();
        const um = j.usageMetadata ?? {};
        usd += ((um.promptTokenCount ?? 0) * PRICE.in + ((um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0)) * PRICE.out) / 1e6;
        return j.candidates?.[0]?.content?.parts?.find((p: any) => p.functionCall)?.functionCall?.args ?? null;
      }
      if (res.status !== 429 && res.status < 500) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
    return null;
  };

  const per: Record<string, { quota: number; met: number; questions: number; citeOk: number; imageQuota: number; imageAttached: number; vignettes: number; calls: number; failed: number }> = {};
  for (const v of Object.keys(variants)) per[v] = { quota: 0, met: 0, questions: 0, citeOk: 0, imageQuota: 0, imageAttached: 0, vignettes: 0, calls: 0, failed: 0 };
  for (const [bi, b] of batches.entries()) {
    for (const [v, fn] of Object.entries(variants)) {
      for (let s = 0; s < samples; s += 1) {
        const key = `${bi}|${v}|${s}`;
        let args = done.get(key);
        if (args === undefined) {
          const body = JSON.parse(JSON.stringify(b.body));
          body.contents[0].parts[b.partIndex].text = fn(b.text);
          args = await call(body);
          done.set(key, args);
          appendFileSync(cachePath, JSON.stringify({ key, args }) + '\n');
        }
        const st = per[v];
        st.calls += 1;
        const qs: any[] = Array.isArray(args?.questions) ? args.questions.slice(0, b.size) : [];
        if (qs.length === 0) {
          st.failed += 1;
          continue;
        }
        const vign = qs.filter((q) => isClinicalVignette(String(q.stem ?? ''))).length;
        st.vignettes += vign;
        st.quota += b.quotaClinical;
        st.met += Math.min(vign, b.quotaClinical);
        st.questions += qs.length;
        st.citeOk += qs.filter((q) => verifyCitations(q.evidence_refs, b.chunks).ok).length;
        st.imageQuota += b.quotaImage;
        st.imageAttached += Math.min(b.quotaImage, qs.filter((q) => Array.isArray(q.image_indices) && q.image_indices.length > 0).length);
      }
    }
    process.stdout.write(`\r묶음 ${bi + 1}/${batches.length} · 추정 $${usd.toFixed(3)}`);
  }
  process.stdout.write('\n');
  const summary = Object.fromEntries(
    Object.entries(per).map(([v, s]) => [
      v,
      {
        ...s,
        clinicalMet: s.quota ? Math.round((s.met / s.quota) * 1000) / 1000 : null,
        citeStrict: s.questions ? Math.round((s.citeOk / s.questions) * 1000) / 1000 : null,
        imageMet: s.imageQuota ? Math.round((s.imageAttached / s.imageQuota) * 1000) / 1000 : null,
      },
    ]),
  );
  const d = (summary.V1.clinicalMet ?? 0) - (summary.V0.clinicalMet ?? 0);
  const citeDrop = (summary.V0.citeStrict ?? 0) - (summary.V1.citeStrict ?? 0);
  const result = {
    batches: batches.length,
    samples,
    clinicalBatches: batches.filter((b) => b.quotaClinical > 0).length,
    imageBatches: batches.filter((b) => b.quotaImage > 0).length,
    summary,
    decision: { clinicalGain: Math.round(d * 1000) / 1000, citeDrop: Math.round(citeDrop * 1000) / 1000, adoptV1: d >= 0.1 && citeDrop <= 0.05 },
    estUsd: Math.round(usd * 10000) / 10000,
  };
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 1));
})();

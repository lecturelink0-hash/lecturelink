/**
 * PR K 사람 라벨 도구 — R2 근거 지지 표본 60문항 + R3 인용 적합 100개 (RAG 실행계획 v1.1 · 6.2 · D5)
 *
 * 1) 페이지: npx tsx scripts/rag-eval/review-k.ts page --out <골든셋 결과 폴더> --on e5-on --off g0-off \
 *      --r2-cache <faithfulness 캐시.jsonl> --r3 <cite-labels 표본.json> --to <로컬 폴더>/review-k.html [--seed 20261012]
 *    R2 표본: on 30 + off 30(근거가 있는 판정분에서 자료·회차 층화 무작위). LLM 판정은 페이지에 보이지 않는다(앵커링 방지).
 *    브라우저에서 고르면 자동 저장되고, '내보내기'로 review-k-labels.json 을 받는다.
 * 2) 집계: npx tsx scripts/rag-eval/review-k.ts stats --labels <review-k-labels.json> --r2-cache <캐시.jsonl>
 *    R2 사람–LLM κ(3분류·이분류)와 사람 기준 충실도. R3 는 cite-labels.ts judge --human 으로.
 *
 * 페이지·라벨에는 강의 원문이 들어가므로 저장소 밖에 둔다(D6).
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cohenKappa, pick, rng } from './stats-util.ts';

const [mode, ...rest] = process.argv.slice(2);
const opt = (n: string, d?: string) => {
  const i = rest.indexOf(n);
  return i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[i + 1] : d;
};
type Rec = Record<string, any>;

function load(outRoot: string, label: string): Rec[] {
  const dir = join(outRoot, label);
  const out: Rec[] = [];
  for (const k of readdirSync(dir)) {
    const kd = join(dir, k);
    if (k.endsWith('.json') || !existsSync(kd)) continue;
    for (const f of readdirSync(kd)) if (/^run\d+\.json$/.test(f)) out.push(JSON.parse(readFileSync(join(kd, f), 'utf8')));
  }
  return out;
}
const readCache = (p: string) =>
  new Map<string, Rec>(
    readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
      .map((j) => [j.key, j]),
  );

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function page() {
  const outRoot = resolve(opt('--out') ?? '');
  const onLabel = opt('--on', 'e5-on')!;
  const offLabel = opt('--off', 'g0-off')!;
  const cache = readCache(opt('--r2-cache')!);
  const rand = rng(Number(opt('--seed', '20261012')));
  const r2: Rec[] = [];
  for (const label of [onLabel, offLabel]) {
    const recs = load(outRoot, label);
    const byMat = new Map<string, Rec[]>();
    for (const r of recs) {
      const chunkText = new Map<string, string>((r.chunks ?? []).map((c: Rec) => [String(c.id), String(c.text ?? '')]));
      for (const q of r.questions ?? []) {
        const key = `${label}|${r.key}|${r.run}|${q.id}`;
        const j = cache.get(key);
        if (!j || j.noEvidence) continue;
        const ids: string[] = Array.isArray(q.evidence) && q.evidence.length ? q.evidence.map((e: Rec) => String(e.chunk_id)) : (q.source_refs?.chunkIds ?? []).map(String);
        const evidence = [...new Set(ids)].map((id) => chunkText.get(id)).filter(Boolean).join('\n\n— — —\n\n').slice(0, 9000);
        (byMat.get(r.key) ?? byMat.set(r.key, []).get(r.key)!).push({ key, stem: q.stem, choices: q.choices, answer: q.answer_index, explanation: q.explanation, evidence });
      }
    }
    const mats = [...byMat.keys()].sort();
    const pools = new Map(mats.map((m) => [m, pick(byMat.get(m)!, byMat.get(m)!.length, rand)]));
    const picked: Rec[] = [];
    for (let i = 0; picked.length < 30 && mats.some((m) => pools.get(m)!.length > 0); i += 1) {
      const x = pools.get(mats[i % mats.length])!.shift();
      if (x) picked.push(x);
    }
    r2.push(...picked);
  }
  // 조건(on/off)을 섞어 보여 준다 — 어느 쪽 문항인지 모르게
  const r2Shown: Rec[] = pick(r2, r2.length, rand).map((x, i) => ({ ...x, n: i + 1 }));
  const r3 = (JSON.parse(readFileSync(opt('--r3')!, 'utf8')).samples as Rec[]).map((s, i) => ({ id: s.id, n: i + 1, quote: s.quote, chunk: s.chunkText }));
  const r3Shown = pick(r3, r3.length, rand);

  const card2 = (x: Rec) => `
<section class="card" data-kind="r2" data-key="${esc(x.key)}">
  <div class="no">R2 · ${x.n}/60</div>
  <p class="stem">${esc(String(x.stem ?? ''))}</p>
  <ol class="choices">${(x.choices ?? []).map((c: string, i: number) => `<li class="${i === x.answer ? 'ans' : ''}">${esc(String(c))}${i === x.answer ? ' <b>(정답)</b>' : ''}</li>`).join('')}</ol>
  <details><summary>해설</summary><p class="exp">${esc(String(x.explanation ?? ''))}</p></details>
  <details open><summary>근거 자료</summary><pre class="ev">${esc(x.evidence)}</pre></details>
  <div class="q">정답의 핵심 근거(정답 선지 내용·정답을 가르는 조건)가 위 근거 자료로 뒷받침되나요? 증례의 나이·성별, 그림에서 읽는 소견은 빼고 봅니다.</div>
  <div class="btns">${['지지', '부분', '미지지'].map((v) => `<button data-v="${v}">${v}</button>`).join('')}</div>
</section>`;
  const card3 = (x: Rec, i: number) => `
<section class="card" data-kind="r3" data-key="${esc(x.id)}">
  <div class="no">R3 · ${i + 1}/${r3Shown.length}</div>
  <div class="lbl">인용구</div><p class="quote">${esc(String(x.quote ?? ''))}</p>
  <details open><summary>원문 청크</summary><pre class="ev">${esc(String(x.chunk ?? '').slice(0, 4000))}</pre></details>
  <div class="q">인용구가 이 원문에서 온 구절이고 뜻이 같나요? 띄어쓰기·기호·작은 오타는 괜찮고, 이어 붙이기·바꿔 쓰기·번역은 부적합입니다.</div>
  <div class="btns">${['적합', '부적합'].map((v) => `<button data-v="${v}">${v}</button>`).join('')}</div>
</section>`;

  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PR K 라벨 검토</title>
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e4e2dc;--accent:#2f5d8a;--ok:#2e7d4f;--bad:#b3412f;--mid:#9a6b14}
@media (prefers-color-scheme: dark){:root{--bg:#141413;--fg:#ecebe6;--muted:#9b9a94;--card:#1e1e1c;--line:#34332f;--accent:#7fb0de;--ok:#6cc08f;--bad:#e2806f;--mid:#d9b25c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
header h1{font-size:16px;margin:0 auto 0 0}.tabs button,header button,header label{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:6px 10px;cursor:pointer}
.tabs button.on{border-color:var(--accent);color:var(--accent)}main{max-width:820px;margin:0 auto;padding:12px 16px 80px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:14px 0}.no{color:var(--muted);font-size:13px}
.stem{font-weight:600}.choices{padding-left:22px}.choices li.ans{color:var(--accent)}pre.ev{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;font:13px/1.55 inherit;max-height:340px;overflow:auto}
.quote{background:var(--bg);border-left:3px solid var(--accent);padding:6px 10px}.lbl{color:var(--muted);font-size:13px}.q{color:var(--muted);font-size:13px;margin-top:8px}
.btns{display:flex;gap:8px;margin-top:10px}.btns button{flex:1;font:inherit;padding:9px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer}
.btns button.sel[data-v="지지"],.btns button.sel[data-v="적합"]{background:var(--ok);color:#fff;border-color:var(--ok)}.btns button.sel[data-v="부분"]{background:var(--mid);color:#fff;border-color:var(--mid)}
.btns button.sel[data-v="미지지"],.btns button.sel[data-v="부적합"]{background:var(--bad);color:#fff;border-color:var(--bad)}#prog{color:var(--muted);font-size:13px}
.hide{display:none}details summary{cursor:pointer;color:var(--muted);font-size:13px}
</style></head><body>
<header><h1>PR K 라벨 검토</h1><span id="prog"></span>
<span class="tabs"><button id="t2" class="on">R2 근거 지지 (60)</button><button id="t3">R3 인용 적합 (${r3Shown.length})</button></span>
<button id="exp">내보내기</button><label>불러오기<input id="imp" type="file" accept="application/json" class="hide"></label></header>
<main><div id="p2">${r2Shown.map(card2).join('')}</div><div id="p3" class="hide">${r3Shown.map(card3).join('')}</div></main>
<script>
const KEY='prk-review-labels-v1';let state={r2:{},r3:{}};
try{const s=localStorage.getItem(KEY);if(s)state=JSON.parse(s)}catch(e){}
const save=()=>{try{localStorage.setItem(KEY,JSON.stringify(state))}catch(e){}};
function paint(){document.querySelectorAll('.card').forEach(c=>{const k=c.dataset.kind,key=c.dataset.key,v=state[k][key];c.querySelectorAll('.btns button').forEach(b=>b.classList.toggle('sel',b.dataset.v===v))});
const n2=Object.keys(state.r2).length,n3=Object.keys(state.r3).length;document.getElementById('prog').textContent='R2 '+n2+'/60 · R3 '+n3+'/${r3Shown.length}'}
document.addEventListener('click',e=>{const b=e.target.closest('.btns button');if(!b)return;const c=b.closest('.card');state[c.dataset.kind][c.dataset.key]=b.dataset.v;save();paint()});
const tab=(n)=>{document.getElementById('p2').classList.toggle('hide',n!==2);document.getElementById('p3').classList.toggle('hide',n!==3);document.getElementById('t2').classList.toggle('on',n===2);document.getElementById('t3').classList.toggle('on',n===3)};
document.getElementById('t2').onclick=()=>tab(2);document.getElementById('t3').onclick=()=>tab(3);
document.getElementById('exp').onclick=()=>{const out={exportedAt:new Date().toISOString(),r2:state.r2,r3:state.r3};const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,1)],{type:'application/json'}));a.download='review-k-labels.json';a.click()};
document.getElementById('imp').onchange=async e=>{const f=e.target.files[0];if(!f)return;const j=JSON.parse(await f.text());state={r2:j.r2||{},r3:j.r3||{}};save();paint()};
paint();
</script></body></html>`;
  writeFileSync(opt('--to')!, html);
  console.log(JSON.stringify({ r2: r2Shown.length, r2On: r2Shown.filter((x) => x.key.startsWith(`${onLabel}|`)).length, r3: r3Shown.length }));
}

function stats() {
  const labels = JSON.parse(readFileSync(opt('--labels')!, 'utf8'));
  const cache = readCache(opt('--r2-cache')!);
  const pairs = Object.entries<string>(labels.r2 ?? {})
    .map(([key, human]) => ({ key, human, llm: cache.get(key)?.overall as string | undefined }))
    .filter((p) => p.llm);
  const bin = (v: string) => (v === '지지' ? '지지' : '지지 아님');
  const byCond: Record<string, { n: number; humanSupported: number; llmSupported: number }> = {};
  for (const p of pairs) {
    const c = p.key.split('|')[0];
    const s = (byCond[c] ??= { n: 0, humanSupported: 0, llmSupported: 0 });
    s.n += 1;
    if (p.human === '지지') s.humanSupported += 1;
    if (p.llm === '지지') s.llmSupported += 1;
  }
  console.log(
    JSON.stringify(
      {
        r2Pairs: pairs.length,
        kappa3: cohenKappa(pairs.map((p) => p.human), pairs.map((p) => p.llm)),
        kappa2: cohenKappa(pairs.map((p) => bin(p.human)), pairs.map((p) => bin(p.llm!))),
        agreement3: pairs.length ? pairs.filter((p) => p.human === p.llm).length / pairs.length : null,
        byCondition: byCond,
        r3Labeled: Object.keys(labels.r3 ?? {}).length,
      },
      null,
      1,
    ),
  );
  // R3 사람 라벨을 cite-labels.ts judge 가 읽는 꼴로
  const r3Out = opt('--r3-to');
  if (r3Out) writeFileSync(r3Out, JSON.stringify({ labeler: 'human', labels: Object.fromEntries(Object.entries<string>(labels.r3 ?? {}).map(([id, v]) => [id, { ok: v === '적합' }])) }, null, 1));
}

if (mode === 'page') page();
else if (mode === 'stats') stats();
else {
  console.error('모드: page | stats');
  process.exit(1);
}

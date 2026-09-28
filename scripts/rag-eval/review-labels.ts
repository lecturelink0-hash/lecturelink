/**
 * R1 라벨 사람 검토 도구 (RAG 실행계획 v1.1 · 6.2 R1 "전재현이 전수 확인해 수정·삭제")
 *
 * 1) 페이지 만들기: 라벨 초안과 코퍼스로 검토용 HTML 한 장을 만든다(외부 의존 없음, 로컬에서 연다).
 *      npx tsx scripts/rag-eval/review-labels.ts page --corpus <작업>/corpus.json \
 *        --labels <작업>/labels-draft.json --out <로컬 폴더>/review.html
 *    브라우저에서 단위마다 채택·삭제를 고르고, 인용구를 청크 원문에서 드래그해 바꾸거나 근거를 더한다.
 *    진행 상황은 브라우저에 자동 저장되고, '검토본 내보내기'로 labels-reviewed.json 을 받는다.
 * 2) 검토 통계: 초안 대비 수정·삭제 비율(6.2 R1 보고 항목).
 *      npx tsx scripts/rag-eval/review-labels.ts stats --draft <초안> --reviewed <검토본>
 *
 * 페이지와 검토본에는 강의 원문이 들어가므로 저장소 밖에 둔다(v1.1 R3).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const [mode, ...rest] = process.argv.slice(2);
const opt = (n: string) => {
  const i = rest.indexOf(n);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (mode === 'stats') {
  const draft = JSON.parse(readFileSync(opt('--draft')!, 'utf8'));
  const reviewed = JSON.parse(readFileSync(opt('--reviewed')!, 'utf8'));
  const rows: string[] = [];
  let total = 0, accepted = 0, edited = 0, deleted = 0, pending = 0, factsBefore = 0, factsAfter = 0;
  for (const [key, m] of Object.entries<any>(draft.materials)) {
    const rm = reviewed.materials?.[key];
    const byId = new Map<string, any>((rm?.units ?? []).map((u: any) => [u.id, u]));
    let a = 0, e = 0, d = 0, p = 0;
    for (const u of m.units) {
      total += 1;
      factsBefore += u.facts.length;
      const r = byId.get(u.id);
      const st = r?.review?.status ?? 'pending';
      if (st === 'deleted') d += 1;
      else if (st === 'pending') p += 1;
      else if (r?.review?.edited) e += 1;
      else a += 1;
      if (st !== 'deleted' && r) factsAfter += r.facts.length;
    }
    const added = (rm?.units ?? []).filter((u: any) => !m.units.some((x: any) => x.id === u.id)).length;
    accepted += a; edited += e; deleted += d; pending += p;
    rows.push(`${key.padEnd(4)} 초안 ${String(m.units.length).padStart(2)} · 그대로 ${a} · 수정 ${e} · 삭제 ${d} · 미검토 ${p}${added ? ` · 추가 ${added}` : ''}`);
  }
  console.log(rows.join('\n'));
  const pct = (n: number) => `${((100 * n) / Math.max(1, total)).toFixed(1)}%`;
  console.log(`\n전체 ${total} · 그대로 채택 ${accepted}(${pct(accepted)}) · 수정 ${edited}(${pct(edited)}) · 삭제 ${deleted}(${pct(deleted)}) · 미검토 ${pending}`);
  console.log(`사실(근거) 수: 초안 ${factsBefore} → 검토 후 ${factsAfter}`);
  process.exit(0);
}

if (mode !== 'page') {
  console.error('사용: review-labels.ts page|stats … (파일 머리말 참고)');
  process.exit(1);
}

const corpus = JSON.parse(readFileSync(opt('--corpus')!, 'utf8'));
const labels = JSON.parse(readFileSync(opt('--labels')!, 'utf8'));
const out = opt('--out')!;

const data = {
  generatedAt: new Date().toISOString(),
  materials: corpus.materials
    .filter((m: any) => labels.materials[m.key])
    .map((m: any) => ({
      key: m.key,
      kind: m.kind,
      subject: m.subject,
      chunks: m.L1_1200.map((c: any) => ({ id: c.id, ref: `C${c.chunkIndex}`, page: c.pageIndex, text: c.text })),
      units: labels.materials[m.key].units,
    })),
};
// </script> 가 원문에 있어도 페이지가 깨지지 않게.
const payload = JSON.stringify(data).replace(/</g, '\\u003c');

const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>R1 라벨 검토</title>
<style>
:root{--bg:#fafaf8;--fg:#1d1d1b;--muted:#6b6b66;--card:#fff;--line:#e3e2dc;--accent:#2f5d8a;--ok:#2e7d4f;--warn:#a15c00;--bad:#b3261e;--hl:#fff1a8}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecebe6;--muted:#a3a29b;--card:#1f1f1d;--line:#34332f;--accent:#8ab4e0;--ok:#7ccf9a;--warn:#e0a458;--bad:#f08c84;--hl:#5a4b00}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Noto Sans KR",sans-serif}
header{position:sticky;top:0;z-index:5;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header h1{font-size:16px;margin:0 8px 0 0}header .sp{flex:1}
button,select{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:6px;padding:4px 10px;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
main{display:grid;grid-template-columns:200px 1fr;gap:16px;padding:16px;max-width:1280px;margin:0 auto}
@media (max-width:760px){main{grid-template-columns:1fr}nav{position:static!important}}
nav{position:sticky;top:64px;align-self:start}nav a{display:flex;justify-content:space-between;padding:6px 8px;border-radius:6px;color:var(--fg);text-decoration:none}nav a.on{background:var(--card);border:1px solid var(--line)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:14px}
.card.deleted{opacity:.55}.card.accepted{border-left:4px solid var(--ok)}.card.deleted{border-left:4px solid var(--bad)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.muted{color:var(--muted);font-size:12px}
.badge{font-size:12px;border-radius:999px;padding:1px 8px;border:1px solid var(--warn);color:var(--warn)}
input[type=text],textarea{width:100%;font:inherit;border:1px solid var(--line);border-radius:6px;padding:4px 8px;background:var(--bg);color:var(--fg)}
textarea{min-height:34px;resize:vertical}label.f{display:block;font-size:12px;color:var(--muted);margin-top:8px}
.fact{border:1px solid var(--line);border-radius:8px;padding:8px;margin-top:8px}
.chunk{white-space:pre-wrap;font-size:13px;max-height:160px;overflow:auto;border-top:1px dashed var(--line);margin-top:6px;padding-top:6px}
mark{background:var(--hl);color:inherit}
.status label{margin-right:10px}.sel{font-size:12px}
</style></head><body>
<header><h1>R1 라벨 검토</h1><span id="progress" class="muted"></span><span class="sp"></span>
<label class="muted"><input type="checkbox" id="onlyFlag"> 검토 우선만</label>
<label class="muted"><input type="checkbox" id="onlyPending"> 미검토만</label>
<button id="export" class="primary">검토본 내보내기</button><button id="import">불러오기</button><input type="file" id="file" accept=".json" hidden></header>
<main><nav id="nav"></nav><section id="list"></section></main>
<script>
const DATA = ${payload};
const KEY = 'r1-review-' + DATA.generatedAt;
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { state = {}; }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} renderProgress(); };
let current = DATA.materials[0]?.key;
const unitState = (u) => (state[u.id] ??= { status: 'pending', edited: false, unit: structuredClone(u) });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const norm = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\\s+/g, '');
function highlight(text, quote) {
  // 공백 차이를 무시하고 원문에서 인용구 구간을 찾아 표시한다.
  const q = norm(quote); if (!q) return esc(text);
  let map = [], flat = '';
  for (let i = 0; i < text.length; i++) { const p = text[i].normalize('NFKC').toLowerCase().replace(/\\s+/g, ''); for (const ch of p) { flat += ch; map.push(i); } }
  const at = flat.indexOf(q); if (at < 0) return esc(text) + ' <span class="badge">원문에서 인용구를 찾지 못함</span>';
  const s = map[at], e = map[at + q.length - 1] + 1;
  return esc(text.slice(0, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>' + esc(text.slice(e));
}
function chunkOf(m, id) { return m.chunks.find((c) => c.id === id); }
function renderProgress() {
  let t = 0, done = 0, del = 0; for (const m of DATA.materials) for (const u of m.units) { t++; const s = state[u.id]; if (s && s.status !== 'pending') done++; if (s?.status === 'deleted') del++; }
  document.getElementById('progress').textContent = '검토 ' + done + ' / ' + t + ' · 삭제 ' + del;
  document.getElementById('nav').innerHTML = DATA.materials.map((m) => {
    const d = m.units.filter((u) => state[u.id] && state[u.id].status !== 'pending').length;
    return '<a href="#" data-k="' + m.key + '" class="' + (m.key === current ? 'on' : '') + '"><span>' + m.key + ' <span class="muted">' + esc(m.subject || m.kind) + '</span></span><span class="muted">' + d + '/' + m.units.length + '</span></a>';
  }).join('');
}
function factHtml(m, u, fi, f, alt, ai) {
  const c = chunkOf(m, f.chunkId);
  const tag = alt ? '대체 위치' : '사실 ' + (fi + 1);
  const fixed = f.corrected ? ' <span class="badge">인용구 자동 보정</span>' : '';
  return '<div class="fact"><div class="row"><b>' + tag + '</b><span class="muted">' + esc(c?.ref) + ' · p.' + esc(c?.page) + '</span>' + fixed + '<span class="sp" style="flex:1"></span>' +
    '<button data-act="use-sel" data-u="' + u.id + '" data-f="' + fi + '" data-a="' + (alt ? ai : '') + '" class="sel">드래그한 글로 인용구 바꾸기</button>' +
    '<button data-act="del-fact" data-u="' + u.id + '" data-f="' + fi + '" data-a="' + (alt ? ai : '') + '" class="sel">빼기</button></div>' +
    '<div class="chunk" data-chunk="' + esc(f.chunkId) + '">' + highlight(c?.text || '', f.quote) + '</div></div>';
}
function render() {
  renderProgress();
  const m = DATA.materials.find((x) => x.key === current); if (!m) return;
  const onlyFlag = document.getElementById('onlyFlag').checked, onlyPending = document.getElementById('onlyPending').checked;
  const cards = m.units.map((orig) => {
    const s = unitState(orig); const u = s.unit;
    if (onlyFlag && !(orig.flags || []).length) return '';
    if (onlyPending && s.status !== 'pending') return '';
    const flags = (orig.flags || []).map((f) => '<span class="badge">' + esc(f) + '</span>').join(' ');
    const facts = u.facts.map((f, fi) => factHtml(m, u, fi, f, false) + (f.alternates || []).map((a, ai) => factHtml(m, u, fi, a, true, ai)).join('')).join('');
    const extra = (orig.crossCheck?.extraCandidates || []).map((e, ei) => { const c = chunkOf(m, e.chunkId); return '<div class="fact"><div class="row"><b>교차검증 추가 후보</b><span class="muted">' + esc(c?.ref) + ' · p.' + esc(c?.page) + '</span><span style="flex:1"></span>' +
      '<select data-act="attach" data-u="' + u.id + '" data-e="' + ei + '"><option value="">추가하기…</option><option value="new">새 사실로</option>' + u.facts.map((_, fi) => '<option value="' + fi + '">사실 ' + (fi + 1) + '의 대체 위치로</option>').join('') + '</select></div><div class="chunk">' + highlight(c?.text || '', e.quote) + '</div></div>'; }).join('');
    const opts = m.chunks.map((c) => '<option value="' + esc(c.id) + '">' + esc(c.ref) + ' p.' + c.page + ' — ' + esc(c.text.slice(0, 40)) + '</option>').join('');
    return '<div class="card ' + s.status + '" id="' + u.id + '"><div class="row"><b>' + u.id + '</b><span class="muted">' + esc(u.askKind) + '</span>' + flags + '<span style="flex:1"></span>' +
      '<span class="status"><label><input type="radio" name="st-' + u.id + '" value="accepted" ' + (s.status === 'accepted' ? 'checked' : '') + ' data-act="status" data-u="' + u.id + '"> 채택</label>' +
      '<label><input type="radio" name="st-' + u.id + '" value="deleted" ' + (s.status === 'deleted' ? 'checked' : '') + ' data-act="status" data-u="' + u.id + '"> 삭제</label>' + (s.edited ? '<span class="badge">수정함</span>' : '') + '</span></div>' +
      '<label class="f">주제</label><input type="text" data-act="edit" data-u="' + u.id + '" data-k="topic" value="' + esc(u.topic) + '">' +
      '<label class="f">학습 목표</label><input type="text" data-act="edit" data-u="' + u.id + '" data-k="objective" value="' + esc(u.objective) + '">' +
      '<label class="f">질의 — 개념</label><input type="text" data-act="edit" data-u="' + u.id + '" data-k="queries.concept" value="' + esc(u.queries.concept) + '">' +
      '<label class="f">질의 — 임상</label><input type="text" data-act="edit" data-u="' + u.id + '" data-k="queries.clinical" value="' + esc(u.queries.clinical) + '">' +
      '<label class="f">질의 — 감별</label><input type="text" data-act="edit" data-u="' + u.id + '" data-k="queries.compare" value="' + esc(u.queries.compare) + '">' +
      '<label class="f">가상 발문(HyDE)</label><textarea data-act="edit" data-u="' + u.id + '" data-k="hydeStem">' + esc(u.hydeStem) + '</textarea>' +
      '<label class="f">근거 — 문항에 꼭 필요한 사실. 인용구가 틀리면 청크 원문에서 드래그한 뒤 “드래그한 글로 인용구 바꾸기”</label>' + (facts || '<div class="muted">근거 없음 — 추가하거나 삭제하세요</div>') + extra +
      '<div class="row" style="margin-top:8px"><select data-act="pick" data-u="' + u.id + '"><option value="">다른 청크에서 근거 추가…</option>' + opts + '</select></div><div data-pickview="' + u.id + '"></div></div>';
  });
  document.getElementById('list').innerHTML = cards.join('') || '<p class="muted">해당하는 단위가 없습니다.</p>';
}
function touch(uid) { const s = state[uid]; s.edited = true; if (s.status === 'pending') s.status = 'accepted'; }
function findOrig(uid) { for (const m of DATA.materials) { const u = m.units.find((x) => x.id === uid); if (u) return [m, u]; } }
document.addEventListener('click', (ev) => {
  const t = ev.target.closest('[data-act],[data-k]'); if (!t) return;
  if (t.dataset.k && t.tagName === 'A') { ev.preventDefault(); current = t.dataset.k; render(); window.scrollTo(0, 0); return; }
  const uid = t.dataset.u; if (!uid) return; const [m, orig] = findOrig(uid); const s = unitState(orig);
  if (t.dataset.act === 'del-fact') { const fi = +t.dataset.f; if (t.dataset.a === '') s.unit.facts.splice(fi, 1); else s.unit.facts[fi].alternates.splice(+t.dataset.a, 1); touch(uid); save(); render(); }
  if (t.dataset.act === 'use-sel') {
    const sel = String(window.getSelection() || '').trim(); if (!sel) { alert('청크 원문에서 쓸 구간을 먼저 드래그하세요.'); return; }
    const fi = +t.dataset.f; const f = t.dataset.a === '' ? s.unit.facts[fi] : s.unit.facts[fi].alternates[+t.dataset.a];
    const c = chunkOf(m, f.chunkId); if (!norm(c.text).includes(norm(sel))) { alert('이 사실의 청크 원문 안에서 드래그해야 합니다.'); return; }
    f.quote = sel; f.corrected = false; touch(uid); save(); render();
  }
  if (t.dataset.act === 'add-sel') {
    const sel = String(window.getSelection() || '').trim(); const cid = t.dataset.c; const c = chunkOf(m, cid);
    if (!sel || !norm(c.text).includes(norm(sel))) { alert('아래 청크 원문에서 근거 구간을 드래그하세요.'); return; }
    const item = { chunkId: cid, chunkRef: c.ref, pageIndex: c.page, quote: sel, corrected: false, alternates: [] };
    const target = t.dataset.to; if (target === 'new') s.unit.facts.push(item); else s.unit.facts[+target].alternates.push(item);
    touch(uid); save(); render();
  }
});
document.addEventListener('change', (ev) => {
  const t = ev.target; const uid = t.dataset?.u; if (!uid) return; const [m, orig] = findOrig(uid); const s = unitState(orig);
  if (t.dataset.act === 'status') { s.status = t.value; save(); render(); }
  if (t.dataset.act === 'edit') { const k = t.dataset.k.split('.'); let o = s.unit; for (let i = 0; i < k.length - 1; i++) o = o[k[i]]; o[k.at(-1)] = t.value; touch(uid); save(); }
  if (t.dataset.act === 'attach' && t.value) { const e = orig.crossCheck.extraCandidates[+t.dataset.e]; const item = { chunkId: e.chunkId, chunkRef: e.chunkRef, pageIndex: e.pageIndex, quote: e.quote, corrected: !!e.corrected, alternates: [] };
    if (t.value === 'new') s.unit.facts.push(item); else s.unit.facts[+t.value].alternates.push(item); touch(uid); save(); render(); }
  if (t.dataset.act === 'pick') { const view = document.querySelector('[data-pickview="' + uid + '"]'); const c = chunkOf(m, t.value); if (!c) { view.innerHTML = ''; return; }
    view.innerHTML = '<div class="fact"><div class="row"><b>' + esc(c.ref) + '</b><span class="muted">p.' + c.page + ' — 근거 구간을 드래그한 뒤 추가</span><span style="flex:1"></span>' +
      '<button class="sel" data-act="add-sel" data-u="' + uid + '" data-c="' + esc(c.id) + '" data-to="new">새 사실로 추가</button>' + s.unit.facts.map((_, fi) => '<button class="sel" data-act="add-sel" data-u="' + uid + '" data-c="' + esc(c.id) + '" data-to="' + fi + '">사실 ' + (fi + 1) + ' 대체 위치로</button>').join('') + '</div><div class="chunk">' + esc(c.text) + '</div></div>'; }
});
['onlyFlag', 'onlyPending'].forEach((id) => document.getElementById(id).addEventListener('change', render));
document.getElementById('export').onclick = () => {
  const out = { reviewer: '전재현', exportedAt: new Date().toISOString(), sourceGeneratedAt: DATA.generatedAt, materials: {} };
  for (const m of DATA.materials) out.materials[m.key] = { units: m.units.map((u) => { const s = state[u.id]; const unit = s ? s.unit : u; return { ...unit, review: { status: s?.status || 'pending', edited: !!s?.edited } }; }) };
  const blob = new Blob([JSON.stringify(out, null, 1)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'labels-reviewed.json'; a.click();
};
document.getElementById('import').onclick = () => document.getElementById('file').click();
document.getElementById('file').onchange = async (ev) => { const f = ev.target.files[0]; if (!f) return; const j = JSON.parse(await f.text());
  for (const m of Object.values(j.materials || {})) for (const u of m.units || []) state[u.id] = { status: u.review?.status || 'pending', edited: !!u.review?.edited, unit: u };
  save(); render(); };
render();
</script></body></html>`;

writeFileSync(out, html);
console.log(`검토 페이지 → ${out} (단위 ${data.materials.reduce((a: number, m: any) => a + m.units.length, 0)}개)`);

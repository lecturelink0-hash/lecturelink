/**
 * 단위 검색·근거 팩 검사 (npm run check:rag-pack · RAG 실행계획 v1.1 5.2 E·F · PR H)
 *
 * 1) lib/rag/pack.ts — 팩 크기·글자 상한·잘라 담기, [E1] 표기, MMR, 단위 검색(충분성·캡션 청크 제외·그림 일치),
 *    근거 부족(D3) 교체·이미지 칸 넘김·빈 칸, 진단 통계, 벡터 읽기
 * 2) 소스 대조 — 검색은 shadow·on 에서 계획·인덱싱이 끝난 뒤에만, 생성은 기다리지 않고 진단 직전에 상한을 두고 합류,
 *    질의 임베딩 비용(rag.query)을 원가에 더함, 낡은 벡터 제외, 진단에 강의 문구 없음
 *
 *   node --experimental-strip-types --no-warnings scripts/check-rag-pack.mjs
 */
import { readFileSync } from 'node:fs';
import {
  packSizeFor,
  buildPack,
  formatPack,
  mmrOrder,
  retrieveUnit,
  replaceInsufficient,
  retrievalStats,
  parseVector,
  PACK_LIMITS,
} from '../lib/rag/pack.ts';
import { RAG_DEFAULTS } from '../lib/rag/mode.ts';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
console.log('[check:rag-pack]');

// ── 크기·상한
check('팩 크기: 기본 6·4,500자, 상 8·6,000자', JSON.stringify(packSizeFor('중')) === '{"size":6,"chars":4500}' && JSON.stringify(packSizeFor('상')) === '{"size":8,"chars":6000}' && JSON.stringify(packSizeFor(null)) === '{"size":6,"chars":4500}');
check('팩 상수는 RAG_DEFAULTS 와 같음', PACK_LIMITS.size === RAG_DEFAULTS.packSize && PACK_LIMITS.chars === RAG_DEFAULTS.packChars && PACK_LIMITS.candidateK === RAG_DEFAULTS.candidateK);

const mk = (id, len, page = 1, kind = 'slide_text') => ({ id, pageIndex: page, kind, text: 'x'.repeat(len), score: 0.7 });
const p1 = buildPack([mk('a', 100), mk('b', 100), mk('c', 100)], 2, 10_000);
check('조립: 개수 상한·E1·E2', p1.length === 2 && p1.map((e) => e.ref).join() === 'E1,E2' && p1.every((e) => !e.truncated));
const p2 = buildPack([mk('a', 1000), mk('b', 1000), mk('c', 1000)], 6, 2500);
check('조립: 글자 상한에서 잘라 담고 멈춤', p2.length === 3 && p2[2].truncated && p2.reduce((s, e) => s + e.text.length, 0) <= 2500 && p2[2].text.endsWith('…'), JSON.stringify(p2.map((e) => e.text.length)));
const p3 = buildPack([mk('a', 1000), mk('b', 1000)], 6, 1100);
check('조립: 남은 글자가 꼬리 하한 미만이면 담지 않음', p3.length === 1 && !p3[0].truncated);
check('조립: 빈 입력', buildPack([], 6, 4500).length === 0);
const f = formatPack([
  { ref: 'E1', chunkId: 'a', pageIndex: 3, kind: 'slide_text', score: 0.7, text: '본문', truncated: false },
  { ref: 'E2', chunkId: 'b', pageIndex: 4, kind: 'ocr', score: 0.6, text: '글자', truncated: false },
]);
check('표기: [E1] (p.3) · OCR 은 출처 표시', f === '[E1] (p.3) 본문\n\n[E2] (p.4, 그림 속 글자(OCR)) 글자', f);

// ── MMR
const vec = { a: [1, 0, 0], a2: [0.99, 0.14, 0], b: [0, 1, 0] };
const rel = new Map([['a', 0.9], ['a2', 0.89], ['b', 0.6]]);
const order = mmrOrder(['a', 'a2', 'b'], rel, (id) => vec[id], 0.7, 2);
check('MMR: 거의 같은 청크 대신 다른 청크를 고름', order.join() === 'a,b', order.join());
check('MMR: λ=1 이면 관련도 순', mmrOrder(['a', 'a2', 'b'], rel, (id) => vec[id], 1, 3).join() === 'a,a2,b');

// ── 단위 검색
const chunks = [
  { id: 'c1', chunkIndex: 0, pageIndex: 1, kind: 'slide_text', modality: 'text', text: '가'.repeat(300), vec: [1, 0, 0, 0] },
  { id: 'c2', chunkIndex: 1, pageIndex: 2, kind: 'slide_text', modality: 'text', text: '나'.repeat(300), vec: [0.98, 0.2, 0, 0] },
  { id: 'c3', chunkIndex: 2, pageIndex: 3, kind: 'ocr', modality: 'ocr', text: '다'.repeat(300), vec: [0, 1, 0, 0] },
  { id: 'cap', chunkIndex: 3, pageIndex: 3, kind: 'image_caption', modality: 'image_caption', text: '[이미지: 해부도] 위', vec: [0.995, 0.1, 0, 0], imageId: 'IMG1' },
];
const q = [[1, 0, 0, 0], [0.9, 0.1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
const r = retrieveUnit('u1', q, chunks, { tau: 0.47, size: 3, chars: 4500 });
check('검색: 최고 유사도·충분성', Math.abs(r.topScore - 1) < 1e-9 && r.sufficient);
check('검색: 캡션 청크는 팩·후보에 넣지 않음', !r.ranked.includes('cap') && r.pack.every((e) => e.chunkId !== 'cap'));
check('검색: 텍스트 단위는 그림 판정 없음', r.captionScore === null && r.captionMatch === null);
const rImg = retrieveUnit('u2', q, chunks, { tau: 0.47, size: 3, chars: 4500, figureImageIds: ['IMG1'] });
check('검색: 이미지 단위는 그 그림 캡션과 비교', rImg.captionScore !== null && rImg.captionScore > 0.99 && rImg.captionMatch === true);
const rImgMiss = retrieveUnit('u3', q, chunks, { tau: 0.47, size: 3, chars: 4500, figureImageIds: ['NOPE'] });
check('검색: 캡션 청크를 못 찾으면 그림 불일치', rImgMiss.captionScore === null && rImgMiss.captionMatch === false);
const rLow = retrieveUnit('u4', [[0, 0, 1, 0]], chunks, { tau: 0.47, size: 3, chars: 4500 });
check('검색: τ 미만이면 근거 부족', rLow.topScore < 0.47 && !rLow.sufficient);
const nz = (v) => { const m = Math.hypot(...v); return v.map((x) => x / m); };
const mmrChunks = [
  { id: 'm1', chunkIndex: 0, pageIndex: 1, kind: 'slide_text', modality: 'text', text: 'a'.repeat(300), vec: nz([1, 0, 0]) },
  { id: 'm2', chunkIndex: 1, pageIndex: 2, kind: 'slide_text', modality: 'text', text: 'b'.repeat(300), vec: nz([1, 0.05, 0]) },
  { id: 'm3', chunkIndex: 2, pageIndex: 3, kind: 'slide_text', modality: 'text', text: 'c'.repeat(300), vec: nz([0, 0, 1]) },
];
const qm = [nz([1, 0, 0.7])];
const rMmr = retrieveUnit('u5', qm, mmrChunks, { tau: 0.47, size: 2, chars: 4500 });
const rNo = retrieveUnit('u5', qm, mmrChunks, { tau: 0.47, size: 2, chars: 4500, mmr: false });
check('검색: MMR 기본 켜짐(거의 같은 m2 대신 m3) · mmr:false 는 RRF 순서', rMmr.pack.map((e) => e.chunkId).join() === 'm1,m3' && rNo.pack.map((e) => e.chunkId).join() === 'm1,m2', `${rMmr.pack.map((e) => e.chunkId)} / ${rNo.pack.map((e) => e.chunkId)}`);

// ── 근거 부족(D3) 교체
const unit = (id, askKinds, needsImage = false) => ({ id, topic: id, objective: '', askKinds, needsImage, figures: needsImage ? ['F1'] : [], pages: [], queries: { concept: id, clinical: id, compare: id }, hydeStem: id });
const units = [unit('a', ['diagnosis']), unit('b', ['definition']), unit('i', ['image_finding'], true), unit('r1', ['treatment']), unit('r2', ['mechanism']), unit('ri', ['image_diagnosis'], true)];
const ret = (id, sufficient, captionMatch = null) => [id, { unitId: id, sufficient, captionMatch, topScore: sufficient ? 0.7 : 0.3 }];
const slots = [
  { batch: 0, type: 'clinical', unitId: 'a', fit: true },
  { batch: 0, type: 'knowledge', unitId: 'b', fit: true },
  { batch: 1, type: 'image', unitId: 'i', fit: true },
];
const res1 = replaceInsufficient(slots, units, new Map([ret('a', false), ret('b', true), ret('i', true, true), ret('r1', true), ret('r2', true), ret('ri', true, true)]));
check('D3: 근거 부족 단위를 유형 맞는 예비로', res1.slots[0].unitId === 'r1' && res1.slots[0].fit && res1.replaced === 1 && res1.shortfall === 0);
check('D3: 충분한 칸은 그대로', res1.slots[1].unitId === 'b' && res1.slots[2].unitId === 'i');
const res2 = replaceInsufficient(slots, units, new Map([ret('a', true), ret('b', true), ret('i', true, false), ret('r1', true), ret('r2', true), ret('ri', true, true)]));
check('D3: 그림 불일치 이미지 단위는 다른 이미지 예비로', res2.slots[2].unitId === 'ri' && res2.slots[2].type === 'image' && res2.imageSpilled === 0);
const res3 = replaceInsufficient(slots, units, new Map([ret('a', true), ret('b', true), ret('i', true, false), ret('r1', true), ret('r2', true), ret('ri', false, false)]));
check('D3: 이미지 예비도 없으면 텍스트 몫으로 넘기고 지금 단위 유지', res3.slots[2].type === 'free' && res3.slots[2].unitId === 'i' && res3.imageSpilled === 1 && res3.shortfall === 0);
const res4 = replaceInsufficient(slots, units, new Map([ret('a', false), ret('b', false), ret('i', false, false), ret('r1', false), ret('r2', true), ret('ri', false, false)]));
check('D3: 예비가 모자라면 빈 칸(shortfall)', res4.shortfall === 2 && res4.replaced === 1 && res4.slots.filter((s) => s.unitId === null).length === 2, JSON.stringify(res4));
check('D3: 입력 칸 배열을 바꾸지 않음', slots[0].unitId === 'a' && slots[2].type === 'image');

// ── 통계·벡터
const st = retrievalStats([r, rImg, rLow]);
check('통계: 수치만', Object.values(st).every((v) => typeof v === 'number'), JSON.stringify(st));
check('통계: 충분·그림 일치 수', st.units === 3 && st.sufficient === 2 && st.imageUnits === 1 && st.imageCaptionMatch === 1);
check('벡터 읽기: 문자열·배열·깨진 값', JSON.stringify(parseVector('[0.5,-1]')) === '[0.5,-1]' && JSON.stringify(parseVector([1, 2])) === '[1,2]' && parseVector('[0.5,') === null && parseVector(null) === null);

// ── 소스 대조
const pg = readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8');
check('PG: 검색은 계획과 인덱싱이 둘 다 끝난 뒤', /ragRetrievalPromise = Promise\.all\(\[indexP, ragPlanPromise\]\)\.then\(/.test(pg));
const iPlanBlock = pg.indexOf('if (ragIndexingEnabled(RAG_MODE)) {\n      ragPlanPromise = runPlan(');
const iRet = pg.indexOf('ragRetrievalPromise = Promise.all(');
check('PG: 검색 시작은 shadow·on 계획 블록 안 한 곳', iPlanBlock > 0 && iRet > iPlanBlock && (pg.match(/runRetrieval\(/g) ?? []).length === 1);
// shadow 는 생성 경로에서 검색을 기다리지 않는다. on(PR I)만 근거 합류 블록에서 상한(RAG_ON_WAIT_MS)을 두고 기다린다.
check(
  'PG: 생성 경로는 on 근거 합류에서만 검색을 기다림(상한 있음)',
  (pg.match(/await settleRetrieval\(ragRetrievalPromise/g) ?? []).length === 1 &&
    !/await ragRetrievalPromise/.test(pg) &&
    (pg.match(/withDeadline<RetrievalRun \| null>\(ragRetrievalPromise, RAG_ON_WAIT_MS/g) ?? []).length === 1 &&
    /if \(ragOn\) \{[\s\S]{0,400}withDeadline<RetrievalRun \| null>\(ragRetrievalPromise/.test(pg),
);
check('PG: 상한을 두고 합류·비용을 원가에', /ragRetrievalDiag = await settleRetrieval\(ragRetrievalPromise, RAG_RETRIEVAL_WAIT_MS\);\s*(\/\/[^\n]*\n\s*)*totalCost \+= ragRetrievalDiag\.costUsd;/.test(pg));
check('PG: 진단에 rag.retrieval', /\.\.\.\(ragRetrievalDiag \? \{ retrieval: ragRetrievalDiag \} : \{\}\)/.test(pg));
check('PG: 그림 id 는 캡션 청크와 같은 계산', /imageIdOf: \(key\) => materialImageId\(uploadRow\.id, key\)/.test(pg) && /imageKey: c\.imageKey/.test(pg));

const rt = readFileSync(new URL('../lib/rag/retrieve.ts', import.meta.url), 'utf8');
check('검색: 질의 임베딩 비용 rag.query·query 타입', /endpoint: 'rag\.query'/.test(rt) && /inputType: 'query'/.test(rt));
check('검색: 내용이 바뀐 낡은 벡터 제외', /if \(r\.embedding_sha !== r\.content_sha\) continue;/.test(rt));
check('검색: 같은 모델 벡터만', /\.eq\('embedding_model', model\)/.test(rt));
check('검색: τ 는 RAG_DEFAULTS', /tau: RAG_DEFAULTS\.tau,/.test(rt));
check('검색: 던지지 않음(try/catch)', /export async function runRetrieval[\s\S]*try \{[\s\S]*\} catch \(e\) \{/.test(rt));
check('검색: 인덱싱 실패면 검색 안 함', /if \(!args\.index \|\| args\.index\.unsupported \|\| args\.index\.error\) return fail\(\{ skipped: 'index' \}\);/.test(rt));
check('진단: 문구 대신 수치', /stats: retrievalStats\(retrievals\)/.test(rt) && !/\btext:|topic:|hydeStem:/.test(rt.slice(rt.indexOf('export interface RetrievalDiag'), rt.indexOf('export interface RetrievalRun'))));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

/**
 * 세트 중복·근거 부족·검색 스냅샷 검사 (npm run check:rag-dedup · RAG 실행계획 v1.1 5.2 J·K·D3 · PR J)
 *
 * 1) lib/rag/dedup.ts — 임베딩 입력, 세트 안 중복(slot 순·사슬·임계 경계), G1 중복률
 * 2) lib/rag/evidence.ts — 근거 부족 칸 쿼터 줄이기, 쿼터 펴기, 보충 칸의 예비 단위 고르기(유형·근거·그림 일치·재사용 금지)
 * 3) 알림 — insufficient_evidence 와 shortfall 의 몫 나누기, 화면 문구
 * 4) lib/rag/mode.ts — source_refs.retrieval 스냅샷
 * 5) 소스 대조 — 중복 검사는 shadow·on 에서만(off 비용 0), 삭제는 on 에서만, 저장 뒤·보충 라운드마다,
 *    임베딩 비용 rag.question·원가 반영, D3 칸은 on 블록에서만 정하고 생성·보충에서 빠짐, 유형 목표는 남은 칸 기준
 *
 *   node --experimental-strip-types --no-warnings scripts/check-rag-dedup.mjs
 */
import { readFileSync } from 'node:fs';
import {
  DEDUP_DEFAULTS,
  questionEmbeddingText,
  findWithinSetDuplicates,
  duplicateRate,
  cosineUnit,
} from '../lib/rag/dedup.ts';
import { reduceQuota, expandQuota, backfillSlotInputs, assignImageSlots } from '../lib/rag/evidence.ts';
import { buildUploadNotices } from '../lib/ai/upload-notice.ts';
import { retrievalRefSnapshot, RAG_DEFAULTS } from '../lib/rag/mode.ts';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
console.log('[check:rag-dedup]');

// ── 1) 중복
const q = { stem: '진단은?', choices: ['천식', '폐렴', '기흉', '결핵', '폐암'], answer_index: 2 };
check('임베딩 입력: 발문 / 발문+정답 / 발문+선지', questionEmbeddingText(q, 'stem') === '진단은?' && questionEmbeddingText(q, 'stem_answer') === '진단은?\n정답: 기흉' && questionEmbeddingText(q, 'stem_choices') === '진단은?\n선지: 천식 | 폐렴 | 기흉 | 결핵 | 폐암');
check('임베딩 입력 기본값 = DEDUP_DEFAULTS.input', questionEmbeddingText(q) === questionEmbeddingText(q, DEDUP_DEFAULTS.input));
check('G1 정의 임계는 0.92 고정(계획서 7장)', DEDUP_DEFAULTS.g1Threshold === 0.92);
check('폐기 임계는 0.85~0.98 (J1 규칙 범위)', DEDUP_DEFAULTS.threshold >= 0.85 && DEDUP_DEFAULTS.threshold <= 0.98, String(DEDUP_DEFAULTS.threshold));
const unit = (deg) => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];
check('코사인(단위 벡터)', Math.abs(cosineUnit(unit(0), unit(60)) - 0.5) < 1e-9);
const th = 0.9;
const items = [
  { id: 'c', slot: 2, vec: unit(20) }, // b 와 10도(0.985), a 와 20도(0.94)
  { id: 'a', slot: 0, vec: unit(0) },
  { id: 'b', slot: 1, vec: unit(10) }, // a 와 10도
  { id: 'd', slot: 3, vec: unit(80) }, // 멀다
];
const hits = findWithinSetDuplicates(items, th);
check('세트 안: 앞 문항을 남기고 뒤 문항을 중복으로(slot 순)', hits.map((h) => h.id).join() === 'b,c' && hits.every((h) => h.of === 'a' && h.scope === 'within'), JSON.stringify(hits));
const chain = findWithinSetDuplicates([
  { id: 'a', slot: 0, vec: unit(0) },
  { id: 'b', slot: 1, vec: unit(20) }, // a 와 0.940
  { id: 'c', slot: 2, vec: unit(40) }, // b 와 0.940, a 와 0.766
], th);
check('사슬: 지운 문항(b)은 기준에서 빠져 c 는 a 와만 비교', chain.map((h) => h.id).join() === 'b', JSON.stringify(chain));
const edge = findWithinSetDuplicates([{ id: 'a', slot: 0, vec: [1, 0] }, { id: 'b', slot: 1, vec: [0.9, Math.sqrt(1 - 0.81)] }], 0.9);
check('임계와 같으면 중복', edge.length === 1);
check('같은 slot 이면 id 순으로 안정', findWithinSetDuplicates([{ id: 'y', slot: 0, vec: [1, 0] }, { id: 'x', slot: 0, vec: [1, 0] }], 0.9)[0]?.id === 'y');
const rate = duplicateRate(items, th);
check('G1 중복률 = 앞 문항과 임계 이상인 문항 / 전체', rate.duplicates === 2 && rate.questions === 4 && rate.rate === 0.5, JSON.stringify(rate));
check('빈 세트 중복률 null', duplicateRate([], th).rate === null);

// ── 2) 근거 부족·보충
check('쿼터 줄이기: 빠진 칸 유형부터', JSON.stringify(reduceQuota({ image: 0, knowledge: 1, clinical: 1, free: 0 }, ['clinical'])) === JSON.stringify({ image: 0, knowledge: 1, clinical: 0, free: 0 }));
check('쿼터 줄이기: 그 유형이 0 이면 free → 지식 순', JSON.stringify(reduceQuota({ image: 0, knowledge: 1, clinical: 1, free: 0 }, ['image'])) === JSON.stringify({ image: 0, knowledge: 0, clinical: 1, free: 0 }));
check('쿼터 줄이기: 합 = 남은 칸', Object.values(reduceQuota({ image: 1, knowledge: 1, clinical: 0, free: 0 }, ['free', 'free'])).reduce((a, b) => a + b, 0) === 0);
check('쿼터 펴기: 이미지 → 임상 → 지식 → free', expandQuota({ image: 1, knowledge: 1, clinical: 2, free: 1 }).join() === 'image,clinical,clinical,knowledge,free');
const U = (id, askKinds, needsImage = false) => ({ id, topic: id, objective: '', askKinds, needsImage, figures: needsImage ? ['F1'] : [], pages: [], queries: { concept: '', clinical: '', compare: '' }, hydeStem: '' });
const R = (unitId, sufficient = true, captionMatch = null) => ({ unitId, topScore: 0.6, sufficient, ranked: [], pack: [{ ref: 'x', chunkId: `c-${unitId}`, pageIndex: 1, kind: 'slide_text', score: 0.6, text: 't', truncated: false }], packChars: 1, captionScore: null, captionMatch });
const units = new Map([
  ['K1', U('K1', ['definition'])],
  ['C1', U('C1', ['diagnosis'])],
  ['C2', U('C2', ['treatment'])],
  ['CX', U('CX', ['diagnosis'])],
  ['I1', U('I1', ['image_finding'], true)],
]);
const retr = new Map([['K1', R('K1')], ['C1', R('C1')], ['C2', R('C2')], ['CX', R('CX', false)], ['I1', R('I1', true, false)]]);
const used = new Set();
const pick = backfillSlotInputs({
  slots: [4, 5, 6],
  wanted: ['clinical', 'clinical', 'image'],
  slotUnit: new Map([[4, 'K1'], [5, 'C1'], [6, 'K1']]),
  reserve: ['CX', 'C2', 'I1'],
  used,
  units,
  retrievals: retr,
});
check('보충: 원래 단위가 유형에 안 맞으면 근거 충분한 맞는 예비(CX 는 근거 부족이라 건너뜀)', pick[0].unit.id === 'C2' && pick[0].fromReserve && pick[0].type === 'clinical', JSON.stringify(pick.map((p) => p.unit?.id)));
check('보충: 원래 단위가 맞으면 그대로', pick[1].unit.id === 'C1' && !pick[1].fromReserve);
check('보충: 이미지 칸은 그림 일치가 없는 예비를 쓰지 않음 → 원래 단위', pick[2].unit.id === 'K1' && !pick[2].fromReserve);
const again = backfillSlotInputs({ slots: [7], wanted: ['clinical'], slotUnit: new Map([[7, 'K1']]), reserve: ['C2'], used, units, retrievals: retr });
check('보충: 한 번 쓴 예비는 다시 쓰지 않음', again[0].unit.id === 'K1' && used.has('C2'));
check('보충: free 칸은 원래 단위', backfillSlotInputs({ slots: [1], wanted: [], slotUnit: new Map([[1, 'K1']]), reserve: ['C1'], used: new Set(), units, retrievals: retr })[0].unit.id === 'K1');

// 이미지 칸 다시 고르기
const IU = (id, figs) => ({ ...U(id, ['image_finding'], true), figures: figs });
const iunits = new Map([['A', IU('A', ['F1'])], ['B', IU('B', ['F1'])], ['C', IU('C', ['F2'])], ['D', IU('D', ['F3'])], ['K', U('K', ['definition'])]]);
const iretr = new Map([['A', R('A', true, true)], ['B', R('B', true, true)], ['C', R('C', true, true)], ['D', R('D', true, true)], ['K', R('K')]]);
const iused = new Set();
const img = assignImageSlots({
  slots: [{ type: 'image', unitId: 'A' }, { type: 'image', unitId: 'B' }, { type: 'knowledge', unitId: 'K' }, { type: 'image', unitId: 'B' }],
  units: iunits,
  retrievals: iretr,
  reserve: ['D', 'C'],
  used: iused,
  figureGi: new Map([['F1', 1], ['F2', 2], ['F3', 3]]),
  usableGis: new Set([1, 2]), // F3(gi 3)은 정제 탈락
});
check('이미지 칸: 쓸 수 있는 새 그림이면 그대로(A→F1)', img.slots[0].unitId === 'A' && img.slots[0].type === 'image');
check('이미지 칸: 같은 그림이면 쓸 수 있는 그림의 예비로(B→C, D 는 그림 탈락이라 건너뜀)', img.slots[1].unitId === 'C' && iused.has('C') && !iused.has('D'), JSON.stringify(img.slots));
check('이미지 칸: 고를 게 없으면 텍스트 몫(free)으로, 단위는 그대로', img.slots[3].type === 'free' && img.slots[3].unitId === 'B');
check('이미지 칸: 이미지 아닌 칸은 그대로', img.slots[2].unitId === 'K' && img.slots[2].type === 'knowledge');
check('이미지 칸: 집계', img.kept === 1 && img.replaced === 1 && img.spilled === 1, JSON.stringify(img));

// ── 3) 알림
const base = { desiredCount: 10, wantsImages: false, featuredImageCount: 0, truncatedChars: 0, referenceSkipped: 0, batchFailureReasons: [], leakageDiscarded: 0, verifyRejected: 0 };
const n1 = buildUploadNotices({ ...base, savedCount: 8, insufficientEvidence: 2 });
check('근거 부족 2 + 저장 8 → insufficient_evidence 만(shortfall 없음)', n1.length === 1 && n1[0].code === 'insufficient_evidence' && n1[0].count === 2, JSON.stringify(n1));
const n2 = buildUploadNotices({ ...base, savedCount: 7, insufficientEvidence: 2 });
check('근거 부족 2 + 저장 7 → insufficient_evidence 2 + shortfall 1', n2.map((n) => `${n.code}:${n.count}`).join() === 'insufficient_evidence:2,shortfall:1', JSON.stringify(n2));
const n3 = buildUploadNotices({ ...base, savedCount: 10, insufficientEvidence: 0 });
check('근거 부족 0 이면 알림 없음', n3.length === 0);
check('근거 부족 수는 실제 모자란 수를 넘지 않음', buildUploadNotices({ ...base, savedCount: 9, insufficientEvidence: 3 })[0].count === 1);
const notes = readFileSync(new URL('../app/(app)/notes/page.tsx', import.meta.url), 'utf8');
check('화면 문구: insufficient_evidence', /insufficient_evidence: \(n\) => `자료에서 근거를 찾지 못해 \$\{n\.count \?\? 0\}문항은 만들지 않았어요\.`/.test(notes));

// ── 4) 검색 스냅샷
const snap = retrievalRefSnapshot(8, { PRIVATE_RAG_MODE: 'on' });
check('source_refs.retrieval = {embed, k, fusion, reranker, topN, mmr, tau}', snap.embed === RAG_DEFAULTS.embedModel && snap.k === RAG_DEFAULTS.candidateK && snap.fusion === 'rrf' && snap.reranker === null && snap.topN === 8 && snap.mmr === RAG_DEFAULTS.mmrLambda && snap.tau === RAG_DEFAULTS.tau, JSON.stringify(snap));

// ── 5) 소스 대조
const pg = readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8');
const count = (re) => (pg.match(re) ?? []).length;
const body = pg.slice(pg.indexOf('const enforceSetDuplicates = async'), pg.indexOf('await enforceSetDuplicates();'));
check('PG: 중복 검사는 shadow·on 에서만(off 는 임베딩도 안 함)', /if \(!ragIndexingEnabled\(RAG_MODE\) \|\| !questionEmbeddingColumnsSupported\) return;/.test(body));
check('PG: 삭제는 on 에서만', /if \(ragOn && hits\.length > 0\) \{[\s\S]{0,200}\.delete\(\)\.in\('id', ids\)/.test(body) && count(/\.delete\(\)\.in\('id', ids\)/g) === 1);
check('PG: 임베딩 비용 rag.question·원가 반영·문항 임베딩 저장', /endpoint: 'rag\.question'/.test(body) && /totalCost \+= emb\.costUsd;/.test(body) && /update\(\{ embedding: emb\.embeddings\[i\], embedding_model: dedupModel \}\)/.test(body));
check('PG: 세트 간은 같은 자료·이번 업로드 제외·폐기 임계', /p_content_sha: contentSha256/.test(body) && /p_exclude_upload: uploadRow\.id/.test(body) && /p_threshold: DEDUP_DEFAULTS\.threshold/.test(body));
check('PG: 저장 뒤 한 번 + 보충 라운드마다', count(/await enforceSetDuplicates\(\);/g) === 2 && /await enforceMarkerQuestionCap\(\);\s*\/\/[^\n]*\n\s*await enforceSetDuplicates\(\);/.test(pg));
check('PG: 진단에 G1 중복률(남은 세트 기준)', /dedupDiag\.g1 = duplicateRate\(remaining, DEDUP_DEFAULTS\.g1Threshold\);/.test(body));
check('PG: 근거 부족 칸은 on 블록에서만 정함', count(/ragSkipSlots = skip;/g) === 1 && /if \(ragOn\) \{[\s\S]{0,6000}ragSkipSlots = skip;/.test(pg));
check('PG: 칸이 전부 근거 부족이면 현행 경로로', /if \(skip\.size >= desiredCount\) \{[\s\S]{0,300}'no_sufficient_units'/.test(pg));
check('PG: 본 묶음은 근거 부족 칸을 빼고, 쿼터도 줄임', /\.filter\(\(sl\) => !ragSkipSlots\.has\(sl\)\); \/\/ 근거 부족\(D3\)/.test(pg) && /plannedQuota: reduceQuota\(quotaFor\(batchIndex\), skippedTypes\)/.test(pg));
check('PG: 보충은 근거 부족 칸을 채우지 않고 만들 수 기준으로 돈다', /saved\.length < deliverableCount; round\+\+/.test(pg) && /\(s\) => !usedSlots\.has\(s\) && !ragSkipSlots\.has\(s\)/.test(pg));
check('PG: 유형 목표는 남은 칸 기준', /planTypeTargets\(\s*\/\/[^\n]*\n\s*deliverableCount,/.test(pg));
check('PG: 알림에 근거 부족 수', /insufficientEvidence: ragSkipSlots\.size,/.test(pg));
check('PG: 보충은 부족 유형에 맞는 예비 단위(on)', /ragFillEvidenceFor = \(slots, quota\) => \{[\s\S]{0,400}backfillSlotInputs\(/.test(pg));

check('PG: on 에서 이미지 정제를 근거 대기와 겹쳐 미리 돌림', /const usableGisPromise: Promise<Set<number>> = useImages\s*\? Promise\.all\(featuredImages\.map\(\(fi\) => withRefineTimeout\(getDisplayPng\(fi\.gi\)\)/.test(pg) && /if \(ragOn\) \{[\s\S]{0,900}const usableGisPromise/.test(pg));
check('PG: 이미지 칸 다시 고르기는 보충과 같은 예비 사용 기록을 씀', /assignImageSlots\(\{ slots: run\.slots, units, retrievals, reserve, used: usedReserve, figureGi, usableGis \}\)/.test(pg) && /used: usedReserve,/.test(pg));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

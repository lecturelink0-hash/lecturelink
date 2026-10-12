/**
 * RAG on 이미지 칸 검사 (npm run check:rag-figure · RAG 실행계획 v1.1 · PR K K0)
 *
 * 1) lib/rag/evidence.ts backfillSlotInputs 의 figureOk — 보충 이미지 칸은 쓸 수 있는 그림이 남은 단위만
 * 2) prompts/rag-cite-directive.ts RAG_FIGURE_DIRECTIVE — 그림 판독 칸 규칙, V0 인용 지시는 그대로
 * 3) 소스 대조 — 블라인드에서 걸린 그림 기록(강등 전에), 보충 그림 조건, 지시는 근거가 있을 때만
 *
 *   node --experimental-strip-types --no-warnings scripts/check-rag-figure.mjs
 */
import { readFileSync } from 'node:fs';
import { backfillSlotInputs, buildBatchEvidence, pickImageAlternates, batchFigureIds } from '../lib/rag/evidence.ts';
import { RAG_FIGURE_DIRECTIVE, RAG_CITE_DIRECTIVE_V0, buildRagCiteDirective } from '../lib/ai/prompts/rag-cite-directive.ts';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
console.log('[check:rag-figure]');

// ── 1) 보충 이미지 칸의 그림 조건
const U = (id, askKinds, needsImage = false, figures = []) => ({
  id, topic: id, objective: '', askKinds, needsImage, figures, pages: [], queries: { concept: '', clinical: '', compare: '' }, hydeStem: '',
});
const R = (unitId, sufficient = true, captionMatch = null) => ({
  unitId, topScore: 0.6, sufficient, ranked: [], packChars: 1, captionScore: null, captionMatch,
  pack: [{ ref: 'x', chunkId: `c-${unitId}`, pageIndex: 1, kind: 'slide_text', score: 0.6, text: 't', truncated: false }],
});
const units = new Map([
  ['IA', U('IA', ['image_finding'], true, ['F1'])], // 블라인드에서 걸린 그림
  ['IB', U('IB', ['image_finding'], true, ['F2'])], // 쓸 수 있는 그림
  ['IC', U('IC', ['image_finding'], true, ['F3'])], // 용량 소진
  ['C1', U('C1', ['diagnosis'])],
]);
const retr = new Map([['IA', R('IA', true, true)], ['IB', R('IB', true, true)], ['IC', R('IC', true, true)], ['C1', R('C1')]]);
const okFig = new Set(['F2']);
const figureOk = (u) => u.figures.some((f) => okFig.has(f));
const used = new Set();
const pick = backfillSlotInputs({
  slots: [1, 2],
  wanted: ['image', 'clinical'],
  slotUnit: new Map([[1, 'IA'], [2, 'C1']]),
  reserve: ['IC', 'IB'],
  used,
  units,
  retrievals: retr,
  figureOk,
});
check('보충 이미지 칸: 칸 단위 그림이 못 쓰면 쓸 수 있는 그림의 예비로(IC 는 건너뜀)', pick[0].unit.id === 'IB' && pick[0].fromReserve && used.has('IB') && !used.has('IC'), JSON.stringify(pick.map((p) => p.unit?.id)));
check('보충 이미지 칸: 그림 조건은 이미지 칸에만(임상 칸은 그대로)', pick[1].unit.id === 'C1' && !pick[1].fromReserve);
const clin = backfillSlotInputs({ slots: [3], wanted: ['clinical'], slotUnit: new Map([[3, 'IA']]), reserve: ['C1'], used: new Set(), units, retrievals: retr, figureOk });
check('그림 조건은 텍스트 칸의 예비 고르기에 영향 없음(그림 없는 임상 단위도 고름)', clin[0].unit.id === 'C1' && clin[0].fromReserve);
const none = backfillSlotInputs({ slots: [1], wanted: ['image'], slotUnit: new Map([[1, 'IA']]), reserve: ['IC'], used: new Set(), units, retrievals: retr, figureOk });
check('보충 이미지 칸: 쓸 그림이 없으면 칸 단위 그대로(그림은 호출자가 걸러 텍스트 몫이 됨)', none[0].unit.id === 'IA' && !none[0].fromReserve);
const keep = backfillSlotInputs({ slots: [1], wanted: ['image'], slotUnit: new Map([[1, 'IB']]), reserve: ['IA'], used: new Set(), units, retrievals: retr, figureOk });
check('보충 이미지 칸: 칸 단위 그림이 쓸 수 있으면 그대로', keep[0].unit.id === 'IB' && !keep[0].fromReserve);
const legacy = backfillSlotInputs({ slots: [1], wanted: ['image'], slotUnit: new Map([[1, 'IA']]), reserve: ['IB'], used: new Set(), units, retrievals: retr });
check('figureOk 없으면 그림은 보지 않음(PR J 동작)', legacy[0].unit.id === 'IA' && !legacy[0].fromReserve);

// ── 1-b) 그림 대체 후보(F3)
const altUnits = new Map([
  ['IA', U('IA', ['image_finding'], true, ['F1'])],
  ['IB', U('IB', ['image_finding'], true, ['F2'])],
  ['IC', U('IC', ['image_finding'], true, ['F3'])],
  ['ID', U('ID', ['image_finding'], true, ['F4'])],
  ['IN', U('IN', ['image_finding'], true, ['F5'])], // 그림 일치 아님
  ['K1', U('K1', ['definition'])],
]);
const altRetr = new Map([['IA', R('IA', true, true)], ['IB', R('IB', true, true)], ['IC', R('IC', true, true)], ['ID', R('ID', true, true)], ['IN', R('IN', true, false)], ['K1', R('K1')]]);
const fg = new Map([['F1', 1], ['F2', 2], ['F3', 3], ['F4', 4], ['F5', 5]]);
const claimed = new Set([1]);
const alts = pickImageAlternates({ units: altUnits, retrievals: altRetr, exclude: new Set(['IA', 'K1']), figureGi: fg, giOk: (g) => g !== 3, claimed, maxFigures: 2 });
check('대체 후보: 묶음 단위·그림 일치 아님·못 쓰는 그림 제외, 상한까지 계획 순서로', JSON.stringify(alts.map((a) => a.unit.id)) === JSON.stringify(['IB', 'ID']) && alts.every((a) => a.type === 'image' && a.slot === -1), JSON.stringify(alts.map((a) => a.unit.id)));
check('대체 후보: 고른 그림을 claimed 에 더함(다음 묶음은 피함)', claimed.has(2) && claimed.has(4) && !claimed.has(3));
const altsAll = pickImageAlternates({ units: altUnits, retrievals: altRetr, exclude: new Set(['IA', 'K1']), figureGi: fg, giOk: (g) => g !== 3, claimed: new Set(), maxFigures: 5 });
check('대체 후보: 묶음에 있는 단위는 그림이 비어 있어도 제외, 그림 일치 아닌 단위 제외', JSON.stringify(altsAll.map((a) => a.unit.id)) === JSON.stringify(['IB', 'ID']), JSON.stringify(altsAll.map((a) => a.unit.id)));
check('대체 후보: 상한 0 이면 없음', pickImageAlternates({ units: altUnits, retrievals: altRetr, exclude: new Set(), figureGi: fg, giOk: () => true, claimed: new Set(), maxFigures: 0 }).length === 0);
const slotIn = [{ slot: 4, type: 'image', unit: altUnits.get('IA'), retrieval: altRetr.get('IA'), insufficient: false }, { slot: 5, type: 'knowledge', unit: altUnits.get('K1'), retrieval: altRetr.get('K1'), insufficient: false }];
const evNo = buildBatchEvidence(slotIn);
const evAlt = buildBatchEvidence(slotIn, alts);
check('묶음 근거: 대체 후보가 없으면 PR J 와 같은 글', evNo.text === buildBatchEvidence(slotIn, []).text && !evNo.text.includes('그림 대체 후보'));
check('묶음 근거: 대체 후보는 단위 목록 뒤 따로(문항 수에 들지 않음)', evAlt.text.includes('### 그림 대체 후보 (문항 수에 들지 않음') && evAlt.text.indexOf('### 출제 단위') < evAlt.text.indexOf('### 그림 대체 후보') && /대체 후보 1\. 주제: IB/.test(evAlt.text) && !/3\. \[/.test(evAlt.text));
check('묶음 근거: 대체 후보 팩도 근거 번호를 받고 alternate 표시', evAlt.units.filter((u) => u.alternate).length === 2 && evAlt.units.filter((u) => !u.alternate).length === 2 && evAlt.chunks.size === 4);
check('묶음 근거: 대체 후보 그림도 묶음 그림에 들어감', JSON.stringify(batchFigureIds(evAlt)) === JSON.stringify(['F1', 'F2', 'F4']));
check('묶음 근거: 칸 팩이 없으면 대체 후보만으로 만들지 않음', buildBatchEvidence([{ slot: 1, type: 'image', unit: altUnits.get('IA'), retrieval: { ...altRetr.get('IA'), pack: [] }, insufficient: false }], alts) === null);

// ── 2) 그림 판독 칸 지시
check('그림 지시: 소견은 그림에서, 지문에 옮기지 않음', RAG_FIGURE_DIRECTIVE.includes('그림에서 읽게') && RAG_FIGURE_DIRECTIVE.includes('지문에 글로 옮겨 쓰지 않습니다'));
check('그림 지시: 선지는 그림 없이 못 고르게', RAG_FIGURE_DIRECTIVE.includes('그림을 보지 않으면 고를 수 없어야'));
check('그림 지시: 인용은 소견의 뜻 근거, V0 금지와의 관계', RAG_FIGURE_DIRECTIVE.includes('evidence_refs') && RAG_FIGURE_DIRECTIVE.includes("'근거 자료로 뒷받침할 수 없는 내용'에 들지 않습니다"));
check('그림 지시: 블록 머리말은 그대로(단위별 그림)', RAG_FIGURE_DIRECTIVE.startsWith('\n\n**단위별 그림** — 그림 판독 문항은 그 단위의 그림으로 만드세요.'));
check('인용 지시: 운영 판은 V0 그대로', buildRagCiteDirective() === RAG_CITE_DIRECTIVE_V0);

// ── 3) 소스 대조
const pg = readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8');
const count = (re) => (pg.match(re) ?? []).length;
check('PG: 그림 지시는 근거가 있을 때(on)만 붙음', count(/RAG_FIGURE_DIRECTIVE/g) === 2 && /if \(gen\.evidence\) \{[\s\S]{0,1200}\$\{RAG_FIGURE_DIRECTIVE\}/.test(pg));
const fixLoop = pg.slice(pg.indexOf('for (const { i, basis } of stillFailed) {'), pg.indexOf("bumpGenDiag('blindDemoted');"));
check('PG: 블라인드에서 걸린 그림은 폐기·강등 전에 기록', /for \(const ix of k\.q\.image_indices \?\? \[\]\) if \(validImageIndex\(ix\)\) blindFailedGis\.add\(featured\[ix\]\.gi\);/.test(fixLoop) && fixLoop.indexOf('blindFailedGis.add') < fixLoop.indexOf('k.q.image_indices = [];'));
check('PG: 블라인드 그림 기록은 실행 단위(묶음 함수 밖) 하나', count(/const blindFailedGis = new Set<number>\(\);/g) === 1 && pg.indexOf('const blindFailedGis') < pg.indexOf('async function generateAndPersistBatch('));
check('PG: 보충 단위 고르기에 같은 그림 조건을 넘김', /const ragFillFigureOk = ragFillGiOk\s*\? \(u: PlanUnit\) =>\s*u\.figures\.some\(\(f\) => \{\s*const gi = ragFigureGi\.get\(f\);\s*return gi !== undefined && ragFillGiOk!\(gi\);/.test(pg) && /ragFillGiOk && ragFillFigureOk \? \{ unitOk: ragFillFigureOk, giOk: ragFillGiOk, claimed: new Set<number>\(\) \} : undefined;/.test(pg));
check('PG: 대체 후보는 이미지 칸이 있는 묶음에만, 칸 그림 포함 최대 3장', /const RAG_ALT_MAX_FIGURES = 3;/.test(pg) && count(/maxFigures: RAG_ALT_MAX_FIGURES - /g) === 2 && /if \(mainUsableGis && inputs\.some\(\(x\) => x\.type === 'image'\)\) \{/.test(pg) && /if \(figure && picked\.some\(\(x\) => x\.type === 'image'\)\) \{/.test(pg));
check('PG: 본 묶음 대체 그림은 이미지 칸 그림을 피하고 한 묶음에만(공유 claimed)', /const mainAltClaimed = new Set<number>\(\);\s*for \(const \[, sl\] of after\) \{\s*if \(sl\.type !== 'image' \|\| !sl\.unitId\) continue;/.test(pg) && /claimed: mainAltClaimed,/.test(pg) && /const key = slots\.join\(','\);\s*if \(mainEvidence\.has\(key\)\)/.test(pg));
check('PG: 보충 대체 그림은 F1 조건(giOk)과 라운드 공유 claimed', /for \(const g of offered\) figure\.claimed\.add\(g\);/.test(pg) && /giOk: figure\.giOk,\s*claimed: figure\.claimed,/.test(pg));
check('PG: 본·보충 묶음 근거에 대체 후보를 넣음', /const ev = buildBatchEvidence\(inputs, alternates\);/.test(pg) && /return buildBatchEvidence\(picked, alternates\);/.test(pg));
check('PG: 단위별 그림 블록이 대체 후보를 따로 표시', /\$\{u\.alternate \? `그림 대체 후보 \$\{altNo\}` : `출제 단위 \$\{n \+ 1\}`\}/.test(pg));
check('PG: off·shadow 보충 그림 경로는 그대로', /: fillFeatured\[i\],\s*\),/.test(pg));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

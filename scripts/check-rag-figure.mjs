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
import { backfillSlotInputs } from '../lib/rag/evidence.ts';
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
check('PG: 보충 단위 고르기에 같은 그림 조건을 넘김', /const ragFillFigureOk = ragFillGiOk\s*\? \(u: PlanUnit\) =>\s*u\.figures\.some\(\(f\) => \{\s*const gi = ragFigureGi\.get\(f\);\s*return gi !== undefined && ragFillGiOk!\(gi\);/.test(pg));
check('PG: off·shadow 보충 그림 경로는 그대로', /: fillFeatured\[i\],\s*\),/.test(pg));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

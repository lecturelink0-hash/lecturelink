/**
 * 출제 계획·질의 검사 (npm run check:rag-plan · RAG 실행계획 v1.1 5.2 C·D · PR G)
 *
 * 1) lib/rag/plan.ts — 페이지 요약·입력 조립(상한·캡션 몫·고른 솎기), 출력 검사(카탈로그·쪽·그림·중복),
 *    질의 4개, 초점 폴백, type-plan 쿼터 칸 배정(유형 적합·예비), 진단 통계에 강의 문구 없음
 * 2) 소스 대조 — 계획 콜은 shadow·on 에서만, 생성은 기다리지 않고 진단 직전에 상한을 두고 합류,
 *    비용은 원가에 더하고 rag.plan 으로 기록, 실패는 초점 폴백
 *
 *   node --experimental-strip-types --no-warnings scripts/check-rag-plan.mjs
 */
import { readFileSync } from 'node:fs';
import {
  pageDigest,
  buildPlanInput,
  buildPlanPrompt,
  parsePlan,
  unitQueries,
  fallbackUnitsFromTopics,
  assignUnitsToSlots,
  unitFits,
  planStats,
  planUnitCount,
  PLAN_LIMITS,
  PLAN_TOOL,
  ALL_PLAN_ASK_KINDS,
} from '../lib/rag/plan.ts';
import { KNOWLEDGE_ASK_KINDS, CLINICAL_ASK_KINDS, IMAGE_ASK_KINDS } from '../lib/ai/prompts/knowledge-rules.ts';
import { planTypeTargets, planBatchQuotas } from '../lib/ai/type-plan.ts';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
console.log('[check:rag-plan]');

// ── 단위 수
check('단위 수: 요청의 1.5배(올림)', planUnitCount(10) === 15 && planUnitCount(7) === 11 && planUnitCount(0) === 1);

// ── 페이지 요약
const d1 = pageDigest('위식도역류질환\n\n12\n정의. 위 내용물이 역류한다. 세 번째 문장이다.\n네 번째 줄', 600);
check('요약: 숫자만 있는 줄 건너뜀·제목 — 문장', d1.startsWith('위식도역류질환 — 정의. 위 내용물이 역류한다.'), d1);
check('요약: 상한 안에서 문장을 더 실음', d1.includes('세 번째 문장이다.') && d1.includes('네 번째 줄'));
const d2 = pageDigest('제목\n첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다.', 15);
check('요약: 첫 두 문장까지는 싣고 상한으로 자름', d2.length <= 15 && d2.endsWith('…') && d2.startsWith('제목 — 첫 문장'), d2);
check('요약: 상한이 넉넉해도 셋째 문장부터는 상한 안에서만', !pageDigest('제목\n첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다.', 26).includes('셋째'));
check('요약: 글자 없는 페이지는 빈 문자열', pageDigest('12\n\n---\n3', 100) === '');

// ── 입력 조립
const pages = Array.from({ length: 30 }, (_, i) => ({ pageIndex: i + 1, text: `제목 ${i + 1}\n${'가나다라마바사. '.repeat(40)}` }));
const captions = [
  { pageIndex: 7, text: '[이미지: 흉부 X-ray] 우하엽 경화.' },
  { pageIndex: 3, text: '[이미지: 해부도] 위 해부도.', imageKey: 'k3' },
];
const inp = buildPlanInput(pages, captions);
check('입력: 상한 이하', inp.text.length <= PLAN_LIMITS.inputChars, String(inp.text.length));
check('입력: 그림은 쪽 순서로 F1·F2', inp.figures.map((f) => `${f.id}:${f.pageIndex}`).join() === 'F1:3,F2:7' && inp.figures[0].imageKey === 'k3');
check('입력: 그림 줄 형식', inp.text.includes('[그림 F1] p3 [이미지: 해부도] 위 해부도.'));
check('입력: 모든 페이지 포함·솎지 않음', inp.pagesIncluded === 30 && inp.pagesTotal === 30 && !inp.truncated);
const many = Array.from({ length: 400 }, (_, i) => ({ pageIndex: i + 1, text: `제목 ${i + 1}\n${'문장입니다. '.repeat(30)}` }));
const inpMany = buildPlanInput(many, []);
check('입력: 페이지가 많으면 고르게 솎음', inpMany.truncated && inpMany.pagesIncluded < 400 && inpMany.text.length <= PLAN_LIMITS.inputChars, `${inpMany.pagesIncluded} ${inpMany.text.length}`);
const lastP = Number([...inpMany.text.matchAll(/^p(\d+) /gm)].at(-1)?.[1]);
check('입력: 솎아도 뒤쪽 페이지가 남음(앞에서 자르지 않음)', lastP > 350, String(lastP));
const capFlood = Array.from({ length: 200 }, (_, i) => ({ pageIndex: i + 1, text: `[이미지: 해부도] ${'설명 '.repeat(60)}` }));
const inpCap = buildPlanInput(pages, capFlood);
check('입력: 캡션은 몫(25%) 안에서만', inpCap.figures.length < 200 && inpCap.text.length <= PLAN_LIMITS.inputChars && inpCap.pagesIncluded === 30);
check('입력: 빈 페이지는 세지 않음', buildPlanInput([{ pageIndex: 1, text: '' }, { pageIndex: 2, text: '본문 있음' }]).pagesTotal === 1);

// ── 프롬프트
const targets = planTypeTargets(10, ['지식형', '임상형', '이미지형'], 20);
const prompt = buildPlanPrompt({ desiredCount: 10, selectedTypes: ['지식형', '임상형', '이미지형'], difficulty: '중', targets }, inp);
check('프롬프트: 단위 수·예비·최소', prompt.includes('출제 단위 **15개**') && prompt.includes('예비 5개') && prompt.includes('10개보다 적게 만들지 않는다'));
check('프롬프트: 유형별 필요 후보 수', /임상형 \d+문항 몫/.test(prompt) && /지식형 \d+문항 몫/.test(prompt) && /이미지형 \d+문항 몫/.test(prompt));
const promptNoFig = buildPlanPrompt({ desiredCount: 10, selectedTypes: ['이미지형'], difficulty: '중', targets }, buildPlanInput(pages, []));
check('프롬프트: 그림이 없으면 이미지형 몫 지시 없음', !promptNoFig.includes('이미지형 ') || !/이미지형 \d+문항 몫/.test(promptNoFig));

// ── 도구 스키마 카탈로그
const enumKinds = PLAN_TOOL.input_schema.properties.units.items.properties.ask_kinds.items.enum;
const catalog = [...KNOWLEDGE_ASK_KINDS, ...CLINICAL_ASK_KINDS, ...IMAGE_ASK_KINDS];
check('스키마: ask_kinds 는 knowledge-rules 카탈로그와 같음', JSON.stringify([...enumKinds]) === JSON.stringify(catalog) && JSON.stringify(ALL_PLAN_ASK_KINDS) === JSON.stringify(catalog));
check('스키마: 질의 3개·HyDE 필수', ['query_concept', 'query_clinical', 'query_compare', 'hyde_stem', 'pages'].every((k) => PLAN_TOOL.input_schema.properties.units.items.required.includes(k)));

// ── 출력 검사
const raw = {
  units: [
    { topic: ' 위식도역류질환 정의 ', objective: '정의를 안다', ask_kinds: ['definition', 'bogus', 'definition'], needs_image: false, figures: [], pages: [3, 99, 3], query_concept: 'GERD 정의', query_clinical: '', query_compare: '역류 비교', hyde_stem: '' },
    { topic: '위식도역류질환  정의', objective: '중복', ask_kinds: ['mechanism'], needs_image: false, pages: [4], query_concept: 'x', query_clinical: 'y', query_compare: 'z', hyde_stem: 'h' },
    { topic: '', ask_kinds: ['definition'], pages: [1] },
    { topic: '흉부 X-ray 판독', objective: '판독한다', ask_kinds: ['image_finding', 'diagnosis'], needs_image: true, figures: ['F2', 'F9'], pages: [7], query_concept: '우하엽 경화', query_clinical: '폐렴', query_compare: '무기폐', hyde_stem: '이 X-ray 소견은?' },
    { topic: '그림 없는 이미지 단위', objective: 'o', ask_kinds: ['image_structure', 'definition'], needs_image: true, figures: ['F9'], pages: [5], query_concept: 'a', query_clinical: 'b', query_compare: 'c', hyde_stem: 'd' },
  ],
};
const parsed = parsePlan(raw, { validPages: pages.map((p) => p.pageIndex), figureIds: inp.figures.map((f) => f.id), maxUnits: 17 });
const [u1, u2, u3] = parsed.units;
check('검사: 주제 없음·중복 주제는 버림', parsed.units.length === 3 && parsed.dropped === 2, JSON.stringify(parsed.units.map((u) => u.topic)));
check('검사: 카탈로그 밖 유형 제거·중복 제거', u1.askKinds.join() === 'definition');
check('검사: 없는 쪽 제거·중복 제거', u1.pages.join() === '3');
check('검사: 빈 질의는 주제로, 빈 HyDE 는 학습목표로', u1.queries.clinical === '위식도역류질환 정의' && u1.hydeStem === '정의를 안다');
check('검사: 그림은 입력에 있던 것만', u2.needsImage === true && u2.figures.join() === 'F2');
check('검사: 가리킬 그림이 없으면 이미지 단위 아님·이미지 유형 제거', u3.needsImage === false && u3.figures.length === 0 && u3.askKinds.join() === 'definition');
check('검사: id 는 순서대로', parsed.units.map((u) => u.id).join() === 'u1,u2,u3');
check('검사: 고친 항목을 셈', parsed.repaired >= 4, String(parsed.repaired));
const capped = parsePlan({ units: Array.from({ length: 30 }, (_, i) => ({ topic: `주제 ${i}`, ask_kinds: [], pages: [] })) }, { validPages: [], figureIds: [], maxUnits: 17 });
check('검사: 상한을 넘는 단위는 버림', capped.units.length === 17 && capped.dropped === 13);
check('검사: 이상한 입력은 빈 계획', parsePlan(null, { validPages: [], figureIds: [], maxUnits: 5 }).units.length === 0 && parsePlan({ units: 'x' }, { validPages: [], figureIds: [], maxUnits: 5 }).units.length === 0);

check('질의: 개념·임상·비교·HyDE 순서 4개', JSON.stringify(unitQueries(u2)) === JSON.stringify(['우하엽 경화', '폐렴', '무기폐', '이 X-ray 소견은?']));

// ── 폴백
const fb = fallbackUnitsFromTopics(['위식도역류질환', '위식도역류질환', '  ', '진단', '치료'], 2);
check('폴백: 초점을 주제·질의로, 중복·빈 것 제외, 상한', fb.length === 2 && fb[0].topic === '위식도역류질환' && fb[1].topic === '진단' && unitQueries(fb[1]).every((q) => q === '진단'));
check('폴백: 유형 후보 없음(칸 배정에서 불일치로 셈)', fb.every((u) => u.askKinds.length === 0 && !unitFits(u, 'clinical') && !unitFits(u, 'knowledge') && unitFits(u, 'free')));

// ── 쿼터 칸 배정
const mk = (id, askKinds, needsImage = false) => ({ id, topic: id, objective: '', askKinds, needsImage, figures: needsImage ? ['F1'] : [], pages: [], queries: { concept: id, clinical: id, compare: id }, hydeStem: id });
const units = [
  mk('k1', ['definition']),
  mk('c1', ['diagnosis']),
  mk('i1', ['image_finding'], true),
  mk('k2', ['mechanism']),
  mk('c2', ['treatment', 'definition']),
  mk('k3', ['classification']),
  mk('x1', []),
];
const quotas = [
  { image: 0, clinical: 1, knowledge: 1, free: 0 },
  { image: 1, clinical: 1, knowledge: 0, free: 0 },
];
const as = assignUnitsToSlots(units, quotas);
check('배정: 묶음 순서·묶음 안은 이미지→임상→지식→free', as.slots.map((s) => `${s.batch}${s.type[0]}:${s.unitId}`).join() === '0c:c1,0k:k1,1i:i1,1c:c2', JSON.stringify(as.slots));
check('배정: 모두 유형 적합', as.stats.fit === 4 && as.stats.filled === 4 && as.stats.empty === 0);
check('배정: 남은 단위는 예비(순서 유지)', as.reserve.join() === 'k2,k3,x1');
const as2 = assignUnitsToSlots([mk('k1', ['definition']), mk('i1', ['image_finding'], true)], [{ image: 0, clinical: 2, knowledge: 0, free: 0 }]);
check('배정: 맞는 단위가 없으면 그림 없는 단위 먼저(불일치)', as2.slots[0].unitId === 'k1' && as2.slots[0].fit === false && as2.slots[1].unitId === 'i1' && as2.slots[1].fit === false);
const as3 = assignUnitsToSlots([mk('k1', ['definition'])], [{ image: 1, clinical: 0, knowledge: 1, free: 1 }]);
check('배정: 단위가 모자라면 빈 칸', as3.stats.empty === 2 && as3.stats.filled === 1);
// 실제 쿼터(10문항·5묶음)와 합이 맞는가
const q10 = planBatchQuotas([2, 2, 2, 2, 2], planTypeTargets(10, ['지식형', '임상형'], 0), [false, false, false, false, false]);
check('배정: 10문항 쿼터 칸 수 = 10', assignUnitsToSlots(units, q10).stats.slots === 10);

// ── 진단 통계
const st = planStats(parsed.units, { pagesTotal: 30 });
check('통계: 수치만(강의 문구 없음)', Object.values(st).every((v) => typeof v === 'number'), JSON.stringify(st));
check('통계: 유형 가능 수·쪽 비율', st.units === 3 && st.needsImage === 1 && st.clinicalCapable === 1 && Math.abs(st.hintedPageShare - 3 / 30) < 1e-3, JSON.stringify(st));

// ── 소스 대조
const pg = readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8');
check('PG: 계획 콜은 shadow·on 에서만', /if \(ragIndexingEnabled\(RAG_MODE\)\) \{\s*ragPlanPromise = runPlanForDiagnostics\(/.test(pg));
check('PG: 계획 콜 시작은 한 곳', (pg.match(/runPlanForDiagnostics\(/g) ?? []).length === 1);
check('PG: 생성 경로에서 계획을 기다리지 않음(진단 직전 합류만)', (pg.match(/await settlePlan\(ragPlanPromise/g) ?? []).length === 1 && !/await ragPlanPromise/.test(pg));
check('PG: 상한을 두고 합류', /ragPlanDiag = await settlePlan\(ragPlanPromise, RAG_PLAN_WAIT_MS/.test(pg));
check('PG: 계획 비용을 totalCost 에 더함', /ragPlanDiag = await settlePlan\([^;]*;\s*(\/\/[^\n]*\n\s*)*totalCost \+= ragPlanDiag\.costUsd;/.test(pg));
check('PG: 진단에 rag.plan', /\.\.\.\(ragPlanDiag \? \{ plan: ragPlanDiag \} : \{\}\)/.test(pg));
check('PG: 쿼터 칸은 type-plan 의 batchQuotas', /quotas: batchQuotas,/.test(pg) && /targets: typeTargets,/.test(pg));
check('PG: 폴백은 현행 초점', /fallbackTopics: \(\) => focusTopics,/.test(pg));
const iPlan = pg.indexOf('ragPlanPromise = runPlanForDiagnostics(');
const iFinal = pg.indexOf('const finalChunks = buildTextFirstChunks(slideSummaries);');
check('PG: 계획은 최종 청크·캡션 확정 뒤', iFinal > 0 && iPlan > iFinal);

const rp = readFileSync(new URL('../lib/ai/rag-plan.ts', import.meta.url), 'utf8');
check('계획 콜: 비용 기록(rag.plan)·생성 모델', /endpoint: 'rag\.plan'/.test(rp) && /MODELS\.generation\(\)/.test(rp));
check('계획 콜: 던지지 않음(try/catch)', /export async function planExamUnits[\s\S]*try \{[\s\S]*\} catch \(e\) \{/.test(rp));
check('계획 콜: 도구 강제', /tool_choice: \{ type: 'tool', name: PLAN_TOOL\.name \}/.test(rp));
check('진단: 단위 문구 대신 통계만', /stats: planStats\(units, r\.input\)/.test(rp) && !/topic:|queries:|hydeStem:/.test(rp.slice(rp.indexOf('export interface PlanDiag'))));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

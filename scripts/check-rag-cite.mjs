/**
 * 인용 강제 생성·인용 검증·검증기 입력 교체 검사 (npm run check:rag-cite · RAG 실행계획 v1.1 5.2 G·H·I · PR I)
 *
 * 1) lib/rag/cite.ts — 정규화, 부분 일치율(반전역 편집 거리), 근거 번호 읽기, 인용 판정(엄격·관대·재귀속),
 *    인용에서 파생한 출처·저장 형태, 진단 통계에 문구 없음
 * 2) lib/rag/evidence.ts — 묶음 근거(청크 중복 제거·번호·단위 목록·HyDE 제외), 문항 단위·검증기 입력, 그림, D3 칸
 * 3) 프롬프트 — off 사용자 메시지·도구 스키마·검증기 입력이 그대로인지, on 변형(evidence_refs 필수·source_pages 파생)
 * 4) 소스 대조 — on 에서만 근거 경로, 선발사 끔, 인용 교정 1회, 검증기 근거 팩, 출처 파생, 폴백, 진단 수치만
 *
 *   node --experimental-strip-types --no-warnings scripts/check-rag-cite.mjs
 */
import { readFileSync } from 'node:fs';
import {
  CITE_LIMITS,
  normalizeForCite,
  substringEditDistance,
  partialMatchRatio,
  normalizeRefId,
  parseEvidenceRefs,
  verifyCitations,
  sourceRefsFromCitations,
  storedEvidence,
  citationStats,
} from '../lib/rag/cite.ts';
import {
  buildBatchEvidence,
  unitForQuestion,
  questionEvidenceText,
  batchFigureIds,
  slotEvidenceInputs,
} from '../lib/rag/evidence.ts';
import {
  buildPrivateGenerationUserMessage,
  PRIVATE_GENERATION_TOOL_SCHEMA,
  PRIVATE_GENERATION_TOOL_SCHEMA_RAG,
} from '../lib/ai/prompts/private-generation.ts';
import { buildPrivateVerificationUserMessage } from '../lib/ai/prompts/verification.ts';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
console.log('[check:rag-cite]');

// ── 1) 정규화·부분 일치
check('정규화: NFKC·소문자·공백 제거', normalizeForCite('ＡＢＣ  Def g​h') === 'abcdefgh', normalizeForCite('ＡＢＣ  Def g​h'));
check('정규화: 따옴표·대시·가운뎃점 통일', normalizeForCite('“A”–‘B’ • C') === '"a"-\'b\'·c', normalizeForCite('“A”–‘B’ • C'));
check('편집 거리: 부분 문자열이면 0', substringEditDistance('cde', 'abcdefg') === 0);
check('편집 거리: 한 글자 치환 1', substringEditDistance('cxe', 'abcdefg') === 1);
check('편집 거리: 빈 문자열', substringEditDistance('', 'abc') === 0 && substringEditDistance('ab', '') === 2);
check('편집 거리: 패턴이 더 길면 남는 만큼', substringEditDistance('abcdef', 'abc') === 3);
const chunk = '급성 심근경색의 가장 흔한 원인은 관상동맥 죽상경화반의 파열과 그에 따른 혈전 형성이다. ST분절 상승은 전층 허혈을 뜻한다.';
check('일치율: 그대로면 1', partialMatchRatio('관상동맥 죽상경화반의 파열', chunk) === 1);
check('일치율: 띄어쓰기만 다르면 1', partialMatchRatio('관상동맥죽상 경화반의  파열과', chunk) === 1);
const typo = partialMatchRatio('관상동맥 죽상경화반의 파혈과 그에 따른 혈전 형성', chunk);
check('일치율: 20자 남짓에 한 글자 오타는 0.9 이상', typo >= 0.9 && typo < 1, String(typo));
const para = partialMatchRatio('심근경색은 주로 관상동맥의 플라크가 터져서 생긴다', chunk);
check('일치율: 바꿔 쓴 문장은 0.9 미만', para < 0.9, String(para));
check('일치율: 빈 quote 는 0', partialMatchRatio('', chunk) === 0);

// ── 근거 번호·인용 읽기
check('번호: E1·[E1]·e 1·E-1·근거 E12', ['E1', '[E1]', 'e 1', 'E-1'].every((x) => normalizeRefId(x) === 'E1') && normalizeRefId('근거 E12') === 'E12');
check('번호: 못 읽으면 null', normalizeRefId('첫째') === null && normalizeRefId('') === null && normalizeRefId(null) === null);
const parsedRefs = parseEvidenceRefs([
  { id: 'E1', quote: '"관상동맥 죽상경화반"' },
  { id: '[E1]', quote: '관상동맥 죽상경화반' }, // 중복
  null,
  'x',
  { id: 'E2', quote: 'a' },
  { id: 'E3', quote: 'b' },
  { id: 'E4', quote: 'c' }, // 상한 3 초과
]);
check('인용 읽기: 따옴표 걷기·중복 제거·형식 오류 버림·상한 3', parsedRefs.length === 3 && parsedRefs[0].quote === '관상동맥 죽상경화반' && parsedRefs.map((r) => r.ref).join() === 'E1,E2,E3', JSON.stringify(parsedRefs));
check('인용 읽기: 배열이 아니면 빈 목록', parseEvidenceRefs(undefined).length === 0 && parseEvidenceRefs({}).length === 0);

const ev = new Map([
  ['E1', { ref: 'E1', chunkId: 'c1', pageIndex: 3, kind: 'slide_text', text: chunk, score: 0.71, rank: 1, unitId: 'U1' }],
  ['E2', { ref: 'E2', chunkId: 'c2', pageIndex: 5, kind: 'slide_text', text: '대동맥 박리는 Stanford A형이면 응급 수술을 시행한다.', score: 0.66, rank: 2, unitId: 'U1' }],
]);
const okV = verifyCitations([{ id: 'E1', quote: '관상동맥 죽상경화반의 파열' }], ev);
check('판정: 맞는 인용 1개 → 합격', okV.ok && okV.lenientOk && okV.citations.length === 1 && okV.citations[0].chunkId === 'c1' && okV.citations[0].match === 1);
check('판정: 인용 없음 → 불합격(empty)', !verifyCitations([], ev).ok && verifyCitations([], ev).empty && !verifyCitations(undefined, ev).lenientOk);
const reatt = verifyCitations([{ id: 'E1', quote: 'Stanford A형이면 응급 수술' }], ev);
check('판정: 번호만 틀리면 재귀속 후 합격', reatt.ok && reatt.reattributed === 1 && reatt.citations[0].ref === 'E2' && reatt.citations[0].reattributedFrom === 'E1', JSON.stringify(reatt));
const unknown = verifyCitations([{ id: 'E9', quote: '전혀 없는 문장이 여기에 들어간다' }], ev);
check('판정: 없는 번호·없는 구절 → unknown_ref', !unknown.ok && unknown.failures[0]?.reason === 'unknown_ref');
const mism = verifyCitations([{ id: 'E1', quote: '심근경색은 주로 관상동맥의 플라크가 터져서 생긴다' }], ev);
check('판정: 바꿔 쓴 구절 → mismatch', !mism.ok && mism.failures[0]?.reason === 'mismatch' && mism.failures[0].match < CITE_LIMITS.threshold);
const short = verifyCitations([{ id: 'E1', quote: '파열' }], ev);
check('판정: 8자 미만 → short_quote', !short.ok && short.failures[0]?.reason === 'short_quote');
const mixed = verifyCitations([{ id: 'E1', quote: '관상동맥 죽상경화반의 파열' }, { id: 'E2', quote: '흉통이 30분 이상 지속되면 의심한다' }], ev);
check('판정: 하나라도 틀리면 엄격 불합격·관대 합격', !mixed.ok && mixed.lenientOk && mixed.citations.length === 1 && mixed.failures.length === 1);
const boundary = verifyCitations([{ id: 'E1', quote: 'abcdefghij' }], new Map([['E1', { ...ev.get('E1'), text: 'xxabcdefghiQxx' }]]));
check('판정: 일치율이 정확히 임계(0.9)면 합격', boundary.ok && boundary.citations[0].match === 0.9, JSON.stringify(boundary.citations));
const below = verifyCitations([{ id: 'E1', quote: 'abcdefghij' }], new Map([['E1', { ...ev.get('E1'), text: 'xxabcdeQQhijxx' }]]));
check('판정: 임계 0.90 고정 — 일치율 0.8 은 불합격', CITE_LIMITS.threshold === 0.9 && !below.ok && below.failures[0]?.match === 0.8, JSON.stringify(below.failures));
check('판정: 너무 긴 구절은 검사하지 않고 불합격', verifyCitations([{ id: 'E1', quote: '가'.repeat(CITE_LIMITS.maxQuoteChars + 1) }], ev).failures[0]?.reason === 'long_quote');

const refs = sourceRefsFromCitations([...okV.citations, ...reatt.citations, ...okV.citations], 'sha');
check('출처 파생: 쪽·청크는 인용 청크만(중복 제거·정렬)', JSON.stringify(refs) === JSON.stringify({ fileSha256: 'sha', pages: [3, 5], chunkIds: ['c1', 'c2'], reportedPages: [3, 5], invalidPages: [] }), JSON.stringify(refs));
const stored = storedEvidence(reatt.citations);
check('저장 형태: chunk_id·page·quote·match·score·rank·role(+재귀속)', stored.length === 1 && stored[0].chunk_id === 'c2' && stored[0].page === 5 && stored[0].role === 'cite' && stored[0].reattributed_from === 'E1' && typeof stored[0].score === 'number', JSON.stringify(stored));
check('저장 형태: quote 상한', verifyCitations([{ id: 'E1', quote: chunk + chunk + chunk }], new Map([['E1', { ...ev.get('E1'), text: chunk + chunk + chunk }]])).citations[0].quote.length <= CITE_LIMITS.storedQuoteChars);
const st = citationStats([okV, mixed, short, unknown, reatt]);
check('통계: 수치만(문구 없음)', JSON.stringify(st) === JSON.stringify({ questions: 5, ok: 2, lenientOk: 3, empty: 0, citations: 3, reattributed: 1, reasons: { unknown_ref: 1, short_quote: 1, long_quote: 0, mismatch: 1 } }), JSON.stringify(st));

// ── 2) 묶음 근거
const pe = (chunkId, page, text, score = 0.7) => ({ ref: 'x', chunkId, pageIndex: page, kind: 'slide_text', score, text, truncated: false });
const unitA = { id: 'U1', topic: '심근경색 원인', objective: '죽상경화반 파열과 혈전', askKinds: ['cause_risk'], needsImage: false, figures: [], pages: [3], queries: { concept: 'q', clinical: 'q', compare: 'q' }, hydeStem: 'HYDE_SECRET_A' };
const unitB = { id: 'U2', topic: '대동맥 박리', objective: 'Stanford 분류와 치료', askKinds: ['treatment'], needsImage: true, figures: ['F1'], pages: [5], queries: { concept: 'q', clinical: 'q', compare: 'q' }, hydeStem: 'HYDE_SECRET_B' };
const retA = { unitId: 'U1', topScore: 0.7, sufficient: true, ranked: [], pack: [pe('c1', 3, 'AAA'), pe('c2', 5, 'BBB')], packChars: 6, captionScore: null, captionMatch: null };
const retB = { unitId: 'U2', topScore: 0.6, sufficient: true, ranked: [], pack: [pe('c2', 5, 'BBB'), pe('c3', 6, 'CCC')], packChars: 6, captionScore: 0.5, captionMatch: true };
const be = buildBatchEvidence([
  { slot: 0, type: 'clinical', unit: unitA, retrieval: retA, insufficient: false },
  { slot: 1, type: 'image', unit: unitB, retrieval: retB, insufficient: false },
]);
check('묶음 근거: 청크 중복 제거·번호 순서', be && be.chunks.size === 3 && [...be.chunks.values()].map((c) => `${c.ref}:${c.chunkId}`).join() === 'E1:c1,E2:c2,E3:c3', be && [...be.chunks.keys()].join());
check('묶음 근거: 단위별 근거 번호(공유 청크는 같은 번호)', be && be.units[0].refs.join() === 'E1,E2' && be.units[1].refs.join() === 'E2,E3');
check('묶음 근거: 처음 담긴 단위·팩 순위', be && be.chunks.get('E2').unitId === 'U1' && be.chunks.get('E2').rank === 2 && be.chunks.get('E3').rank === 2);
check('묶음 근거: 근거 자료·단위 목록·칸 유형, HyDE 없음', be && be.text.includes('[E1] (p.3) AAA') && be.text.includes('1. [임상 증례형 칸] 주제: 심근경색 원인') && be.text.includes('근거: E2, E3') && !be.text.includes('HYDE_SECRET'));
check('묶음 근거: 글자 수는 근거 자료 부분', be && be.evidenceChars === '[E1] (p.3) AAA\n\n[E2] (p.5) BBB\n\n[E3] (p.6) CCC'.length, be && String(be.evidenceChars));
check('묶음 근거: 팩 없는 칸은 빠지고, 전부 없으면 null',
  buildBatchEvidence([{ slot: 0, type: 'free', unit: unitA, retrieval: { ...retA, pack: [] }, insufficient: false }]) === null &&
  buildBatchEvidence([{ slot: 0, type: 'free', unit: null, retrieval: null, insufficient: true }]) === null &&
  buildBatchEvidence([
    { slot: 0, type: 'free', unit: unitA, retrieval: { ...retA, pack: [] }, insufficient: false },
    { slot: 1, type: 'free', unit: unitB, retrieval: retB, insufficient: true },
  ]).units.length === 1);
check('문항 단위: 인용이 많이 속한 단위', unitForQuestion(be, ['E3'], 0).unitId === 'U2' && unitForQuestion(be, ['E1', 'E2'], 1).unitId === 'U1');
check('문항 단위: 동률이면 문항 순서, 인용 없으면 문항 순서', unitForQuestion(be, ['E2'], 1).unitId === 'U2' && unitForQuestion(be, ['E2'], 0).unitId === 'U1' && unitForQuestion(be, [], 1).unitId === 'U2' && unitForQuestion(be, [], 7).unitId === 'U1');
check('검증기 입력: 단위 팩 + 팩 밖 인용', questionEvidenceText(be, ['E1', 'E3'], 0) === '[E1] (p.3) AAA\n\n[E2] (p.5) BBB\n\n[E3] (p.6) CCC' && questionEvidenceText(be, ['E3'], 0) === '[E2] (p.5) BBB\n\n[E3] (p.6) CCC');
check('그림: 이미지 칸 단위의 그림만', batchFigureIds(be).join() === 'F1' &&
  batchFigureIds(buildBatchEvidence([{ slot: 1, type: 'free', unit: unitB, retrieval: retB, insufficient: false }])).length === 0);
const sei = slotEvidenceInputs({
  slots: [0, 1, 2],
  after: new Map([[0, { type: 'clinical', unitId: 'U1' }], [1, { type: 'free', unitId: null }], [2, { type: 'knowledge', unitId: null }]]),
  before: new Map([[0, { type: 'clinical', unitId: 'U1' }], [1, { type: 'image', unitId: 'U2' }], [2, { type: 'knowledge', unitId: null }]]),
  units: new Map([['U1', unitA], ['U2', unitB]]),
  retrievals: new Map([['U1', retA], ['U2', retB]]),
});
check('D3 칸: 교체 뒤 단위, 비면 교체 전 단위(부족 표시·교체 뒤 유형)', sei[0].unit.id === 'U1' && !sei[0].insufficient && sei[1].unit.id === 'U2' && sei[1].insufficient && sei[1].type === 'free' && sei[2].unit === null && !sei[2].insufficient, JSON.stringify(sei.map((x) => [x.unit?.id, x.insufficient, x.type])));

// ── 3) 프롬프트
const umArgs = { subTopicCatalog: [{ code: 'a', name: 'b', subject_name: 'c' }], desiredCount: 2, style: 'kmle', topic: 't', keywords: ['k'] };
const umOff = buildPrivateGenerationUserMessage(umArgs);
check('사용자 메시지: 기본은 현행(source_pages·슬라이드 헤더)', umOff === buildPrivateGenerationUserMessage({ ...umArgs, citeMode: 'pages' }) && umOff.includes('source_pages 에 적기') && umOff.includes('자료 전체에서 다양한 챕터'));
const umOn = buildPrivateGenerationUserMessage({ ...umArgs, citeMode: 'evidence' });
check('사용자 메시지: on 은 evidence_refs·단위별 1문항, source_pages 없음', umOn.includes('evidence_refs') && umOn.includes('출제 단위 목록의 단위마다 1문항') && !umOn.includes('source_pages'));
const baseItem = PRIVATE_GENERATION_TOOL_SCHEMA.input_schema.properties.questions.items;
const ragItem = PRIVATE_GENERATION_TOOL_SCHEMA_RAG.input_schema.properties.questions.items;
check('스키마: 현행은 그대로(source_pages 필수, evidence_refs 없음)', baseItem.required.includes('source_pages') && 'source_pages' in baseItem.properties && !('evidence_refs' in baseItem.properties));
check('스키마: on 은 evidence_refs 필수({id, quote} 필수)·source_pages 없음', ragItem.required.includes('evidence_refs') && !ragItem.required.includes('source_pages') && !('source_pages' in ragItem.properties) && JSON.stringify(ragItem.properties.evidence_refs.items.required) === '["id","quote"]');
check('스키마: on 은 나머지 필드·필수 목록이 현행과 같음', JSON.stringify(baseItem.required.filter((f) => f !== 'source_pages')) === JSON.stringify(ragItem.required.filter((f) => f !== 'evidence_refs')) &&
  Object.keys(baseItem.properties).filter((k) => k !== 'source_pages').every((k) => ragItem.properties[k] === baseItem.properties[k]) &&
  PRIVATE_GENERATION_TOOL_SCHEMA_RAG.name === PRIVATE_GENERATION_TOOL_SCHEMA.name);
const vq = { stem: 's', choices: ['a', 'b', 'c', 'd', 'e'], answer_index: 0, explanation: 'x' };
const vOff = buildPrivateVerificationUserMessage({ question: vq, sourceText: 'SRC' });
const vOn = buildPrivateVerificationUserMessage({ question: vq, sourceText: 'SRC', sourceKind: 'evidence' });
check('검증기 입력: 기본은 현행(앞부분만 — 단정 금지)', vOff.includes('앞부분만') && vOff === buildPrivateVerificationUserMessage({ question: vq, sourceText: 'SRC', sourceKind: 'prefix' }));
check('검증기 입력: on 은 근거 전부 — 근거 없으면 3번 항목', vOn.includes('이 문항을 만들 때 준 근거 전부') && vOn.includes('3번 항목') && !vOn.includes('앞부분만'));

// ── 4) 소스 대조
const pg = readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8');
const count = (re) => (pg.match(re) ?? []).length;
check('PG: on 판정은 RAG_MODE === \'on\' 한 곳', /const ragOn = RAG_MODE === 'on';/.test(pg) && count(/RAG_MODE === 'on'/g) === 1);
check('PG: on 에서 선발사 끔', /const canPrefire = !ragOn && batchSizes\.length > 1/.test(pg));
check('PG: 근거 함수는 on 블록 안에서만 만든다', count(/ragEvidenceFor = \(slots\) =>/g) === 1 && /if \(ragOn\) \{[\s\S]{0,4000}ragEvidenceFor = \(slots\) =>/.test(pg) && /let ragEvidenceFor: [^\n]+ = null;/.test(pg));
check('PG: 근거 대기는 상한(RAG_ON_WAIT_MS 45초)·폴백 사유 기록', /const RAG_ON_WAIT_MS = 45_000;/.test(pg) && /onDiag\.fallback = fallback \?\? 'error';/.test(pg) && /'timeout'/.test(pg) && /'no_index'/.test(pg));
check('PG: 생성 묶음·보충 묶음만 근거를 받는다', count(/evidence: \{ ev: [a-zA-Z]+, figureGi: ragFigureGi \}/g) === 2 && /const fillEvidence = ragFillEvidenceFor \? ragFillEvidenceFor\(slots, fillQuotas\[i\]\) : null;/.test(pg));
check('PG: 도구 스키마는 근거가 있을 때만 on 변형', /tools: \[gen\.evidence \? PRIVATE_GENERATION_TOOL_SCHEMA_RAG : PRIVATE_GENERATION_TOOL_SCHEMA\]/.test(pg) && count(/PRIVATE_GENERATION_TOOL_SCHEMA_RAG/g) === 2);
check('PG: 사용자 메시지 citeMode 는 근거가 있을 때만', /\.\.\.\(gen\.evidence \? \{ citeMode: 'evidence' as const \} : \{\}\)/.test(pg));
check('PG: 인용 검사는 buildKept 안, 근거가 있을 때만', /if \(gen\.evidence\) \{\s*cite = verifyCitations\(q\.evidence_refs, gen\.evidence\.ev\.chunks\);/.test(pg));
check('PG: 첫 응답 뒤 인용 교정은 근거가 있을 때만 1회', /let kept: KeptItem\[\] = buildKept\(parsed\.questions, gen\.evidence \? citeFirst : undefined\);\s*if \(gen\.evidence\) kept = await repairCitations\(kept, citeFirst\);/.test(pg) && count(/repairCitations\(/g) === 1 && count(/const repairCitations = async/g) === 1);
const repairBody = pg.slice(pg.indexOf('const repairCitations = async'), pg.indexOf('const citeFirst: CiteRecord[] = [];'));
check('PG: 인용 교정은 생성 호출 1번·비용 기록(citeFix)·새 문항도 인용 검사', (repairBody.match(/callGenerate\(/g) ?? []).length === 1 && /citeFix: true/.test(repairBody) && /buildKept\(fixParsed\.questions, fixLog\)/.test(repairBody) && /totalCost \+= fixCost;/.test(repairBody));
check('PG: 인용 교정은 빈자리만 채움', /added = uncoveredFirst\.slice\(0, need\);/.test(repairBody) && /const need = batchSize - current\.length;/.test(repairBody));
check('PG: 검증기 입력은 근거가 있을 때만 문항 근거 팩', /sourceText: gen\.evidence\s*\? questionEvidenceText\(gen\.evidence\.ev, \(k\.cite\?\.citations \?\? \[\]\)\.map\(\(c\) => c\.ref\), i\)\s*: gen\.contextText,/.test(pg) && /\.\.\.\(gen\.evidence \? \{ sourceKind: 'evidence' as const \} : \{\}\)/.test(pg));
check('PG: 출처는 근거가 있으면 인용에서, 없으면 현행 검사', /if \(gen\.evidence\) \{[\s\S]{0,900}const refs = toStoredRefs\(sourceRefsFromCitations\(cites, contentSha256\)\);\s*row\.source_refs = refs \? \{ \.\.\.refs, retrieval: retrievalRefSnapshot\(packSizeFor\(input\.difficulty \?\? null\)\.size\) \} : null;/.test(pg) && /\} else \{\s*const availablePages = pagesInContext\(gen\.contextText \|\| ''\);/.test(pg));
check('PG: evidence 컬럼 폴백(00045 미적용)', /let evidenceColumnSupported = true;/.test(pg) && /if \(evidenceColumnSupported\) row\.evidence = storedEvidence\(cites\);/.test(pg) && /evidenceColumnSupported = false;/.test(pg));
check('PG: on 묶음 이미지는 이미지 칸 단위 그림만', /const featuredForEvidence = \(ev: BatchEvidence\): BatchImage\[\] =>/.test(pg) && /batchFigureIds\(ev\)/.test(pg));
check('PG: 보충 묶음 이미지도 근거가 있으면 단위 그림만(마지막 라운드 없음)', /fillEvidence\s*\? isLastBackfillRound\s*\? \[\]\s*: featuredForEvidence\(fillEvidence\)\.filter\(\(fi\) => refinedUsableGis\.has\(fi\.gi\)\)\s*: fillFeatured\[i\]/.test(pg));
const onBlock = pg.slice(pg.indexOf('if (ragOn) {\n      const tWaitEvidence'), pg.indexOf('const featuredForEvidence'));
check('PG: on 진단은 수치·사유만(강의 문구 없음)', onBlock.length > 0 && !/topic|objective|hydeStem|\.text\b/.test(onBlock.replace(/run\?\.diag\.error/g, '')), onBlock.slice(0, 80));
check('PG: 인용 진단은 citationStats(수치)만', /batchDiag\.citeFirst = st;/.test(pg) && /batchDiag\.citeFix = citationStats\(/.test(pg) && !/batchDiag\.[a-zA-Z]+ = [^;\n]*quote/.test(pg));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

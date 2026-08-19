/**
 * 재생성 중복 방지(P11) 회귀 검사 — 네트워크·API 키 없이 돈다.
 *
 * 무엇을 지키는가
 *  1) 초점 배정이 **겹치지 않는가**. 배치들이 같은 주제를 맡으면 같은 증례가 또 나온다.
 *  2) 초점이 모자라면 **아무에게도 배정하지 않는가**. 일부 배치만 좁히면 나머지가
 *     그 주제까지 자유롭게 골라 오히려 중복이 는다.
 *  3) 지시문이 "맡은 것"과 함께 **"피할 것"을 말하는가**. 우선순위는 배제가 아니다
 *     (P7 에서 확인: "우선한다"고만 적으면 모델은 추가로 다룰 뿐 그만두지 않는다).
 *  4) 이전 발문을 **앞부분만** 주는가. 전문을 주면 피하라는 지시가 예시로 읽힌다
 *     (few-shot 이 지시를 이긴 사례가 이미 두 번 있었다).
 *  5) 배선 — 같은 sha 의 **다른** 업로드만 보고, 조회가 늦으면 없는 셈 치고 출발하는가.
 *
 *   npm run check:duplicate
 */

import { readFileSync } from 'node:fs';
import {
  extractFocusTopics,
  assignFocus,
  buildFocusDirective,
  buildPriorStemsDirective,
  PRIOR_STEM_LIMIT,
  PRIOR_STEM_CHARS,
} from '../lib/ai/material-outline.ts';
import { buildClinicalQuotaDirective } from '../lib/ai/prompts/clinical-vignette.ts';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n① 초점 추출 — 슬라이드 블록');
const slideText = [
  '## 슬라이드 1 (이미지 0장)',
  '텍스트: 대동맥질환 총론',
  '이 강의는 대동맥의 해부와 질환을 다룬다.',
  '',
  '## 슬라이드 2 (이미지 1장)',
  '텍스트: 복부 대동맥류',
  '지름 5.5 cm 이상이면 수술을 고려한다.',
  '',
  '## 슬라이드 3 (이미지 0장)',
  '텍스트: 대동맥박리 분류',
  'Stanford A 형과 B 형으로 나눈다.',
  '',
  '## 슬라이드 4 (이미지 0장)',
  '텍스트: 감사합니다',
].join('\n');
const topics = extractFocusTopics(slideText);
check('슬라이드 제목을 뽑는다', topics.includes('대동맥질환 총론'), JSON.stringify(topics));
check('두 번째 제목도 뽑는다', topics.includes('복부 대동맥류'));
check('세 번째 제목도 뽑는다', topics.includes('대동맥박리 분류'));
check('"감사합니다" 는 제목이 아니다', !topics.includes('감사합니다'));
check('본문 문장은 제목이 아니다', !topics.some((t) => t.includes('지름 5.5')), JSON.stringify(topics));
// 회귀: 폴백 스캔이 "## 슬라이드 3 (이미지 0장)" 헤더를 초점으로 집던 결함.
// 배정된 초점이 자료의 골격 라벨이면 모델은 "슬라이드 3에 대해 출제하라"는 지시를 받는다.
check('구조 라벨(슬라이드 N)이 초점에 없다', !topics.some((t) => /^슬라이드\s*\d/.test(t)), JSON.stringify(topics));
check('OCR 라벨도 없다', !topics.some((t) => /이미지\s*\(OCR\)/.test(t)));
check('제목 3개만 뽑는다(슬라이드당 하나)', topics.length === 3, JSON.stringify(topics));

console.log('\n①-b 초점 추출 — 슬라이드 구조가 없는 텍스트 PDF');
const pdfText = [
  '대동맥질환',
  '',
  '대동맥은 인체에서 가장 큰 동맥이며 상행, 궁, 하행으로 나뉜다.',
  '',
  '복부 대동맥류',
  '지름 3 cm 이상으로 늘어난 상태를 말한다.',
  '',
  '대동맥박리',
  '내막이 찢어져 혈액이 중막으로 들어간 상태이다.',
].join('\n');
const pdfTopics = extractFocusTopics(pdfText);
check('짧고 문장이 아닌 줄을 소제목으로 본다', pdfTopics.includes('복부 대동맥류'), JSON.stringify(pdfTopics));
check('문장은 제외한다', !pdfTopics.some((t) => t.includes('나뉜다')), JSON.stringify(pdfTopics));

console.log('\n② 초점 추출 — 제목이 없는 자료');
const flat = '이 문서는 한 문단으로만 되어 있고 소제목이 전혀 없다. '.repeat(20);
check('제목이 없으면 빈 배열', extractFocusTopics(flat).length === 0, JSON.stringify(extractFocusTopics(flat)));
check('빈 텍스트도 빈 배열', extractFocusTopics('').length === 0);
const dup = ['## 슬라이드 1 (이미지 0장)', '텍스트: 같은 제목', '', '## 슬라이드 2 (이미지 0장)', '텍스트: 같은 제목'].join('\n');
check('중복 제목은 한 번만', extractFocusTopics(dup).length === 1, JSON.stringify(extractFocusTopics(dup)));

console.log('\n③ 초점 배정 — 겹치지 않을 것');
const nine = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const assigns = [0, 1, 2].map((i) => assignFocus(nine, i, 3));
const mineAll = assigns.flatMap((a) => a.mine);
check('세 배치가 9개를 남김없이 나눈다', mineAll.length === 9 && new Set(mineAll).size === 9, JSON.stringify(assigns.map((a) => a.mine)));
check('배치 0 은 앞 3개', assigns[0].mine.join('') === 'ABC', assigns[0].mine.join(''));
check('배치 2 는 뒤 3개', assigns[2].mine.join('') === 'GHI', assigns[2].mine.join(''));
check('others 에 자기 몫이 없다', assigns[0].others.every((t) => !assigns[0].mine.includes(t)));
// 나눠떨어지지 않는 경우 — 앞쪽 배치가 하나씩 더 가져간다(결정론적 경계).
const seven = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const un = [0, 1, 2].map((i) => assignFocus(seven, i, 3).mine);
check('7개를 3배치로: 3+2+2', un.map((m) => m.length).join(',') === '3,2,2', un.map((m) => m.length).join(','));
check('나눠떨어지지 않아도 겹치지 않는다', new Set(un.flat()).size === 7);
check(
  '같은 입력이면 같은 배정(결정론)',
  JSON.stringify(assignFocus(seven, 1, 3)) === JSON.stringify(assignFocus(seven, 1, 3)),
);

console.log('\n④ 초점이 모자라면 배정하지 않는다');
check('초점 2개 < 배치 3개 → 아무도 배정 없음', [0, 1, 2].every((i) => assignFocus(['A', 'B'], i, 3).mine.length === 0));
check('배치가 1개면 배정 없음', assignFocus(nine, 0, 1).mine.length === 0);
check('초점이 없으면 배정 없음', assignFocus([], 0, 3).mine.length === 0);

console.log('\n⑤ 초점 지시문');
const directive = buildFocusDirective(assignFocus(nine, 0, 3));
check('맡은 주제를 적는다', /이번 묶음은 다음 주제에서만 출제한다/.test(directive));
check('피할 주제를 적는다(우선순위가 아니라 배제)', /출제하지 않는다/.test(directive));
check('증례 중복 금지를 함께 건다', /같은 환자·같은 주 증상으로 시작하지 않는다/.test(directive));
check('배정이 없으면 빈 문자열', buildFocusDirective({ mine: [], others: [] }) === '');

console.log('\n⑥ 이전 발문 지시문 (세션 간)');
const longStem = '65세 남자가 갑작스러운 등 통증으로 병원에 왔다. 혈압은 180/100 mmHg 이고 맥박은 분당 96회이다. 진단은?';
const priorDirective = buildPriorStemsDirective([longStem, '', '   ']);
check(`발문을 ${PRIOR_STEM_CHARS}자에서 자른다`, priorDirective.includes(`${longStem.slice(0, PRIOR_STEM_CHARS)}…`), priorDirective);
check('빈 발문은 버린다', (priorDirective.match(/^- /gm) ?? []).length === 1);
check('같은 것을 묻지 말라고 지시', /같은 것을 묻지 않는다/.test(priorDirective));
check('같은 정답 조합 금지', /같은 정답 조합/.test(priorDirective));
check('발문이 없으면 빈 문자열', buildPriorStemsDirective([]) === '');
const many = Array.from({ length: PRIOR_STEM_LIMIT + 20 }, (_, i) => `발문 ${i}`);
check(
  `최대 ${PRIOR_STEM_LIMIT}개만 싣는다`,
  (buildPriorStemsDirective(many).match(/^- /gm) ?? []).length === PRIOR_STEM_LIMIT,
);

console.log('\n⑦ 임상형 쿼터 지시에 증례 반복 금지가 붙는가');
const clinical = buildClinicalQuotaDirective(5, 5);
check('증례가 서로 달라야 한다고 말한다', /증례는 서로 달라야 합니다/.test(clinical));
check('묶음 사이도 포함', /다른 묶음과도/.test(clinical));
check('쿼터가 0 이면 지시 없음', buildClinicalQuotaDirective(5, 0) === '');

console.log('\n⑧ 배선');
const gen = stripComments(read('../lib/ai/private-generation.ts'));
check('초점을 추출한다', /extractFocusTopics\(/.test(gen));
check('배치마다 배정한다', /assignFocus\(focusTopics, batchIndex, batchCount\)/.test(gen));
check('초점 지시문을 프롬프트에 붙인다', /\$\{focusDirective\}/.test(gen));
check('이전 발문 지시문도 붙인다', /\$\{priorDirective\}/.test(gen));
check('같은 sha 로 이전 업로드를 찾는다', /\.eq\('content_sha256', contentSha256\)/.test(gen));
check('현재 업로드는 제외한다', /\.neq\('id', upload\.id\)/.test(gen));
check('사용자 것만 본다', /\.eq\('user_id', upload\.user_id\)/.test(gen));
check('조회가 늦으면 없는 셈 치고 출발', /withDeadline\(priorStemsPromise/.test(gen));
check('조회 실패가 생성을 막지 않는다', /이전 발문 조회 실패\(생략\)/.test(read('../lib/ai/private-generation.ts')));
check('초점 개수를 진단에 남긴다', /focusTopicCount/.test(gen));

console.log('');
if (failures === 0) {
  console.log('✅ 전부 통과');
  process.exit(0);
}
console.log(`❌ ${failures}건 실패`);
process.exit(1);

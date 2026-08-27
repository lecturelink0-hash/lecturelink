#!/usr/bin/env node
/**
 * 난이도 조건 계수 회귀 검사 — lib/ai/difficulty-conditions.ts + 프롬프트 배선
 *
 * 왜 있는가 (2026-08-27 실측, 업로드 effbfdf0 — 난이도 '상')
 *  10문항 중 7문항이 difficulty 3 을 신고했지만 전부 사실 하나를 묻는 재인 문항이었다.
 *  원인 ① 프롬프트 '상' 정의가 "…중 하나를 포함"(하나만 있어도 상) ② 숫자 자기신고뿐이라
 *  서버가 대조할 근거가 없었다. 이제 사용자 정의("3가지 이상 조건·지식 결합")를 셀 수 있게
 *  `solution_conditions` 목록으로 받고 서버가 센다. 이 검사는 계수기와 배선을 고정한다.
 *
 *   npm run check:difficulty   (네트워크 불필요)
 */
import { readFileSync } from 'node:fs';
import {
  CONDITIONS_REQUIRED,
  countAnchoredConditions,
  countDistinctConditions,
  effectiveDifficulty,
  isConditionAnchored,
  levelFromConditions,
  meetsRequestedLevel,
  structuralConditionCount,
} from '../lib/ai/difficulty-conditions.ts';
import { PRIVATE_GENERATION_TOOL_SCHEMA } from '../lib/ai/prompts/private-generation.ts';
import {
  CONDITION_JUDGE_SYSTEM_PROMPT,
  CONDITION_JUDGE_TOOL_SCHEMA,
  buildConditionJudgeUserMessage,
} from '../lib/ai/prompts/condition-judge.ts';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

console.log('① 조건 수 세기');
check('빈 값·비배열은 0', countDistinctConditions(undefined) === 0 && countDistinctConditions('x') === 0 && countDistinctConditions([]) === 0);
check('서로 다른 3개는 3', countDistinctConditions(['Stanford A형 박리', '급성 대동맥판 역류 동반', '직경 5.5 cm 초과']) === 3);
check('말만 바꾼 중복(부분 문자열)은 하나로', countDistinctConditions(['혈압 180/100', '혈압 180/100 mmHg 로 상승']) === 1);
check('공백·구두점·대소문자 차이는 같은 조건', countDistinctConditions(['Marfan 증후군', 'marfan증후군.']) === 1);
check('너무 짧은 항목은 세지 않는다', countDistinctConditions(['CT', '박리']) === 0);
check('문자열 아닌 항목은 무시', countDistinctConditions([null, 3, '65세 남자 흉통', { a: 1 }]) === 1);

console.log('\n② 수준 대응 — 하 1 · 중 2 · 상 3+');
check('요구 개수 1/2/3', CONDITIONS_REQUIRED[1] === 1 && CONDITIONS_REQUIRED[2] === 2 && CONDITIONS_REQUIRED[3] === 3);
check('0~1개 → 1', levelFromConditions(0) === 1 && levelFromConditions(1) === 1);
check('2개 → 2', levelFromConditions(2) === 2);
check('3개·5개 → 3', levelFromConditions(3) === 3 && levelFromConditions(5) === 3);

console.log('\n③ 저장 난이도 = 신고값과 구조 수준 중 낮은 쪽');
const three = ['Stanford A형', '대동맥판 역류 동반', '직경 5.5 cm 초과'];
check('3 신고 + 조건 1개 → 1(실측 사고 형태)', effectiveDifficulty(3, ['가성 동맥류의 기전']) === 1);
check('3 신고 + 조건 3개 → 3', effectiveDifficulty(3, three) === 3);
check('2 신고 + 조건 3개 → 2(신고가 낮으면 신고)', effectiveDifficulty(2, three) === 2);
check('신고 누락 + 조건 3개 → 1(신고 없음은 1)', effectiveDifficulty(undefined, three) === 1);

console.log('\n④ 요청 수준 충족 판정은 구조로만');
check('상 요청·조건 2개 → 미충족', !meetsRequestedLevel(['a b c d', 'e f g h'], 3));
check('상 요청·조건 3개 → 충족', meetsRequestedLevel(three, 3));
check('중 요청·조건 2개 → 충족', meetsRequestedLevel(['65세 남자 흉통', '혈압 180/100'], 2));

console.log('\n④-2 어휘 대조 — 발문·선지·해설에 흔적 없는 항목은 세지 않는다 (2차 실측 01ae08ab)');
{
  // 실측 슬롯 8: "대동맥 박리에서 혈압 조절을 위한 약물 치료 시 금기 약물은?" — 사실 하나인데 조건 3개를 신고했다.
  const stem8 = '대동맥 박리(Aortic dissection)에서 혈압 조절을 위한 약물 치료 시 금기 약물은?';
  const choices8 = ['하이드랄라진 (hydralazine)', '메토프롤롤 (metoprolol)', '에스몰롤 (esmolol)', '프로프라놀롤 (propranolol)', '라베탈롤 (labetalol)'];
  const expl8 = '직접적인 혈관 확장제인 하이드랄라진을 단독으로 사용하는 것은 금기이다. 심근 수축력 및 맥압 상승 속도(dP/dt)를 증가시켜 박리 진행을 촉진할 수 있기 때문이다.';
  const texts8 = [stem8, ...choices8, expl8];
  check('발문에 있는 조건은 대조 통과', isConditionAnchored('대동맥 박리에서 혈압 조절', texts8));
  check('해설에 있는 지식은 대조 통과', isConditionAnchored('hydralazine 은 dP/dt 를 증가시킨다', texts8));
  check('어디에도 없는 항목은 탈락', !isConditionAnchored('Stanford B형은 내과적 치료가 원칙', texts8));
  check('조사 붙은 어절도 대조된다("대동맥판막의")', isConditionAnchored('이첨판 대동맥판막의 동반', ['이첨판 대동맥판막이 있는 환자']));
  check(
    '부풀린 목록에서 창작 항목만 빠진다(3→2)',
    countAnchoredConditions(['대동맥 박리 진단', 'hydralazine 단독 사용 금기', 'Stanford B형 내과 치료 원칙'], texts8) === 2,
  );
  check('빈 본문이면 0', countAnchoredConditions(['대동맥 박리'], ['']) === 0);
}

console.log('\n④-3 독립 판정기 결합 — 구조 수 = min(대조 통과 자기신고, 판정기)');
{
  const three = ['Stanford A형 박리', '급성 대동맥판 역류 동반', '직경 5.5 cm 초과'];
  const texts = ['Stanford A형 박리에 급성 대동맥판 역류가 동반되고 직경이 5.5 cm 를 넘는다. 치료는?', '응급 수술', '내과 치료', '', '', '', ''];
  check('판정기 없음(undefined)이면 자기신고 수', structuralConditionCount(three, texts, undefined) === 3);
  check('판정기 못 돌림(null)이면 자기신고 수', structuralConditionCount(three, texts, null) === 3);
  check('판정기가 1이라 하면 1(부풀림 차단)', structuralConditionCount(three, texts, 1) === 1);
  check('판정기가 5라 해도 자기신고 3을 넘지 않는다', structuralConditionCount(three, texts, 5) === 3);
  check('저장 난이도: 3 신고 + 목록 3 + 판정기 1 → 1', effectiveDifficulty(3, three, texts, 1) === 1);
  check('저장 난이도: 3 신고 + 목록 3 + 판정기 3 → 3', effectiveDifficulty(3, three, texts, 3) === 3);
  check('요청 상 충족 판정도 판정기를 본다', !meetsRequestedLevel(three, 3, texts, 2) && meetsRequestedLevel(three, 3, texts, 3));
}

console.log('\n④-4 판정기 프롬프트 — 부풀림을 가르는 규칙이 박혀 있다');
check('"빼도 정답이 유일하면 조건이 아니다" 규칙', CONDITION_JUDGE_SYSTEM_PROMPT.includes('빼도 정답이 여전히 유일하게 정해지면'));
check('장식 정보(나이·성별)는 세지 않는다', CONDITION_JUDGE_SYSTEM_PROMPT.includes('장식'));
check('사실 하나면 1개라고 명시', CONDITION_JUDGE_SYSTEM_PROMPT.includes('**1개**'));
check('기권 없음(목록 최소 1개)', CONDITION_JUDGE_SYSTEM_PROMPT.includes('최소 1개'));
// 3차 실측(009b69fb): "선지 소거 지식도 센다" 규칙 때문에 단일 사실 문항이 4~6개로 판정됐다.
check('오답 소거 지식은 세지 않는다', CONDITION_JUDGE_SYSTEM_PROMPT.includes('세지 않습니다 — 5지선다는'));
check('종전 "소거에 쓰인 지식도 조건으로 셉니다" 규칙이 사라졌다', !CONDITION_JUDGE_SYSTEM_PROMPT.includes('소거에 쓰인 지식도 조건으로 셉니다'));
check('"설명으로 옳은 것은?" 형태는 1개', CONDITION_JUDGE_SYSTEM_PROMPT.includes('설명으로 옳은 것은?'));
check(
  '생성 모델의 목록을 판정기에 보여 주지 않는다(넘겨도 무시)',
  !buildConditionJudgeUserMessage({ stem: 's', choices: ['a', 'b'], answerIndex: 0, conditions: ['x-secret-list'] }).includes('x-secret-list'),
);
check('도구 스키마가 conditions·count·basis 를 요구', ['conditions', 'count', 'basis'].every((k) => CONDITION_JUDGE_TOOL_SCHEMA.input_schema.required.includes(k)));
check('정답 번호를 1-based 로 알려 준다', buildConditionJudgeUserMessage({ stem: 's', choices: ['a', 'b'], answerIndex: 1 }).includes('정답: 2번'));

console.log('\n⑤ 배선 — 스키마·프롬프트·생성기');
const item = PRIVATE_GENERATION_TOOL_SCHEMA.input_schema.properties.questions.items;
check('스키마에 solution_conditions 가 있다', !!item.properties.solution_conditions);
check('solution_conditions 가 required 다', item.required.includes('solution_conditions'));
check('difficulty 설명이 목록 수 기준을 말한다', item.properties.difficulty.description.includes('solution_conditions'));
const gen = readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8');
check('"상" 정의가 3개 이상 결합을 요구한다', /난이도 상\(분석\) — 서로 다른 조건·지식 3개 이상을 결합/.test(gen));
check('종전 "…중 하나를 반드시 포함" 정의가 사라졌다', !/용량 조절 중 하나를 반드시 포함/.test(gen));
check('이미지형 난이도 지침이 있다', gen.includes('IMAGE_DIFFICULTY_DIRECTIVES'));
check('저장 난이도에 effectiveDifficulty 를 쓴다', /difficulty: effectiveDifficulty\(\s*k\.q\.difficulty,\s*k\.q\.solution_conditions,/.test(gen));
check('조건 부족을 계측한다', /bumpGenDiag\('difficultyShortfall'\)/.test(gen));
check('조건이 모자라면 1회 교정 재생성한다', /bumpGenDiag\('difficultyFixed'\)/.test(gen));
check('요청 상이면 첫 묶음 "기본 개념" 지시를 끈다', /requestedDifficultyLevel === 3\s*\?\s*' 요청 난이도가 상이므로/.test(gen));
check('독립 판정기를 게이트 전에 돌린다', /await judgeAll\(kept\)/.test(gen) && /bumpGenDiag\('judgeChecked'\)/.test(gen));
check('재작성본도 판정기를 거친다', /await judgeAll\(fixKept\)/.test(gen));
check('저장 난이도에 어휘 대조·판정기 수를 넘긴다', /effectiveDifficulty\(\s*k\.q\.difficulty,\s*k\.q\.solution_conditions,\s*\[String\(k\.q\.stem/.test(gen));
check('판정기 실패는 통과(null)로 처리한다', /k\.judgeCount = null/.test(gen));
check('판정기 비용을 private\\.judge 로 기록한다', gen.includes("endpoint: 'private.judge'"));
check('발문 규칙(금지 발문)을 모든 묶음에 건다', /const askRuleDirective =/.test(gen) && /\$\{askRuleDirective\}\$\{comboDirective\}/.test(gen));
check('요청 상이면 조건 나열식 발문을 금지한다', gen.includes('모두 고려했을 때" 식으로 나열해 이어 붙이지 말고'));
check('유형 교정이 함수라 2차 패스를 돈다', /const runTypeRepair = async/.test(gen) && /\(await runTypeRepair\(\)\) > 0/.test(gen));
check('생성기가 금지 발문을 코드로 고쳐 쓴다', /rewriteForbiddenAsk\(rawStem\)/.test(gen) && /bumpGenDiag\('forbiddenAskFixed'\)/.test(gen));
check('"(이미지 좌측)" 위치 메모를 지운다', /좌측\|우측/.test(gen));

console.log('');
if (failures === 0) {
  console.log('✅ 전부 통과');
  process.exit(0);
}
console.log(`❌ ${failures}건 실패`);
process.exit(1);

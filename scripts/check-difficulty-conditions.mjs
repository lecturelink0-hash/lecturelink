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
  countDistinctConditions,
  effectiveDifficulty,
  levelFromConditions,
  meetsRequestedLevel,
} from '../lib/ai/difficulty-conditions.ts';
import { PRIVATE_GENERATION_TOOL_SCHEMA } from '../lib/ai/prompts/private-generation.ts';

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

console.log('\n⑤ 배선 — 스키마·프롬프트·생성기');
const item = PRIVATE_GENERATION_TOOL_SCHEMA.input_schema.properties.questions.items;
check('스키마에 solution_conditions 가 있다', !!item.properties.solution_conditions);
check('solution_conditions 가 required 다', item.required.includes('solution_conditions'));
check('difficulty 설명이 목록 수 기준을 말한다', item.properties.difficulty.description.includes('solution_conditions'));
const gen = readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8');
check('"상" 정의가 3개 이상 결합을 요구한다', /난이도 상\(분석\) — 서로 다른 조건·지식 3개 이상을 결합/.test(gen));
check('종전 "…중 하나를 반드시 포함" 정의가 사라졌다', !/용량 조절 중 하나를 반드시 포함/.test(gen));
check('이미지형 난이도 지침이 있다', gen.includes('IMAGE_DIFFICULTY_DIRECTIVES'));
check('저장 난이도에 effectiveDifficulty 를 쓴다', /difficulty: effectiveDifficulty\(k\.q\.difficulty, k\.q\.solution_conditions\)/.test(gen));
check('조건 부족을 계측한다', /bumpGenDiag\('difficultyShortfall'\)/.test(gen));
check('조건이 모자라면 1회 교정 재생성한다', /bumpGenDiag\('difficultyFixed'\)/.test(gen));
check('요청 상이면 첫 묶음 "기본 개념" 지시를 끈다', /requestedDifficultyLevel === 3\s*\?\s*' 요청 난이도가 상이므로/.test(gen));

console.log('');
if (failures === 0) {
  console.log('✅ 전부 통과');
  process.exit(0);
}
console.log(`❌ ${failures}건 실패`);
process.exit(1);

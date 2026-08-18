/**
 * 내신대비 검증 1패스(P1) 회귀 검사 — 네트워크·API 키 없이 돈다.
 *
 * 무엇을 지키는가
 *  1) 폐기 기준이 결정대로인가 (severity critical/major **또는** score < 0.6).
 *     severity 와 score 는 서로를 보정하지 않는다 — 모델이 major 라 말하면서 0.8 을 주는
 *     경우가 있어 둘 중 하나만 걸려도 후보다.
 *  2) private 모드 프롬프트가 **형식을 판정하지 않는가**.
 *     공유풀 프롬프트는 절반이 F 규격이라, 그대로 쓰면 모델이 형식 지적으로 issues 를
 *     채우고 정작 의학 오류를 놓친다. 이 검사가 그 회귀를 잡는다.
 *  3) 자료 원문이 12k 자에서 잘리는가, 없을 때 "판정하지 말라"고 명시하는가.
 *
 *   npm run check:verify
 */

import {
  PRIVATE_VERIFICATION_SYSTEM_PROMPT,
  PRIVATE_VERIFICATION_SOURCE_CHARS,
  VERIFICATION_SYSTEM_PROMPT,
  buildPrivateVerificationUserMessage,
} from '../lib/ai/prompts/verification.ts';
import { isPrivateVerifyFailure, PRIVATE_VERIFY_REJECT_SCORE } from '../lib/ai/verify-policy.ts';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n① 폐기 기준 (severity critical/major 또는 score < 0.6)');
const truthTable = [
  { severity: 'critical', score: 0.99, expect: true, why: 'critical 은 점수와 무관' },
  { severity: 'major', score: 0.80, expect: true, why: 'major 는 점수와 무관' },
  { severity: 'minor', score: 0.59, expect: true, why: '점수 미달' },
  { severity: 'minor', score: 0.60, expect: false, why: '경계값은 통과' },
  { severity: 'minor', score: 0.95, expect: false, why: 'minor 만으로는 폐기 안 함' },
  { severity: 'none', score: 1.0, expect: false, why: '통과' },
  { severity: 'none', score: 0.1, expect: true, why: 'severity 가 none 이어도 점수가 낮으면 후보' },
];
for (const row of truthTable) {
  const got = isPrivateVerifyFailure({ severity: row.severity, score: row.score });
  check(
    `${row.severity}/${row.score} → ${row.expect ? '폐기 후보' : '통과'} (${row.why})`,
    got === row.expect,
    `실제 ${got}`,
  );
}
check('기준 점수 상수 = 0.6', PRIVATE_VERIFY_REJECT_SCORE === 0.6);

console.log('\n② private 프롬프트가 형식을 판정하지 않는가');
const p = PRIVATE_VERIFICATION_SYSTEM_PROMPT;
check('형식 미판정 지시가 있다', /절대 지적하지 마십시오/.test(p));
check('발문 문형을 판정 제외로 명시', /가장 적절한 것은\?/.test(p) && /판정하지 않는 것/.test(p));
check('선지 정렬·종결형을 판정 제외로 명시', /선지 길이·정렬·종결형/.test(p));
check('"남성/여성" 표기를 판정 제외로 명시', /남성\/여성/.test(p));

// 공유풀 프롬프트에만 있어야 하는 F 규격 지시가 private 에 새어 들어오지 않았는지.
const sharedOnly = [
  '글자 수 짧은 것부터 오름차순',
  '혈압 → 맥박 → 호흡 → 체온',
  '검사 결과는 다음과 같다',
];
for (const phrase of sharedOnly) {
  check(
    `공유풀 전용 지시가 private 에 없다: "${phrase.slice(0, 18)}…"`,
    VERIFICATION_SYSTEM_PROMPT.includes(phrase) && !p.includes(phrase),
  );
}

console.log('\n③ 판정 대상 네 가지가 모두 들어 있는가');
check('1 의학적 오류', /의학적 오류/.test(p));
check('2 정답-해설 불일치', /정답과 해설의 불일치/.test(p));
check('3 정답 근거가 자료에 없음', /정답 근거가 자료에 없음/.test(p));
check('4 해설이 오답 사유를 안 다룸', /오답 사유를 다루지 않음/.test(p));
check('자료 절삭을 모델에게 알린다', /앞부분만 잘려/.test(p));

console.log('\n④ 사용자 메시지');
const question = {
  stem: '도파민 경로에 대한 설명으로 옳은 것은?',
  choices: ['가', '나', '다', '라', '마'],
  answer_index: 2,
  explanation: '도파민은 억제성 신경전달물질로 운동 조절에 관여하며…',
};
const longSource = '가'.repeat(PRIVATE_VERIFICATION_SOURCE_CHARS + 5_000);
const withSource = buildPrivateVerificationUserMessage({ question, sourceText: longSource });
const withoutSource = buildPrivateVerificationUserMessage({ question });

check(
  `자료 원문이 ${PRIVATE_VERIFICATION_SOURCE_CHARS}자에서 잘린다`,
  (withSource.match(/가/g) ?? []).length <= PRIVATE_VERIFICATION_SOURCE_CHARS + 20,
  `실제 ${(withSource.match(/가/g) ?? []).length}자`,
);
check('자료가 있으면 "단정하지 말 것" 경고를 붙인다', /단정하지 말 것/.test(withSource));
check('자료가 없으면 3번 항목을 판정하지 말라고 한다', /3번 항목\(자료 근거\)은 판정하지 마십시오/.test(withoutSource));
check('정답 번호를 1-based 로 표시', withoutSource.includes('**모델이 표시한 정답**: 3번'));
check('해설을 그대로 싣는다', withoutSource.includes(question.explanation));
check('선지를 1~5 로 번호 매긴다', /1\. 가\n2\. 나\n3\. 다\n4\. 라\n5\. 마/.test(withoutSource));
// 공유풀 메시지의 과목/소주제 헤더가 private 에 새면 모델이 분류를 판정하려 든다.
check('과목·소주제 컨텍스트를 싣지 않는다', !/## 컨텍스트/.test(withoutSource));

console.log('');
if (failures === 0) {
  console.log('✅ 전부 통과');
  process.exit(0);
}
console.log(`❌ ${failures}건 실패`);
process.exit(1);

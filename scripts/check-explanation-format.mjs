/**
 * 해설 규격(P12) 회귀 검사 — 네트워크·API 키 없이 돈다.
 *
 * 무엇을 지키는가
 *  1) 어미 변환이 **의미를 바꾸지 않는가**. 형용사/동사를 잘못 가르면
 *     "필요합니다 → 필요한다", "물질입니다 → 물질인다" 같은 비문이 나간다.
 *     이 검사가 그 회귀를 잡는다 — 표를 늘릴 때 사례를 함께 늘린다.
 *  2) **부분 변환을 하지 않는가**. 모르는 어미가 하나라도 있으면 원문 그대로 둔다.
 *     반만 바꾼 해설은 한 문단에서 톤이 갈려 안 바꾼 것보다 나쁘다.
 *  3) 평서형 "아니다"를 존댓말로 오인하지 않는가(=/[가-힣]+니다/ 만으로 판정하면 오인한다).
 *  4) 길이를 **자르지 않는가**. 의학 해설을 글자 수로 자르면 틀린 문항이 된다.
 *  5) 프롬프트가 구조·문체를 지시하는가, 그리고 **검증 프롬프트와 충돌하지 않는가**
 *     (private 검증은 "분량·문체를 지적하지 말라"고 못박혀 있다).
 *
 *   npm run check:explanation
 */

import { readFileSync } from 'node:fs';
import {
  normalizeExplanation,
  hasPoliteEnding,
  countDistractorsMentioned,
  EXPLANATION_TARGET_CHARS,
  EXPLANATION_SOFT_LIMIT_CHARS,
  MIN_DISTRACTORS_MENTIONED,
} from '../lib/ai/explanation-format.ts';
import { PRIVATE_GENERATION_SYSTEM_PROMPT } from '../lib/ai/prompts/private-generation.ts';
import { PRIVATE_VERIFICATION_SYSTEM_PROMPT } from '../lib/ai/prompts/verification.ts';

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

console.log('\n① 어미 변환 — 명사+이다 / 하다형 형용사 / 동사');
const conversions = [
  ['도파민은 억제성 신경전달물질입니다.', '도파민은 억제성 신경전달물질이다.', '명사+이다'],
  ['감염이 원인입니다.', '감염이 원인이다.', '명사+이다'],
  ['즉시 항생제를 투여합니다.', '즉시 항생제를 투여한다.', '하다 동사'],
  ['수술적 치료가 필요합니다.', '수술적 치료가 필요하다.', '하다 형용사'],
  ['재발이 흔합니다.', '재발이 흔하다.', '하다 형용사'],
  ['혈압이 상승됩니다.', '혈압이 상승된다.', '되다'],
  ['자연 관해될 가능성이 있습니다.', '자연 관해될 가능성이 있다.', '있다'],
  ['두 군 사이에 차이가 없습니다.', '두 군 사이에 차이가 없다.', '없다'],
  ['발열과 발진이 나타납니다.', '발열과 발진이 나타난다.', '모음 어간 동사'],
  ['흉부 X선에서 침윤이 보입니다.', '흉부 X선에서 침윤이 보인다.', '어간이 이로 끝나는 동사'],
  ['조직검사를 시행하였습니다.', '조직검사를 시행하였다.', '과거형'],
  ['진단을 확인했습니다.', '진단을 확인했다.', '과거형 축약'],
  ['재발 빈도가 높습니다.', '재발 빈도가 높다.', '자음 어간 형용사'],
  ['경구약을 먹습니다.', '경구약을 먹는다.', '자음 어간 동사'],
  ['이것은 정답이 아닙니다.', '이것은 정답이 아니다.', '아니다'],
  ['증상이 명확하지 않습니다.', '증상이 명확하지 않다.', '보조용언 + 형용사'],
  ['합병증은 발생하지 않습니다.', '합병증은 발생하지 않는다.', '보조용언 + 동사'],
  ['항생제를 만듭니다.', '항생제를 만든다.', 'ㄹ 탈락'],
  ['진행이 빠릅니다.', '진행이 빠르다.', '르 형용사'],
  ['병변이 큽니다.', '병변이 크다.', '모음 어간 형용사'],
];
for (const [input, expected, why] of conversions) {
  const got = normalizeExplanation(input);
  check(`${why}: ${input} → ${expected}`, got.text === expected, `실제 "${got.text}"`);
}

console.log('\n② 부분 변환 금지 (모르는 어미가 있으면 통째로 포기)');
// "웃습니다" 는 자음 어간 동사인데 변환표에 없다 — 형용사(웃다? 없음)/동사를 어미만으로
// 가를 수 없어 일부러 넣지 않았다. 이런 어미가 하나라도 있으면 문장 전체를 손대지 않는다.
const mixed = '치료가 필요합니다. 환자가 크게 웃습니다.';
const mixedResult = normalizeExplanation(mixed);
check('모르는 어미가 있으면 원문 그대로', mixedResult.text === mixed, `실제 "${mixedResult.text}"`);
check('changed 는 false', mixedResult.changed === false);
check('미해결 어미를 보고한다', mixedResult.unresolved.length > 0, JSON.stringify(mixedResult.unresolved));
const question = '어떤 검사를 시행합니까?';
check('의문형이 있으면 손대지 않는다', normalizeExplanation(question).text === question);

console.log('\n③ 평서형을 존댓말로 오인하지 않는가');
const plain = '②는 감별질환이지만 발열이 없어 아니다. 기전이 다르다.';
check('"아니다"를 그대로 둔다', normalizeExplanation(plain).text === plain);
check('hasPoliteEnding("…아니다") = false', hasPoliteEnding(plain) === false);
check('hasPoliteEnding("…입니다") = true', hasPoliteEnding('원인입니다.') === true);
check('빈 해설은 그대로', normalizeExplanation('').text === '');

console.log('\n④ 길이 — 재기만 하고 자르지 않는다');
const long = '가'.repeat(EXPLANATION_SOFT_LIMIT_CHARS + 300);
check('상한 상수 350 / 경고 400', EXPLANATION_TARGET_CHARS === 350 && EXPLANATION_SOFT_LIMIT_CHARS === 400);
check('긴 해설도 길이가 그대로', normalizeExplanation(long).text.length === long.length);
const gen = stripComments(read('../lib/ai/private-generation.ts'));
check(
  '파이프라인이 해설을 자르지 않는다(slice 로 잘라 저장하지 않음)',
  !/explanation[^\n]*\.slice\(/.test(gen),
);
check('길이 초과를 카운터로 남긴다', /bumpGenDiag\('explanationTooLong'\)/.test(gen));

console.log('\n⑤ 오답 언급');
const cover = countDistractorsMentioned({
  explanation:
    '급성 심근경색이다. ②는 폐색전증으로 흉통 양상이 다르다. ③ 대동맥박리는 맥압 차가 있다. ④ 기흉은 호흡음이 감소한다. ⑤ 심낭염은 자세에 따라 변한다.',
  choices: ['급성 심근경색', '폐색전증', '대동맥박리', '기흉', '심낭염'],
  answerIndex: 0,
});
check('오답 4개를 모두 다루면 4', cover.mentioned === 4 && cover.total === 4, JSON.stringify(cover));
const thin = countDistractorsMentioned({
  explanation: '급성 심근경색이다. 심전도에서 ST 분절이 상승한다.',
  choices: ['급성 심근경색', '폐색전증', '대동맥박리', '기흉', '심낭염'],
  answerIndex: 0,
});
check('정답만 설명하면 0', thin.mentioned === 0, JSON.stringify(thin));
check('누락 번호를 1-based 로 알려 준다', thin.missing.join(',') === '2,3,4,5', thin.missing.join(','));
check('기준 상수 = 3/4', MIN_DISTRACTORS_MENTIONED === 3);
check('부족하면 카운터로 남긴다', /bumpGenDiag\('explanationThinDistractors'\)/.test(gen));

console.log('\n⑥ 배선');
check('저장 전에 어미를 통일한다', /normalizeExplanation\(String\(k\.q\.explanation/.test(gen));
check('정규화한 해설을 저장한다', /\n\s+explanation,\n/.test(gen));
check('변환 성공을 계측한다', /bumpGenDiag\('explanationToneFixed'\)/.test(gen));
check('변환 포기도 계측한다', /bumpGenDiag\('explanationToneUnresolved'\)/.test(gen));

console.log('\n⑦ 프롬프트 — 구조·문체 지시, 그리고 검증과 충돌하지 않을 것');
const p = PRIVATE_GENERATION_SYSTEM_PROMPT;
check('해설 구조를 고정한다', /해설의 구조를 고정한다/.test(p));
check('정답 근거 2문장', /정답이 옳은 임상적 근거 \*\*2문장\*\*/.test(p));
check('오답 4개 각각 한 문장', /오답 4개를 각각 한 문장씩/.test(p));
check('번호로 지목하는 예시가 있다', /②는 발열이 없어 아니다/.test(p));
check('평서체를 명시한다', /평서체\(~이다 \/ ~한다\)로 통일한다/.test(p));
check('존댓말 금지를 명시한다', /"~입니다", "~합니다"/.test(p));
check('350자 상한이 남아 있다', /350자 이내/.test(p));

// 검증 프롬프트는 "분량·문체를 지적하지 말라"고 못박혀 있다. 거기에 길이 규칙을 넣으면
// 같은 프롬프트가 서로 반대되는 말을 하게 된다(P3 에서 확인된 실패 양식).
const v = PRIVATE_VERIFICATION_SYSTEM_PROMPT;
check('검증 프롬프트는 여전히 문체·분량을 판정하지 않는다', /문체·어미·분량/.test(v));
check('검증 프롬프트에 글자 수 규칙이 없다', !/350자|400자/.test(v));

console.log('');
if (failures === 0) {
  console.log('✅ 전부 통과');
  process.exit(0);
}
console.log(`❌ ${failures}건 실패`);
process.exit(1);

/**
 * 이미지형 블라인드 풀이 검사(P9) 회귀 검사 — 네트워크·API 키 없이 돈다.
 *
 * 무엇을 지키는가
 *  1) 폐기 판정이 결정대로인가 — **독립 시도 전부가 정답일 때만** 폐기.
 *     하나라도 틀리거나 못 푼(null) 시도가 있으면 판정하지 않는다.
 *     이 경계가 느슨해지면(과반 등) 우연 정답률이 4 %에서 10 % 이상으로 뛰어
 *     멀쩡한 이미지 문항을 찍기로 잃는다.
 *  2) 프롬프트가 **기권을 허용하지 않는가**. "그림이 없어 알 수 없다"를 답으로
 *     받아 주면 모델이 전부 그리로 도망가 검사가 항상 통과한다 — 프롬프트의
 *     자기점검(가림 검사)이 실패한 것과 똑같은 방식으로 장식이 된다.
 *  3) 시도가 **독립**인가(temperature 1). 온도 0 이면 2회가 1회의 복사본이라
 *     시도를 늘린 의미가 사라진다.
 *  4) 배선 — 이미지가 붙은 문항에만 돌고, 폐기가 kept 에서 실제로 빠지고,
 *     실패·시간 초과는 통과로 흘러가는가.
 *
 *   npm run check:blind
 */

import { readFileSync } from 'node:fs';
import { BLIND_ATTEMPTS, isBlindSolvable } from '../lib/ai/blind-policy.ts';
import {
  BLIND_SOLVE_SYSTEM_PROMPT,
  BLIND_SOLVE_TOOL_SCHEMA,
  buildBlindSolveUserMessage,
} from '../lib/ai/prompts/blind-solve.ts';

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
/** 주석을 걷어낸 본문 — "종전에는 이랬다"는 설명 주석이 코드로 오인되면 검사가 거짓이 된다. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('\n① 폐기 판정 (독립 시도 전부 정답일 때만)');
check(`시도 횟수 상수 = 2`, BLIND_ATTEMPTS === 2, `실제 ${BLIND_ATTEMPTS}`);
const table = [
  { picks: [2, 2], answer: 2, expect: true, why: '2회 모두 정답 → 그림 없이 풀림' },
  { picks: [2, 0], answer: 2, expect: false, why: '1회만 정답 → 우연 범위' },
  { picks: [0, 2], answer: 2, expect: false, why: '순서가 달라도 같다' },
  { picks: [0, 1], answer: 2, expect: false, why: '전부 오답 → 그림이 필요하다' },
  { picks: [2, null], answer: 2, expect: false, why: '못 푼 시도가 있으면 판정하지 않는다' },
  { picks: [null, null], answer: 2, expect: false, why: '검사 자체가 실패' },
  { picks: [2], answer: 2, expect: false, why: '시도가 모자라면 판정하지 않는다' },
  { picks: [0, 0], answer: 0, expect: true, why: '1번 정답도 같은 규칙' },
];
for (const row of table) {
  const got = isBlindSolvable(row.picks, row.answer);
  check(
    `[${row.picks.join(', ')}] vs 정답 ${row.answer} → ${row.expect ? '폐기' : '통과'} (${row.why})`,
    got === row.expect,
    `실제 ${got}`,
  );
}
// 우연 정답률: 2회 모두 맞을 확률 4 %. 시도를 1회로 낮추면 20 %가 된다.
check(
  '시도를 1회로 낮추면(다른 판정) 1회 정답도 폐기가 된다 — 경계가 상수에 매여 있다',
  isBlindSolvable([2, 0], 2, 1) === true && isBlindSolvable([2, 0], 2, 2) === false,
);

console.log('\n② 프롬프트가 기권을 막는가');
const p = BLIND_SOLVE_SYSTEM_PROMPT;
check('그림이 없다는 사실을 알린다', /그림이 없습니다|볼 수 없습니다/.test(p));
check('반드시 하나를 고르라고 지시', /반드시 하나를 고릅니다/.test(p));
check('"알 수 없다"를 명시적으로 금지', /허용하지 않습니다/.test(p) && /알 수 없다/.test(p));
check('확신이 없으면 추측하라고 지시', /가장 그럴듯한 것을 고르십시오/.test(p));
check('근거 한 문장을 요구', /basis/.test(p));
check('자유 텍스트 금지', /자유 텍스트 금지/.test(p));

console.log('\n③ 도구 스키마');
const schema = BLIND_SOLVE_TOOL_SCHEMA;
check('도구 이름 = solve_without_image', schema.name === 'solve_without_image');
check('answer_index 필수', schema.input_schema.required.includes('answer_index'));
check('basis 필수', schema.input_schema.required.includes('basis'));
check(
  'answer_index 범위 0~4',
  schema.input_schema.properties.answer_index.minimum === 0 &&
    schema.input_schema.properties.answer_index.maximum === 4,
);
// 기권 필드가 생기면 ②의 금지가 무력해진다.
check(
  '기권/불확실 필드가 없다',
  !Object.keys(schema.input_schema.properties).some((k) => /unknown|abstain|unsure|cannot/i.test(k)),
);

console.log('\n④ 사용자 메시지');
const msg = buildBlindSolveUserMessage({
  stem: '다음 흉부 X선 사진에서 관찰되는 소견은?',
  choices: ['가', '나', '다', '라', '마'],
});
check('발문을 그대로 싣는다', msg.includes('다음 흉부 X선 사진에서 관찰되는 소견은?'));
check('선지를 1~5 로 번호 매긴다', /1\. 가\n2\. 나\n3\. 다\n4\. 라\n5\. 마/.test(msg));
check('그림이 없음을 제목에 표시', /그림 없음/.test(msg));
// 이미지 블록을 실으면 검사 자체가 무의미해진다.
check('이미지를 싣지 않는다(텍스트만)', typeof msg === 'string');

console.log('\n⑤ 호출부 — 시도가 독립인가');
const solve = stripComments(read('../lib/ai/blind-solve.ts'));
check('temperature 1 로 호출(2회가 서로 다른 시도)', /temperature:\s*1\b/.test(solve));
check('도구 호출을 강제', /tool_choice:\s*\{\s*type:\s*'tool'/.test(solve));
check('검증 모델(Flash)을 쓴다', /MODELS\.verification\(\)/.test(solve));
check('짧은 재시도(생성 흐름 안에서 돈다)', /maxAttempts:\s*2/.test(solve));
check(
  '범위 밖 응답은 null(=판정 안 함)로 떨어뜨린다',
  /answerIndex\s*=\s*Number\.isInteger/.test(solve) && /:\s*null/.test(solve),
);
check('비용을 UsageRecord 로 돌려준다', /costUSD:\s*calculateCost/.test(solve));

console.log('\n⑥ 배선 — 생성 파이프라인');
const gen = stripComments(read('../lib/ai/private-generation.ts'));
check('blindSolveOnce 를 호출한다', /blindSolveOnce\(/.test(gen));
check('판정은 isBlindSolvable 로만 한다', /isBlindSolvable\(picks/.test(gen));
check(
  '이미지가 붙은 문항만 검사한다',
  /image_indices\s*\?\?\s*\[\]\)\.some\(validImageIndex\)/.test(gen),
);
check('폐기분이 kept 에서 빠진다', /kept\s*=\s*kept\.filter\(\(_, i\) => !blindRejected\.has\(i\)\)/.test(gen));
check('폐기 카운터 blindDiscarded', /bumpGenDiag\('blindDiscarded'\)/.test(gen));
check('호출 실패는 통과 처리(카운터만)', /bumpGenDiag\('blindUnavailable'\)/.test(gen));
check('시간 초과도 통과 처리', /bumpGenDiag\('blindTimeout'\)/.test(gen));
check('진단에 검사 대상 수를 남긴다', /blindTargets/.test(gen));
check('모드 기본값이 discard', /PRIVATE_BLIND_MODE\s*\?\?\s*'discard'/.test(gen));
check('warn 모드가 있다(폐기 없이 계측만)', /bumpGenDiag\('blindFlagged'\)/.test(gen));
check('블라인드 비용을 private.blind 로 기록', /endpoint:\s*'private\.blind'/.test(gen));

console.log('\n⑦ 사용자 알림(P8) 연결');
const notice = stripComments(read('../lib/ai/upload-notice.ts'));
check('blindDiscarded 를 부족분 사유에 포함', /blindDiscarded/.test(notice));
check(
  '알림 문구는 검증을 연상시키지 않는다(그대로 유지)',
  /품질 기준에 못 미친 문항을 걸러내면서/.test(notice),
);

console.log('');
if (failures === 0) {
  console.log('✅ 전부 통과');
  process.exit(0);
}
console.log(`❌ ${failures}건 실패`);
process.exit(1);

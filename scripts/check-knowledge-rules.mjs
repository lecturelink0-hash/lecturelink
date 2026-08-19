#!/usr/bin/env node
/**
 * 지식형 규격(K0~K7)·발문 규칙·난이도 정의 검사 — P3·P4.
 *
 * 실행: npm run check:knowledge   (네트워크 불필요)
 *
 * 왜 있는가 (2026-08-18 감사·실측)
 *  - 지식형은 운영 문항의 59 %인데 지시가 한 줄이었고, 발문의 48 %가 두 문형에 몰렸다
 *    (`가장 적절한 것은?` + `설명으로 옳은 것은?`). `가장` 포함 51 %.
 *  - 원인의 절반은 **기본 프롬프트가 그 문형을 예시로 권장한 것**이었다. 그래서 규격을
 *    추가하는 것만으로는 부족하고, 기본 프롬프트에서 그 예시가 사라졌는지도 검사한다.
 *  - 난이도는 "하 1~2 / 상 2~3" 로 겹쳐 있었다 — 겹침이 다시 생기지 않는지 본다.
 *
 * 검사
 *  1. KNOWLEDGE_RULES 에 K0~K7 조항과 실패 예/성공 예가 있다.
 *  2. 기본 시스템 프롬프트·툴 스키마에 "가장 적절한" 권장 문구가 남아 있지 않다.
 *  3. ask_kind 카탈로그가 스키마 설명과 어긋나지 않는다(모든 값이 설명에 등장).
 *  4. buildKnowledgeQuotaDirective 가 배정 유형·부정형 허용 여부를 숫자로 지시한다.
 *  5. hasForbiddenAsk 가 금지형은 잡고 허용 예외("가장 흔한", "가장 먼저")는 통과시킨다.
 *  6. 난이도 지시 3종이 서로 다른 인지 수준을 말하고 범위가 겹치지 않는다.
 */
import {
  KNOWLEDGE_RULES,
  KNOWLEDGE_ASK_KINDS,
  CLINICAL_ASK_KINDS,
  IMAGE_ASK_KINDS,
  ALL_ASK_KINDS,
  ASK_KIND_LABELS,
  buildKnowledgeQuotaDirective,
} from '../lib/ai/prompts/knowledge-rules.ts';
import {
  PRIVATE_GENERATION_SYSTEM_PROMPT,
  PRIVATE_GENERATION_TOOL_SCHEMA,
} from '../lib/ai/prompts/private-generation.ts';
import { hasForbiddenAsk } from '../lib/ai/clinical-shape.ts';
import { buildClinicalQuotaDirective } from '../lib/ai/prompts/clinical-vignette.ts';

const srcRaw = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8'),
);
// 주석을 걷어낸 뒤 본다 — "종전에는 이랬다"는 설명 주석이 지시문으로 오인되면
// 검사가 사실이 아닌 것을 잡는다(첫 실행에서 실제로 걸렸다).
const src = srcRaw
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

console.log('지식형 규격(K0~K7)');
for (const k of ['K0', 'K1', 'K2', 'K3', 'K4', 'K5', 'K6']) {
  check(`${k} 조항이 있다`, KNOWLEDGE_RULES.includes(`### ${k} `));
}
check('실패 예(껍데기 증례)를 그대로 싣는다', KNOWLEDGE_RULES.includes('껍데기 증례'));
check('성공 예(수치 기준 문항)를 싣는다', KNOWLEDGE_RULES.includes('최대 직경 기준은?'));
check('자기 점검 항목이 있다', KNOWLEDGE_RULES.includes('지식형 제출 전 자기 점검'));
check(
  '"가장 적절한" 금지를 명시한다',
  /금지: "가장 적절한"/.test(KNOWLEDGE_RULES) || KNOWLEDGE_RULES.includes('**금지: "가장 적절한"'),
);
check('선지 순서를 서버가 섞는다고 알린다', KNOWLEDGE_RULES.includes('서버가 저장 직전에 섞고'));

console.log('\n기본 프롬프트에서 금지형 권장이 사라졌는가');
const stemDesc = PRIVATE_GENERATION_TOOL_SCHEMA.input_schema.properties.questions.items.properties.stem.description;
check(
  '시스템 프롬프트가 "가장 적절한 것은?"을 예시로 들지 않는다',
  !/예: "가장 적절한 것은\?"/.test(PRIVATE_GENERATION_SYSTEM_PROMPT),
);
check(
  '"가장 적절한 치료는? → 치료로 가장 적절한 것은?" 변환 지시가 없다',
  !PRIVATE_GENERATION_SYSTEM_PROMPT.includes('치료로 가장 적절한 것은?'),
);
check(
  '시스템 프롬프트가 명사구 발문을 우선하라고 말한다',
  PRIVATE_GENERATION_SYSTEM_PROMPT.includes('짧은 명사구를 우선한다'),
);
check(
  '툴 스키마 stem 설명이 금지형을 예시로 쓰지 않는다',
  !/예: "가장 적절한 것은\?"/.test(stemDesc) && stemDesc.includes('쓰지 않는다'),
);

console.log('\nask_kind 카탈로그');
const askDesc = PRIVATE_GENERATION_TOOL_SCHEMA.input_schema.properties.questions.items.properties.ask_kind.description;
check('ask_kind 가 required 다', PRIVATE_GENERATION_TOOL_SCHEMA.input_schema.properties.questions.items.required.includes('ask_kind'));
const missingInDesc = ALL_ASK_KINDS.filter((k) => !askDesc.includes(k));
check('모든 ask_kind 값이 스키마 설명에 있다', missingInDesc.length === 0, missingInDesc.join(', '));
const missingLabel = ALL_ASK_KINDS.filter((k) => !ASK_KIND_LABELS[k]);
check('모든 ask_kind 에 한국어 라벨이 있다', missingLabel.length === 0, missingLabel.join(', '));
check(
  '지식형·임상형·이미지형 유형이 겹치지 않는다',
  new Set(ALL_ASK_KINDS).size === KNOWLEDGE_ASK_KINDS.length + CLINICAL_ASK_KINDS.length + IMAGE_ASK_KINDS.length,
);
check('지식형 유형이 7종이다(치료·총론 편중을 흩을 만큼)', KNOWLEDGE_ASK_KINDS.length === 7);

console.log('\n배치 정량 지시');
const d = buildKnowledgeQuotaDirective({
  batchSize: 2,
  quota: 1,
  assignedAskKinds: ['mechanism', 'number_criteria'],
  allowNegative: false,
});
check('최소 문항 수를 숫자로 말한다', d.includes('최소 1문항'));
check('배정된 유형을 그대로 싣는다', d.includes('mechanism') && d.includes('number_criteria'));
check('금지 발문을 배치 지시에서 다시 못박는다', d.includes('가장 적절한'));
check('부정형 불허를 명시한다', d.includes('쓰지 마세요'));
const dAll = buildKnowledgeQuotaDirective({ batchSize: 2, quota: 2, assignedAskKinds: [], allowNegative: true });
check('쿼터가 배치 전부면 "전부"로 말한다', dAll.includes('**전부**'));
check('부정형 허용 시 상한 1문항을 말한다', dAll.includes('최대 1문항까지 허용'));
check('quota 0 이면 빈 문자열', buildKnowledgeQuotaDirective({ batchSize: 2, quota: 0, assignedAskKinds: [], allowNegative: false }) === '');

console.log('\n임상형 배치 지시에도 금지어가 있는가 (2026-08-19 실측 대응)');
// 유일하게 걸린 위반이 임상 증례형이었다 — C9 는 시스템 프롬프트에 있었지만 배치 지시에는
// 없어서 Flash 가 놓쳤다. 지식형에만 있던 금지 문구를 임상형 쿼터 지시에도 넣었는지 본다.
const cd = buildClinicalQuotaDirective(2, 1);
check('임상형 지시가 "가장 적절한"을 금지한다', cd.includes('가장 적절한'));
check('임상형 지시가 "다음 중"을 금지한다', cd.includes('다음 중'));
check('허용 예외를 함께 말한다', cd.includes('가장 흔한 원인은?'));
check('quota 0 이면 빈 문자열', buildClinicalQuotaDirective(2, 0) === '');

console.log('\n지식형 난이도 지침 (상이 증례 없이도 3이 되게)');
check(
  '지식형 전용 난이도 지시가 있다',
  src.includes('KNOWLEDGE_DIFFICULTY_DIRECTIVES'),
);
check(
  '지식형 상이 예외·금기/경계 수치/기전 하위 단계를 제시한다',
  /예외·금기/.test(src) && /경계 수치/.test(src) && /기전의 하위 단계/.test(src),
);
check(
  '지식형에 "증례를 붙여 어렵게 만들지 말라"고 못박는다',
  src.includes('증례를 붙여 어렵게 만들려 하지 않는다'),
);
check(
  '지식형을 고른 요청에만 붙인다',
  src.includes('wantsKnowledge ? `\\n${KNOWLEDGE_DIFFICULTY_DIRECTIVES'),
);

console.log('\n발문 유형 배정이 7종을 먼저 덮는가');
// 종전 batchIndex*need 방식은 7종을 다 쓰기 전에 앞쪽 유형이 반복됐다(실측 고유 6/10).
// 누적 슬롯 기준이면 첫 7칸이 7종을 모두 덮는다. 여기서는 같은 계산을 재현해 확인한다.
{
  const pool = KNOWLEDGE_ASK_KINDS;
  const batchSizes = [2, 2, 2, 2, 2];
  const quotaFor = (n) => n; // 지식형 단독 요청
  const plan = (bi) => {
    const need = Math.max(1, quotaFor(batchSizes[bi]));
    const consumed = batchSizes.slice(0, bi).reduce((a, n) => a + Math.max(1, quotaFor(n)), 0);
    const start = consumed % pool.length;
    return Array.from({ length: Math.min(need, pool.length) }, (_, k) => pool[(start + k) % pool.length]);
  };
  const all = batchSizes.map((_, i) => plan(i)).flat();
  check('첫 7칸이 7종을 모두 덮는다', new Set(all.slice(0, 7)).size === 7, all.slice(0, 7).join(','));
  check('10칸에서 고유 유형이 7종이다(최대치)', new Set(all).size === 7, `${new Set(all).size}종`);
  check('같은 배치 안에서는 유형이 겹치지 않는다', batchSizes.every((_, i) => new Set(plan(i)).size === plan(i).length));
}

console.log('\n배정 문구가 이탈을 허용하되 흔적을 남기게 하는가');
check('"배정" 표현으로 조인다', d.includes('배정'));
check('바꿀 때 concepts 에 흔적을 남기게 한다', d.includes('#유형변경'));

console.log('\n금지 발문 판정(hasForbiddenAsk)');
const forbidden = [
  '65세 남자가 등 통증으로 병원에 왔다. 치료로 가장 적절한 것은?',
  '대동맥류의 치료로 가장 적절한 것은?',
  '다음 중 대동맥 박리의 위험인자로 옳은 것은?',
  '이 환자의 진단은 무엇인가?',
  '가장 가능성 높은 진단은?',
];
for (const stem of forbidden) check(`금지형을 잡는다: ${stem.slice(-20)}`, hasForbiddenAsk(stem));
const allowed = [
  '복부 대동맥류에서 수술을 고려하는 직경 기준은?',
  '대동맥 박리의 가장 흔한 원인은?',
  '급성 대동맥 박리에서 가장 먼저 시행할 검사는?',
  '대동맥류에 대한 설명으로 옳은 것은?', // K2 가 묶음당 1개로 제한할 뿐 금지형은 아니다
  '65세 남자가 등 통증으로 병원에 왔다. 진단은?',
];
for (const stem of allowed) check(`허용형을 통과시킨다: ${stem.slice(-20)}`, !hasForbiddenAsk(stem));

console.log('\n난이도 정의(P4)');
check('하/중/상 지시가 각각 인지 수준을 말한다', /난이도 하\(재인\)/.test(src) && /난이도 중\(적용\)/.test(src) && /난이도 상\(분석\)/.test(src));
check('지시문(주석 제외)에 겹치는 범위(1~2 / 2~3)가 없다', !src.includes('difficulty 1~2') && !src.includes('difficulty 2~3'));
check('요청값에 맞춰 신고값을 조정하지 말라고 지시한다(A안)', src.includes('요청에 맞추려고 값을 올리거나 내리지 않는다'));
check('요청 난이도를 정수로 대응해 mismatch 를 센다', src.includes('requestedDifficultyLevel') && src.includes('difficultyMismatch'));

if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log('\n전부 통과');

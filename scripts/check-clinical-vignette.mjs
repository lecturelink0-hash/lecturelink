/**
 * 임상형 판정기·규격 자기 검사.
 *
 *   npm run check:clinical
 *
 * 왜 필요한가
 * ──────────
 * '임상형'이 지식형으로 되돌아가는 회귀는 **아무 오류도 내지 않는다.** 저장은 정상이고
 * 문항 수도 맞다. 2026-08-16 에 사용자가 화면을 보고서야 발견했다(임상형 10문항 전부
 * 지식형). 판정기가 그 실패를 실제로 잡아내는지 여기서 고정한다.
 *
 * 회귀 표본은 실제로 나온 문항을 그대로 쓴다 — 판정기를 느슨하게 고치면 여기서 깨진다.
 */

import {
  isClinicalVignette,
  hasPatientIntro,
  lintClinicalStem,
  measureClinicalYield,
} from '../lib/ai/clinical-shape.ts';
import {
  CLINICAL_VIGNETTE_RULES,
  buildClinicalQuotaDirective,
} from '../lib/ai/prompts/clinical-vignette.ts';

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// ── 회귀 표본: 실제로 나온 '임상형' 문항 10개 중 화면에 보였던 것들.
//    전부 임상형이 아니라고 판정돼야 한다.
const REGRESSION_KNOWLEDGE_STEMS = [
  '신경아교세포(Neuroglial cells)의 종류와 그 기능에 대한 설명으로 옳은 것은?',
  '중추신경계의 주요 신경조절물질(neuromodulator) 및 신경전달물질(neurotransmitter)에 대한 설명으로 옳은 것은?',
  '다음은 대뇌 신피질(Cerebral Neocortex)의 조직학적 소견을 나타내는 그림이다. 이 소견에서 관찰될 수 있는 뉴런 세포층에 대한 설명으로 옳은 것은?',
];

// ── 같은 강의 내용을 임상형으로 바꾼 표본. 전부 임상형으로 판정돼야 한다.
const GOOD_VIGNETTES = [
  '29세 여자가 3일 전부터 오른쪽 눈이 잘 보이지 않고 눈을 움직일 때 아파서 병원에 왔다. ' +
    '1년 전에도 왼쪽 팔이 이틀간 저렸다가 저절로 좋아진 적이 있다고 한다. 시력은 오른쪽 0.2, ' +
    '왼쪽 1.0이고 오른쪽 눈에 상대구심동공장애가 있다. 뇌 자기공명영상에서 뇌실 주위 백질에 ' +
    '여러 개의 T2 고신호 병터가 보인다. 진단은?',
  '68세 남자가 6개월 전부터 오른손이 떨리고 걸음이 느려져 병원에 왔다. 쉬고 있을 때 떨림이 ' +
    '심하고 움직이면 줄어든다고 한다. 진찰에서 톱니바퀴 강직과 얼굴 표정 감소가 있다. 치료 약물은?',
  '생후 5일 된 여아가 젖을 잘 빨지 못하고 늘어져서 응급실에 왔다. 임신나이 39주, 출생체중 ' +
    '3,210 g으로 태어났다고 한다. 체온 35.8 ℃이고 전신 근긴장도가 떨어져 있다. 검사는?',
];

console.log('임상형 판정 — 회귀 표본(지식형)');
for (const stem of REGRESSION_KNOWLEDGE_STEMS) {
  check(
    `지식형으로 판정: "${stem.slice(0, 28)}…"`,
    isClinicalVignette(stem) === false,
    '임상형으로 잘못 셌다 — 미달을 놓치게 된다',
  );
}

console.log('임상형 판정 — 증례 표본');
for (const stem of GOOD_VIGNETTES) {
  check(
    `임상형으로 판정: "${stem.slice(0, 28)}…"`,
    isClinicalVignette(stem) === true,
    '증례인데 지식형으로 셌다',
  );
}

console.log('도입 문형(C1)');
check('62세 남자', hasPatientIntro('62세 남자가 기침으로 병원에 왔다.'));
check('산과력 수식구가 낀 형태', hasPatientIntro('36세 산과력 0-0-0-0인 여자가 병원에 왔다.'));
check('생후 N일', hasPatientIntro('생후 5일 된 여아가 응급실에 왔다.'));
check('임신 N주', hasPatientIntro('임신 35주인 38세 여자가 병원에 왔다.'));
check('환자가 없으면 false', hasPatientIntro('별아교세포의 기능으로 옳은 것은?') === false);

console.log('껍데기 증례 배제(C4)');
check(
  '도입 한 줄만 있고 소견이 없으면 임상형이 아니다',
  isClinicalVignette('62세 남자가 병원에 왔다. 별아교세포의 기능은?') === false,
);
check(
  '환자 도입이 있어도 발문이 "설명으로 옳은 것은?"이면 임상형이 아니다',
  isClinicalVignette(
    '62세 남자가 3일 전부터 기침으로 병원에 왔다. 진찰에서 오른쪽 아래 폐야에 수포음이 들린다. ' +
      '폐렴의 원인균에 대한 설명으로 옳은 것은?',
  ) === false,
);

console.log('형식 린트(lintClinicalStem)');
{
  const issues = lintClinicalStem(
    '45세 남성이 2일 전부터 열이 나서 내원하였다. 활력징후: 혈압 100/60mmHg, 맥박 110bpm이다. ' +
      '이 환자에게 가장 적절한 치료는?',
  );
  const rules = new Set(issues.map((i) => i.rule));
  check('C1 — "남성" 지적', issues.some((i) => i.message.includes('"남성"')));
  check('C1 — "내원하였다" 지적', issues.some((i) => i.message.includes('내원하였다')));
  check('C5 — "활력징후:" 라벨 지적', issues.some((i) => i.message.includes('활력징후:')));
  check('C5 — mmHg 붙여쓰기 지적', issues.some((i) => i.message.includes('mmHg')));
  check('C5 — bpm 지적', issues.some((i) => i.message.includes('bpm')));
  check('C9 — "가장" 지적', issues.some((i) => i.message.includes('가장')));
  check('네 규칙이 모두 걸린다', rules.has('C1') && rules.has('C5') && rules.has('C9'));
}
{
  const clean = lintClinicalStem(GOOD_VIGNETTES[0]);
  check('규격에 맞는 증례는 지적 0건', clean.length === 0, clean.map((i) => i.message).join(' | '));
}
{
  // "남성/여성"을 잡느라 복합어까지 잡으면 멀쩡한 문항이 지적된다.
  const compound = lintClinicalStem(
    '52세 남자가 3개월 전부터 성욕이 줄어 병원에 왔다. 진찰에서 고환이 작아져 있다. ' +
      '혈액검사에서 남성호르몬이 낮게 측정된다. 검사는?',
  );
  check(
    '"남성호르몬" 같은 복합어는 지적하지 않는다',
    compound.every((i) => !i.message.includes('"남성"')),
    compound.map((i) => i.message).join(' | '),
  );
}

console.log('배치 수확량 계측(measureClinicalYield)');
{
  const stat = measureClinicalYield([...REGRESSION_KNOWLEDGE_STEMS, GOOD_VIGNETTES[0]], 4);
  check('임상형 1개만 센다', stat.clinical === 1, `실제 ${stat.clinical}`);
  check('미달 3으로 계산', stat.shortfall === 3, `실제 ${stat.shortfall}`);
}
{
  const stat = measureClinicalYield(GOOD_VIGNETTES, 2);
  check('목표를 넘으면 미달 0', stat.shortfall === 0);
}

console.log('배치 지시문(buildClinicalQuotaDirective)');
check('quota 0 이면 지시하지 않는다', buildClinicalQuotaDirective(5, 0) === '');
{
  const all = buildClinicalQuotaDirective(2, 2);
  check('전량 요구면 "전부"라고 쓴다', all.includes('전부'));
  check('규격 조항을 가리킨다', all.includes('C0~C11'));
  check('자료에 환자가 없어도 된다고 못박는다', all.includes('환자가 없어도'));
}
{
  const partial = buildClinicalQuotaDirective(4, 2);
  check('부분 요구면 최소 개수를 숫자로 쓴다', partial.includes('최소 2문항'));
}

console.log('규격 본문(CLINICAL_VIGNETTE_RULES)');
for (const anchor of ['C0', 'C1', 'C4', 'C5', 'C6', 'C9', 'C10', 'C11']) {
  check(`${anchor} 조항이 있다`, CLINICAL_VIGNETTE_RULES.includes(`### ${anchor} `));
}
check(
  '자료 기반 규칙과의 충돌을 명시적으로 푼다',
  CLINICAL_VIGNETTE_RULES.includes('자료에 없는 내용 추가 금지'),
);
check(
  '실패 예(지식형 문두)를 그대로 싣는다',
  CLINICAL_VIGNETTE_RULES.includes('설명으로 옳은 것은?'),
);
check(
  '발문 우선순위를 명시한다',
  CLINICAL_VIGNETTE_RULES.includes('"~것은?"으로 끝낸다"보다 우선한다') ||
    CLINICAL_VIGNETTE_RULES.includes('보다 우선한다'),
);

if (failed > 0) {
  console.error(`\n실패 ${failed}건`);
  process.exit(1);
}
console.log('\n전부 통과');

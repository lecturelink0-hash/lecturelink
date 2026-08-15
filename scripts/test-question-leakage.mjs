#!/usr/bin/env node
// 정답 누출 린트 회귀 검사 — lib/ai/kmle-format.ts 의 F17 계열
//
// 왜 있는가(2026-08-16 운영 실측):
//   active 1,318문항 중 정답이 1번인 비율 52.3 %, 정답이 '가장 긴 선지'인 비율 57.2 %.
//   AI 생성분만 보면 59.9 % / 62.2 % 였다. 의학을 몰라도 "제일 긴 선지"만 찍으면
//   60 % 가까이 맞았다는 뜻이다. F17 은 프롬프트에는 있었지만 코드로 검사하지 않아
//   아무도 막지 못했다. 그래서 린트로 내렸고, 이 스크립트가 그 린트를 지킨다.
//
// 두 방향을 같이 본다. 잡는 쪽만 검사하면 규칙이 넓어지다가 멀쩡한 문항까지 떨군다.
//   LEAKY : 정답이 드러나는 문항이 반드시 걸리는가
//   CLEAN : 정상 문항이 하나도 안 걸리는가
//
// 실행: npm run test:leakage

import { lintChoiceLeakage } from '../lib/ai/kmle-format.ts';

/** [설명, 문항, 걸려야 하는 규칙 코드] */
const LEAKY = [
  [
    '운영 DB 마르판 증후군 문항 원본 — 오답 넷 중 둘이 위해행위 지속·방치',
    {
      stem: '28세 남자가 가족계획과 운동 상담을 위해 병원에 왔다. 마르판증후군이 있고 가족 중 대동맥수술을 받은 사람이 있다. 팔다리가 길고 거미가락이 보인다. 조치는?',
      choices: ['운동', '항생제', '혈압 방치', '흡연 지속', '정기 대동맥 영상 추적'],
      answer_index: 4,
    },
    ['F17', 'F17-L'],
  ],
  [
    '태도 부정문 선지',
    {
      stem: '55세 여자가 가슴통증으로 응급실에 왔다. 처치는?',
      choices: ['심전도 촬영', '경과 관찰', '진통제 투여', '검사하지 않는다', '흉부 X선촬영'],
      answer_index: 0,
    },
    ['F17'],
  ],
  [
    '단정 부정문 선지',
    {
      stem: '40세 남자가 두통으로 병원에 왔다. 진단은?',
      choices: ['긴장두통', '편두통', '군발두통', '거미막밑출혈', '뇌종양과 무관하다'],
      answer_index: 3,
    },
    ['F17'],
  ],
  [
    '정답만 유독 긴 길이 누출 — 오답은 전부 성립하는 감별 대상',
    {
      stem: '62세 남자가 호흡곤란으로 병원에 왔다. 검사는?',
      choices: ['심전도', '흉부 X선촬영', '폐기능검사', '동맥혈 가스분석', '관상동맥 컴퓨터단층혈관조영술 및 부하검사'],
      answer_index: 4,
    },
    ['F17-L'],
  ],
  [
    '운영 DB 결핵 문항 — 정답에만 검사명을 나열해 길이가 3배',
    {
      stem: '만성 기침·가래를 보이는 환자의 흉부 X선에서 우상엽 침윤과 공동이 있다. 확진 검사는?',
      choices: ['혈액 배양', '폐기능검사', '흉부 초음파', '피부 알레르기검사', '객담 항산균 도말·배양 및 결핵균 핵산증폭검사'],
      answer_index: 4,
    },
    ['F17-L'],
  ],
];

/** 걸리면 안 되는 정상 문항 */
const CLEAN = [
  {
    stem: '68세 남자가 3시간 전부터 시작된 가슴통증으로 응급실에 왔다. 진단은?',
    choices: ['기흉', '심장막염', '대동맥박리', '폐색전증', '급성심근경색증'],
    answer_index: 2,
  },
  {
    stem: '45세 여자가 옆구리 통증으로 병원에 왔다. 우선 시행할 검사는?',
    choices: ['소변검사', '복부 초음파', '혈액배양검사', '콩팥요관방광 촬영', '복부 컴퓨터단층촬영'],
    answer_index: 4,
  },
  {
    stem: '52세 남자가 혈변으로 병원에 왔다. 치료 약물은?',
    choices: ['메살라진', '메트로니다졸', '프레드니솔론', '아자티오프린', '인플릭시맙'],
    answer_index: 0,
  },
  {
    // 병명 길이가 자연히 갈리는 정상 진단 문항 — 산포만으로 걸면 여기서 오탐이 난다.
    stem: '20세 여자가 야간·운동 시 악화되는 발작성 기침과 천명을 반복한다. 진단은?',
    choices: ['천식', '심부전', '폐색전증', '기관지확장증', '만성폐쇄성폐질환'],
    answer_index: 0,
  },
  {
    // 문장형 선지(법규 문항) — "~하지 않는다"가 아닌 정상 문장형은 통과해야 한다.
    stem: '의료기관 개설자가 진료기록부를 보존해야 하는 기간으로 옳은 것은?',
    choices: ['1년간 보존한다', '2년간 보존한다', '3년간 보존한다', '5년간 보존한다', '10년간 보존한다'],
    answer_index: 4,
  },
];

let failed = 0;

for (const [label, question, expectedRules] of LEAKY) {
  const issues = lintChoiceLeakage(question);
  const rules = issues.map((i) => i.rule);
  const missing = expectedRules.filter((r) => !rules.includes(r));
  if (missing.length > 0) {
    failed += 1;
    console.error(`FAIL [LEAKY] ${label}`);
    console.error(`  기대한 규칙: ${expectedRules.join(', ')}`);
    console.error(`  실제 지적:   ${rules.length ? rules.join(', ') : '(없음)'}`);
  } else {
    console.log(`ok   [LEAKY] ${label} → ${rules.join(', ')}`);
  }
}

for (const question of CLEAN) {
  const issues = lintChoiceLeakage(question);
  if (issues.length > 0) {
    failed += 1;
    console.error(`FAIL [CLEAN] 정상 문항이 걸렸다: ${question.stem.slice(0, 40)}…`);
    for (const i of issues) console.error(`  [${i.rule}] ${i.message}`);
  } else {
    console.log(`ok   [CLEAN] ${question.stem.slice(0, 34)}…`);
  }
}

if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log(`\n전부 통과 (누출 ${LEAKY.length}건 검출 / 정상 ${CLEAN.length}건 무지적)`);

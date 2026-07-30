/**
 * lib/ai/kmle-format.ts 자기 검사.
 *
 *   npx tsx scripts/check-kmle-format.ts
 *
 * 이 저장소에는 테스트 러너가 없어 독립 실행 스크립트로 둔다.
 * 특히 normalizeKmleQuestion 의 answer_index 재계산은 회귀하면
 * 화면상으로는 멀쩡한데 채점만 틀리는 사고가 되므로 반드시 확인한다.
 */

import { normalizeKmleQuestion, lintKmleQuestion } from '../lib/ai/kmle-format';

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('\n[normalize] 선지 정렬과 정답 인덱스');
{
  const q = normalizeKmleQuestion({
    stem: '문제',
    choices: ['급성호흡곤란증후군', '기흉', '안정협심증', '폐색전증', '급성심근경색증'],
    answer_index: 1, // 기흉
  });
  const lengths = q.choices.map((c) => c.length);
  check(
    '길이 오름차순으로 정렬된다',
    lengths.every((v, i) => i === 0 || lengths[i - 1] <= v),
    JSON.stringify(q.choices),
  );
  check(
    '정렬 후에도 정답이 기흉이다',
    q.choices[q.answer_index] === '기흉',
    `answer_index=${q.answer_index}`,
  );
}

console.log('\n[normalize] 예외 상황');
{
  const dup = normalizeKmleQuestion({
    stem: '문제',
    choices: ['가나', '가나', '가나다', '가', '가나다라'],
    answer_index: 1,
  });
  check('선지 문자열이 중복돼도 정답을 추적한다', dup.choices[dup.answer_index] === '가나');

  const original = { stem: '문제', choices: ['가', '나', '다', '라', '마'], answer_index: 9 };
  check('answer_index 가 범위 밖이면 원본을 그대로 둔다', normalizeKmleQuestion(original) === original);
}

console.log('\n[normalize] 선지 마침표');
{
  const noun = normalizeKmleQuestion({
    stem: '문제',
    choices: ['혈액투석.', '경과 관찰.', '수액 투여.', '항생제 투여.', '산소 공급.'],
    answer_index: 0,
  });
  check('명사구 선지의 마침표를 없앤다', noun.choices.every((c) => !c.endsWith('.')));

  const sentence = normalizeKmleQuestion({
    stem: '문제',
    choices: [
      '진단서를 교부한다.',
      '연명의료를 중단한다.',
      '보건소장에게 보고한다.',
      '교부를 거부한다.',
      '윤리위원회 심의를 거친다.',
    ],
    answer_index: 0,
  });
  check('문장형 선지의 마침표는 남긴다', sentence.choices.every((c) => c.endsWith('다.')));
}

console.log('\n[lint] 위반 탐지');
{
  const issues = lintKmleQuestion({
    stem: '28세 여성이 UTI 증상으로 내원하였다. 활력징후: 혈압 118/74mmHg, 맥박 76회/분. 가장 적절한 접근은?',
    choices: ['골반 평가를 한다', '감염은 절대 없다', '질분비물 현미경검사', '경과 관찰', '소변배양'],
    answer_index: 2,
  });
  const rules = [...new Set(issues.map((i) => i.rule))];
  for (const rule of ['F01', 'F05', 'F08', 'F12', 'F16']) {
    check(`${rule} 위반을 잡는다`, rules.includes(rule), rules.join(', '));
  }
}

console.log('\n[lint] 정상 문항과 오탐');
{
  const clean = lintKmleQuestion({
    stem:
      '28세 여자가 3일 전부터 배뇨통과 빈뇨로 병원에 왔다. 혈압 118/74 mmHg, 맥박 76회/분, ' +
      '호흡 16회/분, 체온 36.8 ℃이다. 갈비척추각 압통은 없다. 검사는?',
    choices: ['소변배양', '방광내시경', '요역동학검사', '콩팥초음파검사', '질분비물 현미경검사'],
    answer_index: 4,
  });
  check(
    '규격에 맞는 문항은 위반이 없다',
    clean.length === 0,
    clean.map((i) => `${i.rule}:${i.message}`).join(' | '),
  );

  const tight = lintKmleQuestion({
    stem:
      '60세 남자가 어제부터 가슴이 아파서 병원에 왔다. 혈압 140/90mmHg, 맥박 88회/분, ' +
      '호흡 18회/분, 체온 36.5 ℃이다. 진단은?',
    choices: ['기흉', '폐색전증', '안정협심증', '급성심근경색증', '급성호흡곤란증후군'],
    answer_index: 3,
  });
  check('mmHg 를 붙여 쓰면 잡는다', tight.some((i) => i.rule === 'F05'));

  const hormone = lintKmleQuestion({
    stem: '52세 남자가 2주 전부터 유방이 커져 병원에 왔다. 여성호르몬 수치가 높다. 진단은?',
    choices: ['유방암', '지방종', '유선염', '여성유방증', '갑상샘기능항진증'],
    answer_index: 3,
  });
  check('"여성호르몬"은 F01 위반으로 보지 않는다', !hormone.some((i) => i.rule === 'F01'));
}

console.log(`\n${pass} 통과 / ${fail} 실패\n`);
process.exit(fail === 0 ? 0 : 1);

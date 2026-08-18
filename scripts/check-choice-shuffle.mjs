#!/usr/bin/env node
/**
 * 내신대비 저장 직전 후처리 검사 — 정답 위치 셔플 + 정답 길이 누출(F17-L).
 *
 * 실행: npm run check:shuffle
 *
 * 왜 있는가 (2026-08-18 감사)
 *  - 운영 private_questions 987건에서 정답 3번 30.7 %, 1번 9.9 %(균등 20 %), 정답=최장 선지 32.6 %.
 *  - 셔플은 코드로 하지만 "정답 텍스트를 따라가 answer_index 를 다시 계산했는가"가 틀어지면
 *    화면은 멀쩡하고 채점만 어긋난다 — 사람 눈으로 못 잡으므로 여기서 결정론적으로 검사한다.
 *
 * 검사
 *  1. 셔플 후 answer_index 가 가리키는 텍스트가 셔플 전 정답 텍스트와 항상 같다(10,000회).
 *  2. 5지선다 정답 위치가 균등에 가깝다(10,000회, 각 위치 16~24 %).
 *  3. 라벨형 선지(조합형 ㄱ/ㄴ/ㄷ, A~E, ①~⑤)는 순서를 바꾸지 않는다.
 *  4. F17-L: 정답만 유독 긴 선지 세트는 잡고, 병명 길이가 자연히 갈리는 정상 세트는 통과시킨다.
 */
import {
  shuffleChoices,
  isOrderedLabelChoiceSet,
  lintChoiceLeakage,
} from '../lib/ai/kmle-format.ts';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

// 1·2) 정답 보존 + 균등 분포
const base = ['천식', '만성폐쇄성폐질환', '폐색전증', '심부전', '기관지확장증'];
const N = 10_000;
const positions = [0, 0, 0, 0, 0];
let preserved = 0;
for (let i = 0; i < N; i++) {
  const answerIndex = i % 5;
  const answerText = base[answerIndex];
  const r = shuffleChoices(base, answerIndex);
  if (r.choices[r.answerIndex] === answerText) preserved += 1;
  positions[r.answerIndex] += 1;
  if (r.choices.length !== 5 || new Set(r.choices).size !== 5) {
    check('셔플이 선지를 잃거나 중복시키지 않는다', false, JSON.stringify(r));
    break;
  }
}
check('셔플 후 answer_index 가 정답 텍스트를 가리킨다', preserved === N, `${preserved}/${N}`);
const shares = positions.map((p) => p / N);
check(
  '정답 위치가 균등에 가깝다(각 16~24 %)',
  shares.every((s) => s >= 0.16 && s <= 0.24),
  shares.map((s) => `${(s * 100).toFixed(1)}%`).join(' / '),
);
check(
  '원본 배열을 변형하지 않는다',
  base.join('|') === '천식|만성폐쇄성폐질환|폐색전증|심부전|기관지확장증',
);

// 3) 라벨형은 순서 유지
const combo = ['ㄱ', 'ㄴ', 'ㄱ, ㄴ', 'ㄱ, ㄷ', 'ㄱ, ㄴ, ㄷ'];
check('조합형(ㄱ/ㄴ/ㄷ)은 라벨형으로 판정', isOrderedLabelChoiceSet(combo));
check(
  '조합형은 순서를 바꾸지 않는다',
  Array.from({ length: 200 }, () => shuffleChoices(combo, 2)).every(
    (r) => r.choices.join('|') === combo.join('|') && r.answerIndex === 2,
  ),
);
check('A~E 표식 라벨은 라벨형', isOrderedLabelChoiceSet(['A', 'B', 'C', 'D', 'E']));
check('원문자는 라벨형', isOrderedLabelChoiceSet(['①', '②', '③', '④', '⑤']));
check('일반 명사구 선지는 라벨형이 아니다', !isOrderedLabelChoiceSet(base));
check(
  '"A"로 시작하는 일반 선지("Aortic dissection")는 라벨형이 아니다',
  !isOrderedLabelChoiceSet(['Aortic dissection', 'A형 대동맥 박리', 'B', 'C', 'D']),
);

// 잘못된 answer_index 는 그대로 돌려준다(폐기는 상위 normalizeChoiceSet 의 몫)
const bad = shuffleChoices(base, 7);
check('범위 밖 answer_index 는 원본 유지', bad.answerIndex === 7 && bad.choices === base);

// 4) F17-L
const leaky = {
  stem: '마르판 증후군 환자의 관리로 옳은 것은?',
  choices: ['운동', '항생제', '혈압 방치', '흡연 지속', '정기적인 대동맥 영상 추적 관찰과 베타차단제 투여'],
  answer_index: 4,
};
check(
  'F17-L: 정답만 유독 긴 세트를 잡는다',
  lintChoiceLeakage(leaky).some((i) => i.rule === 'F17-L'),
);
const normal = {
  stem: '진단은?',
  choices: ['천식', '만성폐쇄성폐질환', '폐색전증', '심부전', '기관지확장증'],
  answer_index: 1,
};
check(
  'F17-L: 병명 길이가 자연히 갈리는 정상 세트는 통과',
  !lintChoiceLeakage(normal).some((i) => i.rule === 'F17-L'),
);

if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log('\n모두 통과');

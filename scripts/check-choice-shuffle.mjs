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
 *  5. 해설 번호 옮기기(2026-10-05): 셔플·길이순 정렬이 선지 순서만 바꾸고 해설의 "②는 …"을 그대로 둬서
 *     해설이 엉뚱한 선지를 가리켰다(G0 기준선 점검: 번호 해설 182개 중 163개). 대응표가 맞는지,
 *     원문자를 한 번에 옮기는지, 내신대비 저장 경로가 실제로 옮기는지 본다.
 */
import { readFileSync } from 'node:fs';
import {
  shuffleChoices,
  isOrderedLabelChoiceSet,
  lintChoiceLeakage,
  remapChoiceMarks,
  normalizeKmleQuestion,
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

// 5) 해설 번호 옮기기
const marks = ['①', '②', '③', '④', '⑤'];
let mapOk = 0;
let explOk = 0;
for (let i = 0; i < 2_000; i++) {
  const r = shuffleChoices(base, i % 5);
  if (base.every((c, k) => r.choices[r.oldToNew[k]] === c) && r.oldToNew[i % 5] === r.answerIndex) mapOk += 1;
  // 원래 순서로 쓴 해설("①은 천식 …") → 옮긴 뒤 각 번호가 같은 선지를 가리키는가
  const expl = base.map((c, k) => `${marks[k]}${c}`).join(' ');
  const moved = remapChoiceMarks(expl, r.oldToNew);
  if (base.every((c, k) => moved.includes(`${marks[r.oldToNew[k]]}${c}`))) explOk += 1;
}
check('셔플 대응표: 원래 k번 선지가 새 위치 oldToNew[k] 에 있다', mapOk === 2_000, `${mapOk}/2000`);
check('해설 번호를 옮기면 각 번호가 같은 선지를 가리킨다', explOk === 2_000, `${explOk}/2000`);
check('라벨형은 대응표가 그대로', shuffleChoices(combo, 2).oldToNew.join() === '0,1,2,3,4');
check('원문자는 한 번에 옮긴다(① ↔ ③ 맞바꿈)', remapChoiceMarks('①은 아니다. ③은 아니다.', [2, 1, 0, 3, 4]) === '③은 아니다. ①은 아니다.');
check('조사를 새 번호 받침에 맞춘다(은/는·이/가·을/를·과/와)', remapChoiceMarks('①은 ②는 ③이 ④가 ⑤를 ①과', [1, 0, 3, 2, 0]) === '②는 ①은 ④가 ③이 ①을 ②와', remapChoiceMarks('①은 ②는 ③이 ④가 ⑤를 ①과', [1, 0, 3, 2, 0]));
check('조사 뒤에 한글이 이어지면 번호만 바꾼다(②가장 …)', remapChoiceMarks('①가장 흔하다', [1, 0]) === '②가장 흔하다');
check('없어진 선지(-1)를 가리키는 표기는 그대로', remapChoiceMarks('②와 ⑥', [0, -1, 2, 3, 4, 1]) === '②와 ②');
check('원문자가 없으면 그대로', remapChoiceMarks('정답 근거만 있다.', [4, 3, 2, 1, 0]) === '정답 근거만 있다.');
const sorted = normalizeKmleQuestion({
  stem: '진단은?',
  choices: ['만성폐쇄성폐질환', '천식', '폐색전증'],
  answer_index: 1,
  explanation: '정답은 ②이다. ①은 아니다. ③은 아니다.',
});
check('길이순 정렬도 해설 번호를 옮긴다', sorted.choices.join('|') === '천식|폐색전증|만성폐쇄성폐질환' && sorted.explanation === '정답은 ①이다. ③은 아니다. ②는 아니다.', JSON.stringify(sorted));
check('해설이 없는 문항은 정렬만', !('explanation' in normalizeKmleQuestion({ stem: 's', choices: ['bb', 'a'], answer_index: 0 })));
const pg = readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8');
check(
  '내신대비 저장 경로: 모델 순서 → 최종 순서 대응표로 해설 번호를 옮긴다',
  /const oldToNew = \(q\.choices \?\? \[\]\)\.map\(\(c\) => shuffled\.choices\.indexOf\(String\(c \?\? ''\)\.trim\(\)\)\);\s*const remapped = remapChoiceMarks\(String\(q\.explanation \?\? ''\), oldToNew\);/.test(pg) &&
    /q\.explanation = remapped;/.test(pg),
);

if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log('\n모두 통과');

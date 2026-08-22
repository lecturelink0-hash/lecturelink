/**
 * 문항 통계·층화 추출 회귀 검사 (분담표 A12·A13) — 네트워크·DB 없이 돈다.
 *
 * 통계는 조용히 틀린다. 변별도 부호가 뒤집혀도 화면에는 숫자가 그대로 나오고,
 * KR-20 이 표본표준편차로 계산돼도 "0.7 정도면 괜찮네" 하고 넘어간다.
 * 그래서 손으로 계산할 수 있는 값을 박아 두고 대조한다.
 *
 *   npm run check:item-stats
 */
import {
  analyzeItems,
  computeKr20,
  summarizeItemStats,
  MIN_SAMPLE_PER_ITEM,
} from '../lib/stats/item-analysis.ts';
import {
  stratifiedSample,
  seededRandom,
  shuffle,
  defaultQuestionStrata,
} from '../lib/stats/stratified-sample.ts';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const near = (a, b, eps = 1e-4) => a !== null && Math.abs(a - b) < eps;

// ── 문항 통계 ────────────────────────────────────────────────────────────────

console.log('\n[A13] 정답률·선지별 선택률');
{
  // 10명이 Q1 을 풀고 6명 정답(정답은 2번 인덱스), 오답은 0번에 3명·1번에 1명, 3·4번은 0명
  const attempts = [];
  for (let i = 0; i < 6; i += 1) attempts.push(mk(`u${i}`, 'Q1', 2, true));
  for (let i = 6; i < 9; i += 1) attempts.push(mk(`u${i}`, 'Q1', 0, false));
  attempts.push(mk('u9', 'Q1', 1, false));

  const [stat] = analyzeItems(attempts, { Q1: 2 });
  check('n', stat.n === 10);
  check('정답률 0.6', stat.correctRate === 0.6, String(stat.correctRate));
  check('선지 0번 선택률 0.3', stat.choices[0].share === 0.3);
  check('정답 선지 표시', stat.choices[2].isAnswer === true);
  check('아무도 안 고른 오답을 죽은 선지로', JSON.stringify(stat.deadChoices) === '[3,4]',
    JSON.stringify(stat.deadChoices));
  check('정답 선지는 죽은 선지가 아니다', stat.choices[2].dead === false);
  check(`표본 ${MIN_SAMPLE_PER_ITEM} 미만이면 unstable`, stat.unstable === true);
  check('플래그에 표본 부족', stat.flags.some((f) => f.includes('표본 부족')));
  check('플래그에 기능하지 않는 선지', stat.flags.some((f) => f.includes('기능하지 않는')));
}

console.log('\n[A13] 변별도 — 상위 27% 대 하위 27%');
{
  // 100명. 실력 상위 절반은 Q1 을 다 맞히고 하위 절반은 다 틀린다 → 변별도 1.0
  const attempts = [];
  for (let u = 0; u < 100; u += 1) {
    const strong = u < 50;
    attempts.push(mk(`u${u}`, 'Q1', strong ? 0 : 1, strong));
    // 총점 비교가 되도록 채움 문항 5개 (실력대로)
    for (let f = 0; f < 5; f += 1) attempts.push(mk(`u${u}`, `F${f}`, 0, strong));
  }
  const stats = analyzeItems(attempts, { Q1: 0, F0: 0, F1: 0, F2: 0, F3: 0, F4: 0 });
  const q1 = stats.find((s) => s.itemId === 'Q1');
  check('완전 변별 문항 → 변별도 1.0', q1.discrimination === 1, String(q1.discrimination));
  check('point-biserial 양수', q1.pointBiserial > 0.9, String(q1.pointBiserial));
  check('표본 충분 → stable', q1.unstable === false);

  // 정답키가 뒤집힌 문항 — 상위권이 틀리고 하위권이 맞는다
  const flipped = attempts.map((a) =>
    a.itemId === 'Q1' ? { ...a, isCorrect: !a.isCorrect } : a,
  );
  const bad = analyzeItems(flipped, { Q1: 0, F0: 0, F1: 0, F2: 0, F3: 0, F4: 0 })
    .find((s) => s.itemId === 'Q1');
  check('정답키 오류 → 변별도 -1.0', bad.discrimination === -1, String(bad.discrimination));
  check('정답키 오류 → point-biserial 음수', bad.pointBiserial < 0, String(bad.pointBiserial));
  check('정답 오류 점검 플래그', bad.flags.some((f) => f.includes('정답 오류')));
}

console.log('\n[A13] 정의되지 않는 경우를 숫자로 만들지 않는가');
{
  // 전원 정답 → 분산 0 → point-biserial 없음
  const allCorrect = [];
  for (let u = 0; u < 40; u += 1) {
    allCorrect.push(mk(`u${u}`, 'Q1', 0, true));
    for (let f = 0; f < 5; f += 1) allCorrect.push(mk(`u${u}`, `F${f}`, 0, true));
  }
  const q1 = analyzeItems(allCorrect, { Q1: 0 }).find((s) => s.itemId === 'Q1');
  check('전원 정답 → point-biserial null', q1.pointBiserial === null, String(q1.pointBiserial));
  check('전원 정답 → 너무 쉬움 플래그', q1.flags.some((f) => f.includes('너무 쉬움')));

  // 응답자가 적으면 상·하위 집단이 성립하지 않는다
  const tiny = [mk('a', 'Q1', 0, true), mk('b', 'Q1', 1, false)];
  const t = analyzeItems(tiny, { Q1: 0 })[0];
  check('표본 2명 → 변별도 null', t.discrimination === null);
}

console.log('\n[A13] KR-20');
{
  // 손계산 대조: 4명 × 5문항
  //  u0: 5정답, u1: 4정답, u2: 2정답, u3: 0정답
  const pattern = {
    u0: [1, 1, 1, 1, 1],
    u1: [1, 1, 1, 1, 0],
    u2: [1, 1, 0, 0, 0],
    u3: [0, 0, 0, 0, 0],
  };
  const items = ['I0', 'I1', 'I2', 'I3', 'I4'];
  const attempts = [];
  for (const [user, row] of Object.entries(pattern)) {
    row.forEach((v, i) => attempts.push(mk(user, items[i], v ? 0 : 1, v === 1)));
  }
  // p = [.75,.75,.5,.5,.25] → Σpq = .1875+.1875+.25+.25+.1875 = 1.0625
  // 총점 [5,4,2,0], 평균 2.75, 모분산 = ((2.25)²+(1.25)²+(.75)²+(2.75)²)/4 = (5.0625+1.5625+.5625+7.5625)/4 = 3.6875
  // KR-20 = 5/4 × (1 − 1.0625/3.6875) = 1.25 × 0.711864... = 0.88983
  const r = computeKr20(attempts, items);
  check('KR-20 손계산 일치 (0.8898)', near(r.kr20, 0.8898, 1e-3), String(r.kr20));
  check('완전 응답자 4명', r.completeCases === 4);
  check('표본 부족이면 unstable', r.unstable === true);
  check('불안정 사유를 문장으로 남긴다', r.note.includes('완전 응답자'));

  // 문항이 5개 미만이면 계산하지 않는다
  const few = computeKr20(attempts.filter((a) => ['I0', 'I1'].includes(a.itemId)), ['I0', 'I1']);
  check('문항 2개 → 계산 안 함', few.kr20 === null && few.unstable === true);

  // 모두 같은 점수면 분산 0 → 정의되지 않음
  const flat = [];
  for (let u = 0; u < 10; u += 1) items.forEach((it) => flat.push(mk(`v${u}`, it, 0, true)));
  const f = computeKr20(flat, items);
  check('총점 분산 0 → null', f.kr20 === null, String(f.kr20));
  check('분산 0 사유 기록', f.note.includes('분산'));

  // 부분 응답자는 완전 응답자에 들어가지 않는다
  const partial = [...attempts, mk('u4', 'I0', 0, true)];
  check('부분 응답자 제외', computeKr20(partial, items).completeCases === 4);
}

console.log('\n[A13] 요약 — 불안정 문항이 평균을 흔들지 않는가');
{
  const many = [];
  for (let u = 0; u < 40; u += 1) {
    many.push(mk(`u${u}`, 'STABLE', 0, u < 20));
    for (let f = 0; f < 5; f += 1) many.push(mk(`u${u}`, `F${f}`, 0, u < 20));
  }
  many.push(mk('x1', 'TINY', 0, true)); // 표본 1명짜리 정답률 1.0
  const stats = analyzeItems(many, { STABLE: 0, TINY: 0 });
  const s = summarizeItemStats(stats);
  check('불안정 문항 수', s.unstable === 1, String(s.unstable));
  check('평균 정답률은 안정 문항만 (0.5)', near(s.meanCorrectRate, 0.5), String(s.meanCorrectRate));
  check('안정 문항 수', s.stable === 6, String(s.stable));
}

// ── 층화 추출 ────────────────────────────────────────────────────────────────

console.log('\n[A12] 재현성');
{
  const r1 = seededRandom('abc');
  const r2 = seededRandom('abc');
  const r3 = seededRandom('abd');
  check('같은 seed → 같은 난수열', r1() === r2());
  check('다른 seed → 다른 난수열', r2() !== r3());

  const items = Array.from({ length: 50 }, (_, i) => ({ id: `q${i}`, subject: i % 2 ? '내과' : '외과' }));
  const strata = [{ key: '과목', valueOf: (i) => i.subject }];
  const a = stratifiedSample(items, { size: 10, strata, seed: 'audit-2026-08' });
  const b = stratifiedSample(items, { size: 10, strata, seed: 'audit-2026-08' });
  const c = stratifiedSample(items, { size: 10, strata, seed: 'other' });
  check('같은 seed → 같은 표본', JSON.stringify(a.sample) === JSON.stringify(b.sample));
  check('다른 seed → 다른 표본', JSON.stringify(a.sample) !== JSON.stringify(c.sample));
  check('shuffle 은 원본을 건드리지 않는다',
    (() => { const src = [1, 2, 3, 4, 5]; shuffle(src, seededRandom('x')); return JSON.stringify(src) === '[1,2,3,4,5]'; })());
}

console.log('\n[A12] 비례 배분');
{
  // 과목 비율 60:30:10 인 100건에서 10건 → 6:3:1
  const items = [
    ...Array.from({ length: 60 }, (_, i) => ({ id: `a${i}`, subject: '내과' })),
    ...Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, subject: '외과' })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, subject: '소아과' })),
  ];
  const strata = [{ key: '과목', valueOf: (i) => i.subject }];
  const result = stratifiedSample(items, { size: 10, strata, seed: 's1' });
  check('표본 수가 정확히 요청과 같다', result.sample.length === 10, String(result.sample.length));
  const bySubject = tally(result.sample.map((i) => i.subject));
  check('60:30:10 → 6:3:1', bySubject['내과'] === 6 && bySubject['외과'] === 3 && bySubject['소아과'] === 1,
    JSON.stringify(bySubject));
  check('배분표에 층별 목표·실제', result.allocations.length === 3
    && result.allocations.every((a) => a.taken === a.target));
  check('경고 없음', result.warnings.length === 0, JSON.stringify(result.warnings));

  // 반올림이 합계를 깨지 않는가 (33:33:34 에서 10건)
  const thirds = [
    ...Array.from({ length: 33 }, (_, i) => ({ id: `x${i}`, subject: 'A' })),
    ...Array.from({ length: 33 }, (_, i) => ({ id: `y${i}`, subject: 'B' })),
    ...Array.from({ length: 34 }, (_, i) => ({ id: `z${i}`, subject: 'C' })),
  ];
  const t = stratifiedSample(thirds, { size: 10, strata, seed: 's2' });
  check('최대잉여법으로 합계 정확', t.sample.length === 10, String(t.sample.length));
}

console.log('\n[A12] 대표성 보호');
{
  const strata = [{ key: '과목', valueOf: (i) => i.subject }];
  // 희귀 층이 배분 0 이 되면 그 조합이 검수에서 통째로 빠진다
  const skewed = [
    ...Array.from({ length: 99 }, (_, i) => ({ id: `a${i}`, subject: '내과' })),
    { id: 'rare', subject: '희귀과' },
  ];
  const plain = stratifiedSample(skewed, { size: 5, strata, seed: 's3' });
  check('순수 비례면 희귀 층이 빠질 수 있다', !plain.sample.some((i) => i.subject === '희귀과'));
  const guarded = stratifiedSample(skewed, { size: 5, strata, seed: 's3', minPerCell: 1 });
  check('minPerCell 로 희귀 층 보장', guarded.sample.some((i) => i.subject === '희귀과'));
  check('보장해도 표본 수 유지', guarded.sample.length === 5);

  // 모집단보다 크게 요청하면 전수 + 경고
  const all = stratifiedSample(skewed, { size: 500, strata, seed: 's4' });
  check('모집단 초과 요청 → 전수', all.sample.length === 100);
  check('전수 반환을 경고로 남긴다', all.warnings.some((w) => w.includes('전수')));

  // 층 값이 없으면 '미상' 으로 묶어 통계에서 사라지지 않게 한다
  const missing = stratifiedSample(
    [{ id: '1', subject: null }, { id: '2' }, { id: '3', subject: '내과' }],
    { size: 2, strata, seed: 's5' },
  );
  check('값 없는 항목도 층에 들어간다', missing.allocations.some((a) => a.cell.includes('미상')),
    JSON.stringify(missing.allocations.map((a) => a.cell)));
}

console.log('\n[A12] 가이드 6.2 축 (과목·자료형식·난이도·이미지)');
{
  const strata = defaultQuestionStrata();
  check('축 4개', strata.length === 4);
  check('축 이름', JSON.stringify(strata.map((s) => s.key)) === '["과목","자료형식","난이도","이미지문항"]',
    JSON.stringify(strata.map((s) => s.key)));
  const imageAxis = strata[3];
  check('이미지 있음 판정', imageAxis.valueOf({ image_url: 'https://x/y.png' }) === '예');
  check('이미지 없음 판정', imageAxis.valueOf({}) === '아니오');
  check('빈 문자열은 없음', imageAxis.valueOf({ image_url: '' }) === '아니오');

  // 다축 층화가 실제로 쪼개지는가
  const items = [];
  for (const subject of ['내과', '외과']) {
    for (const difficulty of [1, 2]) {
      for (let i = 0; i < 10; i += 1) {
        items.push({ id: `${subject}${difficulty}${i}`, subject, difficulty, file_type: 'pdf' });
      }
    }
  }
  const r = stratifiedSample(items, { size: 8, strata, seed: 's6' });
  check('4개 셀로 쪼개진다', r.allocations.length === 4, String(r.allocations.length));
  check('셀마다 2건씩', r.allocations.every((a) => a.target === 2), JSON.stringify(r.allocations.map((a) => a.target)));
}

function mk(userId, itemId, selectedIndex, isCorrect, timeSpentSeconds = 30) {
  return { userId, itemId, selectedIndex, isCorrect, timeSpentSeconds };
}
function tally(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

console.log(`\n통과 ${pass} · 실패 ${fail}`);
if (fail > 0) process.exit(1);
console.log('문항 통계·층화 추출 회귀 검사 통과.');

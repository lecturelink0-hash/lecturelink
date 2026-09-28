/**
 * 검색 산식·평가 지표 검사 (npm run check:rag-eval)
 *
 * lib/rag/retrieval-math.ts (RRF·코사인·근거 팩 조립)와 lib/rag/eval-metrics.ts (인용구 회수·MRR·τ)를
 * 손으로 계산한 값과 대조한다. 두 파일은 E1~E3 평가와 Phase 1 검색 단계가 함께 쓰므로,
 * 산식이 조용히 바뀌면 평가로 고른 구성이 운영에서 다르게 동작한다.
 *
 *   node --experimental-strip-types --no-warnings scripts/check-rag-eval.mjs
 */
import {
  cosine,
  l2normalize,
  topKByCosine,
  rrfFuse,
  RRF_K,
  assemblePack,
} from '../lib/rag/retrieval-math.ts';
import {
  normalizeForMatch,
  quoteCovered,
  scoreUnit,
  reciprocalRankAt,
  mean,
  percentile,
  chooseTau,
  locateQuote,
} from '../lib/rag/eval-metrics.ts';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

console.log('[check:rag-eval]');

// ── 코사인·정규화
check('코사인: 같은 방향 1', near(cosine([1, 2, 3], [2, 4, 6]), 1));
check('코사인: 직교 0', near(cosine([1, 0], [0, 1]), 0));
check('코사인: 반대 -1', near(cosine([1, 1], [-1, -1]), -1));
check('코사인: 길이 다르면 0', cosine([1, 2], [1, 2, 3]) === 0);
check('코사인: 영벡터 0', cosine([0, 0], [1, 1]) === 0);
const n = l2normalize([3, 4]);
check('정규화: [3,4] → [0.6,0.8]', near(n[0], 0.6) && near(n[1], 0.8));
check('정규화: 영벡터는 영벡터', l2normalize([0, 0]).every((x) => x === 0));

// ── top-k 와 동점 처리
const docs = [
  { id: 'b', vec: [1, 0] },
  { id: 'a', vec: [1, 0] },
  { id: 'c', vec: [0, 1] },
];
const top = topKByCosine([1, 0], docs, 2);
check('top-k: 동점은 id 사전순(a,b)', top.map((x) => x.id).join() === 'a,b', JSON.stringify(top));
check('top-k: k=0 이면 빈 목록', topKByCosine([1, 0], docs, 0).length === 0);

// ── RRF: 손계산 (k=60)
//  목록1: x,y,z   목록2: y,w
//  x = 1/61, y = 1/62 + 1/61, z = 1/63, w = 1/62
const fused = rrfFuse([['x', 'y', 'z'], ['y', 'w']]);
const got = Object.fromEntries(fused.map((s) => [s.id, s.score]));
check('RRF 상수 60', RRF_K === 60);
check('RRF: y = 1/62 + 1/61', near(got.y, 1 / 62 + 1 / 61));
check('RRF: x = 1/61', near(got.x, 1 / 61));
check('RRF: w = 1/62', near(got.w, 1 / 62));
check('RRF: 순서 y > x > w > z', fused.map((s) => s.id).join() === 'y,x,w,z', fused.map((s) => s.id).join());
check('RRF: 한 목록 안 중복은 첫 순위만', near(rrfFuse([['a', 'a']])[0].score, 1 / 61));
check('RRF: 빈 입력', rrfFuse([]).length === 0);

// ── 근거 팩 조립
const parent = (id) => ({ c1: 'p1', c2: 'p1', c3: 'p2', c4: 'p3', c5: null }[id] ?? null);
const ranked = ['c1', 'c2', 'c3', 'c4', 'c5'];
const packA = assemblePack(ranked, parent, { size: 3, expandTop: 0 });
check('팩(a) 확장 없음: 청크 그대로 상위 3', packA.map((p) => p.id).join() === 'c1,c2,c3', packA.map((p) => p.id).join());
const packB = assemblePack(ranked, parent, { size: 6, expandTop: Infinity });
check(
  '팩(b) 전부 부모: p1(c1,c2)·p2·p3·c5',
  packB.map((p) => p.id).join() === 'p1,p2,p3,c5' && packB[0].sourceIds.join() === 'c1,c2',
  JSON.stringify(packB),
);
check('팩(b) 부모 없는 청크는 청크로', packB[3].expanded === false);
const packC = assemblePack(ranked, parent, { size: 4, expandTop: 2 });
check(
  '팩(c) 상위 2개만 부모: p1 흡수 c2 → p1·p2·c4·c5',
  packC.map((p) => p.id).join() === 'p1,p2,c4,c5',
  packC.map((p) => p.id).join(),
);
const packD = assemblePack(['c3', 'c1', 'c2'], parent, { size: 3, expandTop: 1 });
check('팩: 확장 안 된 청크는 뒤의 같은 부모 청크를 막지 않음', packD.map((p) => p.id).join() === 'p2,c1,c2', packD.map((p) => p.id).join());
check('팩: 같은 청크 두 번이면 한 번만', assemblePack(['c5', 'c5'], parent, { size: 3, expandTop: 0 }).length === 1);

// ── 인용구 대조
check('정규화: 공백·줄바꿈·대소문자 무시', normalizeForMatch('AST  /\nALT 비') === 'ast/alt비');
check('정규화: NFKC(전각→반각)', normalizeForMatch('ＡＳＴ') === 'ast');
check('인용구: 줄바꿈이 달라도 회수', quoteCovered('심박출량은 심박수와\n일회박출량의 곱', ['… 심박출량은 심박수와 일회박출량의 곱이다 …']));
check('인용구: 빈 인용구는 회수 아님', quoteCovered('  ', ['아무 글']) === false);
check('인용구: 없는 글', quoteCovered('간문맥', ['심박출량']) === false);

const s1 = scoreUnit(['가나다', '라마바'], ['…가나다…', '무관']);
check('단위 점수: 2개 중 1개 → recall 0.5, hit', s1.recall === 0.5 && s1.hit === true);
const s2 = scoreUnit([], ['x']);
check('단위 점수: 인용구 없으면 평가 제외(null)', s2.recall === null && s2.hit === false);
check('역순위: 두 번째에 있으면 0.5', reciprocalRankAt(['목표'], ['무관', '…목표…', '목표'], 10) === 0.5);
check('역순위: k 밖이면 0', reciprocalRankAt(['목표'], ['a', 'b', '목표'], 2) === 0);

check('평균', mean([1, 2, 3]) === 2 && mean([]) === null);
check('백분위 p95 (nearest-rank)', percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95) === 10);
check('백분위 p50', percentile([5, 1, 3], 50) === 3);

// τ: 점수 10개 중 90% 가 τ 이상 → 9번째로 큰 값
const scores = [0.9, 0.8, 0.85, 0.7, 0.75, 0.6, 0.65, 0.95, 0.5, 0.55];
check('τ: 상위 90%를 남기는 가장 높은 값 = 0.55', chooseTau(scores, 0.9) === 0.55, String(chooseTau(scores, 0.9)));
check('τ: 전부 남기면 최솟값', chooseTau(scores, 1) === 0.5);
check('τ: 빈 입력 null', chooseTau([], 0.9) === null);

// 인용구 바로잡기
const chunk = '위식도 역류질환(GERD)은\n하부식도괄약근의 일과성 이완이 주 기전이다.';
check('바로잡기: 원문 그대로면 그대로', locateQuote('하부식도괄약근의 일과성 이완', chunk) === '하부식도괄약근의 일과성 이완');
const fixed = locateQuote('역류질환(GERD)은 하부식도괄약근의 일과성이완', chunk);
check('바로잡기: 공백만 달라도 원문 구간으로', fixed !== null && quoteCovered(fixed, [chunk]), String(fixed));
const drift = locateQuote('하부식도괄약근의 일과성 수축이 주된 원인', chunk);
check('바로잡기: 뒤가 달라도 앞 앵커로 원문 구간을 가져옴', drift !== null && quoteCovered(drift, [chunk]), String(drift));
check('바로잡기: 앵커도 없으면 null', locateQuote('간경변의 문맥고혈압', chunk) === null);
const bullets = 'Upper esophageal sphincter (UES)\n•high-pressure zone separating the pharynx from the esophagus\n•다음 줄';
const b1 = locateQuote('Upper esophageal sphincter (UES) high-pressure zone separating the pharynx from the esophagus', bullets);
check('바로잡기: 목록 기호를 빼먹은 인용구도 끝 단어까지 온전히', b1 !== null && b1.endsWith('esophagus') && quoteCovered(b1, [bullets]), JSON.stringify(b1));
check('바로잡기: 결과는 원문의 연속 구간', b1 !== null && bullets.includes(b1));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

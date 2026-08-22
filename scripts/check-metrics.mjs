/**
 * 운영 지표 산식·계측 회귀 검사 (분담표 A1·A2·A4) — 네트워크·DB 없이 돈다.
 *
 * 무엇을 지키는가
 *  1) 백분위가 nearest-rank 인가. 보간하면 관측된 적 없는 값이 p95 로 나간다.
 *  2) 성공 경로 지연과 전체 지연이 분리돼 있는가. 타임아웃 하나가 p95 를 삼키면 안 된다.
 *  3) 스키마 준수율의 분모가 '검사한 것'인가. 검사 안 한 요청이 분모에 들어가면 준수율이
 *     실제보다 좋게 나온다.
 *  4) 재시도 성공률이 창(10분)과 같은 사용자·같은 기능을 지키는가.
 *  5) 기능 이름에 uuid 가 새지 않는가. 새면 집계가 요청 수만큼 쪼개진다.
 *  6) 품질 게이트가 계약 위반·중복을 실제로 잡는가.
 *
 *   npm run check:metrics
 */
import {
  percentile,
  latencyStats,
  summarizeRequests,
  summarizeRetries,
  summarizeQuality,
  costPerQuestion,
} from '../lib/metrics/summary.ts';
import { featureFromPath } from '../lib/metrics/feature.ts';
import { versionForFeature } from '../lib/ai/versions.ts';
import {
  checkQuestionSchema,
  findDuplicates,
  lexicalSimilarity,
  cosineSimilarity,
} from '../lib/ai/quality-checks.ts';

let pass = 0;
let fail = 0;

function check(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function row(overrides = {}) {
  return {
    id: 'x',
    request_id: Math.random().toString(36).slice(2),
    feature: 'questions_generate',
    version: 'question_generation-p2',
    user_id: 'u1',
    method: 'POST',
    status: 'success',
    status_code: 200,
    error_code: null,
    total_ms: 1000,
    stages: null,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
    models: null,
    schema_valid: null,
    quality: null,
    created_at: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

console.log('\n[분포] nearest-rank 백분위');
{
  const values = Array.from({ length: 100 }, (_, i) => i + 1);
  check('p50', percentile(values, 50) === 50);
  check('p95', percentile(values, 95) === 95);
  check('p99', percentile(values, 99) === 99);
  check('빈 표본은 null', percentile([], 95) === null);
  check('표본 1개', percentile([7], 95) === 7);
  check('보간하지 않는다 (실측값만)', percentile([10, 20, 30], 95) === 30);
  const stats = latencyStats([100, 200, 300, null, undefined, NaN]);
  check('숫자가 아닌 값은 표본에서 빠진다', stats.count === 3, JSON.stringify(stats));
  check('mean', stats.mean === 200);
  check('빈 표본 통계', latencyStats([]).p95 === null);
}

console.log('\n[집계] 성공률과 지연 분포 분리');
{
  const rows = [
    row({ total_ms: 1000 }),
    row({ total_ms: 3000 }),
    row({ status: 'timeout', status_code: 504, error_code: 'generation_timeout', total_ms: 120000 }),
    row({ feature: 'uploads_process', status: 'server_error', status_code: 500, error_code: 'unhandled_exception', total_ms: 400 }),
  ];
  const summary = summarizeRequests(rows);
  check('전체 성공률', summary.successRate === 0.5, String(summary.successRate));
  const gen = summary.features.find((f) => f.feature === 'questions_generate');
  check('기능별 성공률', Math.abs(gen.successRate - 0.6667) < 1e-4, String(gen.successRate));
  // 타임아웃 120초가 성공 경로 p95 를 삼키면 "느리지만 되는" 상태를 볼 수 없다.
  check('성공 경로 지연은 타임아웃을 제외', gen.successLatencyMs.max === 3000, JSON.stringify(gen.successLatencyMs));
  check('전체 지연에는 타임아웃 포함', gen.latencyMs.max === 120000);
  check('상태별 분포', gen.byStatus.timeout === 1);
  check('오류 코드 분포', summary.errorCodes.generation_timeout === 1 && summary.errorCodes.unhandled_exception === 1);
}

console.log('\n[집계] 스키마 준수율 분모');
{
  const rows = [
    row({ schema_valid: true, quality: { questions: 10, schemaViolations: 0, duplicates: 0 } }),
    row({ schema_valid: false, quality: { questions: 10, schemaViolations: 3, duplicates: 2 } }),
    row({ schema_valid: null }), // 검사 대상 아님
  ];
  const quality = summarizeQuality(rows);
  check('검사한 요청만 분모', quality.checkedRequests === 2, String(quality.checkedRequests));
  check('준수율', quality.schemaValidRate === 0.5, String(quality.schemaValidRate));
  // 요청이 아니라 문항이 분모여야 한다 — 10문항 중 3개 위반과 1문항 중 3개 위반은 다르다.
  check('위반율 분모는 문항', quality.violationRate === 0.15, String(quality.violationRate));
  check('중복률 분모도 문항', quality.duplicateRate === 0.1, String(quality.duplicateRate));

  const per = costPerQuestion([
    row({ cost_usd: 0.5, quality: { questions: 10 } }),
    row({ cost_usd: 0.3, quality: { questions: 5 } }),
    row({ cost_usd: 9.9 }), // 문항을 안 만든 요청은 문항당 원가에서 빠진다
  ]);
  check('문항 1개당 원가', per.perQuestionUsd === 0.053333, String(per.perQuestionUsd));
  check('문항 없는 요청 제외', per.questions === 15 && per.requests === 2);
}

console.log('\n[집계] 재시도 성공률');
{
  const t = (min) => new Date(Date.UTC(2026, 7, 22, 0, min)).toISOString();
  const rows = [
    // 실패 → 2분 뒤 같은 사용자·같은 기능 성공 = 회복
    row({ user_id: 'a', status: 'server_error', status_code: 500, created_at: t(0) }),
    row({ user_id: 'a', status: 'success', created_at: t(2) }),
    // 실패 → 30분 뒤 = 창 밖이라 재시도로 세지 않는다
    row({ user_id: 'b', status: 'server_error', status_code: 500, created_at: t(0) }),
    row({ user_id: 'b', status: 'success', created_at: t(30) }),
    // 실패 후 아무것도 없음 = 이탈
    row({ user_id: 'c', status: 'server_error', status_code: 500, created_at: t(0) }),
  ];
  const retry = summarizeRetries(rows);
  check('실패 수', retry.failures === 3, String(retry.failures));
  check('창 안의 재시도만 센다', retry.retried === 1, String(retry.retried));
  check('회복률', retry.recoveryRate === 1, String(retry.recoveryRate));
  check('이탈률', Math.abs(retry.abandonRate - 0.6667) < 1e-4, String(retry.abandonRate));

  // 다른 사용자의 성공을 내 재시도로 세면 회복률이 부풀려진다.
  const crossUser = summarizeRetries([
    row({ user_id: 'a', status: 'server_error', status_code: 500, created_at: t(0) }),
    row({ user_id: 'b', status: 'success', created_at: t(1) }),
  ]);
  check('다른 사용자는 재시도가 아니다', crossUser.retried === 0, String(crossUser.retried));
}

console.log('\n[기능 이름] id 가 축에 새지 않는가');
{
  check('생성', featureFromPath('/api/questions/generate') === 'questions_generate');
  check(
    'uuid 제거',
    featureFromPath('/api/uploads/3f2a7c1e-1111-2222-3333-444455556666/diagnostics') === 'uploads_diagnostics',
    featureFromPath('/api/uploads/3f2a7c1e-1111-2222-3333-444455556666/diagnostics'),
  );
  check(
    '서로 다른 업로드가 같은 기능으로 모인다',
    featureFromPath('/api/uploads/11111111-1111-1111-1111-111111111111/route') ===
      featureFromPath('/api/uploads/22222222-2222-2222-2222-222222222222/route'),
  );
  check('숫자 세그먼트 제거', featureFromPath('/api/mock-exams/42') === 'mock_exams');
  check('CPX 는 한 이름으로 접는다', featureFromPath('/api/cpx/sessions/abc/evaluate') === 'cpx_proxy');
  check('api 밖', featureFromPath('/dashboard') === 'page');
  check('버전 매핑', versionForFeature('uploads_diagnostics').startsWith('private_generation-p'));
}

console.log('\n[품질 게이트] 계약 위반 탐지');
{
  const good = {
    stem: '55세 남자가 2시간 전부터 시작된 가슴 통증으로 왔다. 가장 가능성이 높은 진단은?',
    choices: ['기흉', '폐색전증', '안정협심증', '급성심근경색증', '급성대동맥박리'],
    answer_index: 3,
    explanation: '심전도에서 ST분절 상승이 관찰되어 급성심근경색증에 합당하다.',
  };
  check('정상 문항은 계약 위반 없음', checkQuestionSchema(good).filter((c) => !c.startsWith('format:')).length === 0,
    JSON.stringify(checkQuestionSchema(good)));
  check('선지 4개는 범위 위반', checkQuestionSchema({ ...good, choices: good.choices.slice(0, 4) }).includes('range:choices'));
  check('정답 인덱스 범위', checkQuestionSchema({ ...good, answer_index: 9 }).includes('range:answer_index'));
  check('정답 인덱스 자료형', checkQuestionSchema({ ...good, answer_index: '3' }).includes('type:answer_index'));
  check('빈 해설', checkQuestionSchema({ ...good, explanation: '   ' }).includes('empty:explanation'));
  check('중복 선지', checkQuestionSchema({ ...good, choices: ['기흉', '기흉', 'a', 'b', 'c'] }).includes('duplicate:choice'));
  check('발문 없음', checkQuestionSchema({ ...good, stem: '' }).includes('empty:stem'));
}

console.log('\n[품질 게이트] 중복 탐지');
{
  check('같은 문장 = 1.0', Math.abs(lexicalSimilarity('가슴 통증 환자', '가슴 통증 환자') - 1) < 1e-9);
  check('전혀 다른 문장은 낮다', lexicalSimilarity('가슴 통증 환자입니다', '무릎 관절이 붓고 아픕니다') < 0.2);
  check('공백·문장부호 차이는 무시', Math.abs(lexicalSimilarity('가슴 통증, 환자', '가슴통증 환자') - 1) < 1e-9);
  check('코사인 동일 벡터', Math.abs(cosineSimilarity([1, 0, 1], [1, 0, 1]) - 1) < 1e-9);
  check('코사인 직교', Math.abs(cosineSimilarity([1, 0], [0, 1])) < 1e-9);

  const stem = '55세 남자가 2시간 전 시작된 가슴 통증으로 응급실에 왔다. 진단은?';
  const { duplicates, mode } = findDuplicates([
    { index: 0, text: stem },
    { index: 1, text: '30세 여자가 두통으로 왔다. 가장 알맞은 검사는?' },
    { index: 2, text: `${stem} ` },
  ]);
  check('배치 안 중복을 잡는다', duplicates.length === 1 && duplicates[0].index === 2, JSON.stringify(duplicates));
  check('벡터가 없으면 lexical 모드', mode === 'lexical');
  check('중복 아닌 문항은 걸리지 않는다', !duplicates.some((d) => d.index === 1));

  const withPrior = findDuplicates(
    [{ index: 0, text: stem }],
    [{ id: 'q-prior', text: stem }],
  );
  check('기존 문항과의 중복도 잡는다', withPrior.duplicates[0]?.against === 'q-prior', JSON.stringify(withPrior.duplicates));

  const embedded = findDuplicates([
    { index: 0, text: 'a', embedding: [1, 0, 0] },
    { index: 1, text: 'b', embedding: [1, 0, 0] },
    { index: 2, text: 'c', embedding: [0, 1, 0] },
  ]);
  check('벡터가 있으면 embedding 모드', embedded.mode === 'embedding');
  check('벡터 중복 탐지', embedded.duplicates.length === 1 && embedded.duplicates[0].index === 1);
}

console.log(`\n통과 ${pass} · 실패 ${fail}`);
if (fail > 0) process.exit(1);
console.log('운영 지표 산식·계측 회귀 검사 통과.');

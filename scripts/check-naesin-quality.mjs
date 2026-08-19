/**
 * 내신대비 문항 품질 계측 — 기준선을 숫자로 찍는다.
 *
 * 왜 이 스크립트가 먼저인가: ② 파이프라인 수정(P1·P3·P4…)이 개선인지 아닌지는
 * "고치기 전 숫자"가 있어야만 증명된다. 감사에서 나온 결함(정답 3번 30.7 %,
 * 최장 선지=정답 32.6 %, 임상형을 요청해도 지식형이 나옴, 난이도가 장식)은 전부
 * 로그에 흔적을 안 남긴다 — 저장은 정상이고 문항 수도 맞다. 세지 않으면 아무도 모른다.
 *
 * 읽기만 하며 DB 를 바꾸지 않는다.
 *
 *   npm run check:naesin-quality
 *   npm run check:naesin-quality -- --days 30
 *   npm run check:naesin-quality -- --days 7 --out outputs/naesin-quality.json
 *
 * 옵션
 *   --days <n>     최근 며칠치를 볼지 (기본 14)
 *   --user <uuid>  특정 사용자만
 *   --out <경로>   전체 지표를 JSON 으로 저장
 *   --top <n>      발문 문미 상위 몇 개를 출력할지 (기본 10)
 *   --no-exit      임계 초과여도 exit 0 (관찰용)
 *
 * 환경변수 (.env.local 또는 셸)
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * 주의: CI 에 넣지 않는다(운영 DB 접근). 주 1회 수동 또는 크론으로 돌린다.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  extractAsk,
  hasForbiddenAsk,
  hasPatientIntro,
  isClinicalVignette,
} from '../lib/ai/clinical-shape.ts';

function loadEnvLocal() {
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const value = m[2].replace(/^["']|["']$/g, '');
      if (!process.env[m[1]]) process.env[m[1]] = value;
    }
  }
}
loadEnvLocal();

const args = process.argv.slice(2);
function opt(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const flag = (name) => args.includes(name);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.');
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });
const days = Number(opt('--days', '14'));
const userFilter = opt('--user');
const outPath = opt('--out');
const topN = Number(opt('--top', '10'));
const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

// ── 임계값. 넘으면 exit 1.
//   정답 쏠림·길이 누출은 "지식 없이 답이 보이는" 결함이라 학습 효과를 직접 깎는다.
//   임상 수확률은 요청한 유형이 실제로 나오는지 — 사용자가 돈을 낸 기능이 도는지다.
const THRESHOLDS = {
  answerPositionMaxShare: 0.30, // 한 위치에 30 % 이상 몰리면 실패 (기대 20 %)
  longestIsAnswerShare: 0.28,   // 최장 선지=정답 28 % 이상이면 실패 (기대 20 %)
  clinicalYieldMin: 0.80,       // 임상형 요청 대비 실제 임상형 수확률 하한
};

// ── PostgREST 는 group by 집계를 못 준다(400). 행을 페이징으로 받아 로컬에서 센다.
const PAGE = 1000;

/**
 * 없는 컬럼을 SELECT 하면 Postgres 가 42703 으로 거절한다
 * (UPDATE/INSERT 본문이면 PostgREST 가 먼저 PGRST204 로 막는다 — 코드가 다르다).
 * 마이그레이션 00040 은 `db push` 금지 정책 때문에 사람이 SQL Editor 에서 적용한다.
 * 이 스크립트는 **적용 전에도 돌아야 한다** — 그게 기준선이기 때문이다.
 */
const MISSING_COLUMN_CODE = '42703';

async function fetchPage(table, columns, tune, page) {
  let q = db.from(table).select(columns).range(page * PAGE, page * PAGE + PAGE - 1);
  q = tune(q);
  return q;
}

/** columns 로 먼저 시도하고, 없는 컬럼 때문에 실패하면 fallbackColumns 로 한 번 더. */
async function fetchAll(table, columns, tune, fallbackColumns = null) {
  const rows = [];
  let used = columns;
  for (let page = 0; page < 200; page += 1) {
    let { data, error } = await fetchPage(table, used, tune, page);
    if (error && error.code === MISSING_COLUMN_CODE && fallbackColumns && used === columns) {
      used = fallbackColumns;
      ({ data, error } = await fetchPage(table, used, tune, page));
    }
    if (error) throw new Error(`${table} 조회 실패: ${error.message} (${error.code ?? '-'})`);
    rows.push(...(data ?? []));
    if ((data ?? []).length < PAGE) break;
  }
  return { rows, degraded: used !== columns };
}

const uploadsResult = await fetchAll(
  'user_uploads',
  'id, user_id, created_at, status, file_name, requested_difficulty, requested_types, generation_style, reference_count, content_sha256',
  (q) => {
    let x = q.gte('created_at', since).order('created_at', { ascending: false });
    if (userFilter) x = x.eq('user_id', userFilter);
    return x;
  },
  'id, user_id, created_at, status, file_name',
);
const uploads = uploadsResult.rows;
const hasRequestColumns = !uploadsResult.degraded;

if (uploads.length === 0) {
  console.log(`최근 ${days}일 업로드가 없습니다. --days 를 늘려보세요.`);
  process.exit(0);
}

const uploadById = new Map(uploads.map((u) => [u.id, u]));
const uploadIds = uploads.map((u) => u.id);

// upload_id in (...) 를 한 번에 넣으면 URL 이 길어져 414 가 난다. 200개씩 끊는다.
const questions = [];
let hasKindColumn = true;
for (let i = 0; i < uploadIds.length; i += 200) {
  const chunk = uploadIds.slice(i, i + 200);
  const part = await fetchAll(
    'private_questions',
    'id, upload_id, stem, choices, answer_index, explanation, difficulty, kind, ask_kind, verify_score, created_at',
    (q) => q.in('upload_id', chunk),
    'id, upload_id, stem, choices, answer_index, explanation, difficulty, created_at',
  );
  questions.push(...part.rows);
  if (part.degraded) hasKindColumn = false;
}

if (questions.length === 0) {
  console.log(`최근 ${days}일 생성 문항이 없습니다.`);
  process.exit(0);
}

const pct = (n, d) => (d > 0 ? n / d : 0);
const fmtPct = (x) => `${(x * 100).toFixed(1)}%`;
const failures = [];

// ── 1) 정답 위치 분포
const positions = [0, 0, 0, 0, 0];
for (const q of questions) {
  const i = Number(q.answer_index);
  if (Number.isInteger(i) && i >= 0 && i < 5) positions[i] += 1;
}
const positionShares = positions.map((n) => pct(n, questions.length));
const worstPosition = positionShares.reduce(
  (acc, share, i) => (share > acc.share ? { share, i } : acc),
  { share: 0, i: 0 },
);
if (worstPosition.share >= THRESHOLDS.answerPositionMaxShare) {
  failures.push(
    `정답 위치 쏠림: ${worstPosition.i + 1}번 ${fmtPct(worstPosition.share)} ` +
      `(임계 ${fmtPct(THRESHOLDS.answerPositionMaxShare)}, 기대 20 %)`,
  );
}

// ── 2) 최장 선지 = 정답 비율 (길이만 보고 답을 고를 수 있는가)
let longestIsAnswer = 0;
let lengthComparable = 0;
for (const q of questions) {
  const choices = Array.isArray(q.choices) ? q.choices.map((c) => String(c ?? '')) : [];
  if (choices.length < 2) continue;
  lengthComparable += 1;
  const lengths = choices.map((c) => c.replace(/\s/g, '').length);
  const max = Math.max(...lengths);
  // 최장이 유일할 때만 센다(동률이면 길이가 단서가 아니다).
  if (lengths.filter((l) => l === max).length === 1 && lengths[q.answer_index] === max) {
    longestIsAnswer += 1;
  }
}
const longestShare = pct(longestIsAnswer, lengthComparable);
if (longestShare >= THRESHOLDS.longestIsAnswerShare) {
  failures.push(
    `최장 선지=정답 ${fmtPct(longestShare)} (임계 ${fmtPct(THRESHOLDS.longestIsAnswerShare)}, 기대 20 %)`,
  );
}

// ── 3) 요청 유형 vs 실제 유형 (수확률)
const TYPE_TO_KIND = { 지식형: 'knowledge', 임상형: 'clinical', 이미지형: 'image' };
const byUpload = new Map();
for (const q of questions) {
  const list = byUpload.get(q.upload_id) ?? [];
  list.push(q);
  byUpload.set(q.upload_id, list);
}

const kindCounts = { knowledge: 0, clinical: 0, image: 0, unlabeled: 0 };
for (const q of questions) {
  if (q.kind && kindCounts[q.kind] !== undefined) kindCounts[q.kind] += 1;
  else kindCounts.unlabeled += 1;
}

// 요청 유형별 수확률. 생성 코드의 쿼터 계산(clinicalQuotaFor)과 같은 식으로 기대치를 잡는다:
// 유형 하나만 골랐으면 전량, 섞였으면 유형 수로 나눈 몫.
const yieldRows = [];
for (const [uploadId, list] of byUpload) {
  const upload = uploadById.get(uploadId);
  const types = Array.isArray(upload?.requested_types) ? upload.requested_types : [];
  if (types.length === 0) continue;
  const expectedShare = types.length <= 1 ? 1 : 1 / types.length;
  for (const type of types) {
    const kind = TYPE_TO_KIND[type];
    if (!kind) continue;
    const actual = list.filter((q) => q.kind === kind).length;
    const expected = Math.max(1, Math.ceil(list.length * expectedShare));
    yieldRows.push({ uploadId, type, kind, actual, expected, total: list.length });
  }
}
const yieldByType = {};
for (const row of yieldRows) {
  const acc = (yieldByType[row.type] ??= { actual: 0, expected: 0, uploads: 0 });
  acc.actual += row.actual;
  acc.expected += row.expected;
  acc.uploads += 1;
}
if (hasKindColumn && yieldByType['임상형']) {
  const y = pct(yieldByType['임상형'].actual, yieldByType['임상형'].expected);
  if (y < THRESHOLDS.clinicalYieldMin) {
    failures.push(
      `임상형 수확률 ${fmtPct(y)} (임계 ${fmtPct(THRESHOLDS.clinicalYieldMin)}) — ` +
        `요청 ${yieldByType['임상형'].expected}문항 대비 실제 ${yieldByType['임상형'].actual}문항`,
    );
  }
}

// ── 4) 요청 난이도 vs 모델 self-report 난이도
const DIFF_TO_LEVEL = { 하: 1, 중: 2, 상: 3 };
const difficultyByRequest = {};
for (const [uploadId, list] of byUpload) {
  const requested = uploadById.get(uploadId)?.requested_difficulty;
  if (!requested) continue;
  const acc = (difficultyByRequest[requested] ??= { 1: 0, 2: 0, 3: 0, total: 0, match: 0 });
  for (const q of list) {
    const d = Number(q.difficulty);
    if (acc[d] !== undefined) acc[d] += 1;
    acc.total += 1;
    if (d === DIFF_TO_LEVEL[requested]) acc.match += 1;
  }
}

// ── 5) 발문 문미 분포 + '가장' 비율 + 껍데기 증례
const askCounts = new Map();
let mostFrequentAsk = 0;
let shellVignette = 0;
let clinicalShaped = 0;
for (const q of questions) {
  const ask = extractAsk(String(q.stem ?? ''));
  askCounts.set(ask, (askCounts.get(ask) ?? 0) + 1);
  if (/가장/.test(ask)) mostFrequentAsk += 1;
  const stem = String(q.stem ?? '');
  if (isClinicalVignette(stem)) clinicalShaped += 1;
  // 껍데기 증례: 환자 도입은 있는데 증례로 성립하지 않는다(임상 정보 없음/지식형 발문).
  else if (hasPatientIntro(stem)) shellVignette += 1;
}
const topAsks = [...askCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN);

// ── 5-b) 금지 발문(P3)·ask_kind 분포
// "'가장' 포함"은 "가장 흔한 원인은?" 같은 정당한 발문까지 세므로 개선을 과소평가한다.
// 실제로 막으려는 것(선지 우열을 흐리는 "가장 적절한" 류)만 따로 센다.
let forbiddenAsk = 0;
const askKindCounts = new Map();
let askKindLabeled = 0;
for (const q of questions) {
  if (hasForbiddenAsk(String(q.stem ?? ''))) forbiddenAsk += 1;
  const ak = q.ask_kind ?? null;
  if (ak) {
    askKindLabeled += 1;
    askKindCounts.set(ak, (askKindCounts.get(ak) ?? 0) + 1);
  }
}
const topAskKinds = [...askKindCounts.entries()].sort((a, b) => b[1] - a[1]);
// 같은 업로드 안에서 같은 ask_kind 가 반복된 정도(유형 편중) — 라벨이 있는 문항만.
let askKindRepeat = 0;
for (const [, list] of byUpload) {
  const labeled = list.map((q) => q.ask_kind).filter(Boolean);
  askKindRepeat += labeled.length - new Set(labeled).size;
}

// ── 6) 해설 길이
const explanationLengths = questions
  .map((q) => String(q.explanation ?? '').length)
  .sort((a, b) => a - b);
const quantile = (arr, p) =>
  arr.length === 0 ? 0 : arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];

// ── 7) 세션 내 중복 (같은 업로드 안에서 첫 40자가 같은 문항)
let inUploadDuplicates = 0;
const duplicateSamples = [];
for (const [uploadId, list] of byUpload) {
  const seen = new Map();
  for (const q of list) {
    const head = String(q.stem ?? '').replace(/\s/g, '').slice(0, 40);
    if (!head) continue;
    if (seen.has(head)) {
      inUploadDuplicates += 1;
      if (duplicateSamples.length < 5) {
        duplicateSamples.push({ uploadId, head: head.slice(0, 30) });
      }
    } else seen.set(head, q.id);
  }
}

// ── 8) 세션 간 중복 (같은 파일을 다시 올렸을 때 같은 발문이 또 나오는가)
const shaGroups = new Map();
for (const u of uploads) {
  if (!u.content_sha256) continue;
  const groupKey = `${u.user_id}:${u.content_sha256}`;
  shaGroups.set(groupKey, [...(shaGroups.get(groupKey) ?? []), u.id]);
}
let reuploadPairs = 0;
let reuploadDuplicateStems = 0;
for (const ids of shaGroups.values()) {
  if (ids.length < 2) continue;
  reuploadPairs += 1;
  const heads = new Map();
  for (const id of ids) {
    for (const q of byUpload.get(id) ?? []) {
      const head = String(q.stem ?? '').replace(/\s/g, '').slice(0, 40);
      if (!head) continue;
      if (heads.has(head) && heads.get(head) !== id) reuploadDuplicateStems += 1;
      else heads.set(head, id);
    }
  }
}

// ── 9) P1 검증 커버리지 (verify_score 가 채워지는가)
const verified = questions.filter((q) => typeof q.verify_score === 'number');
const verifyScores = verified.map((q) => q.verify_score).sort((a, b) => a - b);

// ── 10) 생성 진단(ai_cost_log)에서 폐기 카운터를 모은다.
let diagnostics = [];
try {
  diagnostics = (
    await fetchAll('ai_cost_log', 'created_at, metadata', (q) =>
      q.eq('endpoint', 'private.diagnostics').gte('created_at', since),
    )
  ).rows;
} catch (e) {
  console.warn(`진단 로그 조회 생략: ${e.message}`);
}
const diagTotals = {};
for (const row of diagnostics) {
  const gen = row.metadata?.generation ?? {};
  for (const [k, v] of Object.entries(gen)) {
    if (typeof v === 'number') diagTotals[k] = (diagTotals[k] ?? 0) + v;
  }
}

// ─────────────────────────── 출력 ───────────────────────────
const line = (label, value) => console.log(`  ${label.padEnd(30, ' ')} ${value}`);

console.log(`\n내신대비 품질 계측 — 최근 ${days}일 (기준 ${since.slice(0, 10)} 이후)`);
console.log(`업로드 ${uploads.length}건 / 문항 ${questions.length}개\n`);

if (!hasRequestColumns || !hasKindColumn) {
  console.log('⚠ 마이그레이션 00040 이 아직 적용되지 않았습니다 (SQL Editor 직접 실행 필요).');
  console.log('  요청 조건·유형 라벨이 없어 수확률·난이도 대조는 건너뜁니다.\n');
}

console.log('① 정답 위치 분포 (기대 각 20 %)');
positionShares.forEach((share, i) => line(`${i + 1}번`, `${positions[i]}개 ${fmtPct(share)}`));

console.log('\n② 길이 누출');
line('최장 선지 = 정답', `${longestIsAnswer}/${lengthComparable} ${fmtPct(longestShare)}`);

console.log('\n③ 문항 유형 (요청 vs 실제)');
line('실제 knowledge', `${kindCounts.knowledge}개`);
line('실제 clinical', `${kindCounts.clinical}개`);
line('실제 image', `${kindCounts.image}개`);
if (kindCounts.unlabeled > 0) line('라벨 없음(00040 이전)', `${kindCounts.unlabeled}개`);
for (const [type, acc] of Object.entries(yieldByType)) {
  line(`${type} 수확률`, `${acc.actual}/${acc.expected} ${fmtPct(pct(acc.actual, acc.expected))} (업로드 ${acc.uploads}건)`);
}

console.log('\n④ 난이도 (요청 vs 모델 self-report)');
if (Object.keys(difficultyByRequest).length === 0) line('-', '요청 난이도 기록 없음');
for (const [requested, acc] of Object.entries(difficultyByRequest)) {
  line(
    `요청 '${requested}' (${acc.total}문항)`,
    `1:${fmtPct(pct(acc[1], acc.total))} 2:${fmtPct(pct(acc[2], acc.total))} 3:${fmtPct(pct(acc[3], acc.total))} / 일치 ${fmtPct(pct(acc.match, acc.total))}`,
  );
}

console.log('\n⑤ 발문');
line(
  '금지 발문("가장 적절한"류)',
  `${forbiddenAsk}/${questions.length} ${fmtPct(pct(forbiddenAsk, questions.length))}`,
);
line("'가장' 포함(예외 포함)", `${mostFrequentAsk}/${questions.length} ${fmtPct(pct(mostFrequentAsk, questions.length))}`);
line('임상 증례형', `${clinicalShaped}/${questions.length} ${fmtPct(pct(clinicalShaped, questions.length))}`);
line('껍데기 증례', `${shellVignette}/${questions.length} ${fmtPct(pct(shellVignette, questions.length))}`);
console.log(`  발문 문미 top${topN}`);
topAsks.forEach(([ask, n], i) => {
  console.log(`    ${String(i + 1).padStart(2)}. ${n}회 ${fmtPct(pct(n, questions.length))}  ${ask.slice(0, 46)}`);
});

console.log('\n⑤-b 발문 유형(ask_kind)');
if (askKindLabeled === 0) {
  line('-', '라벨 없음(P3 배포 전 문항이거나 00040 미적용)');
} else {
  line('라벨된 문항', `${askKindLabeled}/${questions.length} ${fmtPct(pct(askKindLabeled, questions.length))}`);
  line('같은 업로드 내 유형 반복', `${askKindRepeat}건`);
  topAskKinds.forEach(([k, n]) => {
    console.log(`    · ${String(k).padEnd(24)} ${n}회 ${fmtPct(pct(n, askKindLabeled))}`);
  });
}

console.log('\n⑥ 해설 길이 (자)');
line('중앙값 / p90 / 최대', `${quantile(explanationLengths, 0.5)} / ${quantile(explanationLengths, 0.9)} / ${explanationLengths[explanationLengths.length - 1] ?? 0}`);

console.log('\n⑦ 중복');
line('같은 업로드 내 첫 40자 동일', `${inUploadDuplicates}건`);
line('같은 파일 재업로드 쌍', `${reuploadPairs}쌍`);
line('재업로드 간 발문 동일', `${reuploadDuplicateStems}건`);
duplicateSamples.forEach((d) => console.log(`    · ${d.head}…`));

console.log('\n⑧ 검증(P1) 커버리지');
line('verify_score 기록', `${verified.length}/${questions.length} ${fmtPct(pct(verified.length, questions.length))}`);
if (verifyScores.length > 0) {
  line('점수 중앙값 / p10', `${quantile(verifyScores, 0.5).toFixed(2)} / ${quantile(verifyScores, 0.1).toFixed(2)}`);
}
const diagKeys = Object.keys(diagTotals).sort();
if (diagKeys.length > 0) {
  console.log(`  생성 진단 누계 (업로드 ${diagnostics.length}건)`);
  for (const k of diagKeys) console.log(`    · ${k}: ${diagTotals[k]}`);
}

const report = {
  since,
  days,
  uploads: uploads.length,
  questions: questions.length,
  migrationApplied: hasKindColumn && hasRequestColumns,
  answerPositions: positions,
  answerPositionShares: positionShares,
  longestIsAnswer: { count: longestIsAnswer, of: lengthComparable, share: longestShare },
  kindCounts,
  yieldByType,
  difficultyByRequest,
  ask: {
    mostShare: pct(mostFrequentAsk, questions.length),
    clinicalShare: pct(clinicalShaped, questions.length),
    shellVignetteShare: pct(shellVignette, questions.length),
    top: topAsks.map(([ask, n]) => ({ ask, n })),
  },
  explanation: {
    median: quantile(explanationLengths, 0.5),
    p90: quantile(explanationLengths, 0.9),
    max: explanationLengths[explanationLengths.length - 1] ?? 0,
  },
  duplicates: { inUpload: inUploadDuplicates, reuploadPairs, reuploadDuplicateStems },
  verification: {
    covered: verified.length,
    medianScore: verifyScores.length ? quantile(verifyScores, 0.5) : null,
  },
  diagnosticsTotals: diagTotals,
  failures,
};

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n전체 지표 저장: ${outPath}`);
}

console.log('');
if (failures.length === 0) {
  console.log('✅ 임계 초과 없음');
  process.exit(0);
}
console.log('❌ 임계 초과');
failures.forEach((f) => console.log(`  · ${f}`));
process.exit(flag('--no-exit') ? 0 : 1);

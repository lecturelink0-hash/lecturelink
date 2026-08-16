/**
 * 로딩 화면의 "남은 시간" 정확도를 프로덕션 실행 기록으로 재생해 측정한다.
 *
 * 왜 필요한가: 남은 시간 추산은 눈으로는 검증이 안 된다. 한 번 돌려 보고 "그럴듯하다"고
 * 판단하면 2026-08-16 처럼 **진행률이 멈춘 실행에서 남은 시간이 거꾸로 늘어나는**
 * 설계 결함을 놓친다. 파이프라인이 실행마다 ai_cost_log 에 단계별 소요를 남기므로,
 * 그 기록을 1초 간격 타임라인으로 되살려 GenerationLoadingGame 과 같은 계산을 돌리면
 * "실제로 얼마나 맞았는지"를 숫자로 확인할 수 있다.
 *
 *   node --experimental-strip-types --no-warnings scripts/replay-eta-accuracy.mjs [--limit 20]
 *
 * 검사 항목 (하나라도 어긋나면 종료 코드 1)
 *   - 표시되는 남은 시간이 **한 번도 증가하지 않을 것** (가장 중요한 성질)
 *   - 실행별 오차 중앙값의 중앙값이 임계치 이하일 것
 *
 * 주의: 소요 모델 상수(PREP_SEC/WAVE_SEC/WAVE_QUESTIONS)와 구간표(STAGE_RANGES)는
 * components/notes/GenerationLoadingGame.tsx 와 **같은 값을 유지해야 한다**.
 * 한쪽만 바꾸면 이 재생은 실제 화면과 다른 것을 재고 있는 셈이 된다.
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';

function loadEnvLocal() {
  for (const file of ['.env.local', '.env']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
loadEnvLocal();

const argv = process.argv;
const arg = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const LIMIT = Number(arg('limit') ?? 20);
/** 실행별 오차 중앙값의 중앙값 허용 상한(초). */
const MEDIAN_ERROR_BUDGET_SEC = 10;

// ── GenerationLoadingGame.tsx 와 동일해야 하는 값들 ───────────────────
const STAGE_RANGES = {
  queued: [0, 4],
  downloading: [4, 8],
  extracting: [8, 32],
  vision: [32, 46],
  ocr: [46, 60],
  generating: [32, 97],
  partially_completed: [32, 97],
  completed: [100, 100],
};
const WAVE_QUESTIONS = 16;
const PREP_SEC = { image: 10, text: 3 };
const WAVE_SEC = { image: 30, text: 6 };
const SCAN_PATH_MIN_REMAIN_SEC = 40;
const predictPerFileSec = (n, img) =>
  PREP_SEC[img ? 'image' : 'text'] +
  WAVE_SEC[img ? 'image' : 'text'] * Math.max(1, Math.ceil(Math.max(1, n) / WAVE_QUESTIONS));

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다 (.env.local).');
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const { data: rows, error } = await db
  .from('ai_cost_log')
  .select('created_at, metadata')
  .eq('endpoint', 'private.diagnostics')
  .order('created_at', { ascending: false })
  .limit(LIMIT);
if (error) {
  console.error(`진단 기록 조회 실패: ${error.message}`);
  process.exit(2);
}
if (!rows?.length) {
  console.error('진단 기록이 없습니다.');
  process.exit(2);
}

/**
 * 진단 기록 → 1초 간격 (단계, 진행률) 타임라인.
 * 서버가 클라이언트에 보고하는 단계 전이를 timings 로 되살린다.
 */
function buildTimeline(m) {
  const t = m.timings ?? {};
  const total = t.totalMs ?? 0;
  const extractDone = t.extractAwaitedMs ?? 0;
  const firstBatch = t.firstBatchStartMs ?? 0;
  const desired = m.desiredCount || 10;
  const prefire = m.generation?.prefireCount ?? 0;
  const ocrCalls = m.extract?.ocrCalls ?? 0;
  const ocrMs = t.ocrMs ?? 0;
  // 선발사 배치가 없을 때만 서버가 'ocr' 단계를 실제로 보고한다(스캔 자료 경로).
  const usesOcrStage = prefire === 0 && ocrCalls > 0;
  const ocrEnd = extractDone + ocrMs;
  const completions = (m.batches ?? []).map((b, i) => ({
    at: (i < prefire ? firstBatch : Math.max(extractDone, usesOcrStage ? ocrEnd : 0)) + (b.totalMs || 0),
    kept: b.kept ?? b.size ?? 0,
  }));
  const samples = [];
  for (let ms = 0; ms <= total; ms += 1000) {
    let stage;
    if (ms < 200) stage = 'downloading';
    else if (ms < extractDone) stage = 'extracting';
    else if (usesOcrStage && ms < ocrEnd) stage = 'ocr';
    else stage = 'generating';
    let done = 0;
    for (const c of completions) if (c.at <= ms) done += c.kept;
    done = Math.min(done, desired);
    const [lo, hi] = STAGE_RANGES[stage];
    let frac = 0;
    if (stage === 'generating') frac = desired > 0 ? done / desired : 0;
    else if (stage === 'extracting') frac = extractDone > 0 ? Math.min(1, ms / extractDone) : 0;
    else if (stage === 'ocr') frac = ocrMs > 0 ? Math.min(1, (ms - extractDone) / ocrMs) : 0;
    samples.push({ ms, stage, pct: lo + (hi - lo) * frac });
  }
  return { samples, totalSec: total / 1000, desired, withImages: !!m.wantsImages };
}

/** GenerationLoadingGame 의 남은 시간 계산과 같은 절차. 숫자 또는 문구 상태를 돌려준다. */
function replayEta({ samples, desired, withImages }) {
  const waves = Math.max(1, Math.ceil(desired / WAVE_QUESTIONS));
  const waveSec = (withImages ? WAVE_SEC.image : WAVE_SEC.text) * waves;
  let total = predictPerFileSec(desired, withImages);
  let shown = { secs: total, at: 0 };
  let moved = { pct: samples[0]?.pct ?? 0, at: 0 };
  let genEntered = 0;
  let scanEntered = 0;
  let lastWasNumber = false;
  const out = [];
  for (const s of samples) {
    const t = s.ms / 1000;
    if (Math.round(s.pct) !== Math.round(moved.pct)) moved = { pct: s.pct, at: t };
    const scanning = s.stage === 'vision' || s.stage === 'ocr';
    if (scanning && scanEntered === 0) {
      scanEntered = t;
      total = Math.max(total, t + SCAN_PATH_MIN_REMAIN_SEC + waveSec);
    }
    if (scanning && scanEntered > 0) {
      const [lo, hi] = STAGE_RANGES[s.stage];
      const frac = hi > lo ? (s.pct - lo) / (hi - lo) : 0;
      const inStage = t - scanEntered;
      if (frac > 0.15 && inStage > 3) {
        total = Math.max(total, t + (inStage * (1 - frac)) / frac + waveSec);
      }
    }
    if ((s.stage === 'generating' || s.stage === 'partially_completed') && genEntered === 0) {
      genEntered = t;
      total = t + waveSec;
    }
    const stalledFor = t - moved.at;
    if (s.pct >= 97) { lastWasNumber = false; out.push('곧 완료'); continue; }
    if (!withImages && genEntered === 0 && scanEntered === 0) { lastWasNumber = false; out.push('계산 중'); continue; }
    if (t > total * 1.6 || stalledFor > 60) { lastWasNumber = false; out.push('길어지는 중'); continue; }
    const remaining = Math.max(0, total - t);
    if (!lastWasNumber) shown = { secs: remaining, at: t };
    const decayed = shown.secs - (t - shown.at);
    const secs = Math.min(remaining, decayed);
    shown = { secs, at: t };
    if (secs < 3) { lastWasNumber = false; out.push('마무리 중'); continue; }
    lastWasNumber = true;
    out.push(secs);
  }
  return out;
}

const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : NaN);

let increases = 0;
const perRunMedian = [];
console.log(
  `${'실행'.padEnd(12)}${'실제'.padStart(8)}${'초기안내'.padStart(11)}${'오차중앙'.padStart(10)}${'역증가'.padStart(8)}`,
);
for (const r of rows) {
  const m = r.metadata;
  if (!m?.timings?.totalMs) continue;
  const tl = buildTimeline(m);
  const vals = replayEta(tl);
  // 10초 단위로 반올림해 보이는 값 기준으로 증가를 센다(화면 표기와 동일).
  const nums = vals.map((v) => (typeof v === 'number' ? Math.round(v / 10) * 10 : null));
  let inc = 0;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] != null && nums[i - 1] != null && nums[i] > nums[i - 1]) inc++;
  }
  increases += inc;
  const errs = [];
  vals.forEach((v, i) => {
    if (typeof v !== 'number') return;
    const truth = tl.totalSec - i;
    if (truth < 3) return;
    errs.push(Math.abs(v - truth));
  });
  const med = median(errs);
  if (Number.isFinite(med)) perRunMedian.push(med);
  const first = typeof vals[0] === 'number' ? `${vals[0].toFixed(0)}초` : String(vals[0]);
  console.log(
    r.created_at.slice(5, 16).padEnd(12) +
    `${tl.totalSec.toFixed(1)}초`.padStart(8) +
    first.padStart(11) +
    (Number.isFinite(med) ? `${med.toFixed(0)}초` : '-').padStart(10) +
    String(inc).padStart(8),
  );
}

const overall = median(perRunMedian);
console.log('\n─────');
console.log(`실행 수                     : ${perRunMedian.length}`);
console.log(`남은 시간 역증가 합계       : ${increases}회   (허용 0회)`);
console.log(`실행별 오차 중앙값의 중앙값 : ${overall.toFixed(1)}초   (허용 ${MEDIAN_ERROR_BUDGET_SEC}초)`);

const problems = [];
if (increases > 0) {
  problems.push(`남은 시간이 ${increases}회 늘어났다 — 표시는 절대 증가하면 안 된다.`);
}
if (!(overall <= MEDIAN_ERROR_BUDGET_SEC)) {
  problems.push(`오차 중앙값 ${overall.toFixed(1)}초가 허용치를 넘었다 — 소요 모델 상수를 재보정할 때다.`);
}
if (problems.length > 0) {
  console.log('\n이상 신호');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\n이상 없음.');

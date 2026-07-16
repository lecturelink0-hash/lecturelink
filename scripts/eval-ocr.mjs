// @ts-check
/**
 * OCR 품질 측정 하네스 — CER / WER
 *
 * 입력 디렉토리 구조:
 *   eval/ocr-goldenset/
 *     001.png       # 슬라이드/잘라낸 의료 이미지
 *     001.txt       # 사람이 라벨링한 정답 텍스트
 *     002.png
 *     002.txt
 *     ...
 *
 * 사용:
 *   node scripts/eval-ocr.mjs eval/ocr-goldenset --backend auto
 *
 * 출력:
 *   - 각 샘플의 CER / WER
 *   - 집계 평균 + p50 / p90
 *   - 백엔드별 누적 비용
 *
 * 의존성: tsx 또는 컴파일된 lib/ocr/engine.js. 본 데모는 외부 의존 최소화로
 * `dynamic import` 가 동작하는 환경에서 실행. 빌드 산출물은 .next/server 에서 가능.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, basename, extname } from 'node:path';

// ───────── CLI ─────────
const args = process.argv.slice(2);
const dir = args[0];
const backendIdx = args.indexOf('--backend');
const backend = backendIdx >= 0 ? args[backendIdx + 1] : 'auto';

const USAGE = `사용:
  npx tsx scripts/eval-ocr.mjs <goldenset-dir> [--backend auto|tesseract|claude]

골든셋 디렉토리 구조:
  <dir>/001.png   <dir>/001.txt
  <dir>/002.png   <dir>/002.txt
  ...

골든셋이 없으면 docs/p1a-ocr-eval.md 의 구조 안내를 참고하세요.

주의:
  - 본 스크립트는 .ts 모듈을 직접 import 합니다. 'node' 단독으로는 .ts 를 못 읽으므로
    반드시 'npx tsx' 또는 빌드된 .js 를 통해 실행하세요.
  - 실행 시 OCR 백엔드에 따라 Claude/Voyage API 가 실제로 호출됩니다 (비용 발생).
`;

if (!dir || dir === '--help' || dir === '-h') {
  console.log(USAGE);
  process.exit(dir ? 0 : 1);
}
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`디렉토리 없음: ${dir}\n\n${USAGE}`);
  process.exit(1);
}
if (!['auto', 'tesseract', 'claude'].includes(backend)) {
  console.error(`--backend 값이 잘못됨: ${backend}\n${USAGE}`);
  process.exit(1);
}

// ───────── 거리 함수 ─────────

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;

  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j += 1) prev[j] = curr[j];
  }
  return curr[n];
}

function cer(reference, hypothesis) {
  if (reference.length === 0) return hypothesis.length === 0 ? 0 : 1;
  return levenshtein(reference, hypothesis) / reference.length;
}

function wer(reference, hypothesis) {
  const refWords = reference.split(/\s+/).filter(Boolean);
  const hypWords = hypothesis.split(/\s+/).filter(Boolean);
  if (refWords.length === 0) return hypWords.length === 0 ? 0 : 1;
  // 단어 단위 levenshtein: 단어를 토큰화해 동일 알고리즘 적용 (문자 → 단어 비교용 재구성)
  const m = refWords.length;
  const n = hypWords.length;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = refWords[i - 1] === hypWords[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j += 1) prev[j] = curr[j];
  }
  return curr[n] / m;
}

// ───────── 샘플 수집 ─────────
const files = readdirSync(resolve(dir))
  .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
  .sort();

if (files.length === 0) {
  console.error(
    `이미지 파일 없음: ${dir}/*.{png,jpg,webp}\n` +
      '골든셋이 아직 준비되지 않은 환경에서는 정상입니다. docs/p1a-ocr-eval.md 참고.',
  );
  process.exit(1);
}

console.log(`\n📐 OCR 평가 — ${files.length} 샘플, backend=${backend}\n`);

// ───────── OCR 엔진 로드 ─────────
let runOcr;
try {
  const mod = await import('../lib/ocr/engine.ts');
  runOcr = mod.runOcr;
} catch (e) {
  console.error('OCR 엔진 로드 실패. TS 파일을 직접 import 하려면 tsx 실행이 필요합니다:');
  console.error('  npx tsx scripts/eval-ocr.mjs', dir, `--backend ${backend}`);
  console.error('원인:', e?.message ?? e);
  process.exit(1);
}

// ───────── 평가 루프 ─────────
const results = [];
let totalCost = 0;
let totalMs = 0;

for (const file of files) {
  const stem = basename(file, extname(file));
  const refPath = join(resolve(dir), `${stem}.txt`);
  if (!existsSync(refPath)) {
    console.warn(`  skip ${file} (정답 ${stem}.txt 없음)`);
    continue;
  }
  const reference = readFileSync(refPath, 'utf8').trim();
  const png = readFileSync(join(resolve(dir), file));

  const r = await runOcr({ png: new Uint8Array(png), backend });
  const c = cer(reference, r.text);
  const w = wer(reference, r.text);
  totalCost += r.costUsd;
  totalMs += r.durationMs;

  results.push({ file, cer: c, wer: w, backend: r.backend, cost: r.costUsd });
  console.log(
    `  ${file.padEnd(20)}  CER ${(c * 100).toFixed(1).padStart(5)}%   WER ${(w * 100).toFixed(1).padStart(5)}%   ${r.backend}  $${r.costUsd.toFixed(4)}  ${r.durationMs}ms`,
  );
}

if (results.length === 0) {
  console.error('평가된 샘플 0. 정답 파일 페어가 없습니다.');
  process.exit(1);
}

// ───────── 집계 ─────────
const cers = results.map((r) => r.cer).sort((a, b) => a - b);
const wers = results.map((r) => r.wer).sort((a, b) => a - b);
function pct(arr, p) {
  return arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
}

console.log('\n──────────────────────────────────');
console.log(`샘플 수      : ${results.length}`);
console.log(`평균 CER     : ${((cers.reduce((s, v) => s + v, 0) / cers.length) * 100).toFixed(2)}%`);
console.log(`p50 CER      : ${(pct(cers, 0.5) * 100).toFixed(2)}%`);
console.log(`p90 CER      : ${(pct(cers, 0.9) * 100).toFixed(2)}%`);
console.log(`평균 WER     : ${((wers.reduce((s, v) => s + v, 0) / wers.length) * 100).toFixed(2)}%`);
console.log(`총 비용      : $${totalCost.toFixed(4)}`);
console.log(`총 소요      : ${(totalMs / 1000).toFixed(1)}s`);
console.log('──────────────────────────────────\n');

/**
 * 강의록 PDF 1개의 이미지 추출을 프로덕션과 같은 조건으로 돌려 보고, 이상 신호를 보고한다.
 *
 * 왜 필요한가: 문항 생성이 "느리다/안 끝난다"는 제보가 들어와도 원인이 강의록 형식에
 * 있는지 확인할 방법이 없었다. 실제 사고(2026-08-16)에서 어떤 강의록은 같은 그림을 여러
 * 슬라이드에 재사용했고, 그 그림이 pdfjs 전역 스코프(g_) 객체로 승격돼 조회가 영영
 * 끝나지 않아 생성 전체가 66 % 에서 멈췄다. 새 형식의 강의록을 받았을 때 이 스크립트로
 * 먼저 훑으면 같은 부류의 문제를 몇 초 만에 가려낼 수 있다.
 *
 *   node --experimental-strip-types --no-warnings scripts/check-pdf-extraction.mjs <파일.pdf> [--max-images 40]
 *
 * 종료 코드: 이상 신호(상한 초과·시간 초과·이미지 0장)가 있으면 1.
 */

import { existsSync, readFileSync } from 'node:fs';
import { extractPdfImageObjects } from '../lib/extract/pdf-image-objects.ts';

const argv = process.argv;
const arg = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
// node 실행 경로·스크립트 경로를 파일로 오인하지 않도록 뒤에서 첫 비옵션 인자를 쓴다.
const file = argv.slice(2).find((a) => !a.startsWith('--') && a.toLowerCase().endsWith('.pdf'));

if (!file || !existsSync(file)) {
  console.error('사용법: node --experimental-strip-types scripts/check-pdf-extraction.mjs <파일.pdf>');
  process.exit(2);
}

// 프로덕션(private-generation.ts)과 같은 값.
const MAX_IMAGES = Number(arg('max-images') ?? 40);
const MIN_EDGE_PX = 200;
const MAX_OUT_EDGE_PX = 1024;
/** 이 시간을 넘기면 생성 체감이 눈에 띄게 나빠진다(정상 강의록 실측 2~6초). */
const SLOW_MS = 20_000;

const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const diag = {};
const startedAt = Date.now();
const images = await extractPdfImageObjects(ab, {
  maxImages: MAX_IMAGES,
  maxOutEdgePx: MAX_OUT_EDGE_PX,
  minEdgePx: MIN_EDGE_PX,
  diag,
});
const elapsed = Date.now() - startedAt;
const pngBytes = images.reduce((a, x) => a + x.png.length, 0);

console.log(`파일          ${file.split('/').pop()}  (${(buf.length / 1048576).toFixed(1)} MB)`);
console.log(`훑은 쪽       ${diag.pagesScanned ?? '-'}`);
console.log(`후보 이미지   ${diag.objectsFound ?? '-'}  (크기 기준 통과)`);
console.log(`인코드        ${diag.encoded ?? '-'}  → 반환 ${images.length}장, ${(pngBytes / 1048576).toFixed(1)} MB`);
console.log(`소요          ${elapsed} ms`);
console.log(`전역(g_) 생략 ${diag.skippedGlobal ?? 0}   중복 참조 생략 ${diag.dedupedRefs ?? 0}`);
console.log(`조회 시간초과 ${diag.timedOut ?? 0}   벽시계 상한 초과 ${diag.budgetExceeded ? '예' : '아니오'}`);
if (diag.error) console.log(`추출 오류     ${diag.error}`);

const problems = [];
if (diag.budgetExceeded) {
  problems.push('벽시계 상한을 넘겼다 — 이 강의록은 추출 단계에서 이미지 일부를 포기하고 있다.');
}
if ((diag.timedOut ?? 0) > 0) {
  problems.push(
    `이미지 객체 ${diag.timedOut}건이 상한 안에 도착하지 않았다 — pdfjs 가 아직 모르는 형태일 수 있다.`,
  );
}
if (elapsed > SLOW_MS) {
  problems.push(`추출이 ${(elapsed / 1000).toFixed(1)}초로 느리다(정상 2~6초).`);
}
if (images.length === 0) {
  problems.push('이미지를 한 장도 못 얻었다 — 이미지형 문항이 만들어지지 않는다.');
}
// 전역 객체가 많다는 것 자체는 정상(건너뛰도록 고쳐 뒀다)이지만, 그림 재사용이 많은
// 강의록이라는 신호라 이미지 확보량이 얇아질 수 있어 알려 준다.
if ((diag.skippedGlobal ?? 0) > 0) {
  console.log(
    `\n참고: 여러 쪽이 공유하는 그림 ${diag.skippedGlobal}건은 조회 수단이 없어 건너뛴다(정상 동작).`,
  );
}

if (problems.length > 0) {
  console.log('\n이상 신호');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('\n이상 없음.');

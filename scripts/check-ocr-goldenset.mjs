/**
 * OCR 골든셋 구성·완결성 검사 (분담표 A5 · 가이드 §6.2)
 *
 * 측정기(scripts/eval-ocr.mjs)는 이미 있다. 없는 것은 **정확한 원문 전사**이고,
 * 그 전사를 모을 때 가장 흔한 실패는 "잘 나온 표본만 모으는 것"이다. 쉬운 슬라이드만
 * 100장 모으면 CER 이 낮게 나오고, 그 수치는 실제 강의자료에서 재현되지 않는다.
 *
 * 그래서 구성을 사람의 의지가 아니라 도구로 강제한다:
 *   1) 대장(samples.csv)과 실제 전사 파일이 일치하는가
 *   2) 층화 목표(composition.json) 대비 각 갈래의 비율이 범위 안인가
 *   3) 빈 전사·짝 없는 파일이 없는가
 *   4) 전사가 규칙을 지키는가 (판독 불가 표기, 장식 글머리 기호)
 *
 * 표본이 목표에 못 미쳐도 실패로 보지 않는다 — 구축 중에도 진척을 보여줘야 하기 때문이다.
 * 다만 **완성 선언(--complete)** 을 하면 그때는 목표 미달을 실패로 처리한다.
 *
 *   npm run check:ocr-goldenset
 *   npm run check:ocr-goldenset -- --complete   # 완성 판정 (CI 릴리스 게이트용)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'datasets/ocr-goldenset';
const COMPOSITION = join(DIR, 'composition.json');
const SAMPLES = join(DIR, 'samples.csv');

function parseCsv(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = lines[0].split(',').map((h) => h.trim());
  const rows = lines.slice(1).map((line, i) => {
    const cells = line.split(',');
    const row = { __line: i + 2 };
    header.forEach((key, idx) => {
      row[key] = (cells[idx] ?? '').trim();
    });
    return row;
  });
  return { header, rows };
}

function main() {
  const complete = process.argv.includes('--complete');
  const problems = [];
  const warnings = [];

  if (!existsSync(COMPOSITION) || !existsSync(SAMPLES)) {
    console.error(`FAIL  ${DIR} 에 composition.json 과 samples.csv 가 있어야 합니다.`);
    process.exit(1);
  }
  const composition = JSON.parse(readFileSync(COMPOSITION, 'utf8'));
  const strata = new Map(composition.strata.map((s) => [s.id, s]));
  const { header, rows } = parseCsv(readFileSync(SAMPLES, 'utf8'));

  for (const required of ['id', 'stratum', 'source', 'transcribed']) {
    if (!header.includes(required)) problems.push(`samples.csv 에 '${required}' 열이 없습니다.`);
  }
  if (problems.length > 0) return report(problems, warnings, complete);

  // ── 대장 검사
  const seen = new Set();
  const transcribed = [];
  for (const row of rows) {
    const where = `samples.csv:${row.__line}`;
    if (!row.id) {
      problems.push(`${where}: id 가 비었습니다.`);
      continue;
    }
    if (seen.has(row.id)) problems.push(`${where}: id '${row.id}' 가 중복입니다.`);
    seen.add(row.id);
    if (!strata.has(row.stratum)) {
      problems.push(`${where}: 알 수 없는 stratum '${row.stratum}' (composition.json 에 없음).`);
    }
    if (!row.source) warnings.push(`${where}: source 가 비어 있습니다 — 출처 추적이 안 됩니다.`);

    const isDone = /^(y|yes|true|1|done)$/i.test(row.transcribed);
    const txtPath = join(DIR, `${row.id}.txt`);
    const hasTxt = existsSync(txtPath);

    if (isDone && !hasTxt) {
      problems.push(`${where}: transcribed=${row.transcribed} 인데 ${row.id}.txt 가 없습니다.`);
      continue;
    }
    if (!isDone) {
      if (hasTxt) warnings.push(`${where}: 전사 파일은 있는데 대장이 미완으로 표시돼 있습니다.`);
      continue;
    }
    const text = readFileSync(txtPath, 'utf8');
    if (!text.trim()) {
      problems.push(`${row.id}.txt: 전사가 비었습니다. 텍스트가 없는 이미지는 대장에서 제외하세요.`);
      continue;
    }
    // 전사 규칙 위반 — CER 을 왜곡하는 것들만 잡는다.
    if (/^[\s]*[•·▪]/m.test(text)) {
      warnings.push(`${row.id}.txt: 장식 글머리 기호가 남아 있습니다 (규칙: 적지 않는다).`);
    }
    if (/\[\?{2,}\]/.test(text)) {
      warnings.push(`${row.id}.txt: 판독 불가 표기는 글자당 [?] 한 칸입니다.`);
    }
    transcribed.push(row);
  }

  // 짝 없는 전사 파일 — 대장에 없는데 파일만 있으면 측정에서 조용히 빠지거나 섞인다.
  for (const file of readdirSync(DIR)) {
    if (!file.endsWith('.txt')) continue;
    const id = file.slice(0, -4);
    if (!seen.has(id)) problems.push(`${file}: 대장(samples.csv)에 없는 전사 파일입니다.`);
  }

  // ── 층화 검사
  const counts = new Map();
  for (const row of transcribed) counts.set(row.stratum, (counts.get(row.stratum) ?? 0) + 1);
  const total = transcribed.length;
  const { min: targetMin, max: targetMax } = composition.targetTotal;

  console.log(`전사 완료 ${total}장 (목표 ${targetMin}–${targetMax}장)\n`);
  for (const stratum of composition.strata) {
    const count = counts.get(stratum.id) ?? 0;
    const share = total > 0 ? count / total : 0;
    const inRange = share >= stratum.minShare && share <= stratum.maxShare;
    const mark = total === 0 ? '····' : inRange ? 'OK  ' : 'OFF ';
    console.log(
      `  ${mark} ${stratum.label.padEnd(28)} ${String(count).padStart(3)}장 ` +
        `${(share * 100).toFixed(1)}% (목표 ${(stratum.minShare * 100).toFixed(0)}–${(stratum.maxShare * 100).toFixed(0)}%)`,
    );
    if (total > 0 && !inRange) {
      const message =
        `${stratum.label}: ${(share * 100).toFixed(1)}% — 목표 ` +
        `${(stratum.minShare * 100).toFixed(0)}–${(stratum.maxShare * 100).toFixed(0)}% 를 벗어났습니다.`;
      if (complete) problems.push(message);
      else warnings.push(message);
    }
  }

  if (total < targetMin) {
    const message = `표본 ${total}장 — 목표 최소 ${targetMin}장에 미달입니다.`;
    if (complete) problems.push(message);
    else warnings.push(`${message} (구축 중)`);
  }
  if (total > targetMax) problems.push(`표본 ${total}장 — 목표 최대 ${targetMax}장을 넘었습니다.`);

  report(problems, warnings, complete);
}

function report(problems, warnings, complete) {
  if (warnings.length > 0) {
    console.log('\n경고:');
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (problems.length > 0) {
    console.error('\nOCR 골든셋 검사 실패:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`\nOCR 골든셋 검사 통과${complete ? ' (완성 판정)' : ''}.`);
}

main();

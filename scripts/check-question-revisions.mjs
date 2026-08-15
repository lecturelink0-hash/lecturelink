/**
 * 문항 수정안 사전 검산 — apply-question-revisions.mjs 로 반영하기 전에 돌린다.
 *
 * 반영 스크립트의 게이트는 '정답 텍스트 일치'까지만 본다. 재작성의 목적이 정답 누출
 * 제거인데 누출이 남아 있으면 반영해 봐야 의미가 없으므로, 여기서 문항 규격과
 * 누출 린트를 먼저 통과시킨다.
 *
 *   node --experimental-strip-types scripts/check-question-revisions.mjs \
 *     --in outputs/leakage-rewrite.json [--source outputs/rewrite-source.json] [--verbose]
 *
 * 검사 항목
 *   HARD (하나라도 걸리면 실패)
 *     - 선지 5개, answer_index 범위, 선지 중복
 *     - choices[answer_index] === answer_text_after
 *     - lintChoiceLeakage() 0건            ← 재작성의 본래 목적
 *     - 선지가 길이 오름차순(F15)이고 answer_index 가 그 순서 기준일 것
 *     - 원본 대비 실제로 바뀌었을 것        ← 손 안 댄 문항이 섞여 드는 것 방지
 *   SOFT (경고만)
 *     - lintKmleQuestion() 잔여 지적(F01·F05·F06·F08·F12·F16 등)
 *     - 해설에 [정답 근거]/[오답 감별] 이 없음
 */

import { readFileSync, existsSync } from 'node:fs';
import { lintChoiceLeakage, lintKmleQuestion, normalizeKmleQuestion } from '../lib/ai/kmle-format.ts';

const argv = process.argv;
const arg = (n) => argv[argv.indexOf(`--${n}`) + 1];
const VERBOSE = argv.includes('--verbose');

const inPath = arg('in');
if (!inPath) {
  console.error('--in <수정안 JSON> 이 필요합니다.');
  process.exit(1);
}
const payload = JSON.parse(readFileSync(inPath, 'utf8'));
const revisions = payload.revisions ?? payload;

const sourcePath = arg('source') ?? 'outputs/rewrite-source.json';
const source = new Map();
if (existsSync(sourcePath)) {
  for (const s of JSON.parse(readFileSync(sourcePath, 'utf8'))) source.set(s.id, s);
}

let hardFail = 0;
let softWarn = 0;
const softCounts = new Map();

for (const r of revisions) {
  const hard = [];
  const soft = [];
  const choices = Array.isArray(r.choices) ? r.choices.map((c) => String(c)) : [];

  if (choices.length !== 5) hard.push(`선지 ${choices.length}개`);
  if (!Number.isInteger(r.answer_index) || r.answer_index < 0 || r.answer_index > 4) {
    hard.push(`answer_index=${r.answer_index}`);
  }
  if (new Set(choices).size !== choices.length) hard.push('선지 중복');
  if (choices.length === 5 && Number.isInteger(r.answer_index)) {
    if (r.answer_text_after !== choices[r.answer_index]) {
      hard.push(`정답 불일치: choices[${r.answer_index}]="${choices[r.answer_index]}" ≠ "${r.answer_text_after}"`);
    }
    // F15 — 길이 오름차순. 정렬 결과와 answer_index 가 함께 맞아야 채점이 안 틀어진다.
    const norm = normalizeKmleQuestion({ stem: r.stem, choices, answer_index: r.answer_index });
    if (norm.choices.join('') !== choices.join('')) {
      hard.push('선지가 길이 오름차순이 아님(F15)');
    } else if (norm.answer_index !== r.answer_index) {
      hard.push('정렬 기준 answer_index 불일치');
    }
  }

  const leak = choices.length === 5 ? lintChoiceLeakage({ stem: r.stem, choices, answer_index: r.answer_index }) : [];
  for (const i of leak) hard.push(`[${i.rule}] ${i.message}`);

  const src = source.get(r.id);
  if (src) {
    const same = src.stem === r.stem && src.choices.join('') === choices.join('');
    if (same) hard.push('원본과 동일 — 재작성되지 않음');
  } else if (source.size > 0) {
    soft.push('원본 대조 불가(source 에 없음)');
  }

  if (choices.length === 5) {
    for (const i of lintKmleQuestion({ stem: r.stem, choices, answer_index: r.answer_index })) {
      if (i.rule === 'F17' || i.rule === 'F17-L') continue; // 위에서 이미 hard 로 봤다
      soft.push(`[${i.rule}] ${i.message}`);
      softCounts.set(i.rule, (softCounts.get(i.rule) ?? 0) + 1);
    }
  }
  const expl = String(r.explanation ?? '');
  if (!expl.includes('[정답 근거]')) soft.push('해설에 [정답 근거] 없음');
  if (!expl.includes('[오답 감별]')) soft.push('해설에 [오답 감별] 없음');

  if (hard.length > 0) {
    hardFail += 1;
    console.error(`\nFAIL ${r.id}`);
    for (const h of hard) console.error(`   ✗ ${h}`);
  } else if (soft.length > 0) {
    softWarn += 1;
    if (VERBOSE) {
      console.warn(`\nWARN ${r.id}`);
      for (const s of soft) console.warn(`   · ${s}`);
    }
  }
}

console.log(`\n검사 ${revisions.length}건 · 실패 ${hardFail}건 · 경고 ${softWarn}건`);
if (softCounts.size > 0) {
  console.log('경고 규칙 분포:', Object.fromEntries([...softCounts].sort((a, b) => b[1] - a[1])));
}
if (hardFail > 0) process.exit(1);
console.log('HARD 게이트 전부 통과 — 반영 가능');

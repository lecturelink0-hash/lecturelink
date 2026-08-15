/**
 * 재작성 초안 → 반영 페이로드 변환.
 *
 * 사람이 쓰는 초안에서는 선지 순서·정답 인덱스·해설 번호를 신경 쓰지 않는다.
 * 그 셋은 서로 얽혀 있어서 손으로 맞추면 반드시 틀어지고, 틀어지면 화면은 멀쩡한데
 * 채점만 잘못되는 사고가 된다(F15 주석 참조). 그래서 여기서 기계가 계산한다.
 *
 *   node --experimental-strip-types scripts/prep-question-revisions.mjs \
 *     --in outputs/rewrite-draft-01.json --out outputs/rewrite-payload-01.json
 *
 * 초안 형식 (배열)
 *   { id, stem, choices: [5개, 순서 무관], answer: "정답 선지 텍스트",
 *     rationale: "정답 근거 2~3문장",
 *     distractors: { "오답 선지 텍스트": "한 줄 설명", ... 4개 },
 *     answer_meaning_changed?: boolean, concepts?, difficulty? }
 *
 * 하는 일
 *   1. normalizeKmleQuestion() 으로 선지를 길이 오름차순 정렬하고 answer_index 재계산
 *   2. 해설을 최종 순서 기준 번호(①~⑤)로 다시 조립 — 손으로 번호를 쓰지 않게 한다
 *   3. answer_text_after 를 정렬 후 실제 정답 문자열로 채운다
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeKmleQuestion } from '../lib/ai/kmle-format.ts';

const argv = process.argv;
const arg = (n) => argv[argv.indexOf(`--${n}`) + 1];

const inPath = arg('in');
const outPath = arg('out');
if (!inPath || !outPath) {
  console.error('--in <초안 JSON> --out <페이로드 JSON> 이 필요합니다.');
  process.exit(1);
}

const CIRCLED = ['①', '②', '③', '④', '⑤'];
const draft = JSON.parse(readFileSync(inPath, 'utf8'));
const revisions = [];
const errors = [];

for (const d of draft) {
  const choices = (d.choices ?? []).map((c) => String(c).trim());
  if (choices.length !== 5) {
    errors.push(`${d.id}: 선지 ${choices.length}개`);
    continue;
  }
  const rawIndex = choices.indexOf(String(d.answer).trim());
  if (rawIndex < 0) {
    errors.push(`${d.id}: answer "${d.answer}" 가 choices 에 없음`);
    continue;
  }

  const norm = normalizeKmleQuestion({
    stem: String(d.stem).trim(),
    choices,
    answer_index: rawIndex,
  });

  const distractors = d.distractors ?? {};
  const lines = [];
  let missing = 0;
  norm.choices.forEach((choice, i) => {
    if (i === norm.answer_index) return;
    const note = distractors[choice];
    if (!note) missing += 1;
    lines.push(`${CIRCLED[i]} ${choice} — ${note ?? '이 임상 상황에서 우선 선택이 아니다.'}`);
  });
  if (missing > 0) errors.push(`${d.id}: 오답 설명 ${missing}개 누락`);

  revisions.push({
    id: d.id,
    verdict: 'ok',
    stem: norm.stem,
    choices: norm.choices,
    answer_index: norm.answer_index,
    answer_text_before: d.answer_text_before ?? null,
    answer_text_after: norm.choices[norm.answer_index],
    answer_meaning_changed: d.answer_meaning_changed === true,
    explanation: `[정답 근거] ${d.rationale}\n[오답 감별]\n${lines.join('\n')}`,
    ...(d.concepts ? { concepts: d.concepts } : {}),
    ...(d.difficulty ? { difficulty: d.difficulty } : {}),
    notes: d.notes ?? '정답 누출(F17 계열) 제거 목적 재작성',
  });
}

if (errors.length > 0) {
  console.error('초안 오류:');
  for (const e of errors) console.error('  ✗ ' + e);
  process.exit(1);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ ruleset: 'F01~F23 v2 (정답 누출 제거)', revisions }, null, 1));
console.log(`${revisions.length}건 → ${outPath}`);

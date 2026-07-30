/**
 * 승인된 문항 수정안 반영 — 국시형 재작성 작업의 마지막 단계.
 *
 *   node scripts/apply-question-revisions.mjs --in outputs/kidney-revised.json --dry-run
 *   node scripts/apply-question-revisions.mjs --in outputs/kidney-revised.json
 *   node scripts/apply-question-revisions.mjs --restore <question_id> --to 1
 *
 * 반영 전에 반드시 통과해야 하는 게이트가 있다. 하나라도 걸리면 그 문항은
 * 건너뛰고 나머지만 반영한다. 특히 아래 둘은 조용히 틀어지면 화면은 멀쩡한데
 * 채점만 잘못되는 사고가 되므로 무조건 거부한다.
 *
 *   - choices[answer_index] 가 answer_text_after 와 다름
 *   - answer_meaning_changed 가 true (정답의 의학적 내용이 바뀜 → 사람 확인)
 *
 * 반영할 때마다 question_revisions 에 수정 전·후 전체 스냅샷을 남긴다.
 * 지문이 바뀌면 임베딩도 다시 계산한다. 안 하면 유사문제 추천과 중복 검사가
 * 옛 지문 기준으로 엉뚱하게 동작한다.
 *
 * 입력 JSON 형식
 *   { "ruleset": "F01~F23 v2",
 *     "revisions": [ { id, verdict, stem, choices, answer_index, explanation,
 *                      concepts?, difficulty?, answer_text_before, answer_text_after,
 *                      answer_meaning_changed, notes? } ] }
 *
 * 환경변수
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (필수)
 *   VOYAGE_API_KEY                                        (임베딩 재계산용)
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

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
const arg = (n) => argv[argv.indexOf(`--${n}`) + 1];
const flag = (n) => argv.includes(`--${n}`);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('[apply] NEXT_PUBLIC_SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.');
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const ACTOR = arg('actor') ?? `script:apply-question-revisions`;
const DRY = flag('dry-run');

/** 문항 스냅샷으로 남길 컬럼. 복구할 때 그대로 되살린다. */
const SNAPSHOT_COLUMNS =
  'id, sub_topic_id, stem, choices, answer_index, explanation, concepts, ' +
  'difficulty, image_url, image_type, open_image_id, source, tier, status';

// ─────────────────────────────────────────────
// 복구 모드
// ─────────────────────────────────────────────
if (flag('restore')) {
  const questionId = arg('restore');
  const to = Number(arg('to'));
  if (!questionId || !Number.isInteger(to)) {
    console.error('[apply] 사용법: --restore <question_id> --to <revision>');
    process.exit(1);
  }

  const { data: rev, error } = await db
    .from('question_revisions')
    .select('*')
    .eq('question_id', questionId)
    .eq('revision', to)
    .single();
  if (error || !rev) {
    console.error(`[apply] revision ${to} 을 찾지 못했습니다.`, error?.message ?? '');
    process.exit(1);
  }

  const target = rev.before_data;
  console.log(`복구 대상: ${questionId} → revision ${to} 의 before_data`);
  console.log(`  발문: ${String(target.stem).slice(0, 60)}...`);
  if (DRY) {
    console.log('  (dry-run — 반영하지 않음)');
    process.exit(0);
  }

  const { data: current } = await db
    .from('questions')
    .select(SNAPSHOT_COLUMNS)
    .eq('id', questionId)
    .single();

  const { data: nextRev } = await db.rpc('next_question_revision', {
    p_question_id: questionId,
  });

  await db.from('question_revisions').insert({
    question_id: questionId,
    revision: nextRev,
    before_data: current,
    after_data: target,
    reason: `restore:${to}`,
    ruleset: null,
    actor: ACTOR,
  });

  const { id, ...restorable } = target;
  const { error: upErr } = await db.from('questions').update(restorable).eq('id', questionId);
  if (upErr) throw upErr;
  console.log(`복구 완료. 새 revision ${nextRev} 로 기록했습니다.`);
  process.exit(0);
}

// ─────────────────────────────────────────────
// 반영 모드
// ─────────────────────────────────────────────
const inPath = arg('in');
if (!inPath) {
  console.error('[apply] --in <수정안 JSON> 이 필요합니다.');
  process.exit(1);
}
const payload = JSON.parse(readFileSync(inPath, 'utf8'));
const revisions = payload.revisions ?? payload;
const ruleset = payload.ruleset ?? null;

/** 반영 전 게이트. 통과 못 하면 이유를 돌려준다. */
function gate(r) {
  const fail = [];
  if (r.verdict === 'hold') fail.push('verdict=hold');
  if (r.verdict === 'rewrite_required') fail.push('verdict=rewrite_required');
  if (!Array.isArray(r.choices) || r.choices.length !== 5) fail.push('선지가 5개가 아님');
  if (!Number.isInteger(r.answer_index) || r.answer_index < 0 || r.answer_index > 4)
    fail.push('answer_index 범위 밖');
  if (r.answer_meaning_changed === true) fail.push('answer_meaning_changed=true (사람 확인 필요)');
  if (
    Array.isArray(r.choices) &&
    Number.isInteger(r.answer_index) &&
    r.answer_text_after &&
    r.choices[r.answer_index] !== r.answer_text_after
  ) {
    fail.push(
      `정답 불일치: choices[${r.answer_index}]="${r.choices?.[r.answer_index]}" ` +
        `≠ answer_text_after="${r.answer_text_after}"`,
    );
  }
  if (!r.stem || !String(r.stem).trim()) fail.push('stem 이 비어 있음');
  return fail;
}

/** 지문이 바뀌면 임베딩을 다시 계산한다. */
async function embed(text) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'voyage-3', input: [text], input_type: 'document' }),
  });
  if (!res.ok) {
    console.warn(`  [경고] 임베딩 실패 (${res.status}) — 나중에 백필 필요`);
    return null;
  }
  const json = await res.json();
  return json.data?.[0]?.embedding ?? null;
}

const applied = [];
const skipped = [];
const needsEmbeddingBackfill = [];

for (const r of revisions) {
  const fail = gate(r);
  if (fail.length > 0) {
    skipped.push({ id: r.id, reasons: fail });
    continue;
  }

  const { data: current, error: curErr } = await db
    .from('questions')
    .select(SNAPSHOT_COLUMNS)
    .eq('id', r.id)
    .single();
  if (curErr || !current) {
    skipped.push({ id: r.id, reasons: [`DB 에서 문항을 찾지 못함: ${curErr?.message ?? ''}`] });
    continue;
  }

  const next = {
    stem: r.stem,
    choices: r.choices,
    answer_index: r.answer_index,
    explanation: r.explanation ?? current.explanation,
    concepts: r.concepts ?? current.concepts,
    difficulty: r.difficulty ?? current.difficulty,
  };
  if (r.image_url !== undefined) next.image_url = r.image_url;
  if (r.image_type !== undefined) next.image_type = r.image_type;
  if (r.open_image_id !== undefined) next.open_image_id = r.open_image_id;

  if (DRY) {
    applied.push({ id: r.id, dryRun: true });
    continue;
  }

  // 임베딩 재계산 — 지문·선지·해설을 합쳐 문항 전체를 대표하게 한다.
  const embedText = [next.stem, ...next.choices, next.explanation ?? ''].join('\n');
  const vector = await embed(embedText);
  if (vector) next.embedding = vector;
  else needsEmbeddingBackfill.push(r.id);

  const { data: nextRev } = await db.rpc('next_question_revision', { p_question_id: r.id });

  const { error: revErr } = await db.from('question_revisions').insert({
    question_id: r.id,
    revision: nextRev,
    before_data: current,
    after_data: { ...current, ...next, embedding: undefined },
    reason: r.notes ? `kmle-format: ${r.notes}`.slice(0, 500) : 'kmle-format',
    ruleset,
    actor: ACTOR,
  });
  if (revErr) {
    skipped.push({ id: r.id, reasons: [`이력 기록 실패 — 반영 중단: ${revErr.message}`] });
    continue;
  }

  const { error: upErr } = await db.from('questions').update(next).eq('id', r.id);
  if (upErr) {
    skipped.push({ id: r.id, reasons: [`반영 실패: ${upErr.message}`] });
    continue;
  }
  applied.push({ id: r.id, revision: nextRev });
}

console.log(`\n${DRY ? '[dry-run] ' : ''}반영 ${applied.length}건 / 건너뜀 ${skipped.length}건`);
if (skipped.length > 0) {
  console.log('\n건너뛴 문항:');
  for (const s of skipped) console.log(`  ${s.id}\n     ${s.reasons.join('\n     ')}`);
}
if (needsEmbeddingBackfill.length > 0) {
  console.log(
    `\n[경고] 임베딩을 다시 계산하지 못한 문항 ${needsEmbeddingBackfill.length}건.\n` +
      '       VOYAGE_API_KEY 를 설정하고 다시 돌리거나 백필하세요.\n' +
      '       그대로 두면 유사문제 추천과 중복 검사가 옛 지문 기준으로 동작합니다.',
  );
  writeFileSync('outputs/embedding-backfill.json', JSON.stringify(needsEmbeddingBackfill, null, 2));
}

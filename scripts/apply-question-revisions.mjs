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
import { readFileSync, writeFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
// indexOf 가 -1 일 때 +1 하면 argv[0](node 실행 경로)을 돌려주므로 반드시 확인한다.
// 옵션을 안 준 것과 "node 경로를 값으로 준 것"이 구분되지 않으면 엉뚱한 파일을 읽는다.
const arg = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
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
const ALLOW_MEANING_CHANGE = flag('allow-meaning-change');

/** 문항 스냅샷으로 남길 컬럼. 복구할 때 그대로 되살린다. */
const SNAPSHOT_COLUMNS =
  'id, sub_topic_id, stem, choices, answer_index, explanation, concepts, ' +
  'difficulty, image_url, image_type, open_image_id, source, tier, status';

/**
 * 이력 저장소 — DB 테이블이 없으면 파일로 대체한다.
 *
 * 이력을 남기지 못하면 수정 전 내용이 영구 소실되므로 반영 자체를 막는 것이 원칙이다.
 * 다만 운영 DB에 question_revisions(마이그레이션 00028)가 아직 없을 수 있는데, 그때
 * 작업을 통째로 멈추는 대신 같은 스냅샷을 JSONL 파일로 남겨 되돌릴 수 있게 한다.
 * 파일은 저장소에 커밋해 두면 DB 테이블과 같은 역할을 한다.
 *
 * 테이블이 생기면 자동으로 그쪽을 쓴다 — 파일 경로는 폴백일 뿐이다.
 */
const HISTORY_FILE = arg('history-file') ?? 'outputs/question-revision-history.jsonl';

function readFileHistory() {
  if (!existsSync(HISTORY_FILE)) return [];
  return readFileSync(HISTORY_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function nextFileRevision(questionId) {
  const rows = readFileHistory().filter((r) => r.question_id === questionId);
  return rows.reduce((m, r) => Math.max(m, r.revision), 0) + 1;
}

function appendFileHistory(record) {
  mkdirSync(dirname(HISTORY_FILE), { recursive: true });
  appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n');
}

/**
 * 이력 테이블/함수가 아직 없어서 난 오류인가.
 *
 * 테이블(question_revisions)과 함수(next_question_revision)가 같은 마이그레이션에
 * 들어 있어 둘 다 없을 수 있다. 'question_revision' 을 부분 문자열로 보면 둘 다 잡힌다.
 * PGRST205=테이블 없음, PGRST202=함수 없음.
 */
function isMissingRevisionTable(error) {
  const m = `${error?.message ?? ''} ${error?.code ?? ''}`;
  return m.includes('question_revision') || m.includes('PGRST205') || m.includes('PGRST202');
}

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

  let rev = null;
  const { data: dbRev, error } = await db
    .from('question_revisions')
    .select('*')
    .eq('question_id', questionId)
    .eq('revision', to)
    .maybeSingle();

  if (dbRev) {
    rev = dbRev;
  } else if (!error || isMissingRevisionTable(error)) {
    // 테이블이 없거나 그쪽에 기록이 없으면 파일 이력에서 찾는다.
    rev = readFileHistory().find(
      (x) => x.question_id === questionId && x.revision === to,
    ) ?? null;
  }
  if (!rev) {
    console.error(
      `[apply] revision ${to} 을 찾지 못했습니다. (DB: ${error?.message ?? '없음'} / 파일: ${HISTORY_FILE})`,
    );
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

  const restoreRecord = {
    question_id: questionId,
    before_data: current,
    after_data: target,
    reason: `restore:${to}`,
    ruleset: null,
    actor: ACTOR,
  };
  const { data: dbNext, error: rpcErr } = await db.rpc('next_question_revision', {
    p_question_id: questionId,
  });
  const { error: insErr } = rpcErr
    ? { error: rpcErr }
    : await db.from('question_revisions').insert({ ...restoreRecord, revision: dbNext });
  const nextRev = insErr ? nextFileRevision(questionId) : dbNext;
  if (insErr) {
    appendFileHistory({ ...restoreRecord, revision: nextRev, created_at: new Date().toISOString() });
  }

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
  // 정답의 의학적 의미가 바뀌는 수정은 기본적으로 막는다. 화면은 멀쩡한데 채점 기준만
  // 달라지는 변경이라 사람이 봐야 한다. 확인을 마쳤으면 --allow-meaning-change 로 연다.
  // 플래그로 여는 이유: 초안의 answer_meaning_changed 를 false 로 고쳐 통과시키면
  // "의미가 바뀌었다"는 사실 자체가 이력에서 지워진다.
  if (r.answer_meaning_changed === true && !ALLOW_MEANING_CHANGE) {
    fail.push('answer_meaning_changed=true (사람 확인 필요 — 확인했다면 --allow-meaning-change)');
  }
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
let usedFileHistory = false;

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

  const record = {
    question_id: r.id,
    before_data: current,
    after_data: { ...current, ...next, embedding: undefined },
    reason: r.notes ? `kmle-format: ${r.notes}`.slice(0, 500) : 'kmle-format',
    ruleset,
    actor: ACTOR,
  };

  let nextRev;
  const { data: dbRev, error: rpcErr } = await db.rpc('next_question_revision', {
    p_question_id: r.id,
  });
  const { error: revErr } = rpcErr
    ? { error: rpcErr }
    : await db.from('question_revisions').insert({ ...record, revision: dbRev });

  if (!revErr) {
    nextRev = dbRev;
  } else if (isMissingRevisionTable(revErr) || isMissingRevisionTable(rpcErr)) {
    // 테이블이 아직 없다 — 같은 스냅샷을 파일에 남기고 계속한다.
    nextRev = nextFileRevision(r.id);
    appendFileHistory({ ...record, revision: nextRev, created_at: new Date().toISOString() });
    usedFileHistory = true;
  } else {
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
if (usedFileHistory) {
  console.log(
    `\n[안내] question_revisions 테이블이 없어 수정 이력을 ${HISTORY_FILE} 에 남겼습니다.\n` +
      '       되돌리려면 --restore <question_id> --to <revision> 을 쓰면 같은 파일을 읽습니다.\n' +
      '       마이그레이션 00028 을 적용하면 이후로는 DB 에 기록됩니다.',
  );
}
if (needsEmbeddingBackfill.length > 0) {
  console.log(
    `\n[경고] 임베딩을 다시 계산하지 못한 문항 ${needsEmbeddingBackfill.length}건.\n` +
      '       VOYAGE_API_KEY 를 설정하고 다시 돌리거나 백필하세요.\n' +
      '       그대로 두면 유사문제 추천과 중복 검사가 옛 지문 기준으로 동작합니다.',
  );
  // 배치마다 통째로 덮어쓰면 직전 배치의 미백필 목록이 사라진다. 기존 목록과 합쳐서 쓴다.
  const backfillPath = 'outputs/embedding-backfill.json';
  let previous = [];
  if (existsSync(backfillPath)) {
    try {
      const parsed = JSON.parse(readFileSync(backfillPath, 'utf8'));
      if (Array.isArray(parsed)) previous = parsed;
    } catch {
      previous = [];
    }
  }
  const merged = [...new Set([...previous, ...needsEmbeddingBackfill])];
  writeFileSync(backfillPath, JSON.stringify(merged, null, 2));
  console.log(`       누적 미백필 목록: ${merged.length}건 (${backfillPath})`);
}

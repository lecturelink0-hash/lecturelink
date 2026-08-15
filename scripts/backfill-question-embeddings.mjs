/**
 * 재작성으로 지문이 바뀐 문항의 임베딩 백필.
 *
 * apply-question-revisions.mjs 는 VOYAGE_API_KEY 가 없으면 임베딩을 다시 계산하지 못하고
 * 대상 id 를 outputs/embedding-backfill.json 에 누적해 둔다. 그 목록을 읽어 지금 DB 에 있는
 * 지문 기준으로 임베딩만 다시 계산해 채운다. 문항 내용은 건드리지 않는다.
 *
 *   VOYAGE_API_KEY=... node scripts/backfill-question-embeddings.mjs [--in outputs/embedding-backfill.json] [--dry-run]
 *   VOYAGE_API_KEY=... node scripts/backfill-question-embeddings.mjs --all-null
 *
 * 재작성분 말고도 임베딩 제공자 장애로 처음부터 NULL 로 저장된 문항이 따로 있다.
 * 그쪽까지 한 번에 채우려면 --all-null 을 쓴다(목록 파일 대신 DB 의 embedding IS NULL 을 본다).
 *
 * 백필하지 않고 두면 유사문제 추천과 중복 검사가 옛 지문 기준으로 동작한다.
 * 성공한 id 는 목록에서 지우므로 중간에 끊겨도 다시 돌리면 남은 것만 처리한다.
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
const arg = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const DRY = argv.includes('--dry-run');
/**
 * 재작성 목록만 채우면 부족하다. 임베딩 제공자 장애로 애초에 NULL 로 저장된 문항이 따로 있어서,
 * 목록 파일 대신 `embedding IS NULL` 전량을 대상으로 잡는 모드를 둔다.
 */
const ALL_NULL = argv.includes('--all-null');
const listPath = arg('in') ?? 'outputs/embedding-backfill.json';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const voyageKey = process.env.VOYAGE_API_KEY;
if (!url || !key) {
  console.error('[backfill] NEXT_PUBLIC_SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.');
  process.exit(1);
}
if (!voyageKey) {
  console.error('[backfill] VOYAGE_API_KEY 가 없습니다. 키가 있는 환경에서 돌리세요.');
  process.exit(1);
}
if (!ALL_NULL && !existsSync(listPath)) {
  console.error(`[backfill] ${listPath} 이 없습니다. (--all-null 로 DB 의 NULL 전량을 잡을 수 있습니다)`);
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

async function collectNullIds() {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await db
      .from('questions')
      .select('id')
      .is('embedding', null)
      .eq('status', 'active')
      .range(from, from + page - 1);
    if (error) throw new Error(error.message);
    out.push(...data.map((r) => r.id));
    if (data.length < page) return out;
  }
}

const ids = ALL_NULL ? await collectNullIds() : JSON.parse(readFileSync(listPath, 'utf8'));
if (!Array.isArray(ids) || ids.length === 0) {
  console.log('백필할 문항이 없습니다.');
  process.exit(0);
}
console.log(`대상 ${ids.length}건${ALL_NULL ? ' (embedding IS NULL · status=active 전량)' : ` (${listPath})`}`);

async function embed(text) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${voyageKey}` },
    body: JSON.stringify({
      model: process.env.VOYAGE_EMBED_MODEL ?? 'voyage-3',
      input: [text],
      input_type: 'document',
      output_dimension: parseInt(process.env.VOYAGE_EMBED_DIM ?? '1024', 10),
    }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status} ${await res.text()}`);
  const json = await res.json();
  const vector = json.data?.[0]?.embedding;
  if (!Array.isArray(vector)) throw new Error('임베딩 응답에 벡터가 없습니다.');
  return vector;
}

const remaining = [];
let done = 0;
let missing = 0;

for (const id of ids) {
  const { data, error } = await db
    .from('questions')
    .select('id, stem, choices, explanation')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.warn(`  [경고] ${id} 조회 실패 — ${error.message}`);
    remaining.push(id);
    continue;
  }
  if (!data) {
    // 삭제됐거나 비공개 테이블로 옮겨진 문항. 목록에 남겨 두면 매번 실패하므로 뺀다.
    console.warn(`  [건너뜀] ${id} — questions 에 없음`);
    missing += 1;
    continue;
  }

  const text = [data.stem, ...(data.choices ?? []), data.explanation ?? ''].join('\n');
  try {
    const vector = await embed(text);
    if (DRY) {
      console.log(`  [dry-run] ${id} — ${vector.length}차원 계산까지만`);
      remaining.push(id);
      continue;
    }
    const { error: upErr } = await db.from('questions').update({ embedding: vector }).eq('id', id);
    if (upErr) throw new Error(upErr.message);
    done += 1;
  } catch (e) {
    console.warn(`  [경고] ${id} 실패 — ${e.message}`);
    remaining.push(id);
  }
}

// --all-null 은 DB 를 원본으로 삼으므로 목록 파일을 덮어쓰지 않는다.
if (!DRY && !ALL_NULL) writeFileSync(listPath, JSON.stringify(remaining, null, 2));

console.log(
  `\n백필 ${done}건 / 남음 ${remaining.length}건 / 문항 없음 ${missing}건` +
    (DRY ? '  (dry-run — DB 미반영)' : ''),
);
process.exit(remaining.length > 0 && !DRY ? 1 : 0);

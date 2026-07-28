/**
 * 문항 내보내기 — 국시형 재작성 작업의 1단계.
 *
 * 지정한 과목·세부주제의 문항을 정답·해설까지 포함해 JSON 으로 내려받는다.
 * 읽기만 하며 DB 를 바꾸지 않는다.
 *
 *   node scripts/export-questions.mjs --subject 신장 --out outputs/kidney-85.json
 *   node scripts/export-questions.mjs --sub-topic 요로감염 --out outputs/uti.json
 *   node scripts/export-questions.mjs --subject 신장 --list-only
 *
 * 옵션
 *   --subject <이름>     과목 이름(부분 일치). 예: 신장
 *   --sub-topic <이름>   세부주제 이름(부분 일치). 여러 번 지정 가능
 *   --status <값>        기본 active. all 이면 전체
 *   --out <경로>         출력 JSON 경로. 없으면 stdout 요약만
 *   --list-only          문항 본문 없이 과목·세부주제별 개수만 출력
 *
 * 환경변수 (.env.local 또는 셸)
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// ───── .env.local 로드 (dotenv 의존성 없이) ─────
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

function arg(name, { multi = false } = {}) {
  const out = [];
  for (let i = 2; i < process.argv.length; i += 1) {
    if (process.argv[i] === `--${name}`) out.push(process.argv[i + 1]);
  }
  return multi ? out : out[0];
}
const flag = (name) => process.argv.includes(`--${name}`);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  console.error(
    '[export] NEXT_PUBLIC_SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.\n' +
      '        .env.local 에 넣거나 셸 환경변수로 지정하세요.',
  );
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });

const subjectName = arg('subject');
const subTopicNames = arg('sub-topic', { multi: true });
const status = arg('status') ?? 'active';
const outPath = arg('out');

// ───── 1. 과목·세부주제 해석 ─────
const { data: subjects, error: subjErr } = await db
  .from('subjects')
  .select('id, name, category');
if (subjErr) throw subjErr;

const { data: subTopics, error: stErr } = await db
  .from('sub_topics')
  .select('id, name, subject_id, parent_id, level, exam_relevance, is_risk_category');
if (stErr) throw stErr;

const subjectById = new Map(subjects.map((s) => [s.id, s]));

let targetSubTopics = subTopics;
if (subjectName) {
  const matched = subjects.filter((s) => s.name.includes(subjectName));
  if (matched.length === 0) {
    console.error(`[export] '${subjectName}' 과 일치하는 과목이 없습니다.`);
    console.error('        사용 가능한 과목:', subjects.map((s) => s.name).join(', '));
    process.exit(1);
  }
  const ids = new Set(matched.map((s) => s.id));
  targetSubTopics = targetSubTopics.filter((t) => ids.has(t.subject_id));
}
if (subTopicNames.length > 0) {
  targetSubTopics = targetSubTopics.filter((t) =>
    subTopicNames.some((n) => t.name.includes(n)),
  );
}

if (targetSubTopics.length === 0) {
  console.error('[export] 조건에 맞는 세부주제가 없습니다.');
  process.exit(1);
}

// ───── 2. 문항 조회 ─────
const subTopicIds = targetSubTopics.map((t) => t.id);
let query = db
  .from('questions')
  .select(
    'id, sub_topic_id, stem, choices, answer_index, explanation, concepts, ' +
      'difficulty, image_url, image_type, open_image_id, source, tier, status, ' +
      'times_answered, times_correct, created_at, updated_at',
  )
  .in('sub_topic_id', subTopicIds)
  .order('sub_topic_id')
  .order('created_at');

if (status !== 'all') query = query.eq('status', status);

const { data: questions, error: qErr } = await query;
if (qErr) throw qErr;

// ───── 3. 요약 ─────
const stById = new Map(targetSubTopics.map((t) => [t.id, t]));
const byTopic = new Map();
for (const q of questions) {
  const t = stById.get(q.sub_topic_id);
  const label = t ? t.name : q.sub_topic_id;
  if (!byTopic.has(label)) byTopic.set(label, []);
  byTopic.get(label).push(q);
}

console.log(`\n총 ${questions.length}문항 (status=${status})\n`);
const rows = [...byTopic.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [label, list] of rows) {
  const withImage = list.filter((q) => q.image_url || q.open_image_id).length;
  const tiers = list.reduce((acc, q) => {
    acc[q.tier] = (acc[q.tier] ?? 0) + 1;
    return acc;
  }, {});
  const tierStr = Object.entries(tiers)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  console.log(
    `  ${label.padEnd(28)} ${String(list.length).padStart(3)}문항  ` +
      `이미지 ${withImage}  (${tierStr})`,
  );
}

if (flag('list-only')) process.exit(0);

// ───── 4. 저장 ─────
const payload = {
  exported_at: new Date().toISOString(),
  filter: { subject: subjectName ?? null, sub_topics: subTopicNames, status },
  sub_topics: targetSubTopics.map((t) => ({
    id: t.id,
    name: t.name,
    level: t.level,
    parent_id: t.parent_id,
    subject: subjectById.get(t.subject_id)?.name ?? null,
    exam_relevance: t.exam_relevance,
    is_risk_category: t.is_risk_category,
  })),
  questions: questions.map((q) => ({
    ...q,
    sub_topic_name: stById.get(q.sub_topic_id)?.name ?? null,
  })),
};

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\n저장: ${outPath}`);
} else {
  console.log('\n--out 을 지정하면 JSON 으로 저장합니다.');
}

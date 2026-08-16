/**
 * 정답 누출 감사 — 이미 풀에 올라간 문항 중 '지식 없이 답이 보이는' 것을 찾는다.
 *
 * lib/ai/kmle-format.ts 의 F17 계열 린트를 그대로 쓴다. 생성 단계는 이제 이 린트에
 * 걸리면 admission 에서 거부하지만, 그 이전에 들어간 문항은 아무도 검사한 적이 없다.
 * 읽기만 하며 DB 를 바꾸지 않는다.
 *
 *   npm run audit:leakage
 *   node --experimental-strip-types scripts/audit-question-leakage.mjs --subject 순환기
 *   node --experimental-strip-types scripts/audit-question-leakage.mjs --out outputs/leakage.json
 *
 * 옵션
 *   --subject <이름>   과목 이름(부분 일치)으로 좁힌다
 *   --status <값>      기본 active
 *   --out <경로>       걸린 문항 전체를 JSON 으로 저장
 *   --limit <n>        화면에 출력할 예시 개수 (기본 15)
 *
 * 환경변수 (.env.local 또는 셸)
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { lintChoiceLeakage } from '../lib/ai/kmle-format.ts';

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

const args = process.argv.slice(2);
function opt(name, fallback = null) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.');
  process.exit(1);
}

const db = createClient(url, key, { auth: { persistSession: false } });
const status = opt('--status', 'active');
const subjectFilter = opt('--subject');
const outPath = opt('--out');
const sampleLimit = Number(opt('--limit', '15'));

const PAGE = 1000;
const rows = [];
for (let page = 0; page < 100; page += 1) {
  const { data, error } = await db
    .from('questions')
    .select('id, stem, choices, answer_index, tier, source, reviewed_by, sub_topic:sub_topics(name, subject:subjects(name))')
    .eq('status', status)
    .range(page * PAGE, page * PAGE + PAGE - 1);
  if (error) throw error;
  rows.push(...(data ?? []));
  if ((data ?? []).length < PAGE) break;
}

const named = rows.map((r) => {
  const st = Array.isArray(r.sub_topic) ? r.sub_topic[0] : r.sub_topic;
  const sj = st && (Array.isArray(st.subject) ? st.subject[0] : st.subject);
  return { ...r, subTopicName: st?.name ?? '미분류', subjectName: sj?.name ?? '기타' };
});

const scope = subjectFilter
  ? named.filter((r) => r.subjectName.includes(subjectFilter))
  : named;

const flagged = [];
const ruleCounts = new Map();
let answerFirst = 0;
let answerLongest = 0;

for (const r of scope) {
  const choices = Array.isArray(r.choices) ? r.choices.map(String) : [];
  if (choices.length < 2) continue;
  if (r.answer_index === 0) answerFirst += 1;
  const longestIdx = choices.reduce((best, c, i) => (c.length > choices[best].length ? i : best), 0);
  if (longestIdx === r.answer_index) answerLongest += 1;

  const issues = lintChoiceLeakage({ stem: r.stem, choices, answer_index: r.answer_index });
  if (issues.length === 0) continue;
  for (const i of issues) ruleCounts.set(i.rule, (ruleCounts.get(i.rule) ?? 0) + 1);
  flagged.push({
    id: r.id,
    subject: r.subjectName,
    subTopic: r.subTopicName,
    tier: r.tier,
    source: r.source,
    stem: r.stem,
    choices,
    answerIndex: r.answer_index,
    issues,
  });
}

const n = scope.length;
const pct = (x) => `${((x / Math.max(1, n)) * 100).toFixed(1)} %`;

console.log(`대상: status=${status}${subjectFilter ? ` · 과목~"${subjectFilter}"` : ''} · ${n}문항\n`);
console.log('── 위치·길이 편중 (균등 기대 20 %) ──');
console.log(`  정답이 1번           : ${answerFirst}건 (${pct(answerFirst)})`);
console.log(`  정답이 가장 긴 선지  : ${answerLongest}건 (${pct(answerLongest)})`);
console.log('\n── 정답 누출 린트 ──');
console.log(`  걸린 문항: ${flagged.length}건 (${pct(flagged.length)})`);
for (const [rule, count] of [...ruleCounts].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${rule}: ${count}건`);
}

console.log(`\n── 예시 ${Math.min(sampleLimit, flagged.length)}건 ──`);
for (const f of flagged.slice(0, sampleLimit)) {
  console.log(`\n[${f.subject} · ${f.subTopic}] tier=${f.tier} source=${f.source}`);
  console.log(`  ${f.stem.replace(/\s+/g, ' ').slice(0, 90)}`);
  console.log(`  선지: ${f.choices.map((c, i) => (i === f.answerIndex ? `**${c}**` : c)).join(' / ')}`);
  for (const i of f.issues) console.log(`  → [${i.rule}] ${i.message}`);
}

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify({ scanned: n, flagged }, null, 2));
  console.log(`\n${outPath} 에 ${flagged.length}건 저장`);
}

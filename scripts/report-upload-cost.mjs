/**
 * 업로드당·문항당 원가 보고 (RAG 실행계획 v1.1 · Phase 0-a · G0 '원가 귀속'·'기준선')
 *
 * ai_cost_log 에서 uploadId 가 달린 비용 행을 모아 업로드별로 합치고, 저장된 문항 수로 나눠
 * 문항당 원가를 낸다. 진단 행(private.diagnostics)의 파이프라인 totalCost 와 대조해
 * "어느 한쪽이 호출을 빠뜨리고 있지 않은가"를 함께 보고한다. 산식은 lib/metrics/upload-cost.ts.
 *
 * 읽기만 하며 DB 를 바꾸지 않는다.
 *
 *   npm run report:upload-cost -- --uploads <id,id,...>
 *   npm run report:upload-cost -- --days 7
 *   npm run report:upload-cost -- --days 30 --user <uuid> --out outputs/upload-cost.json
 *
 * 옵션
 *   --uploads <ids>     쉼표로 구분한 upload id (골든셋 실행 결과를 볼 때). 주면 --days 는 무시
 *   --days <n>          최근 며칠 사이에 만든 업로드 (기본 7)
 *   --user <uuid>       특정 사용자의 업로드만
 *   --tolerance <비율>  교차 검증 허용 오차 (기본 0.01 = ±1%)
 *   --out <경로>        업로드별 상세를 JSON 으로 저장
 *   --limit <n>         표에 찍을 업로드 수 (기본 30, JSON 에는 전부)
 *
 * 환경변수 (.env.local 또는 셸)
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * 주의
 *  - 0-a 이전에 처리된 업로드는 OCR·Vision·이미지 선별 비용에 uploadId 가 없어 합계가 실제보다
 *    작게 나온다. 진단에 cost 필드가 없는 업로드는 표에 '0-a 이전'으로 표시한다.
 *  - 사전 분석(uploads.analyze)은 생성 파이프라인 밖의 선택 단계라 합계에 넣지 않는다.
 *  - CI 에 넣지 않는다(운영 DB 접근).
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { summarizeUploadCosts, DEFAULT_GAP_TOLERANCE } from '../lib/metrics/upload-cost.ts';

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
const uploadArg = opt('--uploads');
const days = Number(opt('--days', '7'));
const userFilter = opt('--user');
const tolerance = Number(opt('--tolerance', String(DEFAULT_GAP_TOLERANCE)));
const outPath = opt('--out');
const limit = Number(opt('--limit', '30'));

const PAGE = 1000;
const ID_CHUNK = 100;

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function fetchAll(buildQuery) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// 1) 대상 업로드
let uploadMeta = [];
if (uploadArg) {
  const ids = uploadArg.split(',').map((s) => s.trim()).filter(Boolean);
  for (const part of chunks(ids, ID_CHUNK)) {
    const { data, error } = await db
      .from('user_uploads')
      .select('id, user_id, status, file_type, target_question_count, created_at')
      .in('id', part);
    if (error) throw new Error(error.message);
    uploadMeta.push(...(data ?? []));
  }
  const found = new Set(uploadMeta.map((u) => u.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) console.warn(`찾지 못한 업로드 ${missing.length}건: ${missing.join(', ')}`);
} else {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  uploadMeta = await fetchAll(() => {
    let q = db
      .from('user_uploads')
      .select('id, user_id, status, file_type, target_question_count, created_at')
      .gte('created_at', since)
      .order('created_at', { ascending: true });
    if (userFilter) q = q.eq('user_id', userFilter);
    return q;
  });
}
if (userFilter) uploadMeta = uploadMeta.filter((u) => u.user_id === userFilter);
const uploadIds = uploadMeta.map((u) => u.id);
if (uploadIds.length === 0) {
  console.log('대상 업로드가 없습니다.');
  process.exit(0);
}

// 2) 비용 행 (진단 행 포함 — 교차 검증에 쓴다)
const rows = [];
for (const part of chunks(uploadIds, ID_CHUNK)) {
  rows.push(
    ...(await fetchAll(() =>
      db
        .from('ai_cost_log')
        .select('endpoint, cost_usd, input_tokens, output_tokens, metadata, created_at')
        .in('metadata->>uploadId', part)
        .order('created_at', { ascending: true }),
    )),
  );
}

// 3) 저장된 문항 수
const questionCounts = {};
for (const part of chunks(uploadIds, ID_CHUNK)) {
  const qs = await fetchAll(() => db.from('private_questions').select('upload_id').in('upload_id', part));
  for (const q of qs) questionCounts[q.upload_id] = (questionCounts[q.upload_id] ?? 0) + 1;
}

const { uploads, aggregate } = summarizeUploadCosts({
  rows,
  questionCounts,
  uploadIds,
  gapTolerance: tolerance,
});

// 0-a 이전 실행 표시: 진단에 cost 필드가 없으면 추출 단계 비용이 합계에서 빠져 있다.
const hasCostDiag = new Set(
  rows
    .filter((r) => r.endpoint === 'private.diagnostics' && r.metadata?.cost)
    .map((r) => r.metadata.uploadId),
);
const metaById = new Map(uploadMeta.map((u) => [u.id, u]));

const usd = (v) => (v === null || v === undefined ? '—' : `$${v.toFixed(4)}`);
const pct = (v) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`);
const sec = (v) => (v === null || v === undefined ? '—' : `${(v / 1000).toFixed(0)}s`);

console.log('\n[업로드당·문항당 원가]');
console.log(
  `업로드 ${aggregate.uploads}건 (문항 있음 ${aggregate.uploadsWithQuestions}건) · 총 ${usd(aggregate.totalUsd)} · 저장 문항 ${aggregate.totalQuestions}개`,
);
console.log(
  `문항당 원가 중앙값 ${usd(aggregate.medianPerQuestionUsd)} · 가중 평균 ${usd(aggregate.pooledPerQuestionUsd)} · 처리 시간 p95 ${sec(aggregate.p95TotalMs)}`,
);
console.log(
  `교차 검증(ai_cost_log − 헤지 패자 vs 진단 totalCost, ±${(tolerance * 100).toFixed(1)}%): ${aggregate.gapWithinTolerance}/${aggregate.gapChecked} 통과`,
);
const legacy = uploads.filter((u) => !hasCostDiag.has(u.uploadId)).length;
if (legacy > 0) {
  console.log(`※ 0-a 이전 실행 ${legacy}건 — OCR·Vision 비용이 빠져 있어 합계가 과소 추정됨`);
}

console.log('\n업로드별 (최근 순)');
console.log('uploadId                              상태        문항  합계      문항당    헤지패자  파이프라인 차이    시간   주요 비용');
const ordered = [...uploads].sort((a, b) =>
  String(metaById.get(b.uploadId)?.created_at ?? '').localeCompare(String(metaById.get(a.uploadId)?.created_at ?? '')),
);
for (const u of ordered.slice(0, limit)) {
  const meta = metaById.get(u.uploadId);
  const top = Object.entries(u.byEndpoint)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .slice(0, 3)
    .map(([ep, v]) => `${ep} ${usd(v.costUsd)}×${v.calls}`)
    .join(', ');
  const status = `${meta?.status ?? '?'}${hasCostDiag.has(u.uploadId) ? '' : ' (0-a 이전)'}`;
  console.log(
    [
      u.uploadId.padEnd(37),
      status.padEnd(11),
      String(u.questions).padStart(4),
      usd(u.totalUsd).padStart(9),
      usd(u.perQuestionUsd).padStart(9),
      usd(u.hedgeLoserUsd).padStart(9),
      usd(u.pipelineUsd).padStart(9),
      pct(u.gapRatio).padStart(7),
      sec(u.totalMs).padStart(6),
      ` ${top}`,
    ].join(' '),
  );
}
if (ordered.length > limit) console.log(`… 외 ${ordered.length - limit}건 (--limit 로 늘리거나 --out 으로 전체 저장)`);

if (outPath) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        filter: uploadArg ? { uploads: uploadIds } : { days, user: userFilter },
        aggregate,
        uploads: uploads.map((u) => ({
          ...u,
          status: metaById.get(u.uploadId)?.status ?? null,
          fileType: metaById.get(u.uploadId)?.file_type ?? null,
          targetQuestions: metaById.get(u.uploadId)?.target_question_count ?? null,
          createdAt: metaById.get(u.uploadId)?.created_at ?? null,
          preAttribution: !hasCostDiag.has(u.uploadId),
        })),
      },
      null,
      2,
    ),
  );
  console.log(`\nJSON 저장: ${outPath}`);
}

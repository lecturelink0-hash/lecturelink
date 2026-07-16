// @ts-check
/**
 * 오픈 의료 이미지 인제스트 스크립트.
 *
 * 지원 소스 (open_image_source enum 과 1:1 일치):
 *   - roco_v2          : ROCO v2 manifest.json
 *   - nih_chestxray14  : NIH ChestX-ray14 entries (license=cc0)
 *   - pmc_open_access  : PMC OA subset
 *   - wikipedia_commons: Wikimedia Commons (Category:Medical)
 *   - manual_upload    : 운영자 수동 등록 (1건씩, manifest 한 줄)
 *
 * 사용:
 *   node scripts/ingest-open-images.mjs --source roco_v2 --manifest data/roco.jsonl
 *   node scripts/ingest-open-images.mjs --source nih_chestxray14 --manifest data/chestxray14.json --dry-run
 *
 * 옵션:
 *   --source <name>          (필수) 위 enum 중 하나
 *   --manifest <path>        (필수) JSON 또는 JSONL (한 줄 한 row)
 *   --limit N                기본 1000. 너무 큰 manifest 의 점진적 시도용
 *   --allow-sa               cc_by_sa 인제스트 명시 허용 (기본은 reject)
 *   --dry-run                DB insert 없이 가드/임베딩만 검증 (VOYAGE_API_KEY 도 선택)
 *   --skip-embedding         임베딩 단계 생략 — dry-run 과 함께 manifest 형태만 점검
 *   --help / -h              사용법 출력 후 0 으로 종료
 *
 * 환경변수:
 *   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — admin client (dry-run + skip-embedding 이면 미설정 허용)
 *   VOYAGE_API_KEY                                      — 캡션 임베딩 (skip-embedding 이면 생략 가능)
 *
 * manifest 스키마:
 *   {
 *     "items": [
 *       {
 *         "source_id": "PMC1234567_fig1",         // (필수) source 내 unique
 *         "original_url": "https://pmc.../article",// (필수) 출처/논문 페이지 URL — attribution 표시 전용
 *         "storage_path": "roco/PMC1234567_fig1.png", // (권장) Supabase Storage `open_images` 버킷 내 사본 경로
 *         "caption": "Chest X-ray showing ...",   // (권장)
 *         "modality": "xray",                     // (필수) medical_image_type enum
 *         "license": "cc_by",                     // (필수) open_image_license enum
 *         "attribution_text": "Smith et al. ...", // (필수) 라이선스 의무
 *         "keywords": ["pneumonia"],              // (선택)
 *         "sub_topic_id": null                    // (선택, uuid)
 *       }
 *     ]
 *   }
 *   JSONL 도 지원 — 한 줄 한 row (위 객체 구조 그대로).
 *
 * URL 정책:
 *   - storage_path 가 있으면 AI Vision 입력 URL = `open_images` 버킷의 public URL.
 *   - storage_path 가 없으면 original_url 을 direct image URL 로 간주하므로,
 *     manifest 작성자가 *논문 페이지 URL 이 아닌 .jpg/.png 같은 실 이미지 URL* 을 넣어야 한다.
 *   - 어느 경우든 original_url 은 attribution 표시(라이선스 의무) 용으로 그대로 보존.
 *
 * 멱등성: open_images UNIQUE (source, source_id) 에 의해 이미 인제스트된 항목은 skip.
 *
 * 라이선스 가드: cc_by_sa 기본 reject. attribution_text 비어 있는 row 도 reject.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const USAGE = `사용:
  node scripts/ingest-open-images.mjs --source <name> --manifest <path> [옵션]

옵션:
  --source <name>       roco_v2 | nih_chestxray14 | pmc_open_access | wikipedia_commons | manual_upload
  --manifest <path>     JSON ({"items":[...]}) 또는 JSONL
  --limit N             처음 N 행만 처리 (기본 1000)
  --allow-sa            cc_by_sa 명시 허용 (기본 reject)
  --dry-run             insert 없이 가드/임베딩까지만 검증
  --skip-embedding      임베딩 단계 생략 (manifest 형태 / 라이선스 가드만 점검)
  --help, -h            본 안내 출력 후 종료

자세한 라이선스 정책: docs/open-image-licenses.md
`;

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
}
function flag(name) {
  return args.includes(`--${name}`);
}

if (flag('help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}

const source = arg('source');
const manifestPath = arg('manifest');
const limit = parseInt(arg('limit') ?? '1000', 10);
const allowSa = flag('allow-sa');
const dryRun = flag('dry-run');
const skipEmbedding = flag('skip-embedding');

const ALLOWED_SOURCES = [
  'roco_v2',
  'nih_chestxray14',
  'pmc_open_access',
  'wikipedia_commons',
  'manual_upload',
];

if (!source || !manifestPath) {
  console.error(USAGE);
  process.exit(1);
}
if (!ALLOWED_SOURCES.includes(source)) {
  console.error(`지원하지 않는 소스: ${source}\n${USAGE}`);
  process.exit(1);
}
if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
  console.error(`manifest 파일 없음 또는 디렉토리: ${manifestPath}`);
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;

// dry-run + skip-embedding 이면 DB / Voyage 키 모두 없어도 manifest 형태 검증 가능.
const needsDb = !dryRun;
const needsVoyage = !skipEmbedding;

if (needsDb && (!SUPABASE_URL || !SERVICE_KEY)) {
  console.error(
    'NEXT_PUBLIC_SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY 미설정 — DB insert 진행 불가.\n' +
      '환경변수를 설정하거나 --dry-run 을 추가하세요.',
  );
  process.exit(1);
}
if (needsVoyage && !VOYAGE_KEY) {
  console.error(
    'VOYAGE_API_KEY 미설정 — 임베딩을 만들 수 없습니다.\n' +
      '환경변수를 설정하거나 --skip-embedding 을 추가하세요.',
  );
  process.exit(1);
}

let admin = null;
if (needsDb) {
  const { createClient } = await import('@supabase/supabase-js');
  admin = createClient(SUPABASE_URL, SERVICE_KEY);
}

// ───── manifest 로드 (JSON 또는 JSONL 자동 감지) ─────
function loadManifest(path) {
  const raw = readFileSync(resolve(path), 'utf8').trim();
  if (!raw) return { items: [] };
  // JSONL: 첫 글자가 '{' 이고 줄바꿈 후 또 '{' 가 나오면 라인 단위로 파싱
  if (raw.startsWith('{') && raw.includes('\n{')) {
    const items = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        items.push(JSON.parse(trimmed));
      } catch (e) {
        console.error(`JSONL 파싱 실패 (skip): ${e?.message ?? e}`);
      }
    }
    return { items };
  }
  // 일반 JSON
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return { items: parsed };
  return { items: parsed.items ?? [] };
}

const manifest = loadManifest(manifestPath);
const items = (manifest.items ?? []).slice(0, limit);
console.log(
  `\n📥 ${source} 인제스트 — manifest ${items.length}건 (limit ${limit}) ` +
    `[dryRun=${dryRun}, skipEmbedding=${skipEmbedding}, allowSa=${allowSa}]\n`,
);

// ───── 라이선스 enum 화이트리스트 (open_image_license 와 동기화) ─────
const VALID_LICENSES = [
  'cc0',
  'cc_by',
  'cc_by_sa',
  'public_domain',
  'pmc_oa',
  'nih_open_access',
];

const VALID_MODALITIES = [
  'xray',
  'ct',
  'mri',
  'ecg',
  'pathology',
  'microscope',
  'ultrasound',
  'other',
];

// ───── row 단위 검증 ─────
// 반환: { ok: true, row } 또는 { ok: false, reason }
function validateItem(it) {
  if (!it || typeof it !== 'object') return { ok: false, reason: 'not-object' };
  if (!it.source_id || typeof it.source_id !== 'string')
    return { ok: false, reason: 'source_id 누락' };
  if (!it.original_url || !/^https?:\/\//.test(it.original_url))
    return { ok: false, reason: 'original_url 누락/형식 오류' };
  if (!it.modality || !VALID_MODALITIES.includes(it.modality))
    return { ok: false, reason: `modality 부적합: ${it.modality}` };
  if (!it.license || !VALID_LICENSES.includes(it.license))
    return { ok: false, reason: `license 부적합: ${it.license}` };
  if (it.license === 'cc_by_sa' && !allowSa)
    return { ok: false, reason: 'cc_by_sa (--allow-sa 필요)', kind: 'sa' };
  // attribution_text 는 DB NOT NULL — 라이선스 의무도 큼. 빈 문자열도 reject.
  if (!it.attribution_text || typeof it.attribution_text !== 'string' || !it.attribution_text.trim())
    return { ok: false, reason: 'attribution_text 누락' };
  if (it.sub_topic_id != null && typeof it.sub_topic_id !== 'string')
    return { ok: false, reason: 'sub_topic_id 가 uuid 문자열이 아님' };
  // storage_path 가 있으면 문자열이어야 한다.
  if (it.storage_path != null && typeof it.storage_path !== 'string')
    return { ok: false, reason: 'storage_path 가 문자열이 아님' };
  return {
    ok: true,
    row: {
      source,
      source_id: it.source_id,
      modality: it.modality,
      license: it.license,
      attribution_text: it.attribution_text.trim(),
      original_url: it.original_url,
      storage_path:
        typeof it.storage_path === 'string' && it.storage_path.trim()
          ? it.storage_path.trim()
          : null,
      caption: typeof it.caption === 'string' ? it.caption.trim() : null,
      keywords: Array.isArray(it.keywords) ? it.keywords : null,
      sub_topic_id: it.sub_topic_id ?? null,
    },
  };
}

// ───── 임베딩 헬퍼 (voyage-3, 1024차원) — 429/5xx 1회 재시도 ─────
let voyageCallCount = 0;
let voyageTokensApprox = 0;

async function embedTexts(texts) {
  if (skipEmbedding) {
    // 임베딩 생략 시 null 배열 반환 — DB 컬럼은 nullable.
    return texts.map(() => null);
  }
  const payload = {
    model: 'voyage-3',
    input: texts.map((t) => (t && t.trim() ? t : '(no caption)')),
    input_type: 'document',
  };
  const send = () =>
    fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VOYAGE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

  let res = await send();
  // 429 / 5xx 1회 재시도 (P0-3 policy 와 동일 패턴)
  if (res.status === 429 || res.status >= 500) {
    await new Promise((r) => setTimeout(r, 1000));
    res = await send();
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Voyage embedding 실패: ${res.status} ${txt}`);
  }
  const json = await res.json();
  voyageCallCount += 1;
  // 토큰 수 대략 추정 — 정확한 비용은 ai_cost_log 가 처리하나 본 스크립트는 ad-hoc 이라 근사치 로깅.
  voyageTokensApprox += texts.reduce(
    (s, t) => s + Math.ceil((t?.length ?? 0) / 4),
    0,
  );
  return json.data.map((d) => d.embedding);
}

// ───── 통계 ─────
let inserted = 0;
let skipped = 0;
let rejectedLicense = 0;
let rejectedSchema = 0;
let errored = 0;

// ───── 배치 처리 ─────
const BATCH = 50;
for (let i = 0; i < items.length; i += BATCH) {
  const batch = items.slice(i, i + BATCH);

  // row 검증 + 라이선스 가드
  const valid = [];
  for (const it of batch) {
    const v = validateItem(it);
    if (v.ok) {
      valid.push(v.row);
    } else if (v.kind === 'sa') {
      rejectedLicense += 1;
    } else if (
      v.reason.startsWith('license') ||
      v.reason.startsWith('attribution')
    ) {
      rejectedLicense += 1;
    } else {
      rejectedSchema += 1;
      if (rejectedSchema <= 5) {
        console.warn(`  ✗ row reject — ${v.reason} — source_id=${it?.source_id ?? '<none>'}`);
      }
    }
  }
  if (valid.length === 0) continue;

  // 이미 있는 source_id 제외 (멱등) — manifest 내 중복도 한 번에 정리
  // dry-run 일 때도 admin 이 있으면 체크. 없으면 skip.
  const sourceIds = [...new Set(valid.map((it) => it.source_id))];
  let existingIds = new Set();
  if (admin) {
    const { data: existing, error: selErr } = await admin
      .from('open_images')
      .select('source_id')
      .eq('source', source)
      .in('source_id', sourceIds);
    if (selErr) {
      console.error(`  batch ${i}: 기존 row 조회 실패`, selErr.message);
      errored += valid.length;
      continue;
    }
    existingIds = new Set((existing ?? []).map((r) => r.source_id));
  }
  const newItems = valid.filter((it) => !existingIds.has(it.source_id));
  // manifest 내 중복도 dedupe (앞의 것 우선).
  // - source_id 중복: 같은 row 가 들어온 경우
  // - original_url 중복: 동일 이미지가 다른 ID 로 들어온 경우 (perceptual hash 부재 시 최소 안전판)
  const seenSourceId = new Set();
  const seenUrl = new Set();
  const newItemsDedup = [];
  for (const r of newItems) {
    if (seenSourceId.has(r.source_id)) continue;
    if (seenUrl.has(r.original_url)) continue;
    seenSourceId.add(r.source_id);
    seenUrl.add(r.original_url);
    newItemsDedup.push(r);
  }
  skipped += valid.length - newItemsDedup.length;
  if (newItemsDedup.length === 0) continue;

  // 임베딩
  const captions = newItemsDedup.map((it) => it.caption ?? '');
  let embeddings;
  try {
    embeddings = await embedTexts(captions);
  } catch (e) {
    console.error(`  batch ${i}: 임베딩 실패`, e?.message ?? e);
    errored += newItemsDedup.length;
    continue;
  }

  // insert payload
  const rows = newItemsDedup.map((it, idx) => ({
    ...it,
    embedding: embeddings[idx] ?? null,
  }));

  if (dryRun) {
    inserted += rows.length;
    console.log(`  [dry-run] batch ${i}: ${rows.length}건 (insert 생략)`);
    continue;
  }

  const { error } = await admin.from('open_images').insert(rows);
  if (error) {
    console.error(`  batch ${i}: insert 실패`, error.message);
    errored += rows.length;
  } else {
    inserted += rows.length;
    console.log(`  batch ${i}: ${rows.length}건 insert`);
  }
}

console.log('\n──────────────────────────────────');
console.log(`소스               : ${source}`);
console.log(`인제스트           : ${inserted}${dryRun ? ' (dry-run)' : ''}`);
console.log(`중복 skip          : ${skipped}`);
console.log(`라이선스/attr 거부 : ${rejectedLicense}`);
console.log(`스키마 거부        : ${rejectedSchema}`);
console.log(`에러               : ${errored}`);
if (!skipEmbedding) {
  console.log(`Voyage 호출        : ${voyageCallCount}회 (≈${voyageTokensApprox} tokens)`);
}
console.log('──────────────────────────────────\n');

process.exit(errored > 0 ? 1 : 0);

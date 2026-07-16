// @ts-check
/**
 * P1-B 통합 스모크 테스트 (드라이런).
 *
 * 본 스크립트는 외부 API 호출 없이 흐름이 올바르게 연결됐는지만 확인:
 *   - lib/open-images/select.ts 모듈 로드
 *   - components/ui/ImageAttribution.tsx 컴포넌트 노출 확인
 *   - /api/questions/generate 의 body schema 가 image_source/open_image_query 를 받는지
 *   - 마이그레이션 SQL 의 RPC 이름이 select.ts 와 일치하는지
 *   - 라이선스 매트릭스 문서가 갱신됐는지
 *
 * 사용:
 *   node scripts/test-open-images-flow.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

const checks = [];

function check(name, condition, hint = '') {
  checks.push({ name, ok: !!condition, hint });
}

// 1) 라이선스 메모
const docPath = resolve(ROOT, 'docs/open-image-licenses.md');
check('라이선스 매트릭스 문서 존재', existsSync(docPath), docPath);
if (existsSync(docPath)) {
  const md = readFileSync(docPath, 'utf8');
  check('ROCO v2 / NIH ChestX-ray14 채택 명시', /ROCO v2.*NIH ChestX-ray14/s.test(md));
  check('Radiopaedia 사용 불가 명시', /Radiopaedia[^\n]*사용 불가/.test(md));
  // P3-0-2: storage_path vs original_url 정책이 문서에 명시돼야 한다.
  check(
    'storage_path vs original_url 정책 섹션 존재',
    /storage_path[\s\S]*?original_url/.test(md) && /attribution[\s\S]*?Vision/i.test(md),
  );
}

// 2) 마이그레이션
const migPath = resolve(ROOT, 'supabase/migrations/00010_open_images.sql');
check('00010_open_images.sql 존재', existsSync(migPath), migPath);
if (existsSync(migPath)) {
  const sql = readFileSync(migPath, 'utf8');
  check('open_images 테이블 정의', /create table.+open_images/i.test(sql));
  check('attribution_text NOT NULL', /attribution_text\s+text not null/i.test(sql));
  check('match_open_images RPC 정의', /create or replace function .+match_open_images/i.test(sql));
  check('questions.open_image_id FK 추가', /add column.+open_image_id .+references public\.open_images/i.test(sql));
}

// 3) select 라이브러리
const selectPath = resolve(ROOT, 'lib/open-images/select.ts');
check('open-images/select.ts 존재', existsSync(selectPath));
if (existsSync(selectPath)) {
  const ts = readFileSync(selectPath, 'utf8');
  check("RPC 이름 'match_open_images' 사용", /match_open_images/.test(ts));
  check('SelectedOpenImage 에 attribution/license 필드', /attributionText.+license/s.test(ts));
  // P3-0-2: imageUrl(Vision) 과 originalUrl(attribution) 분리가 타입 차원에서 유지되는지.
  check(
    'SelectedOpenImage.imageUrl 필드 존재',
    /SelectedOpenImage[\s\S]*?imageUrl:\s*string/.test(ts),
  );
  check(
    'SelectedOpenImage.originalUrl 필드 존재',
    /SelectedOpenImage[\s\S]*?originalUrl:\s*string/.test(ts),
  );
  check(
    'toSelected 가 storage_path → public URL, 없으면 original_url 사용',
    /storage_path[\s\S]*?getPublicUrl[\s\S]*?originalUrl/.test(ts),
  );
}

// 4) generate route
const routePath = resolve(ROOT, 'app/api/questions/generate/route.ts');
check('generate route 존재', existsSync(routePath));
if (existsSync(routePath)) {
  const ts = readFileSync(routePath, 'utf8');
  check("image_source schema 추가", /image_source.+enum\(\['none', ?'user', ?'open_library'\]\)/.test(ts));
  check('selectOpenImages 호출', /selectOpenImages/.test(ts));
  check('validateImageUrl allowOpenImageHosts 옵션 사용', /allowOpenImageHosts:\s*true/.test(ts));
  check('admin role 가드 (requireAdmin)', /requireAdmin\(\)/.test(ts));
  // P3-0-2: SSRF 검증과 Vision 입력은 oi.imageUrl, attribution 은 oi.attributionText 로 명확히 분리.
  check(
    'validateImageUrl 대상이 oi.imageUrl (originalUrl 아님)',
    /validateImageUrl\(\s*oi\.imageUrl/.test(ts),
  );
  check(
    'imageContext.imageUrl 가 oi.imageUrl (Vision 입력)',
    /imageUrl:\s*oi\.imageUrl/.test(ts),
  );
  check(
    'attribution 은 oi.attributionText 로 유지',
    /attribution:\s*oi\.attributionText/.test(ts),
  );
  check(
    'oi.originalUrl 을 Vision 입력으로 사용하지 않음',
    !/imageUrl:\s*oi\.originalUrl/.test(ts),
  );
}

// 5) attribution 컴포넌트
const attrPath = resolve(ROOT, 'components/ui/ImageAttribution.tsx');
check('ImageAttribution.tsx 존재', existsSync(attrPath));
if (existsSync(attrPath)) {
  const tsx = readFileSync(attrPath, 'utf8');
  check('originalUrl prop 존재', /originalUrl/.test(tsx));
  check('CC BY/SA 라이선스 URL 매핑', /creativecommons\.org\/licenses\/by/.test(tsx));
}

// 6) practice 페이지가 attribution 노출
const practicePath = resolve(ROOT, 'app/(app)/practice/page.tsx');
check('practice page 존재', existsSync(practicePath));
if (existsSync(practicePath)) {
  const tsx = readFileSync(practicePath, 'utf8');
  check('ImageAttribution import', /from '@\/components\/ui\/ImageAttribution'/.test(tsx));
  check('attribution prop 렌더', /current\.attribution/.test(tsx));
}

// 7) 추천 엔진이 open_image join
const enginePath = resolve(ROOT, 'lib/recommend/engine.ts');
check('recommend/engine.ts 존재', existsSync(enginePath));
if (existsSync(enginePath)) {
  const ts = readFileSync(enginePath, 'utf8');
  check('open_image 조인', /open_image:open_images/.test(ts));
  check('attribution 매핑', /attribution:\s*oi/.test(ts));
}

// 8) admin 페이지
const adminPath = resolve(ROOT, 'app/(app)/admin/open-images/page.tsx');
check('admin/open-images 페이지 존재', existsSync(adminPath));

// 9) 인제스트 스크립트
const ingestPath = resolve(ROOT, 'scripts/ingest-open-images.mjs');
check('ingest-open-images.mjs 존재', existsSync(ingestPath));
if (existsSync(ingestPath)) {
  const js = readFileSync(ingestPath, 'utf8');
  check('CC BY-SA 기본 reject (--allow-sa)', /cc_by_sa.+allowSa/.test(js));
  check('멱등성: source + source_id unique 체크', /existingIds/.test(js));
}

// ───── 출력
let failed = 0;
for (const c of checks) {
  const icon = c.ok ? '✓' : '✗';
  console.log(`  ${icon}  ${c.name}${c.hint ? `  (${c.hint})` : ''}`);
  if (!c.ok) failed += 1;
}

console.log('\n──────────────────────────────────');
console.log(`  ${checks.length - failed}/${checks.length} pass`);
console.log('──────────────────────────────────\n');

process.exit(failed === 0 ? 0 : 1);

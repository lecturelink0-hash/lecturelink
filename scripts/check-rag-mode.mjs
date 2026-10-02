/**
 * RAG 모드·임베딩 배치·인덱스 스키마 검사 (npm run check:rag-mode · RAG 실행계획 v1.1 0-e·0-g·0-h)
 *
 * 1) lib/rag/mode.ts — PRIVATE_RAG_MODE 해석(모르는 값은 off), E1~E3 확정 구성
 * 2) lib/rag/embed-batch.ts — 요청 묶음 나누기·단가·정규화·재임베딩 판정
 * 3) 소스 대조 — off 에서 인덱싱 경로를 타지 않는가, 임베딩 비용이 원가에 들어가는가,
 *    마이그레이션 00045 가 설계대로인가(HNSW·trgm 인덱스 없음, RPC 는 서비스 롤 전용)
 *
 *   node --experimental-strip-types --no-warnings scripts/check-rag-mode.mjs
 */
import { readFileSync } from 'node:fs';
import {
  parseRagMode,
  ragMode,
  ragIndexingEnabled,
  ragGenerationEnabled,
  ragEmbedModel,
  embedProvider,
  ragConfigSnapshot,
  RAG_DEFAULTS,
} from '../lib/rag/mode.ts';
import {
  batchTexts,
  embedCostUsd,
  embedPricePerM,
  approxTokens,
  l2normalize,
  toPgVector,
  needsEmbedding,
  EMBED_BATCH_LIMITS,
} from '../lib/rag/embed-batch.ts';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
console.log('[check:rag-mode]');

// ── 1) 모드
check('모드: 비어 있으면 off', parseRagMode(undefined).mode === 'off' && !parseRagMode('').invalid);
check('모드: off/shadow/on 그대로', ['off', 'shadow', 'on'].every((m) => parseRagMode(m).mode === m));
check('모드: 대소문자·공백 무시', parseRagMode('  Shadow ').mode === 'shadow');
check('모드: 모르는 값은 off + invalid', parseRagMode('enabled').mode === 'off' && parseRagMode('enabled').invalid === true);
check('모드: 환경변수에서 읽음', ragMode({ PRIVATE_RAG_MODE: 'on' }) === 'on' && ragMode({}) === 'off');
check('인덱싱: off 만 꺼짐', !ragIndexingEnabled('off') && ragIndexingEnabled('shadow') && ragIndexingEnabled('on'));
check('생성 사용: on 만', !ragGenerationEnabled('shadow') && ragGenerationEnabled('on'));

// E1~E3 확정값 — 바꾸면 e1-e3-results.md 와 함께 바꿔야 한다.
check('구성: 임베딩 voyage-4 · 1024차원', RAG_DEFAULTS.embedModel === 'voyage-4' && RAG_DEFAULTS.dim === 1024);
check('구성: sparse·리랭커 불채택, 부모 확장 없음', RAG_DEFAULTS.sparse === false && RAG_DEFAULTS.reranker === null && RAG_DEFAULTS.parentExpandTop === 0);
check('구성: 근거 팩 6 · 후보 20 · τ 0.61', RAG_DEFAULTS.packSize === 6 && RAG_DEFAULTS.candidateK === 20 && RAG_DEFAULTS.tau === 0.61);
check('임베딩 모델: 기본값·환경변수', ragEmbedModel({}) === 'voyage-4' && ragEmbedModel({ RAG_EMBED_MODEL: 'gemini-embedding-2' }) === 'gemini-embedding-2');
check('임베딩 모델: 빈 문자열이면 기본값', ragEmbedModel({ RAG_EMBED_MODEL: '  ' }) === 'voyage-4');
check('제공자 판정', embedProvider('voyage-4') === 'voyage' && embedProvider('gemini-embedding-2') === 'gemini' && embedProvider('text-embedding-3-small') === null);
const snap = ragConfigSnapshot({ PRIVATE_RAG_MODE: 'weird' });
check('스냅샷: 모르는 모드값을 남김', snap.mode === 'off' && snap.invalidModeValue === 'weird', JSON.stringify(snap));
check('스냅샷: 구성 필드', ['embedModel', 'dim', 'candidateK', 'packSize', 'tau', 'sparse', 'reranker', 'chunkChars'].every((k) => k in snap));

// ── 2) 배치
const b1 = batchTexts(['a', 'b', 'c', 'd', 'e'], { maxItems: 2, maxChars: 100 });
check('묶음: 개수 상한', b1.map((b) => b.texts.join('')).join('|') === 'ab|cd|e' && b1.map((b) => b.start).join() === '0,2,4');
const b2 = batchTexts(['xxxx', 'yy', 'zzzz'], { maxItems: 10, maxChars: 6 });
check('묶음: 글자 수 상한', b2.map((b) => b.texts.join(',')).join('|') === 'xxxx,yy|zzzz', JSON.stringify(b2));
const b3 = batchTexts(['long-long-long', 'a'], { maxItems: 10, maxChars: 5 });
check('묶음: 상한보다 긴 텍스트는 혼자', b3.length === 2 && b3[0].texts[0] === 'long-long-long');
check('묶음: 빈 입력', batchTexts([], { maxItems: 2, maxChars: 10 }).length === 0);
const flat = batchTexts(Array.from({ length: 300 }, (_, i) => String(i)), EMBED_BATCH_LIMITS.voyage).flatMap((b) => b.texts);
check('묶음: 순서 보존·누락 없음', flat.length === 300 && flat.every((t, i) => t === String(i)));
check('묶음 상한: Gemini 100건 이하', EMBED_BATCH_LIMITS.gemini.maxItems <= 100);

check('단가: voyage-4 $0.06/M', embedPricePerM('voyage-4') === 0.06 && Math.abs(embedCostUsd('voyage-4', 1_000_000) - 0.06) < 1e-12);
check('단가: 모르는 모델은 null(0원 기록 금지)', embedPricePerM('unknown-model') === null);
check('단가: 음수 토큰은 0', embedCostUsd('voyage-4', -5) === 0);
check('토큰 근사: 글자 수, 최소 1', approxTokens('가나다') === 3 && approxTokens('') === 1);
const n = l2normalize([3, 4]);
check('정규화', Math.abs(n[0] - 0.6) < 1e-12 && Math.abs(n[1] - 0.8) < 1e-12 && l2normalize([0, 0]).every((x) => x === 0));
check('pgvector 문자열', toPgVector([0.5, -1, NaN]) === '[0.5,-1,0]');
const row = { content_sha: 's1', embedding_model: 'voyage-4', embedding_sha: 's1' };
check('재임베딩: 같은 모델·같은 내용이면 안 함', needsEmbedding(row, 'voyage-4') === false);
check('재임베딩: 내용이 바뀌면 함', needsEmbedding({ ...row, content_sha: 's2' }, 'voyage-4') === true);
check('재임베딩: 모델이 다르면 함', needsEmbedding(row, 'gemini-embedding-2') === true);
check('재임베딩: 임베딩 없으면 함', needsEmbedding({ content_sha: 's1', embedding_model: null, embedding_sha: null }, 'voyage-4') === true);

// ── 3) 소스 대조
const pg = readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8');
check('PG: 모드는 parseRagMode 로 한 번 읽음', /const ragModeParsed = parseRagMode\(process\.env\.PRIVATE_RAG_MODE\)/.test(pg));
check(
  'PG: 인덱싱은 ragIndexingEnabled(RAG_MODE) 안에서만 시작',
  /if \(ragIndexingEnabled\(RAG_MODE\) && materialChunksSupported\) \{\s*ragIndexPromise = indexMaterialChunks\(/.test(pg),
);
check('PG: indexMaterialChunks 호출은 한 곳뿐', (pg.match(/indexMaterialChunks\(/g) ?? []).length === 1);
check('PG: 임베딩 비용을 totalCost 에 더함', /totalCost \+= ragDiag\.costUsd;/.test(pg));
check('PG: 진단에 rag·retrieval 스냅샷', /rag: \{ \.\.\.\(ragDiag \?\? \{ mode: RAG_MODE \}\)/.test(pg) && /retrieval: ragConfigSnapshot\(\)/.test(pg));
check('PG: 진단 기록 전에 인덱싱 합류(상한 있음)', /ragDiag = await settleRagIndex\(ragIndexPromise, RAG_INDEX_WAIT_MS/.test(pg));

const embed = readFileSync(new URL('../lib/ai/embed.ts', import.meta.url), 'utf8');
check('embedTexts: 비용을 recordAiCost 로 기록(rag.embed)', /export async function embedTexts/.test(embed) && /endpoint: input\.endpoint \?\? 'rag\.embed'/.test(embed) && /await recordAiCost\(/.test(embed));
check('embedTexts: 단가표에 없는 모델은 호출 전 거부', /embedPricePerM\(model\) === null\) throw/.test(embed));
check('embedTexts: 차원 확인·정규화', /v\.length !== dim/.test(embed) && /l2normalize\(v\)/.test(embed));
check('embedTexts: Gemini 키는 헤더로(URL에 싣지 않음)', /'x-goog-api-key': apiKey/.test(embed) && !/batchEmbedContents\?key=/.test(embed));

const mig = readFileSync(new URL('../supabase/migrations/00045_rag_index.sql', import.meta.url), 'utf8');
const code = mig.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
for (const col of ['embedding       vector(1024)', 'embedding_model text', 'embedding_sha   text', 'parent_id       uuid', 'level           smallint', 'modality        text', 'heading_path    text[]', 'image_id        uuid', 'evidence        jsonb']) {
  check(`00045: 컬럼 ${col.split(/\s+/)[0]}`, code.includes(col));
}
check('00045: HNSW 인덱스 없음(업로드 내 정확 검색)', !/using\s+hnsw/i.test(code));
check('00045: pg_trgm 인덱스 없음(E3 sparse 불채택)', !/gin_trgm_ops/i.test(code));
check('00045: parent_id 는 ON UPDATE CASCADE', /on delete cascade on update cascade/i.test(code));
check('00045: kind 에 image_caption', /kind in \('slide_text', 'ocr', 'image_caption'\)/.test(code));
check('00045: 검색은 내용이 같은 벡터만', /c\.embedding_sha = c\.content_sha/.test(code));
check('00045: 저장은 내용 지문이 같을 때만', /and c\.content_sha = r\.sha/.test(code));
for (const fn of ['match_material_chunks', 'match_private_questions', 'rag_set_chunk_embeddings']) {
  check(`00045: ${fn} 서비스 롤 전용`, new RegExp(`'public\\.${fn}\\(`).test(code));
}
check('00045: anon·authenticated 권한 회수', /from anon;/.test(code) && /from authenticated;/.test(code) && /to service_role;/.test(code));
check('00045: 재적용 안전(if not exists)', (code.match(/add column if not exists/g) ?? []).length >= 12);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

/**
 * 이미지 캡션 청크 검사 (npm run check:rag-caption · RAG 실행계획 v1.1 0-f)
 *
 * 1) lib/rag/caption.ts — 응답 검사·정리, 청크 본문, 대상 크롭 판정, 프롬프트
 * 2) lib/extract/chunk.ts — 캡션 청크는 본문·OCR 뒤에 붙고, 붙어도 앞 청크의 번호·지문이 그대로인가
 * 3) lib/extract/chunk-id.ts — 그림 id 결정론
 * 4) 소스 대조 — 캡션은 이미지형 + RAG shadow·on 에서만, 문항 이미지 후보에만 만든다. 크롭 OCR 콜은
 *    건드리지 않는다(후보 A 불채택, f-caption-results.md). 00045 가 없으면 캡션만 빼고 다시 저장한다.
 *
 *   node --experimental-strip-types --no-warnings scripts/check-rag-caption.mjs
 */
import { readFileSync } from 'node:fs';
import {
  parseImageCaption,
  parseCaptionResponse,
  captionChunkText,
  captionEligible,
  captionPrompt,
  CAPTION_LIMITS,
  CAPTION_CONTEXT_CHARS,
} from '../lib/rag/caption.ts';
import { buildTextFirstChunks, buildTextChunks } from '../lib/extract/chunk.ts';
import { materialImageId, materialChunkId } from '../lib/extract/chunk-id.ts';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) passed += 1;
  else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
console.log('[check:rag-caption]');

// ── 1) 캡션 검사·정리
const ok = parseImageCaption({ image_type: ' 흉부 X-ray ', caption: '우하엽\n경화가 보이는  흉부 X-ray.', findings: ['우하엽 경화', '우하엽 경화', '공기기관지조영'] });
check('검사: 정상 응답', ok && ok.imageType === '흉부 X-ray' && ok.caption === '우하엽 경화가 보이는 흉부 X-ray.', JSON.stringify(ok));
check('검사: 소견 중복 제거', ok && ok.findings.join('|') === '우하엽 경화|공기기관지조영');
check('검사: 캡션이 비면 null', parseImageCaption({ image_type: 'CT', caption: '   ', findings: ['a'] }) === null);
check('검사: 객체가 아니면 null', [null, 'x', 3, ['a']].every((v) => parseImageCaption(v) === null));
check('검사: imageType 별칭', parseImageCaption({ imageType: '해부도', caption: 'c' })?.imageType === '해부도');
check('검사: 소견 문자열 하나', parseImageCaption({ caption: 'c', findings: '단일 소견' })?.findings.join() === '단일 소견');
const long = parseImageCaption({
  image_type: 'x'.repeat(100),
  caption: '가'.repeat(1000),
  findings: Array.from({ length: 9 }, (_, i) => `${i}`.repeat(200)),
});
check(
  '검사: 길이·개수 상한',
  long.imageType.length === CAPTION_LIMITS.imageTypeChars &&
    long.caption.length === CAPTION_LIMITS.captionChars &&
    long.findings.length === CAPTION_LIMITS.findings &&
    long.findings.every((f) => f.length <= CAPTION_LIMITS.findingChars),
);
check('검사: 상한 결과가 청크 하나 안', captionChunkText(long).length <= 1200, String(captionChunkText(long).length));
check('검사: 문자열이 아닌 소견 무시', parseImageCaption({ caption: 'c', findings: [1, null, '진짜'] })?.findings.join() === '진짜');

check('응답 파싱: 코드펜스·앞뒤 말', parseCaptionResponse('설명:\n```json\n{"image_type":"CT","caption":"복부 CT","findings":[]}\n```')?.caption === '복부 CT');
check('응답 파싱: 깨진 JSON 은 null', parseCaptionResponse('{"caption": "x"') === null && parseCaptionResponse('') === null);

// ── 청크 본문
check('청크 본문: 종류·소견', captionChunkText({ imageType: 'H&E 조직 사진', caption: '편도 조직.', findings: ['림프소절', '종자 중심'] }) === '[이미지: H&E 조직 사진] 편도 조직.\n소견: 림프소절; 종자 중심');
check('청크 본문: 종류·소견 없음', captionChunkText({ imageType: '', caption: '그림.', findings: [] }) === '[이미지] 그림.');

// ── 대상 크롭
check('대상: 일반 크롭', captionEligible({ region: { kind: 'xray' } }) === true);
check('대상: 페이지 전체 OCR 폴백 제외', captionEligible({ ocrOnly: true, region: { kind: 'other' } }) === false);
check('대상: 텍스트 캡처 분류 제외', captionEligible({ region: { kind: 'text_slide' } }) === false);

// ── 프롬프트
const p1 = captionPrompt('가'.repeat(2000));
check('프롬프트: JSON 형식·규칙 포함', p1.includes('"image_type"') && p1.includes('"findings"') && p1.includes('맥락에서 가져와 쓰지 않는다'));
check('프롬프트: 맥락 상한', p1.endsWith('가'.repeat(CAPTION_CONTEXT_CHARS)) && !p1.includes('가'.repeat(CAPTION_CONTEXT_CHARS + 1)));
check('프롬프트: 맥락 없으면 맥락 절 없음', !captionPrompt('').includes('주변 맥락:\n') && !captionPrompt(null).includes('주변 맥락:\n') && p1.includes('주변 맥락:\n'));

// ── 2) 청크 순서
const slides = [
  { pageIndex: 2, slideText: '둘째 페이지 본문', ocrTexts: ['[xray] R L'], captions: [{ text: '[이미지: 흉부 X-ray] 정상 흉부.', imageKey: 'k2' }] },
  { pageIndex: 1, slideText: '첫 페이지 본문', ocrTexts: [], captions: [{ text: '[이미지: 해부도] 위 해부도.', imageKey: 'k1' }] },
];
const withCap = buildTextFirstChunks(slides);
const noCap = buildTextFirstChunks(slides.map(({ captions, ...rest }) => rest));
check('순서: 본문 → OCR → 캡션', withCap.map((c) => c.kind).join() === 'slide_text,slide_text,ocr,image_caption,image_caption', withCap.map((c) => c.kind).join());
check('순서: 캡션도 페이지 순', withCap.filter((c) => c.kind === 'image_caption').map((c) => c.pageIndex).join() === '1,2');
check(
  '순서: 캡션을 빼도 앞 청크 번호·지문 동일',
  noCap.every((c, i) => withCap[i].chunkIndex === c.chunkIndex && withCap[i].sha256 === c.sha256 && withCap[i].kind === c.kind),
);
check('캡션 청크: 그림 지문 유지', withCap.filter((c) => c.kind === 'image_caption').map((c) => c.imageKey).join() === 'k1,k2');
check('캡션 청크: 본문·OCR 청크에는 그림 지문 없음', withCap.filter((c) => c.kind !== 'image_caption').every((c) => c.imageKey === undefined));
check('본문 청크(선발 저장)는 캡션을 무시', buildTextChunks(slides).every((c) => c.kind === 'slide_text'));
check('입력 순서가 달라도 같은 결과', JSON.stringify(buildTextFirstChunks([...slides].reverse())) === JSON.stringify(withCap));

// ── 3) 그림 id
const U = '11111111-2222-4333-8444-555555555555';
const id1 = materialImageId(U, 'abc');
check('그림 id: 결정론·UUID v5', id1 === materialImageId(U, 'abc') && /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id1));
check('그림 id: 업로드·지문이 다르면 다름', id1 !== materialImageId(U, 'abd') && id1 !== materialImageId('11111111-2222-4333-8444-555555555556', 'abc'));
check('그림 id: 청크 id 와 겹치지 않음', id1 !== materialChunkId(U, 0, 'abc'));

// ── 4) 소스 대조
const pg = readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8');
check('PG: 이미지형 + RAG shadow·on 에서만', /const captionsEnabled = wantsImages && ragIndexingEnabled\(RAG_MODE\);/.test(pg));
check('PG: 대상 크롭만·중복 출발 없음', /if \(!captionsEnabled \|\| captionTasks\.has\(crop\) \|\| !captionEligible\(crop\)\) return;/.test(pg));
check('PG: OCR 과 같은 시점에 출발', /const startCropOcr = \([^)]*\): void => \{\s*startCropCaption\(slideText, pageIndex, crop\);/.test(pg));
check('PG: 캡션 콜은 원본 색상 크롭', /captionImage\(\{ png: crop\.png, context: slideText/.test(pg));
check('PG: 캡션 비용을 totalCost 에 더함', /const r = await captionImage\([^;]*;\s*totalCost \+= r\.costUsd;/.test(pg));
check('PG: OCR 대기에서 캡션도 기다림', /Promise\.all\(\[ocrTasks\.get\(crop\), captionTasks\.get\(crop\)\]\)/.test(pg));
check('PG: 캡션 청크는 문항 이미지 후보에서만', /if \(captionsEnabled\) \{[\s\S]{0,400}for \(const fi of featuredImages\)/.test(pg));
const iFeatured = pg.indexOf('const featuredImages = slides');
const iFinal = pg.indexOf('const finalChunks = buildTextFirstChunks(slideSummaries);');
check('PG: 후보 확정이 청크 저장보다 먼저', iFeatured > 0 && iFinal > iFeatured);
check('PG: featuredImages 정의는 한 곳', (pg.match(/const featuredImages = /g) ?? []).length === 1);
check('PG: 00045 컬럼은 shadow·on 또는 캡션 있을 때만', /const ragColumns = hasCaptions \|\| ragIndexingEnabled\(RAG_MODE\);/.test(pg));
check('PG: 저장 실패 시 캡션·00045 컬럼 빼고 재시도', /if \(chunkErr && ragColumns\) \{[\s\S]{0,400}saved = chunks\.filter\(\(c\) => c\.kind !== 'image_caption'\);\s*rows = toRows\(saved, false\);/.test(pg));
check('PG: 잔여 청크 정리는 실제 저장 수 기준', /\.gte\('chunk_index', saved\.length\)/.test(pg) && !/\.gte\('chunk_index', chunks\.length\)/.test(pg));
check('PG: 진단에 캡션 수치', /diag\.extract\.captions = \{/.test(pg));

const engine = readFileSync(new URL('../lib/ocr/engine.ts', import.meta.url), 'utf8');
check('OCR 콜 불변: 캡션 필드 없음(후보 A 불채택)', !/withCaption|image_type|parseImageCaption|lib\/rag\/caption/.test(engine));
const capMod = readFileSync(new URL('../lib/extract/caption-image.ts', import.meta.url), 'utf8');
check('캡션 콜: 비용 기록(extract.caption)', /endpoint: 'extract\.caption'/.test(capMod) && /await recordAiCost\(/.test(capMod));
check('캡션 콜: temperature 0 · 검증 모델', /temperature: 0/.test(capMod) && /MODELS\.verification\(\)/.test(capMod));
check('캡션 콜: 공용 프롬프트·파서', /captionPrompt\(input\.context\)/.test(capMod) && /parseCaptionResponse\(raw\)/.test(capMod));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

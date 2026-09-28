/**
 * 페이지 단위 본문·청크 id·구간 분할 회귀 검사 (RAG 실행계획 v1.1 · Phase 0-b·0-c·0-d)
 * — 네트워크·DB 없이 돈다.
 *
 * 무엇을 지키는가
 *  1) 페이지별로 모은 본문을 이어 붙이면 pdf-parse 의 전체 텍스트와 **한 글자도 다르지 않은가**.
 *     전체 텍스트를 쓰는 기존 경로(초점 추출·세션 간 중복 방지)의 동작을 바꾸지 않기 위해서다.
 *     손으로 만든 3쪽짜리 PDF 를 실제 pdf-parse 로 파싱해 대조한다.
 *  2) 전체 글자 수 상한이 페이지 순서대로 적용되는가(종전 전체 절삭과 같은 결과).
 *  3) 렌더된 페이지(PNG)와 본문 페이지가 달라도 슬라이드 행이 빠짐없이 만들어지는가.
 *  4) PPTX 미디어 폴백처럼 같은 페이지가 여러 행이면 하나로 합쳐지는가.
 *  5) 본문 청크를 먼저 저장하고 OCR 청크를 나중에 붙여도 **본문 청크의 번호가 그대로인가**.
 *     번호가 밀리면 (업로드, 번호)로 정해지는 청크 id 가 다른 내용을 가리킨다.
 *  6) 청크 id 가 결정론적 UUID v5 인가(RFC 4122 시험 벡터로 구현 검증).
 *  7) 선발 배치·본 배치 구간이 `## 슬라이드 N` 헤더를 잃지 않는가(출처 검증 기준집합).
 *
 *   npm run check:page-text
 */
import { createRequire } from 'node:module';
import {
  assemblePageSlides,
  capPageTexts,
  joinPageTexts,
  mergeByPage,
  renderPageText,
} from '../lib/extract/page-text.ts';
import { buildChunks, buildTextChunks, buildTextFirstChunks } from '../lib/extract/chunk.ts';
import { MATERIAL_CHUNK_ID_NAMESPACE, materialChunkId, uuidV5 } from '../lib/extract/chunk-id.ts';
import {
  balancedBlockRange,
  buildEarlyBlocks,
  headerBefore,
  segmentContext,
  sliceRange,
} from '../lib/ai/context-segments.ts';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/** 의존성 없이 ASCII 텍스트 PDF 를 만든다. pages[i] = 그 페이지의 줄 목록. */
function makePdf(pages) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };
  const catalog = add(null);
  const pagesObj = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const lines of pages) {
    const ops = ['BT', '/F1 12 Tf'];
    lines.forEach((line, i) => {
      const esc = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
      ops.push(`1 0 0 1 72 ${720 - i * 20} Tm (${esc}) Tj`);
    });
    ops.push('ET');
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    kids.push(
      add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Node Buffer 가 아니라 순수 Uint8Array 로 넘긴다. pdf-parse 에 묶인 구버전 pdf.js(1.10)는
  // 이렇게 작은 합성 PDF 를 Node 22 의 Buffer 로 받으면 'bad XRef entry' 로 실패한다(실제 강의록
  // 크기의 PDF 는 Buffer 로도 정상 — 검사 환경의 함정일 뿐 프로덕션 경로와 무관).
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

console.log('\n[페이지 본문] pdf-parse 전체 텍스트와 동일');
{
  const pdf = makePdf([
    ['Aortic dissection', 'Tearing chest pain radiating to the back'],
    [],
    ['CT angiography is the standard', 'Stanford A needs emergency surgery', 'Beta blockers first'],
  ]);
  const baseline = await pdfParse(pdf);
  const pages = [];
  const withPages = await pdfParse(pdf, {
    pagerender: async (pageData) => {
      const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      const text = renderPageText(content.items);
      pages.push({ pageIndex: pageData.pageNumber, text });
      return text;
    },
  });
  check('pdf-parse 가 3쪽으로 읽는다', baseline.numpages === 3, String(baseline.numpages));
  check('페이지 렌더러를 써도 전체 텍스트가 같다', withPages.text === baseline.text, JSON.stringify([withPages.text, baseline.text]));
  check('페이지 번호가 1-based 로 모인다', JSON.stringify(pages.map((p) => p.pageIndex)) === '[1,2,3]');
  check('줄 바뀜은 개행으로', pages[0].text === 'Aortic dissection\nTearing chest pain radiating to the back', JSON.stringify(pages[0].text));
  check('빈 페이지는 빈 문자열', pages[1].text === '');
  check('다시 이으면 종전 전체 텍스트(trim)와 같다', joinPageTexts(pages) === baseline.text.trim());
}

console.log('\n[페이지 본문] renderPageText 규칙');
{
  const t = (str, y) => ({ str, transform: [1, 0, 0, 1, 0, y] });
  check('같은 y 는 이어 붙인다', renderPageText([t('ab', 10), t('cd', 10)]) === 'abcd');
  check('y 가 바뀌면 개행', renderPageText([t('ab', 10), t('cd', 5)]) === 'ab\ncd');
  check('첫 항목 y=0 도 첫 줄 취급(pdf-parse 와 동일)', renderPageText([t('a', 0), t('b', 0)]) === 'ab');
  check('항목이 없으면 빈 문자열', renderPageText([]) === '');
}

console.log('\n[페이지 본문] 전체 상한');
{
  const pages = [
    { pageIndex: 1, text: '  가'.padEnd(12, '가') + '  ' },
    { pageIndex: 2, text: '나'.repeat(10) },
    { pageIndex: 3, text: '다'.repeat(10) },
  ];
  // 페이지마다 앞뒤 공백을 걷어 낸 뒤 이은 전체(페이지 텍스트 = trim) 기준으로 종전 절삭과 비교한다.
  // pdf-parse 원문 전체는 페이지 안쪽 앞뒤 공백까지 포함하므로 그와 글자 단위로 같지는 않다.
  const whole = joinPageTexts(pages.map((p) => ({ ...p, text: p.text.trim() })));
  const capped = capPageTexts(pages, 25);
  check('앞뒤 공백을 걷어 낸다', capped.pages[0].text.startsWith('가'));
  const joined = joinPageTexts(capped.pages);
  check('trim 된 페이지 기준으로 종전 앞부분 절삭과 같은 결과', joined === whole.slice(0, 25).trimEnd(), JSON.stringify([joined, whole.slice(0, 25)]));
  check('상한에 걸린 페이지는 남은 만큼만', capped.pages.length === 3 && capped.pages[2].text.length === 1, JSON.stringify(capped.pages));
  check('잘린 글자 수 보고', capped.truncatedChars === whole.length - 25, `${capped.truncatedChars} vs ${whole.length - 25}`);
  const tight = capPageTexts(pages, 12);
  check('상한을 다 쓴 뒤의 페이지는 버린다', tight.pages.length === 1 && tight.pages[0].pageIndex === 1, JSON.stringify(tight.pages));
  const all = capPageTexts(pages, 10_000);
  check('상한 안이면 그대로(자른 글자 0)', all.truncatedChars === 0 && all.pages.length === 3);
  check('상한 0 이면 아무것도 없음', capPageTexts(pages, 0).pages.length === 0);
}

console.log('\n[슬라이드 행] 본문 페이지 + 렌더 페이지');
{
  const rows = assemblePageSlides(
    [
      { pageIndex: 1, text: '본문1' },
      { pageIndex: 2, text: '' },
      { pageIndex: 3, text: '본문3' },
    ],
    [{ pageIndex: 3, png: 'PNG3' }, { pageIndex: 5, png: 'PNG5' }],
    () => '',
  );
  check('본문 또는 PNG 가 있는 페이지만, 페이지 순', JSON.stringify(rows.map((r) => r.pageIndex)) === '[1,3,5]', JSON.stringify(rows));
  check('렌더된 페이지에는 PNG', rows[1].png === 'PNG3' && rows[1].text === '본문3');
  check('렌더 안 된 페이지는 빈 PNG', rows[0].png === '');
  check('본문 없는 렌더 페이지도 남는다(이미지 검출 대상)', rows[2].text === '' && rows[2].png === 'PNG5');
}

console.log('\n[슬라이드 행] 같은 페이지 합치기(PPTX 미디어 폴백)');
{
  const merged = mergeByPage(
    [
      { pageIndex: 1, text: '슬라이드1', crops: ['a'] },
      { pageIndex: 1, text: '슬라이드1', crops: ['b'] },
      { pageIndex: 2, text: '', crops: [] },
      { pageIndex: 2, text: '슬라이드2', crops: ['c'] },
    ],
    (into, from) => {
      into.crops = [...into.crops, ...from.crops];
    },
  );
  check('페이지당 한 행', merged.length === 2);
  check('본문이 반복되지 않는다', merged[0].text === '슬라이드1');
  check('크롭은 순서대로 모인다', JSON.stringify(merged[0].crops) === '["a","b"]');
  check('빈 본문 행 뒤의 본문을 채택', merged[1].text === '슬라이드2' && JSON.stringify(merged[1].crops) === '["c"]');
}

console.log('\n[청크] 본문 먼저 저장 → OCR 추가해도 번호 유지');
{
  const long = ['가'.repeat(700), '나'.repeat(700)].join('\n\n');
  const slides = [
    { pageIndex: 2, slideText: '두 번째 페이지', ocrTexts: ['[xray] 흉부 X선'] },
    { pageIndex: 1, slideText: long, ocrTexts: ['[ecg] ST 상승', '[table] 표'] },
  ];
  const early = buildTextChunks(slides.map((s) => ({ pageIndex: s.pageIndex, slideText: s.slideText })));
  const final = buildTextFirstChunks(slides);
  check('본문 청크는 최종본의 앞부분과 번호·내용이 같다',
    early.length > 0 && early.every((c, i) => JSON.stringify(c) === JSON.stringify(final[i])),
    JSON.stringify(early.map((c) => c.chunkIndex)));
  check('OCR 청크는 본문 뒤에 이어진다',
    final.slice(early.length).every((c) => c.kind === 'ocr') && final.slice(0, early.length).every((c) => c.kind === 'slide_text'));
  check('OCR 청크도 자기 페이지를 가리킨다', final.filter((c) => c.kind === 'ocr').map((c) => c.pageIndex).join(',') === '1,1,2');
  check('번호가 0부터 연속', final.every((c, i) => c.chunkIndex === i));
  check('입력 순서가 달라도 같은 결과', JSON.stringify(buildTextFirstChunks([...slides].reverse())) === JSON.stringify(final));
  // 대조군: 종전 buildChunks(페이지마다 본문·OCR 교차)였다면 OCR 이 붙는 순간 뒤 페이지의
  // 본문 청크 번호가 밀린다 — 이 검사가 막으려는 회귀가 실제로 있다는 확인.
  const legacy = buildChunks(slides);
  const p2Early = early.find((c) => c.pageIndex === 2);
  const p2Legacy = legacy.find((c) => c.pageIndex === 2 && c.kind === 'slide_text');
  check('대조군: 교차 순서라면 2쪽 본문 번호가 밀린다', p2Early && p2Legacy && p2Early.chunkIndex !== p2Legacy.chunkIndex,
    `${p2Early?.chunkIndex} vs ${p2Legacy?.chunkIndex}`);
}

console.log('\n[청크 id] 결정론적 UUID v5');
{
  // RFC 4122 부록의 DNS 네임스페이스 시험 벡터 (널리 쓰이는 uuid 라이브러리와 같은 값)
  check('RFC 시험 벡터', uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8') === '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'));
  const U = '11111111-1111-1111-1111-111111111111';
  const a = materialChunkId(U, 3, 'sha-a');
  check('같은 입력 → 같은 id', a === materialChunkId(U, 3, 'sha-a'));
  check('번호가 다르면 다른 id', a !== materialChunkId(U, 4, 'sha-a'));
  check('업로드가 다르면 다른 id', a !== materialChunkId('22222222-2222-2222-2222-222222222222', 3, 'sha-a'));
  check('같은 번호라도 내용이 바뀌면 다른 id(재처리 뒤 OCR 이 바뀐 경우)', a !== materialChunkId(U, 3, 'sha-b'));
  check('uuid v5 형식', /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(a), a);
  check('네임스페이스 상수가 유효한 uuid', /^[0-9a-f-]{36}$/.test(MATERIAL_CHUNK_ID_NAMESPACE));
}

console.log('\n[구간] 선발 배치 블록·헤더 보존');
{
  const headerPages = (text) => [...text.matchAll(/^##\s*슬라이드\s*(\d+)/gm)].map((m) => Number(m[1]));
  const blocks = buildEarlyBlocks([
    { pageIndex: 1, text: ' 첫 페이지 ' },
    { pageIndex: 2, text: '   ' },
    { pageIndex: 3, text: '셋째 페이지' },
  ]);
  check('빈 페이지는 블록을 만들지 않는다', blocks.length === 2);
  check('헤더가 출처 검증 규칙으로 읽힌다', JSON.stringify(headerPages(blocks.join('\n\n'))) === '[1,3]');
  check('본문은 텍스트: 라벨로', blocks[0] === '## 슬라이드 1\n텍스트: 첫 페이지');

  // 블록이 구간 수 이상 → 블록 경계(앞뒤 1블록 겹침) — 종전 본 배치 규칙과 동일
  const many = Array.from({ length: 6 }, (_, i) => `## 슬라이드 ${i + 1} (이미지 0장)\n텍스트: ${'x'.repeat(50)}`);
  const seg0 = segmentContext({ blocks: many, segIndex: 0, segCount: 3, overlapRatio: 0.1 });
  const seg1 = segmentContext({ blocks: many, segIndex: 1, segCount: 3, overlapRatio: 0.1 });
  check('블록 경계 분할(구간 0 = 1~3)', JSON.stringify(headerPages(seg0)) === '[1,2,3]', JSON.stringify(headerPages(seg0)));
  check('블록 경계 분할(구간 1 = 2~5, 앞뒤 겹침)', JSON.stringify(headerPages(seg1)) === '[2,3,4,5]', JSON.stringify(headerPages(seg1)));
  check('구간이 1개면 전체', segmentContext({ blocks: many, segIndex: 0, segCount: 1, overlapRatio: 0.1 }) === many.join('\n\n'));

  // 블록이 구간 수보다 적음 → 문자 분할 + 헤더 이어 붙이기
  const bigPage = `## 슬라이드 7 (이미지 0장)\n텍스트: ${Array.from({ length: 400 }, (_, i) => `문장 ${i} 입니다.`).join('\n')}`;
  const segs = [0, 1, 2].map((i) => segmentContext({ blocks: [bigPage], segIndex: i, segCount: 3, overlapRatio: 0.1 }));
  check('문자 분할 구간마다 헤더가 있다', segs.every((sg) => JSON.stringify(headerPages(sg)) === '[7]'), JSON.stringify(segs.map(headerPages)));
  check('뒤 구간은 헤더 + 본문 조각', segs[2].startsWith('## 슬라이드 7 (이미지 0장)\n') && segs[2].length < bigPage.length);
  const range = sliceRange(bigPage, 1, 3, 0.1);
  check('headerBefore 는 구간 시작 앞의 마지막 헤더', headerBefore(bigPage, range.start) === '## 슬라이드 7 (이미지 0장)');
  check('헤더가 전혀 없는 원문은 그대로(페이지 모름 폴백)', !segmentContext({ blocks: ['가\n'.repeat(3000)], segIndex: 1, segCount: 2, overlapRatio: 0.1 }).startsWith('##'));

  // 블록 수가 구간 수보다 조금 많아도 빈 구간이 없어야 한다(종전 ceil 규칙은 12블록·8구간에서
  // 마지막 구간이 비었다 → 그 배치는 자료 없이 문항을 만들었다).
  let emptySeg = null;
  let uncovered = null;
  for (let segCount = 2; segCount <= 12 && !emptySeg && !uncovered; segCount++) {
    for (let n = segCount; n <= segCount * 3; n++) {
      const bl = Array.from({ length: n }, (_, i) => `## 슬라이드 ${i + 1}\n텍스트: p${i + 1}`);
      const seen = new Set();
      for (let i = 0; i < segCount; i++) {
        const { from, to } = balancedBlockRange(n, i, segCount);
        if (to <= from) { emptySeg = `n=${n} s=${segCount} i=${i}`; break; }
        for (let k = from; k < to; k++) seen.add(k);
        const seg = segmentContext({ blocks: bl, segIndex: i, segCount, overlapRatio: 0.1 });
        if (!seg.trim()) { emptySeg = `n=${n} s=${segCount} i=${i} (segmentContext)`; break; }
      }
      if (!emptySeg && seen.size !== n) { uncovered = `n=${n} s=${segCount} covered ${seen.size}`; break; }
    }
  }
  check('n ≥ 구간 수이면 모든 구간이 최소 1블록', emptySeg === null, emptySeg ?? '');
  check('겹침 전 구간들의 합이 전체 블록을 빠짐없이 덮는다', uncovered === null, uncovered ?? '');
  const b12 = Array.from({ length: 12 }, (_, i) => `## 슬라이드 ${i + 1}\n텍스트: p${i + 1}`);
  check('12블록·8구간의 마지막 구간도 자료가 있다',
    JSON.stringify(headerPages(segmentContext({ blocks: b12, segIndex: 7, segCount: 8, overlapRatio: 0.1 }))) === '[10,11,12]',
    JSON.stringify(headerPages(segmentContext({ blocks: b12, segIndex: 7, segCount: 8, overlapRatio: 0.1 }))));

  // 문자 분할 구간이 블록 사이 빈 줄에서 시작해도 앞 페이지 헤더를 덧붙이지 않는다
  const two = [`## 슬라이드 1\n텍스트: ${'a'.repeat(20)}\nend`, `## 슬라이드 2\n텍스트: row 0\n${'b\n'.repeat(3)}`];
  const twoText = two.join('\n\n');
  let wrongHeader = null;
  for (let segCount = 3; segCount <= 8; segCount++) {
    for (let i = 1; i < segCount; i++) {
      const sg = segmentContext({ blocks: two, text: twoText, segIndex: i, segCount, overlapRatio: 0.1 });
      // 잘못된 경우 = 덧붙인 헤더 바로 뒤에 (빈 줄만 두고) 다른 헤더가 오는 것 — 그 페이지의
      // 내용이 한 글자도 없는데 출처 기준집합에만 들어간다.
      if (/^##\s*슬라이드\s*\d+[^\n]*\n\s*##\s*슬라이드/.test(sg)) wrongHeader = `s=${segCount} i=${i}: ${JSON.stringify(sg.slice(0, 40))}`;
      if (/^\s/.test(sg)) wrongHeader = `leading whitespace s=${segCount} i=${i}`;
    }
  }
  check('빈 줄에서 시작하는 구간에 앞 페이지 헤더가 섞이지 않는다', wrongHeader === null, wrongHeader ?? '');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

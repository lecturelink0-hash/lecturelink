/**
 * 출처 추적 회귀 검사 (분담표 A8) — 네트워크·DB 없이 돈다.
 *
 * 무엇을 지키는가
 *  1) 청킹이 **결정론**인가. 같은 자료를 다시 처리했을 때 청크 번호가 달라지면
 *     이전에 저장된 문항의 출처가 통째로 끊긴다.
 *  2) 슬라이드 본문과 OCR 이 갈라져 있는가. 한 덩어리로 묶으면 검수자가 "저자가 쓴 글"과
 *     "기계가 읽은 글자"를 구분할 수 없다.
 *  3) 구조적 출처 검사가 **없는 페이지를 걸러내는가**. 모델이 지어낸 번호를 통과시키면
 *     "출처 유효성"이라는 지표가 거짓말이 된다.
 *  4) 배치가 보지도 못한 페이지를 인용했을 때 잡히는가(구간 분할 때문에 실제로 생긴다).
 *
 *   npm run check:source-tracking
 */
import {
  buildChunks,
  splitText,
  chunkHash,
  pagesOf,
  MAX_CHUNK_CHARS,
} from '../lib/extract/chunk.ts';
import {
  validateSourceRefs,
  normalizeReportedPages,
  toStoredRefs,
} from '../lib/ai/source-refs.ts';

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

console.log('\n[청킹] 결정론');
{
  const slides = [
    { pageIndex: 2, slideText: '두 번째 슬라이드 본문이다.', ocrTexts: ['그림 속 글자'] },
    { pageIndex: 1, slideText: '첫 번째 슬라이드 본문이다.', ocrTexts: [] },
  ];
  const a = buildChunks(slides);
  const b = buildChunks([...slides].reverse());
  check('입력 순서가 달라도 같은 결과', JSON.stringify(a) === JSON.stringify(b));
  check('페이지 순으로 정렬', a[0].pageIndex === 1 && a[1].pageIndex === 2);
  check('청크 번호가 0부터 연속', a.every((c, i) => c.chunkIndex === i), JSON.stringify(a.map((c) => c.chunkIndex)));
  check('같은 내용 → 같은 해시', chunkHash('가나다') === chunkHash('가나다'));
  check('다른 내용 → 다른 해시', chunkHash('가나다') !== chunkHash('가나라'));
  check('해시가 내용과 함께 저장된다', a[0].sha256 === chunkHash(a[0].text));
}

console.log('\n[청킹] 본문과 OCR 분리');
{
  const chunks = buildChunks([
    { pageIndex: 3, slideText: '저자가 쓴 본문', ocrTexts: ['[table] 기계가 읽은 표', '[figure] 축 라벨'] },
  ]);
  check('청크 3개 (본문 1 + OCR 2)', chunks.length === 3, String(chunks.length));
  check('본문은 slide_text', chunks[0].kind === 'slide_text');
  check('OCR 은 ocr 로 표시', chunks[1].kind === 'ocr' && chunks[2].kind === 'ocr');
  check('OCR 도 같은 페이지에 매인다', chunks.every((c) => c.pageIndex === 3));
  check('빈 본문은 청크를 만들지 않는다',
    buildChunks([{ pageIndex: 1, slideText: '   ', ocrTexts: [] }]).length === 0);
}

console.log('\n[청킹] 긴 텍스트 분할');
{
  const paragraph = '가'.repeat(500);
  const long = [paragraph, paragraph, paragraph, paragraph].join('\n\n'); // 2000자 + 구분자
  const pieces = splitText(long);
  check('상한을 넘지 않는다', pieces.every((p) => p.length <= MAX_CHUNK_CHARS),
    JSON.stringify(pieces.map((p) => p.length)));
  check('내용이 유실되지 않는다',
    pieces.join('').replace(/\s/g, '').length === long.replace(/\s/g, '').length,
    `${pieces.join('').replace(/\s/g, '').length} vs ${long.replace(/\s/g, '').length}`);

  // 줄바꿈 없는 초장문(표를 그대로 붙여넣은 경우)도 끊긴다
  const wall = '나'.repeat(5000);
  const wallPieces = splitText(wall);
  check('줄바꿈 없는 초장문도 상한 안', wallPieces.every((p) => p.length <= MAX_CHUNK_CHARS),
    JSON.stringify(wallPieces.map((p) => p.length)));
  check('짧은 텍스트는 그대로 1개', splitText('짧다').length === 1);
  check('빈 텍스트는 0개', splitText('   ').length === 0);

  // 긴 슬라이드가 여러 청크가 되어도 모두 같은 페이지를 가리킨다
  const chunks = buildChunks([{ pageIndex: 7, slideText: long }]);
  check('분할된 청크가 모두 같은 페이지', chunks.length > 1 && chunks.every((c) => c.pageIndex === 7),
    `${chunks.length}개`);
  check('pagesOf 는 중복 없이 정렬', JSON.stringify(pagesOf(chunks)) === '[7]');
}

console.log('\n[출처] 모델이 보고한 값 정규화');
{
  check('문자열 숫자 허용', JSON.stringify(normalizeReportedPages(['3', 1])) === '[1,3]');
  check('중복 제거·정렬', JSON.stringify(normalizeReportedPages([5, 5, 2])) === '[2,5]');
  check('소수는 버림', JSON.stringify(normalizeReportedPages([2.9])) === '[2]');
  check('0·음수 제거', JSON.stringify(normalizeReportedPages([0, -1, 4])) === '[4]');
  check('배열이 아니면 빈 배열', JSON.stringify(normalizeReportedPages('3')) === '[]');
  check('쓰레기 값 제거', JSON.stringify(normalizeReportedPages([null, 'abc', {}, 6])) === '[6]');
}

console.log('\n[출처] 구조적 유효성 — 없는 페이지를 거르는가');
{
  const chunks = [
    { id: 'c1', pageIndex: 1 },
    { id: 'c2', pageIndex: 1 },
    { id: 'c3', pageIndex: 2 },
  ];
  const result = validateSourceRefs(
    [
      { sourcePages: [1, 2] },   // 둘 다 있음
      { sourcePages: [1, 99] },  // 99 는 자료에 없다
      { sourcePages: [] },       // 출처 미신고
    ],
    { fileSha256: 'sha-abc', availablePages: [1, 2], chunks },
  );

  check('유효 페이지만 남긴다', JSON.stringify(result.refs[0].pages) === '[1,2]');
  check('없는 페이지는 invalidPages 로', JSON.stringify(result.refs[1].invalidPages) === '[99]');
  check('없는 페이지는 pages 에서 제외', JSON.stringify(result.refs[1].pages) === '[1]');
  check('신고 원본을 보존', JSON.stringify(result.refs[1].reportedPages) === '[1,99]');
  check('청크 id 를 이어 붙인다', JSON.stringify(result.refs[0].chunkIds) === '["c1","c2","c3"]',
    JSON.stringify(result.refs[0].chunkIds));
  check('파일 해시가 함께 저장된다', result.refs[0].fileSha256 === 'sha-abc');

  const s = result.stats;
  check('출처 신고율 2/3', Math.abs(s.sourceReportRate - 0.6667) < 1e-4, String(s.sourceReportRate));
  check('참조 4개 중 3개 유효', s.referencesReported === 4 && s.referencesValid === 3,
    `${s.referencesReported}/${s.referencesValid}`);
  check('구조적 유효성 0.75', s.locationValidRate === 0.75, String(s.locationValidRate));
  check('잘못 신고한 문항 수', s.questionsWithInvalidRef === 1);
  check('없는 페이지를 경고로', result.warnings.some((w) => w.includes('99')));
  check('미신고를 경고로', result.warnings.some((w) => w.includes('신고하지 않은')));
}

console.log('\n[출처] 배치가 못 본 페이지를 인용한 경우');
{
  // 구간 분할로 이 배치는 5~8페이지만 받았는데 모델이 1페이지를 인용했다.
  // 자료 전체 페이지로 검사하면 통과해 버린다 — availablePages 는 그 배치가 실제로
  // 본 페이지여야 한다.
  const result = validateSourceRefs([{ sourcePages: [1, 6] }], { availablePages: [5, 6, 7, 8] });
  check('배치 밖 페이지를 잡는다', JSON.stringify(result.refs[0].invalidPages) === '[1]',
    JSON.stringify(result.refs[0].invalidPages));
  check('배치 안 페이지는 통과', JSON.stringify(result.refs[0].pages) === '[6]');
  check('구조적 유효성 0.5', result.stats.locationValidRate === 0.5);
}

console.log('\n[출처] 저장 형태');
{
  const { refs } = validateSourceRefs(
    [{ sourcePages: [2] }, { sourcePages: [] }],
    { fileSha256: 'sha-x', availablePages: [2], chunks: [{ id: 'c9', pageIndex: 2 }] },
  );
  const stored = toStoredRefs(refs[0]);
  check('저장 형태에 해시·페이지·청크', stored.fileSha256 === 'sha-x'
    && JSON.stringify(stored.pages) === '[2]' && JSON.stringify(stored.chunkIds) === '["c9"]');
  check('원문 텍스트를 싣지 않는다', !('text' in stored) && !('reportedPages' in stored),
    JSON.stringify(Object.keys(stored)));
  check('출처가 아예 없으면 null', toStoredRefs(refs[1]) === null);

  const withInvalid = toStoredRefs(
    validateSourceRefs([{ sourcePages: [3] }], { availablePages: [1] }).refs[0],
  );
  check('잘못된 신고는 흔적을 남긴다', JSON.stringify(withInvalid.invalidPages) === '[3]',
    JSON.stringify(withInvalid));
}

console.log(`\n통과 ${pass} · 실패 ${fail}`);
if (fail > 0) process.exit(1);
console.log('출처 추적 회귀 검사 통과.');

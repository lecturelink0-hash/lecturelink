/**
 * PDF 페이지 렌더 검사 — 그림이 있는 페이지가 렌더되는가 (npm run check:pdf-render)
 *
 * 왜 필요한가: pdfjs-dist 4.10 의 Node 기본 캔버스 팩토리는 렌더 도중 만드는 임시 캔버스를
 * `@napi-rs/canvas` 로 만들고, 우리 코드는 페이지 캔버스를 node-canvas 로 만든다. 둘이 섞이면
 * 그림(이미지 XObject·인라인 이미지)이 있는 페이지에서 "Image or Canvas expected" 로 렌더가
 * 통째로 실패하고, 호출부는 "PDF 페이지 렌더 실패 — 텍스트만 사용" 으로 넘어간다.
 * 스캔 PDF 는 한 페이지도 렌더되지 않아 OCR 이 돌지 않는다. 텍스트만 있는 페이지는 멀쩡해서
 * 텍스트 위주 자료로만 확인하면 드러나지 않는다.
 *
 * 합성 PDF(외부 파일 없음)를 실제 renderPdfPages 로 렌더해 확인한다.
 *   1쪽: 이미지 XObject(빨강 16×16)   2쪽: 인라인 이미지(파랑 4×4)   3쪽: 벡터 사각형(초록)
 *
 * 같이 보는 것: 호출자의 버퍼가 그대로인가. pdfjs 는 받은 버퍼를 분리(detach)하므로 사본을
 * 넘기지 않으면, 같은 PDF 를 두 번 렌더하는 호출부(전체 훑기 → 후보 페이지)의 두 번째 호출이
 * "detached ArrayBuffer" 로 실패한다. 그림 렌더가 실패하던 동안에는 첫 호출에서 이미 넘어가
 * 드러나지 않던 결함이다.
 *
 *   node --experimental-strip-types --no-warnings scripts/check-pdf-render.mjs
 */
import { renderPdfPages, extractPdfTextPages } from '../lib/extract/render-slides.ts';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ── 합성 PDF ─────────────────────────────────────────────────────────────────
function buildPdf() {
  const red = Buffer.alloc(16 * 16 * 3);
  for (let i = 0; i < red.length; i += 3) red[i] = 255;
  const blue = Buffer.alloc(4 * 4 * 3);
  for (let i = 2; i < blue.length; i += 3) blue[i] = 255;

  const stream = (dict, body) =>
    Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${body.length} >>\nstream\n`, 'latin1'),
      body,
      Buffer.from('\nendstream', 'latin1'),
    ]);
  const page1 = Buffer.from('q 160 0 0 160 20 20 cm /Im1 Do Q', 'latin1');
  const page2 = Buffer.concat([
    Buffer.from('q 160 0 0 160 20 20 cm BI /W 4 /H 4 /CS /RGB /BPC 8 ID ', 'latin1'),
    blue,
    Buffer.from(' EI Q', 'latin1'),
  ]);
  const page3 = Buffer.from('0 1 0 rg 20 20 160 160 re f', 'latin1');

  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R 6 0 R 8 0 R] /Count 3 >>', 'latin1'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>',
      'latin1',
    ),
    stream('', page1),
    stream('/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB /BitsPerComponent 8', red),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 7 0 R >>', 'latin1'),
    stream('', page2),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 9 0 R >>', 'latin1'),
    stream('', page3),
  ];

  const parts = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [];
  let pos = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(pos);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    parts.push(chunk);
    pos += chunk.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
  parts.push(Buffer.from(xref, 'latin1'));
  const buf = Buffer.concat(parts);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function centerPixel(png) {
  const { loadImage, createCanvas } = await import('canvas');
  const img = await loadImage(Buffer.from(png));
  const c = createCanvas(img.width, img.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const [r, g, b] = ctx.getImageData(Math.floor(img.width / 2), Math.floor(img.height / 2), 1, 1).data;
  return { r, g, b };
}

// ── 검사 ─────────────────────────────────────────────────────────────────────
console.log('[check:pdf-render]');
const pdf = buildPdf();

let pages = [];
let renderError = null;
try {
  pages = await renderPdfPages(pdf, { maxEdgePx: 200 });
} catch (e) {
  renderError = e instanceof Error ? e.message : String(e);
}
check('그림 있는 페이지를 포함한 PDF 렌더가 예외 없이 끝난다', renderError === null, renderError ?? '');
check('3쪽 모두 렌더된다', pages.length === 3, `실제 ${pages.length}쪽`);
check('렌더 후에도 호출자의 버퍼가 그대로다(분리되지 않음)', pdf.byteLength > 0, `byteLength ${pdf.byteLength}`);

// 같은 버퍼로 두 번째 렌더 — 운영의 '전체 훑기 → 후보 페이지' 순서와 같다.
let second = [];
let secondError = null;
try {
  second = await renderPdfPages(pdf, { pages: [2], maxEdgePx: 400 });
} catch (e) {
  secondError = e instanceof Error ? e.message : String(e);
}
check('같은 버퍼로 두 번째 렌더(후보 페이지)가 된다', secondError === null && second.length === 1, secondError ?? `실제 ${second.length}쪽`);

const textBuf = buildPdf();
await extractPdfTextPages(textBuf);
check('페이지 텍스트 추출 뒤에도 호출자의 버퍼가 그대로다', textBuf.byteLength > 0, `byteLength ${textBuf.byteLength}`);

const expect = [
  { page: 1, name: '이미지 XObject', want: 'r' },
  { page: 2, name: '인라인 이미지', want: 'b' },
  { page: 3, name: '벡터 도형', want: 'g' },
];
for (const e of expect) {
  const p = pages.find((x) => x.pageIndex === e.page);
  if (!p) {
    check(`${e.page}쪽(${e.name})이 그려진다`, false, '렌더 결과 없음');
    continue;
  }
  const px = await centerPixel(p.png);
  const other = ['r', 'g', 'b'].filter((k) => k !== e.want);
  const ok = px[e.want] > 200 && other.every((k) => px[k] < 60);
  check(`${e.page}쪽(${e.name})이 실제로 그려진다 — 가운데 픽셀`, ok, JSON.stringify(px));
}

// 참고: 팩토리를 넘기지 않은 pdfjs 기본 설정이 여전히 실패하는지(= 이 수정이 아직 필요한지).
// pdfjs 를 올려 기본값이 바뀌면 여기가 '성공'으로 바뀐다 — 실패로 치지 않고 알리기만 한다.
try {
  const { resolve } = await import('node:path');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = await import('canvas');
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buildPdf()),
    standardFontDataUrl: resolve(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts') + '/',
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
  }).promise;
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  let defaultErr = null;
  try {
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  } catch (e) {
    defaultErr = e instanceof Error ? e.message : String(e);
  }
  await doc.destroy();
  console.log(
    defaultErr
      ? `  · 참고: 팩토리 없이 렌더하면 여전히 실패 (${defaultErr}) — 이 수정이 필요함`
      : '  · 참고: 팩토리 없이도 렌더됨 — pdfjs 기본값이 바뀐 것. 수정 유지 여부를 재검토할 것',
  );
} catch (e) {
  console.log(`  · 참고 확인 생략: ${e instanceof Error ? e.message : String(e)}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

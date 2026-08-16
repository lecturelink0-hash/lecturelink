/**
 * 이미지 표식(A·B·C) 자기 검사.
 *
 *   npm run check:markers
 *
 * 무엇을 지키는가
 * ──────────────
 * 이미지형 문항이 "그림을 가려도 풀리는" 상태로 돌아가지 않게 하는 장치가 표식이다.
 * 표식이 조용히 0개가 되면(선별 규칙이 과해지거나 좌표가 어긋나면) 이미지형은 예전처럼
 * "이 그림에 대한 설명으로 옳은 것은?"으로 후퇴하는데, 그 회귀는 아무 오류도 내지 않는다.
 *
 * 그래서 실제 PNG 를 만들어 마스킹→표식까지 통과시키고 **픽셀이 실제로 바뀌었는지**까지 본다.
 * 규칙만 문자열로 확인하면 "표식을 찍었다고 믿었는데 안 찍힌" 상태를 잡지 못한다.
 */

import { readFileSync } from 'node:fs';
import { maskTextRegions, isShortFigureLabel as maskShortLabel } from '../lib/extract/mask-text.ts';
import {
  looksLikeStructureLabel,
  selectMarkerSources,
  annotateMarkers,
  buildMarkerLegend,
  isShortFigureLabel as annotateShortLabel,
  stemReferencesMarker,
  MAX_MARKERS_PER_IMAGE,
} from '../lib/extract/annotate-markers.ts';

let failed = 0;
const check = (name, ok, detail) => {
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('짧은 라벨 판정 — 두 구현의 일치');
{
  // annotate-markers.ts 는 의존성 없이 두려고 mask-text.ts 의 규칙을 복제했다.
  // 두 구현이 갈라지면 표식 선별이 조용히 어긋나므로 여기서 고정한다.
  const samples = [
    'A', 'B', '(C)', 'D.', 'E', 'F', '1', '9', '①', 'Ⅲ', '가',
    'Astrocyte', 'Type A', '별아교세포', '', '  ', 'AB', '12',
  ];
  const mismatched = samples.filter((s) => maskShortLabel(s) !== annotateShortLabel(s));
  check(
    'mask-text 와 annotate-markers 의 isShortFigureLabel 이 같다',
    mismatched.length === 0,
    `어긋난 입력: ${mismatched.map((s) => JSON.stringify(s)).join(', ')}`,
  );
}

console.log('구조 이름 라벨 판정(looksLikeStructureLabel)');
check('영문 구조명', looksLikeStructureLabel('Astrocyte'));
check('여러 단어 구조명', looksLikeStructureLabel('Layer of pyramidal cells'));
check('한글 구조명', looksLikeStructureLabel('별아교세포'));
check('괄호 표기', looksLikeStructureLabel('(Myelin sheath)'));
check('짧은 패널 라벨은 제외', looksLikeStructureLabel('A') === false);
check('원문자 패널 라벨은 제외', looksLikeStructureLabel('①') === false);
check('그림 번호 캡션은 제외', looksLikeStructureLabel('Figure 3') === false);
check('한글 그림 캡션은 제외', looksLikeStructureLabel('그림 1') === false);
check('순수 수치·단위는 제외', looksLikeStructureLabel('100 µm') === false);
check('서술 문장은 제외', looksLikeStructureLabel('미엘린 수초를 형성한다') === false);
check('영문 문장은 제외', looksLikeStructureLabel('This layer contains large pyramidal neurons') === false);
check('너무 긴 텍스트는 제외', looksLikeStructureLabel('a'.repeat(40)) === false);
check('빈 문자열은 제외', looksLikeStructureLabel('') === false);
check('2음절 한글 구조명은 통과', looksLikeStructureLabel('축삭'));

console.log('표식 자리 선별(selectMarkerSources)');
const W = 400;
const H = 300;
{
  const regions = [
    { text: 'Molecular layer', x0: 30, y0: 20, x1: 130, y1: 36 },
    { text: 'Pyramidal cells', x0: 30, y0: 120, x1: 130, y1: 136 },
    { text: 'Fusiform cells', x0: 30, y0: 220, x1: 130, y1: 236 },
    { text: 'Figure 2', x0: 300, y0: 280, x1: 360, y1: 296 }, // 캡션 — 제외
    { text: 'A', x0: 200, y0: 100, x1: 210, y1: 116 }, // 패널 라벨 조각 — 제외
  ];
  const picked = selectMarkerSources(regions, W, H);
  check('구조 라벨 3개만 고른다', picked.length === 3, `실제 ${picked.length}개`);
  check(
    '읽기 순서(위→아래)로 정렬한다',
    picked[0].text === 'Molecular layer' && picked[2].text === 'Fusiform cells',
    picked.map((p) => p.text).join(' → '),
  );
}
{
  // 같은 이름이 두 번 나오면 한 번만 — 아니면 정답이 둘인 문항이 된다.
  const regions = [
    { text: 'Axon', x0: 20, y0: 20, x1: 70, y1: 36 },
    { text: 'axon', x0: 20, y0: 160, x1: 70, y1: 176 },
    { text: 'Dendrite', x0: 200, y0: 20, x1: 260, y1: 36 },
  ];
  const picked = selectMarkerSources(regions, W, H);
  check('같은 라벨은 한 번만 표식으로 쓴다', picked.length === 2, picked.map((p) => p.text).join(', '));
}
{
  // 표식끼리 겹치면 어느 것을 가리키는지 알 수 없다.
  const regions = [
    { text: 'Nucleus', x0: 100, y0: 100, x1: 150, y1: 116 },
    { text: 'Nucleolus', x0: 104, y0: 104, x1: 154, y1: 120 },
  ];
  const picked = selectMarkerSources(regions, W, H);
  check('너무 가까운 자리는 하나만 쓴다', picked.length === 1);
}
{
  const wide = [{ text: 'Cerebral cortex layers', x0: 10, y0: 10, x1: 330, y1: 30 }];
  check('그림 폭의 절반을 넘는 줄은 캡션으로 보고 제외', selectMarkerSources(wide, W, H).length === 0);
}
{
  const many = Array.from({ length: 9 }, (_, i) => ({
    text: `Structure ${'ABCDEFGHI'[i]}`,
    x0: 20,
    y0: 10 + i * 32,
    x1: 110,
    y1: 26 + i * 32,
  }));
  const picked = selectMarkerSources(many, W, 320);
  check(
    `표식은 최대 ${MAX_MARKERS_PER_IMAGE}개(A~E)까지만`,
    picked.length <= MAX_MARKERS_PER_IMAGE,
    `실제 ${picked.length}개`,
  );
}
check('덮인 자리가 없으면 표식도 없다', selectMarkerSources([], W, H).length === 0);

console.log('표식 안내문(buildMarkerLegend)');
check('표식이 없으면 안내문도 없다', buildMarkerLegend(0, []) === '');
{
  const legend = buildMarkerLegend(2, [
    { letter: 'A', label: 'Molecular layer' },
    { letter: 'B', label: 'Pyramidal cells' },
  ]);
  check('이미지 번호를 밝힌다', legend.includes('[이미지 2]'));
  check('대응표를 담는다', legend.includes('A = Molecular layer') && legend.includes('B = Pyramidal cells'));
  check('학생에게 안 보인다고 명시한다', legend.includes('보이지 않음'));
  check('라벨 원문 사용 금지를 명시한다', legend.includes('그대로 적으면'));
  check('어긋나면 쓰지 말라고 안내한다', legend.includes('어긋나 보이면'));
}

console.log('표식 참조 발문 판정(stemReferencesMarker)');
// 이걸 놓치면 이미지가 빠졌을 때 표식 문항이 그림 없이 살아남아 학생에게 나간다.
check('A로 표시된', stemReferencesMarker('A로 표시된 세포층에서 유래하는 신경섬유는?'));
check('C가 가리키는', stemReferencesMarker('C가 가리키는 세포는?'));
check(
  '"비타민 C에 해당하는"은 표식 참조가 아니다(오탐이면 문항이 삭제된다)',
  stemReferencesMarker('비타민 C에 해당하는 결핍 증상은?') === false,
);
check('D로 표시한', stemReferencesMarker('D로 표시한 부위에서 일어나는 변화는?'));
check('표식 E', stemReferencesMarker('표식 E 부위의 진단은?'));
check('E는 표시된', stemReferencesMarker('E는 표시된 층이다. 진단은?'));
check('"A형 간염"은 아니다', stemReferencesMarker('A형 간염의 예방 조치는?') === false);
check('"B형 위축"은 아니다', stemReferencesMarker('B형 위축위염의 진단은?') === false);
check('영문 단어 안의 글자는 아니다', stemReferencesMarker('Astrocyte가 가리키는 세포는?') === false);
check('표식이 없는 발문은 아니다', stemReferencesMarker('62세 남자의 진단은?') === false);

console.log('실제 렌더 — 마스킹 → 표식');
{
  const { createCanvas, loadImage } = await import('canvas');

  // 라벨이 붙은 모식도를 흉내 낸 그림을 만든다.
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  // 그림 몸통(표식이 침범하면 안 되는 영역)
  ctx.fillStyle = '#cfe3f5';
  ctx.fillRect(180, 40, 180, 220);
  ctx.fillStyle = '#111111';
  ctx.font = '16px sans-serif';
  const labels = [
    { text: 'Molecular layer', x: 20, y: 60 },
    { text: 'Pyramidal cells', x: 20, y: 150 },
    { text: 'Fusiform cells', x: 20, y: 240 },
  ];
  for (const l of labels) ctx.fillText(l.text, l.x, l.y);
  const original = new Uint8Array(canvas.toBuffer('image/png'));

  const boxes = labels.map((l) => ({
    text: l.text,
    x0: l.x - 2,
    y0: l.y - 16,
    x1: l.x + Math.ceil(ctx.measureText(l.text).width) + 2,
    y1: l.y + 5,
  }));

  const masked = await maskTextRegions(original, boxes);
  check('세 라벨을 모두 덮었다', masked.masked === 3, `실제 ${masked.masked}개`);
  check('덮은 자리 좌표를 돌려준다', masked.regions.length === 3, `실제 ${masked.regions.length}개`);
  check(
    '덮은 자리에 원래 글자가 기록돼 있다',
    masked.regions.every((r) => labels.some((l) => l.text === r.text)),
  );

  const sources = selectMarkerSources(masked.regions, W, H);
  check('덮은 자리 셋 다 표식 후보가 된다', sources.length === 3, `실제 ${sources.length}개`);

  const annotated = await annotateMarkers(masked.png, sources);
  check('표식 3개를 반환한다', annotated.markers.length === 3);
  check(
    '표식 글자가 A·B·C 순이다',
    annotated.markers.map((m) => m.letter).join('') === 'ABC',
    annotated.markers.map((m) => m.letter).join(''),
  );
  check(
    '대응표가 원본 라벨을 담는다',
    annotated.markers[0].label === 'Molecular layer',
    annotated.markers[0].label,
  );

  // 픽셀 검증 — "찍었다고 믿었는데 안 찍힌" 상태를 잡는다.
  const img = await loadImage(Buffer.from(annotated.png));
  const out = createCanvas(W, H);
  const octx = out.getContext('2d');
  octx.drawImage(img, 0, 0);
  const data = octx.getImageData(0, 0, W, H).data;
  const px = (x, y) => {
    const o = (y * W + x) * 4;
    return [data[o], data[o + 1], data[o + 2]];
  };
  const isDark = ([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b < 100;

  // 각 표식 자리 주변에 검은 픽셀(테두리·글자)이 생겼는가.
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const cx = Math.round((s.x0 + s.x1) / 2);
    const cy = Math.round((s.y0 + s.y1) / 2);
    let dark = 0;
    for (let y = Math.max(0, cy - 14); y <= Math.min(H - 1, cy + 14); y++) {
      for (let x = Math.max(0, cx - 14); x <= Math.min(W - 1, cx + 14); x++) {
        if (isDark(px(x, y))) dark += 1;
      }
    }
    check(`표식 ${'ABC'[i]} 가 실제로 그려졌다`, dark > 20, `어두운 픽셀 ${dark}개`);
  }

  // 그림 몸통은 건드리지 않았는가.
  const bodyIntact = (() => {
    for (let y = 60; y < 240; y += 7) {
      for (let x = 200; x < 340; x += 7) {
        const [r, g, b] = px(x, y);
        if (Math.abs(r - 0xcf) > 12 || Math.abs(g - 0xe3) > 12 || Math.abs(b - 0xf5) > 12) {
          return false;
        }
      }
    }
    return true;
  })();
  check('표식이 그림 몸통을 침범하지 않는다', bodyIntact);

  // 라벨 글자는 여전히 지워진 상태인가(표식이 글자를 되살리면 정답 노출).
  // 표식 원은 덮인 자리 **중앙**에 앉으므로, 왼쪽 가장자리 띠에는 아무것도 없어야 한다.
  // (좌표를 손으로 적으면 원 가장자리에 걸린다 — 실제 자리에서 계산한다.)
  const labelAreaClean = (() => {
    const s = sources[1];
    let dark = 0;
    for (let y = s.y0 + 2; y <= s.y1 - 2; y++) {
      for (let x = s.x0 + 2; x <= s.x0 + 15; x++) if (isDark(px(x, y))) dark += 1;
    }
    return dark === 0;
  })();
  check('덮인 라벨 글자는 되살아나지 않았다', labelAreaClean);

  const noSources = await annotateMarkers(masked.png, []);
  check('후보가 없으면 원본을 그대로 돌려준다', noSources.png === masked.png && noSources.markers.length === 0);
}

console.log('표식 글자 — 폰트 API 를 아예 쓰지 않는가');
{
  // 운영 사고의 근본 원인은 "폰트가 없는 런타임에서 fillText 를 썼다"는 것이다.
  // 그 조건은 로컬에서 재현할 수 없다 — macOS 의 node-canvas 는 CoreText 를 쓰므로
  // FONTCONFIG_FILE 을 비워도 글자가 그대로 그려진다(실제로 시도해 확인했다).
  //
  // 재현할 수 없는 조건은 **없앤 것을 증명**하는 쪽이 확실하다. 그리기 경로가 폰트
  // API 를 한 번도 부르지 않으면 폰트 유무가 결과를 바꿀 수 없다.
  const raw = readFileSync(new URL('../lib/extract/annotate-markers.ts', import.meta.url), 'utf8');
  // 주석은 뺀다 — 사고 경위를 설명하려고 주석에 `ctx.fillText(…)` 를 적어 두었고,
  // 그대로 검사하면 설명을 지워야 통과하는 검사가 된다.
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
  const banned = ['fillText', 'strokeText', 'measureText', 'registerFont'];
  const hits = banned.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(src));
  check(
    '폰트 렌더링 API 를 호출하지 않는다',
    hits.length === 0,
    `발견: ${hits.join(', ')} — 폰트 없는 런타임에서 두부(□)가 된다`,
  );
  check(
    'ctx.font 을 설정하지 않는다',
    !/\.font\s*=/.test(src),
    'font 를 지정한다는 것은 폰트에 의존한다는 뜻이다',
  );
}

console.log('표식 글자 — 폰트 없이 실제로 구별되게 그려지는가');
{
  // 운영 사고 재발 방지. 첫 배포분은 ctx.fillText + 'sans-serif' 를 썼는데 Vercel
  // 리눅스 런타임에 폰트가 없어 **모든 표식이 두부(□)로** 나갔다. 원과 테두리는 우리가
  // 그리므로 "어두운 픽셀이 있는가"만 보는 검사로는 잡히지 않는다(그때 통과했다).
  //
  // 두부·빈 원은 다섯 글자가 **서로 똑같아진다.** 그래서 글자별 내부 픽셀이 전부
  // 다른지를 본다 — 이건 폰트가 없으면 반드시 깨진다.
  const { createCanvas, loadImage } = await import('canvas');
  const IW = 400;
  const IH = 600;
  const base = createCanvas(IW, IH);
  const bctx = base.getContext('2d');
  bctx.fillStyle = '#ffffff';
  bctx.fillRect(0, 0, IW, IH);

  const BOX_H = 24;
  const regions = Array.from({ length: 5 }, (_, i) => ({
    text: `Structure number ${i}`,
    x0: 40,
    y0: 40 + i * 100,
    x1: 140,
    y1: 40 + i * 100 + BOX_H,
  }));
  const picked = selectMarkerSources(regions, IW, IH);
  check('다섯 자리를 모두 고른다', picked.length === 5, `실제 ${picked.length}개`);

  const res = await annotateMarkers(new Uint8Array(base.toBuffer('image/png')), picked);
  check('다섯 표식을 반환한다', res.markers.length === 5);
  check('A~E 를 순서대로 쓴다', res.markers.map((m) => m.letter).join('') === 'ABCDE');

  const img = await loadImage(Buffer.from(res.png));
  const out = createCanvas(IW, IH);
  const octx = out.getContext('2d');
  octx.drawImage(img, 0, 0);
  const data = octx.getImageData(0, 0, IW, IH).data;
  const dark = (x, y) => {
    const o = (y * IW + x) * 4;
    return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2] < 100;
  };

  // 반지름을 여기서 다시 계산하지 않는다(구현 공식과 이중으로 묶이면 크기를 조정할
  // 때마다 검사가 엉뚱하게 깨진다). 그린 결과에서 원의 바깥 테두리를 찾아 역산한다.
  const outerRadius = (cx, cy) => {
    for (let d = 60; d > 3; d--) {
      if (cx + d < IW && dark(cx + d, cy)) return d;
    }
    return 0;
  };
  const signatures = picked.map((s) => {
    const cx = Math.round((s.x0 + s.x1) / 2);
    const cy = Math.round((s.y0 + s.y1) / 2);
    const R = outerRadius(cx, cy);
    // 테두리를 빼고 **원 안쪽만** 본다 — 테두리는 글자와 무관하게 항상 같다.
    // 글자 전체가 들어올 만큼 넓게 잡는다(너무 좁으면 C·D 처럼 획이 바깥에 있는
    // 글자들의 중앙이 나란히 비어 서로 같아 보인다).
    const inner = Math.round(R * 0.72);
    let bits = '';
    let ink = 0;
    for (let y = cy - inner; y <= cy + inner; y++) {
      for (let x = cx - inner; x <= cx + inner; x++) {
        const d = dark(x, y);
        bits += d ? '1' : '0';
        if (d) ink += 1;
      }
    }
    return { bits, ink, total: (inner * 2 + 1) ** 2 };
  });

  signatures.forEach((sig, i) => {
    const letter = 'ABCDE'[i];
    const ratio = sig.ink / sig.total;
    check(
      `${letter} — 원 안에 획이 그려졌다 (잉크 ${(ratio * 100).toFixed(1)}%)`,
      ratio > 0.04,
      '빈 원이다 — 글자가 아예 안 그려졌다',
    );
    check(
      `${letter} — 원을 까맣게 칠하지 않았다`,
      ratio < 0.7,
      `잉크 ${(ratio * 100).toFixed(1)}% — 글자가 아니라 덩어리다`,
    );
  });

  const dupes = [];
  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      if (signatures[i].bits === signatures[j].bits) dupes.push(`${'ABCDE'[i]}=${'ABCDE'[j]}`);
    }
  }
  check(
    '다섯 글자가 서로 다르게 그려진다(두부·빈 원이면 여기서 깨진다)',
    dupes.length === 0,
    `같은 모양: ${dupes.join(', ')}`,
  );
}

if (failed > 0) {
  console.error(`\n실패 ${failed}건`);
  process.exit(1);
}
console.log('\n전부 통과');

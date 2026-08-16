/**
 * 지운 라벨 자리에 A·B·C 표식을 찍는다 — "이미지를 봐야 풀리는" 문항을 만들기 위해.
 *
 * 왜 필요한가 (2026-08-16)
 * ──────────────────────
 * 이미지형의 정의는 "이미지를 판독해야 풀 수 있는 문제"인데, 실제로 나온 문항은
 * 이랬다.
 *
 *   "다음은 대뇌 신피질의 조직학적 소견을 나타내는 그림이다. 이 소견에서 관찰될 수
 *    있는 뉴런 세포층에 대한 설명으로 옳은 것은?"
 *   선지: I층은 …이다 / II층은 …이다 / III층은 …이다 / …
 *
 * 그림을 가리지 않고 풀 수 있다. 대뇌피질 6층의 교과서 지식만 있으면 된다.
 *
 * 구조적인 원인이 있다. 정제 단계(lib/extract/mask-text.ts)는 그림 속 글자를 전부
 * **정답 단서**로 보고 지운다. 그래서 학생에게 도착한 그림에는 **가리킬 것이 하나도
 * 남지 않는다.** 가리킬 대상이 없으니 발문은 "이 그림에 대한 설명으로 옳은 것은?"
 * 수준으로 후퇴할 수밖에 없다.
 *
 * 여기서 하는 일은 그 반대다. 지운 라벨의 **좌표는 알고 있으므로**, 그 자리에 A·B·C
 * 표식을 찍고 "A = 원래 거기 적혀 있던 라벨"이라는 대응표를 생성 모델에게만 넘긴다.
 * 그러면 "A로 표시된 세포층은?" 처럼 **그림을 보지 않으면 풀 수 없는** 문항이 나온다.
 * 정답 단서(라벨 글자)는 여전히 지워진 채다 — 지우는 것과 가리키는 것을 동시에 얻는다.
 *
 * 설계 제약
 * ────────
 *  1) 표식 글자는 A~E 만 쓴다. 정제 후 잔존 텍스트 검사(readResidualText)가
 *     isShortFigureLabel() 로 A~E·1~9 를 이미 제외하므로, 그 범위를 벗어나면
 *     우리가 찍은 표식 때문에 이미지가 "글자 남음"으로 폐기된다.
 *  2) 표식은 지운 자리 안에 앉힌다. 그림 픽셀 위에 새로 얹는 면적을 최소화한다.
 *  3) 라벨처럼 보이지 않는 것(캡션·제목·단위·문장)은 표식으로 만들지 않는다.
 *     잘못 찍으면 가리키는 대상이 없는 표식이 되고, 그걸 물어보는 문항은 풀 수 없다.
 *  4) 대응표의 라벨은 OCR 결과다 — 오독일 수 있다. 생성 모델에게는 원본(라벨이 살아
 *     있는) 이미지도 함께 주므로, 대응표가 그림과 어긋나면 그 표식을 쓰지 말라고
 *     프롬프트에서 지시한다.
 */

// 타입 전용 import 는 `node --experimental-strip-types` 가 지워 버리므로, 이 파일을
// 의존성 없이 두는 원칙(아래 isShortFigureLabel 주석 참고)을 깨지 않는다.
import type { CanvasRenderingContext2D } from 'canvas';

/**
 * 짧은 단독 라벨(A, 1, ①, Ⅲ) 판정.
 *
 * lib/extract/mask-text.ts 의 isShortFigureLabel() 과 같은 규칙을 **의도적으로 복제**했다.
 * 이 모듈을 의존성 없는 파일로 두어야 scripts/check-image-markers.mjs 가
 * `node --experimental-strip-types` 로 그대로 불러올 수 있다(확장자 없는 상대 import 는
 * 그 로더가 해석하지 못한다). lib/ai/kmle-format.ts 를 의존성 없이 둔 것과 같은 이유다.
 * 규칙을 바꾸면 두 곳을 함께 고친다 — 검사 스크립트가 두 구현의 일치를 검증한다.
 *
 * 여기서는 "덮인 자리"만 후보로 받는데, 짧은 라벨은 mask-text 가 보존하므로 원래 덮이지
 * 않는다. 다만 "Type A" 처럼 구절의 일부로 함께 덮인 조각은 여기까지 올라온다 —
 * 그건 구조 이름이 아니라 조각이므로 표식으로 만들면 안 된다.
 */
export function isShortFigureLabel(raw: string): boolean {
  const t = (raw ?? '').trim();
  if (!t) return false;
  const core = t.replace(/[()[\]{}.,:;·、。\s]/g, '');
  if (core.length === 0 || core.length > 2) return false;
  return (
    /^[A-Ea-e]$/.test(core) ||
    /^[1-9]$/.test(core) ||
    /^[①-⑩]$/.test(core) ||
    /^[ⅠⅡⅢⅣⅤ]$/.test(core) ||
    /^[가나다라마]$/.test(core)
  );
}

/** 표식으로 만들 후보 — maskTextRegions 가 실제로 덮은 사각형. */
export interface MarkerSource {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 그림에 찍힌 표식 하나와, 원래 그 자리에 있던 라벨. */
export interface PlacedMarker {
  /** A~E */
  letter: string;
  /** 원본 라벨 텍스트(OCR). 생성 모델에게만 전달한다 — 학생 화면에는 없다. */
  label: string;
}

export interface AnnotateResult {
  png: Uint8Array;
  markers: PlacedMarker[];
}

/** 표식 글자. isShortFigureLabel() 이 통과시키는 A~E 로 제한한다(설계 제약 1). */
const MARKER_LETTERS = ['A', 'B', 'C', 'D', 'E'] as const;

/**
 * 라벨로 보지 않는 텍스트 — 캡션·제목·출처·단위 축약.
 *
 * 한글 캡션에 \b 를 쓰면 안 된다. JS 의 \b 는 [A-Za-z0-9_] 기준이라 "그림 1" 의
 * "림"과 공백 사이에는 경계가 없어 규칙이 통째로 죽는다(자기 검사에서 걸렸다).
 * 대신 "캡션어 + 번호"로 끝나는 형태만 잡아 "그림자세포" 같은 실제 구조명은 살린다.
 */
const NON_LABEL_PATTERNS: RegExp[] = [
  /^(?:fig(?:ure)?|table|chart|source|ref)\b/i,
  /^(?:그림|사진|표|도표|출처|자료)\s*[\d.]*$/,
  /^\d+(?:\.\d+)?\s*(?:%|mm|cm|µm|um|nm|px|kg|mg|mL|ml|초|분|시간)?$/i, // 순수 수치·단위
  /^[·•\-–—*]+$/,
  /^(?:copyright|©|all rights reserved)/i,
];

/** 한 그림에 찍는 표식 수 상한. A~E 로 제한되므로 5 를 넘길 수 없다. */
export const MAX_MARKERS_PER_IMAGE = MARKER_LETTERS.length;

/**
 * 라벨 텍스트가 "가리킬 대상이 있는 이름"인지.
 *
 * 문장·설명은 제외한다. 그런 것은 그림 안의 주석이지 구조 이름이 아니라서,
 * 표식으로 바꾸면 "A로 표시된 것은?"에 답할 수가 없다.
 */
export function looksLikeStructureLabel(raw: string): boolean {
  const t = String(raw ?? '').trim();
  if (!t) return false;
  // 짧은 패널 라벨(A, 1, ①)은 애초에 지워지지 않고 남는다 — 표식 후보가 아니다.
  if (isShortFigureLabel(t)) return false;

  const core = t.replace(/[()[\]{}]/g, '').trim();
  if (core.length < 2 || core.length > 28) return false;
  if (NON_LABEL_PATTERNS.some((re) => re.test(core))) return false;
  // 글자(한글·라틴)가 하나도 없으면 이름이 아니다.
  if (!/[\p{Script=Hangul}A-Za-z]/u.test(core)) return false;
  // 문장은 제외 — 종결어미·문장부호가 있으면 설명문이다.
  if (/[.!?]\s*$/.test(core) && !/^[A-Za-z]{1,4}\.$/.test(core)) return false;
  if (/(?:다|요|음)\s*[.!?]?$/.test(core) && /[\p{Script=Hangul}]/u.test(core)) {
    // "…를 형성한다", "…이다" 같은 서술은 제외. 단 "세포막"처럼 '막/포/음'으로 끝나는
    // 명사를 잘라내지 않도록 2음절 이하 한글 단어는 통과시킨다.
    if (core.replace(/\s/g, '').length > 3) return false;
  }
  // 단어 수 상한 — "Layer of pyramidal cells"(4단어)까지 허용한다.
  if (core.split(/\s+/).length > 4) return false;
  return true;
}

/**
 * 덮인 영역 중 표식으로 바꿀 것을 고른다.
 *
 * 읽기 순서(위→아래, 왼→오른쪽)로 A·B·C 를 매겨, 학생이 그림을 훑는 순서와
 * 표식 순서가 맞게 한다.
 */
export function selectMarkerSources(
  regions: MarkerSource[],
  imageWidth: number,
  imageHeight: number,
  limit: number = MAX_MARKERS_PER_IMAGE,
): MarkerSource[] {
  if (regions.length === 0 || imageWidth <= 0 || imageHeight <= 0) return [];

  const minSide = Math.min(imageWidth, imageHeight);
  const candidates = regions.filter((r) => {
    if (!looksLikeStructureLabel(r.text)) return false;
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    if (w <= 0 || h <= 0) return false;
    // 폭이 그림의 절반을 넘으면 캡션·제목 줄이다 — 가리키는 구조가 없다.
    if (w > imageWidth * 0.45) return false;
    // 덮인 자리가 표식을 앉히기에 너무 작으면(글자가 아주 작은 그림) 건너뛴다.
    if (h < Math.max(6, minSide * 0.015)) return false;
    return true;
  });

  // 같은 이름이 여러 번 나오면 한 번만 표식으로 쓴다(둘 다 A 가 될 수는 없고,
  // 서로 다른 글자를 주면 정답이 둘이 되는 문항이 된다).
  const seen = new Set<string>();
  const deduped: MarkerSource[] = [];
  for (const r of candidates) {
    const key = r.text.trim().toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  // 읽기 순서: 같은 줄로 볼 만큼 y 가 가까우면 x 를 먼저 본다.
  const rowTolerance = minSide * 0.06;
  deduped.sort((a, b) => {
    const ay = (a.y0 + a.y1) / 2;
    const by = (b.y0 + b.y1) / 2;
    if (Math.abs(ay - by) > rowTolerance) return ay - by;
    return a.x0 - b.x0;
  });

  // 표식끼리 겹치지 않게 최소 간격을 둔다.
  const minGap = minSide * 0.08;
  const placed: MarkerSource[] = [];
  for (const r of deduped) {
    if (placed.length >= limit) break;
    const cx = (r.x0 + r.x1) / 2;
    const cy = (r.y0 + r.y1) / 2;
    const tooClose = placed.some((p) => {
      const px = (p.x0 + p.x1) / 2;
      const py = (p.y0 + p.y1) / 2;
      return Math.hypot(cx - px, cy - py) < minGap;
    });
    if (tooClose) continue;
    placed.push(r);
  }
  return placed;
}

/**
 * 표식 글자를 **선분과 호로 직접 그린다.** 폰트를 쓰지 않는다.
 *
 * 운영 사고(2026-08-16, 첫 배포분): `ctx.fillText(letter, …)` 에 `sans-serif` 를 썼는데
 * Vercel 리눅스 런타임에는 node-canvas 가 쓸 시스템 폰트가 없어서 **모든 표식이 두부
 * (□)로 나갔다.** 원과 테두리는 우리가 직접 그리니 멀쩡했고 글자만 사라져서, 화면에는
 * "빈 동그라미"로 보였다. 개발 맥에는 폰트가 있어 로컬에서는 정상으로 보였다.
 *
 * 저장소에 `public/fonts/NotoSansKR-Variable.ttf` 가 있고 infographic-text-repair.ts 가
 * `registerFont` 로 쓰지만, 여기서는 쓰지 않는다.
 *   - 라틴 대문자 5글자를 위해 10 MB 가변 폰트를 콜드스타트마다 로드하게 된다.
 *   - `process.cwd()/public/` 이 서버리스 번들에 실리는지에 의존하게 되는데, 지금 깨진
 *     것이 정확히 "런타임에 파일이 없어서" 계열이다. 같은 종류의 의존을 새로 만들 이유가 없다.
 * 다섯 글자는 선분·호로 그리면 폰트 의존이 **아예 없어지고** 결과가 결정적이다.
 *
 * 획으로만 그린다(채우기 없음). 작은 크기에서도 형태가 뭉개지지 않는다.
 */
function drawMarkerGlyph(
  ctx: CanvasRenderingContext2D,
  letter: string,
  cx: number,
  cy: number,
  r: number,
): void {
  const h = r * 1.1; // 글자 높이 — 원 안에 여백을 남긴다
  const w = h * 0.78; // 글자 폭
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;

  // 획 두께. 0.2r 은 B 의 보울 속을 메워 검은 덩어리로 만들었다(육안 확인) — 조인다.
  ctx.lineWidth = Math.max(1.4, r * 0.16);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111111';
  ctx.beginPath();

  switch (letter) {
    case 'A':
      ctx.moveTo(x0, y1);
      ctx.lineTo(cx, y0);
      ctx.lineTo(x1, y1);
      // 가로대는 아래쪽 1/3 지점
      ctx.moveTo(x0 + w * 0.18, y1 - h * 0.33);
      ctx.lineTo(x1 - w * 0.18, y1 - h * 0.33);
      break;
    case 'B':
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0, y1);
      // 위·아래 보울. 반지름 h/4 짜리 반원으로 그렸더니 획 두께에 속이 메워져
      // 검은 덩어리가 됐다 — 글자 폭 전체를 쓰는 곡선으로 그린다.
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(x1, y0, x1, cy, x0, cy);
      ctx.moveTo(x0, cy);
      ctx.bezierCurveTo(x1, cy, x1, y1, x0, y1);
      break;
    case 'C':
      // 오른쪽이 트인 호 — 50°에서 시계방향으로 310°까지(아래→왼쪽→위)
      ctx.arc(cx, cy, h / 2, Math.PI * 0.28, Math.PI * 1.72);
      break;
    case 'D':
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0, y1);
      ctx.moveTo(x0, y0);
      ctx.arc(x0, cy, h / 2, -Math.PI / 2, Math.PI / 2);
      break;
    case 'E':
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0, y1);
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y0);
      ctx.moveTo(x0, cy);
      ctx.lineTo(x1 - w * 0.15, cy); // 가운데 가로대는 조금 짧게
      ctx.moveTo(x0, y1);
      ctx.lineTo(x1, y1);
      break;
    default:
      // MARKER_LETTERS 밖의 글자는 오지 않는다. 와도 빈 원으로 두지 않고 점을 찍어
      // "표식은 있는데 글자가 없는" 상태(= 이번 사고의 증상)를 만들지 않는다.
      ctx.moveTo(cx - w * 0.3, cy);
      ctx.lineTo(cx + w * 0.3, cy);
      break;
  }
  ctx.stroke();
}

/**
 * 고른 자리에 A·B·C 표식을 그린다.
 *
 * 흰 원 + 검은 테두리 + 검은 글자로 통일한다. 밝은 해부도와 어두운 영상(X선·초음파)
 * 양쪽에서 읽히는 조합이라 배경색을 판정할 필요가 없다.
 *
 * canvas 는 서버(node) 전용이라 동적 import 한다. 실패하면 원본을 그대로 돌려주고
 * markers 를 비운다 — 표식을 못 찍었는데 대응표만 넘기면 존재하지 않는 표식을
 * 가리키는 문항이 만들어진다.
 */
export async function annotateMarkers(
  png: Uint8Array,
  sources: MarkerSource[],
): Promise<AnnotateResult> {
  if (sources.length === 0) return { png, markers: [] };

  try {
    const { createCanvas, loadImage } = await import('canvas');
    const img = await loadImage(Buffer.from(png));
    const W = img.width;
    const H = img.height;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const minSide = Math.min(W, H);
    const markers: PlacedMarker[] = [];

    sources.slice(0, MARKER_LETTERS.length).forEach((src, i) => {
      const letter = MARKER_LETTERS[i];
      const boxH = Math.max(1, src.y1 - src.y0);
      // 지운 자리 높이에 맞추되(설계 제약 2), 그림 크기 대비 최소·최대 크기를 둔다.
      //
      // 하한을 8px → 10px, 비율 하한을 2 % → 2.5 % 로 올렸다. 운영 첫 배포분에서
      // 표식이 육안으로 너무 작았다(넓은 모식도의 작은 라벨 자리는 boxH 가 작아
      // 반지름이 하한에 걸린다). 표식이 지운 자리를 조금 넘어가는 것은 허용한다 —
      // 실제 시험 그림의 표식도 그렇고, 읽히지 않는 표식은 없는 것과 같다.
      const r = Math.round(
        Math.max(
          Math.max(10, minSide * 0.025),
          Math.min(boxH * 0.9, minSide * 0.055),
        ),
      );
      // 테두리가 잘리지 않게 가장자리에서 안쪽으로 밀어 넣는다.
      const cx = Math.round(Math.min(W - r - 2, Math.max(r + 2, (src.x0 + src.x1) / 2)));
      const cy = Math.round(Math.min(H - r - 2, Math.max(r + 2, (src.y0 + src.y1) / 2)));

      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = Math.max(2, Math.round(r * 0.16));
      ctx.strokeStyle = '#111111';
      ctx.stroke();

      drawMarkerGlyph(ctx, letter, cx, cy, r);

      markers.push({ letter, label: src.text.trim() });
    });

    if (markers.length === 0) return { png, markers: [] };
    return { png: new Uint8Array(canvas.toBuffer('image/png')), markers };
  } catch {
    // 표식을 못 찍었으면 대응표도 넘기지 않는다(없는 표식을 가리키는 문항 방지).
    return { png, markers: [] };
  }
}

/**
 * 발문이 표식(A·B·C)을 가리키는지.
 *
 * 왜 필요한가: "A로 표시된 세포층은?" 같은 발문에는 "그림", "사진", "다음" 같은 단어가
 * 하나도 없다. private-generation.ts 의 기존 그림 참조 판정(IMAGE_DEPENDENT_STEM_RE /
 * FIGURE_DECLARATION_RE)은 전부 그림 명사에 걸려 있어서 이 형태를 **하나도 못 잡는다.**
 * 그대로 두면 이미지가 정제 실패로 빠졌을 때 표식 문항이 그림 없이 살아남아, 학생에게
 * 가리킬 대상이 없는 문항이 나간다(그리고 그건 오류를 내지 않는다).
 *
 * "A형 간염", "B형 위축" 처럼 글자가 분류명으로 쓰인 경우를 잡지 않도록 **가리키는
 * 서술어(표시·가리키·지시)가 뒤따를 때만** 참으로 본다.
 *
 * "해당하는"은 일부러 뺐다. "비타민 C에 해당하는 것은?" 같은 멀쩡한 텍스트 문항이
 * 걸리는데, 오탐의 대가가 **문항 삭제**라 비싸다. 대신 프롬프트에서 표식 문항은
 * "…로 표시된" 형태로 쓰도록 못박아 표현을 좁혔다.
 */
const MARKER_REFERENCE_RE =
  /(?:(?<![A-Za-z])[A-E]\s*(?:로|으로|에|가|이|는|은)?\s*(?:표시(?:된|한|되어|하는|되는)|가리키(?:는|고)|지시(?:된|하는))|(?:표식|표시)\s*[A-E](?![A-Za-z]))/;

export function stemReferencesMarker(stem: string): boolean {
  return MARKER_REFERENCE_RE.test(String(stem ?? ''));
}

/**
 * 생성 모델에게 넘길 표식 안내문.
 *
 * 학생 화면에는 이 대응표가 없다. 모델만 보고 정답을 정하는 데 쓴다.
 */
export function buildMarkerLegend(imageIndex: number, markers: PlacedMarker[]): string {
  if (markers.length === 0) return '';
  const list = markers.map((m) => `${m.letter} = ${m.label}`).join(' / ');
  return (
    `[이미지 ${imageIndex}] 표식 안내(학생에게는 보이지 않음): ` +
    `학생이 보는 그림에는 원본 라벨 글자가 지워지고 그 자리에 흰 원 표식이 찍혀 있습니다. ` +
    `${list}. ` +
    `이 표식을 가리켜 "A로 표시된 …" 형태로 물으면 그림을 봐야만 풀 수 있는 문항이 됩니다. ` +
    `발문·선지·해설에 위 라벨 원문(${markers.map((m) => m.label).join(', ')})을 그대로 적으면 ` +
    `정답이 노출되므로 쓰지 마세요. ` +
    `표식 안내가 그림과 어긋나 보이면 그 표식은 쓰지 마세요.`
  );
}

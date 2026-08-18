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
      // 보울을 반지름 h/2 반원으로 그렸더니 폭이 0.5h 에 그쳐(다른 글자는 0.78h) 좁고
      // 왼쪽으로 치우친 "찌그러진 D"가 됐다(운영 이미지 8배 확대로 확인).
      // 제어점을 글자 폭 밖으로 빼서 보울이 x1 까지 닿게 한다(3차 베지에의 최대 도달점은
      // 제어점 거리의 3/4 이라 w + w/3 을 주면 정확히 w 만큼 나간다).
      ctx.moveTo(x0, y0);
      ctx.bezierCurveTo(x1 + w / 3, y0, x1 + w / 3, y1, x0, y1);
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

/** 표식에서 대상까지의 지시선 탐색 결과. */
type Designation =
  | { kind: 'anchored' } // 원본 그림의 지시선·브래킷이 이 자리에 붙어 있다 — 기호 필수
  | { kind: 'adjacent' } // 표식이 이미 대상에 닿아 있다 — 선이 필요 없다
  | { kind: 'line'; angle: number; dist: number } // 지시선을 그린다
  | { kind: 'none' }; // 가리킬 것을 못 찾았거나 방향이 모호하다 — 표식을 찍지 않는다

/**
 * 지운 라벨 자리에 원본 그림의 **지시선·브래킷이 붙어 있는지** 본다.
 *
 * 왜 필요한가(2026-08-18 운영 지적): 정제는 글자만 지우고 선은 남긴다. 그런데 표식을
 * "문항이 물을 때만" 찍도록 바꾸자(#225), 라벨이 지워진 지시선이 **가리키는 것 없는 맨
 * 선**으로 남았다. 뇌 사진에 선 3개가 허공을 가리키고, 대뇌 겉질 그림의 층 브래킷에는
 * 아무 표시도 없었다.
 *
 * 원본에 지시선이 있다는 것은 **그 자리에 이름표가 있어야 한다는 뜻**이다. 그래서
 * 지시선이 붙은 라벨 자리에는 문항이 묻든 말든 기호를 반드시 찍는다.
 *
 * 판정: 라벨 상자 가장자리 가까이에서 시작해 바깥으로 뻗는 **가늘고 긴** 잉크를 찾는다.
 * 가늘어야(수직 두께가 얇아야) 선이고, 두꺼우면 그림 덩어리다.
 */
function hasAttachedPointer(
  isContent: (x: number, y: number) => boolean,
  src: MarkerSource,
  W: number,
  H: number,
): boolean {
  const midX = Math.round((src.x0 + src.x1) / 2);
  const midY = Math.round((src.y0 + src.y1) / 2);
  const boxH = Math.max(1, src.y1 - src.y0);
  // 선은 라벨 바로 옆에서 시작한다. 너무 멀리서 찾으면 옆 그림을 선으로 오인한다.
  const gapMax = Math.max(6, Math.round(boxH * 0.8));
  const runMin = Math.max(10, Math.round(boxH * 0.9));
  const thickMax = Math.max(3, Math.round(boxH * 0.45));

  const dirs: Array<[number, number, number, number]> = [
    // [dx, dy, 시작 x, 시작 y] — 좌·우·상·하
    [-1, 0, src.x0, midY],
    [1, 0, src.x1, midY],
    [0, -1, midX, src.y0],
    [0, 1, midX, src.y1],
  ];

  for (const [dx, dy, sx, sy] of dirs) {
    // 선을 만날 때까지의 빈틈
    let start = -1;
    for (let g = 1; g <= gapMax; g++) {
      const x = sx + dx * g;
      const y = sy + dy * g;
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) break;
      if (isContent(x, y)) {
        start = g;
        break;
      }
    }
    if (start < 0) continue;

    // 이어지는 길이
    let run = 0;
    let miss = 0;
    for (let d = start; d < start + runMin * 3; d++) {
      const x = sx + dx * d;
      const y = sy + dy * d;
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) break;
      if (isContent(x, y)) {
        run = d - start + 1;
        miss = 0;
      } else if (++miss > 2) break; // 점선도 받아들인다
    }
    if (run < runMin) continue;

    // 두께 — 선이면 얇다. 진행 방향의 수직으로 재 본다.
    const px = dx === 0 ? 1 : 0;
    const py = dx === 0 ? 0 : 1;
    const probe = Math.round(start + run / 2);
    let thick = 0;
    for (let t = -thickMax - 2; t <= thickMax + 2; t++) {
      const x = sx + dx * probe + px * t;
      const y = sy + dy * probe + py * t;
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
      if (isContent(x, y)) thick += 1;
    }
    if (thick > 0 && thick <= thickMax) return true;
  }
  return false;
}

/**
 * 표식이 무엇을 가리키는지 찾는다.
 *
 * 왜 필요한가(2026-08-16 운영 지적): 원본 그림의 라벨이 **지시선 없이 위치만으로**
 * 구조를 가리키는 경우가 많다. 글자를 지우고 그 자리에 표식을 놓으면 배경 위에 동그라미가
 * 떠 있게 되어 "A가 무엇을 지칭하는지 분명하지 않다"가 된다.
 *
 * 라벨이 있던 자리에서 사방으로 광선을 쏴 가장 가까운 "그림 요소"를 찾는다. 방향이 한쪽으로
 * 모이면 그쪽으로 지시선을 긋고, 사방에 흩어져 있으면(= 무엇을 가리키는지 특정 불가)
 * 표식을 아예 찍지 않는다. **애매한 표식은 없느니만 못하다.**
 */
function findDesignation(
  isContent: (x: number, y: number) => boolean,
  cx: number,
  cy: number,
  r: number,
  W: number,
  H: number,
): Designation {
  const maxDist = Math.round(Math.min(W, H) * 0.3);
  const hits: Array<{ angle: number; dist: number }> = [];
  for (let deg = 0; deg < 360; deg += 4) {
    const a = (deg * Math.PI) / 180;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    for (let d = r + 2; d <= maxDist; d += 2) {
      const x = Math.round(cx + dx * d);
      const y = Math.round(cy + dy * d);
      if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) break;
      if (isContent(x, y)) {
        hits.push({ angle: a, dist: d });
        break;
      }
    }
  }
  if (hits.length === 0) return { kind: 'none' };

  const minDist = Math.min(...hits.map((h) => h.dist));
  // 이미 대상 위/옆에 있으면 선을 그으면 오히려 그림을 가린다.
  if (minDist <= r * 1.3) return { kind: 'adjacent' };

  // 최단 거리에 가까운 방향들이 한쪽으로 모이는지(원형 분산)를 본다.
  // 사방이 다 비슷하게 가까우면 무엇을 가리키는지 정할 수 없다.
  const near = hits.filter((h) => h.dist <= minDist * 1.25);
  let sx = 0;
  let sy = 0;
  for (const h of near) {
    sx += Math.cos(h.angle);
    sy += Math.sin(h.angle);
  }
  const concentration = Math.hypot(sx, sy) / near.length;
  if (concentration < 0.7) return { kind: 'none' };

  return { kind: 'line', angle: Math.atan2(sy, sx), dist: minDist };
}

/**
 * 표식에서 대상까지 지시선을 긋는다.
 *
 * 어두운 영상(X선·초음파)에서도 보이게 흰 테두리를 깔고 그 위에 검은 선을 얹는다.
 * 끝에는 작은 화살촉을 달아 방향을 분명히 한다.
 */
function drawLeaderLine(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  angle: number,
  dist: number,
): void {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const x0 = cx + dx * (r + 1);
  const y0 = cy + dy * (r + 1);
  // 대상에 닿기 직전에서 멈춘다 — 그림을 덮지 않게.
  const end = Math.max(r + 4, dist - 3);
  const x1 = cx + dx * end;
  const y1 = cy + dy * end;

  const w = Math.max(1.2, r * 0.14);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // 흰 테두리(어두운 배경 대비)
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = w * 2.6;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  ctx.strokeStyle = '#111111';
  ctx.lineWidth = w;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  // 화살촉
  const head = Math.max(3, r * 0.42);
  for (const s of [1, -1]) {
    const a = angle + s * 2.5;
    ctx.moveTo(x1, y1);
    ctx.lineTo(x1 + Math.cos(a) * head, y1 + Math.sin(a) * head);
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
  options: {
    /**
     * true 면 **필수 기호만** 찍는다 — 원본 그림의 지시선·브래킷이 붙어 있어서
     * 이름표가 없으면 그 선이 허공을 가리키게 되는 자리.
     * 문항이 표식을 묻지 않는 경우에 쓰는 판이다.
     */
    onlyRequired?: boolean;
  } = {},
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

    // ── 배경색 추정 + "그림 요소" 판정
    //
    // 표식이 무엇을 가리키는지 찾으려면 배경과 그림을 갈라야 한다. 배경은 테두리 픽셀의
    // 최빈색(8단계 양자화)으로 잡는다 — 강의록 그림은 대개 바깥이 배경이다.
    // 판정 문턱을 낮게 잡으면 종이 질감·연한 워터마크가 그림으로 잡혀 지시선이 엉뚱한
    // 곳을 가리키므로 넉넉히 둔다.
    const frame = ctx.getImageData(0, 0, W, H).data;
    const bucket = new Map<string, { c: [number, number, number]; n: number }>();
    const sampleBorder = (x: number, y: number) => {
      const o = (y * W + x) * 4;
      const c: [number, number, number] = [frame[o], frame[o + 1], frame[o + 2]];
      const key = `${c[0] >> 5}_${c[1] >> 5}_${c[2] >> 5}`;
      const cur = bucket.get(key);
      if (cur) cur.n += 1;
      else bucket.set(key, { c, n: 1 });
    };
    for (let x = 0; x < W; x += 2) {
      sampleBorder(x, 0);
      sampleBorder(x, H - 1);
    }
    for (let y = 0; y < H; y += 2) {
      sampleBorder(0, y);
      sampleBorder(W - 1, y);
    }
    let bg: [number, number, number] = [255, 255, 255];
    let best = 0;
    for (const { c, n } of bucket.values()) {
      if (n > best) {
        best = n;
        bg = c;
      }
    }
    const CONTENT_DELTA = 70;
    const isContent = (x: number, y: number): boolean => {
      // 낱개 픽셀(잡티·질감)은 그림으로 보지 않는다 — 3x3 안에 여러 개가 모여야 한다.
      let hit = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const o = ((y + dy) * W + (x + dx)) * 4;
          const d =
            Math.abs(frame[o] - bg[0]) + Math.abs(frame[o + 1] - bg[1]) + Math.abs(frame[o + 2] - bg[2]);
          if (d > CONTENT_DELTA) hit += 1;
        }
      }
      return hit >= 5;
    };

    // 지시선은 원보다 **먼저** 그린다(선 끝이 글자를 가로지르지 않게).
    // 그리기 전에 모든 표식의 지시 대상을 원본 픽셀로 계산해 둔다 — 먼저 그린 표식이
    // 다음 표식의 "그림 요소" 판정을 오염시키지 않게.
    const placements = sources.slice(0, MARKER_LETTERS.length).map((src) => {
      const boxH = Math.max(1, src.y1 - src.y0);
      // 지운 자리 높이에 맞추되(설계 제약 2), 그림 크기 대비 최소·최대 크기를 둔다.
      // 하한 8px→10px, 비율 하한 2 %→2.5 %: 첫 배포분에서 표식이 육안으로 너무 작았다
      // (넓은 모식도의 작은 라벨 자리는 boxH 가 작아 반지름이 하한에 걸린다).
      // 지운 자리를 조금 넘어가는 것은 허용한다 — 읽히지 않는 표식은 없는 것과 같다.
      const r = Math.round(
        Math.max(Math.max(10, minSide * 0.025), Math.min(boxH * 0.9, minSide * 0.055)),
      );
      const cx = Math.round(Math.min(W - r - 2, Math.max(r + 2, (src.x0 + src.x1) / 2)));
      const cy = Math.round(Math.min(H - r - 2, Math.max(r + 2, (src.y0 + src.y1) / 2)));
      // 원본 지시선이 붙어 있으면 기호는 **선택이 아니라 필수**다.
      const anchored = hasAttachedPointer(isContent, src, W, H);
      const designation: Designation = anchored
        ? { kind: 'anchored' }
        : findDesignation(isContent, cx, cy, r, W, H);
      return { src, r, cx, cy, designation, required: anchored };
    });

    // 가리킬 것을 못 찾은 표식은 아예 찍지 않는다 — 애매한 표식은 없느니만 못하다.
    const usable = placements.filter(
      (p) => p.designation.kind !== 'none' && (!options.onlyRequired || p.required),
    );
    for (const p of usable) {
      if (p.designation.kind === 'line') {
        drawLeaderLine(ctx, p.cx, p.cy, p.r, p.designation.angle, p.designation.dist);
      }
    }

    usable.forEach((p, i) => {
      const letter = MARKER_LETTERS[i];
      const { r, cx, cy, src } = p;
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

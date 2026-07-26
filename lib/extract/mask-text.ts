/**
 * 이미지 속 텍스트를 "덮어서" 지운다 (생성형 인페인팅 대체).
 *
 * 왜 바꿨나
 * ─────────
 * 종전에는 Gemini 이미지 편집 모델에 "글자를 지워라"라고 요청했다. 그 모델은 이미지를
 * 재생성하므로 해부도·모식도에서 라벨을 새로 그려 넣었고, 실측에서 4장 중 3장이
 * 정제 후 글자가 오히려 늘어(11→32, 26→112, 28→115, 44→176자) 폐기됐다.
 * 장당 19~20초를 쓰고 결과는 버린 셈이다.
 *
 * 여기서는 OCR 이 알려준 좌표만 배경색으로 덮는다. 그림 픽셀은 건드리지 않으므로
 * 삽화가 원형 그대로 보존되고, 처리 시간은 장당 수 밀리초다.
 *
 * 설계 원칙(사용자 확인)
 * ─────────────────────
 *  1) 배경색과 같은 색으로 덮는다 — 글자 박스 바깥 링에서 색을 샘플링(중앙값).
 *  2) 글자 크기에 딱 맞는 최소 크기로 덮는다 — OCR 박스를 실제 글자 픽셀 범위로 축소.
 *  3) 짧은 단독 라벨(A~E, 1~5, ①~⑤ 등)은 남긴다 — 그림의 일부이자 문항이 가리키는
 *     대상이라 지우면 "B에 해당하는 것은?" 같은 문항을 풀 수 없다.
 *  4) 그림을 글자로 오인해 지우지 않는다 — 프로토타입 1차에서 삽화가 통째로 지워졌다.
 *     크기·잉크 밀도 가드로 막는다.
 */

export interface MaskBox {
  text: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MaskTextOptions {
  /** 글자 박스 주변 최소 여유(px). 좌표 오차·안티에일리어싱을 덮는다. */
  pad?: number;
  /** 박스 높이 대비 추가 여유 비율(작은 글자일수록 절대 여백이 작아지게). */
  padRatio?: number;
  /**
   * 박스가 이미지 면적의 이 비율을 넘으면 텍스트로 보지 않는다.
   * 실측 교훈: 예전엔 높이 10%·너비 35% 로 좁게 잡아 여러 줄 주석·넓은 캡션이
   * 통째로 걸러졌고(too_large 4건) 강의록 인쇄 텍스트가 그대로 남았다.
   * 모델이 준 박스는 실제 텍스트에 붙어 있으므로 "명백히 이상한 경우"만 막는다.
   */
  maxAreaRatio?: number;
}

export interface MaskTextResult {
  png: Uint8Array;
  /** 실제로 덮은 박스 수. */
  masked: number;
  /** 규칙에 따라 남긴 박스 수(짧은 라벨 보존 + 그림 오인 방지). */
  kept: number;
  /** 남긴 이유별 개수 — 진단용. */
  keptReasons: Record<string, number>;
}

/**
 * 그림의 일부로 봐야 하는 "짧은 단독 라벨"인지.
 * 예: A, B, (C), D., 1, 2), ①, Ⅲ — 지우면 문항이 가리킬 대상이 사라진다.
 * 반대로 "Aortic dissection", "hematoma생기면 …" 같은 설명은 정답 단서라 지운다.
 */
export function isShortFigureLabel(raw: string): boolean {
  const t = (raw ?? '').trim();
  if (!t) return false;
  // 괄호·마침표 같은 장식 제거 후 남는 알맹이로 판단
  const core = t.replace(/[()[\]{}.,:;·、。\s]/g, '');
  if (core.length === 0 || core.length > 2) return false;
  return (
    /^[A-Ea-e]$/.test(core) ||            // A~E (패널 라벨 관례)
    /^[1-9]$/.test(core) ||               // 1~9
    /^[①-⑩]$/.test(core) ||               // 원문자
    /^[ⅠⅡⅢⅣⅤ]$/.test(core) ||            // 로마자
    /^[가나다라마]$/.test(core)            // 한글 항목 라벨
  );
}

/**
 * OCR 박스를 배경색으로 덮어 텍스트를 제거한다.
 * canvas 는 서버(node) 전용이라 동적 import 한다.
 */
export async function maskTextRegions(
  png: Uint8Array,
  boxes: MaskBox[],
  options: MaskTextOptions = {},
): Promise<MaskTextResult> {
  const pad = options.pad ?? 2;
  const padRatio = options.padRatio ?? 0.08;
  const maxAreaRatio = options.maxAreaRatio ?? 0.6;

  const keptReasons: Record<string, number> = {};
  const keep = (reason: string) => {
    keptReasons[reason] = (keptReasons[reason] ?? 0) + 1;
  };

  if (boxes.length === 0) {
    return { png, masked: 0, kept: 0, keptReasons };
  }

  const { createCanvas, loadImage } = await import('canvas');
  const img = await loadImage(Buffer.from(png));
  const W = img.width;
  const H = img.height;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);

  const frame = ctx.getImageData(0, 0, W, H).data;
  const at = (x: number, y: number): [number, number, number] => {
    const o = (y * W + x) * 4;
    return [frame[o], frame[o + 1], frame[o + 2]];
  };
  const lum = ([r, g, b]: [number, number, number]) => 0.299 * r + 0.587 * g + 0.114 * b;
  const median = (arr: number[]) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)];

  let masked = 0;
  for (const box of boxes) {
    // (3) 짧은 단독 라벨은 그림의 일부 — 남긴다.
    if (isShortFigureLabel(box.text)) {
      keep('short_label');
      continue;
    }

    const x0 = Math.max(0, Math.min(W - 1, box.x0));
    const y0 = Math.max(0, Math.min(H - 1, box.y0));
    const x1 = Math.max(0, Math.min(W - 1, box.x1));
    const y1 = Math.max(0, Math.min(H - 1, box.y1));
    if (x1 <= x0 || y1 <= y0) {
      keep('degenerate');
      continue;
    }

    // (4) 그림 오인 방지 — 모델이 명백히 이상한 박스를 준 경우만 막는다.
    //     (좁은 가드는 여러 줄 주석·넓은 캡션을 통째로 걸러 텍스트를 남겼다.)
    if ((x1 - x0) * (y1 - y0) > W * H * maxAreaRatio) {
      keep('too_large');
      continue;
    }

    // (1) 배경색: 박스 바깥 2px 링의 색 중앙값
    const ring: [number, number, number][] = [];
    const rx0 = Math.max(0, x0 - 2);
    const rx1 = Math.min(W - 1, x1 + 2);
    const ry0 = Math.max(0, y0 - 2);
    const ry1 = Math.min(H - 1, y1 + 2);
    for (let x = rx0; x <= rx1; x++) {
      ring.push(at(x, ry0));
      ring.push(at(x, ry1));
    }
    for (let y = ry0; y <= ry1; y++) {
      ring.push(at(rx0, y));
      ring.push(at(rx1, y));
    }
    if (ring.length === 0) {
      keep('no_ring');
      continue;
    }
    // 배경색: 링 픽셀의 "최빈 색"을 쓴다(8단계 양자화).
    // 중앙값을 쓰면 링에 걸친 글자 획·인접 텍스트 때문에 회색으로 치우쳐, 흰 배경 위에
    // 회색 사각형이 남는 문제가 실측에서 나왔다.
    const bucket = new Map<string, { c: [number, number, number]; n: number }>();
    for (const c of ring) {
      const key = `${c[0] >> 5}_${c[1] >> 5}_${c[2] >> 5}`;
      const cur = bucket.get(key);
      if (cur) cur.n += 1;
      else bucket.set(key, { c, n: 1 });
    }
    let bg: [number, number, number] = [
      median(ring.map((c) => c[0])),
      median(ring.map((c) => c[1])),
      median(ring.map((c) => c[2])),
    ];
    let best = 0;
    for (const { c, n } of bucket.values()) {
      if (n > best) {
        best = n;
        bg = c;
      }
    }
    const bgLum = lum(bg);
    const isInk = (x: number, y: number) => Math.abs(lum(at(x, y)) - bgLum) > 40;

    // (2) 글자 픽셀 범위로 축소 — 박스가 넉넉해도 실제 글자에만 밀착시킨다.
    //     단 글자를 찾지 못하면 "덮지 않는" 대신 모델이 준 박스를 그대로 쓴다.
    //     (밝은 색 글자는 잉크로 안 잡혀 그대로 노출되는 사고가 실측에서 나왔다.)
    let ix0 = x1;
    let iy0 = y1;
    let ix1 = x0;
    let iy1 = y0;
    let found = false;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!isInk(x, y)) continue;
        found = true;
        if (x < ix0) ix0 = x;
        if (x > ix1) ix1 = x;
        if (y < iy0) iy0 = y;
        if (y > iy1) iy1 = y;
      }
    }
    if (!found) {
      ix0 = x0;
      iy0 = y0;
      ix1 = x1;
      iy1 = y1;
    }

    // 여유: 좌표 오차·안티에일리어싱으로 글자 가장자리가 남지 않게 한다.
    // 글자 높이에 비례해 주므로 작은 글자에는 여전히 최소 크기다(수칙 2 유지).
    const grow = Math.max(pad, Math.round((iy1 - iy0 + 1) * padRatio));
    const fx0 = Math.max(0, ix0 - grow);
    const fy0 = Math.max(0, iy0 - grow);
    const fx1 = Math.min(W - 1, ix1 + grow);
    const fy1 = Math.min(H - 1, iy1 + grow);

    ctx.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    ctx.fillRect(fx0, fy0, fx1 - fx0 + 1, fy1 - fy0 + 1);
    masked += 1;
  }

  return {
    png: masked > 0 ? new Uint8Array(canvas.toBuffer('image/png')) : png,
    masked,
    kept: Object.values(keptReasons).reduce((a, b) => a + b, 0),
    keptReasons,
  };
}

/**
 * OCR 대상 이미지 전처리.
 *
 * 적용:
 *   - resize: 긴 변 1600px 이상이면 1600 으로 다운, 800 미만이면 1600 으로 업
 *   - grayscale + 대비 정규화 (EKG/CT 흑백 텍스트 가독성)
 *   - 가벼운 디노이즈 (3x3 box blur 1회)
 *
 * pure Canvas API 만 사용 — @napi-rs/canvas 의존.
 */

const TARGET_LONG_EDGE = 1600;
const MIN_LONG_EDGE = 800;

/**
 * 임의 raster 포맷(JPEG/WebP/BMP/GIF 등) 의 이미지 바이트를 PNG 로 재인코딩.
 *
 * Vision/crop/OCR 파이프라인이 항상 `media_type: 'image/png'` 로 처리하므로
 * PPTX `ppt/media` 임베드 이미지처럼 다른 포맷이 섞인 입력은 본 헬퍼로 표준화한다.
 *
 * - loadImage 실패(EMF/WMF/손상/0-byte 등): null 반환. 호출자가 skip 결정.
 * - 입력이 이미 PNG 인지 빠르게 식별 가능(매직바이트 8byte 시그니처) 하면 재인코딩 생략.
 */
export async function normalizeToPng(
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  if (!bytes || bytes.length === 0) return null;

  // PNG 매직: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return bytes;
  }

  try {
    const { loadImage, createCanvas } = await import('canvas');
    const img = await loadImage(Buffer.from(bytes));
    if (img.width < 1 || img.height < 1) return null;
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return new Uint8Array(canvas.toBuffer('image/png'));
  } catch {
    return null;
  }
}

export interface PreprocessOptions {
  /** 흑백 변환 적용 여부. 기본 true. */
  grayscale?: boolean;
  /** 대비 정규화 적용 여부. 기본 true. */
  normalizeContrast?: boolean;
  /** 박스 블러 적용 여부. 기본 false (라인이 가는 EKG 에서 정보 손실 가능). */
  denoise?: boolean;
}

export async function preprocessForOcr(
  inputPng: Uint8Array,
  options: PreprocessOptions = {},
): Promise<Uint8Array> {
  if (!inputPng || inputPng.length === 0) return inputPng;

  const { loadImage, createCanvas } = await import('canvas');

  // 비표준 포맷 / 손상 이미지 / WMF·EMF 등은 loadImage 가 throw — 원본 그대로 반환해
  // 전체 OCR 파이프라인이 죽지 않도록 fallback.
  let img: Awaited<ReturnType<typeof loadImage>>;
  try {
    img = await loadImage(Buffer.from(inputPng));
  } catch (e) {
    console.warn(
      '[preprocess] loadImage 실패, 원본 반환:',
      e instanceof Error ? e.message : String(e),
    );
    return inputPng;
  }

  const W0 = img.width;
  const H0 = img.height;
  if (W0 < 8 || H0 < 8) {
    // 너무 작은 이미지는 전처리 의미 없음 — 원본 반환.
    return inputPng;
  }
  const longEdge0 = Math.max(W0, H0);

  let scale = 1;
  if (longEdge0 > TARGET_LONG_EDGE) scale = TARGET_LONG_EDGE / longEdge0;
  else if (longEdge0 < MIN_LONG_EDGE) scale = TARGET_LONG_EDGE / longEdge0;

  const W = Math.round(W0 * scale);
  const H = Math.round(H0 * scale);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  // node-canvas 타입 정의엔 imageSmoothingQuality 가 없으나 런타임은 지원(또는 무시) — 캐스팅.
  (ctx as { imageSmoothingQuality?: string }).imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, W, H);

  if (options.grayscale !== false || options.normalizeContrast !== false) {
    const imgData = ctx.getImageData(0, 0, W, H);
    const d = imgData.data;

    // grayscale
    if (options.grayscale !== false) {
      for (let i = 0; i < d.length; i += 4) {
        // BT.601 luma
        const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
        d[i] = d[i + 1] = d[i + 2] = y;
      }
    }

    // 대비 정규화: 1% / 99% 분위수 stretch
    if (options.normalizeContrast !== false) {
      const hist = new Uint32Array(256);
      for (let i = 0; i < d.length; i += 4) hist[d[i]] += 1;
      const total = W * H;
      let acc = 0;
      let lo = 0;
      let hi = 255;
      const loTarget = Math.floor(total * 0.01);
      const hiTarget = Math.floor(total * 0.99);
      for (let v = 0; v < 256; v += 1) {
        acc += hist[v];
        if (acc >= loTarget) {
          lo = v;
          break;
        }
      }
      acc = 0;
      for (let v = 0; v < 256; v += 1) {
        acc += hist[v];
        if (acc >= hiTarget) {
          hi = v;
          break;
        }
      }
      const range = Math.max(1, hi - lo);
      for (let i = 0; i < d.length; i += 4) {
        const v = d[i];
        const norm = Math.max(0, Math.min(255, ((v - lo) / range) * 255));
        d[i] = d[i + 1] = d[i + 2] = norm;
      }
    }

    ctx.putImageData(imgData, 0, 0);
  }

  if (options.denoise) {
    // 3x3 box blur 1회
    const src = ctx.getImageData(0, 0, W, H);
    const dst = ctx.createImageData(W, H);
    const s = src.data;
    const t = dst.data;
    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        let sum = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            sum += s[(ny * W + nx) * 4];
            n += 1;
          }
        }
        const v = sum / n;
        const i = (y * W + x) * 4;
        t[i] = t[i + 1] = t[i + 2] = v;
        t[i + 3] = 255;
      }
    }
    ctx.putImageData(dst, 0, 0);
  }

  return new Uint8Array(canvas.toBuffer('image/png'));
}

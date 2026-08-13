import path from 'node:path';
import { createCanvas, loadImage, registerFont, type CanvasRenderingContext2D } from 'canvas';

export type InfographicTextPatch = {
  observedText: string;
  replacementText: string;
  confidence: number;
  backgroundComplexity: 'simple' | 'complex';
  box: { x: number; y: number; width: number; height: number };
};

export const MAX_INFOGRAPHIC_TEXT_PATCHES_PER_PASS = 24;

let fontRegistered = false;

function ensureKoreanFont() {
  if (fontRegistered) return;
  registerFont(path.join(process.cwd(), 'public', 'fonts', 'NotoSansKR-Variable.ttf'), {
    family: 'LectureLink Korean',
    weight: '700',
  });
  fontRegistered = true;
}

function parseImageDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:image\/(?:png|jpeg|webp);base64,(.+)$/s);
  return match ? Buffer.from(match[1], 'base64') : null;
}

function sampleBackground(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const margin = Math.max(3, Math.round(Math.min(width, height) * 0.18));
  const sx = Math.max(0, x - margin);
  const sy = Math.max(0, y - margin);
  const sw = Math.min(context.canvas.width - sx, width + margin * 2);
  const sh = Math.min(context.canvas.height - sy, height + margin * 2);
  const data = context.getImageData(sx, sy, sw, sh).data;
  const samples: Array<[number, number, number]> = [];
  const step = Math.max(1, Math.round(Math.min(sw, sh) / 18));
  const innerLeft = x - sx;
  const innerTop = y - sy;

  for (let py = 0; py < sh; py += step) {
    for (let px = 0; px < sw; px += step) {
      const inside =
        px >= innerLeft &&
        px <= innerLeft + width &&
        py >= innerTop &&
        py <= innerTop + height;
      if (inside) continue;
      const index = (py * sw + px) * 4;
      const rgb: [number, number, number] = [data[index], data[index + 1], data[index + 2]];
      samples.push(rgb);
    }
  }

  if (samples.length === 0) return [248, 246, 235] as const;
  const buckets = new Map<string, { count: number; red: number; green: number; blue: number }>();
  for (const [red, green, blue] of samples) {
    const key = `${Math.round(red / 16)}:${Math.round(green / 16)}:${Math.round(blue / 16)}`;
    const bucket = buckets.get(key) ?? { count: 0, red: 0, green: 0, blue: 0 };
    bucket.count += 1;
    bucket.red += red;
    bucket.green += green;
    bucket.blue += blue;
    buckets.set(key, bucket);
  }
  const dominant = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
  return dominant
    ? [
        Math.round(dominant.red / dominant.count),
        Math.round(dominant.green / dominant.count),
        Math.round(dominant.blue / dominant.count),
      ] as const
    : [248, 246, 235] as const;
}

function drawFittedText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  let size = Math.max(12, Math.min(height * 0.7, width / Math.max(2, text.length * 0.72)));
  while (size > 10) {
    context.font = `700 ${Math.floor(size)}px "LectureLink Korean"`;
    if (context.measureText(text).width <= width - 8) break;
    size -= 1;
  }
  context.textBaseline = 'middle';
  context.fillStyle = '#111b17';
  context.fillText(text, x + 4, y + height / 2, width - 8);
}

/**
 * Covers only confidently identified malformed text boxes and redraws the approved
 * string with a bundled Korean font. Coordinates use a provider-independent
 * 0..1000 normalized image space.
 */
export async function repairInfographicText(
  dataUrl: string,
  patches: InfographicTextPatch[],
) {
  const source = parseImageDataUrl(dataUrl);
  if (!source) return null;
  ensureKoreanFont();

  const image = await loadImage(source);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);

  const safePatches = patches.filter((patch) =>
    patch.confidence >= 0.72
    && patch.replacementText.trim().length > 0
    && patch.replacementText.length <= 120
    && patch.box.width > 8
    && patch.box.height > 5
  ).slice(0, MAX_INFOGRAPHIC_TEXT_PATCHES_PER_PASS);

  for (const patch of safePatches) {
    const x = Math.max(0, Math.round((patch.box.x / 1000) * canvas.width));
    const y = Math.max(0, Math.round((patch.box.y / 1000) * canvas.height));
    const width = Math.min(canvas.width - x, Math.round((patch.box.width / 1000) * canvas.width));
    const height = Math.min(canvas.height - y, Math.round((patch.box.height / 1000) * canvas.height));
    if (width < 12 || height < 8) continue;

    const [red, green, blue] = sampleBackground(context, x, y, width, height);
    const padding = Math.max(2, Math.round(height * 0.12));
    context.save();
    context.fillStyle = `rgb(${red}, ${green}, ${blue})`;
    context.beginPath();
    context.roundRect(
      Math.max(0, x - padding),
      Math.max(0, y - padding),
      Math.min(canvas.width - x + padding, width + padding * 2),
      Math.min(canvas.height - y + padding, height + padding * 2),
      Math.max(3, Math.round(height * 0.16)),
    );
    context.fill();
    drawFittedText(context, patch.replacementText.trim(), x, y, width, height);
    context.restore();
  }

  return safePatches.length > 0
    ? {
        dataUrl: `data:image/png;base64,${canvas.toBuffer('image/png').toString('base64')}`,
        appliedCount: safePatches.length,
      }
    : null;
}

import { colorDistance, type Raster, type Rgb } from './raster.js';

/**
 * Background removal.
 *
 * `flood` runs a flood fill from every
 * edge pixel, removing pixels within `threshold` of the background colour.
 * Enclosed background (a hole inside a mug handle) is reached through
 * `fillHoles`, which runs a second pass from any remaining background-coloured
 * pixel that touches an already-removed one.
 *
 * `chroma` removes every pixel near the chroma colour regardless of position.
 *
 * Both are followed by feather and despill.
 *
 * `ink` is for line art on paper, where fills inside a shape are the same white as the paper and
 * the model paints that paper a hazy off-white. Darkness becomes alpha: anything within
 * `INK_PAPER_MARGIN` of the background's luminance is fully transparent, the ink colour fully
 * opaque, and every pixel takes the ink colour, so antialiasing stays smooth on any surface.
 */

export type CutoutOptions = {
  mode: 'flood' | 'chroma' | 'ink';
  background: Rgb;
  /** Line colour for `ink` mode. */
  ink?: Rgb;
  threshold: number;
  feather: number;
  despill: boolean;
};

function floodFromEdges(raster: Raster, background: Rgb, threshold: number): Uint8Array {
  const { width, height, data } = raster;
  const removed = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];
  const isBackground = (index: number) => {
    const o = index * 4;
    const a = data[o + 3] ?? 255;
    if (a < 24) return true;
    return colorDistance(data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0, background.r, background.g, background.b) <= threshold;
  };
  const enqueue = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const index = y * width + x;
    if (visited[index]) return;
    visited[index] = 1;
    if (!isBackground(index)) return;
    queue.push(index);
  };
  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor] ?? 0;
    removed[index] = 1;
    const x = index % width;
    const y = Math.floor(index / width);
    enqueue(x, y - 1);
    enqueue(x - 1, y);
    enqueue(x + 1, y);
    enqueue(x, y + 1);
  }
  return removed;
}

function chromaMask(raster: Raster, background: Rgb, threshold: number): Uint8Array {
  const { width, height, data } = raster;
  const removed = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    if (colorDistance(data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0, background.r, background.g, background.b) <= threshold) {
      removed[i] = 1;
    }
  }
  return removed;
}

/** Soft alpha near the mask edge: box-blur the removal mask by `radius`. */
function featherAlpha(removed: Uint8Array, width: number, height: number, radius: number): Float32Array {
  const alpha = new Float32Array(width * height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = removed[i] ? 0 : 1;
  if (radius <= 0) return alpha;
  const r = Math.ceil(radius);
  const tmp = new Float32Array(alpha.length);
  // horizontal
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let n = 0;
      for (let k = -r; k <= r; k += 1) {
        const xx = x + k;
        if (xx < 0 || xx >= width) continue;
        sum += alpha[y * width + xx]!;
        n += 1;
      }
      tmp[y * width + x] = sum / n;
    }
  }
  // vertical
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      let n = 0;
      for (let k = -r; k <= r; k += 1) {
        const yy = y + k;
        if (yy < 0 || yy >= height) continue;
        sum += tmp[yy * width + x]!;
        n += 1;
      }
      alpha[y * width + x] = sum / n;
    }
  }
  // Keep the interior fully opaque and the removed area fully clear; only
  // the band around the edge is soft.
  for (let i = 0; i < alpha.length; i += 1) {
    if (removed[i]) alpha[i] = Math.min(alpha[i]!, 0.999);
    else alpha[i] = Math.max(alpha[i]!, 0.001);
  }
  return alpha;
}

/**
 * Despill: pixels in the soft band take the colour of the nearest solid
 * foreground pixels, so a cream or green halo does not survive into the
 * edge blend.
 */
function despillEdges(raster: Raster, removed: Uint8Array, alpha: Float32Array, radius: number): void {
  const { width, height, data } = raster;
  const r = Math.max(1, Math.ceil(radius) + 1);
  const out = Buffer.from(data);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const a = alpha[i]!;
      if (a >= 0.999 || a <= 0.001) continue;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let n = 0;
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
          const j = yy * width + xx;
          if (removed[j] || alpha[j]! < 0.999) continue;
          const o = j * 4;
          sr += data[o]!;
          sg += data[o + 1]!;
          sb += data[o + 2]!;
          n += 1;
        }
      }
      if (n > 0) {
        const o = i * 4;
        out[o] = Math.round(sr / n);
        out[o + 1] = Math.round(sg / n);
        out[o + 2] = Math.round(sb / n);
      }
    }
  }
  out.copy(data);
}

const INK_PAPER_MARGIN = 30;

const luminance = ({ r, g, b }: Rgb) => 0.299 * r + 0.587 * g + 0.114 * b;

function inkOnly(raster: Raster, background: Rgb, ink: Rgb): { raster: Raster; removedPixels: number } {
  const paper = luminance(background) - INK_PAPER_MARGIN;
  const span = Math.max(1, paper - luminance(ink));
  let removedPixels = 0;
  for (let i = 0; i < raster.width * raster.height; i += 1) {
    const o = i * 4;
    const level = luminance({ r: raster.data[o]!, g: raster.data[o + 1]!, b: raster.data[o + 2]! });
    const alpha = Math.min(1, Math.max(0, (paper - level) / span));
    if (alpha === 0) removedPixels += 1;
    raster.data[o] = ink.r;
    raster.data[o + 1] = ink.g;
    raster.data[o + 2] = ink.b;
    raster.data[o + 3] = Math.round((raster.data[o + 3] ?? 255) * alpha);
  }
  return { raster, removedPixels };
}

export function cutout(raster: Raster, options: CutoutOptions): { raster: Raster; removedPixels: number } {
  if (options.mode === 'ink') return inkOnly(raster, options.background, options.ink ?? { r: 0x33, g: 0x33, b: 0x33 });
  const removed = options.mode === 'chroma' ? chromaMask(raster, options.background, options.threshold) : floodFromEdges(raster, options.background, options.threshold);
  const alpha = featherAlpha(removed, raster.width, raster.height, options.feather);
  if (options.despill) {
    despillEdges(raster, removed, alpha, options.feather);
  }
  let removedPixels = 0;
  for (let i = 0; i < removed.length; i += 1) {
    const o = i * 4 + 3;
    const value = Math.round((raster.data[o] ?? 255) * alpha[i]!);
    if (removed[i]) removedPixels += 1;
    raster.data[o] = removed[i] ? 0 : value;
  }
  return { raster, removedPixels };
}

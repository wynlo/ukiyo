import { alphaBounds } from './crop.js';
import { colorDistance, parseHex, type Raster } from './raster.js';

/**
 * Overlay extraction for `layer` targets.
 *
 * The model redraws the base with one item added, but it rarely keeps the
 * exact position and scale. `register` finds the similarity transform
 * (uniform scale + translation) that maps base pixels onto the edited image,
 * by maximising the overlap of the two silhouettes. `extractLayer` then
 * resamples the edit into the base's frame and keeps only pixels that are
 * outside the base silhouette or clearly differ from the base colour.
 */

export type Transform = { scale: number; tx: number; ty: number; iou: number };

const ALPHA_ON = 128;

function mask(raster: Raster): Uint8Array {
  const out = new Uint8Array(raster.width * raster.height);
  for (let i = 0; i < out.length; i += 1) out[i] = (raster.data[i * 4 + 3] ?? 0) >= ALPHA_ON ? 1 : 0;
  return out;
}

/** Outline and other dark pixels are left out of fill masks. */
const FILL_MIN_LUMINANCE = 60;

/**
 * Main fill colours of the base: quantised, most frequent first, covering
 * 95% of the fill pixels.
 */
function fillPalette(raster: Raster): [number, number, number][] {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let i = 0; i < raster.data.length; i += 4) {
    if ((raster.data[i + 3] ?? 0) < ALPHA_ON) continue;
    const r = raster.data[i] ?? 0;
    const g = raster.data[i + 1] ?? 0;
    const b = raster.data[i + 2] ?? 0;
    if (0.2126 * r + 0.7152 * g + 0.0722 * b < FILL_MIN_LUMINANCE) continue;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const entry = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    entry.n += 1;
    entry.r += r;
    entry.g += g;
    entry.b += b;
    counts.set(key, entry);
    total += 1;
  }
  const sorted = [...counts.values()].sort((a, b) => b.n - a.n);
  const palette: [number, number, number][] = [];
  let covered = 0;
  for (const entry of sorted) {
    if (covered >= total * 0.95 || palette.length >= 24) break;
    palette.push([entry.r / entry.n, entry.g / entry.n, entry.b / entry.n]);
    covered += entry.n;
  }
  return palette;
}

/**
 * Pixels in the base's fill colours. On the base that is its fill; on the
 * edit it is the part of the base still visible, so an added item neither
 * helps nor hurts the overlap wherever it is.
 */
const EMPTY = 0;
const FILL = 1;
const DARK = 2;
const OTHER = 3;
/** Dark pixels next to an added item: the item's outline. */
const ITEM_EDGE = 4;

/** Per-pixel class: empty, base fill colour, dark (outline), or anything else (an added item). */
function classify(raster: Raster, palette: [number, number, number][], tolerance: number): Uint8Array {
  const out = new Uint8Array(raster.width * raster.height);
  for (let p = 0; p < out.length; p += 1) {
    const i = p * 4;
    if ((raster.data[i + 3] ?? 0) < ALPHA_ON) continue;
    const r = raster.data[i] ?? 0;
    const g = raster.data[i + 1] ?? 0;
    const b = raster.data[i + 2] ?? 0;
    out[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b < FILL_MIN_LUMINANCE ? DARK : OTHER;
    for (const c of palette) {
      if (colorDistance(r, g, b, c[0], c[1], c[2]) <= tolerance) {
        out[p] = FILL;
        break;
      }
    }
  }
  // An outline stroke touching item colour belongs to the item. Only solid
  // item areas count: anti-aliased outline edges also give odd colours.
  const { width, height } = raster;
  const reach = Math.max(3, Math.round(Math.max(width, height) / 200));
  const core = 2;
  const solid = new Uint8Array(out.length);
  for (let p = 0; p < out.length; p += 1) {
    if (out[p] !== OTHER) continue;
    const x = p % width;
    const y = (p - x) / width;
    let all = true;
    for (let oy = -core; oy <= core && all; oy += 1) {
      for (let ox = -core; ox <= core && all; ox += 1) {
        const qx = x + ox;
        const qy = y + oy;
        if (qx < 0 || qy < 0 || qx >= width || qy >= height || out[qy * width + qx] !== OTHER) all = false;
      }
    }
    if (all) solid[p] = 1;
  }
  const marked: number[] = [];
  for (let p = 0; p < out.length; p += 1) {
    if (out[p] !== DARK) continue;
    const x = p % width;
    const y = (p - x) / width;
    search: for (let oy = -reach; oy <= reach; oy += 1) {
      for (let ox = -reach; ox <= reach; ox += 1) {
        const qx = x + ox;
        const qy = y + oy;
        if (qx >= 0 && qy >= 0 && qx < width && qy < height && solid[qy * width + qx]) {
          marked.push(p);
          break search;
        }
      }
    }
  }
  for (const p of marked) out[p] = ITEM_EDGE;
  return out;
}

/** Widest row width in the lowest `fraction` of a silhouette's rows. */
function lowerWidth(m: Uint8Array, width: number, box: { x: number; y: number; width: number; height: number }, fraction: number): number {
  let widest = 1;
  const from = Math.floor(box.y + box.height * (1 - fraction));
  for (let y = from; y < box.y + box.height; y += 1) {
    let min = -1;
    let max = -1;
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (m[y * width + x]) {
        if (min < 0) min = x;
        max = x;
      }
    }
    if (min >= 0) widest = Math.max(widest, max - min + 1);
  }
  return widest;
}

/**
 * Find the transform p_edit = scale * p_base + t that best overlays the base
 * silhouette on the edit silhouette. Coarse grid search, then a fine search
 * around the best coarse result.
 */
export function register(base: Raster, edit: Raster, tolerance = 48): Transform {
  const bb = alphaBounds(base, ALPHA_ON - 1);
  const eb = alphaBounds(edit, ALPHA_ON - 1);
  if (!bb || !eb) throw new Error('empty silhouette; nothing to register');
  // Items change the top (hats) and the sides (coats) more than the lower
  // body, so the first scale guess comes from the lower third of each shape.
  const s0 = lowerWidth(mask(edit), edit.width, eb, 0.33) / lowerWidth(mask(base), base.width, bb, 0.33);
  const palette = fillPalette(base);
  const bc = classify(base, palette, tolerance);
  const em = classify(edit, palette, tolerance);
  let editCount = 0;
  for (let i = 0; i < em.length; i += 1) if (em[i] === FILL) editCount += 1;
  if (editCount === 0) throw new Error('the edit shows none of the base colour; the model recoloured the base');
  // Bottom-centre of the base maps near bottom-centre of the edit.
  const bcx = bb.x + bb.width / 2;
  const bcy = bb.y + bb.height;
  const t0x = eb.x + eb.width / 2 - s0 * bcx;
  const t0y = eb.y + eb.height - s0 * bcy;

  /*
   * Overlap of the base fill with the visible base fill in the edit. A base
   * pixel that lands on an added item, or on the item's own outline where it
   * crosses the body, is hidden, not wrong, so it is left out. Landing on
   * empty space or the body outline is a miss. Edit fill that no base pixel
   * explains is a miss too.
   */
  const score = (scale: number, tx: number, ty: number, stride: number): number => {
    let hit = 0;
    let miss = 0;
    for (let y = bb.y; y < bb.y + bb.height; y += stride) {
      const ey = Math.round(scale * y + ty);
      const rowInside = ey >= 0 && ey < edit.height;
      for (let x = bb.x; x < bb.x + bb.width; x += stride) {
        if (bc[y * base.width + x] !== FILL) continue;
        const ex = Math.round(scale * x + tx);
        const cls = rowInside && ex >= 0 && ex < edit.width ? em[ey * edit.width + ex]! : EMPTY;
        if (cls === FILL) hit += 1;
        else if (cls === EMPTY || cls === DARK) miss += 1;
      }
    }
    const area = stride * stride;
    const hits = hit * area;
    const unexplained = Math.max(0, editCount / (scale * scale) - hits);
    const total = hits + miss * area + unexplained;
    return total === 0 ? 0 : hits / total;
  };

  let best: Transform = { scale: s0, tx: t0x, ty: t0y, iou: score(s0, t0x, t0y, 1) };
  const coarse = Math.max(1, Math.round(bb.height / 64));
  const reach = Math.round(Math.max(bb.width, bb.height) * s0 * 0.12);
  for (let k = -12; k <= 12; k += 1) {
    const scale = s0 * (1 + k * 0.02);
    const cx = eb.x + eb.width / 2 - scale * bcx;
    const cy = eb.y + eb.height - scale * bcy;
    for (let dy = -reach; dy <= reach; dy += coarse * 2) {
      for (let dx = -reach; dx <= reach; dx += coarse * 2) {
        const iou = score(scale, cx + dx, cy + dy, coarse);
        if (iou > best.iou) best = { scale, tx: cx + dx, ty: cy + dy, iou };
      }
    }
  }
  // Pattern search from the coarse result: try one step in each direction,
  // move while it improves, halve the step when nothing does.
  const fine = Math.max(1, Math.round(bb.height / 160));
  best.iou = score(best.scale, best.tx, best.ty, fine);
  let delta = coarse * 2;
  let scaleDelta = 0.02;
  while (delta >= 0.5) {
    let moved = false;
    for (const [ds, dx, dy] of [
      [scaleDelta, 0, 0],
      [-scaleDelta, 0, 0],
      [0, delta, 0],
      [0, -delta, 0],
      [0, 0, delta],
      [0, 0, -delta],
    ] as const) {
      const scale = best.scale * (1 + ds);
      const iou = score(scale, best.tx + dx, best.ty + dy, fine);
      if (iou > best.iou + 1e-6) {
        best = { scale, tx: best.tx + dx, ty: best.ty + dy, iou };
        moved = true;
      }
    }
    if (!moved) {
      delta /= 2;
      scaleDelta /= 2;
    }
  }
  best.iou = score(best.scale, best.tx, best.ty, 1);
  return best;
}

export function sample(raster: Raster, x: number, y: number): [number, number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const out: [number, number, number, number] = [0, 0, 0, 0];
  let weight = 0;
  for (const [ox, oy, w] of [
    [0, 0, (1 - fx) * (1 - fy)],
    [1, 0, fx * (1 - fy)],
    [0, 1, (1 - fx) * fy],
    [1, 1, fx * fy],
  ] as const) {
    const px = x0 + ox;
    const py = y0 + oy;
    if (w <= 0 || px < 0 || py < 0 || px >= raster.width || py >= raster.height) continue;
    const i = (py * raster.width + px) * 4;
    const a = (raster.data[i + 3] ?? 0) / 255;
    // Premultiplied, so transparent neighbours do not bleed colour.
    out[0] += (raster.data[i] ?? 0) * a * w;
    out[1] += (raster.data[i + 1] ?? 0) * a * w;
    out[2] += (raster.data[i + 2] ?? 0) * a * w;
    out[3] += a * w;
    weight += w;
  }
  if (out[3] <= 0 || weight <= 0) return [0, 0, 0, 0];
  return [out[0] / out[3], out[1] / out[3], out[2] / out[3], (out[3] / weight) * 255 * Math.min(1, weight)];
}

/** Multiply every pixel's colour by `hex`: how the base was shown to the model. */
export function tintRaster(raster: Raster, hex: string): Raster {
  const c = parseHex(hex);
  const data = Buffer.from(raster.data);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.round(((data[i] ?? 0) * c.r) / 255);
    data[i + 1] = Math.round(((data[i + 1] ?? 0) * c.g) / 255);
    data[i + 2] = Math.round(((data[i + 2] ?? 0) * c.b) / 255);
  }
  return { ...raster, data };
}

export type Extracted = {
  /** The overlay, on a canvas that extends the base canvas by `margin` on every side. */
  raster: Raster;
  /** Offset of the base canvas origin inside `raster`. */
  margin: number;
  /** Share of the base silhouette the overlay covers, 0..1. */
  coverage: number;
};

/**
 * Keep the pixels of `edit` that are new relative to `base`. `base` is the
 * base as the model saw it (already tinted). Returns the overlay in the base
 * frame, on a canvas with room for items that stick out (a hat, a tail).
 */
export function extractLayer(base: Raster, edit: Raster, transform: Transform, threshold: number, minArea: number): Extracted {
  const margin = Math.round(Math.max(base.width, base.height) * 0.5);
  const width = base.width + margin * 2;
  const height = base.height + margin * 2;
  const data = Buffer.alloc(width * height * 4);
  const bm = mask(base);
  let covered = 0;
  let baseCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const bx = x - margin;
      const by = y - margin;
      const [r, g, b, a] = sample(edit, transform.scale * bx + transform.tx, transform.scale * by + transform.ty);
      const insideBase = bx >= 0 && by >= 0 && bx < base.width && by < base.height && bm[by * base.width + bx] === 1;
      if (insideBase) baseCount += 1;
      if (a < 16) continue;
      let keep = 1;
      if (insideBase) {
        // Distance to the closest base colour in a 3x3 window, so a one-pixel
        // misregistration along an outline does not count as new.
        let nearest = Infinity;
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const qx = bx + ox;
            const qy = by + oy;
            if (qx < 0 || qy < 0 || qx >= base.width || qy >= base.height) continue;
            const i = (qy * base.width + qx) * 4;
            if ((base.data[i + 3] ?? 0) < ALPHA_ON) continue;
            nearest = Math.min(nearest, colorDistance(r, g, b, base.data[i] ?? 0, base.data[i + 1] ?? 0, base.data[i + 2] ?? 0));
          }
        }
        keep = Math.max(0, Math.min(1, (nearest - threshold * 0.6) / (threshold * 0.4)));
        if (keep > 0) covered += 1;
      }
      if (keep <= 0) continue;
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = Math.round(a * keep);
    }
  }
  const raster: Raster = { data, width, height, channels: 4 };
  removeSpecks(raster, minArea);
  return { raster, margin, coverage: baseCount ? covered / baseCount : 0 };
}

/**
 * A small region that is a solid blob (an eye dot, a blush oval) rather than a
 * sliver. Misregistration leaves thin strips along outlines; real small
 * features fill most of their bounding box and are a few pixels thick.
 */
function isCompact(region: readonly number[], width: number): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of region) {
    const x = p % width;
    const y = (p - x) / width;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  return Math.min(w, h) >= 4 && region.length >= 0.45 * w * h && Math.max(w, h) / Math.min(w, h) <= 3;
}

/** Clear connected opaque regions smaller than `minArea` pixels, unless they are compact blobs. */
export function removeSpecks(raster: Raster, minArea: number): void {
  const { width, height, data } = raster;
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  const region: number[] = [];
  for (let start = 0; start < width * height; start += 1) {
    if (seen[start] || (data[start * 4 + 3] ?? 0) < 64) continue;
    region.length = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      region.push(p);
      const x = p % width;
      const y = (p - x) / width;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (q < 0 || seen[q] || (data[q * 4 + 3] ?? 0) < 64) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    if (region.length < minArea && !isCompact(region, width)) for (const p of region) data[p * 4 + 3] = 0;
  }
  // Faint pixels left without an opaque neighbour region are noise too.
  for (let p = 0; p < width * height; p += 1) {
    if ((data[p * 4 + 3] ?? 0) > 0 && (data[p * 4 + 3] ?? 0) < 64 && !seen[p]) {
      const x = p % width;
      const y = (p - x) / width;
      let near = false;
      for (let oy = -2; oy <= 2 && !near; oy += 1) {
        for (let ox = -2; ox <= 2 && !near; ox += 1) {
          const qx = x + ox;
          const qy = y + oy;
          if (qx >= 0 && qy >= 0 && qx < width && qy < height && (data[(qy * width + qx) * 4 + 3] ?? 0) >= 64) near = true;
        }
      }
      if (!near) data[p * 4 + 3] = 0;
    }
  }
}

import { luminance, parseHex, readRaster, toSharp, type Raster, type Rgb } from './raster.js';

/**
 * Outline normalisation. A model draws every image with about the same
 * outline weight, so a target that `final` shrinks more ends with a thinner
 * outline than one it shrinks less. `setStroke` redraws the outline of a
 * source raster so that, after the final resize, it has a set width.
 *
 * The outline is the set of dark pixels connected to the silhouette edge.
 * Isolated dark marks (eyes, dots) are not changed. The outline grows or
 * shrinks on its inner side only, so the silhouette and the registration of
 * overlays stay the same.
 */

/** Pixels darker than this (luminance) are outline. */
const DARK = 100;
const OPAQUE = 128;

const isDark = (data: Buffer, i: number) => (data[i + 3] ?? 0) >= OPAQUE && luminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0) < DARK;

/** Dark pixels that are connected (8-way) to the silhouette edge. */
function outlineMask(raster: Raster): Uint8Array {
  const { width: w, height: h, data } = raster;
  const mask = new Uint8Array(w * h);
  const stack: number[] = [];
  const clear = (x: number, y: number) => x < 0 || y < 0 || x >= w || y >= h || (data[(y * w + x) * 4 + 3] ?? 0) < OPAQUE;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = y * w + x;
      if (!isDark(data, p * 4)) continue;
      if (clear(x - 1, y) || clear(x + 1, y) || clear(x, y - 1) || clear(x, y + 1)) {
        mask[p] = 1;
        stack.push(p);
      }
    }
  }
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % w;
    const y = (p - x) / w;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (mask[q] || !isDark(data, q * 4)) continue;
        mask[q] = 1;
        stack.push(q);
      }
    }
  }
  return mask;
}

/**
 * Exact Euclidean distance transform (Felzenszwalb and Huttenlocher) with the
 * index of the nearest feature pixel. `feature[p] = 1` marks the sources.
 */
function distanceTransform(feature: Uint8Array, w: number, h: number): { dist: Float64Array; nearest: Int32Array } {
  const INF = 1e20;
  const n = w * h;
  const f = new Float64Array(n);
  const idx = new Int32Array(n).fill(-1);
  for (let p = 0; p < n; p += 1) if (feature[p]) { f[p] = 0; idx[p] = p; } else f[p] = INF;
  const size = Math.max(w, h);
  const v = new Int32Array(size);
  const z = new Float64Array(size + 1);
  const line = new Float64Array(size);
  const lineIdx = new Int32Array(size);
  const outD = new Float64Array(size);
  const outI = new Int32Array(size);
  const pass = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q += 1) {
      let s = (line[q]! + q * q - (line[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      while (s <= z[k]!) {
        k -= 1;
        s = (line[q]! + q * q - (line[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
      }
      k += 1;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q += 1) {
      while (z[k + 1]! < q) k += 1;
      const d = q - v[k]!;
      outD[q] = d * d + line[v[k]!]!;
      outI[q] = lineIdx[v[k]!]!;
    }
  };
  for (let x = 0; x < w; x += 1) {
    for (let y = 0; y < h; y += 1) { line[y] = f[y * w + x]!; lineIdx[y] = idx[y * w + x]!; }
    pass(h);
    for (let y = 0; y < h; y += 1) { f[y * w + x] = outD[y]!; idx[y * w + x] = outI[y]!; }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) { line[x] = f[y * w + x]!; lineIdx[x] = idx[y * w + x]!; }
    pass(w);
    for (let x = 0; x < w; x += 1) { f[y * w + x] = outD[x]!; idx[y * w + x] = outI[x]!; }
  }
  const dist = new Float64Array(n);
  for (let p = 0; p < n; p += 1) dist[p] = Math.sqrt(f[p]!);
  return { dist, nearest: idx };
}

/**
 * Outline width in px: the median run of outline pixels inward from the
 * silhouette edge, scanned along rows and columns from all four sides.
 */
export function measureStroke(raster: Raster, mask = outlineMask(raster)): number {
  const { width: w, height: h, data } = raster;
  const runs: number[] = [];
  const scan = (at: (i: number) => number, len: number) => {
    let i = 0;
    while (i < len && (data[at(i) * 4 + 3] ?? 0) < OPAQUE) i += 1;
    let k = 0;
    while (i + k < len && mask[at(i + k)]) k += 1;
    if (k > 0 && i + k < len) runs.push(k);
  };
  for (let y = 0; y < h; y += 1) {
    scan((i) => y * w + i, w);
    scan((i) => y * w + (w - 1 - i), w);
  }
  for (let x = 0; x < w; x += 1) {
    scan((i) => i * w + x, h);
    scan((i) => (h - 1 - i) * w + x, h);
  }
  if (runs.length === 0) return 0;
  runs.sort((a, b) => a - b);
  return runs[Math.floor(runs.length / 2)]!;
}

/** Median colour of the darker half of the outline pixels. */
function coreColor(raster: Raster, mask: Uint8Array): Rgb {
  const { data } = raster;
  const px: [number, number, number, number][] = [];
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p] || (data[p * 4 + 3] ?? 0) < 250) continue;
    px.push([luminance(data[p * 4]!, data[p * 4 + 1]!, data[p * 4 + 2]!), data[p * 4]!, data[p * 4 + 1]!, data[p * 4 + 2]!]);
  }
  if (px.length === 0) return { r: 60, g: 40, b: 32 };
  px.sort((a, b) => a[0] - b[0]);
  const core = px.slice(0, Math.ceil(px.length / 2));
  const med = (k: 1 | 2 | 3) => core.map((c) => c[k]).sort((a, b) => a - b)[core.length >> 1]!;
  return { r: med(1), g: med(2), b: med(3) };
}

/** Pixels the supersampled work raster may hold. Bigger sources get a lower factor. */
const MAX_WORK_PIXELS = 8_000_000;
const MAX_SUPERSAMPLE = 4;

/** Supersampling factor for a raster: up to 4, lower for big sources. */
export function supersampleFactor(width: number, height: number): number {
  const fit = Math.floor(Math.sqrt(MAX_WORK_PIXELS / Math.max(1, width * height)));
  return Math.max(1, Math.min(MAX_SUPERSAMPLE, fit));
}

/** Upscale a raster by `factor` with a Mitchell filter (little ringing on ink edges). */
export async function supersample(raster: Raster, factor: number): Promise<Raster> {
  if (factor <= 1) return raster;
  return readRaster(
    await toSharp(raster)
      .resize(raster.width * factor, raster.height * factor, { kernel: 'mitchell', fit: 'fill' })
      .png()
      .toBuffer(),
  );
}

/**
 * Set the outline to `width` px (in `raster` pixels). The work is done on a
 * copy supersampled by `factor`, and that copy is returned, so the caller
 * downscales it once to the final size. The new outline is a clean offset of
 * the silhouette at sub-pixel precision, and the downscale anti-aliases it.
 *
 * - The outline band is everything within `width` of the outside, where an
 *   outline exists.
 * - Growing: fill next to the outline turns to ink, up to half the depth of
 *   a thin fill region.
 * - Shrinking: only the edge band shrinks. Inner lines joined to the outline
 *   keep their weight. The freed band and the old soft inner edge take the
 *   colour of the nearest clean fill, so no dark ghost ring is left.
 *
 * Returns null when the raster has no outline.
 */
export function setStroke(raster: Raster, width: number, color?: string, factor = 1): { raster: Raster; before: number } | null {
  const S = Math.max(1, Math.round(factor));
  const { width: w, height: h, data } = raster;
  const mask = outlineMask(raster);
  const current = measureStroke(raster, mask) / S;
  if (current === 0) return null;
  const n = w * h;
  const ink = color ? parseHex(color) : coreColor(raster, mask);
  const src = Buffer.from(data);
  const W = width * S;
  const oldBand = current * S;
  const outside = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) if ((src[p * 4 + 3] ?? 0) < OPAQUE) outside[p] = 1;
  const out = distanceTransform(outside, w, h);
  const near = distanceTransform(mask, w, h);
  const room = fillRoom(src, mask, near.dist, w, h);
  const grow = Math.max(0, W - oldBand);
  const shrinking = W < oldBand;
  // The soft transition between outline and fill, in work pixels.
  const ring = 1.5 * S;
  // Clean fill: opaque, not outline, not dark, and clear of the soft inner edge.
  const clean = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) {
    if ((src[p * 4 + 3] ?? 0) < OPAQUE || mask[p] || near.dist[p]! <= ring) continue;
    if (luminance(src[p * 4]!, src[p * 4 + 1]!, src[p * 4 + 2]!) < DARK) continue;
    clean[p] = 1;
  }
  let fillIndex: Int32Array | null = null;
  const nearestClean = (p: number): number => {
    fillIndex ??= distanceTransform(clean, w, h).nearest;
    return fillIndex[p]!;
  };
  // Half a work pixel of ramp: the downscale does the anti-aliasing.
  const ramp = (edge: number, d: number) => Math.max(0, Math.min(1, edge + 0.5 - d));
  for (let p = 0; p < n; p += 1) {
    if ((src[p * 4 + 3] ?? 0) === 0) continue;
    const dOut = out.dist[p]!;
    const dLine = near.dist[p]!;
    // Edge band: only where an outline is present next to the silhouette.
    let t = dLine <= W + S && dOut <= oldBand + ring ? ramp(W, dOut) : 0;
    if (grow > 0 && !mask[p]) t = Math.max(t, ramp(Math.min(grow, room[p]!), dLine));
    const inEdgeBand = dOut <= oldBand + ring;
    if (mask[p] && !inEdgeBand) continue; // an inner line: keep as drawn
    let base: Rgb = { r: src[p * 4]!, g: src[p * 4 + 1]!, b: src[p * 4 + 2]! };
    if (shrinking && inEdgeBand && (mask[p] || dLine <= ring) && t < 1) {
      const q = nearestClean(p);
      if (q >= 0) base = { r: src[q * 4]!, g: src[q * 4 + 1]!, b: src[q * 4 + 2]! };
    } else if (t === 0) {
      continue;
    }
    data[p * 4] = Math.round(base.r + (ink.r - base.r) * t);
    data[p * 4 + 1] = Math.round(base.g + (ink.g - base.g) * t);
    data[p * 4 + 2] = Math.round(base.b + (ink.b - base.b) * t);
  }
  return { raster, before: current };
}

/**
 * For each fill pixel: half of the greatest distance from the outline found
 * in its fill region. Outline growth stops there.
 */
function fillRoom(data: Buffer, mask: Uint8Array, dist: Float64Array, w: number, h: number): Float64Array {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const room = new Float64Array(n);
  const stack: number[] = [];
  const members: number[] = [];
  const isFill = (p: number) => !mask[p] && (data[p * 4 + 3] ?? 0) > 0;
  let next = 0;
  for (let start = 0; start < n; start += 1) {
    if (label[start]! >= 0 || !isFill(start)) continue;
    label[start] = next;
    stack.push(start);
    members.length = 0;
    let deepest = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      members.push(p);
      deepest = Math.max(deepest, dist[p]!);
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && label[p - 1]! < 0 && isFill(p - 1)) { label[p - 1] = next; stack.push(p - 1); }
      if (x < w - 1 && label[p + 1]! < 0 && isFill(p + 1)) { label[p + 1] = next; stack.push(p + 1); }
      if (y > 0 && label[p - w]! < 0 && isFill(p - w)) { label[p - w] = next; stack.push(p - w); }
      if (y < h - 1 && label[p + w]! < 0 && isFill(p + w)) { label[p + w] = next; stack.push(p + w); }
    }
    for (const p of members) room[p] = deepest / 2;
    next += 1;
  }
  return room;
}

import sharp from 'sharp';
import type { RigConfig } from '../config.js';
import type { Complexity } from '../meta.js';
import type { Raster } from './raster.js';

/**
 * How complex a sprite is, from its pixels alone, for `ukiyo plan`. Four
 * measures, each mapped to 0..1 by the project's `[low, high, weight]` terms
 * (`rig.score` in `ukiyo.json`) and summed by weight:
 *
 * - `regions`: flat colour regions of at least 0.5% of the art. A shrine hall
 *   with a rope, paper and doors has many; a stone has few.
 * - `protrusion`: the share of the silhouette's row and column spans that is
 *   not art. Things that hang, stick out or stand apart raise it.
 * - `edges`: the share of art pixels on a colour edge.
 * - `components`: separate pieces of art of at least 1% of it.
 *
 * The measure runs on a copy at most 256 px on its long side, so it is quick
 * and does not depend on the atlas scale. Deterministic.
 */

const ALPHA_ON = 128;

async function small(raster: Raster): Promise<Raster> {
  const long = Math.max(raster.width, raster.height);
  if (long <= 256) return raster;
  const k = 256 / long;
  const { data, info } = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } })
    .resize(Math.max(1, Math.round(raster.width * k)), Math.max(1, Math.round(raster.height * k)), { kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: Buffer.from(data), width: info.width, height: info.height, channels: 4 };
}

const lum = (d: Buffer, i: number) => 0.2126 * (d[i] ?? 0) + 0.7152 * (d[i + 1] ?? 0) + 0.0722 * (d[i + 2] ?? 0);

/** 8-connected regions of pixels that share `key`, counted when at least `min` px. */
function countRegions(key: Int32Array, width: number, height: number, min: number): number {
  const seen = new Uint8Array(key.length);
  let count = 0;
  const stack: number[] = [];
  for (let p = 0; p < key.length; p += 1) {
    if (seen[p] || key[p]! < 0) continue;
    let size = 0;
    seen[p] = 1;
    stack.push(p);
    while (stack.length > 0) {
      const q = stack.pop()!;
      size += 1;
      const x = q % width;
      const y = (q - x) / width;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (!seen[n] && key[n] === key[p]) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    if (size >= min) count += 1;
  }
  return count;
}

export async function measureComplexity(source: Raster, rig: RigConfig): Promise<Complexity> {
  const r = await small(source);
  const { width, height, data } = r;
  const opaque = new Int32Array(width * height).fill(-1);
  const colour = new Int32Array(width * height).fill(-1);
  let area = 0;
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    if ((data[i + 3] ?? 0) < ALPHA_ON) continue;
    area += 1;
    opaque[p] = 1;
    // Coarse colour classes: 3 bits a channel, so soft shading stays in one region.
    colour[p] = ((data[i]! >> 5) << 6) | ((data[i + 1]! >> 5) << 3) | (data[i + 2]! >> 5);
  }
  if (area === 0) return { score: 0, regions: 0, protrusion: 0, edges: 0, components: 0 };
  const regions = countRegions(colour, width, height, Math.max(4, Math.round(area * 0.005)));
  const components = countRegions(opaque, width, height, Math.max(4, Math.round(area * 0.01)));
  let rowSpan = 0;
  for (let y = 0; y < height; y += 1) {
    let a = -1;
    let b = -1;
    for (let x = 0; x < width; x += 1) {
      if (opaque[y * width + x]! > 0) {
        if (a < 0) a = x;
        b = x;
      }
    }
    if (a >= 0) rowSpan += b - a + 1;
  }
  let colSpan = 0;
  for (let x = 0; x < width; x += 1) {
    let a = -1;
    let b = -1;
    for (let y = 0; y < height; y += 1) {
      if (opaque[y * width + x]! > 0) {
        if (a < 0) a = y;
        b = y;
      }
    }
    if (a >= 0) colSpan += b - a + 1;
  }
  const protrusion = 1 - area / ((rowSpan + colSpan) / 2);
  let edges = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      if (opaque[p]! < 0) continue;
      const i = p * 4;
      const gx = lum(data, i + 4) - lum(data, i - 4);
      const gy = lum(data, i + width * 4) - lum(data, i - width * 4);
      if (Math.hypot(gx, gy) / 2 > 6) edges += 1;
    }
  }
  const edgeShare = edges / area;
  const term = (value: number, [low, high, weight]: readonly [number, number, number]) => weight * Math.max(0, Math.min(1, (value - low) / Math.max(1e-9, high - low)));
  const { score } = rig;
  const weights = score.regions[2] + score.protrusion[2] + score.edges[2] + score.components[2];
  const total = (term(regions, score.regions) + term(protrusion, score.protrusion) + term(edgeShare, score.edges) + term(components, score.components)) / Math.max(1e-9, weights);
  const round = (v: number) => Number(v.toFixed(3));
  return { score: round(total), regions, protrusion: round(protrusion), edges: round(edgeShare), components };
}

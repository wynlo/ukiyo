import { alphaBounds } from './crop.js';
import { colorDistance, parseHex, type Raster } from './raster.js';
import { removeSpecks, sample, type Transform } from './register.js';

/**
 * `split` targets: an approved sprite cut into registered pieces.
 *
 * Every step works on the base's final PNG, in its px. A piece is a mask
 * over a source (the base, or an `add` overlay): its pixels are copied as
 * they are, so the piece keeps the approved look. The plate is the base
 * with the moving pieces taken out:
 *
 * - `detach` pieces leave transparency, except a seam band along each cut
 *   where the piece touches art that stays. The band lies under the piece
 *   at rest, so a small turn about the joint never opens a gap.
 * - `cover` pieces leave the base as it is.
 * - `fill` pieces leave the `plate` edit (a redraw without them), blended
 *   into the base over a few px.
 *
 * Drawn at their offsets, the plate, the adds and the pieces rebuild the
 * base exactly (except under `fill` pieces, which hide the fill at rest).
 */

export type PieceSpec = Readonly<{
  id: string;
  box?: readonly [number, number, number, number];
  poly?: readonly (readonly [number, number])[];
  colors?: readonly string[];
  except?: readonly string[];
  tolerance: number;
  seeds?: readonly (readonly [number, number])[];
  fillHoles: boolean;
}>;

const ALPHA_ON = 128;

export function emptyRaster(width: number, height: number): Raster {
  return { data: Buffer.alloc(width * height * 4), width, height, channels: 4 };
}

function insidePoly(poly: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Pixels of `source` the piece selects, minus pixels an earlier piece took. 1 = selected. */
export function selectPiece(source: Raster, piece: PieceSpec, taken: Uint8Array): Uint8Array {
  const { width, height, data } = source;
  const mask = new Uint8Array(width * height);
  const colors = piece.colors?.map(parseHex);
  const except = piece.except?.map(parseHex);
  const [bx0, by0, bx1, by1] = piece.box ?? [0, 0, width, height];
  for (let y = Math.max(0, Math.floor(by0)); y < Math.min(height, Math.ceil(by1)); y += 1) {
    for (let x = Math.max(0, Math.floor(bx0)); x < Math.min(width, Math.ceil(bx1)); x += 1) {
      const p = y * width + x;
      if (taken[p] || (data[p * 4 + 3] ?? 0) === 0) continue;
      if (piece.poly && !insidePoly(piece.poly, x + 0.5, y + 0.5)) continue;
      const r = data[p * 4] ?? 0;
      const g = data[p * 4 + 1] ?? 0;
      const b = data[p * 4 + 2] ?? 0;
      if (colors && !colors.some((c) => colorDistance(r, g, b, c.r, c.g, c.b) <= piece.tolerance)) continue;
      if (except?.some((c) => colorDistance(r, g, b, c.r, c.g, c.b) <= piece.tolerance)) continue;
      mask[p] = 1;
    }
  }
  if (piece.seeds && piece.seeds.length > 0) keepSeeded(mask, width, height, piece.seeds);
  if (piece.fillHoles) fillHoles(mask, source, taken);
  return mask;
}

/** Keep the 8-connected regions of `mask` that hold a seed, or the region nearest to it within 8 px. */
function keepSeeded(mask: Uint8Array, width: number, height: number, seeds: readonly (readonly [number, number])[]): void {
  const label = new Int32Array(width * height).fill(-1);
  let next = 0;
  const stack: number[] = [];
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p] || label[p] !== -1) continue;
    label[p] = next;
    stack.push(p);
    while (stack.length > 0) {
      const q = stack.pop()!;
      const qx = q % width;
      const qy = (q - qx) / width;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = qx + ox;
          const ny = qy + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (mask[n] && label[n] === -1) {
            label[n] = next;
            stack.push(n);
          }
        }
      }
    }
    next += 1;
  }
  const keep = new Set<number>();
  for (const [sx, sy] of seeds) {
    let best = -1;
    let bestD = Infinity;
    for (let oy = -8; oy <= 8; oy += 1) {
      for (let ox = -8; ox <= 8; ox += 1) {
        const x = Math.round(sx) + ox;
        const y = Math.round(sy) + oy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const l = label[y * width + x]!;
        const d = ox * ox + oy * oy;
        if (l >= 0 && d < bestD) {
          bestD = d;
          best = l;
        }
      }
    }
    if (best >= 0) keep.add(best);
  }
  for (let p = 0; p < mask.length; p += 1) if (mask[p] && !keep.has(label[p]!)) mask[p] = 0;
}

/** Add the pixels enclosed by the selection (not reachable from outside its box without crossing it). */
function fillHoles(mask: Uint8Array, source: Raster, taken: Uint8Array): void {
  const { width, height } = source;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const x = p % width;
    const y = (p - x) / width;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  if (x1 < 0) return;
  const outside = new Uint8Array(width * height);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    if (x < x0 || y < y0 || x > x1 || y > y1) return;
    const p = y * width + x;
    if (mask[p] || outside[p]) return;
    outside[p] = 1;
    stack.push(p);
  };
  for (let x = x0; x <= x1; x += 1) {
    push(x, y0);
    push(x, y1);
  }
  for (let y = y0; y <= y1; y += 1) {
    push(x0, y);
    push(x1, y);
  }
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const p = y * width + x;
      if (!mask[p] && !outside[p] && !taken[p] && (source.data[p * 4 + 3] ?? 0) > 0) mask[p] = 1;
    }
  }
}

/**
 * Move thin strips (2 px or less across) to the art they touch most. A piece
 * box often takes the edge of the beam it hangs from, or a sliver of the next
 * piece, and the plate keeps a sliver of a piece that the colour test missed.
 * A strip is what a 3x3 opening of its owner's solid pixels removes. Each
 * 8-connected strip goes to the owner whose pixels border it most, if that is
 * more than the border with its own owner's core. A strip that joins two parts
 * of one piece (a thin cord) borders its own core most and stays.
 */
export function moveThinStrips(source: Raster, masks: readonly Uint8Array[]): void {
  const { width, height, data } = source;
  const n = width * height;
  const owner = new Int32Array(n).fill(-1);
  for (let p = 0; p < n; p += 1) {
    if ((data[p * 4 + 3] ?? 0) < ALPHA_ON) continue;
    owner[p] = 0;
    for (let i = 0; i < masks.length; i += 1) {
      if (masks[i]![p]) {
        owner[p] = i + 1;
        break;
      }
    }
  }
  // Core: pixels that survive a 3x3 opening of their owner's region.
  const eroded = new Uint8Array(n);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const p = y * width + x;
      const o = owner[p]!;
      if (o < 0) continue;
      let all = true;
      for (let oy = -1; oy <= 1 && all; oy += 1) for (let ox = -1; ox <= 1; ox += 1) if (owner[p + oy * width + ox] !== o) all = false;
      if (all) eroded[p] = 1;
    }
  }
  const core = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) {
    if (!eroded[p]) continue;
    const x = p % width;
    const y = (p - x) / width;
    for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) core[(y + oy) * width + x + ox] = 1;
  }
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  for (let start = 0; start < n; start += 1) {
    const o = owner[start]!;
    if (o < 0 || core[start] || seen[start]) continue;
    // One strip: the 8-connected non-core pixels of one owner.
    const strip: number[] = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length > 0) {
      const q = stack.pop()!;
      strip.push(q);
      const qx = q % width;
      const qy = (q - qx) / width;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = qx + ox;
          const ny = qy + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const m = ny * width + nx;
          if (!seen[m] && owner[m] === o && !core[m]) {
            seen[m] = 1;
            stack.push(m);
          }
        }
      }
    }
    const touch = new Map<number, number>();
    let own = 0;
    for (const q of strip) {
      const qx = q % width;
      const qy = (q - qx) / width;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = qx + ox;
        const ny = qy + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const m = ny * width + nx;
        const other = owner[m]!;
        if (other < 0) continue;
        if (other === o) {
          if (core[m]) own += 1;
        } else touch.set(other, (touch.get(other) ?? 0) + 1);
      }
    }
    let best = -1;
    let bestN = own;
    for (const [other, count] of touch) {
      if (count > bestN) {
        bestN = count;
        best = other;
      }
    }
    if (best < 0) continue;
    for (const q of strip) {
      if (o > 0) masks[o - 1]![q] = 0;
      if (best > 0) masks[best - 1]![q] = 1;
      owner[q] = best;
    }
  }
}

/**
 * Move small islands out of each piece. A piece is one object, so a solid
 * region that does not touch its largest region and is under a quarter of
 * its size is a scrap of something else (the post next to a plaque). It goes
 * to the owner it borders most, or to the plate.
 */
export function moveIslands(source: Raster, masks: readonly Uint8Array[]): void {
  const { width, height, data } = source;
  const n = width * height;
  const solid = (p: number) => (data[p * 4 + 3] ?? 0) >= ALPHA_ON;
  for (const [i, mask] of masks.entries()) {
    const label = new Int32Array(n).fill(-1);
    const regions: number[][] = [];
    const stack: number[] = [];
    for (let start = 0; start < n; start += 1) {
      if (!mask[start] || !solid(start) || label[start] !== -1) continue;
      const region: number[] = [];
      label[start] = regions.length;
      stack.push(start);
      while (stack.length > 0) {
        const q = stack.pop()!;
        region.push(q);
        const qx = q % width;
        const qy = (q - qx) / width;
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            const nx = qx + ox;
            const ny = qy + oy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const m = ny * width + nx;
            if (mask[m] && solid(m) && label[m] === -1) {
              label[m] = regions.length;
              stack.push(m);
            }
          }
        }
      }
      regions.push(region);
    }
    if (regions.length < 2) continue;
    const largest = Math.max(...regions.map((r) => r.length));
    for (const region of regions) {
      if (region.length >= largest * 0.25) continue;
      const touch = new Map<number, number>();
      for (const q of region) {
        const qx = q % width;
        const qy = (q - qx) / width;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = qx + ox;
          const ny = qy + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const m = ny * width + nx;
          if (mask[m] || !solid(m)) continue;
          const other = masks.findIndex((o, j) => j !== i && o[m]);
          touch.set(other, (touch.get(other) ?? 0) + 1);
        }
      }
      let best = -1;
      let bestN = 0;
      for (const [other, count] of touch) {
        if (count > bestN) {
          bestN = count;
          best = other;
        }
      }
      for (const q of region) {
        mask[q] = 0;
        if (best >= 0) masks[best]![q] = 1;
      }
    }
  }
}

/**
 * Give each soft edge pixel (alpha below ALPHA_ON) to the art it belongs to.
 * A colour or box test sorts soft pixels badly: a piece picks up the faint
 * edge of the beam it hangs from, and the plate keeps a faint outline of each
 * piece taken out of it. Here each soft pixel goes to the owner of the
 * nearest solid pixel within `reach` px: a piece (its mask gains it) or the
 * plate (every mask loses it). A soft pixel with no solid pixel that near is
 * halo; it is returned so the caller can clear it from the plate too.
 */
export function assignSoftEdges(source: Raster, masks: readonly Uint8Array[], reach: number): Uint8Array {
  const { width, height, data } = source;
  const n = width * height;
  // Owner of each solid pixel: piece index + 1, or 0 for the plate.
  const owner = new Int32Array(n).fill(-1);
  for (let p = 0; p < n; p += 1) {
    if ((data[p * 4 + 3] ?? 0) < ALPHA_ON) continue;
    owner[p] = 0;
    for (let i = 0; i < masks.length; i += 1) {
      if (masks[i]![p]) {
        owner[p] = i + 1;
        break;
      }
    }
  }
  const halo = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) {
    const a = data[p * 4 + 3] ?? 0;
    if (a === 0 || a >= ALPHA_ON) continue;
    const x = p % width;
    const y = (p - x) / width;
    let best = -1;
    let bestD = Infinity;
    for (let oy = -reach; oy <= reach; oy += 1) {
      for (let ox = -reach; ox <= reach; ox += 1) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const o = owner[ny * width + nx]!;
        const d = ox * ox + oy * oy;
        if (o >= 0 && d < bestD) {
          bestD = d;
          best = o;
        }
      }
    }
    for (const mask of masks) mask[p] = 0;
    if (best > 0) masks[best - 1]![p] = 1;
    else if (best < 0) halo[p] = 1;
  }
  return halo;
}

/** Pixels of `mask` within `reach` px (square) of a pixel in `near`. */
export function band(mask: Uint8Array, near: Uint8Array, width: number, height: number, reach: number): Uint8Array {
  const out = new Uint8Array(mask.length);
  if (reach <= 0) return out;
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const x = p % width;
    const y = (p - x) / width;
    search: for (let oy = -reach; oy <= reach; oy += 1) {
      for (let ox = -reach; ox <= reach; ox += 1) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        if (near[ny * width + nx]) {
          out[p] = 1;
          break search;
        }
      }
    }
  }
  return out;
}

/** Opaque pixels of `raster` that are not in `mask`. */
export function opaqueOutside(raster: Raster, mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(raster.width * raster.height);
  for (let p = 0; p < out.length; p += 1) if (!mask[p] && (raster.data[p * 4 + 3] ?? 0) >= ALPHA_ON) out[p] = 1;
  return out;
}

/** A copy of `source` with only the pixels of `mask`. */
export function masked(source: Raster, mask: Uint8Array): Raster {
  const out = emptyRaster(source.width, source.height);
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    source.data.copy(out.data, p * 4, p * 4, p * 4 + 4);
  }
  return out;
}

/** Clear the pixels of `mask` in `raster`, in place. */
export function clear(raster: Raster, mask: Uint8Array): void {
  for (let p = 0; p < mask.length; p += 1) if (mask[p]) raster.data[p * 4 + 3] = 0;
}

export function dilate(mask: Uint8Array, width: number, height: number, reach: number): Uint8Array {
  const out = new Uint8Array(mask);
  if (reach <= 0) return out;
  for (let p = 0; p < mask.length; p += 1) {
    if (!mask[p]) continue;
    const x = p % width;
    const y = (p - x) / width;
    for (let oy = -reach; oy <= reach; oy += 1) {
      for (let ox = -reach; ox <= reach; ox += 1) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) out[ny * width + nx] = 1;
      }
    }
  }
  return out;
}

/**
 * Where a base-cut pixel lands in the base's final PNG. `final` trims,
 * scales by one factor and pads, so the map is a scale and an offset.
 */
export type CutToFinal = { factor: number; cutX: number; cutY: number; finalX: number; finalY: number };

export function cutToFinal(baseCut: Raster, baseFinal: Raster): CutToFinal {
  const bb = alphaBounds(baseCut)!;
  const fb = alphaBounds(baseFinal)!;
  return { factor: fb.height / bb.height, cutX: bb.x, cutY: bb.y, finalX: fb.x, finalY: fb.y };
}

/**
 * An edit resampled onto the base's final canvas: each final px goes back
 * to the base cut, then through the registration into the edit.
 */
export function resampleEdit(edit: Raster, transform: Transform, map: CutToFinal, width: number, height: number): Raster {
  const out = emptyRaster(width, height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cx = map.cutX + (x + 0.5 - map.finalX) / map.factor - 0.5;
      const cy = map.cutY + (y + 0.5 - map.finalY) / map.factor - 0.5;
      // Average a small footprint when the edit is much larger than the final.
      const step = transform.scale / map.factor;
      const taps = step > 1.5 ? 2 : 1;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let ty = 0; ty < taps; ty += 1) {
        for (let tx = 0; tx < taps; tx += 1) {
          const ox = taps === 1 ? 0 : (tx - 0.5) * 0.5 * step;
          const oy = taps === 1 ? 0 : (ty - 0.5) * 0.5 * step;
          const [sr, sg, sb, sa] = sample(edit, transform.scale * cx + transform.tx + ox, transform.scale * cy + transform.ty + oy);
          r += sr * sa;
          g += sg * sa;
          b += sb * sa;
          a += sa;
        }
      }
      if (a <= 0) continue;
      const o = (y * width + x) * 4;
      out.data[o] = Math.round(r / a);
      out.data[o + 1] = Math.round(g / a);
      out.data[o + 2] = Math.round(b / a);
      out.data[o + 3] = Math.round(a / (taps * taps));
    }
  }
  return out;
}

/**
 * The new pixels of an `add` edit, on the base's final canvas. `base` is the
 * base as the model saw it (tinted), `edit` the resampled edit. A pixel is
 * new outside the base silhouette, or where its colour is far from every
 * base colour in a 3x3 window.
 */
export function newPixels(base: Raster, edit: Raster, threshold: number, minArea: number): Raster {
  const { width, height } = base;
  const out = emptyRaster(width, height);
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    const a = edit.data[i + 3] ?? 0;
    if (a < 16) continue;
    const x = p % width;
    const y = (p - x) / width;
    let keep = 1;
    if ((base.data[i + 3] ?? 0) >= ALPHA_ON) {
      let nearest = Infinity;
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = (ny * width + nx) * 4;
          if ((base.data[j + 3] ?? 0) < ALPHA_ON) continue;
          nearest = Math.min(nearest, colorDistance(edit.data[i]!, edit.data[i + 1]!, edit.data[i + 2]!, base.data[j]!, base.data[j + 1]!, base.data[j + 2]!));
        }
      }
      keep = Math.max(0, Math.min(1, (nearest - threshold * 0.6) / (threshold * 0.4)));
    }
    if (keep <= 0) continue;
    edit.data.copy(out.data, i, i, i + 3);
    out.data[i + 3] = Math.round(a * keep);
  }
  removeSpecks(out, minArea);
  return out;
}

/**
 * The plate edit blended into `plate` over the fill region: full weight
 * inside `region`, fading to none `feather` px outside it.
 */
export function blendFill(plate: Raster, fill: Raster, region: Uint8Array, feather: number): void {
  const { width, height } = plate;
  const grown = dilate(region, width, height, feather);
  for (let p = 0; p < region.length; p += 1) {
    if (!grown[p]) continue;
    let w = 1;
    if (!region[p]) {
      // Distance to the region, in px (square), turned into a weight.
      const x = p % width;
      const y = (p - x) / width;
      let d = feather + 1;
      for (let oy = -feather; oy <= feather; oy += 1) {
        for (let ox = -feather; ox <= feather; ox += 1) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || !region[ny * width + nx]) continue;
          d = Math.min(d, Math.max(Math.abs(ox), Math.abs(oy)));
        }
      }
      w = Math.max(0, 1 - d / (feather + 1));
    }
    const i = p * 4;
    const pa = (plate.data[i + 3] ?? 0) / 255;
    const fa = (fill.data[i + 3] ?? 0) / 255;
    const a = pa * (1 - w) + fa * w;
    if (a <= 0) {
      plate.data[i + 3] = 0;
      continue;
    }
    for (let c = 0; c < 3; c += 1) plate.data[i + c] = Math.round(((plate.data[i + c] ?? 0) * pa * (1 - w) + (fill.data[i + c] ?? 0) * fa * w) / a);
    plate.data[i + 3] = Math.round(a * 255);
  }
}

/** Largest per-channel difference between `a` over `b` composites and `reference`, over opaque reference px. For the rebuild check. */
export function rebuildError(layers: readonly Raster[], reference: Raster, ignore: Uint8Array): { max: number; share: number } {
  const { width, height } = reference;
  let bad = 0;
  let count = 0;
  let max = 0;
  for (let p = 0; p < width * height; p += 1) {
    if (ignore[p]) continue;
    const i = p * 4;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (const layer of layers) {
      const la = (layer.data[i + 3] ?? 0) / 255;
      if (la <= 0) continue;
      r = (layer.data[i] ?? 0) * la + r * (1 - la);
      g = (layer.data[i + 1] ?? 0) * la + g * (1 - la);
      b = (layer.data[i + 2] ?? 0) * la + b * (1 - la);
      a = la + a * (1 - la);
    }
    const ra = (reference.data[i + 3] ?? 0) / 255;
    if (ra < 0.5 && a < 0.5) continue;
    count += 1;
    const d = Math.max(Math.abs(a - ra) * 255, a > 0 && ra > 0 ? Math.max(Math.abs(r / a - (reference.data[i] ?? 0)), Math.abs(g / a - (reference.data[i + 1] ?? 0)), Math.abs(b / a - (reference.data[i + 2] ?? 0))) : 0);
    max = Math.max(max, d);
    if (d > 24) bad += 1;
  }
  return { max, share: count ? bad / count : 0 };
}

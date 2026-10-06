import type { RigConfig } from '../config.js';
import { slugify } from '../manifest.js';
import { colorDistance, type Raster } from './raster.js';
import { selectPiece } from './split.js';

/**
 * `ukiyo plan`: from labelled regions to the pieces of a `split` target.
 *
 * The model says roughly where each moving piece is and what it is made of
 * (`Label`). Everything else is measured on the pixels, so a re-run with the
 * same labels gives the same plan:
 *
 * - the core of each label: the smooth colour region round its seed (a
 *   lantern body with its soft shading). It stops at colour edges.
 * - the carrier: the art outside every label's window (a post, a rope, a
 *   beam), grown along smooth colour into the windows. It never enters a core.
 * - the mask: the art in the label's window, minus the carrier, the other
 *   labels' cores and the `except` colours, kept to the region round the
 *   seed. The window is the label's box widened by `MARGIN`, so the mask
 *   stops at colour boundaries and not at the model's rough box.
 * - `except`: colours of the carrier and of the other cores that the piece
 *   does not have. A colour the piece has in its own area is never excluded
 *   (a cream lantern keeps its red cap next to a red lantern).
 * - `poly`: the outline of the mask, when the box and `except` alone would
 *   select more (a lantern under a rope of its own colour).
 * - the mode: `detach` when the piece mostly touches air, else `fill`, unless
 *   the material sets one;
 * - the joint: by the material's pivot rule. `contact-top` is the hook: the
 *   topmost point where the piece touches the art it hangs from (the plate,
 *   or its parent piece), not a sibling beside it.
 * - the parent: the piece most of its contact touches, or the label's `hangsFrom`.
 */

export type Label = {
  label: string;
  material: string;
  box: [number, number, number, number];
  seed: [number, number];
  hangsFrom?: string | null;
};

export type PlannedPiece = {
  id: string;
  box: [number, number, number, number];
  poly?: [number, number][];
  seeds: [number, number][];
  except?: string[];
  tolerance: number;
  mode: 'detach' | 'cover' | 'fill';
  joint: [number, number];
  z: number;
  parent?: string;
  material: string;
};

const ALPHA_ON = 128;
/** Most colour change between two neighbouring pixels of one smooth region (soft shading, a rope). */
const STEP = 16;
/** Most distance from the seed's colour for a pixel of the core. */
const CORE_RANGE = 52;
/** Most colour change between neighbouring pixels of a carrier (a twisted rope, a grained post). */
const CARRIER_STEP = 30;
/** The carrier also takes this many px of art along its edge (the blended pixels). */
const HALO = 2;
/** The label's box is widened by this share of its size on each side. */
const MARGIN = 0.2;
/**
 * A colour is the piece's own when 3 px plus this share of its own area are
 * within the tolerance of it. Kept small: excluding a colour the piece has
 * cuts holes in it.
 */
const OWN_SHARE = 0.002;
const TOLERANCE = 30;
const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

const hex = (r: number, g: number, b: number) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/** Most common colours among `pixels`, as up to `n` cluster centres `tolerance` apart. */
function palette(raster: Raster, pixels: number[], n: number, tolerance: number): [number, number, number][] {
  const buckets = new Map<number, { c: number; r: number; g: number; b: number }>();
  for (const p of pixels) {
    const i = p * 4;
    const key = ((raster.data[i]! >> 4) << 8) | ((raster.data[i + 1]! >> 4) << 4) | (raster.data[i + 2]! >> 4);
    const e = buckets.get(key) ?? { c: 0, r: 0, g: 0, b: 0 };
    e.c += 1;
    e.r += raster.data[i]!;
    e.g += raster.data[i + 1]!;
    e.b += raster.data[i + 2]!;
    buckets.set(key, e);
  }
  const sorted = [...buckets.values()].sort((a, b) => b.c - a.c);
  const out: [number, number, number][] = [];
  for (const e of sorted) {
    if (e.c < Math.max(3, pixels.length * 0.02)) break;
    const c: [number, number, number] = [e.r / e.c, e.g / e.c, e.b / e.c];
    if (out.some((o) => colorDistance(o[0], o[1], o[2], c[0], c[1], c[2]) < tolerance)) continue;
    out.push(c);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * Pixels reached from `starts` through art whose colour changes by at most
 * `step` between 4-neighbours, inside `window`, never through `blocked`.
 * With `near`, only pixels within `range` of that colour.
 */
export function smoothRegion(
  base: Raster,
  starts: readonly number[],
  window: readonly [number, number, number, number],
  opts: { step: number; blocked?: Uint8Array; near?: readonly [number, number, number]; range?: number },
): Uint8Array {
  const { width, height, data } = base;
  const { step, blocked, near, range = Infinity } = opts;
  const inRange = (q: number) => !near || colorDistance(data[q * 4]!, data[q * 4 + 1]!, data[q * 4 + 2]!, near[0], near[1], near[2]) <= range;
  const [x0, y0, x1, y1] = window;
  const out = new Uint8Array(width * height);
  const stack: number[] = [];
  for (const p of starts) {
    if (out[p] || blocked?.[p] || (data[p * 4 + 3] ?? 0) < ALPHA_ON || !inRange(p)) continue;
    out[p] = 1;
    stack.push(p);
  }
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    for (const [ox, oy] of NEIGHBOURS) {
      const nx = x + ox;
      const ny = y + oy;
      if (nx < x0 || ny < y0 || nx >= x1 || ny >= y1) continue;
      const n = ny * width + nx;
      if (out[n] || blocked?.[n] || (data[n * 4 + 3] ?? 0) < ALPHA_ON || !inRange(n)) continue;
      if (colorDistance(data[p * 4]!, data[p * 4 + 1]!, data[p * 4 + 2]!, data[n * 4]!, data[n * 4 + 1]!, data[n * 4 + 2]!) > step) continue;
      out[n] = 1;
      stack.push(n);
    }
  }
  return out;
}

/** Douglas-Peucker on an open chain of points; keeps both ends. */
function simplifyChain(points: [number, number][], epsilon: number): [number, number][] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a]!;
    const [bx, by] = points[b]!;
    const len = Math.hypot(bx - ax, by - ay);
    let far = -1;
    let farD = epsilon;
    for (let i = a + 1; i < b; i += 1) {
      const [px, py] = points[i]!;
      const d = len === 0 ? Math.hypot(px - ax, py - ay) : Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / len;
      if (d > farD) {
        farD = d;
        far = i;
      }
    }
    if (far < 0) continue;
    keep[far] = 1;
    stack.push([a, far], [far, b]);
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * The outer outline of `mask` as a polygon on pixel corners, simplified to
 * within `epsilon` px (below 0.5, so no pixel centre changes side).
 * Pixels that touch at a corner stay in one outline (8-connected).
 */
export function outline(mask: Uint8Array, width: number, height: number, epsilon = 0.45): [number, number][] {
  // Directed edges with the mask on the right (y down): the top, right, bottom and left side of each pixel.
  const W = width + 1;
  const out = new Map<number, number[]>();
  const add = (ax: number, ay: number, bx: number, by: number) => {
    const key = ay * W + ax;
    const list = out.get(key) ?? [];
    list.push(by * W + bx);
    out.set(key, list);
  };
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) add(x, y, x + 1, y);
      if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!on(x - 1, y)) add(x, y + 1, x, y);
    }
  }
  let best: [number, number][] = [];
  let bestArea = 0;
  for (const [start, ends] of out) {
    while (ends.length > 0) {
      const loop: [number, number][] = [[start % W, Math.floor(start / W)]];
      let from = start;
      let to = ends.pop()!;
      for (;;) {
        const next = out.get(to);
        if (!next || next.length === 0) break;
        loop.push([to % W, Math.floor(to / W)]);
        let pick = 0;
        if (next.length > 1) {
          // A saddle: turn left, onto the pixel that touches at the corner, so it stays in the outline.
          const dx = (to % W) - (from % W);
          const dy = Math.floor(to / W) - Math.floor(from / W);
          pick = Math.max(0, next.findIndex((n) => dx * (Math.floor(n / W) - Math.floor(to / W)) - dy * ((n % W) - (to % W)) < 0));
        }
        from = to;
        to = next.splice(pick, 1)[0]!;
      }
      let area = 0;
      for (let i = 0; i < loop.length; i += 1) {
        const [ax, ay] = loop[i]!;
        const [bx, by] = loop[(i + 1) % loop.length]!;
        area += ax * by - bx * ay;
      }
      if (Math.abs(area) > bestArea) {
        bestArea = Math.abs(area);
        best = loop;
      }
    }
  }
  if (best.length < 4) return best;
  // Split the closed loop at the point farthest from its start and simplify each half.
  let far = 0;
  let farD = -1;
  for (let i = 1; i < best.length; i += 1) {
    const d = (best[i]![0] - best[0]![0]) ** 2 + (best[i]![1] - best[0]![1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const first = simplifyChain(best.slice(0, far + 1), epsilon);
  const second = simplifyChain([...best.slice(far), best[0]!], epsilon);
  return [...first, ...second.slice(1, -1)];
}

/** Is `at` inside `region` or in a hole of it (not reachable from the window's edge without crossing it)? */
function encloses(base: Raster, region: Uint8Array, at: number, window: readonly [number, number, number, number]): boolean {
  if (region[at]) return true;
  const { width } = base;
  const [x0, y0, x1, y1] = window;
  const seen = new Uint8Array(region.length);
  const stack = [at];
  seen[at] = 1;
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % width;
    const y = (p - x) / width;
    if (x <= x0 || y <= y0 || x >= x1 - 1 || y >= y1 - 1) return false;
    for (const [ox, oy] of NEIGHBOURS) {
      const n = (y + oy) * width + x + ox;
      if (seen[n] || region[n]) continue;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return true;
}

/** The core of a seed: its smooth region near its colour, inside `window`. */
function coreOf(base: Raster, seed: readonly [number, number], window: readonly [number, number, number, number]): Uint8Array {
  const p = seed[1] * base.width + seed[0];
  const d = base.data;
  return smoothRegion(base, [p], window, { step: STEP, near: [d[p * 4]!, d[p * 4 + 1]!, d[p * 4 + 2]!], range: CORE_RANGE });
}

/**
 * The seed whose core is widest among `seed` and points round it in the box,
 * of those whose core holds `seed` or encloses it.
 */
function widestSeed(base: Raster, seed: [number, number], box: readonly [number, number, number, number], window: readonly [number, number, number, number]): [number, number] {
  const { width, data } = base;
  const r = Math.max(2, Math.round(Math.min(box[2] - box[0], box[3] - box[1]) * 0.15));
  const at = seed[1] * width + seed[0];
  let best = seed;
  let bestArea = -1;
  for (const k of [0, 0.5, 1, 1.5, 2]) {
    for (let a = 0; a < (k === 0 ? 1 : 8); a += 1) {
      const x = Math.round(seed[0] + Math.cos((a * Math.PI) / 4) * r * k);
      const y = Math.round(seed[1] + Math.sin((a * Math.PI) / 4) * r * k);
      if (x < box[0] || y < box[1] || x >= box[2] || y >= box[3] || (data[(y * width + x) * 4 + 3] ?? 0) < ALPHA_ON) continue;
      const core = coreOf(base, [x, y], window);
      let area = 0;
      for (let p = 0; p < core.length; p += 1) area += core[p]!;
      if (area > bestArea && encloses(base, core, at, window)) {
        bestArea = area;
        best = [x, y];
      }
    }
  }
  return best;
}

/**
 * For each pixel, the core whose piece it is attached to, or -1.
 *
 * Art outside every core is split into smooth regions, and each pixel goes to
 * the core nearest to it through the art. The part of a region that goes to
 * one core is attached to it when it touches that core, lies within its
 * columns and near its rows (a cap, a rim), and is no larger than it. A
 * region that touches no core is attached when it lies on one attachment,
 * within the same columns, and is a quarter of the core's size or less (a
 * cord, a knob). A post or a rope is too long to be attached.
 */
function attachments(base: Raster, coreOwner: Int16Array, count: number): Int16Array {
  const { width, height, data } = base;
  const n = width * height;
  const isArt = (p: number) => (data[p * 4 + 3] ?? 0) >= ALPHA_ON;
  // The nearest core of each art pixel, through the art (breadth first from every core).
  const nearest = new Int16Array(coreOwner);
  let queue: number[] = [];
  for (let p = 0; p < n; p += 1) if (coreOwner[p]! >= 0) queue.push(p);
  while (queue.length > 0) {
    const next: number[] = [];
    for (const p of queue) {
      const x = p % width;
      const y = (p - x) / width;
      for (const [ox, oy] of NEIGHBOURS) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const m = ny * width + nx;
        if (nearest[m]! >= 0 || !isArt(m)) continue;
        nearest[m] = nearest[p]!;
        next.push(m);
      }
    }
    queue = next;
  }
  // Each core's box and size.
  const cores = Array.from({ length: count }, () => ({ x0: width, x1: -1, y0: height, y1: -1, area: 0 }));
  for (let p = 0; p < n; p += 1) {
    const o = coreOwner[p]!;
    if (o < 0) continue;
    const x = p % width;
    const y = (p - x) / width;
    const c = cores[o]!;
    c.x0 = Math.min(c.x0, x);
    c.x1 = Math.max(c.x1, x);
    c.y0 = Math.min(c.y0, y);
    c.y1 = Math.max(c.y1, y);
    c.area += 1;
  }
  /** Do `pixels` fit round core `o`: in its columns, from `above` of its height over it to 0.5 under it, at most `share` of its size? */
  const fits = (pixels: number[], o: number, above: number, share: number) => {
    const c = cores[o]!;
    const h = c.y1 - c.y0 + 1;
    if (pixels.length > c.area * share) return false;
    return pixels.every((q) => {
      const x = q % width;
      const y = (q - x) / width;
      return x >= c.x0 - 3 && x <= c.x1 + 3 && y >= c.y0 - h * above && y <= c.y1 + h * 0.5;
    });
  };
  /** Is the middle of `pixels` near the middle of core `o`? A cap, a rim or a cord hangs on the axis; a rope passing the side does not. */
  const centred = (pixels: number[], o: number) => {
    const c = cores[o]!;
    let x0 = width;
    let x1 = -1;
    for (const q of pixels) {
      x0 = Math.min(x0, q % width);
      x1 = Math.max(x1, q % width);
    }
    return Math.abs((x0 + x1) / 2 - (c.x0 + c.x1) / 2) <= (c.x1 - c.x0 + 1) * 0.25;
  };
  // Smooth regions of the art outside every core.
  const region = new Int32Array(n).fill(-1);
  const regions: number[][] = [];
  for (let p = 0; p < n; p += 1) {
    if (region[p]! >= 0 || coreOwner[p]! >= 0 || !isArt(p)) continue;
    const id = regions.length;
    const pixels: number[] = [];
    regions.push(pixels);
    const stack = [p];
    region[p] = id;
    while (stack.length > 0) {
      const q = stack.pop()!;
      pixels.push(q);
      const x = q % width;
      const y = (q - x) / width;
      for (const [ox, oy] of NEIGHBOURS) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const m = ny * width + nx;
        if (region[m]! >= 0 || coreOwner[m]! >= 0 || !isArt(m)) continue;
        if (colorDistance(data[q * 4]!, data[q * 4 + 1]!, data[q * 4 + 2]!, data[m * 4]!, data[m * 4 + 1]!, data[m * 4 + 2]!) > STEP) continue;
        region[m] = id;
        stack.push(m);
      }
    }
  }
  const owner = new Int16Array(n).fill(-1);
  const done = new Uint8Array(regions.length);
  // A region on cores (within 2 px): split between those cores by the nearest, each part near its core
  // (the caps of two stacked lanterns). Rows where the region runs past the cores' columns belong to
  // something else (a rope, an awning, a post), and so does what is only joined to the cores through them.
  const coreNear = (q: number): Set<number> => {
    const out = new Set<number>();
    const x = q % width;
    const y = (q - x) / width;
    for (let oy = -2; oy <= 2; oy += 1) {
      for (let ox = -2; ox <= 2; ox += 1) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && coreOwner[ny * width + nx]! >= 0) out.add(coreOwner[ny * width + nx]!);
      }
    }
    return out;
  };
  regions.forEach((pixels, id) => {
    const touched = new Set<number>();
    for (const q of pixels) for (const o of coreNear(q)) touched.add(o);
    if (touched.size === 0) return;
    // Per core: the rows where the region runs past that core's columns.
    const wide = new Map<number, Set<number>>();
    for (const o of touched) {
      const rows = new Set<number>();
      for (const q of pixels) {
        const x = q % width;
        if (x < cores[o]!.x0 - 3 || x > cores[o]!.x1 + 3) rows.add((q - x) / width);
      }
      wide.set(o, rows);
    }
    const candidate = new Set(pixels.filter((q) => touched.has(nearest[q]!) && !wide.get(nearest[q]!)!.has(Math.floor(q / width)) && fits([q], nearest[q]!, 0.6, Infinity)));
    // Keep what joins its own core through the candidates.
    const kept = new Set<number>();
    const stack = [...candidate].filter((q) => coreNear(q).has(nearest[q]!));
    for (const q of stack) kept.add(q);
    while (stack.length > 0) {
      const q = stack.pop()!;
      const x = q % width;
      const y = (q - x) / width;
      for (const [ox, oy] of NEIGHBOURS) {
        const m = (y + oy) * width + x + ox;
        if (x + ox < 0 || y + oy < 0 || x + ox >= width || y + oy >= height) continue;
        if (!candidate.has(m) || kept.has(m) || nearest[m] !== nearest[q]) continue;
        kept.add(m);
        stack.push(m);
      }
    }
    const parts = new Map<number, number[]>();
    for (const q of kept) parts.set(nearest[q]!, [...(parts.get(nearest[q]!) ?? []), q]);
    for (const [o, part] of parts) if (part.length <= cores[o]!.area && centred(part, o)) for (const q of part) owner[q] = o;
    if (kept.size === pixels.length) done[id] = 1;
  });
  // Then twice: a small region on one piece's attachments (a knob on a cap, a cord on the knob). It may reach higher.
  for (let round = 0; round < 2; round += 1) {
    regions.forEach((pixels, id) => {
      if (done[id]) return;
      const on = new Set<number>();
      for (const q of pixels) {
        const x = q % width;
        const y = (q - x) / width;
        for (const [ox, oy] of NEIGHBOURS) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const m = ny * width + nx;
          if (coreOwner[m]! >= 0) on.add(-2);
          else if (region[m] !== id && owner[m]! >= 0) on.add(owner[m]!);
        }
      }
      const [o] = [...on];
      if (on.size !== 1 || o === undefined || o < 0 || !fits(pixels, o, 1, 0.25) || !centred(pixels, o)) return;
      for (const q of pixels) owner[q] = o;
      done[id] = 1;
    });
  }
  return owner;
}

/** A piece the plan keeps as it is (`locked: true` in the manifest), as the manifest has it. */
export type KeptPiece = {
  id: string;
  box?: readonly [number, number, number, number];
  poly?: readonly (readonly [number, number])[];
  colors?: readonly string[];
  except?: readonly string[];
  tolerance?: number;
  seeds?: readonly (readonly [number, number])[];
  fillHoles?: boolean;
  from?: string;
};

/**
 * Plan the pieces for `labels`. `keep` are the pieces that stay as they are
 * (locked): the manifest lists them first, so they take their pixels first,
 * and the plan cuts round them. A label with the id of a kept piece is not planned.
 */
export function planPieces(base: Raster, labels: readonly Label[], rig: RigConfig, maxParts: number, keep: readonly KeptPiece[] = []): { pieces: PlannedPiece[]; dropped: string[] } {
  const { width, height, data } = base;
  const isArt = (p: number) => (data[p * 4 + 3] ?? 0) >= ALPHA_ON;
  let art = 0;
  for (let p = 0; p < width * height; p += 1) if (isArt(p)) art += 1;
  const dropped: string[] = [];
  const keptIds = new Set(keep.map((k) => k.id));
  const usable = labels.filter((label) => {
    if (!rig.materials[label.material]) {
      dropped.push(`${label.label}: unknown material "${label.material}"`);
      return false;
    }
    if (keptIds.has(slugify(label.label))) {
      dropped.push(`${label.label}: locked in the manifest`);
      return false;
    }
    return true;
  });
  // Small pieces take their pixels first, so a strip on a rope is not swallowed by the rope.
  const order = [...usable].sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]));

  // Each label's box (padded 2 px), window (the box widened by MARGIN), seed and core seed. A piece that
  // hangs (pivot `contact-top`: a lantern, a bell, a chime, paper on a rope) is cut in its window, round
  // its core seed, apart from the carrier it hangs from. Any other piece is cut in its box, round its seed.
  type Box = [number, number, number, number];
  type Entry = { label: Label; box: Box; window: Box; seed: [number, number]; core: [number, number]; hangs: boolean };
  const entries: Entry[] = [];
  for (const label of order) {
    const x0 = Math.max(0, Math.floor(Math.min(label.box[0], label.box[2])) - 2);
    const y0 = Math.max(0, Math.floor(Math.min(label.box[1], label.box[3])) - 2);
    const x1 = Math.min(width, Math.ceil(Math.max(label.box[0], label.box[2])) + 2);
    const y1 = Math.min(height, Math.ceil(Math.max(label.box[1], label.box[3])) + 2);
    if (x1 - x0 < 3 || y1 - y0 < 3) {
      dropped.push(`${label.label}: empty box`);
      continue;
    }
    const mx = Math.max(4, Math.round((x1 - x0) * MARGIN));
    const my = Math.max(4, Math.round((y1 - y0) * MARGIN));
    const window: [number, number, number, number] = [Math.max(0, x0 - mx), Math.max(0, y0 - my), Math.min(width, x1 + mx), Math.min(height, y1 + my)];
    // The seed: the nearest art pixel to the model's point, inside the box.
    let seed: [number, number] | null = null;
    let best = Infinity;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        if (!isArt(y * width + x)) continue;
        const d = (x - label.seed[0]) ** 2 + (y - label.seed[1]) ** 2;
        if (d < best) {
          best = d;
          seed = [x, y];
        }
      }
    }
    if (!seed) {
      dropped.push(`${label.label}: no art in its box`);
      continue;
    }
    // A core seed on a detail (a crest on a lantern, a face on a sign) moves to the region round it, so
    // the core is the body and not the detail.
    const core = widestSeed(base, seed, [x0, y0, x1, y1], window);
    entries.push({ label, box: [x0, y0, x1, y1], window, seed, core, hangs: rig.materials[label.material]!.pivot === 'contact-top' });
  }

  // Cores: the smooth region round each seed, near the seed's colour, inside its window. A pixel two cores reach goes to the nearer seed.
  const coreOwner = new Int16Array(width * height).fill(-1);
  entries.forEach((e, i) => {
    const core = coreOf(base, e.core, e.window);
    for (let p = 0; p < core.length; p += 1) {
      if (!core[p]) continue;
      const other = coreOwner[p]!;
      if (other >= 0) {
        const x = p % width;
        const y = (p - x) / width;
        const o = entries[other]!.core;
        if ((x - o[0]) ** 2 + (y - o[1]) ** 2 <= (x - e.core[0]) ** 2 + (y - e.core[1]) ** 2) continue;
      }
      coreOwner[p] = i;
    }
  });

  // Attachments: small smooth regions on a core and within its width (a cap, a rim, a cord), and the
  // small regions on those. They belong to that core's piece: no carrier or other piece takes them.
  const attachOwner = attachments(base, coreOwner, entries.length);

  // The kept pieces take their pixels first, in list order, as `ukiyo final` cuts them.
  const taken = new Uint8Array(width * height);
  for (const k of keep) {
    if (k.from && k.from !== 'base') continue;
    const mask = selectPiece(base, { id: k.id, box: k.box, poly: k.poly, colors: k.colors, except: k.except, tolerance: k.tolerance ?? 60, seeds: k.seeds, fillHoles: k.fillHoles ?? true }, taken);
    for (let p = 0; p < mask.length; p += 1) if (mask[p]) taken[p] = 1;
  }
  const built: { label: Label; id: string; mask: Uint8Array; area: number; piece: PlannedPiece }[] = [];
  const ids = new Set<string>();
  entries.forEach((entry, i) => {
    const { label, hangs } = entry;
    const seed = hangs ? entry.core : entry.seed;
    const within = hangs ? entry.window : entry.box;
    const [wx0, wy0, wx1, wy1] = within;
    const [bx0, by0, bx1, by1] = entry.box;
    // The piece's own core: its core, and for a hanging piece the attachments on it (a cap, a cord).
    const ownCore = new Uint8Array(width * height);
    for (let p = 0; p < ownCore.length; p += 1) if (coreOwner[p] === i || (hangs && attachOwner[p] === i)) ownCore[p] = 1;
    const blocked = new Uint8Array(taken);
    // The piece's own area, and the art round it that is something else.
    const own: number[] = [];
    const foreign: number[] = [];
    if (hangs) {
      // The carrier: art that runs through the window from its edge (a post, a rope, a beam), grown
      // along smooth colour, never into this piece's core or attachments.
      const edge: number[] = [];
      for (let x = wx0; x < wx1; x += 1) edge.push(wy0 * width + x, (wy1 - 1) * width + x);
      for (let y = wy0; y < wy1; y += 1) edge.push(y * width + wx0, y * width + wx1 - 1);
      const carrier = smoothRegion(base, edge, within, { step: CARRIER_STEP, blocked: ownCore });
      // Its soft edge too: the blended and half-transparent pixels along a rope or a post are not in the
      // flood, but belong to it (the mask takes every pixel that is not fully transparent).
      for (let round = 0; round < HALO; round += 1) {
        const grow: number[] = [];
        for (let y = wy0; y < wy1; y += 1) {
          for (let x = wx0; x < wx1; x += 1) {
            const p = y * width + x;
            if (carrier[p] || ownCore[p] || (data[p * 4 + 3] ?? 0) === 0) continue;
            if (NEIGHBOURS.some(([ox, oy]) => x + ox >= wx0 && y + oy >= wy0 && x + ox < wx1 && y + oy < wy1 && carrier[(y + oy) * width + x + ox] === 1)) grow.push(p);
          }
        }
        for (const p of grow) carrier[p] = 1;
      }
      // Foreign: the carrier, the other cores and their attachments. The mask never takes them.
      const foreignTo = (p: number) => !ownCore[p] && (carrier[p] === 1 || coreOwner[p]! >= 0 || attachOwner[p]! >= 0);
      for (let p = 0; p < blocked.length; p += 1) if (foreignTo(p)) blocked[p] = 1;
      // Own: the core and attachments, and the art in the label's box that is not foreign and is nearer
      // this seed than any other.
      for (let y = Math.max(0, wy0 - 4); y < Math.min(height, wy1 + 4); y += 1) {
        for (let x = Math.max(0, wx0 - 4); x < Math.min(width, wx1 + 4); x += 1) {
          const p = y * width + x;
          if (!isArt(p)) continue;
          if (foreignTo(p)) {
            foreign.push(p);
            continue;
          }
          if (ownCore[p]) {
            own.push(p);
            continue;
          }
          if (x < bx0 || y < by0 || x >= bx1 || y >= by1) continue;
          const d = (x - seed[0]) ** 2 + (y - seed[1]) ** 2;
          if (entries.some((o, j) => j !== i && (x - o.core[0]) ** 2 + (y - o.core[1]) ** 2 < d)) continue;
          own.push(p);
        }
      }
    } else {
      // Own: the art round the seed. Foreign: the art that rings the box (a post behind a sign, a trunk
      // under a canopy). The rest of the box may hold that art too, so it does not count as own.
      for (let y = Math.max(by0, seed[1] - 4); y < Math.min(by1, seed[1] + 5); y += 1) {
        for (let x = Math.max(bx0, seed[0] - 4); x < Math.min(bx1, seed[0] + 5); x += 1) if (isArt(y * width + x)) own.push(y * width + x);
      }
      for (let y = Math.max(0, by0 - 4); y < Math.min(height, by1 + 4); y += 1) {
        for (let x = Math.max(0, bx0 - 4); x < Math.min(width, bx1 + 4); x += 1) {
          const inside = x >= bx0 && x < bx1 && y >= by0 && y < by1;
          if (!inside && isArt(y * width + x)) foreign.push(y * width + x);
        }
      }
    }
    // Exclude a foreign colour only when the piece's own area does not have it.
    const has = (c: [number, number, number]) => {
      let n = 0;
      for (const p of own) if (colorDistance(data[p * 4]!, data[p * 4 + 1]!, data[p * 4 + 2]!, c[0], c[1], c[2]) <= TOLERANCE) n += 1;
      return n >= 3 + own.length * OWN_SHARE;
    };
    const except = palette(base, foreign, hangs ? 8 : 6, TOLERANCE)
      .filter((c) => !has(c))
      .map((c) => hex(c[0], c[1], c[2]));
    const exceptList = except.length ? except : undefined;
    const mask = selectPiece(base, { id: label.label, box: within, except: exceptList, tolerance: TOLERANCE, seeds: [seed], fillHoles: true }, blocked);
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let p = 0; p < mask.length; p += 1) {
      if (!mask[p]) continue;
      area += 1;
      const x = p % width;
      const y = (p - x) / width;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
    if (area < art * 0.002 || area > art * 0.85) {
      dropped.push(`${label.label}: ${area < art * 0.002 ? 'too small' : 'too large'} (${((100 * area) / art).toFixed(1)}% of the art)`);
      return;
    }
    // A mask whose outline runs mostly along its window through solid art is a box, not a piece: the label was misplaced.
    let rim = 0;
    let cut = 0;
    for (let p = 0; p < mask.length; p += 1) {
      if (!mask[p]) continue;
      const x = p % width;
      const y = (p - x) / width;
      const onBox = x === wx0 || y === wy0 || x === wx1 - 1 || y === wy1 - 1;
      let outer = false;
      for (const [ox, oy] of NEIGHBOURS) {
        const nx = x + ox;
        const ny = y + oy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || !mask[ny * width + nx]) outer = true;
      }
      if (!outer) continue;
      rim += 1;
      if (onBox) {
        const nx = Math.min(width - 1, Math.max(0, x === wx0 ? x - 1 : x === wx1 - 1 ? x + 1 : x));
        const ny = Math.min(height - 1, Math.max(0, y === wy0 ? y - 1 : y === wy1 - 1 ? y + 1 : y));
        if (isArt(ny * width + nx)) cut += 1;
      }
    }
    if (rim > 0 && cut / rim > 0.35) {
      dropped.push(`${label.label}: its box cuts through the art (${Math.round((100 * cut) / rim)}% of its outline); the label is probably misplaced`);
      return;
    }
    // The manifest keeps the box and `except`, and the outline as `poly` only when they alone would select more.
    const box: [number, number, number, number] = hangs ? [minX, minY, maxX + 1, maxY + 1] : within;
    const plain = selectPiece(base, { id: label.label, box, except: exceptList, tolerance: TOLERANCE, seeds: [seed], fillHoles: true }, taken);
    let same = true;
    for (let p = 0; p < mask.length && same; p += 1) if (plain[p] !== mask[p]) same = false;
    const poly = same ? undefined : outline(mask, width, height);
    for (let p = 0; p < mask.length; p += 1) if (mask[p]) taken[p] = 1;
    let id = slugify(label.label);
    for (let n = 2; ids.has(id); n += 1) id = `${slugify(label.label)}-${n}`;
    ids.add(id);
    built.push({ label, id, mask, area, piece: { id, box, ...(poly ? { poly } : {}), seeds: [seed], ...(exceptList ? { except } : {}), tolerance: TOLERANCE, mode: 'detach', joint: [0, 0], z: 0, material: label.material } });
  });
  // The largest pieces first, up to the cap.
  const kept = [...built].sort((a, b) => b.area - a.area).slice(0, maxParts);
  for (const cut of built.filter((b) => !kept.includes(b))) dropped.push(`${cut.label.label}: over maxParts`);
  const owner = new Int16Array(width * height).fill(-1);
  kept.forEach((b, i) => {
    for (let p = 0; p < b.mask.length; p += 1) if (b.mask[p]) owner[p] = i;
  });
  // Where each piece touches art that is not its own, and what it touches there: another piece, or the plate (-1).
  const contacts = kept.map((b, i) => {
    const contact: { p: number; with: number; up: number | null }[] = [];
    let boundary = 0;
    const touches = new Map<number, number>();
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let p = 0; p < b.mask.length; p += 1) {
      if (!b.mask[p]) continue;
      const x = p % width;
      const y = (p - x) / width;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      let edge = false;
      let touching: number | null = null;
      for (const [ox, oy] of NEIGHBOURS) {
        const nx = x + ox;
        const ny = y + oy;
        const n = ny * width + nx;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height || !b.mask[n]) {
          edge = true;
          if (nx >= 0 && ny >= 0 && nx < width && ny < height && isArt(n)) {
            const o = owner[n]!;
            if (touching === null || o === -1) touching = o;
            if (o >= 0 && o !== i) touches.set(o, (touches.get(o) ?? 0) + 1);
          }
        }
      }
      if (edge) boundary += 1;
      // What hangs over it: the owner of the art right above (a piece, -1 the plate), or null.
      const over = y > 0 && !b.mask[p - width] && isArt(p - width) ? owner[p - width]! : null;
      if (touching !== null) contact.push({ p, with: touching, up: over });
    }
    return { contact, boundary, touches, minX, minY, maxX, maxY };
  });
  // A chain: the model's `hangsFrom`, else the piece most of its contact touches.
  kept.forEach((b, i) => {
    const { contact, touches } = contacts[i]!;
    const named = b.label.hangsFrom ? kept.find((k) => k.label.label === b.label.hangsFrom) : undefined;
    const [top] = [...touches].sort((x, y) => y[1] - x[1]);
    const byContact = top && contact.length && top[1] / contact.length >= 0.5 ? kept[top[0]] : undefined;
    const parent = named ?? byContact;
    if (parent && parent !== b) b.piece.parent = parent.id;
  });
  // A parent that hangs from its own child would loop: break it.
  for (const b of kept) {
    const seen = new Set<string>([b.id]);
    let at = b.piece.parent;
    while (at) {
      if (seen.has(at)) {
        delete b.piece.parent;
        break;
      }
      seen.add(at);
      at = kept.find((k) => k.id === at)?.piece.parent;
    }
  }
  kept.forEach((b, i) => {
    const material = rig.materials[b.label.material]!;
    const { contact: touching, boundary, minX, minY, maxX, maxY } = contacts[i]!;
    const contact = touching.map((c) => c.p);
    const ratio = boundary ? contact.length / boundary : 0;
    b.piece.mode = material.mode ?? (ratio < 0.4 ? 'detach' : 'fill');
    const centroid = (pixels: number[]): [number, number] => {
      let sx = 0;
      let sy = 0;
      for (const p of pixels) {
        sx += p % width;
        sy += Math.floor(p / width);
      }
      return [Math.round(sx / pixels.length), Math.round(sy / pixels.length)];
    };
    /** The pixel of `among` nearest to `at`, so a joint lies on the piece's art. */
    const nearest = (at: [number, number], among: number[]): [number, number] => {
      let best = among[0]!;
      let bestD = Infinity;
      for (const p of among) {
        const d = ((p % width) - at[0]) ** 2 + (Math.floor(p / width) - at[1]) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      return [best % width, Math.floor(best / width)];
    };
    const midX = Math.round((minX + maxX) / 2);
    switch (material.pivot) {
      case 'contact-top': {
        // The hook: where the piece hangs from what is right above it (the plate, or its parent; not a
        // sibling), nearest the piece's axis, since a hanging piece rests under its hook. Then the topmost.
        const parent = b.piece.parent ? kept.findIndex((k) => k.id === b.piece.parent) : -2;
        // Only solid pixels: a joint on a half-transparent edge pixel is off the piece once it is packed.
        const under = touching.filter((c) => isArt(c.p) && (c.up === -1 || (c.up !== null && c.up === parent))).map((c) => c.p);
        const axis = centroid([...b.mask.keys()].filter((p) => b.mask[p]))[0];
        const reach = Math.max(2, (maxX - minX + 1) * 0.2);
        const central = under.filter((p) => Math.abs((p % width) - axis) <= reach);
        const hook = central.length > 0 ? central : under;
        if (hook.length > 0) {
          const top = Math.min(...hook.map((p) => Math.floor(p / width)));
          const row = hook.filter((p) => Math.floor(p / width) <= top + 3);
          b.piece.joint = nearest([axis, top], row);
        } else {
          // It touches nothing it can hang from: the top of the piece (the end of its cord).
          let top = minY;
          const row: number[] = [];
          for (; top <= maxY && row.length === 0; top += 1) for (let x = minX; x <= maxX; x += 1) if (b.mask[top * width + x] && isArt(top * width + x)) row.push(top * width + x);
          b.piece.joint = row.length > 0 ? nearest([midX, minY], row) : [midX, minY];
        }
        break;
      }
      case 'contact-bottom': {
        if (contact.length === 0) {
          b.piece.joint = [midX, maxY];
          break;
        }
        const ys = contact.map((p) => Math.floor(p / width));
        const lo = Math.min(...ys);
        const hi = Math.max(...ys);
        b.piece.joint = centroid(contact.filter((p) => Math.floor(p / width) >= hi - (hi - lo) * 0.25));
        break;
      }
      case 'contact':
        b.piece.joint = contact.length ? centroid(contact) : centroid([...b.mask.keys()].filter((p) => b.mask[p]));
        break;
      case 'top':
        b.piece.joint = [midX, minY];
        break;
      case 'bottom':
        b.piece.joint = [midX, maxY];
        break;
      case 'center':
        b.piece.joint = [midX, Math.round((minY + maxY) / 2)];
        break;
    }
  });
  // Selection order stays small first (the manifest cuts in list order); larger pieces draw lower.
  const byArea = [...kept].sort((a, b) => b.area - a.area);
  const pieces = built.filter((b) => kept.includes(b)).map((b) => ({ ...b.piece, z: 1 + byArea.indexOf(b) }));
  return { pieces, dropped };
}

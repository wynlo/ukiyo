import type { Raster } from './raster.js';

/*
 * Light emitters: where a picture gives off light at night.
 *
 * A light is a lit region of the art: a lantern window, a flame, a glowing
 * paper panel, a firefly, or the paper body of a chochin. Each region
 * becomes one light point: its centroid, and the radius of a disc with the
 * region's area. A lantern with two lit panels gets two points; a row of
 * five candles gets five.
 *
 * Two ways to find the regions, set per material (`emits` in
 * `rig.materials`):
 *
 * - `lit`: pixels that are drawn lit. Bright and warm (the `lit` hue band),
 *   or bright and pale (the hot core of a flame). Every region above the
 *   size floor is a light.
 * - `body`: the bright body of the piece (a paper lantern drawn unlit by
 *   day). The dark caps, ribs and cord are left out. One light per piece.
 *
 * Both open the mask first (erode, then dilate) so thin slivers, such as a
 * cage bar at the edge of a firefly's cut, never become a light.
 */

export type LightMode = 'lit' | 'body';

export type LightRules = {
  lit: {
    /** Lowest HSV value (0-1) of a lit pixel. */
    minValue: number;
    /** Hue band of a warm lit pixel, degrees. */
    hue: [number, number];
    /** Lowest saturation of a warm lit pixel. */
    minSat: number;
    /** A pale pixel at least this bright is lit whatever its hue (a flame's core). */
    core: { maxSat: number; minValue: number };
  };
  body: { minValue: number };
  /** Erode, then dilate, this many px before regions are counted. */
  open: number;
  /** Smallest region, px. */
  minArea: number;
  /** Smallest side of a region's box, px. Thinner regions are slivers. */
  minThick: number;
  /** `lit`: a region smaller than this share of the largest one in the same piece is noise. */
  minShare: number;
};

export const DEFAULT_LIGHT_RULES: LightRules = {
  lit: { minValue: 0.9, hue: [35, 75], minSat: 0.25, core: { maxSat: 0.35, minValue: 0.95 } },
  body: { minValue: 0.72 },
  open: 1,
  minArea: 8,
  minThick: 4,
  minShare: 0.15,
};

/** A light in px of the raster it was found on. */
export type LightRegion = {
  x: number;
  y: number;
  radius: number;
  /** Mean colour of the region, `#rrggbb`. */
  color: string;
  /** Mean HSV value of the region, 0-1. */
  intensity: number;
};

/** A light as ukiyo stores it: in px of a canvas, with the piece it belongs to. */
export type LightPoint = LightRegion & {
  /** The split piece that carries it: the light moves with that piece. */
  piece?: string;
  /** `base` or the id of an `add`: the art the piece was cut from. */
  from?: string;
};

function hsv(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d > 0) {
    h = max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
    h *= 60;
  }
  return [h, max > 0 ? d / max : 0, max];
}

function morph(mask: Uint8Array, width: number, height: number, grow: boolean): Uint8Array {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let v = grow ? 0 : 1;
      for (let dy = -1; dy <= 1 && v === (grow ? 0 : 1); dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const X = x + dx;
          const Y = y + dy;
          const s = X < 0 || Y < 0 || X >= width || Y >= height ? 0 : mask[Y * width + X]!;
          if (grow && s) v = 1;
          if (!grow && !s) v = 0;
        }
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

/**
 * The lit regions of `raster`, in its px. `within` limits the search to a
 * mask (a piece's pixels); without it every opaque pixel counts.
 */
export function detectLights(raster: Raster, mode: LightMode, rules: LightRules = DEFAULT_LIGHT_RULES, within?: Uint8Array): LightRegion[] {
  const { width, height, data } = raster;
  let mask: Uint8Array = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    if ((data[i + 3] ?? 0) < 128 || (within && !within[p])) continue;
    const [h, s, v] = hsv(data[i]!, data[i + 1]!, data[i + 2]!);
    if (mode === 'body') {
      if (v >= rules.body.minValue) mask[p] = 1;
      continue;
    }
    const { lit } = rules;
    const warm = v >= lit.minValue && h >= lit.hue[0] && h <= lit.hue[1] && s >= lit.minSat;
    const core = v >= lit.core.minValue && s <= lit.core.maxSat;
    if (warm || core) mask[p] = 1;
  }
  for (let k = 0; k < rules.open; k += 1) mask = morph(mask, width, height, false);
  for (let k = 0; k < rules.open; k += 1) mask = morph(mask, width, height, true);

  type Comp = { n: number; sx: number; sy: number; r: number; g: number; b: number; v: number; x0: number; y0: number; x1: number; y1: number };
  const label = new Int32Array(width * height).fill(-1);
  const comps: Comp[] = [];
  for (let p = 0; p < width * height; p += 1) {
    if (!mask[p] || label[p]! >= 0) continue;
    const c: Comp = { n: 0, sx: 0, sy: 0, r: 0, g: 0, b: 0, v: 0, x0: width, y0: height, x1: -1, y1: -1 };
    label[p] = comps.length;
    const stack = [p];
    while (stack.length) {
      const q = stack.pop()!;
      const x = q % width;
      const y = (q - x) / width;
      c.n += 1;
      c.sx += x + 0.5;
      c.sy += y + 0.5;
      c.r += data[q * 4]!;
      c.g += data[q * 4 + 1]!;
      c.b += data[q * 4 + 2]!;
      c.v += Math.max(data[q * 4]!, data[q * 4 + 1]!, data[q * 4 + 2]!) / 255;
      c.x0 = Math.min(c.x0, x);
      c.y0 = Math.min(c.y0, y);
      c.x1 = Math.max(c.x1, x);
      c.y1 = Math.max(c.y1, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const X = x + dx;
          const Y = y + dy;
          if (X < 0 || Y < 0 || X >= width || Y >= height) continue;
          const n = Y * width + X;
          if (mask[n] && label[n]! < 0) {
            label[n] = comps.length;
            stack.push(n);
          }
        }
      }
    }
    comps.push(c);
  }
  let keep = comps.filter((c) => c.n >= rules.minArea && Math.min(c.x1 - c.x0, c.y1 - c.y0) + 1 >= rules.minThick).sort((a, b) => b.n - a.n);
  if (mode === 'body') keep = keep.slice(0, 1);
  else if (keep[0]) keep = keep.filter((c) => c.n >= rules.minShare * keep[0]!.n);
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return keep
    .map((c) => ({
      x: round(c.sx / c.n),
      y: round(c.sy / c.n),
      radius: round(Math.sqrt(c.n / Math.PI)),
      color: `#${hex(c.r / c.n)}${hex(c.g / c.n)}${hex(c.b / c.n)}`,
      intensity: round(c.v / c.n),
    }))
    .sort((a, b) => a.x - b.x || a.y - b.y);
}

const round = (v: number, places = 2) => Math.round(v * 10 ** places) / 10 ** places;

/**
 * A lit piece of a split as a template: its pixels on the base canvas
 * (`mask`, in base px) and the lights found on it (base px).
 */
export type LitTemplate = Readonly<{ id: string; mask: Uint8Array; lights: readonly LightRegion[] }>;

/** A copy of a lit piece left on the plate, with the lights it gives. */
export type LitCopy = Readonly<{ of: string; x: number; y: number; score: number; lights: LightRegion[] }>;

export type CopyRules = {
  /** Lowest normalised cross-correlation of the copy's pixels with the piece's (per-channel, zero-mean). */
  minScore: number;
  /** Largest RGB distance between the mean colours of the copy and the piece. */
  maxColor: number;
  /** Largest share of the piece's pixels that may fall on transparent pixels or on the pieces themselves. */
  maxMissing: number;
  /** Template samples used per piece, at most. */
  samples: number;
};

export const DEFAULT_COPY_RULES: CopyRules = { minScore: 0.72, maxColor: 48, maxMissing: 0.12, samples: 600 };

/**
 * Lit regions left on the plate of a split: copies of a lit piece that the
 * plan did not cut out. A plan may cut some lanterns of a row, or some
 * candles of a rack, and leave the rest on the plate; each of those still
 * gives light. Every emitting piece is searched for on the base, outside
 * the pieces (`exclude`), by its shape and shading (normalised
 * cross-correlation) and its colour. Each copy found gives the piece's
 * lights, moved to the copy. In px of `base`.
 */
export function findLitCopies(base: Raster, templates: readonly LitTemplate[], exclude: Uint8Array, rules: CopyRules = DEFAULT_COPY_RULES): LitCopy[] {
  const { width, height, data } = base;
  type Candidate = { of: string; x: number; y: number; score: number; tw: number; th: number; lights: LightRegion[] };
  const candidates: Candidate[] = [];
  for (const template of templates) {
    if (template.lights.length === 0) continue;
    let x0 = width;
    let y0 = height;
    let x1 = -1;
    let y1 = -1;
    const all: number[] = [];
    for (let p = 0; p < width * height; p += 1) {
      if (!template.mask[p] || (data[p * 4 + 3] ?? 0) < 200) continue;
      const x = p % width;
      const y = (p - x) / width;
      all.push(p);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    if (all.length < 16) continue;
    const step = Math.max(1, Math.floor(all.length / rules.samples));
    const points = all.filter((_, i) => i % step === 0);
    const n = points.length;
    const dx = new Int32Array(n);
    const dy = new Int32Array(n);
    const t = new Float64Array(n * 3);
    const mean = [0, 0, 0];
    points.forEach((p, i) => {
      const x = p % width;
      dx[i] = x - x0;
      dy[i] = (p - x) / width - y0;
      for (let c = 0; c < 3; c += 1) {
        t[i * 3 + c] = data[p * 4 + c]!;
        mean[c]! += data[p * 4 + c]! / n;
      }
    });
    let tt = 0;
    for (let i = 0; i < n; i += 1) for (let c = 0; c < 3; c += 1) {
      t[i * 3 + c]! -= mean[c]!;
      tt += t[i * 3 + c]! ** 2;
    }
    if (tt <= 0) continue;
    const tw = x1 - x0 + 1;
    const th = y1 - y0 + 1;
    const w = new Float64Array(n * 3);
    const score = (ox: number, oy: number): { score: number; color: number } | null => {
      let missing = 0;
      const m = [0, 0, 0];
      for (let i = 0; i < n; i += 1) {
        const q = (oy + dy[i]!) * width + ox + dx[i]!;
        if ((data[q * 4 + 3] ?? 0) < 128 || exclude[q]) {
          missing += 1;
          if (missing > rules.maxMissing * n) return null;
        }
        for (let c = 0; c < 3; c += 1) {
          w[i * 3 + c] = data[q * 4 + c]!;
          m[c]! += data[q * 4 + c]! / n;
        }
      }
      const color = Math.hypot(m[0]! - mean[0]!, m[1]! - mean[1]!, m[2]! - mean[2]!);
      if (color > rules.maxColor) return null;
      let tw_ = 0;
      let ww = 0;
      for (let i = 0; i < n; i += 1) for (let c = 0; c < 3; c += 1) {
        const v = w[i * 3 + c]! - m[c]!;
        tw_ += t[i * 3 + c]! * v;
        ww += v * v;
      }
      return ww > 0 ? { score: tw_ / Math.sqrt(tt * ww), color } : null;
    };
    const found: Candidate[] = [];
    for (let oy = 0; oy + th <= height; oy += 2) {
      for (let ox = 0; ox + tw <= width; ox += 2) {
        const s = score(ox, oy);
        if (!s || s.score < rules.minScore - 0.08) continue;
        // Refine to the best position within 1 px.
        let best = { x: ox, y: oy, score: s.score };
        for (let ry = -1; ry <= 1; ry += 1) for (let rx = -1; rx <= 1; rx += 1) {
          const X = ox + rx;
          const Y = oy + ry;
          if (X < 0 || Y < 0 || X + tw > width || Y + th > height) continue;
          const r = score(X, Y);
          if (r && r.score > best.score) best = { x: X, y: Y, score: r.score };
        }
        if (best.score >= rules.minScore) {
          found.push({ of: template.id, x: best.x, y: best.y, score: best.score, tw, th, lights: template.lights.map((l) => ({ x: round(l.x - x0 + best.x), y: round(l.y - y0 + best.y), radius: l.radius, color: l.color, intensity: l.intensity })) });
        }
      }
    }
    candidates.push(...found);
  }
  // One copy per place: the best match wins, the others near it are the same copy.
  candidates.sort((a, b) => b.score - a.score);
  const kept: Candidate[] = [];
  for (const c of candidates) {
    const cx = c.x + c.tw / 2;
    const cy = c.y + c.th / 2;
    if (kept.some((k) => Math.abs(k.x + k.tw / 2 - cx) < Math.min(k.tw, c.tw) * 0.6 && Math.abs(k.y + k.th / 2 - cy) < Math.min(k.th, c.th) * 0.6)) continue;
    kept.push(c);
  }
  return kept.map(({ of, x, y, score, lights }) => ({ of, x, y, score: round(score, 3), lights })).sort((a, b) => a.x - b.x || a.y - b.y);
}

/**
 * Lights for the atlas: `x` and `y` as a share of the frame's content box
 * (0-1 from its top-left), `radius` as a share of the content box's width.
 * `lights` are in frame px.
 */
export function atlasLights(
  lights: readonly LightPoint[],
  content: { x: number; y: number; width: number; height: number },
): { x: number; y: number; radius: number; color?: string; intensity?: number; piece?: string }[] {
  const w = Math.max(1, content.width);
  const h = Math.max(1, content.height);
  return lights.map((l) => ({
    x: round((l.x - content.x) / w, 4),
    y: round((l.y - content.y) / h, 4),
    radius: round(l.radius / w, 4),
    ...(l.color ? { color: l.color } : {}),
    ...(l.intensity !== undefined ? { intensity: l.intensity } : {}),
    ...(l.piece ? { piece: l.piece } : {}),
  }));
}

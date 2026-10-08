/**
 * Renders the multipart prop images for the README from the split targets in
 * examples/: docs/examples/multipart.gif and runeforge.gif (every prop with a
 * moving piece, the pieces turning about their joints) and
 * docs/examples/multipart.png (some
 * props assembled, then their pieces). Run with `npm run showcase`.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve('examples');
const outDir = path.resolve('docs/examples');

const bg = '#FFF4DC';
const ink = '#7A4A2A';
const width = 1600;
const pad = 32;
const gap = 28;
const rowGap = 56;
const propHeight = 260;
const pieceHeight = 110;

// GIF: frames at about 10 fps over one loop with three beats: rest motion all the
// time, a gust of wind that crosses the grid, then each prop used in turn.
// Prop motion is small, so it is scaled up 5x to show. Characters are not.
const frameMs = 96;
const loopMs = 7200;
const gustStartMs = 400;
const gustStepMs = 160; // per grid column
const useStartMs = 2800;
const useSpanMs = 1200; // the last prop is used this long after the first
const cellW = 300;
const cellH = 250;
const columns = 5;

/** Props for the pieces image, in order. */
const featured = ['prop-furin-stand', 'prop-noodle-stall', 'prop-ema-rack', 'prop-hono-chochin', 'prop-koinobori', 'prop-chochin-arch'];
/** Props left out: the hall's pieces carry soft edges of the hall; the mikoshi and drone move only a tiny part. */
const skip = new Set(['prop-shrine-haiden-4', 'prop-mikoshi', 'prop-drone']);

interface Part {
  x: number;
  y: number;
  joint?: { x: number; y: number };
  parent?: string;
  z: number;
  role?: string;
  rig?: { lag?: number; stagger?: number; rest?: Motion; use?: Motion; gust?: Motion };
}
interface Motion {
  kind: string;
  amount: [number, number];
  periodMs?: [number, number];
  durationMs?: [number, number];
}
interface Piece {
  name: string;
  file: string;
  w: number;
  h: number;
  part: Part;
}
interface Prop {
  example: string;
  target: string;
  /** Characters move at their real size: their bones already swing far. */
  boost: number;
  pieces: Piece[];
  box: { x: number; y: number; w: number; h: number };
}

const props: Prop[] = [];
for (const name of fs.readdirSync(root).sort()) {
  const dir = path.join(root, name);
  const configPath = path.join(dir, 'ukiyo.json');
  if (!fs.existsSync(configPath)) continue;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, config.manifest), 'utf8'));
  for (const t of manifest) {
    // Split targets, and parts targets assembled into a rig.
    if (!(t.compose === 'split' || (t.compose === 'parts' && t.rig)) || skip.has(t.target)) continue;
    const gen = path.join(dir, config.out, t.target);
    if (!fs.existsSync(path.join(gen, 'meta.json'))) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(gen, 'meta.json'), 'utf8'));
    const pieces: Piece[] = [];
    for (const [asset, a] of Object.entries<any>(meta.assets)) {
      const file = path.join(gen, 'final', `${asset}.png`);
      if (!a.part || !fs.existsSync(file)) continue;
      pieces.push({ name: asset, file, w: a.width, h: a.height, part: a.part });
    }
    // A split with no plate (only cover pieces) draws its base under the pieces.
    if (!pieces.some((p) => p.part.role === 'plate')) {
      const [baseTarget, baseAsset] = t.base.split('/');
      const file = path.join(dir, config.out, baseTarget, 'final', `${baseAsset}.png`);
      if (!fs.existsSync(file)) continue;
      const { width: w = 0, height: h = 0 } = await sharp(file).metadata();
      pieces.push({ name: 'plate', file, w, h, part: { x: 0, y: 0, z: 0, role: 'plate' } });
    }
    if (!pieces.some((p) => p.part.rig?.rest || p.part.rig?.use || p.part.rig?.gust)) continue;
    pieces.sort((a, b) => a.part.z - b.part.z);
    const x0 = Math.min(...pieces.map((p) => p.part.x));
    const y0 = Math.min(...pieces.map((p) => p.part.y));
    const x1 = Math.max(...pieces.map((p) => p.part.x + p.w));
    const y1 = Math.max(...pieces.map((p) => p.part.y + p.h));
    props.push({ example: name, target: t.target, boost: t.kind === 'character' ? 1 : 5, pieces, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
}
if (!props.length) {
  console.log('no split targets in examples/');
  process.exit(0);
}
// Most pieces first.
props.sort((a, b) => b.pieces.length - a.pieces.length || a.target.localeCompare(b.target));

/** Seeded value in [0, 1) from a string, so each piece keeps its own phase. */
const seed = (s: string) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
};

/** A piece's pose, relative to its rest frame. Angles in degrees, offsets in native px. */
interface Pose {
  a: number;
  dy: number;
  sy: number;
  light: number;
}
const still: Pose = { a: 0, dy: 0, sy: 1, light: 0 };

/** When the gust reaches a prop and when the prop is used, in ms from the loop start. */
interface Cue {
  gust: number;
  use: number;
}

const pick = (band: [number, number] | undefined, r: number, fallback: number) => (band ? band[0] + (band[1] - band[0]) * r : fallback);
/** 1 at the start of an impulse, easing to 0 at its end. */
const decay = (t: number, d: number) => (t < 0 || t > d ? 0 : (1 - t / d) ** 2);

/** Adds one motion at local time t (ms since it started; any t for rest) to a pose. */
function apply(pose: Pose, m: Motion, t: number, r: number, boost: number, loop: boolean): void {
  const amount = pick(m.amount, r, 0) * boost;
  const period = pick(m.periodMs, r, 600);
  const d = pick(m.durationMs, r, period * 2);
  // Rest loops use whole cycles per loop so the GIF loops without a jump.
  const phase = loop ? (2 * Math.PI * Math.max(1, Math.round(loopMs / period)) * t) / loopMs + r * 2 * Math.PI : (2 * Math.PI * t) / period;
  const env = loop ? 1 : decay(t, d);
  if (!loop && env === 0) return;
  switch (m.kind) {
    case 'swing':
    case 'flutter':
    case 'sway':
      pose.a += amount * Math.sin(phase) * env;
      break;
    case 'shake':
      // One cycle per two frames: any faster aliases to a slow drift.
      pose.a += amount * Math.sin((2 * Math.PI * t) / (frameMs * 2) + Math.PI / 2) * env;
      break;
    case 'hop':
      // Amount in world px; native art is about 4x that.
      if (!loop && t <= d) pose.dy -= amount * 4 * Math.sin((Math.PI * t) / d);
      break;
    case 'stretch':
      pose.sy += (amount / boost) * 2 * Math.sin(phase) * env;
      break;
    case 'spin':
      // Degrees per second; rounded to whole turns per loop.
      pose.a += (360 * Math.max(1, Math.round((amount / boost) * (loopMs / 1000) / 360)) * t) / loopMs;
      break;
    case 'glow':
    case 'shimmer':
    case 'flicker':
      pose.light += (amount / boost) * 1.5 * (0.5 + 0.5 * Math.sin(phase));
      break;
  }
}

/** The pose of a piece at loop time t, before its parent's turn. */
function pose(p: Piece, t: number, cue: Cue, depth: number, sibling: number, boost: number): Pose {
  const rig = p.part.rig;
  const out = { ...still };
  if (!rig) return out;
  const r = seed(p.name);
  // A child starts its impulse `lag` ms per level after the root; siblings `stagger` ms apart.
  // Capped so the last impulse ends before the loop does.
  const delay = (rig.lag ?? 0) * depth + (rig.stagger ?? 0) * Math.min(sibling, 4);
  if (rig.rest) apply(out, rig.rest, t, r, rig.rest.kind === 'spin' ? 1 : boost, true);
  if (rig.gust) apply(out, rig.gust, t - cue.gust - delay, r, boost, false);
  if (rig.use) apply(out, rig.use, t - cue.use - delay, r, boost, false);
  return out;
}

/** Composites a prop at native size, each piece posed about its joint. `t` null draws the rest frame. */
async function assemble(prop: Prop, t: number | null, cue: Cue = { gust: 0, use: 0 }): Promise<Buffer> {
  const byName = new Map(prop.pieces.map((p) => [p.name, p]));
  const depthOf = (p: Piece): number => (p.part.parent && byName.get(p.part.parent) ? 1 + depthOf(byName.get(p.part.parent)!) : 0);
  // Index among pieces of the same material, for the stagger.
  const siblingOf = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const p of prop.pieces) {
    const key = JSON.stringify(p.part.rig?.rest ?? p.part.rig?.use ?? null);
    siblingOf.set(p.name, counts.get(key) ?? 0);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const world = new Map<string, { a: number; jx: number; jy: number; pose: Pose }>();
  const place = (p: Piece): { a: number; jx: number; jy: number; pose: Pose } => {
    const done = world.get(p.name);
    if (done) return done;
    const j = p.part.joint ?? { x: p.w / 2, y: p.h / 2 };
    let jx = p.part.x + j.x;
    let jy = p.part.y + j.y;
    const own = t === null ? still : pose(p, t, cue, depthOf(p), siblingOf.get(p.name) ?? 0, prop.boost);
    let a = own.a;
    jy += own.dy;
    const parent = p.part.parent ? byName.get(p.part.parent) : undefined;
    if (parent) {
      // Move this joint with the parent, about the parent's rest joint.
      const pw = place(parent);
      const pj = parent.part.joint ?? { x: parent.w / 2, y: parent.h / 2 };
      const px = parent.part.x + pj.x;
      const py = parent.part.y + pj.y;
      const rad = (pw.a * Math.PI) / 180;
      const dx = jx - px;
      const dy = jy - py;
      jx = pw.jx + dx * Math.cos(rad) - dy * Math.sin(rad);
      jy = pw.jy + dx * Math.sin(rad) + dy * Math.cos(rad);
      a += pw.a;
    }
    const w = { a, jx, jy, pose: own };
    world.set(p.name, w);
    return w;
  };

  const margin = Math.round(Math.max(prop.box.w, prop.box.h) * 0.08);
  // Draw on a larger canvas so a moved piece never overflows it, then crop.
  const big = margin + Math.max(...prop.pieces.map((p) => Math.hypot(p.w, p.h)));
  const off = Math.ceil(big - margin);
  const layers: sharp.OverlayOptions[] = [];
  for (const p of prop.pieces) {
    const w = place(p);
    const j = p.part.joint ?? { x: p.w / 2, y: p.h / 2 };
    const { sy, light } = w.pose;
    if (Math.abs(w.a) < 0.01 && Math.abs(sy - 1) < 0.002 && light < 0.005) {
      layers.push({
        input: p.file,
        left: Math.round(w.jx - j.x - prop.box.x + margin) + off,
        top: Math.round(w.jy - j.y - prop.box.y + margin) + off,
      });
      continue;
    }
    let img = sharp(p.file);
    let jy = j.y;
    let h = p.h;
    if (Math.abs(sy - 1) >= 0.002) {
      // Stretch about the joint.
      h = Math.max(1, Math.round(p.h * sy));
      jy = j.y * sy;
      img = sharp(await img.resize(p.w, h, { fit: 'fill' }).png().toBuffer());
    }
    if (light >= 0.005) img = sharp(await img.modulate({ brightness: 1 + light }).png().toBuffer());
    // Pad so the joint is the centre, then turn about the centre.
    const R = Math.ceil(Math.max(Math.hypot(j.x, jy), Math.hypot(p.w - j.x, jy), Math.hypot(j.x, h - jy), Math.hypot(p.w - j.x, h - jy))) + 1;
    const padded = await img
      .extend({ left: R - Math.round(j.x), top: R - Math.round(jy), right: R - p.w + Math.round(j.x), bottom: R - h + Math.round(jy), background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .rotate(w.a, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer({ resolveWithObject: true });
    layers.push({
      input: padded.data,
      left: Math.round(w.jx - padded.info.width / 2 - prop.box.x + margin) + off,
      top: Math.round(w.jy - padded.info.height / 2 - prop.box.y + margin) + off,
    });
  }
  const drawn = await sharp({
    create: { width: prop.box.w + (margin + off) * 2, height: prop.box.h + (margin + off) * 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(layers)
    .png()
    .toBuffer();
  return sharp(drawn)
    .extract({ left: off, top: off, width: prop.box.w + margin * 2, height: prop.box.h + margin * 2 })
    .png()
    .toBuffer();
}

const trimmed = async (input: Buffer | string, height: number) => {
  const t = await sharp(input).trim({ threshold: 1 }).png().toBuffer();
  return sharp(t).resize({ height }).png().toBuffer({ resolveWithObject: true });
};

fs.mkdirSync(outDir, { recursive: true });

// Static image: the assembled prop, then its pieces.
{
  const layers: sharp.OverlayOptions[] = [];
  let y = 110;
  const shown = featured.map((t) => props.find((p) => p.target === t)).filter((p): p is Prop => Boolean(p));
  for (const prop of shown) {
    const whole = await trimmed(await assemble(prop, null), propHeight);
    const wholeW = Math.min(whole.info.width, 640);
    const wholeBuf = wholeW < whole.info.width ? await sharp(whole.data).resize({ width: wholeW }).png().toBuffer({ resolveWithObject: true }) : whole;
    layers.push({ input: wholeBuf.data, left: pad, top: y + propHeight - wholeBuf.info.height });

    // Pieces scaled together, laid out in lines to the right.
    const left = pad + wholeBuf.info.width + 96;
    // Scale by the median piece so one big piece does not shrink the rest.
    const hs = prop.pieces.filter((p) => p.part.role !== 'plate').map((p) => p.h).sort((a, b) => a - b);
    const scale = (pieceHeight * 0.7) / (hs[Math.floor(hs.length / 2)] ?? 1);
    let x = left;
    let line = y;
    let lineH = 0;
    for (const p of prop.pieces) {
      const isPlate = p.part.role === 'plate';
      const img = await sharp(p.file).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
      const h = isPlate ? Math.min(propHeight - pieceHeight - gap, Math.round(img.info.height * scale)) : Math.min(propHeight - gap, Math.max(56, Math.round(img.info.height * scale)));
      const buf = await sharp(img.data).resize({ height: h }).png().toBuffer({ resolveWithObject: true });
      if (x + buf.info.width > width - pad) {
        x = left;
        line += lineH + gap;
        lineH = 0;
      }
      layers.push({ input: buf.data, left: x, top: line });
      x += buf.info.width + gap;
      lineH = Math.max(lineH, buf.info.height);
    }
    y = Math.max(y + propHeight, line + lineH) + rowGap;
  }
  const height = y + pad - rowGap;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="${width}" height="${height}" fill="${bg}"/>
<text x="${pad}" y="58" font-family="Helvetica, Arial, sans-serif" font-size="38" font-weight="700" fill="${ink}">Multipart props</text>
<text x="${pad}" y="90" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="${ink}" opacity="0.75">Each prop assembled from its parts (left) and the parts split cuts out of it (right)</text>
</svg>`;
  const file = path.join(outDir, 'multipart.png');
  await sharp(Buffer.from(svg)).composite(layers).png({ palette: true, quality: 95, compressionLevel: 9 }).toFile(file);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

/** GIF: props in a grid, each piece moved about its joint. */
async function writeGif(props: Prop[], file: string): Promise<void> {
  const rows = Math.ceil(props.length / columns);
  const gifW = columns * cellW + pad * 2;
  const gifH = rows * cellH + pad * 2;
  // Each prop is scaled once, from its rest frame, so it does not change size as it moves.
  const scales = await Promise.all(
    props.map(async (prop) => {
      const m = await sharp(await assemble(prop, null)).metadata();
      return Math.min((cellW - gap) / m.width!, (cellH - gap) / m.height!);
    }),
  );
  const frames: Buffer[] = [];
  for (let t = 0; t < loopMs; t += frameMs) {
    const layers: sharp.OverlayOptions[] = [];
    for (const [i, prop] of props.entries()) {
      const col = i % columns;
      const row = Math.floor(i / columns);
      // The gust crosses left to right; props are used in a shuffled order so neighbours differ.
      const cue = { gust: gustStartMs + col * gustStepMs + row * 60, use: useStartMs + (((i * 7) % props.length) / props.length) * useSpanMs };
      const full = await assemble(prop, t, cue);
      const m = await sharp(full).metadata();
      const w = Math.max(1, Math.round(m.width! * scales[i]!));
      const h = Math.max(1, Math.round(m.height! * scales[i]!));
      const img = await sharp(full).resize(w, h).png().toBuffer();
      layers.push({ input: img, left: pad + col * cellW + Math.round((cellW - w) / 2), top: pad + row * cellH + (cellH - gap / 2 - h) });
    }
    frames.push(
      await sharp({ create: { width: gifW, height: gifH, channels: 4, background: bg } })
        .composite(layers)
        .flatten({ background: bg })
        .png()
        .toBuffer(),
    );
  }
  await sharp(frames, { join: { animated: true } })
    .gif({ delay: frameMs, loop: 0, effort: 10 })
    .toFile(file);
  console.log(`wrote ${path.relative(process.cwd(), file)} (${props.length} props: ${props.map((p) => p.target).join(' ')})`);
}

// Runeforge (warriors and staffs) gets its own GIF to keep each file small.
await writeGif(props.filter((p) => p.example !== 'runeforge'), path.join(outDir, 'multipart.gif'));
await writeGif(props.filter((p) => p.example === 'runeforge'), path.join(outDir, 'runeforge.gif'));

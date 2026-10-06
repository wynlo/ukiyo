/**
 * Renders the multipart prop images for the README from the split targets in
 * examples/: docs/examples/multipart.png (each prop assembled, then its
 * pieces) and docs/examples/multipart.gif (the pieces moving about their
 * joints). Run with `npm run showcase`.
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

// GIF: frames at 12.5 fps. Rest motion is small, so it is scaled up to show.
const frameMs = 80;
const loopMs = 2400;
const boost = 4;
const gifHeight = 260;
const gifProps = 5;

interface Part {
  x: number;
  y: number;
  joint?: { x: number; y: number };
  parent?: string;
  z: number;
  role?: string;
  rig?: { rest?: { kind: string; amount: [number, number]; periodMs: [number, number] } };
}
interface Piece {
  name: string;
  file: string;
  w: number;
  h: number;
  part: Part;
}
interface Prop {
  target: string;
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
    if (t.compose !== 'split') continue;
    const gen = path.join(dir, config.out, t.target);
    const meta = JSON.parse(fs.readFileSync(path.join(gen, 'meta.json'), 'utf8'));
    const pieces: Piece[] = [];
    for (const [asset, a] of Object.entries<any>(meta.assets)) {
      const file = path.join(gen, 'final', `${asset}.png`);
      if (!a.part || !fs.existsSync(file)) continue;
      pieces.push({ name: asset, file, w: a.width, h: a.height, part: a.part });
    }
    // A split with no plate draws its base under the pieces; skip those here.
    if (!pieces.some((p) => p.part.role === 'plate')) continue;
    pieces.sort((a, b) => a.part.z - b.part.z);
    const x0 = Math.min(...pieces.map((p) => p.part.x));
    const y0 = Math.min(...pieces.map((p) => p.part.y));
    const x1 = Math.max(...pieces.map((p) => p.part.x + p.w));
    const y1 = Math.max(...pieces.map((p) => p.part.y + p.h));
    props.push({ target: t.target, pieces, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
}
if (!props.length) {
  console.log('no split targets in examples/');
  process.exit(0);
}
// Biggest prop first.
props.sort((a, b) => b.pieces.length - a.pieces.length);

/** Seeded value in [0, 1) from a string, so each piece keeps its own phase. */
const seed = (s: string) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return ((h >>> 0) % 10000) / 10000;
};

/** Angle in degrees of a piece at time t, from its rest motion. */
const angle = (p: Piece, t: number) => {
  const rest = p.part.rig?.rest;
  if (!rest || (rest.kind !== 'swing' && rest.kind !== 'flutter')) return 0;
  const r = seed(p.name);
  const amount = (rest.amount[0] + (rest.amount[1] - rest.amount[0]) * r) * boost;
  const period = rest.periodMs[0] + (rest.periodMs[1] - rest.periodMs[0]) * r;
  // Whole cycles per loop so the GIF loops without a jump.
  const cycles = Math.max(1, Math.round(loopMs / period));
  return amount * Math.sin((2 * Math.PI * cycles * t) / loopMs + r * 2 * Math.PI);
};

/** Composites a prop at native size, each piece turned about its joint. */
async function assemble(prop: Prop, t: number | null): Promise<Buffer> {
  const byName = new Map(prop.pieces.map((p) => [p.name, p]));
  const world = new Map<string, { a: number; jx: number; jy: number }>();
  const place = (p: Piece): { a: number; jx: number; jy: number } => {
    const done = world.get(p.name);
    if (done) return done;
    const j = p.part.joint ?? { x: p.w / 2, y: p.h / 2 };
    let jx = p.part.x + j.x;
    let jy = p.part.y + j.y;
    let a = t === null ? 0 : angle(p, t);
    const parent = p.part.parent ? byName.get(p.part.parent) : undefined;
    if (parent) {
      // Turn this joint with the parent, about the parent's rest joint.
      const pw = place(parent);
      const pj = parent.part.joint ?? { x: parent.w / 2, y: parent.h / 2 };
      const px = parent.part.x + pj.x;
      const py = parent.part.y + pj.y;
      const r = (pw.a * Math.PI) / 180;
      const dx = jx - px;
      const dy = jy - py;
      jx = pw.jx + dx * Math.cos(r) - dy * Math.sin(r);
      jy = pw.jy + dx * Math.sin(r) + dy * Math.cos(r);
      a += pw.a;
    }
    const w = { a, jx, jy };
    world.set(p.name, w);
    return w;
  };

  const margin = Math.round(Math.max(prop.box.w, prop.box.h) * 0.08);
  // Draw on a larger canvas so a turned piece never overflows it, then crop.
  const big = margin + Math.max(...prop.pieces.map((p) => Math.hypot(p.w, p.h)));
  const off = Math.ceil(big - margin);
  const layers: sharp.OverlayOptions[] = [];
  for (const p of prop.pieces) {
    const w = place(p);
    const j = p.part.joint ?? { x: p.w / 2, y: p.h / 2 };
    if (Math.abs(w.a) < 0.01) {
      layers.push({
        input: p.file,
        left: Math.round(w.jx - j.x - prop.box.x + margin) + off,
        top: Math.round(w.jy - j.y - prop.box.y + margin) + off,
      });
      continue;
    }
    // Pad so the joint is the centre, then turn about the centre.
    const R = Math.ceil(Math.max(Math.hypot(j.x, j.y), Math.hypot(p.w - j.x, j.y), Math.hypot(j.x, p.h - j.y), Math.hypot(p.w - j.x, p.h - j.y)));
    const padded = await sharp(p.file)
      .extend({ left: R - Math.round(j.x), top: R - Math.round(j.y), right: R - p.w + Math.round(j.x), bottom: R - p.h + Math.round(j.y), background: { r: 0, g: 0, b: 0, alpha: 0 } })
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
  for (const prop of props) {
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

// GIF: the first props in a row, every piece moving about its joint.
{
  // Wide props read too small at the GIF height; leave them to the static image.
  const chosen = props.filter((p) => p.box.w / p.box.h < 1.6).slice(0, gifProps);
  const frames: Buffer[] = [];
  let gifW = 0;
  const gifH = gifHeight + pad * 2;
  for (let t = 0; t < loopMs; t += frameMs) {
    const layers: sharp.OverlayOptions[] = [];
    let x = pad;
    for (const prop of chosen) {
      // Same crop every frame: scale from the native canvas, not a trim.
      const full = await assemble(prop, t);
      const m = await sharp(full).metadata();
      const s = gifHeight / m.height!;
      const img = await sharp(full).resize({ height: gifHeight }).png().toBuffer();
      layers.push({ input: img, left: x, top: pad });
      x += Math.round(m.width! * s) + gap;
    }
    gifW = x - gap + pad;
    frames.push(
      await sharp({ create: { width: gifW, height: gifH, channels: 4, background: bg } })
        .composite(layers)
        .flatten({ background: bg })
        .png()
        .toBuffer(),
    );
  }
  const file = path.join(outDir, 'multipart.gif');
  await sharp(frames, { join: { animated: true } })
    .gif({ delay: frameMs, loop: 0, effort: 10 })
    .toFile(file);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

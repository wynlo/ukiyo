/**
 * Checks of the part planner (`src/ops/plan.ts`) on drawn scenes. No provider
 * is called. Run with `npm run check:plan`.
 *
 * The main scene is a row of paper lanterns on a rope between two posts:
 * red lanterns with brown caps, cream lanterns with red caps, and a cream
 * rope the same colour as the cream lanterns. Each lantern hangs from the
 * rope on a short cord.
 */
import assert from 'node:assert/strict';
import sharp from 'sharp';
import type { RigConfig } from '../src/config.js';
import { outline, planPieces, type Label, type PlannedPiece } from '../src/ops/plan.js';
import { colorDistance, parseHex, readRaster, type Raster } from '../src/ops/raster.js';
import { selectPiece } from '../src/ops/split.js';

const W = 480;
const H = 200;
const RED = { body: '#e73726', shade: '#c92a1c', cap: '#7c4a25', rim: '#6b3d1f' };
const CREAM = { body: '#fde6b6', shade: '#f6ba75', cap: '#d8442c', rim: '#b92a1c' };
const CORD = '#5b3816';
const ROPE = '#fde6b6';
const POST = '#f39626';
const POST_SHADE = '#d87917';
const TOLERANCE = 30;

const swing = { kind: 'swing' as const, amount: [1, 1] as [number, number], periodMs: [3000, 3000] as [number, number] };
const rig = {
  materials: {
    lantern: { describe: 'a paper lantern', pivot: 'contact-top', lag: 0, rest: swing },
    canopy: { describe: 'a leafy crown', pivot: 'contact-bottom', lag: 0 },
  },
  kinds: {},
  score: { regions: [0, 1, 1], protrusion: [0, 1, 1], edges: [0, 1, 1], components: [0, 1, 1] },
  stagger: 0,
  triggers: [],
  exclude: [],
  prefix: 'prop-',
} as unknown as RigConfig;

/** The rope's lower edge at `x`: a sag between the posts. */
const ropeY = (x: number) => 40 + 34 * (1 - ((x - 240) / 196) ** 2);
const centres = [120, 180, 240, 300, 360];

function lanternSvg(i: number): string {
  const cx = centres[i]!;
  const c = i % 2 === 0 ? RED : CREAM;
  const top = ropeY(cx) + 4;
  const capY = top + 5;
  const bodyY = capY + 8 + 28;
  return [
    `<rect x="${cx - 2}" y="${top - 1}" width="4" height="7" fill="${CORD}"/>`,
    `<rect x="${cx - 12}" y="${capY}" width="24" height="9" rx="2" fill="${c.cap}"/>`,
    `<ellipse cx="${cx}" cy="${bodyY}" rx="27" ry="28" fill="${c.body}"/>`,
    `<ellipse cx="${cx + 9}" cy="${bodyY + 4}" rx="14" ry="20" fill="${c.shade}"/>`,
    `<rect x="${cx - 11}" y="${bodyY + 26}" width="22" height="7" rx="2" fill="${c.rim}"/>`,
  ].join('');
}

function ropeSvg(): string {
  const pts: string[] = [];
  for (let x = 44; x <= 436; x += 4) pts.push(`${x},${ropeY(x) - 4}`);
  return `<polyline points="${pts.join(' ')}" fill="none" stroke="${ROPE}" stroke-width="8"/>`;
}

const postsSvg = () =>
  [20, 436].map((x) => `<rect x="${x}" y="10" width="24" height="190" fill="${POST}"/><rect x="${x + 16}" y="10" width="8" height="190" fill="${POST_SHADE}"/>`).join('');

async function draw(body: string): Promise<Raster> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${body}</svg>`;
  return readRaster(await sharp(Buffer.from(svg)).png().toBuffer());
}

/** Opaque pixels of `raster`. */
const solid = (raster: Raster) => {
  const out = new Uint8Array(raster.width * raster.height);
  for (let p = 0; p < out.length; p += 1) if ((raster.data[p * 4 + 3] ?? 0) >= 128) out[p] = 1;
  return out;
};

/** The masks the manifest gives for `pieces`, cut in list order as `ukiyo final` does. */
function cut(base: Raster, pieces: readonly PlannedPiece[]): Map<string, Uint8Array> {
  const taken = new Uint8Array(base.width * base.height);
  const out = new Map<string, Uint8Array>();
  for (const piece of pieces) {
    const mask = selectPiece(base, { ...piece, fillHoles: true }, taken);
    for (let p = 0; p < mask.length; p += 1) if (mask[p]) taken[p] = 1;
    out.set(piece.id, mask);
  }
  return out;
}

async function lanternRow(): Promise<void> {
  const base = await draw(postsSvg() + ropeSvg() + centres.map((_, i) => lanternSvg(i)).join(''));
  const truth = await Promise.all(centres.map(async (_, i) => solid(await draw(lanternSvg(i)))));
  const art = solid(base);
  // Rough labels, as a model gives them: the boxes miss the cord and part of the rim.
  const labels: Label[] = centres.map((cx, i) => ({
    label: `lantern ${i + 1}`,
    material: 'lantern',
    box: [cx - 26, ropeY(cx) + 12, cx + 26, ropeY(cx) + 70],
    seed: [cx - 6, ropeY(cx) + 40],
  }));
  const { pieces, dropped } = planPieces(base, labels, rig, 8);
  assert.deepEqual(dropped, [], 'every lantern is planned');
  assert.equal(pieces.length, 5);
  const masks = cut(base, pieces);
  centres.forEach((cx, i) => {
    const piece = pieces.find((p) => p.id === `lantern-${i + 1}`)!;
    const own = i % 2 === 0 ? RED : CREAM;
    const mask = masks.get(piece.id)!;
    const t = truth[i]!;
    let hit = 0;
    let size = 0;
    let stray = 0;
    for (let p = 0; p < t.length; p += 1) {
      if (t[p] && art[p]) {
        size += 1;
        if (mask[p]) hit += 1;
      } else if (mask[p] && art[p]) stray += 1;
    }
    // The mask holds the whole lantern: cap, cord, body, shading and rim.
    assert.ok(hit / size >= 0.97, `lantern ${i + 1}: the mask holds ${((100 * hit) / size).toFixed(1)}% of the lantern`);
    // And nothing else: no rope, no post, no neighbour.
    assert.ok(stray / size <= 0.03, `lantern ${i + 1}: the mask takes ${stray} px that are not the lantern`);
    // `except` never holds a colour of the piece itself.
    for (const colour of [...Object.values(own), CORD]) {
      const c = parseHex(colour);
      for (const e of piece.except ?? []) {
        const x = parseHex(e);
        assert.ok(colorDistance(c.r, c.g, c.b, x.r, x.g, x.b) > TOLERANCE, `lantern ${i + 1}: except ${e} is its own colour ${colour}`);
      }
    }
    // A red lantern excludes the cream of its neighbours and the rope. A cream lantern cannot: the rope and
    // the red lanterns are kept out by the carrier and the cores (the stray check above).
    const has = (list: readonly string[] | undefined, colour: string) => {
      const c = parseHex(colour);
      return (list ?? []).some((e) => {
        const x = parseHex(e);
        return colorDistance(c.r, c.g, c.b, x.r, x.g, x.b) <= TOLERANCE;
      });
    };
    if (i % 2 === 0) assert.ok(has(piece.except, CREAM.body), `lantern ${i + 1}: a red lantern excludes cream`);
    // The joint is the hook: the top of the cord, under the rope, on the lantern's axis.
    const [jx, jy] = piece.joint;
    assert.ok(Math.abs(jx - cx) <= 2, `lantern ${i + 1}: joint x ${jx}, the cord is at ${cx}`);
    assert.ok(Math.abs(jy - (ropeY(cx) + 3)) <= 2, `lantern ${i + 1}: joint y ${jy}, the cord starts at ${Math.round(ropeY(cx) + 3)}`);
    assert.ok(mask[jy * W + jx] || mask[(jy + 1) * W + jx], `lantern ${i + 1}: the joint is on the piece`);
  });

  // A locked piece keeps its pixels: the plan cuts round it and does not plan its label again.
  const keep = [{ ...pieces.find((p) => p.id === 'lantern-3')! }];
  const again = planPieces(base, labels, rig, 8, keep);
  assert.ok(!again.pieces.some((p) => p.id === 'lantern-3'), 'the locked label is not planned again');
  assert.ok(again.dropped.some((d) => d.includes('locked')), 'the report names the locked label');
  const kept = masks.get('lantern-3')!;
  const others = cut(base, [...keep, ...again.pieces] as PlannedPiece[]);
  for (const [id, mask] of others) {
    if (id === 'lantern-3') continue;
    for (let p = 0; p < mask.length; p += 1) assert.ok(!(mask[p] && kept[p]), `${id} takes a pixel of the locked piece`);
  }
}

async function canopyOnTrunk(): Promise<void> {
  // A piece that does not hang keeps the box rules: the trunk that rings the box is excluded, the leaves are not.
  const base = await draw(`<rect x="110" y="90" width="20" height="100" fill="#7a4a2a"/><ellipse cx="120" cy="70" rx="60" ry="40" fill="#6f9a3c"/><ellipse cx="130" cy="60" rx="30" ry="20" fill="#8cb34a"/>`);
  const { pieces } = planPieces(base, [{ label: 'canopy', material: 'canopy', box: [62, 32, 178, 108], seed: [110, 80] }], rig, 4);
  const piece = pieces[0]!;
  const near = (colour: string) =>
    (piece.except ?? []).some((e) => {
      const a = parseHex(colour);
      const b = parseHex(e);
      return colorDistance(a.r, a.g, a.b, b.r, b.g, b.b) <= TOLERANCE;
    });
  assert.ok(near('#7a4a2a'), 'the trunk colour is excluded');
  assert.ok(!near('#6f9a3c'), 'the leaf colour at the seed is not excluded');
  assert.equal(piece.poly, undefined, 'no outline for a piece that does not hang');
}

function outlines(): void {
  // Blocks, a diagonal chain and a single pixel that touches at a corner: one outline, the same pixels.
  const w = 40;
  const h = 30;
  const mask = new Uint8Array(w * h);
  const fill = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) mask[y * w + x] = 1;
  };
  fill(5, 5, 20, 15);
  fill(12, 15, 16, 25);
  for (let k = 0; k < 8; k += 1) mask[(15 + k) * w + 20 + k] = 1;
  mask[4 * w + 4] = 1;
  const poly = outline(mask, w, h);
  const flat: Raster = { data: Buffer.alloc(w * h * 4, 255), width: w, height: h, channels: 4 };
  const back = selectPiece(flat, { id: 'x', poly, tolerance: 1, fillHoles: false }, new Uint8Array(w * h));
  for (let p = 0; p < mask.length; p += 1) assert.equal(back[p], mask[p], `outline: pixel ${p % w},${Math.floor(p / w)}`);
  assert.ok(poly.length < 60, `outline: ${poly.length} points, simplified`);
}

async function main() {
  outlines();
  await lanternRow();
  await canopyOnTrunk();
  console.log('plan: all checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

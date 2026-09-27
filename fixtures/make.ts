/**
 * Builds the smoke-test fixtures: a project folder with ukiyo.json, the starter
 * style file, a manifest, and "generated" PNGs drawn with SVG on a white background. Run with
 * `npm run fixtures`, then `cd fixtures/out && ukiyo cut && ukiyo final && ukiyo sheet`.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { renderStyle, starterStyle } from '../src/style.js';

const root = path.resolve('fixtures/out');
const bg = '#F7EEDC';
const ink = '#4A3328';

fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(path.join(root, 'art'), { recursive: true });

const blob = (cx: number, cy: number, r: number, fill: string, extra = '') =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r * 0.9}" fill="${fill}" stroke="${ink}" stroke-width="6"/>${extra}`;

// A sheet with three items.
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${bg}"/>
${blob(200, 300, 90, '#C9786B')}
${blob(512, 300, 110, '#A7BFA3', `<rect x="452" y="330" width="120" height="70" rx="20" fill="#8FAF8F" stroke="${ink}" stroke-width="6"/>`)}
${blob(824, 300, 80, '#EFD88B')}
</svg>`;

// A strip: same blob in three poses (shifted eye, small hop).
const pose = (x: number, dy: number, eye: number) =>
  `<ellipse cx="${x}" cy="${560 + dy}" rx="120" ry="110" fill="#E9AFA3" stroke="${ink}" stroke-width="6"/><circle cx="${x - 30 + eye}" cy="${540 + dy}" r="10" fill="${ink}"/><circle cx="${x + 30 + eye}" cy="${540 + dy}" r="10" fill="${ink}"/><rect x="${x - 60}" y="${650 + dy}" width="40" height="60" rx="16" fill="#C9786B" stroke="${ink}" stroke-width="6"/><rect x="${x + 20}" y="${650 + dy}" width="40" height="60" rx="16" fill="#C9786B" stroke="${ink}" stroke-width="6"/>`;
const strip = `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1024"><rect width="1536" height="1024" fill="${bg}"/>
${pose(256, 0, 0)}${pose(768, -30, 8)}${pose(1280, 0, -8)}
</svg>`;

// A single counter.
const single = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${bg}"/>
<rect x="160" y="420" width="704" height="300" rx="24" fill="#C89B6A" stroke="${ink}" stroke-width="8"/>
<rect x="140" y="380" width="744" height="60" rx="18" fill="#8B5E3C" stroke="${ink}" stroke-width="8"/>
<rect x="200" y="480" width="120" height="200" rx="12" fill="#6E4429"/>
</svg>`;

// A blob body (tint-ready white) and three "edits" of it, as a layer target
// would get back from the model: moved and rescaled, body in the marker
// colour, with one item added.
const body = (fill: string, extra = '') => `<g><ellipse cx="0" cy="-150" rx="140" ry="150" fill="${fill}" stroke="${ink}" stroke-width="8"/>${extra}</g>`;
const bodySvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${bg}"/>
<g transform="translate(512 800)">${body('#F2EEE8', `<ellipse cx="0" cy="-110" rx="80" ry="70" fill="#DCD6CC"/>`)}</g></svg>`;
const marker = '#8FB3E0';
const markerShade = '#7E9DC4';
const edit = (transform: string, item: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="1024" height="1024" fill="${bg}"/>
<g transform="${transform}">${body(marker, `<ellipse cx="0" cy="-110" rx="80" ry="70" fill="${markerShade}"/>`)}${item}</g></svg>`;
const hat = `<path d="M-90 -285 Q0 -330 90 -285 L70 -380 Q0 -420 -70 -380 Z" fill="#FFFFFF" stroke="${ink}" stroke-width="8"/><rect x="-120" y="-300" width="240" height="30" rx="14" fill="#E4E4E4" stroke="${ink}" stroke-width="8"/>`;
const apron = `<path d="M-95 -170 L95 -170 L120 -20 Q0 20 -120 -20 Z" fill="#FFFFFF" stroke="${ink}" stroke-width="8"/><rect x="-40" y="-120" width="80" height="50" rx="10" fill="#E6E6E6" stroke="${ink}" stroke-width="6"/>`;
const face = `<circle cx="-45" cy="-190" r="12" fill="${ink}"/><circle cx="45" cy="-190" r="12" fill="${ink}"/><path d="M-18 -160 Q0 -145 18 -160" fill="none" stroke="${ink}" stroke-width="7" stroke-linecap="round"/>`;

const manifest = [
  { target: 'items-1', compose: 'sheet', kind: 'item', game: 'demo', category: 'Test items', assets: ['red ball', 'green mug', 'yellow ball'], names: ['red-ball', 'green-mug', 'yellow-ball'] },
  { target: 'pink-guest', compose: 'strip', kind: 'visitor', game: 'demo', subject: 'a pink round guest', frames: ['idle', 'step-a', 'step-b'] },
  { target: 'counter', compose: 'single', kind: 'furniture', game: 'demo', subject: 'a wooden counter', height: 2.5 },
  { target: 'crt-body', compose: 'single', kind: 'visitor', game: 'demo', subject: 'a round blob critter body', tint: 'fur', height: 0.9 },
  {
    target: 'crt-wear', compose: 'layer', kind: 'visitor', game: 'demo', base: 'crt-body/crt-body', subject: 'a round blob critter body', tint: 'fabric', order: 2,
    layers: [ { id: 'chef-hat', label: 'a white chef hat' }, { id: 'apron', label: 'a white apron' } ],
  },
  {
    target: 'crt-faces', compose: 'layer', kind: 'visitor', game: 'demo', base: 'crt-body/crt-body', subject: 'a round blob critter body', order: 1,
    layers: [ { id: 'happy', label: 'a happy face' } ],
  },
];

fs.writeFileSync(
  path.join(root, 'ukiyo.json'),
  JSON.stringify(
    {
      project: { name: 'fixtures', description: 'smoke test' },
      style: { file: 'art/style.md', additionalDetails: '' },
      manifest: 'art/manifest.json',
      out: 'art/generated',
      provider: { name: 'manual' },
      atlas: { dir: 'atlas', scale: 2, unit: 64 },
      tints: { fur: ['#E8A866', '#9C8F84', '#F3E6D2', '#7A5A45'], fabric: ['#A7BFA3', '#EFD88B', '#E9AFA3', '#9BB5C9'] },
    },
    null,
    2,
  ),
);
fs.writeFileSync(path.join(root, 'art/manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(root, 'art/style.md'), renderStyle(starterStyle));

const write = async (name: string, svg: string) => {
  const dir = path.join(root, 'art/generated', name);
  fs.mkdirSync(dir, { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(path.join(dir, 'raw.png'));
};
await write('items-1', sheet);
await write('pink-guest', strip);
await write('counter', single);
await write('crt-body', bodySvg);
const writeFrame = async (target: string, id: string, svg: string) => {
  const dir = path.join(root, 'art/generated', target, 'frames');
  fs.mkdirSync(dir, { recursive: true });
  await sharp(Buffer.from(svg)).png().toFile(path.join(dir, `${id}.png`));
};
// Moved and rescaled the way a model edit drifts.
await writeFrame('crt-wear', 'chef-hat', edit('translate(549 779) scale(1.08)', hat));
await writeFrame('crt-wear', 'apron', edit('translate(490 812) scale(0.93)', apron));
await writeFrame('crt-faces', 'happy', edit('translate(530 790) scale(1.03)', face));
console.log(`fixtures written to ${root}`);

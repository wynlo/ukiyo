/**
 * Renders docs/examples/<name>.png for each project in examples/: one line of
 * final sprites per target on a flat background. Run with `npm run showcase` after
 * `ukiyo all` in each example.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import YAML from 'yaml';

const root = path.resolve('examples');
const outDir = path.resolve('docs/examples');

/** Card colours per example. Default is a light grey. */
const themes: Record<string, { bg: string; ink: string; pixel?: boolean }> = {
  'lucky-cat-shrine': { bg: '#FFF4DC', ink: '#7A4A2A' },
  'ramen-inc': { bg: '#EAF3F7', ink: '#3E5A70' },
  'zen-garden': { bg: '#F3EFE6', ink: '#3F4A3A' },
  'neon-alley': { bg: '#15131F', ink: '#F2F0FF' },
  starfall: { bg: '#1C2340', ink: '#F4F1FF' },
};

const width = 1600;
const pad = 32;
const header = 110;
const gap = 28;
const rowGap = 48;
const minRow = 150;
const maxSprite = 300;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

fs.mkdirSync(outDir, { recursive: true });

for (const name of fs.readdirSync(root).sort()) {
  const dir = path.join(root, name);
  const configPath = path.join(dir, 'ukiyo.json');
  if (!fs.existsSync(configPath)) continue;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, config.manifest), 'utf8'));
  const styleText = fs.readFileSync(path.join(dir, config.style.file), 'utf8');
  const style = YAML.parse(styleText.split('---')[1]);
  const theme = themes[name] ?? { bg: '#F4F4F4', ink: '#222222' };
  const kernel = theme.pixel ? 'nearest' : 'lanczos3';

  // Scale every sprite by the same factor so relative sizes stay true.
  const rows: { sprites: { file: Buffer; w: number; h: number }[]; single: boolean }[] = [];
  let tallest = 1;
  for (const t of manifest) {
    // Style reference sheets only anchor the look. They are not game art.
    if (t.target.endsWith('-style')) continue;
    // Split targets are drawn by scripts/multipart.ts.
    if (t.compose === 'split') continue;
    const gen = path.join(dir, config.out, t.target);
    const finalDir = path.join(gen, 'final');
    if (!fs.existsSync(finalDir)) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(gen, 'meta.json'), 'utf8'));
    const sprites = [];
    for (const asset of Object.keys(meta.assets)) {
      const file = path.join(finalDir, `${asset}.png`);
      if (!fs.existsSync(file)) continue;
      // Drop the transparent padding that final adds for the kind aspect.
      const { data, info } = await sharp(file).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
      sprites.push({ file: data, w: info.width, h: info.height });
      tallest = Math.max(tallest, info.height);
    }
    // Put consecutive one-sprite targets on the same line.
    const last = rows.at(-1);
    if (sprites.length === 1 && last?.single) last.sprites.push(...sprites);
    else rows.push({ sprites, single: sprites.length === 1 });
  }
  if (!rows.length) {
    console.log(`skip ${name}: nothing generated`);
    continue;
  }
  const factor = Math.min(maxSprite / tallest, 1.5);

  const layers: sharp.OverlayOptions[] = [];
  let y = header;
  for (const row of rows) {
    // Each target gets its own line. Small targets are scaled up to a readable size.
    const tall = Math.max(...row.sprites.map((s) => s.h));
    const scale = Math.min(Math.max(minRow / tall, factor), maxSprite / tall);
    const sized = row.sprites.map((s) => ({ ...s, w: Math.round(s.w * scale), h: Math.round(s.h * scale) }));
    const avail = width - pad * 2;
    const total = sized.reduce((a, s) => a + s.w, 0) + gap * (sized.length - 1);
    const fit = Math.min(1, avail / total);
    for (const s of sized) {
      s.w = Math.max(1, Math.round(s.w * fit));
      s.h = Math.max(1, Math.round(s.h * fit));
    }
    const rowH = Math.max(...sized.map((s) => s.h));
    let x = pad + Math.round((avail - (sized.reduce((a, s) => a + s.w, 0) + gap * (sized.length - 1))) / 2);
    for (const s of sized) {
      const buf = await sharp(s.file).resize(s.w, s.h, { kernel }).png().toBuffer();
      layers.push({ input: buf, left: x, top: y + rowH - s.h });
      x += s.w + gap;
    }
    y += rowH + rowGap;
  }
  const height = y + pad - rowGap;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<rect width="${width}" height="${height}" fill="${theme.bg}"/>
<text x="${pad}" y="58" font-family="Helvetica, Arial, sans-serif" font-size="38" font-weight="700" fill="${theme.ink}">${esc(config.project.name)}</text>
<text x="${pad}" y="90" font-family="Helvetica, Arial, sans-serif" font-size="20" fill="${theme.ink}" opacity="0.75">${esc(style.name.replace(/ v\d+$/, ''))} · ${esc(config.project.description)}</text>
</svg>`;

  const file = path.join(outDir, `${name}.png`);
  await sharp(Buffer.from(svg)).composite(layers).png({ palette: true, quality: 95, compressionLevel: 9 }).toFile(file);
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

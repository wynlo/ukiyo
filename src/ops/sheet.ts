import fs from 'node:fs';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';

export type SheetEntry = { name: string; file: string; width: number; height: number };

/** A contact sheet: every frame side by side on the style background. */
export async function contactSheet(entries: SheetEntry[], outFile: string, background: string): Promise<void> {
  if (entries.length === 0) return;
  const gap = 16;
  const cellH = Math.max(...entries.map((e) => e.height)) + gap * 2;
  const width = entries.reduce((sum, e) => sum + e.width + gap, gap);
  const composites: OverlayOptions[] = [];
  let x = gap;
  for (const entry of entries) {
    composites.push({ input: entry.file, left: x, top: gap + Math.round((cellH - gap * 2 - entry.height)) });
    x += entry.width + gap;
  }
  await sharp({ create: { width, height: cellH, channels: 4, background } })
    .composite(composites)
    .png()
    .toFile(outFile);
}

/** A small HTML page that plays the frames at `fps`. Files are referenced relatively. */
export function framePlayer(entries: SheetEntry[], outFile: string, background: string, fps = 6): void {
  const dir = path.dirname(outFile);
  const list = entries.map((e) => ({ name: e.name, src: path.relative(dir, e.file).split(path.sep).join('/'), w: e.width, h: e.height }));
  const html = `<!doctype html>
<meta charset="utf-8">
<title>ukiyo sheet</title>
<style>
  body { margin: 0; padding: 24px; background: ${background}; font: 14px system-ui, sans-serif; color: #4A3328; }
  .row { display: flex; gap: 24px; align-items: flex-end; flex-wrap: wrap; }
  .cell { text-align: center; }
  .cell img { image-rendering: auto; display: block; }
  .player { margin-top: 32px; }
  .player img { display: none; }
  .player img.on { display: block; }
  .scales { display: flex; gap: 32px; align-items: flex-end; }
</style>
<h3>Frames</h3>
<div class="row">
${list.map((e) => `  <div class="cell"><img src="${e.src}" width="${e.w}" height="${e.h}"><div>${e.name}<br>${e.w}x${e.h}</div></div>`).join('\n')}
</div>
${list.length > 1 ? `<div class="player"><h3>Playing at ${fps} fps, at 1x, 0.5x, 0.33x</h3><div class="scales">
${[1, 0.5, 1 / 3].map((s) => `<div class="p" data-scale="${s}">${list.map((e, i) => `<img class="${i === 0 ? 'on' : ''}" src="${e.src}" width="${Math.round(e.w * s)}" height="${Math.round(e.h * s)}">`).join('')}</div>`).join('\n')}
</div></div>
<script>
  let i = 0;
  setInterval(() => {
    i = (i + 1) % ${list.length};
    document.querySelectorAll('.p').forEach((p) => {
      p.querySelectorAll('img').forEach((img, j) => img.classList.toggle('on', j === i));
    });
  }, ${Math.round(1000 / fps)});
</script>` : ''}
`;
  fs.writeFileSync(outFile, html);
}

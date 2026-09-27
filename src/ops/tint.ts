import { luminance, readRaster, writePng } from './raster.js';

/**
 * Make an asset tint-ready: fills become neutral grey, stretched so the
 * lightest fill is white, and dark pixels (the outline, eyes, stitching) keep
 * their colour. A runtime multiply tint then gives the fill exactly the tint
 * colour, its shade step a darker tint, and leaves the outline dark.
 */
const DARK = 70;
const LIGHT = 110;

export async function neutralize(file: string, outFile = file): Promise<void> {
  const raster = await readRaster(file);
  const { data } = raster;
  const fills: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < 128) continue;
    const l = luminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    if (l >= LIGHT) fills.push(l);
  }
  if (fills.length === 0) return;
  fills.sort((a, b) => a - b);
  const white = Math.max(LIGHT + 1, fills[Math.floor(fills.length * 0.9)] ?? 255);
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) === 0) continue;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const l = luminance(r, g, b);
    const grey = Math.min(255, Math.round((l * 255) / white));
    // 0 keeps the original colour (outline), 1 is fully neutral (fill).
    const t = Math.max(0, Math.min(1, (l - DARK) / (LIGHT - DARK)));
    data[i] = Math.round(r + (grey - r) * t);
    data[i + 1] = Math.round(g + (grey - g) * t);
    data[i + 2] = Math.round(b + (grey - b) * t);
  }
  await writePng(raster, outFile);
}

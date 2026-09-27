import sharp, { type Sharp } from 'sharp';

export type Raster = {
  data: Buffer;
  width: number;
  height: number;
  /** Always 4 after `readRaster`. */
  channels: 4;
};

export type Rgb = { r: number; g: number; b: number };

export async function readRaster(source: string | Buffer): Promise<Raster> {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: Buffer.from(data), width: info.width, height: info.height, channels: 4 };
}

export function toSharp(raster: Raster): Sharp {
  return sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } });
}

export async function writePng(raster: Raster, file: string): Promise<void> {
  await toSharp(raster).png().toFile(file);
}

export function parseHex(hex: string): Rgb {
  const clean = hex.replace('#', '');
  const value = Number.parseInt(clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function colorDistance(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

export function pixel(raster: Raster, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const i = (y * raster.width + x) * 4;
  return { r: raster.data[i] ?? 255, g: raster.data[i + 1] ?? 255, b: raster.data[i + 2] ?? 255, a: raster.data[i + 3] ?? 255 };
}

/**
 * Background colour estimate: 96 border
 * samples, keep the brightest quarter, average them.
 */
export function estimateBackground(raster: Raster): Rgb {
  const { width, height } = raster;
  const samples: { r: number; g: number; b: number; a: number }[] = [];
  const count = 24;
  for (let i = 0; i < count; i += 1) {
    const x = Math.round((i / (count - 1)) * (width - 1));
    const y = Math.round((i / (count - 1)) * (height - 1));
    samples.push(pixel(raster, x, 0), pixel(raster, x, height - 1), pixel(raster, 0, y), pixel(raster, width - 1, y));
  }
  const opaque = samples.filter((p) => p.a > 245).sort((a, b) => luminance(b.r, b.g, b.b) - luminance(a.r, a.g, a.b));
  const chosen = opaque.slice(0, Math.max(4, Math.ceil(samples.length * 0.25)));
  const source = chosen.length > 0 ? chosen : samples;
  return source.reduce(
    (sum, p) => ({ r: sum.r + p.r / source.length, g: sum.g + p.g / source.length, b: sum.b + p.b / source.length }),
    { r: 0, g: 0, b: 0 },
  );
}

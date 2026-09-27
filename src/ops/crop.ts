import sharp from 'sharp';
import type { Anchor } from '../config.js';
import type { Box } from '../meta.js';
import { readRaster, type Raster } from './raster.js';

/** Bounding box of pixels with alpha above `min`. */
export function alphaBounds(raster: Raster, min = 8): Box | null {
  const { width, height, data } = raster;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > min) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function anchorFraction(anchor: Anchor): { x: number; y: number } {
  switch (anchor) {
    case 'top-left':
      return { x: 0, y: 0 };
    case 'top-center':
      return { x: 0.5, y: 0 };
    case 'center':
      return { x: 0.5, y: 0.5 };
    case 'bottom-left':
      return { x: 0, y: 1 };
    case 'bottom-center':
      return { x: 0.5, y: 1 };
  }
}

export type Framed = { file: string; bounds: Box; width: number; height: number };

/**
 * Trim each file to its alpha bounds plus `pad`. For a set of frames (a strip),
 * every frame is placed on one shared canvas sized to the union of the frames'
 * bounds, aligned on the anchor, so the sprite does not jitter when the
 * frames play. Returns the shared canvas size.
 */
export async function trimAndAlign(files: string[], outFiles: string[], anchor: Anchor, pad: number): Promise<{ width: number; height: number; frames: Framed[] }> {
  const rasters = await Promise.all(files.map((file) => readRaster(file)));
  const bounds = rasters.map((raster) => alphaBounds(raster) ?? { x: 0, y: 0, width: raster.width, height: raster.height });
  const a = anchorFraction(anchor);
  // Extents relative to the anchor point of each frame.
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  for (const b of bounds) {
    const ax = b.width * a.x;
    const ay = b.height * a.y;
    left = Math.max(left, ax);
    right = Math.max(right, b.width - ax);
    top = Math.max(top, ay);
    bottom = Math.max(bottom, b.height - ay);
  }
  const width = Math.ceil(left + right) + pad * 2;
  const height = Math.ceil(top + bottom) + pad * 2;
  const frames: Framed[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const raster = rasters[i]!;
    const b = bounds[i]!;
    const ax = b.width * a.x;
    const ay = b.height * a.y;
    const dx = Math.round(pad + left - ax);
    const dy = Math.round(pad + top - ay);
    const cropped = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } })
      .extract({ left: b.x, top: b.y, width: b.width, height: b.height })
      .png()
      .toBuffer();
    await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: cropped, left: dx, top: dy }])
      .png()
      .toFile(outFiles[i]!);
    frames.push({ file: outFiles[i]!, bounds: b, width, height });
  }
  return { width, height, frames };
}

/** Resize a PNG so its height (or width) equals `target` px, keeping aspect. */
export async function fitTo(file: string, outFile: string, target: { height?: number; width?: number }): Promise<{ width: number; height: number }> {
  const meta = await sharp(file).metadata();
  const w = meta.width ?? 1;
  const h = meta.height ?? 1;
  let width: number;
  let height: number;
  if (target.width) {
    width = Math.round(target.width);
    height = Math.max(1, Math.round((h / w) * width));
  } else {
    height = Math.round(target.height ?? h);
    width = Math.max(1, Math.round((w / h) * height));
  }
  await sharp(file).resize(width, height, { kernel: 'lanczos3', fit: 'fill' }).png().toFile(outFile);
  return { width, height };
}

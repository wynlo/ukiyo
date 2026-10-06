import fs from 'node:fs';
import sharp from 'sharp';
import type { Anchor, ResolvedConfig } from '../config.js';
import type { Target } from '../manifest.js';
import { anchorFraction } from './crop.js';

/**
 * Declared aspect ratios. A project declares a width:height ratio per kind
 * (`ukiyo.json` `kinds.<kind>.aspect`) and can override it per target
 * (`aspect` in the manifest). `final` pads each final PNG with transparent
 * pixels until it has the declared ratio. It never stretches or crops.
 */

export const ASPECT_PATTERN = /^\d+(\.\d+)?:\d+(\.\d+)?$/;

/** "3:2" as a number (1.5). */
export function parseAspect(value: string): number {
  const [w, h] = value.split(':').map(Number) as [number, number];
  if (!(w > 0) || !(h > 0)) throw new Error(`Invalid aspect "${value}": expected "width:height", e.g. "3:2"`);
  return w / h;
}

/** The target's declared aspect ratio, or null when neither the target nor its kind declares one. */
export function declaredAspect(config: ResolvedConfig, target: Target): { label: string; ratio: number } | null {
  const label = target.aspect ?? config.kinds[target.kind]?.aspect;
  return label ? { label, ratio: parseAspect(label) } : null;
}

/**
 * A pixel canvas cannot hold most ratios exactly. A size matches when it is
 * within 1 px of the ratio in either dimension.
 */
export function matchesAspect(width: number, height: number, ratio: number): boolean {
  return Math.abs(width - height * ratio) <= 1 || Math.abs(height - width / ratio) <= 1;
}

export type AspectPad = { width: number; height: number; dx: number; dy: number };

/** Split `total` px of padding by an anchor fraction: 0 pads after, 1 pads before, 0.5 pads both sides evenly. */
function split(total: number, fraction: number): { total: number; before: number } {
  if (fraction <= 0) return { total, before: 0 };
  if (fraction >= 1) return { total, before: total };
  // Centred: keep the padding even so the art stays exactly on the centre line.
  const even = total % 2 === 0 ? total : total + 1;
  return { total: even, before: even / 2 };
}

/**
 * The smallest canvas with the ratio that holds a `width` x `height` image,
 * and where the image goes on it. The anchor point of the image stays at the
 * same fraction of the canvas: bottom-centre art keeps its ground contact at
 * the bottom centre, centred art stays centred, top-left art stays top-left.
 */
export function aspectPad(width: number, height: number, ratio: number, anchor: Anchor): AspectPad {
  if (matchesAspect(width, height, ratio)) return { width, height, dx: 0, dy: 0 };
  const a = anchorFraction(anchor);
  if (width / height < ratio) {
    const x = split(Math.ceil(height * ratio) - width, a.x);
    return { width: width + x.total, height, dx: x.before, dy: 0 };
  }
  const y = split(Math.ceil(width / ratio) - height, a.y);
  return { width, height: height + y.total, dx: 0, dy: y.before };
}

/** Pad a PNG in place with transparent pixels. Returns the padding, or null when the file already matches. */
export async function padToAspect(file: string, ratio: number, anchor: Anchor): Promise<AspectPad | null> {
  const m = await sharp(file).metadata();
  const width = m.width ?? 1;
  const height = m.height ?? 1;
  const pad = aspectPad(width, height, ratio, anchor);
  if (pad.width === width && pad.height === height) return null;
  const input = await sharp(file).png().toBuffer();
  const out = await sharp({ create: { width: pad.width, height: pad.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input, left: pad.dx, top: pad.dy }])
    .png()
    .toBuffer();
  fs.writeFileSync(file, out);
  return pad;
}

/** Width and height from a PNG header, without decoding the image. */
export function pngSize(file: string): { width: number; height: number } | null {
  try {
    const fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(24);
    fs.readSync(fd, header, 0, 24, 0);
    fs.closeSync(fd);
    if (header.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } catch {
    return null;
  }
}

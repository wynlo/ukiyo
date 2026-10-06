import fs from 'node:fs';
import path from 'node:path';
import { MaxRectsPacker } from 'maxrects-packer';
import sharp from 'sharp';
import type { PartMeta } from '../meta.js';
import { atlasLights, type LightPoint } from './lights.js';

export type PackInput = {
  /** Frame name in the atlas, e.g. "guest-fox/idle" or "counter". */
  name: string;
  file: string;
  width: number;
  height: number;
  anchor: { x: number; y: number };
  /** Runtime tint channel, written to the frame for the engine. */
  tint?: string;
  /** The art's box inside the image, before aspect padding. Default: the whole image. */
  content?: { x: number; y: number; width: number; height: number };
  /** A `split` output: its place on the base frame and its joint. Written to the frame as is. */
  part?: PartMeta;
  /** Light points in px of this image (`ops/lights.ts`). Written to the frame as shares of its content box. */
  lights?: LightPoint[];
};

export type PackOptions = {
  padding: number;
  maxSize: number;
  scale: number;
  quantize?: boolean;
  /** Power-of-two sheet size, for mipmaps on WebGL 1. */
  pot?: boolean;
  quality?: number;
};

type PhaserFrame = {
  frame: { x: number; y: number; w: number; h: number };
  rotated: false;
  trimmed: false;
  spriteSourceSize: { x: number; y: number; w: number; h: number };
  sourceSize: { w: number; h: number };
  pivot: { x: number; y: number };
  anchor: { x: number; y: number };
  /**
   * The art's box inside the frame, in frame px. Smaller than the frame when
   * `final` padded the asset to its declared aspect ratio. For code that fits
   * the art itself to a box (a DOM icon, a nine-slice, a rig's part sizes).
   */
  content: { x: number; y: number; w: number; h: number };
  tint?: string;
  /**
   * A `split` output. `base` is the frame it belongs to; `x`, `y` place this
   * frame's top-left on it; `joint` is the point it turns about, in this
   * frame's px; `z` is the draw order (plate 0).
   */
  part?: PartMeta;
  /**
   * Where the picture gives off light: one point per lit region. `x` and `y`
   * are shares of the content box from its top-left, `radius` a share of its
   * width. `piece` names the split piece that carries the light.
   */
  lights?: ReturnType<typeof atlasLights>;
};

export type PackResult = { png: string; json: string; width: number; height: number; frames: string[]; skipped: string[] };

/**
 * Pack into one PNG + one JSON in the TexturePacker "JSON hash" layout, which
 * Phaser loads with `this.load.atlas`. `pivot` sets Phaser's custom pivot per
 * frame; `anchor` is the same value for other engines.
 */
export async function packAtlas(group: string, inputs: PackInput[], outDir: string, options: PackOptions): Promise<PackResult> {
  const packer = new MaxRectsPacker<{ name: string; file: string; anchor: { x: number; y: number }; tint?: string; content?: PackInput['content']; part?: PartMeta; lights?: LightPoint[]; width: number; height: number; x: number; y: number }>(
    options.maxSize,
    options.maxSize,
    options.padding,
    { smart: true, pot: options.pot === true, square: false, allowRotation: false },
  );
  for (const input of inputs) {
    packer.add({ width: input.width, height: input.height, name: input.name, file: input.file, anchor: input.anchor, tint: input.tint, content: input.content, part: input.part, lights: input.lights, x: 0, y: 0 });
  }
  const bin = packer.bins[0];
  if (!bin) {
    throw new Error(`Nothing to pack for group "${group}"`);
  }
  const skipped = packer.bins.slice(1).flatMap((b) => b.rects.map((r) => r.name));
  const width = bin.width;
  const height = bin.height;
  const composites = bin.rects.map((rect) => ({ input: rect.file, left: rect.x, top: rect.y }));
  fs.mkdirSync(outDir, { recursive: true });
  const png = path.join(outDir, `${group}.png`);
  const json = path.join(outDir, `${group}.json`);
  await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png(options.quantize !== true ? { compressionLevel: 9 } : { compressionLevel: 9, palette: true, quality: options.quality ?? 90, effort: 8 })
    .toFile(png);
  const frames: Record<string, PhaserFrame> = {};
  for (const rect of [...bin.rects].sort((a, b) => a.name.localeCompare(b.name))) {
    frames[rect.name] = {
      frame: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: rect.width, h: rect.height },
      sourceSize: { w: rect.width, h: rect.height },
      pivot: rect.anchor,
      anchor: rect.anchor,
      content: rect.content ? { x: rect.content.x, y: rect.content.y, w: rect.content.width, h: rect.content.height } : { x: 0, y: 0, w: rect.width, h: rect.height },
      ...(rect.tint ? { tint: rect.tint } : {}),
      ...(rect.part ? { part: rect.part } : {}),
      ...(rect.lights?.length ? { lights: atlasLights(rect.lights, rect.content ?? { x: 0, y: 0, width: rect.width, height: rect.height }) } : {}),
    };
  }
  const document = {
    frames,
    meta: {
      app: 'ukiyo',
      version: '1',
      image: `${group}.png`,
      format: 'RGBA8888',
      size: { w: width, h: height },
      scale: String(options.scale),
    },
  };
  fs.writeFileSync(json, `${JSON.stringify(document, null, 2)}\n`);
  return { png, json, width, height, frames: Object.keys(frames), skipped };
}

/** Frame names already present in the atlas JSON files under `dir`. */
export function packedFrameNames(dir: string): Set<string> {
  const names = new Set<string>();
  if (!fs.existsSync(dir)) return names;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { frames?: Record<string, unknown> };
      for (const name of Object.keys(doc.frames ?? {})) names.add(name);
    } catch {
      // ignore unreadable files
    }
  }
  return names;
}

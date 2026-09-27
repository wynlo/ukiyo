import type { Box } from '../meta.js';
import { colorDistance, estimateBackground, luminance, type Raster, type Rgb } from './raster.js';

/**
 * Component detection: foreground mask by colour distance from the
 * estimated background plus a dark-line check, 4-connected components, box
 * merge by gap. Boxes are clustered into rows for reading order, because a
 * plain (y, x) sort mis-orders a grid whose cells sit at slightly different
 * heights.
 */

export type DetectOptions = {
  threshold: number;
  minArea: number;
  mergeGap: number;
  /** When set, the mask is "distance from this colour", not from the estimate. */
  background?: Rgb;
};

type Component = Box & { area: number };

export function buildForegroundMask(raster: Raster, threshold: number, background: Rgb): Uint8Array {
  const { width, height, data } = raster;
  const mask = new Uint8Array(width * height);
  const backgroundIsLight = luminance(background.r, background.g, background.b) > 180;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const r = data[i] ?? 255;
      const g = data[i + 1] ?? 255;
      const b = data[i + 2] ?? 255;
      const a = data[i + 3] ?? 255;
      if (a < 24) {
        continue;
      }
      const distance = colorDistance(r, g, b, background.r, background.g, background.b);
      const darkLine = backgroundIsLight && luminance(r, g, b) < 150 && distance > Math.max(12, threshold * 0.35);
      if (distance > threshold || darkLine) {
        mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

export function findComponents(mask: Uint8Array, width: number, height: number, minArea: number): Component[] {
  const visited = new Uint8Array(mask.length);
  const queue: number[] = [];
  const boxes: Component[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    visited[start] = 1;
    queue.length = 0;
    queue.push(start);
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let area = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor] ?? 0;
      const x = index % width;
      const y = Math.floor(index / width);
      area += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      const neighbours = [index - 1, index + 1, index - width, index + width];
      for (const n of neighbours) {
        if (n < 0 || n >= mask.length || visited[n] || !mask[n]) continue;
        if (Math.abs((n % width) - x) > 1) continue;
        visited[n] = 1;
        queue.push(n);
      }
    }
    if (area >= minArea) {
      boxes.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area });
    }
  }
  return boxes;
}

function touch(a: Box, b: Box, gap: number): boolean {
  return a.x <= b.x + b.width + gap && a.x + a.width + gap >= b.x && a.y <= b.y + b.height + gap && a.y + a.height + gap >= b.y;
}

export function mergeBoxes(boxes: Component[], gap: number): Component[] {
  const merged = [...boxes];
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let a = 0; a < merged.length; a += 1) {
      for (let b = a + 1; b < merged.length; b += 1) {
        const first = merged[a];
        const second = merged[b];
        if (!first || !second || !touch(first, second, gap)) continue;
        const x = Math.min(first.x, second.x);
        const y = Math.min(first.y, second.y);
        const x2 = Math.max(first.x + first.width, second.x + second.width);
        const y2 = Math.max(first.y + first.height, second.y + second.height);
        merged[a] = { x, y, width: x2 - x, height: y2 - y, area: first.area + second.area };
        merged.splice(b, 1);
        changed = true;
        break outer;
      }
    }
  }
  return merged;
}

/** Reading order: cluster into rows by centre y, then left to right. */
export function readingOrder(boxes: Component[]): Component[] {
  if (boxes.length === 0) return [];
  const avgHeight = boxes.reduce((sum, b) => sum + b.height, 0) / boxes.length;
  const rows: Component[][] = [];
  const sorted = [...boxes].sort((a, b) => a.y + a.height / 2 - (b.y + b.height / 2));
  for (const box of sorted) {
    const cy = box.y + box.height / 2;
    const row = rows.find((r) => {
      const rcy = r.reduce((sum, b) => sum + b.y + b.height / 2, 0) / r.length;
      return Math.abs(rcy - cy) < avgHeight * 0.5;
    });
    if (row) row.push(box);
    else rows.push([box]);
  }
  rows.sort((a, b) => a[0]!.y - b[0]!.y);
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x));
}

/** Drop tiny specks relative to the largest component (dust, stray dots). */
export function dropSpecks(boxes: Component[], ratio = 0.02): Component[] {
  const largest = Math.max(0, ...boxes.map((b) => b.area));
  return boxes.filter((b) => b.area >= largest * ratio);
}

export function detectComponents(raster: Raster, options: DetectOptions): { boxes: Component[]; background: Rgb } {
  const background = options.background ?? estimateBackground(raster);
  const mask = buildForegroundMask(raster, options.threshold, background);
  const boxes = readingOrder(dropSpecks(mergeBoxes(findComponents(mask, raster.width, raster.height, options.minArea), options.mergeGap)));
  return { boxes, background };
}

/**
 * Force exactly `count` boxes by merging the closest pairs (too many) or
 * splitting the widest box evenly (too few). Used for strips, whose frame
 * count is known. Returns the boxes and a warning when it had to intervene.
 */
export function coerceCount(boxes: Component[], count: number, rasterWidth: number): { boxes: Component[]; warning?: string } {
  if (boxes.length === count) return { boxes };
  let working = [...boxes];
  if (working.length > count) {
    while (working.length > count) {
      let bestGap = Number.POSITIVE_INFINITY;
      let bestIndex = 0;
      for (let i = 0; i < working.length - 1; i += 1) {
        const a = working[i]!;
        const b = working[i + 1]!;
        const gap = b.x - (a.x + a.width);
        if (gap < bestGap) {
          bestGap = gap;
          bestIndex = i;
        }
      }
      const a = working[bestIndex]!;
      const b = working[bestIndex + 1]!;
      const x = Math.min(a.x, b.x);
      const y = Math.min(a.y, b.y);
      const x2 = Math.max(a.x + a.width, b.x + b.width);
      const y2 = Math.max(a.y + a.height, b.y + b.height);
      working.splice(bestIndex, 2, { x, y, width: x2 - x, height: y2 - y, area: a.area + b.area });
    }
    return { boxes: working, warning: `Detected ${boxes.length} components, expected ${count}; merged the closest ones.` };
  }
  if (working.length === 0) {
    const cell = Math.floor(rasterWidth / count);
    working = Array.from({ length: count }, (_, i) => ({ x: i * cell, y: 0, width: cell, height: 0, area: 0 }));
    return { boxes: working, warning: `Detected 0 components, expected ${count}; split the image evenly.` };
  }
  while (working.length < count) {
    let widest = 0;
    for (let i = 1; i < working.length; i += 1) {
      if (working[i]!.width > working[widest]!.width) widest = i;
    }
    const w = working[widest]!;
    const half = Math.floor(w.width / 2);
    working.splice(widest, 1, { ...w, width: half, area: Math.floor(w.area / 2) }, { ...w, x: w.x + half, width: w.width - half, area: Math.ceil(w.area / 2) });
  }
  return { boxes: working, warning: `Detected ${boxes.length} components, expected ${count}; split the widest ones.` };
}

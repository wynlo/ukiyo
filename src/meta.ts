import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from './config.js';
import { assetNames, type Target } from './manifest.js';

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export type Box = { x: number; y: number; width: number; height: number };

export type AssetMeta = {
  name: string;
  /** Detected box on raw.png, when cut from a sheet or strip. */
  sourceBox?: Box;
  /** Final size in atlas px. */
  width?: number;
  height?: number;
  /** Pivot as a fraction of the final frame. */
  anchor?: { x: number; y: number };
  status: ReviewStatus;
  note?: string;
  reviewedAt?: string;
  /** An optional part the sheet did not include. Never packed, never pending. */
  missing?: boolean;
  /** Runtime tint channel, when the asset is tint-ready. */
  tint?: string;
  /** Layer targets: how well the edit lined up with its base. */
  registration?: { iou: number; scale: number; coverage: number };
};

export type TargetMeta = {
  target: string;
  compose: Target['compose'];
  kind: string;
  game?: string;
  prompt?: string;
  /** `prompts.version` the prompt was composed with. */
  promptVersion?: string;
  generatedAt?: string;
  provider?: string;
  /** Detected component count vs expected. */
  detected?: number;
  expected?: number;
  warnings: string[];
  assets: Record<string, AssetMeta>;
};

export type Stage = 'raw' | 'cut' | 'final';

export function targetDir(config: ResolvedConfig, target: string): string {
  return path.join(config.outDir, target);
}

export function rawPath(config: ResolvedConfig, target: string): string {
  return path.join(targetDir(config, target), 'raw.png');
}

export function refPath(config: ResolvedConfig, target: string): string {
  return path.join(targetDir(config, target), 'ref.png');
}

export function stagePath(config: ResolvedConfig, target: string, stage: Exclude<Stage, 'raw'>, asset: string): string {
  return path.join(targetDir(config, target), stage, `${asset}.png`);
}

export function metaPath(config: ResolvedConfig, target: string): string {
  return path.join(targetDir(config, target), 'meta.json');
}

export function readMeta(config: ResolvedConfig, target: Target): TargetMeta {
  const file = metaPath(config, target.target);
  const names = assetNames(target);
  let meta: TargetMeta;
  if (fs.existsSync(file)) {
    meta = JSON.parse(fs.readFileSync(file, 'utf8')) as TargetMeta;
  } else {
    meta = { target: target.target, compose: target.compose, kind: target.kind, game: target.game, warnings: [], assets: {} };
  }
  meta.compose = target.compose;
  meta.kind = target.kind;
  meta.game = target.game;
  meta.warnings ??= [];
  meta.assets ??= {};
  for (const name of names) {
    meta.assets[name] ??= { name, status: 'pending' };
  }
  return meta;
}

export function writeMeta(config: ResolvedConfig, meta: TargetMeta): void {
  const file = metaPath(config, meta.target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);
}

export type StepState = 'done' | 'missing' | 'partial';

export type TargetStatus = {
  target: string;
  raw: StepState;
  cut: StepState;
  final: StepState;
  packed: StepState;
  review: { approved: number; rejected: number; pending: number; total: number };
  warnings: string[];
};

function stageState(config: ResolvedConfig, target: Target, stage: Exclude<Stage, 'raw'>): StepState {
  const names = assetNames(target);
  const present = names.filter((name) => fs.existsSync(stagePath(config, target.target, stage, name))).length;
  if (present === 0) return 'missing';
  if (present === names.length) return 'done';
  return 'partial';
}

export function targetStatus(config: ResolvedConfig, target: Target, packedNames: Set<string>): TargetStatus {
  const meta = readMeta(config, target);
  const names = assetNames(target);
  const review = { approved: 0, rejected: 0, pending: 0, total: names.length };
  for (const name of names) {
    if (meta.assets[name]?.missing) {
      review.total -= 1;
      continue;
    }
    review[meta.assets[name]?.status ?? 'pending'] += 1;
  }
  const packed = names.filter((name) => packedNames.has(`${target.target}/${name}`)).length;
  return {
    target: target.target,
    raw: fs.existsSync(rawPath(config, target.target)) ? 'done' : 'missing',
    cut: stageState(config, target, 'cut'),
    final: stageState(config, target, 'final'),
    packed: packed === 0 ? 'missing' : packed === names.length ? 'done' : 'partial',
    review,
    warnings: meta.warnings,
  };
}

export function removeOutputs(config: ResolvedConfig, target: Target, asset?: string): string[] {
  const removed: string[] = [];
  const dir = targetDir(config, target.target);
  if (!asset) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    }
    return removed;
  }
  for (const stage of ['cut', 'final'] as const) {
    const file = stagePath(config, target.target, stage, asset);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed.push(file);
    }
  }
  // A layer's generated image is its source; drop it so `gen` redraws it.
  const frame = path.join(targetDir(config, target.target), 'frames', `${asset}.png`);
  if (target.compose === 'layer' && fs.existsSync(frame)) {
    fs.rmSync(frame);
    removed.push(frame);
  }
  const meta = readMeta(config, target);
  meta.assets[asset] = { name: asset, status: 'pending' };
  writeMeta(config, meta);
  return removed;
}

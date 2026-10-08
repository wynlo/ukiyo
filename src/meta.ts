import fs from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig } from './config.js';
import { assetNames, type Target } from './manifest.js';
import { declaredAspect, matchesAspect, pngSize } from './ops/aspect.js';
import type { LightPoint } from './ops/lights.js';

export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export type Box = { x: number; y: number; width: number; height: number };

/** What a reference image is for: `input` is the image being edited; the others are named in the prompt. */
export type ReferenceRole = 'input' | 'style' | 'proportions' | 'family';
/** Where a reference came from (see `src/references.ts`). */
export type ReferenceSource = 'edit' | 'anchor' | 'request' | 'explicit' | 'first-target' | 'auto';

/** One image sent with a generation call, as recorded in meta.json. */
export type ReferenceRecord = {
  /** Position in the request. Image 1 is the input image of an edit. */
  n: number;
  /** `<target>/<asset>`, for a reference to an asset of the project. */
  id?: string;
  /** Path relative to ukiyo.json. */
  path: string;
  role: ReferenceRole;
  source: ReferenceSource;
  /** Review status of the asset when it was sent. */
  status?: ReviewStatus;
  /** First 16 hex digits of the file's SHA-256 when it was sent. */
  sha256: string;
};

export type AssetMeta = {
  name: string;
  /** Detected box on raw.png, when cut from a sheet or strip. */
  sourceBox?: Box;
  /** Final size in atlas px. */
  width?: number;
  height?: number;
  /**
   * Where the art sits in the final PNG, in final px. It differs from the
   * full PNG when `final` padded the asset to its declared aspect ratio.
   */
  content?: Box;
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
  /** Split targets: where this output sits on its base and how it moves. Written to the atlas frame. */
  part?: PartMeta;
  /** `ukiyo plan`: how complex the asset is, and why (see `ops/complexity.ts`). */
  complexity?: Complexity;
  /** `ukiyo plan` looked at it and found nothing that moves on its own (a stone statue). */
  still?: boolean;
  /**
   * Light points, in px of this final PNG (`ops/lights.ts`). Written by
   * `ukiyo final` for light sources and split pieces that emit; `pack`
   * writes them into the atlas frame as shares of the content box.
   */
  lights?: LightPoint[];
  /**
   * The wind and light review of the asset, proposed by `ukiyo plan` and
   * approved on the review page (Wind & light tab). Every sprite the rig
   * rules cover gets one; a game guard can require it.
   */
  effects?: EffectsReview;
  /** The review of the light points of an asset with no split (a split's lights are reviewed with its plan). */
  lightReview?: { status: ReviewStatus; note?: string; reviewedAt?: string };
  /** The images sent with the call that made this asset. */
  references?: ReferenceRecord[];
};

/**
 * Whether the wind moves a sprite and whether it gives light. `wind`: the
 * wind materials of its moving parts, or `none`. `light`: `art` when its
 * light points come from the art (`lights`), or `none`. `hash` is the final
 * PNG's hash when the pass ran: a regenerated sprite gets a new proposal.
 */
export type EffectsReview = {
  wind: string[] | 'none';
  light: 'art' | 'none';
  /** Light points found on the asset or its split's pieces. */
  lights: number;
  /** Regions that look lit to the light detector (`lit` rule), whether or not it is a light source. */
  lit: number;
  /** Why the pass proposed what it did. */
  why: string;
  hash: string;
  /** `plan`: proposed by the pass. `hand`: set on the review page, kept by later passes while the art is the same. */
  source: 'plan' | 'hand';
  status: ReviewStatus;
  note?: string;
  reviewedAt?: string;
};

export type Complexity = { score: number; regions: number; protrusion: number; edges: number; components: number };

/** How a piece moves, from its material in `rig.materials` and the piece's own override. The game reads it. */
export type PartRig = {
  material: string;
  rest?: { kind: string; amount: [number, number]; periodMs?: [number, number]; durationMs?: [number, number] };
  use?: { kind: string; amount: [number, number]; periodMs?: [number, number]; durationMs?: [number, number] };
  gust?: { kind: string; amount: [number, number]; periodMs?: [number, number]; durationMs?: [number, number] };
  /** Ms after its parent, per level of a chain. */
  lag: number;
  /** Ms after the sibling before it, for pieces of one material. */
  stagger: number;
  phases?: string[];
};

/**
 * One output of a `split` target, measured on its base's final PNG.
 * `x` and `y` place this frame's top-left on the base frame; `joint` is
 * the point it turns about, in this frame's px. Every output of one split
 * shares the base's canvas: drawn at these offsets they rebuild the base.
 */
export type PartMeta = {
  /** Atlas frame name of the base (`shrine-haiden`, `sheet/asset`). */
  base: string;
  /** The base frame's size in px. */
  baseWidth: number;
  baseHeight: number;
  x: number;
  y: number;
  joint: { x: number; y: number };
  /** Draw order. The plate is 0. */
  z: number;
  role: 'plate' | 'add' | 'piece';
  /** What the plate keeps under a piece (see the manifest's `mode`). */
  mode?: 'detach' | 'cover' | 'fill';
  /** The piece this one hangs from. */
  parent?: string;
  /** How it moves (a piece with a `material`). */
  rig?: PartRig;
  /** On the root of a rigged parts target: keyframed clips, by name. */
  animations?: Record<string, RigClip>;
};

/** A keyframed clip: per part, poses at times in ms. Channels missing from a key are the rest pose. */
export type RigClip = {
  durationMs: number;
  loop: boolean;
  keys: Record<string, { t: number; a?: number; dx?: number; dy?: number; sx?: number; sy?: number }[]>;
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
  /** Split targets: the review of the part plan (pieces, joints, motion). A rejected plan does not pack. */
  plan?: { status: ReviewStatus; note?: string; reviewedAt?: string };
  /** Split targets: every light of the prop, in px of the base's final PNG, each with the piece that carries it. */
  lights?: LightPoint[];
  /** The images sent with the last generation call of this target. */
  references?: ReferenceRecord[];
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
  /** Final PNGs whose size does not have the declared aspect ratio, e.g. "lamp 120x256 (declared 1:1)". */
  aspect: string[];
};

/** Final PNGs of a target that do not have its declared aspect ratio. */
export function aspectIssues(config: ResolvedConfig, target: Target): string[] {
  const declared = declaredAspect(config, target);
  if (!declared) return [];
  const issues: string[] = [];
  for (const name of assetNames(target)) {
    const size = pngSize(stagePath(config, target.target, 'final', name));
    if (size && !matchesAspect(size.width, size.height, declared.ratio)) {
      issues.push(`${name} ${size.width}x${size.height} (declared ${declared.label})`);
    }
  }
  return issues;
}

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
  const aspect = aspectIssues(config, target);
  return {
    target: target.target,
    raw: fs.existsSync(rawPath(config, target.target)) ? 'done' : 'missing',
    cut: stageState(config, target, 'cut'),
    final: stageState(config, target, 'final'),
    packed: packed === 0 ? 'missing' : packed === names.length ? 'done' : 'partial',
    review,
    warnings: aspect.length ? [...meta.warnings, `aspect: ${aspect.join(', ')}`] : meta.warnings,
    aspect,
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
  // A layer's (or a split add's) generated image is its source; drop it so `gen` redraws it.
  const frame = path.join(targetDir(config, target.target), 'frames', `${asset}.png`);
  if ((target.compose === 'layer' || target.compose === 'split') && fs.existsSync(frame)) {
    fs.rmSync(frame);
    removed.push(frame);
  }
  const meta = readMeta(config, target);
  meta.assets[asset] = { name: asset, status: 'pending' };
  writeMeta(config, meta);
  return removed;
}

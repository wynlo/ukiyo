import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { ResolvedConfig } from './config.js';
import { assetNames, type Manifest, type Target } from './manifest.js';
import { rawPath, readMeta, removeOutputs, stagePath, targetDir, targetStatus, writeMeta, type AssetMeta, type Complexity, type EffectsReview, type PartMeta, type PartRig, type TargetStatus } from './meta.js';
import { coerceCount, detectComponents } from './ops/autocrop.js';
import { cutout } from './ops/cutout.js';
import { alphaBounds, anchorFraction, fitTo, trimAndAlign } from './ops/crop.js';
import { extractLayer, register, tintRaster } from './ops/register.js';
import { neutralize } from './ops/tint.js';
import { setStroke, supersample, supersampleFactor } from './ops/stroke.js';
import { packAtlas, packedFrameNames, type PackInput } from './ops/pack.js';
import { aspectPad, declaredAspect, matchesAspect, padToAspect } from './ops/aspect.js';
import { colorDistance, estimateBackground, parseHex, readRaster, toSharp, writePng, type Raster } from './ops/raster.js';
import { contactSheet, framePlayer, type SheetEntry } from './ops/sheet.js';
import { composeEditPrompt, composeLayerPrompt, composePrompt, composeSplitPrompt, defaultSize, framePoseInstruction } from './prompt/compose.js';
import { assignSoftEdges, band, moveIslands, moveThinStrips, blendFill, clear, cutToFinal, dilate, emptyRaster, masked, newPixels, opaqueOutside, rebuildError, resampleEdit, selectPiece } from './ops/split.js';
import { measureComplexity } from './ops/complexity.js';
import { planPieces, type KeptPiece, type Label } from './ops/plan.js';
import { DEFAULT_LIGHT_RULES, detectLights, findLitCopies, type LightPoint, type LightRules } from './ops/lights.js';
import { templatesFor } from './prompt/compose.js';
import { createProvider, RateLimitError, type ImageProvider } from './providers/index.js';
import { createReferenceResolver, referenceRecords, type ReferenceInput, type ReferenceRequest } from './references.js';

export type StepName = 'gen' | 'animate' | 'edit' | 'cut' | 'final' | 'sheet' | 'pack' | 'redo' | 'import' | 'plan';

export type PipelineEvent =
  | { type: 'start'; step: StepName; target: string; message?: string }
  | { type: 'done'; step: StepName; target: string; message?: string }
  | { type: 'skip'; step: StepName; target: string; message?: string }
  | { type: 'warn'; step: StepName; target: string; message: string }
  | { type: 'error'; step: StepName; target: string; message: string }
  | { type: 'wait'; step: StepName; target: string; ms: number; message: string }
  | { type: 'log'; message: string };

export type Emit = (event: PipelineEvent) => void;

export type Pipeline = ReturnType<typeof createPipeline>;

/** One asset `ukiyo plan` looked at. */
export type PlanRow = { target: string; asset: string; score: number; threshold: number; action: string; trigger?: string; pieces?: string[]; dropped?: string[]; plan?: { pieces: unknown[]; existing: unknown[] }; effects?: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type PipelineOptions = {
  /** Per-request reference overrides (`--ref`, `--no-refs`, `--refs-only`, `--max-refs`, `--pending-refs`). */
  refs?: ReferenceRequest;
};

export function createPipeline(config: ResolvedConfig, manifest: Manifest, emit: Emit, providerOverride?: ImageProvider, options: PipelineOptions = {}) {
  const provider = providerOverride ?? createProvider(config);
  const references = createReferenceResolver(config, manifest);
  const byName = new Map(manifest.map((t) => [t.target, t]));

  const pick = (names: string[] | undefined): Target[] => {
    if (!names || names.length === 0) return manifest;
    return names.map((name) => {
      const target = byName.get(name);
      if (!target) throw new Error(`Unknown target "${name}"`);
      return target;
    });
  };

  const groupOf = (target: Target): string => ((target as unknown as Record<string, unknown>)[config.atlas.groupBy] as string | undefined) ?? 'atlas';
  /** Atlas px per CSS px for the target's group. */
  const scaleFor = (target: Target): number => config.atlas.groupScale[groupOf(target)] ?? config.atlas.scale;
  /** `stroke` is set in atlas px at the base scale; keep it the same width on screen. */
  const strokeFor = (target: Target): number => (target.stroke ?? 0) * (scaleFor(target) / config.atlas.scale);
  const pxFor = (target: Target): { height?: number; width?: number } => {
    const kind = config.kinds[target.kind];
    if (!kind) throw new Error(`Target "${target.target}" uses unknown kind "${target.kind}". Add it to ukiyo.json kinds.`);
    const px = config.atlas.unit * scaleFor(target);
    const height = target.height ?? kind.height;
    const width = target.width ?? kind.width;
    if (target.compose === 'backdrop') return { width: (width ?? 8) * px };
    return { height: (height ?? 1) * px };
  };

  const anchorFor = (target: Target) => anchorFraction(config.kinds[target.kind]?.anchor ?? 'bottom-center');

  /**
   * The reference images for one call (see `references.ts`): the prompt with
   * its REFERENCE IMAGES block, the files for the provider, and the records
   * for meta.json.
   */
  const withReferences = async (target: Target, prompt: string, extra: { input?: ReferenceInput; editing?: string; exclude?: string[] } = {}) => {
    const plan = references.resolve(target, { request: options.refs, ...extra });
    for (const d of plan.dropped) emit({ type: 'log', message: `${target.target}: reference ${d.ref} not used (${d.reason})` });
    if (plan.refs.length) emit({ type: 'log', message: `${target.target}: references ${plan.refs.map((r) => r.id ?? r.path).join(', ')}` });
    const block = references.promptBlock(target, plan);
    return { prompt: block ? `${prompt}\n\n${block}` : prompt, refs: await references.providerFiles(plan, backgroundFor(target)), records: referenceRecords(plan) };
  };

  const withRetry = async <T>(step: StepName, target: string, fn: () => Promise<T>): Promise<T> => {
    let attempt = 0;
    for (;;) {
      try {
        return await fn();
      } catch (error) {
        if (error instanceof RateLimitError && attempt < 3) {
          attempt += 1;
          const ms = Math.max(30000, config.provider.gapMs * 10) * attempt;
          emit({ type: 'wait', step, target, ms, message: `${error.message} Waiting ${Math.round(ms / 1000)}s (attempt ${attempt}/3).` });
          await sleep(ms);
          continue;
        }
        throw error;
      }
    }
  };

  const copyIn = async (from: string, to: string) => {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    await sharp(from).png().toFile(to);
  };

  type LayerTarget = Extract<Target, { compose: 'layer' }>;

  const splitRef = (ref: string): [string, string] => ref.split('/') as [string, string];

  /** The background a target is generated on and cut from. */
  const backgroundFor = (target: Target): string =>
    target.background ?? (config.cutout.mode === 'chroma' ? config.cutout.chroma : config.styleGuide.canvas.backgroundColor);

  const layerBase = (target: LayerTarget, id: string): string => target.layers.find((l) => l.id === id)?.base ?? target.base;

  /**
   * The base as the model sees it for a layer edit: the cut base in the
   * target's marker colour on the background, with room above for hats.
   */
  const layerRef = async (target: LayerTarget, ref: string): Promise<string> => {
    const [baseTarget, baseAsset] = splitRef(ref);
    const cut = stagePath(config, baseTarget, 'cut', baseAsset);
    if (!fs.existsSync(cut)) throw new Error(`base ${ref} is not cut yet; run \`ukiyo cut ${baseTarget}\``);
    const out = path.join(targetDir(config, target.target), `base-${baseTarget}-${baseAsset}.png`);
    const raster = await readRaster(cut);
    const box = alphaBounds(raster);
    if (!box) throw new Error(`base ${ref} is empty`);
    const tinted = await toSharp(tintRaster(raster, target.baseTint))
      .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
      .png()
      .toBuffer();
    const size = 1024;
    const height = Math.round(size * 0.58);
    const width = Math.max(1, Math.round((box.width / box.height) * height));
    const scaled = await sharp(tinted).resize(Math.min(width, Math.round(size * 0.8)), undefined, { fit: 'inside' }).resize(undefined, height, { fit: 'inside' }).png().toBuffer();
    const sm = await sharp(scaled).metadata();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await sharp({ create: { width: size, height: size, channels: 4, background: backgroundFor(target) } })
      .composite([{ input: scaled, left: Math.round((size - (sm.width ?? width)) / 2), top: Math.round(size * 0.84 - (sm.height ?? height)) }])
      .flatten({ background: backgroundFor(target) })
      .png()
      .toFile(out);
    return out;
  };

  const genLayers = async (target: LayerTarget, force: boolean) => {
    const meta = readMeta(config, target);
    meta.prompt = composePrompt(config, target);
    meta.promptVersion = config.prompts.version;
    writeMeta(config, meta);
    if (provider.name === 'manual') {
      emit({ type: 'skip', step: 'gen', target: target.target, message: 'manual provider: import each layer with `ukiyo import <file> --target <target> --asset <id>`' });
      return;
    }
    try {
      await copyIn(await layerRef(target, target.base), rawPath(config, target.target));
    } catch (error) {
      emit({ type: 'error', step: 'gen', target: target.target, message: error instanceof Error ? error.message : String(error) });
      return;
    }
    for (const layer of target.layers) {
      const out = path.join(targetDir(config, target.target), 'frames', `${layer.id}.png`);
      if (fs.existsSync(out) && !force) {
        emit({ type: 'skip', step: 'gen', target: target.target, message: `frames/${layer.id}.png exists` });
        continue;
      }
      emit({ type: 'start', step: 'gen', target: target.target, message: `layer ${layer.id}` });
      try {
        const baseId = layer.base ?? target.base;
        const ref = await layerRef(target, baseId);
        const call = await withReferences(target, composeLayerPrompt(config, target, layer), { input: { file: ref, id: baseId }, exclude: [baseId] });
        const result = await withRetry('gen', target.target, () => provider.edit(call.prompt, ref, { size: defaultSize(target), refs: call.refs, log: (line) => emit({ type: 'log', message: line }) }));
        if (!result.file) throw new Error('provider returned no file');
        await copyIn(result.file, out);
        const m = readMeta(config, target);
        m.assets[layer.id] = { name: layer.id, status: 'pending', references: call.records };
        m.references = call.records;
        m.generatedAt = new Date().toISOString();
        m.provider = provider.name;
        writeMeta(config, m);
        emit({ type: 'done', step: 'gen', target: target.target, message: `frames/${layer.id}.png` });
      } catch (error) {
        emit({ type: 'error', step: 'gen', target: target.target, message: error instanceof Error ? error.message : String(error) });
        if (error instanceof RateLimitError) return;
      }
      if (config.provider.gapMs > 0) await sleep(config.provider.gapMs);
    }
  };

  // ---- split -----------------------------------------------------------------------

  type SplitTarget = Extract<Target, { compose: 'split' }>;

  // ---- lights ----------------------------------------------------------------------

  /** `rig.lights` over the defaults. */
  const lightRules = (): LightRules => {
    const own = config.rig?.lights;
    const d = DEFAULT_LIGHT_RULES;
    return {
      lit: { ...d.lit, ...(own?.lit ?? {}), core: own?.lit?.core ?? d.lit.core, hue: own?.lit?.hue ?? d.lit.hue },
      body: own?.body ?? d.body,
      open: own?.open ?? d.open,
      minArea: own?.minArea ?? d.minArea,
      minThick: own?.minThick ?? d.minThick,
      minShare: own?.minShare ?? d.minShare,
    };
  };
  /** How a split piece gives off light: its material's `emits`. */
  const emitsOf = (material: string | undefined) => (material ? config.rig?.materials[material]?.emits : undefined);
  /** Splits cut from `<target>/<asset>` that have a piece that emits light. */
  const emittingSplits = (ref: string): SplitTarget[] =>
    manifest.filter((t): t is SplitTarget => t.compose === 'split' && t.base === ref && t.pieces.some((piece) => Boolean(emitsOf(piece.material))));
  /** Whether an asset is a light source by name (`rig.lights.match`), in the atlas groups the rig rules cover. */
  const isLightSource = (target: Target, asset: string): boolean => {
    const match = config.rig?.lights?.match;
    if (!match || (config.rig?.groups && !config.rig.groups.includes(groupOf(target)))) return false;
    const subject = target.compose === 'sheet' ? (target.assets[assetNames(target).indexOf(asset)] ?? '') : 'subject' in target ? String(target.subject ?? '') : '';
    return new RegExp(match, 'i').test(`${target.target}/${asset} ${subject}`);
  };
  /**
   * The wind and light pass: what moves in the wind and what gives light,
   * for one sprite. The wind comes from its split's pieces (their materials
   * in `rig.wind.materials`), else from a trigger of a wind material. The
   * light comes from the light rules (`rig.lights.match`) or an emitting
   * piece, with the points `final` found. `lit` counts regions that look lit
   * whatever the name, so the reviewer sees a lamp the rules missed. A
   * review set by hand, or approved, is kept while the art is the same.
   */
  const proposeEffects = (target: Target, asset: string, file: string, base: Raster, own: AssetMeta | undefined, words: string, relabel = false): EffectsReview => {
    const hash = createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
    const kept = own?.effects;
    if (kept && kept.hash === hash && !relabel && (kept.source === 'hand' || kept.status !== 'pending')) return kept;
    const ref = `${target.target}/${asset}`;
    const windMaterials = new Set(config.rig?.wind?.materials ?? []);
    const splits = manifest.filter((t): t is SplitTarget => t.compose === 'split' && t.base === ref);
    const fromPieces = [...new Set(splits.flatMap((split) => split.pieces.map((piece) => piece.material ?? '')).filter((m) => windMaterials.has(m)))];
    const trigger = (config.rig?.triggers ?? []).find((t) => t.material && windMaterials.has(t.material) && new RegExp(t.match, 'i').test(words));
    // A split decides by its pieces; only a sprite with no split falls back to the name triggers.
    const wind: EffectsReview['wind'] = fromPieces.length ? fromPieces.sort() : !splits.length && trigger?.material ? [trigger.material] : 'none';
    const pieceLights = splits.reduce((sum, split) => sum + Object.values(readMeta(config, split).assets).reduce((n, a) => n + (a.part?.role === 'piece' || a.part?.role === 'plate' ? (a.lights?.length ?? 0) : 0), 0), 0);
    const lights = pieceLights + (own?.lights?.length ?? 0);
    const source = isLightSource(target, asset) || splits.some((split) => split.pieces.some((piece) => Boolean(emitsOf(piece.material))));
    const lit = detectLights(base, 'lit', lightRules()).length;
    const why = [
      fromPieces.length ? `split pieces of ${fromPieces.join(', ')}` : splits.length ? 'its split has no wind piece' : trigger ? `name matches "${trigger.match}" (${trigger.material}): check` : 'no wind material',
      source ? `light source by the rules, ${lights} point${lights === 1 ? '' : 's'}` : lit ? `${lit} region${lit === 1 ? '' : 's'} look lit, not a light source by the rules: check` : 'no lit regions',
    ].join('; ');
    return { wind, light: source ? 'art' : 'none', lights, lit, why, hash, source: 'plan', status: 'pending', ...(kept?.note ? { note: kept.note } : {}) };
  };
  /**
   * The lights of an asset that is not a split output, in px of its final
   * PNG: a locked hand list, or nothing when a split owns them (its pieces
   * carry them), or the `lit` regions of the whole picture for a light
   * source. `undefined` when it gives no light.
   */
  const ownLights = async (target: Target, asset: string): Promise<LightPoint[] | undefined> => {
    const hand = target.lights?.[asset];
    if (hand?.locked) return hand.points.map((p) => ({ color: '#ffffff', intensity: 1, ...p }));
    if (!isLightSource(target, asset) || emittingSplits(`${target.target}/${asset}`).length > 0) return undefined;
    const file = stagePath(config, target.target, 'final', asset);
    if (!fs.existsSync(file)) return undefined;
    return detectLights(await readRaster(file), 'lit', lightRules());
  };
  /**
   * The lights of an atlas frame, in px of its final PNG. A split output
   * carries its own. A base carries its splits' lights that were cut from its
   * pixels (not those of an `add`), each tagged with its piece.
   */
  const frameLights = (target: Target, asset: string, meta: ReturnType<typeof readMeta>): LightPoint[] | undefined => {
    const own = meta.assets[asset];
    if (target.compose === 'split') return own?.lights;
    if (target.lights?.[asset]?.locked) return own?.lights;
    if (own?.lightReview?.status === 'rejected') return undefined;
    const splits = emittingSplits(`${target.target}/${asset}`);
    if (splits.length > 0) {
      const points = splits.flatMap((split) => (readMeta(config, split).lights ?? []).filter((l) => (l.from ?? 'base') === 'base'));
      return points.length ? points : undefined;
    }
    return own?.lights;
  };

  /** The atlas frame name of an asset: single and backdrop targets are named by target only. */
  const frameNameOf = (ref: string): string => {
    const [name, asset] = splitRef(ref);
    const owner = byName.get(name);
    return owner && (owner.compose === 'single' || owner.compose === 'backdrop') ? name : `${name}/${asset}`;
  };

  /**
   * The base as the model sees it for a split edit: the cut base on the
   * background, in its own colours for a plate and in the marker colour for
   * an add, filling about 80% of the canvas.
   */
  const splitRefImage = async (target: SplitTarget, tinted: boolean): Promise<string> => {
    const [baseTarget, baseAsset] = splitRef(target.base);
    const cutFile = stagePath(config, baseTarget, 'cut', baseAsset);
    if (!fs.existsSync(cutFile)) throw new Error(`base ${target.base} is not cut yet; run \`ukiyo cut ${baseTarget}\``);
    const out = path.join(targetDir(config, target.target), `base-${tinted ? 'marker' : 'plain'}.png`);
    const raster = await readRaster(cutFile);
    const box = alphaBounds(raster);
    if (!box) throw new Error(`base ${target.base} is empty`);
    const source = tinted ? tintRaster(raster, target.baseTint) : raster;
    const crop = await toSharp(source).extract({ left: box.x, top: box.y, width: box.width, height: box.height }).png().toBuffer();
    const size = 1024;
    const scaled = await sharp(crop).resize(Math.round(size * 0.8), Math.round(size * 0.72), { fit: 'inside' }).png().toBuffer();
    const sm = await sharp(scaled).metadata();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await sharp({ create: { width: size, height: size, channels: 4, background: backgroundFor(target) } })
      .composite([{ input: scaled, left: Math.round((size - (sm.width ?? size)) / 2), top: Math.round((size - (sm.height ?? size)) / 2) }])
      .flatten({ background: backgroundFor(target) })
      .png()
      .toFile(out);
    return out;
  };

  /** The generated sources of a split target: `plate` (if set) and each `add`. Written to frames/. */
  const genSplit = async (target: SplitTarget, force: boolean) => {
    const meta = readMeta(config, target);
    meta.prompt = composePrompt(config, target);
    meta.promptVersion = config.prompts.version;
    writeMeta(config, meta);
    const jobs: { id: string; kind: 'plate' | 'add'; label: string }[] = [
      ...(target.plate ? [{ id: 'plate', kind: 'plate' as const, label: target.plate }] : []),
      ...target.add.map((entry) => ({ id: entry.id, kind: 'add' as const, label: entry.label })),
    ];
    if (jobs.length === 0) {
      emit({ type: 'skip', step: 'gen', target: target.target, message: 'nothing to generate: every piece is cut from the base' });
      return;
    }
    if (provider.name === 'manual') {
      emit({ type: 'skip', step: 'gen', target: target.target, message: 'manual provider: import each edit with `ukiyo import <file> --target <target> --asset <id>`' });
      return;
    }
    for (const job of jobs) {
      const out = path.join(targetDir(config, target.target), 'frames', `${job.id}.png`);
      if (fs.existsSync(out) && !force) {
        emit({ type: 'skip', step: 'gen', target: target.target, message: `frames/${job.id}.png exists` });
        continue;
      }
      emit({ type: 'start', step: 'gen', target: target.target, message: `${job.kind} ${job.id}` });
      try {
        const ref = await splitRefImage(target, job.kind === 'add');
        const call = await withReferences(target, composeSplitPrompt(config, target, job.kind, job.label), { input: { file: ref, id: target.base }, exclude: [target.base] });
        const result = await withRetry('gen', target.target, () => provider.edit(call.prompt, ref, { size: defaultSize(target), refs: call.refs, log: (line) => emit({ type: 'log', message: line }) }));
        if (!result.file) throw new Error('provider returned no file');
        await copyIn(result.file, out);
        const m = readMeta(config, target);
        if (m.assets[job.id]) m.assets[job.id] = { ...m.assets[job.id]!, references: call.records };
        m.references = call.records;
        m.generatedAt = new Date().toISOString();
        m.provider = provider.name;
        writeMeta(config, m);
        emit({ type: 'done', step: 'gen', target: target.target, message: `frames/${job.id}.png` });
      } catch (error) {
        emit({ type: 'error', step: 'gen', target: target.target, message: error instanceof Error ? error.message : String(error) });
        if (error instanceof RateLimitError) return;
      }
      if (config.provider.gapMs > 0) await sleep(config.provider.gapMs);
    }
  };

  /**
   * Cut the base into its outputs (see `ops/split.ts`). Every output is
   * cropped to its art, padded to the declared aspect ratio about its
   * centre, and records where it sits on the base (`part`).
   */
  const finalizeSplit = async (target: SplitTarget, meta: ReturnType<typeof readMeta>): Promise<void> => {
    const [baseName, baseAsset] = splitRef(target.base);
    const baseFinalFile = stagePath(config, baseName, 'final', baseAsset);
    const baseCutFile = stagePath(config, baseName, 'cut', baseAsset);
    if (!fs.existsSync(baseFinalFile) || !fs.existsSync(baseCutFile)) throw new Error(`base ${target.base} has no final yet; run \`ukiyo final ${baseName}\` first`);
    const base = await readRaster(baseFinalFile);
    const { width, height } = base;
    const map = cutToFinal(await readRaster(baseCutFile), base);
    const baseCut = await readRaster(baseCutFile);
    const warnings: string[] = [];

    /** A generated edit (cut) resampled onto the base's final canvas. */
    const registered = async (id: string, tinted: boolean): Promise<Raster | null> => {
      const file = stagePath(config, target.target, 'cut', id);
      if (!fs.existsSync(file)) {
        warnings.push(`${id}: no cut edit; run \`ukiyo gen ${target.target}\` and \`ukiyo cut ${target.target}\``);
        return null;
      }
      const edit = await readRaster(file);
      const transform = register(tinted ? tintRaster(baseCut, target.baseTint) : baseCut, edit);
      meta.assets[id] = { ...(meta.assets[id] ?? { name: id, status: 'pending' }), registration: { iou: Number(transform.iou.toFixed(3)), scale: Number(transform.scale.toFixed(4)), coverage: 0 } };
      if (transform.iou < 0.8) warnings.push(`${id}: weak registration (overlap ${transform.iou.toFixed(2)}); the edit may have moved or reshaped the base.`);
      const out = resampleEdit(edit, transform, map, width, height);
      // Kept for the author: the edit on the base canvas, to pick piece boxes and check the fit.
      const preview = path.join(targetDir(config, target.target), 'registered', `${id}.png`);
      fs.mkdirSync(path.dirname(preview), { recursive: true });
      await writePng(out, preview);
      return out;
    };

    // Sources: the base, and each add's new pixels.
    const sources = new Map<string, Raster>([['base', base]]);
    const tintedBase = tintRaster(base, target.baseTint);
    for (const entry of target.add) {
      const edit = await registered(entry.id, true);
      if (!edit) continue;
      const bb = alphaBounds(base)!;
      sources.set(entry.id, newPixels(tintedBase, edit, target.diffThreshold, Math.max(12, Math.round(bb.width * bb.height * 0.0008))));
    }

    // Masks, in list order: a pixel belongs to the first piece that selects it.
    const taken = new Map<string, Uint8Array>();
    const masks = new Map<string, Uint8Array>();
    for (const piece of target.pieces) {
      const from = piece.from ?? 'base';
      const source = sources.get(from);
      if (!source) continue;
      const used = taken.get(from) ?? new Uint8Array(width * height);
      const mask = selectPiece(source, piece, used);
      let count = 0;
      for (let p = 0; p < mask.length; p += 1) {
        if (mask[p]) {
          used[p] = 1;
          count += 1;
        }
      }
      taken.set(from, used);
      masks.set(piece.id, mask);
      if (count === 0) warnings.push(`piece ${piece.id}: the mask selects no pixels`);
    }

    // Thin strips and soft edge pixels go to the art they border; halo with no solid art near it is dropped.
    const halos = new Map<string, Uint8Array>();
    for (const [from, source] of sources) {
      const own = target.pieces.filter((piece) => (piece.from ?? 'base') === from && masks.has(piece.id)).map((piece) => masks.get(piece.id)!);
      if (!own.length) continue;
      moveThinStrips(source, own);
      moveIslands(source, own);
      halos.set(from, assignSoftEdges(source, own, 2));
    }

    // The plate and each add's rest: the source minus its moving pieces, with a seam band kept along each cut.
    const rests = new Map<string, Raster>();
    for (const [from, source] of sources) {
      const out = masked(source, new Uint8Array(width * height).fill(1));
      const halo = halos.get(from);
      if (halo) clear(out, halo);
      const removed = new Uint8Array(width * height);
      for (const piece of target.pieces) {
        if ((piece.from ?? 'base') !== from || piece.mode === 'cover') continue;
        const mask = masks.get(piece.id)!;
        for (let p = 0; p < mask.length; p += 1) if (mask[p]) removed[p] = 1;
      }
      const stays = opaqueOutside(source, removed);
      const seam = band(removed, stays, width, height, target.seam);
      // Only solid pixels stay in the band: a soft edge pixel drawn twice (plate and piece) would darken.
      for (let p = 0; p < removed.length; p += 1) if (seam[p] && (source.data[p * 4 + 3] ?? 0) >= 250) removed[p] = 0;
      clear(out, removed);
      rests.set(from, out);
    }
    const plate = rests.get('base')!;
    if (target.plate) {
      const fill = await registered('plate', false);
      const region = new Uint8Array(width * height);
      for (const piece of target.pieces) {
        if ((piece.from ?? 'base') !== 'base' || piece.mode !== 'fill') continue;
        const mask = masks.get(piece.id)!;
        for (let p = 0; p < mask.length; p += 1) if (mask[p]) region[p] = 1;
      }
      if (fill) blendFill(plate, fill, dilate(region, width, height, 4), 3);
    }

    // Pieces, each with a seam band of its children, so a joint between two moving pieces stays closed too.
    const pieceRasters = new Map<string, Raster>();
    for (const piece of target.pieces) {
      const mask = masks.get(piece.id);
      const source = sources.get(piece.from ?? 'base');
      if (!mask || !source) continue;
      const withChildren = new Uint8Array(mask);
      for (const child of target.pieces.filter((c) => c.parent === piece.id)) {
        const childMask = masks.get(child.id);
        if (!childMask) continue;
        const seam = band(childMask, mask, width, height, target.seam);
        for (let p = 0; p < seam.length; p += 1) if (seam[p] && (source.data[p * 4 + 3] ?? 0) >= 250) withChildren[p] = 1;
      }
      pieceRasters.set(piece.id, masked(source, withChildren));
    }

    // The rebuild check: plate, adds and pieces over each other give the base back.
    const ignore = new Uint8Array(width * height);
    for (const piece of target.pieces) {
      if (piece.mode !== 'fill') continue;
      const mask = masks.get(piece.id);
      if (mask) for (let p = 0; p < mask.length; p += 1) if (mask[p]) ignore[p] = 1;
    }
    for (const entry of target.add) {
      const source = sources.get(entry.id);
      if (source) for (let p = 0; p < width * height; p += 1) if ((source.data[p * 4 + 3] ?? 0) > 0) ignore[p] = 1;
    }
    const baseHalo = halos.get('base');
    if (baseHalo) for (let p = 0; p < baseHalo.length; p += 1) if (baseHalo[p]) ignore[p] = 1;
    // Cover pieces lie on a plate that still has them; only the pieces cut out of it must fill their holes.
    const layered = [plate, ...target.pieces.filter((piece) => (piece.from ?? 'base') === 'base' && piece.mode !== 'cover').map((piece) => pieceRasters.get(piece.id)).filter((r): r is Raster => Boolean(r))];
    const error = rebuildError(layered, base, ignore);
    if (error.share > 0.002) warnings.push(`rebuild: ${(error.share * 100).toFixed(2)}% of the base differs by more than 24 (max ${Math.round(error.max)}); a piece may overlap another.`);

    // Lights: one per lit region of each piece that emits (its material's `emits`), in base px.
    // A locked hand list for a piece replaces what is found on it.
    const rules = lightRules();
    const lights: LightPoint[] = [];
    for (const piece of target.pieces) {
      const from = piece.from ?? 'base';
      const hand = target.lights?.[piece.id];
      if (hand?.locked) {
        lights.push(...hand.points.map((p) => ({ color: '#ffffff', intensity: 1, ...p, piece: piece.id, from })));
        continue;
      }
      const mode = emitsOf(piece.material);
      const raster = pieceRasters.get(piece.id);
      if (!mode || !raster) continue;
      const found = detectLights(raster, mode, rules, masks.get(piece.id));
      if (found.length === 0) warnings.push(`piece ${piece.id}: material "${piece.material}" emits light, but no lit region was found`);
      lights.push(...found.map((l) => ({ ...l, piece: piece.id, from })));
    }
    // Lit copies left on the plate: a plan may cut only some lanterns of a row, or some candles of a
    // rack. Each copy of an emitting piece that stays on the plate gives the piece's lights there, with
    // no piece: the plate carries them. A locked `plate` entry replaces what is found.
    const plateHand = target.lights?.plate;
    if (plateHand?.locked) lights.push(...plateHand.points.map((p) => ({ color: '#ffffff', intensity: 1, ...p, from: 'base' })));
    else {
      const templates = target.pieces
        .filter((piece) => (piece.from ?? 'base') === 'base' && masks.has(piece.id))
        .map((piece) => ({ id: piece.id, mask: masks.get(piece.id)!, lights: lights.filter((l) => l.piece === piece.id) }))
        .filter((template) => template.lights.length > 0);
      if (templates.length > 0) {
        const exclude = new Uint8Array(width * height);
        for (const piece of target.pieces) {
          const mask = masks.get(piece.id);
          if ((piece.from ?? 'base') === 'base' && mask) for (let p = 0; p < mask.length; p += 1) if (mask[p]) exclude[p] = 1;
        }
        const copies = findLitCopies(base, templates, dilate(exclude, width, height, 3));
        for (const copy of copies) {
          // The copy is not the piece: its lights belong to no piece.
          lights.push(...copy.lights.map(({ x, y, radius, color, intensity }) => ({ x, y, radius, color, intensity, from: 'base' })));
          warnings.push(`lights: a copy of lit piece ${copy.of} stays on the plate at (${copy.x}, ${copy.y}) and gives light there; cut it as a piece if it should move`);
        }
      }
    }
    // A light source with no emitting piece: the lit regions of the whole base stay with the plate.
    const [bn, ba] = splitRef(target.base);
    const baseTarget = byName.get(bn);
    if (lights.length === 0 && baseTarget && isLightSource(baseTarget, ba)) lights.push(...detectLights(base, 'lit', rules).map((l) => ({ ...l, from: 'base' })));
    if (lights.length) meta.lights = lights;
    else delete meta.lights;

    // Write every output: cropped to its art, padded to the declared aspect about its centre.
    const declared = declaredAspect(config, target);
    const baseFrame = frameNameOf(target.base);
    const baseAnchor = anchorFraction(config.kinds[byName.get(baseName)!.kind]?.anchor ?? 'bottom-center');
    const write = async (name: string, raster: Raster, role: PartMeta['role'], joint: [number, number] | null, z: number, extra: Partial<PartMeta> = {}) => {
      const bounds = alphaBounds(raster, 0);
      const file = stagePath(config, target.target, 'final', name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (!bounds) {
        warnings.push(`${name}: empty; nothing written`);
        if (fs.existsSync(file)) fs.rmSync(file);
        return;
      }
      const padBy = 2;
      const left = Math.max(0, bounds.x - padBy);
      const top = Math.max(0, bounds.y - padBy);
      const w = Math.min(width, bounds.x + bounds.width + padBy) - left;
      const h = Math.min(height, bounds.y + bounds.height + padBy) - top;
      const pad = declared ? aspectPad(w, h, declared.ratio, 'center') : { width: w, height: h, dx: 0, dy: 0 };
      const crop = await toSharp(raster).extract({ left, top, width: w, height: h }).png().toBuffer();
      await sharp({ create: { width: pad.width, height: pad.height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([{ input: crop, left: pad.dx, top: pad.dy }])
        .png()
        .toFile(file);
      const x = left - pad.dx;
      const y = top - pad.dy;
      const jx = joint ? joint[0] : x + pad.width / 2;
      const jy = joint ? joint[1] : y + pad.height / 2;
      meta.assets[name] = {
        ...(meta.assets[name] ?? { name, status: 'pending' }),
        name,
        width: pad.width,
        height: pad.height,
        content: { x: pad.dx, y: pad.dy, width: w, height: h },
        // The atlas pivot is the base's anchor point, like a layer, so tools that stack frames by pivot line them up.
        anchor: { x: (baseAnchor.x * width - x) / pad.width, y: (baseAnchor.y * height - y) / pad.height },
        part: { base: baseFrame, baseWidth: width, baseHeight: height, x, y, joint: { x: jx - x, y: jy - y }, z, role, ...extra },
      };
    };
    const outputs = assetNames(target);
    if (outputs.includes('plate')) await write('plate', plate, 'plate', null, 0);
    for (const [i, entry] of target.add.entries()) {
      const rest = rests.get(entry.id);
      if (rest && entry.rest) await write(entry.id, rest, 'add', null, 0.5 + i * 0.01);
    }
    for (const [i, piece] of target.pieces.entries()) {
      const raster = pieceRasters.get(piece.id);
      const material = piece.material ? config.rig?.materials[piece.material] : undefined;
      if (piece.material && !material) warnings.push(`piece ${piece.id}: material "${piece.material}" is not in rig.materials`);
      const rig: PartRig | undefined = material
        ? {
            material: piece.material!,
            ...((piece.motion?.rest ?? material.rest) ? { rest: piece.motion?.rest ?? material.rest } : {}),
            ...((piece.motion?.use ?? material.use) ? { use: piece.motion?.use ?? material.use } : {}),
            ...((piece.motion?.gust ?? material.gust) ? { gust: piece.motion?.gust ?? material.gust } : {}),
            lag: material.lag,
            stagger: config.rig?.stagger ?? 0,
            ...(material.phases ? { phases: material.phases } : {}),
          }
        : undefined;
      if (raster) await write(piece.id, raster, 'piece', [piece.joint[0], piece.joint[1]], piece.z ?? i + 1, { mode: piece.mode, ...(piece.parent ? { parent: piece.parent } : {}), ...(rig ? { rig } : {}) });
    }
    // Each output carries its lights in its own px: a piece its own, the plate those of no piece.
    for (const name of assetNames(target)) {
      const asset = meta.assets[name];
      if (!asset?.part) continue;
      const own = lights.filter((l) => (l.piece ? l.piece === name : name === 'plate'));
      if (own.length) asset.lights = own.map((l) => ({ ...l, x: Math.round((l.x - asset.part!.x) * 100) / 100, y: Math.round((l.y - asset.part!.y) * 100) / 100 }));
      else delete asset.lights;
    }
    meta.warnings = [...meta.warnings.filter((w) => !w.startsWith('split ')), ...warnings.map((w) => `split ${w}`)];
    for (const warning of warnings) emit({ type: 'warn', step: 'final', target: target.target, message: warning });
  };

  // ---- plan ------------------------------------------------------------------------

  /**
   * The base on a plain ground with a grid over it, for the model. Lines every
   * tenth of the width and height, labelled 0.1 … 0.9: the model answers in
   * those fractions, which it reads far more reliably than pixels.
   */
  const gridImage = async (file: string, out: string): Promise<void> => {
    const m = await sharp(file).metadata();
    const w = m.width ?? 1;
    const h = m.height ?? 1;
    const k = 1024 / Math.max(w, h);
    const W = Math.round(w * k);
    const H = Math.round(h * k);
    let svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`;
    for (let i = 1; i < 10; i += 1) {
      const x = (W * i) / 10;
      const y = (H * i) / 10;
      svg += `<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#0004" stroke-width="1"/><text x="${x + 2}" y="14" font-size="13" font-family="Helvetica" fill="#000">${(i / 10).toFixed(1)}</text>`;
      svg += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#0004" stroke-width="1"/><text x="2" y="${y - 3}" font-size="13" font-family="Helvetica" fill="#000">${(i / 10).toFixed(1)}</text>`;
    }
    svg += '</svg>';
    const art = await sharp(file).resize(W, H).png().toBuffer();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await sharp({ create: { width: W, height: H, channels: 4, background: '#b8d4c6' } }).composite([{ input: art }, { input: Buffer.from(svg) }]).png().toFile(out);
  };

  /** Labels in fractions of the image, to base px. */
  const toPixels = (labels: Label[], w: number, h: number): Label[] =>
    labels.map((l) => ({
      ...l,
      box: [l.box[0] * w, l.box[1] * h, l.box[2] * w, l.box[3] * h],
      seed: [l.seed[0] * w, l.seed[1] * h],
    }));

  /** Pull the first JSON object out of a model's answer. */
  const parseLabels = (text: string): Label[] => {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error(`no JSON in the answer: ${text.slice(0, 200)}`);
    const parsed = JSON.parse(text.slice(start, end + 1)) as { parts?: Label[] };
    return (parsed.parts ?? []).filter((p) => p && typeof p.label === 'string' && Array.isArray(p.box) && p.box.length === 4 && Array.isArray(p.seed) && p.seed.length === 2);
  };

  /**
   * Score every sheet and single asset whose kind has a rule in `rig.kinds`,
   * and write a `split` plan into the manifest for each one at or above its
   * threshold. The model labels the moving pieces by material once; the
   * labels are cached in `<split>/plan-labels.json`, so a re-run gives the
   * same plan. A target with `plan.locked` is kept as it is, and so is every
   * piece with `locked: true`.
   */
  const plan = async (names?: string[], opts: { relabel?: boolean; dry?: boolean; scoreOnly?: boolean; ignoreLocks?: boolean; labelAll?: boolean } = {}): Promise<PlanRow[]> => {
    const rig = config.rig;
    if (!rig) throw new Error('ukiyo.json has no `rig` section; add materials, kinds and score weights first (see the manifest reference, "Multipart rules")');
    const rows: PlanRow[] = [];
    const raw = JSON.parse(fs.readFileSync(config.manifestPath, 'utf8')) as Record<string, unknown>[];
    const updates: { entry: Record<string, unknown>; after: string }[] = [];
    const candidates = pick(names).filter((t) => (t.compose === 'sheet' || t.compose === 'single') && rig.kinds[t.kind] && (!rig.groups || rig.groups.includes(groupOf(t))));
    // Score everything first; plan in order of priority: triggered or above threshold, then by score.
    const queue: { target: Target; asset: string; file: string; base: Raster; complexity: Complexity; trigger: string | null; effects: EffectsReview }[] = [];
    for (const target of candidates) {
      const meta = readMeta(config, target);
      for (const asset of assetNames(target)) {
        const file = stagePath(config, target.target, 'final', asset);
        if (!fs.existsSync(file) || rig.exclude.some((e) => new RegExp(e, 'i').test(`${target.target}/${asset}`))) continue;
        const base = await readRaster(file);
        const complexity = await measureComplexity(base, rig);
        meta.assets[asset] = { ...(meta.assets[asset] ?? { name: asset, status: 'pending' }), complexity };
        const words = [target.target, asset, target.compose === 'sheet' ? (target.assets[assetNames(target).indexOf(asset)] ?? '') : target.subject].join(' ');
        const hit = rig.triggers.find((t) => new RegExp(t.match, 'i').test(words));
        // The wind and light pass runs on every sprite the rules cover, planned or not.
        const effects = proposeEffects(target, asset, file, base, meta.assets[asset], words, opts.relabel);
        if (!opts.dry) meta.assets[asset] = { ...meta.assets[asset]!, effects };
        queue.push({ target, asset, file, base, complexity, trigger: hit ? hit.match : null, effects });
      }
      writeMeta(config, meta);
    }
    const due = (q: (typeof queue)[number]) => Boolean(q.trigger) || q.complexity.score >= rig.kinds[q.target.kind]!.threshold || Boolean(opts.labelAll);
    queue.sort((a, b) => Number(due(b)) - Number(due(a)) || b.complexity.score - a.complexity.score);
    for (const { target, asset, file, base, complexity, trigger, effects } of queue) {
      const meta = readMeta(config, target);
      const rule = rig.kinds[target.kind]!;
      try {
        const ref = `${target.target}/${asset}`;
        const summary = `wind ${effects.wind === 'none' ? 'none' : effects.wind.join('+')}, light ${effects.light}${effects.lit && effects.light === 'none' ? ` (${effects.lit} lit-looking)` : ''} [${effects.status}]`;
        const row: PlanRow = { target: target.target, asset, score: complexity.score, threshold: rule.threshold, action: '', effects: summary, ...(trigger ? { trigger } : {}) };
        rows.push(row);
        if (!trigger && complexity.score < rule.threshold && !opts.labelAll) {
          row.action = 'below threshold';
          continue;
        }
        const existingIndex = raw.findIndex((t) => t.compose === 'split' && t.base === ref);
        const existing = existingIndex >= 0 ? (raw[existingIndex] as Record<string, any>) : null;
        if (opts.scoreOnly) {
          row.action = existingIndex >= 0 ? `has ${String(raw[existingIndex]!.target)}` : 'needs a plan';
          continue;
        }
        if (existing?.plan?.locked && !opts.ignoreLocks) {
          row.action = `locked (${existing.target})`;
          row.pieces = (existing.pieces as { id: string }[]).map((p) => p.id);
          continue;
        }
        const splitName = (existing?.target as string | undefined) ?? `${rig.prefix}${asset}`;
        const dir = targetDir(config, splitName);
        const cacheFile = path.join(dir, 'plan-labels.json');
        const hash = createHash('sha1').update(fs.readFileSync(file)).update(JSON.stringify(rig.materials)).update('fractions-v1').digest('hex').slice(0, 12);
        let labels: Label[] | null = null;
        if (!opts.relabel && fs.existsSync(cacheFile)) {
          const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { hash: string; labels: Label[] };
          if (cached.hash === hash) labels = cached.labels;
        }
        if (!labels) {
          if (!provider.describe) {
            row.action = `needs labels: provider "${provider.name}" cannot describe images; write ${path.relative(config.root, cacheFile)} by hand`;
            continue;
          }
          const grid = path.join(dir, 'plan-grid.png');
          await gridImage(file, grid);
          const subject = (existing?.subject as string | undefined) ?? (target.compose === 'sheet' ? (target.assets[target.names?.indexOf(asset) ?? assetNames(target).indexOf(asset)] ?? asset) : target.subject);
          const prompt = templatesFor(config).render('plan-label', {
            subject,
            maxParts: rule.maxParts,
            materials: Object.entries(rig.materials).map(([name, m]) => ({ name, describe: m.describe })),
          });
          emit({ type: 'start', step: 'plan', target: ref, message: 'labelling pieces' });
          try {
            const answer = await withRetry('plan', ref, () => provider.describe!(prompt, grid, { log: (line) => emit({ type: 'log', message: line }) }));
            labels = parseLabels(answer);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(cacheFile, `${JSON.stringify({ hash, labels, answer }, null, 2)}\n`);
          } catch (error) {
            row.action = `labelling failed: ${error instanceof Error ? error.message : String(error)}`;
            emit({ type: 'error', step: 'plan', target: ref, message: row.action });
            if (error instanceof RateLimitError) break;
            continue;
          }
          if (config.provider.gapMs > 0) await sleep(config.provider.gapMs);
        }
        // Locked pieces stay first in the list, so they take their pixels first: the plan cuts round them.
        const locked = opts.ignoreLocks ? [] : ((existing?.pieces as Record<string, any>[] | undefined) ?? []).filter((p) => p.locked);
        const { pieces, dropped } = planPieces(base, toPixels(labels, base.width, base.height), rig, rule.maxParts, locked as KeptPiece[]);
        row.dropped = dropped;
        if (opts.ignoreLocks) row.plan = { pieces, existing: (existing?.pieces as Record<string, unknown>[] | undefined) ?? [] };
        const merged = [...locked, ...pieces.filter((p) => !locked.some((l) => l.id === p.id))];
        row.pieces = merged.map((p) => `${p.id} (${p.material ?? '?'}, ${p.mode ?? 'detach'})`);
        if (merged.length === 0) {
          row.action = 'nothing moves';
          if (!opts.dry) meta.assets[asset] = { ...meta.assets[asset]!, still: true };
          continue;
        }
        if (!opts.dry) delete meta.assets[asset]!.still;
        row.action = existing ? `replanned ${splitName}` : `planned ${splitName}`;
        if (opts.dry) continue;
        const fills = merged.filter((p) => p.mode === 'fill');
        const baseTarget = raw.find((t) => t.target === target.target) as Record<string, any>;
        const entry: Record<string, unknown> = {
          target: splitName,
          compose: 'split',
          kind: target.kind,
          game: existing?.game ?? rig.group ?? baseTarget?.game,
          ...((existing?.aspect ?? rig.aspect) ? { aspect: existing?.aspect ?? rig.aspect } : {}),
          base: ref,
          subject: existing?.subject ?? (target.compose === 'sheet' ? asset.replace(/-/g, ' ') : target.subject),
          ...((existing?.notes ?? rig.notes) ? { notes: existing?.notes ?? rig.notes } : {}),
          ...((existing?.background ?? baseTarget?.background) && (fills.length || existing?.add) ? { background: existing?.background ?? baseTarget?.background } : {}),
          ...(fills.length ? { plate: existing?.plate ?? `the ${fills.map((p) => p.id.replace(/-/g, ' ')).join(', ')}. Paint what is behind them` } : existing?.plate ? { plate: existing.plate } : {}),
          ...(existing?.add ? { add: existing.add } : {}),
          pieces: merged,
          plan: { source: 'auto', score: complexity.score },
        };
        updates.push({ entry, after: target.target });
        // A new plan needs a new review.
        const known = byName.get(splitName);
        if (known) {
          const splitMeta = readMeta(config, known);
          splitMeta.plan = { status: 'pending' };
          writeMeta(config, splitMeta);
        }
      } finally {
        writeMeta(config, meta);
      }
    }
    if (updates.length > 0 && !opts.dry) {
      // Re-read the manifest and change only the plans, so an edit made meanwhile is kept.
      const fresh = JSON.parse(fs.readFileSync(config.manifestPath, 'utf8')) as Record<string, unknown>[];
      for (const { entry, after } of updates) {
        const at = fresh.findIndex((t) => t.target === entry.target);
        if (at >= 0) fresh[at] = entry;
        else fresh.splice(fresh.findIndex((t) => t.target === after) + 1, 0, entry);
      }
      fs.writeFileSync(config.manifestPath, `${JSON.stringify(fresh, null, 2)}\n`);
    }
    return rows;
  };

  // ---- gen -------------------------------------------------------------------------

  const gen = async (names?: string[], force = false) => {
    const targets = pick(names);
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i]!;
      if (target.compose === 'layer') {
        await genLayers(target, force);
        continue;
      }
      if (target.compose === 'split') {
        await genSplit(target, force);
        continue;
      }
      const raw = rawPath(config, target.target);
      if (fs.existsSync(raw) && !force) {
        emit({ type: 'skip', step: 'gen', target: target.target, message: 'raw.png exists' });
        continue;
      }
      const prompt = composePrompt(config, target);
      const meta = readMeta(config, target);
      meta.prompt = prompt;
      meta.promptVersion = config.prompts.version;
      if (provider.name === 'manual') {
        writeMeta(config, meta);
        emit({ type: 'skip', step: 'gen', target: target.target, message: 'manual provider: run `ukiyo prompt` then `ukiyo import`' });
        continue;
      }
      emit({ type: 'start', step: 'gen', target: target.target, message: `${target.compose}, ${defaultSize(target)}` });
      try {
        // A parts sheet with a reference is an edit of the assembled character.
        const referenceFile =
          target.compose === 'parts' && target.reference
            ? stagePath(config, target.reference.split('/')[0]!, 'cut', target.reference.split('/')[1]!)
            : null;
        if (referenceFile && !fs.existsSync(referenceFile)) {
          throw new Error(`reference is missing; generate and cut it first (${path.relative(config.root, referenceFile)})`);
        }
        const log = (line: string) => emit({ type: 'log', message: line });
        const partsRef = target.compose === 'parts' ? target.reference : undefined;
        const call = await withReferences(target, prompt, referenceFile && partsRef ? { input: { file: referenceFile, id: partsRef }, exclude: [partsRef] } : {});
        const result = await withRetry('gen', target.target, () =>
          referenceFile
            ? provider.edit(call.prompt, referenceFile, { size: defaultSize(target), refs: call.refs, log })
            : provider.generate(call.prompt, { refs: call.refs, size: defaultSize(target), log }),
        );
        if (!result.file) throw new Error('provider returned no file');
        await copyIn(result.file, raw);
        meta.references = call.records;
        for (const name of assetNames(target)) meta.assets[name] = { ...meta.assets[name]!, references: call.records };
        meta.generatedAt = new Date().toISOString();
        meta.provider = provider.name;
        writeMeta(config, meta);
        emit({ type: 'done', step: 'gen', target: target.target, message: path.relative(config.root, raw) });
      } catch (error) {
        emit({ type: 'error', step: 'gen', target: target.target, message: error instanceof Error ? error.message : String(error) });
        if (error instanceof RateLimitError) break;
      }
      if (i < targets.length - 1 && config.provider.gapMs > 0) await sleep(config.provider.gapMs);
    }
  };

  // ---- import ----------------------------------------------------------------------

  const importFile = async (name: string, file: string, asset?: string) => {
    const target = byName.get(name);
    if (!target) throw new Error(`Unknown target "${name}"`);
    if (target.compose === 'layer' || target.compose === 'split') {
      const sources = target.compose === 'split' ? [...(target.plate ? ['plate'] : []), ...target.add.map((entry) => entry.id)] : assetNames(target);
      if (!asset || !sources.includes(asset)) throw new Error(`${target.compose === 'split' ? 'Split' : 'Layer'} target "${name}" needs --asset <${sources.join('|')}>`);
      await copyIn(path.resolve(file), path.join(targetDir(config, target.target), 'frames', `${asset}.png`));
      const meta = readMeta(config, target);
      meta.prompt ??= composePrompt(config, target);
      meta.assets[asset] = { name: asset, status: 'pending' };
      writeMeta(config, meta);
      emit({ type: 'done', step: 'import', target: target.target, message: `frames/${asset}.png` });
      return;
    }
    const raw = rawPath(config, target.target);
    await copyIn(path.resolve(file), raw);
    const meta = readMeta(config, target);
    meta.prompt ??= composePrompt(config, target);
    meta.generatedAt = new Date().toISOString();
    meta.provider = 'import';
    writeMeta(config, meta);
    emit({ type: 'done', step: 'import', target: target.target, message: path.relative(config.root, raw) });
  };

  // ---- animate (per-frame edits for strips) ----------------------------------------

  const animate = async (names?: string[], force = false) => {
    for (const target of pick(names)) {
      if (target.compose !== 'strip') continue;
      const base = stagePath(config, target.target, 'cut', target.frames[0]!);
      if (!fs.existsSync(base)) {
        emit({ type: 'skip', step: 'animate', target: target.target, message: `cut/${target.frames[0]}.png missing; run cut first` });
        continue;
      }
      for (const frame of target.frames.slice(1)) {
        const out = path.join(targetDir(config, target.target), 'frames', `${frame}.png`);
        if (fs.existsSync(out) && !force) {
          emit({ type: 'skip', step: 'animate', target: target.target, message: `frames/${frame}.png exists` });
          continue;
        }
        emit({ type: 'start', step: 'animate', target: target.target, message: frame });
        try {
          const instruction = framePoseInstruction(config, target, frame);
          const meta = readMeta(config, target);
          const call = await withReferences(target, composeEditPrompt(config, meta.prompt ?? composePrompt(config, target), instruction, target.background), { input: { file: base, id: `${target.target}/${target.frames[0]}` }, editing: frame });
          const result = await withRetry('animate', target.target, () => provider.edit(call.prompt, base, { size: '1024x1024', refs: call.refs, log: (line) => emit({ type: 'log', message: line }) }));
          if (!result.file) throw new Error('provider returned no file');
          await copyIn(result.file, out);
          const m = readMeta(config, target);
          m.assets[frame] = { ...m.assets[frame]!, references: call.records };
          writeMeta(config, m);
          emit({ type: 'done', step: 'animate', target: target.target, message: `frames/${frame}.png` });
        } catch (error) {
          emit({ type: 'error', step: 'animate', target: target.target, message: error instanceof Error ? error.message : String(error) });
          if (error instanceof RateLimitError) return;
        }
        if (config.provider.gapMs > 0) await sleep(config.provider.gapMs);
      }
    }
  };

  // ---- edit (iterate one asset) ----------------------------------------------------

  const edit = async (name: string, asset: string, instruction: string) => {
    const target = byName.get(name);
    if (!target) throw new Error(`Unknown target "${name}"`);
    const source = stagePath(config, target.target, 'cut', asset);
    if (!fs.existsSync(source)) throw new Error(`cut/${asset}.png missing for ${name}; run cut first`);
    emit({ type: 'start', step: 'edit', target: target.target, message: asset });
    const meta = readMeta(config, target);
    const call = await withReferences(target, composeEditPrompt(config, meta.prompt ?? composePrompt(config, target), instruction, target.background), { input: { file: source, id: `${target.target}/${asset}` }, editing: asset });
    const result = await withRetry('edit', target.target, () => provider.edit(call.prompt, source, { size: '1024x1024', refs: call.refs, log: (line) => emit({ type: 'log', message: line }) }));
    if (!result.file) throw new Error('provider returned no file');
    const out = path.join(targetDir(config, target.target), 'frames', `${asset}.png`);
    await copyIn(result.file, out);
    meta.assets[asset] = { name: asset, status: 'pending', references: call.records };
    writeMeta(config, meta);
    for (const stage of ['final'] as const) {
      const file = stagePath(config, target.target, stage, asset);
      if (fs.existsSync(file)) fs.rmSync(file);
    }
    emit({ type: 'done', step: 'edit', target: target.target, message: `frames/${asset}.png; run cut` });
  };

  // ---- cut -------------------------------------------------------------------------

  const cutOne = async (source: string, out: string, box?: { x: number; y: number; width: number; height: number }, threshold = config.cutout.threshold, chroma?: string) => {
    let raster = await readRaster(source);
    if (box) {
      const pad = 6;
      const left = Math.max(0, box.x - pad);
      const top = Math.max(0, box.y - pad);
      const width = Math.min(raster.width - left, box.width + pad * 2);
      const height = Math.min(raster.height - top, box.height + pad * 2);
      const buffer = await sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 4 } })
        .extract({ left, top, width, height })
        .png()
        .toBuffer();
      raster = await readRaster(buffer);
    }
    const mode = chroma ? 'chroma' : config.cutout.mode;
    const background = chroma ? parseHex(chroma) : config.cutout.mode === 'chroma' ? parseHex(config.cutout.chroma) : parseHex(config.styleGuide.canvas.backgroundColor);
    const outline = config.styleGuide.linework.outlineColor;
    const ink = /^#[0-9a-f]{6}$/i.test(outline) ? parseHex(outline) : undefined;
    const result = cutout(raster, { mode, background, ink, threshold, feather: config.cutout.feather, despill: config.cutout.despill });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await writePng(result.raster, out);
  };

  const cut = async (names?: string[], force = false) => {
    for (const target of pick(names)) {
      const raw = rawPath(config, target.target);
      if (target.compose === 'split') {
        // Only the generated edits are cut; the pieces are cut from the base by mask in `final`.
        let count = 0;
        for (const id of [...(target.plate ? ['plate'] : []), ...target.add.map((entry) => entry.id)]) {
          const frameFile = path.join(targetDir(config, target.target), 'frames', `${id}.png`);
          const out = stagePath(config, target.target, 'cut', id);
          // A newer edit (a regenerated plate) is cut again.
          const stale = fs.existsSync(out) && fs.existsSync(frameFile) && fs.statSync(frameFile).mtimeMs > fs.statSync(out).mtimeMs;
          if (!fs.existsSync(frameFile) || (fs.existsSync(out) && !force && !stale)) continue;
          await cutOne(frameFile, out, undefined, target.cutout?.threshold, target.background);
          count += 1;
        }
        emit({ type: count > 0 ? 'done' : 'skip', step: 'cut', target: target.target, message: count > 0 ? `${count} edit${count === 1 ? '' : 's'}` : 'nothing to cut' });
        continue;
      }
      const outputs = assetNames(target);
      const allDone = outputs.every((n) => fs.existsSync(stagePath(config, target.target, 'cut', n)));
      if (allDone && !force) {
        emit({ type: 'skip', step: 'cut', target: target.target, message: 'cut/ complete' });
        continue;
      }
      if (target.compose === 'layer') {
        emit({ type: 'start', step: 'cut', target: target.target });
        let count = 0;
        for (const name of outputs) {
          const frameFile = path.join(targetDir(config, target.target), 'frames', `${name}.png`);
          const out = stagePath(config, target.target, 'cut', name);
          if (!fs.existsSync(frameFile) || (fs.existsSync(out) && !force)) continue;
          await cutOne(frameFile, out, undefined, target.cutout?.threshold, target.background);
          count += 1;
        }
        emit({ type: 'done', step: 'cut', target: target.target, message: `${count} layer${count === 1 ? '' : 's'}` });
        continue;
      }
      if (!fs.existsSync(raw)) {
        emit({ type: 'skip', step: 'cut', target: target.target, message: 'raw.png missing' });
        continue;
      }
      emit({ type: 'start', step: 'cut', target: target.target });
      const meta = readMeta(config, target);
      meta.warnings = [];
      try {
        if (target.compose === 'backdrop' && config.cutout.mode === 'ink') {
          // Line art on paper: the paper goes, the drawing stays at full size.
          await cutOne(raw, stagePath(config, target.target, 'cut', target.target));
        } else if (target.compose === 'backdrop') {
          const out = stagePath(config, target.target, 'cut', target.target);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          await sharp(raw).png().toFile(out);
        } else if (target.compose === 'single') {
          await cutOne(raw, stagePath(config, target.target, 'cut', target.target), undefined, target.cutout?.threshold, target.background);
        } else {
          const raster = await readRaster(raw);
          const background = target.background ? parseHex(target.background) : config.cutout.mode === 'chroma' ? parseHex(config.cutout.chroma) : undefined;
          const detected = detectComponents(raster, {
            threshold: config.cutout.detectThreshold,
            minArea: target.cutout?.minArea ?? config.cutout.minArea,
            mergeGap: target.cutout?.mergeGap ?? config.cutout.mergeGap,
            background,
          });
          let expected = outputs.length;
          // A parts sheet may leave out trailing optional parts (a tail). Then
          // the detected pieces are the leading names, and nothing is split.
          let present = outputs;
          if (target.compose === 'parts' && detected.boxes.length < outputs.length) {
            let optionalTail = 0;
            for (let i = target.parts.length - 1; i >= 0 && target.parts[i]!.required === false; i -= 1) optionalTail += 1;
            const missing = outputs.length - detected.boxes.length;
            if (missing <= optionalTail) {
              present = outputs.slice(0, detected.boxes.length);
              expected = present.length;
              const note = `Optional part${missing === 1 ? '' : 's'} not drawn: ${outputs.slice(present.length).join(', ')}.`;
              meta.warnings.push(note);
              emit({ type: 'warn', step: 'cut', target: target.target, message: note });
            }
          }
          const { boxes, warning } = coerceCount(detected.boxes, expected, raster.width);
          meta.detected = detected.boxes.length;
          meta.expected = expected;
          if (warning) {
            meta.warnings.push(warning);
            emit({ type: 'warn', step: 'cut', target: target.target, message: warning });
          }
          for (const name of outputs) {
            if (!present.includes(name)) {
              meta.assets[name] = { ...meta.assets[name]!, sourceBox: undefined, missing: true };
              // Drop anything an earlier cut left behind for this part.
              for (const stage of ['cut', 'final'] as const) {
                const stale = stagePath(config, target.target, stage, name);
                if (fs.existsSync(stale)) fs.rmSync(stale);
              }
            }
          }
          for (let i = 0; i < present.length; i += 1) {
            const name = present[i]!;
            const frameFile = path.join(targetDir(config, target.target), 'frames', `${name}.png`);
            const box = boxes[i]!;
            if (fs.existsSync(frameFile)) {
              // A per-frame edit replaces the slice from the sheet.
              // An edit may come back on the style background instead of the
              // target's chroma colour; cut it on the colour it actually has.
              const frame = await readRaster(frameFile);
              const seen = estimateBackground(frame);
              const chroma = target.background ? parseHex(target.background) : undefined;
              const onChroma = chroma && colorDistance(seen.r, seen.g, seen.b, chroma.r, chroma.g, chroma.b) < 60;
              await cutOne(frameFile, stagePath(config, target.target, 'cut', name), undefined, target.cutout?.threshold, onChroma ? target.background : undefined);
              meta.assets[name] = { ...meta.assets[name]!, sourceBox: undefined };
            } else {
              await cutOne(raw, stagePath(config, target.target, 'cut', name), box, target.cutout?.threshold, target.background);
              meta.assets[name] = { ...meta.assets[name]!, sourceBox: box };
            }
          }
        }
        writeMeta(config, meta);
        emit({ type: 'done', step: 'cut', target: target.target, message: `${outputs.length} asset${outputs.length === 1 ? '' : 's'}` });
      } catch (error) {
        emit({ type: 'error', step: 'cut', target: target.target, message: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  // ---- final (crop + align + fit) --------------------------------------------------

  /**
   * One overlay: register the edit to its base, keep the new pixels, and
   * write it at the base's scale with a pivot on the base's anchor point, so
   * drawing base and overlay at the same position lines them up.
   */
  const finalizeLayer = async (target: LayerTarget, name: string, input: string, output: string, meta: ReturnType<typeof readMeta>): Promise<string | null> => {
    const ref = layerBase(target, name);
    const [baseName, baseAsset] = splitRef(ref);
    const baseTarget = byName.get(baseName)!;
    const baseCutFile = stagePath(config, baseName, 'cut', baseAsset);
    const baseFinalFile = stagePath(config, baseName, 'final', baseAsset);
    if (!fs.existsSync(baseCutFile) || !fs.existsSync(baseFinalFile)) {
      return `layer ${name}: base ${ref} has no final yet; run \`ukiyo final ${baseName}\` first.`;
    }
    const baseCut = await readRaster(baseCutFile);
    const tinted = tintRaster(baseCut, target.baseTint);
    const edit = await readRaster(input);
    const transform = register(tinted, edit);
    const bb = alphaBounds(baseCut)!;
    const minArea = Math.max(24, Math.round(bb.width * bb.height * 0.0015));
    const extracted = extractLayer(tinted, edit, transform, target.diffThreshold, minArea);
    const ob = alphaBounds(extracted.raster, 24);
    if (!ob) {
      meta.assets[name] = { ...meta.assets[name]!, registration: { iou: transform.iou, scale: transform.scale, coverage: 0 } };
      return `layer ${name}: no new pixels found; the edit may not have added the item.`;
    }
    // Scale: the same px-per-source-px the base got in its final.
    const baseFinal = await readRaster(baseFinalFile);
    const fb = alphaBounds(baseFinal)!;
    const factor = fb.height / bb.height;
    // Pivot: the base's anchor point, in base-cut pixels.
    const a = anchorFor(baseTarget);
    const pivotX = bb.x + bb.width * a.x;
    const pivotY = bb.y + bb.height * a.y;
    const pad = 2;
    const left = Math.max(0, ob.x - pad);
    const top = Math.max(0, ob.y - pad);
    const width = Math.min(extracted.raster.width - left, ob.width + pad * 2);
    const height = Math.min(extracted.raster.height - top, ob.height + pad * 2);
    const outWidth = Math.max(1, Math.round(width * factor));
    const outHeight = Math.max(1, Math.round(height * factor));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    let crop = await readRaster(await toSharp(extracted.raster).extract({ left, top, width, height }).png().toBuffer());
    if (target.stroke) {
      const ss = supersampleFactor(crop.width, crop.height);
      const stroked = setStroke(await supersample(crop, ss), strokeFor(target) / factor, target.strokeColor, ss);
      if (stroked) {
        crop = stroked.raster;
        emit({ type: 'log', message: `${target.target}/${name}: outline ${(stroked.before * factor).toFixed(1)} -> ${strokeFor(target)} px` });
      }
    }
    await toSharp(crop).resize(outWidth, outHeight, { kernel: 'lanczos3', fit: 'fill' }).png().toFile(output);
    const originX = left - extracted.margin;
    const originY = top - extracted.margin;
    const anchor = { x: (pivotX - originX) / width, y: (pivotY - originY) / height };
    meta.assets[name] = {
      ...meta.assets[name]!,
      width: outWidth,
      height: outHeight,
      anchor,
      registration: { iou: Number(transform.iou.toFixed(3)), scale: Number(transform.scale.toFixed(4)), coverage: Number(extracted.coverage.toFixed(3)) },
    };
    if (transform.iou < 0.8) return `layer ${name}: weak registration (overlap ${transform.iou.toFixed(2)}); the edit may have moved or reshaped the base.`;
    return null;
  };

  /**
   * Set the outline of a source image so it is `target.stroke` atlas px wide
   * after it is resized to `outHeight`. No-op without `stroke`.
   */
  const applyStroke = async (target: Target, file: string, outHeight: number) => {
    if (!target.stroke) return;
    const raster = await readRaster(file);
    const factor = outHeight / raster.height;
    // Work supersampled and keep the big copy: `fitTo` then does the one downscale.
    const ss = supersampleFactor(raster.width, raster.height);
    const stroked = setStroke(await supersample(raster, ss), strokeFor(target) / factor, target.strokeColor, ss);
    if (!stroked) return;
    await writePng(stroked.raster, file);
    emit({ type: 'log', message: `${target.target}/${path.basename(file, '.png')}: outline ${(stroked.before * factor).toFixed(1)} -> ${strokeFor(target)} px` });
  };

  /**
   * Pad every final PNG of a target to its declared aspect ratio, anchored on
   * the kind's anchor, and move its pivot and `content` box with the art.
   * Returns how many files were padded. A seamless backdrop is not padded
   * (transparent edges would break the tiling); it is reported instead.
   */
  const enforceAspect = async (target: Target, meta: ReturnType<typeof readMeta>, outputs: string[]): Promise<number> => {
    const declared = declaredAspect(config, target);
    let padded = 0;
    for (const name of outputs) {
      const file = stagePath(config, target.target, 'final', name);
      if (!fs.existsSync(file)) continue;
      const m = await sharp(file).metadata();
      const width = m.width ?? 1;
      const height = m.height ?? 1;
      const asset = meta.assets[name]!;
      asset.content ??= { x: 0, y: 0, width, height };
      if (!declared || matchesAspect(width, height, declared.ratio)) continue;
      if (target.compose === 'backdrop' && target.seamless) {
        emit({ type: 'warn', step: 'final', target: target.target, message: `${name} is ${width}x${height}, not ${declared.label}; a seamless backdrop is not padded. Regenerate it at ${declared.label}.` });
        continue;
      }
      const pad = await padToAspect(file, declared.ratio, config.kinds[target.kind]?.anchor ?? 'bottom-center');
      if (!pad) continue;
      const anchor = asset.anchor ?? anchorFor(target);
      asset.anchor = { x: (anchor.x * width + pad.dx) / pad.width, y: (anchor.y * height + pad.dy) / pad.height };
      asset.content = { ...asset.content, x: asset.content.x + pad.dx, y: asset.content.y + pad.dy };
      asset.width = pad.width;
      asset.height = pad.height;
      padded += 1;
    }
    return padded;
  };

  /** Writes `lights` of each output that is not a split output. Returns how many lights. */
  const storeLights = async (target: Target, meta: ReturnType<typeof readMeta>, outputs: string[]): Promise<number> => {
    let count = 0;
    for (const name of outputs) {
      const asset = meta.assets[name];
      if (!asset) continue;
      const found = await ownLights(target, name);
      if (found) {
        const before = JSON.stringify(asset.lights ?? null);
        asset.lights = found;
        // New points need a new look.
        if (before !== JSON.stringify(found) && asset.lightReview) asset.lightReview = { status: 'pending' };
        count += found.length;
      } else {
        delete asset.lights;
        delete asset.lightReview;
      }
    }
    return count;
  };

  const finalize = async (names?: string[], force = false) => {
    for (const target of pick(names)) {
      if (target.compose === 'split') {
        // Deterministic and quick: always rebuilt from the base and the manifest. An output whose pixels change goes back to pending.
        const meta = readMeta(config, target);
        const before = new Map(assetNames(target).map((n) => {
          const file = stagePath(config, target.target, 'final', n);
          return [n, fs.existsSync(file) ? fs.readFileSync(file) : null] as const;
        }));
        try {
          await finalizeSplit(target, meta);
          let changed = 0;
          for (const n of assetNames(target)) {
            const file = stagePath(config, target.target, 'final', n);
            const old = before.get(n);
            if (!fs.existsSync(file) || (old && old.equals(fs.readFileSync(file)))) continue;
            changed += 1;
            meta.assets[n] = { ...meta.assets[n]!, status: 'pending', reviewedAt: undefined };
          }
          writeMeta(config, meta);
          const lit = meta.lights?.length ?? 0;
          emit({ type: 'done', step: 'final', target: target.target, message: `${assetNames(target).length} outputs on the base canvas${changed ? `, ${changed} changed` : ''}${lit ? `, ${lit} light${lit === 1 ? '' : 's'}` : ''}` });
        } catch (error) {
          emit({ type: 'error', step: 'final', target: target.target, message: error instanceof Error ? error.message : String(error) });
        }
        continue;
      }
      const metaBefore = readMeta(config, target);
      const outputs = assetNames(target).filter((n) => !metaBefore.assets[n]?.missing);
      const inputs = outputs.map((n) => stagePath(config, target.target, 'cut', n));
      const finals = outputs.map((n) => stagePath(config, target.target, 'final', n));
      if (finals.every((f) => fs.existsSync(f)) && !force) {
        // Finals exist: only bring them to the declared aspect ratio.
        const declared = declaredAspect(config, target);
        const padded = await enforceAspect(target, metaBefore, outputs);
        const lit = await storeLights(target, metaBefore, outputs);
        writeMeta(config, metaBefore);
        const lights = lit ? `${lit} light${lit === 1 ? '' : 's'}` : '';
        if (padded > 0) emit({ type: 'done', step: 'final', target: target.target, message: `padded ${padded} to ${declared?.label}${lights ? `, ${lights}` : ''}` });
        else emit({ type: 'skip', step: 'final', target: target.target, message: `final/ complete${lights ? `; ${lights}` : ''}` });
        continue;
      }
      if (outputs.length === 0 || !inputs.every((f) => fs.existsSync(f))) {
        emit({ type: 'skip', step: 'final', target: target.target, message: 'cut/ incomplete' });
        continue;
      }
      emit({ type: 'start', step: 'final', target: target.target });
      try {
        const meta = readMeta(config, target);
        meta.warnings = meta.warnings.filter((w) => !w.startsWith('layer '));
        // New finals: the old content boxes no longer apply.
        for (const n of outputs) delete meta.assets[n]!.content;
        const anchor = anchorFor(target);
        fs.mkdirSync(path.dirname(finals[0]!), { recursive: true });
        const px = pxFor(target);
        if (target.compose === 'layer') {
          for (let i = 0; i < outputs.length; i += 1) {
            const warning = await finalizeLayer(target, outputs[i]!, inputs[i]!, finals[i]!, meta);
            if (warning) {
              meta.warnings.push(warning);
              emit({ type: 'warn', step: 'final', target: target.target, message: warning });
            }
          }
        } else if (target.compose === 'backdrop') {
          const size = await fitTo(inputs[0]!, finals[0]!, px);
          meta.assets[outputs[0]!] = { ...meta.assets[outputs[0]!]!, ...size, anchor };
        } else {
          const tmpDir = path.join(targetDir(config, target.target), '.tmp');
          fs.mkdirSync(tmpDir, { recursive: true });
          const aligned = outputs.map((n) => path.join(tmpDir, `${n}.png`));
          if (target.compose === 'strip') {
            await trimAndAlign(inputs, aligned, config.kinds[target.kind]?.anchor ?? 'bottom-center', 2);
          } else {
            for (let i = 0; i < inputs.length; i += 1) {
              await trimAndAlign([inputs[i]!], [aligned[i]!], config.kinds[target.kind]?.anchor ?? 'bottom-center', 2);
            }
          }
          if (target.compose === 'parts' && target.proportions && target.uniformFrom) {
            // One factor for every part: the named part reaches its proportion,
            // the rest keep the relative size the model drew. Strokes stay even.
            const base = px.height ?? config.atlas.unit * scaleFor(target);
            const anchorIndex = outputs.indexOf(target.uniformFrom);
            const anchorMeta = anchorIndex >= 0 ? await sharp(aligned[anchorIndex]!).metadata() : null;
            const fraction = target.proportions[target.uniformFrom] ?? 1;
            const factor = anchorMeta?.height ? (base * fraction) / anchorMeta.height : 1;
            if (!anchorMeta) meta.warnings.push(`uniformFrom part "${target.uniformFrom}" not found; parts left unscaled.`);
            for (let i = 0; i < outputs.length; i += 1) {
              const m = await sharp(aligned[i]!).metadata();
              const own = outputs[i] !== target.uniformFrom ? target.proportions[outputs[i]!] : undefined;
              const height = own !== undefined ? Math.max(1, Math.round(base * own)) : Math.max(1, Math.round((m.height ?? 1) * factor));
              await applyStroke(target, aligned[i]!, height);
              const size = await fitTo(aligned[i]!, finals[i]!, { height });
              meta.assets[outputs[i]!] = { ...meta.assets[outputs[i]!]!, ...size, anchor };
            }
          } else if (target.compose === 'parts' && target.proportions) {
            // Fixed proportions: each part is a set fraction of the kind height,
            // so every skin of a rig has identical part sizes.
            const base = px.height ?? config.atlas.unit * scaleFor(target);
            for (let i = 0; i < outputs.length; i += 1) {
              const fraction = target.proportions[outputs[i]!];
              if (fraction === undefined) {
                meta.warnings.push(`No proportion for part "${outputs[i]}"; scaled by the tallest part instead.`);
              }
              const m = await sharp(aligned[i]!).metadata();
              const height = fraction !== undefined ? Math.max(1, Math.round(base * fraction)) : Math.max(1, m.height ?? 1);
              await applyStroke(target, aligned[i]!, height);
              const size = await fitTo(aligned[i]!, finals[i]!, { height });
              meta.assets[outputs[i]!] = { ...meta.assets[outputs[i]!]!, ...size, anchor };
            }
          } else if (target.compose === 'parts') {
            // Parts of one character scale together: the tallest part gets the
            // kind height and every other part keeps its relative size.
            let tallest = 1;
            for (const file of aligned) {
              const m = await sharp(file).metadata();
              tallest = Math.max(tallest, m.height ?? 1);
            }
            const factor = (px.height ?? tallest) / tallest;
            for (let i = 0; i < outputs.length; i += 1) {
              const m = await sharp(aligned[i]!).metadata();
              const height = Math.max(1, Math.round((m.height ?? 1) * factor));
              await applyStroke(target, aligned[i]!, height);
              const size = await fitTo(aligned[i]!, finals[i]!, { height });
              meta.assets[outputs[i]!] = { ...meta.assets[outputs[i]!]!, ...size, anchor };
            }
          } else {
            for (let i = 0; i < outputs.length; i += 1) {
              if (target.stroke) {
                const m = await sharp(aligned[i]!).metadata();
                const h = m.height ?? 1;
                const outHeight = px.height ?? Math.round(h * (px.width ?? 1) / (m.width ?? 1));
                await applyStroke(target, aligned[i]!, outHeight);
              }
              const size = await fitTo(aligned[i]!, finals[i]!, px);
              meta.assets[outputs[i]!] = { ...meta.assets[outputs[i]!]!, ...size, anchor };
            }
          }
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        if (target.tint) {
          for (let i = 0; i < outputs.length; i += 1) {
            if (!fs.existsSync(finals[i]!)) continue;
            await neutralize(finals[i]!);
            meta.assets[outputs[i]!] = { ...meta.assets[outputs[i]!]!, tint: target.tint };
          }
        }
        const padded = await enforceAspect(target, meta, outputs);
        await storeLights(target, meta, outputs);
        writeMeta(config, meta);
        const declared = declaredAspect(config, target);
        const summary = target.compose === 'layer' ? `${outputs.length} layer${outputs.length === 1 ? '' : 's'} at base scale` : `${outputs.length} at ${px.height ? `${px.height}px tall` : `${px.width}px wide`}`;
        emit({ type: 'done', step: 'final', target: target.target, message: padded > 0 ? `${summary}, ${padded} padded to ${declared?.label}` : summary });
      } catch (error) {
        emit({ type: 'error', step: 'final', target: target.target, message: error instanceof Error ? error.message : String(error) });
      }
    }
  };

  // ---- sheet -----------------------------------------------------------------------

  const sheet = async (names?: string[]) => {
    const written: string[] = [];
    for (const target of pick(names)) {
      const outputs = assetNames(target);
      const stage = outputs.every((n) => fs.existsSync(stagePath(config, target.target, 'final', n))) ? 'final' : 'cut';
      const files = outputs.map((n) => stagePath(config, target.target, stage, n)).filter((f) => fs.existsSync(f));
      if (files.length === 0) {
        emit({ type: 'skip', step: 'sheet', target: target.target, message: 'nothing cut yet' });
        continue;
      }
      const entries: SheetEntry[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const m = await sharp(files[i]!).metadata();
        entries.push({ name: outputs[i]!, file: files[i]!, width: m.width ?? 0, height: m.height ?? 0 });
      }
      const dir = targetDir(config, target.target);
      await contactSheet(entries, path.join(dir, 'sheet.png'), config.styleGuide.canvas.backgroundColor);
      framePlayer(entries, path.join(dir, 'sheet.html'), config.styleGuide.canvas.backgroundColor);
      written.push(path.join(dir, 'sheet.html'));
      emit({ type: 'done', step: 'sheet', target: target.target, message: `sheet.html (${stage})` });
    }
    return written;
  };

  // ---- pack ------------------------------------------------------------------------

  const pack = async (groups?: string[], allowPending = false, allowPendingPlans = false) => {
    const grouped = new Map<string, Target[]>();
    for (const target of manifest) {
      const group = groupOf(target);
      if (groups && groups.length > 0 && !groups.includes(group)) continue;
      grouped.set(group, [...(grouped.get(group) ?? []), target]);
    }
    const results: { group: string; png: string; frames: number; skipped: string[] }[] = [];
    for (const [group, targets] of grouped) {
      emit({ type: 'start', step: 'pack', target: group });
      const inputs: PackInput[] = [];
      const skipped: string[] = [];
      for (const target of targets) {
        const meta = readMeta(config, target);
        // A split's part plan is reviewed as a whole: rejected never packs, pending packs only with --allow-pending.
        // An auto plan nobody has looked at never ships, not even in a preview pack, unless asked for.
        const unseenAuto = target.compose === 'split' && target.plan?.source === 'auto' && meta.plan?.status !== 'approved' && !allowPendingPlans;
        if (target.compose === 'split' && (unseenAuto || meta.plan?.status === 'rejected' || (!allowPending && meta.plan?.status !== 'approved'))) {
          skipped.push(`${target.target} (plan ${meta.plan?.status ?? 'pending'})`);
          continue;
        }
        for (const name of assetNames(target)) {
          const file = stagePath(config, target.target, 'final', name);
          const asset = meta.assets[name]!;
          const frameName = target.compose === 'single' || target.compose === 'backdrop' ? target.target : `${target.target}/${name}`;
          if (!fs.existsSync(file)) {
            skipped.push(`${frameName} (no final)`);
            continue;
          }
          if (asset.status !== 'approved' && !allowPending) {
            skipped.push(`${frameName} (${asset.status})`);
            continue;
          }
          const m = await sharp(file).metadata();
          const declared = declaredAspect(config, target);
          if (declared && !matchesAspect(m.width ?? 0, m.height ?? 0, declared.ratio)) {
            emit({ type: 'warn', step: 'pack', target: group, message: `${frameName} is ${m.width}x${m.height}, not ${declared.label}; run \`ukiyo final ${target.target}\`` });
          }
          const content = asset.content && asset.content.x + asset.content.width <= (m.width ?? 0) && asset.content.y + asset.content.height <= (m.height ?? 0) ? asset.content : undefined;
          const lights = frameLights(target, name, meta);
          inputs.push({ name: frameName, file, width: m.width ?? 0, height: m.height ?? 0, anchor: asset.anchor ?? anchorFor(target), tint: asset.tint, content, part: asset.part, ...(lights?.length ? { lights } : {}) });
        }
      }
      if (inputs.length === 0) {
        emit({ type: 'skip', step: 'pack', target: group, message: `nothing approved${skipped.length ? `; skipped ${skipped.length}` : ''}` });
        continue;
      }
      try {
        if (config.atlas.format === 'folder') {
          const dir = path.join(config.atlasDir, group);
          fs.mkdirSync(dir, { recursive: true });
          for (const input of inputs) {
            const out = path.join(dir, `${input.name.replace('/', '__')}.png`);
            fs.copyFileSync(input.file, out);
          }
          results.push({ group, png: dir, frames: inputs.length, skipped });
          emit({ type: 'done', step: 'pack', target: group, message: `${inputs.length} files in ${path.relative(config.root, dir)}${skipped.length ? `; skipped ${skipped.length}` : ''}` });
        } else {
          const result = await packAtlas(group, inputs, config.atlasDir, { padding: config.atlas.padding, maxSize: config.atlas.maxSize, scale: config.atlas.groupScale[group] ?? config.atlas.scale, quantize: config.atlas.quantize, quality: config.atlas.quality, pot: config.atlas.pot });
          results.push({ group, png: result.png, frames: result.frames.length, skipped: [...skipped, ...result.skipped.map((s) => `${s} (overflow)`)] });
          emit({ type: 'done', step: 'pack', target: group, message: `${result.frames.length} frames, ${result.width}x${result.height}${skipped.length ? `; skipped ${skipped.length}` : ''}` });
        }
        for (const s of skipped) emit({ type: 'warn', step: 'pack', target: group, message: `skipped ${s}` });
      } catch (error) {
        emit({ type: 'error', step: 'pack', target: group, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  };

  // ---- status / redo ---------------------------------------------------------------

  const status = (): TargetStatus[] => {
    const packed = packedFrameNames(config.atlasDir);
    return manifest.map((target) => {
      // Single/backdrop frames are named by target only.
      const names = new Set(packed);
      if (target.compose === 'single' || target.compose === 'backdrop') {
        if (packed.has(target.target)) names.add(`${target.target}/${target.target}`);
      }
      return targetStatus(config, target, names);
    });
  };

  const redo = (name: string, asset?: string) => {
    const target = byName.get(name);
    if (!target) throw new Error(`Unknown target "${name}"`);
    const removed = removeOutputs(config, target, asset);
    emit({ type: 'done', step: 'redo', target: name, message: removed.length ? `removed ${removed.length} path${removed.length === 1 ? '' : 's'}` : 'nothing to remove' });
  };

  const all = async (names?: string[]) => {
    await gen(names);
    await cut(names);
    await finalize(names);
    await sheet(names);
    const pending = status().filter((s) => s.review.pending > 0 || s.review.rejected > 0);
    if (pending.length > 0) {
      emit({ type: 'log', message: `Review gate: ${pending.length} target${pending.length === 1 ? '' : 's'} with pending or rejected assets. Run \`ukiyo review\`.` });
      return;
    }
    await pack();
  };

  return { provider, references, plan, gen, importFile, animate, edit, cut, finalize, sheet, pack, status, redo, all, pick };
}

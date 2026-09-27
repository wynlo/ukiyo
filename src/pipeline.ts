import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { ResolvedConfig } from './config.js';
import { assetNames, type Manifest, type Target } from './manifest.js';
import { rawPath, readMeta, removeOutputs, stagePath, targetDir, targetStatus, writeMeta, type TargetStatus } from './meta.js';
import { coerceCount, detectComponents } from './ops/autocrop.js';
import { cutout } from './ops/cutout.js';
import { alphaBounds, anchorFraction, fitTo, trimAndAlign } from './ops/crop.js';
import { extractLayer, register, tintRaster } from './ops/register.js';
import { neutralize } from './ops/tint.js';
import { setStroke, supersample, supersampleFactor } from './ops/stroke.js';
import { packAtlas, packedFrameNames, type PackInput } from './ops/pack.js';
import { colorDistance, estimateBackground, parseHex, readRaster, toSharp, writePng } from './ops/raster.js';
import { contactSheet, framePlayer, type SheetEntry } from './ops/sheet.js';
import { composeEditPrompt, composeLayerPrompt, composePrompt, defaultSize, framePoseInstruction } from './prompt/compose.js';
import { createProvider, RateLimitError, type ImageProvider } from './providers/index.js';

export type StepName = 'gen' | 'animate' | 'edit' | 'cut' | 'final' | 'sheet' | 'pack' | 'redo' | 'import';

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createPipeline(config: ResolvedConfig, manifest: Manifest, emit: Emit, providerOverride?: ImageProvider) {
  const provider = providerOverride ?? createProvider(config);
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

  /** The style reference: an explicit `ref.png` in the first target, else its raw. */
  const styleRef = (current: Target): string | undefined => {
    const first = manifest[0];
    if (!first || first.target === current.target) return undefined;
    const raw = rawPath(config, first.target);
    return fs.existsSync(raw) ? raw : undefined;
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
        const ref = await layerRef(target, layer.base ?? target.base);
        const prompt = composeLayerPrompt(config, target, layer);
        const result = await withRetry('gen', target.target, () => provider.edit(prompt, ref, { size: defaultSize(target), log: (line) => emit({ type: 'log', message: line }) }));
        if (!result.file) throw new Error('provider returned no file');
        await copyIn(result.file, out);
        const m = readMeta(config, target);
        m.assets[layer.id] = { name: layer.id, status: 'pending' };
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

  // ---- gen -------------------------------------------------------------------------

  const gen = async (names?: string[], force = false) => {
    const targets = pick(names);
    for (let i = 0; i < targets.length; i += 1) {
      const target = targets[i]!;
      if (target.compose === 'layer') {
        await genLayers(target, force);
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
        const result = await withRetry('gen', target.target, () =>
          referenceFile
            ? provider.edit(prompt, referenceFile, { size: defaultSize(target), log })
            : provider.generate(prompt, { ref: styleRef(target), size: defaultSize(target), log }),
        );
        if (!result.file) throw new Error('provider returned no file');
        await copyIn(result.file, raw);
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
    if (target.compose === 'layer') {
      if (!asset || !assetNames(target).includes(asset)) throw new Error(`Layer target "${name}" needs --asset <${assetNames(target).join('|')}>`);
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
          const prompt = composeEditPrompt(config, meta.prompt ?? composePrompt(config, target), instruction, target.background);
          const result = await withRetry('animate', target.target, () => provider.edit(prompt, base, { size: '1024x1024', log: (line) => emit({ type: 'log', message: line }) }));
          if (!result.file) throw new Error('provider returned no file');
          await copyIn(result.file, out);
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
    const prompt = composeEditPrompt(config, meta.prompt ?? composePrompt(config, target), instruction, target.background);
    const result = await withRetry('edit', target.target, () => provider.edit(prompt, source, { size: '1024x1024', log: (line) => emit({ type: 'log', message: line }) }));
    if (!result.file) throw new Error('provider returned no file');
    const out = path.join(targetDir(config, target.target), 'frames', `${asset}.png`);
    await copyIn(result.file, out);
    meta.assets[asset] = { name: asset, status: 'pending' };
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

  const finalize = async (names?: string[], force = false) => {
    for (const target of pick(names)) {
      const metaBefore = readMeta(config, target);
      const outputs = assetNames(target).filter((n) => !metaBefore.assets[n]?.missing);
      const inputs = outputs.map((n) => stagePath(config, target.target, 'cut', n));
      const finals = outputs.map((n) => stagePath(config, target.target, 'final', n));
      if (finals.every((f) => fs.existsSync(f)) && !force) {
        emit({ type: 'skip', step: 'final', target: target.target, message: 'final/ complete' });
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
        writeMeta(config, meta);
        const summary = target.compose === 'layer' ? `${outputs.length} layer${outputs.length === 1 ? '' : 's'} at base scale` : `${outputs.length} at ${px.height ? `${px.height}px tall` : `${px.width}px wide`}`;
        emit({ type: 'done', step: 'final', target: target.target, message: summary });
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

  const pack = async (groups?: string[], allowPending = false) => {
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
          inputs.push({ name: frameName, file, width: m.width ?? 0, height: m.height ?? 0, anchor: asset.anchor ?? anchorFor(target), tint: asset.tint });
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

  return { provider, gen, importFile, animate, edit, cut, finalize, sheet, pack, status, redo, all, pick };
}

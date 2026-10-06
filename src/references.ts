import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import type { ResolvedConfig } from './config.js';
import { assetNames, type Manifest, type ReferenceEntry, type Target } from './manifest.js';
import { readMeta, rawPath, refPath, stagePath, type AssetMeta, type Box, type ReferenceRecord, type ReferenceRole, type ReferenceSource, type ReviewStatus } from './meta.js';
import { declaredAspect } from './ops/aspect.js';
import { templatesFor } from './prompt/compose.js';

/**
 * Reference images for a generation call. Every call can attach images that
 * the model uses for style, proportions and framing. The list is built from,
 * in this order of precedence:
 *
 * 1. the input image of an edit (the image being changed), always first;
 * 2. `references.anchors` in `ukiyo.json`;
 * 3. `--ref` on the command line;
 * 4. `references` on the target in the manifest;
 * 5. the first target's `ref.png` or `raw.png` (`references.firstTarget`);
 * 6. automatic picks from finished assets of the same project.
 *
 * The result is deterministic: the same project state gives the same list.
 */

/** The effective `references` config. Without a `references` section ukiyo sends only the first target, as before. */
export type ReferenceSettings = {
  anchors: ReferenceEntry[];
  firstTarget: boolean;
  auto: { max: number; match: ('kind' | 'group' | 'tag')[]; perTarget: number };
  includePending: boolean;
  max: number;
  maxImages: number;
  framing: boolean;
};

export function referenceSettings(config: ResolvedConfig): ReferenceSettings {
  const own = config.references;
  if (!own) {
    return { anchors: [], firstTarget: true, auto: { max: 0, match: ['kind'], perTarget: 1 }, includePending: false, max: 4, maxImages: 5, framing: true };
  }
  return { ...own, auto: { ...own.auto } };
}

/** Per-request overrides from the command line. */
export type ReferenceRequest = {
  /** `--ref`: added to the list. */
  add?: string[];
  /** `--refs-only`: the whole list. Anchors, manifest references and automatic picks are skipped. */
  only?: string[];
  /** `--no-refs`: no reference images. The input image of an edit is still sent. */
  none?: boolean;
  /** `--max-refs`: the most reference images, not counting the input image. */
  max?: number;
  /** `--pending-refs`: automatic picks may use assets that are not approved yet. */
  pending?: boolean;
};

/** The image being edited. It is image 1 and is not a reference. */
export type ReferenceInput = { file: string; id?: string };

export type ResolvedReference = ReferenceRecord & {
  /** Absolute path of the source file. */
  file: string;
  /** Text for the prompt: size and framing of an asset reference. */
  framing?: string;
};

export type ReferencePlan = {
  input?: ResolvedReference;
  refs: ResolvedReference[];
  /** Candidates that were not used, and why. */
  dropped: { ref: string; reason: string }[];
};

const unitText = (units: number) => `${units} unit${units === 1 ? '' : 's'}`;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

function entryOf(entry: ReferenceEntry): { ref: string; role?: ReferenceRole } {
  return typeof entry === 'string' ? { ref: entry } : entry;
}

export function fileHash(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

type Candidate = { id?: string; file: string; source: ReferenceSource; role?: ReferenceRole; status?: ReviewStatus; owner?: Target; asset?: string; meta?: AssetMeta };

export function createReferenceResolver(config: ResolvedConfig, manifest: Manifest) {
  const byName = new Map(manifest.map((t) => [t.target, t]));
  const settings = referenceSettings(config);
  const groupOf = (target: Target): string => ((target as unknown as Record<string, unknown>)[config.atlas.groupBy] as string | undefined) ?? 'atlas';
  const metaCache = new Map<string, ReturnType<typeof readMeta>>();
  const metaOf = (target: Target) => {
    let meta = metaCache.get(target.target);
    if (!meta) {
      meta = readMeta(config, target);
      metaCache.set(target.target, meta);
    }
    return meta;
  };
  const unitsOf = (target: Target): number | undefined => {
    const kind = config.kinds[target.kind];
    return target.compose === 'backdrop' ? (target.width ?? kind?.width) : (target.height ?? kind?.height);
  };

  /** The file of an asset reference: its final PNG, else its cut PNG. */
  const assetFile = (owner: Target, asset: string): string | null => {
    for (const stage of ['final', 'cut'] as const) {
      const file = stagePath(config, owner.target, stage, asset);
      if (fs.existsSync(file)) return file;
    }
    return null;
  };

  /** Turn one `target/asset` id or path into a candidate, or a reason it cannot be used. */
  const parse = (ref: string, source: ReferenceSource, role?: ReferenceRole): Candidate | string => {
    if (ID_PATTERN.test(ref) && byName.has(ref.split('/')[0]!)) {
      const [name, asset] = ref.split('/') as [string, string];
      const owner = byName.get(name)!;
      if (!assetNames(owner).includes(asset)) return `"${name}" has no asset "${asset}"`;
      const meta = metaOf(owner).assets[asset];
      if (meta?.status === 'rejected') return 'rejected';
      if (meta?.missing) return 'missing from its sheet';
      const file = assetFile(owner, asset);
      if (!file) return 'not cut yet';
      return { id: ref, file, source, role, status: meta?.status, owner, asset, meta };
    }
    const file = path.resolve(config.root, ref);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return `file not found (${path.relative(config.root, file)})`;
    if (!/\.(png|jpe?g|webp)$/i.test(file)) return 'not a PNG, JPEG or WebP file';
    return { file, source, role };
  };

  /** The first target's `ref.png`, else its `raw.png`. The behaviour before project references existed. */
  const firstTarget = (current: Target): Candidate | string | null => {
    const first = manifest[0];
    if (!first || first.target === current.target) return null;
    const own = refPath(config, first.target);
    const file = fs.existsSync(own) ? own : rawPath(config, first.target);
    if (!fs.existsSync(file)) return null;
    const statuses = Object.values(metaOf(first).assets).map((a) => a.status);
    if (fs.existsSync(own) === false && statuses.includes('rejected')) return `${first.target} has rejected assets`;
    return { file, source: 'first-target', role: 'style', owner: first };
  };

  /** Finished assets of the project that suit `current`, best first. */
  const autoPicks = (current: Target, pending: boolean): Candidate[] => {
    const tags = new Set(current.tags ?? []);
    const aspect = declaredAspect(config, current)?.label;
    const rows: { c: Candidate; key: [number, number, number, number, string, string] }[] = [];
    for (const owner of manifest) {
      if (owner.target === current.target) continue;
      // Overlays and split pieces are fragments of another asset, not whole art.
      if (owner.compose === 'layer' || owner.compose === 'split') continue;
      const sameKind = owner.kind === current.kind;
      const sameGroup = groupOf(owner) === groupOf(current);
      const sharedTag = (owner.tags ?? []).some((tag) => tags.has(tag));
      const matches = settings.auto.match.some((m) => (m === 'kind' ? sameKind : m === 'group' ? sameGroup : sharedTag));
      if (!matches) continue;
      const meta = metaOf(owner);
      for (const asset of assetNames(owner)) {
        const a = meta.assets[asset];
        if (!a || a.missing || a.status === 'rejected') continue;
        if (a.status !== 'approved' && !(pending && a.status === 'pending')) continue;
        const file = stagePath(config, owner.target, 'final', asset);
        if (!fs.existsSync(file)) continue;
        const when = (a.status === 'approved' ? a.reviewedAt : undefined) ?? meta.generatedAt ?? '';
        const id = `${owner.target}/${asset}`;
        rows.push({
          c: { id, file, source: 'auto', status: a.status, owner, asset, meta: a },
          key: [sameKind ? 1 : 0, sameGroup ? 1 : 0, sharedTag ? 1 : 0, (declaredAspect(config, owner)?.label ?? '') === (aspect ?? '') && aspect ? 1 : 0, when, id],
        });
      }
    }
    rows.sort((x, y) => {
      for (let i = 0; i < 4; i += 1) if (x.key[i] !== y.key[i]) return (y.key[i] as number) - (x.key[i] as number);
      if (x.key[4] !== y.key[4]) return x.key[4] < y.key[4] ? 1 : -1;
      return x.key[5] < y.key[5] ? -1 : 1;
    });
    const perOwner = new Map<string, number>();
    const out: Candidate[] = [];
    for (const row of rows) {
      if (out.length >= settings.auto.max) break;
      const used = perOwner.get(row.c.owner!.target) ?? 0;
      if (used >= settings.auto.perTarget) continue;
      perOwner.set(row.c.owner!.target, used + 1);
      out.push(row.c);
    }
    return out;
  };

  /** Size and framing of an asset reference, for the prompt. */
  const framingOf = (c: Candidate): string | undefined => {
    if (!c.owner || !c.meta?.width || !c.meta.height) return undefined;
    const parts: string[] = [];
    const aspect = declaredAspect(config, c.owner)?.label;
    parts.push(`${aspect ? `a ${aspect} frame` : 'its frame'} (${c.meta.width}x${c.meta.height} px)`);
    const box = c.meta.content;
    if (box) {
      const w = Math.round((box.width / c.meta.width) * 100);
      const h = Math.round((box.height / c.meta.height) * 100);
      parts.push(`the art fills ${w}% of the width and ${h}% of the height`);
    }
    const anchor = config.kinds[c.owner.kind]?.anchor;
    if (anchor) parts.push(`anchored ${anchor.replace('-', ' ')}`);
    const units = unitsOf(c.owner);
    if (units) parts.push(`${unitText(units)} ${c.owner.compose === 'backdrop' ? 'wide' : 'tall'} in the game`);
    return parts.join(', ');
  };

  const roleOf = (c: Candidate, current: Target): ReferenceRole => {
    if (c.role) return c.role;
    if (!c.owner || c.source === 'first-target') return 'style';
    if (c.owner.kind === current.kind) return 'proportions';
    if (groupOf(c.owner) === groupOf(current) || (c.owner.tags ?? []).some((t) => (current.tags ?? []).includes(t))) return 'family';
    return 'style';
  };

  const record = (c: Candidate, current: Target, n: number, role?: ReferenceRole): ResolvedReference => ({
    n,
    id: c.id,
    path: path.relative(config.root, c.file),
    file: c.file,
    role: role ?? roleOf(c, current),
    source: c.source,
    status: c.status,
    sha256: fileHash(c.file),
    framing: settings.framing ? framingOf(c) : undefined,
  });

  /**
   * The reference list for one generation call of `current`.
   * `editing` is set for `ukiyo edit` and `ukiyo animate`: they may use other
   * assets of the same target (never the asset itself, which is the input).
   */
  const resolve = (current: Target, options: { request?: ReferenceRequest; input?: ReferenceInput; editing?: string; exclude?: string[] } = {}): ReferencePlan => {
    const request = options.request ?? {};
    const mode = current.referencesMode ?? 'add';
    const dropped: ReferencePlan['dropped'] = [];
    const queue: (Candidate | { error: string; ref: string })[] = [];
    const push = (ref: string, source: ReferenceSource, role?: ReferenceRole) => {
      const c = parse(ref, source, role);
      queue.push(typeof c === 'string' ? { error: c, ref } : c);
    };
    if (request.only) {
      for (const ref of request.only) push(ref, 'request');
    } else if (!request.none) {
      if (mode === 'add') for (const e of settings.anchors.map(entryOf)) push(e.ref, 'anchor', e.role);
      for (const ref of request.add ?? []) push(ref, 'request');
      if (mode !== 'none') for (const e of (current.references ?? []).map(entryOf)) push(e.ref, 'explicit', e.role);
      if (mode === 'add' && settings.firstTarget) {
        const first = firstTarget(current);
        if (typeof first === 'string') dropped.push({ ref: manifest[0]!.target, reason: first });
        else if (first) queue.push(first);
      }
      if (mode === 'add' && settings.auto.max > 0) queue.push(...autoPicks(current, request.pending ?? settings.includePending));
    }

    const input = options.input
      ? ({ n: 1, id: options.input.id, path: path.relative(config.root, options.input.file), file: options.input.file, role: 'input', source: 'edit', sha256: fs.existsSync(options.input.file) ? fileHash(options.input.file) : '' } satisfies ResolvedReference)
      : undefined;
    const cap = Math.max(0, Math.min(request.max ?? current.maxReferences ?? settings.max, settings.maxImages - (input ? 1 : 0)));
    // The same picture under two names (a copied anchor) is sent once.
    const seen = new Set<string>(input ? [path.resolve(input.file), input.sha256] : []);
    const refs: ResolvedReference[] = [];
    for (const c of queue) {
      if ('error' in c) {
        dropped.push({ ref: c.ref, reason: c.error });
        continue;
      }
      const label = c.id ?? path.relative(config.root, c.file);
      if (c.owner?.target === current.target && c.source !== 'first-target' && (!options.editing || c.asset === options.editing)) {
        dropped.push({ ref: label, reason: options.editing ? 'the asset being edited' : 'an old version of this target' });
        continue;
      }
      if (c.id && options.exclude?.includes(c.id)) {
        dropped.push({ ref: label, reason: 'the input image of this edit' });
        continue;
      }
      const hash = fileHash(c.file);
      if (seen.has(path.resolve(c.file)) || seen.has(hash)) {
        dropped.push({ ref: label, reason: 'same image as an earlier reference' });
        continue;
      }
      if (refs.length >= cap) {
        dropped.push({ ref: label, reason: `over the limit of ${cap}` });
        continue;
      }
      seen.add(path.resolve(c.file));
      seen.add(hash);
      refs.push(record(c, current, refs.length + (input ? 2 : 1)));
    }
    return { input, refs, dropped };
  };

  /** Size and framing of the target being generated, for the prompt. */
  const ownFraming = (current: Target): string | undefined => {
    if (!settings.framing) return undefined;
    const aspect = declaredAspect(config, current)?.label;
    const units = unitsOf(current);
    const parts = [aspect ? `each asset goes in a ${aspect} frame` : '', units ? `${unitText(units)} ${current.compose === 'backdrop' ? 'wide' : 'tall'} in the game` : ''].filter(Boolean);
    return parts.length ? parts.join(', ') : undefined;
  };

  /** The REFERENCE IMAGES block appended to the prompt. Empty when there are no references. */
  const promptBlock = (current: Target, plan: ReferencePlan): string => {
    if (plan.refs.length === 0) return '';
    return templatesFor(config).render('references', {
      input: Boolean(plan.input),
      // Only asset references carry a size to compare with.
      own: plan.refs.some((r) => r.framing) ? ownFraming(current) : undefined,
      refs: plan.refs.map((r) => ({
        n: r.n,
        name: r.id ?? r.path,
        style: r.role === 'style',
        proportions: r.role === 'proportions',
        family: r.role === 'family',
        framing: r.framing,
      })),
    });
  };

  /**
   * Copies of the reference files for the provider. A final PNG is
   * transparent; the model gets it flattened on the target's background, at
   * its full padded size, so the frame is kept.
   */
  const providerFiles = async (plan: ReferencePlan, background: string): Promise<string[]> => {
    const dir = path.join(os.tmpdir(), 'ukiyo-refs');
    fs.mkdirSync(dir, { recursive: true });
    const out: string[] = [];
    for (const r of plan.refs) {
      if (!r.id) {
        out.push(r.file);
        continue;
      }
      const file = path.join(dir, `${r.sha256}-${background.replace('#', '')}.png`);
      if (!fs.existsSync(file)) await sharp(r.file).flatten({ background }).png().toFile(file);
      out.push(file);
    }
    return out;
  };

  return { resolve, promptBlock, providerFiles, settings };
}

export type ReferenceResolver = ReturnType<typeof createReferenceResolver>;

/** The records written to meta.json: the input image and every reference, without the local paths. */
export function referenceRecords(plan: ReferencePlan): ReferenceRecord[] {
  return [...(plan.input ? [plan.input] : []), ...plan.refs].map(({ n, id, path: p, role, source, status, sha256 }) => ({ n, id, path: p, role, source, status, sha256 }));
}

/** One line per image, for `ukiyo prompt` and the log. */
export function describePlan(plan: ReferencePlan): string[] {
  const lines = [...(plan.input ? [plan.input] : []), ...plan.refs].map(
    (r) => `${r.n}. ${r.role.padEnd(11)} ${r.id ?? r.path}${r.id ? `  (${r.path})` : ''}  [${r.source}${r.status ? `, ${r.status}` : ''}]  sha256:${r.sha256}`,
  );
  for (const d of plan.dropped) lines.push(`   not used: ${d.ref} (${d.reason})`);
  return lines;
}

export type { Box };

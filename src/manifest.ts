import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const nameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only');

const base = {
  target: nameSchema,
  /** Kind key in `ukiyo.json` `kinds`. */
  kind: z.string().min(1),
  /** Atlas group. Matches `atlas.groupBy` (default "game"). */
  game: z.string().min(1).optional(),
  /** Override the kind's height in board units. */
  height: z.number().positive().optional(),
  /** Override the kind's width in board units (backdrops). */
  width: z.number().positive().optional(),
  /** Extra prompt lines for this target only. */
  notes: z.string().optional(),
  /** Output image size hint, e.g. "1024x1024". */
  size: z.string().regex(/^\d+x\d+$/).optional(),
  /** Per-target cut-out overrides for subjects close to the background colour. */
  cutout: z
    .object({
      threshold: z.number().min(1).optional(),
      mergeGap: z.number().int().min(0).optional(),
      minArea: z.number().int().min(1).optional(),
    })
    .optional(),
  /**
   * Generate on this solid background instead of the style's, and cut by
   * chroma-keying it. For subjects that share the style background colour
   * (a white rabbit on cream).
   */
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /**
   * Runtime tint channel. The prompt asks for white and light-grey fills, and
   * `final` turns fills neutral grey while keeping the outline, so a multiply
   * tint at runtime gives clean colours. Recorded in meta and the atlas.
   */
  tint: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
  /**
   * Outline width in final atlas px. `final` redraws the dark outline on its
   * inner side so it has this width after the resize, whatever scale the
   * target was shrunk by. Use the same value on targets that are drawn next
   * to each other. Isolated dark marks (eyes) are not changed.
   */
  stroke: z.number().positive().optional(),
  /** Outline colour for `stroke`, e.g. the furniture's outline colour. Default: the target's own outline colour. */
  strokeColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  /** Kept for manifests that mark UI art front-facing; every style is front-facing now. */
  view: z.enum(['front']).optional(),
};

const assetRef = z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/, 'expected <target>/<asset>');

export const targetSchema = z.discriminatedUnion('compose', [
  z.object({
    ...base,
    compose: z.literal('sheet'),
    /** Named assets on one sheet, in reading order. 2 to 9. */
    assets: z.array(z.string().min(1)).min(1).max(9),
    /** Output asset names; defaults to slugified `assets`. */
    names: z.array(nameSchema).optional(),
    category: z.string().optional(),
    /**
     * Draw assets at their true relative sizes instead of a similar size, so
     * a style reference shows how big a character is next to furniture.
     */
    trueScale: z.boolean().optional(),
  }),
  z.object({
    ...base,
    compose: z.literal('single'),
    subject: z.string().min(1),
  }),
  z.object({
    ...base,
    compose: z.literal('strip'),
    subject: z.string().min(1),
    /** Frame names in order. First is the rest pose. */
    frames: z.array(nameSchema).min(2).max(8),
    /** Pose descriptions per frame, same order. Defaults derived from frame names. */
    poses: z.array(z.string()).optional(),
  }),
  z.object({
    ...base,
    compose: z.literal('backdrop'),
    subject: z.string().min(1),
    aspect: z.enum(['1:1', '2:1', '3:1', '16:9', '9:16']).default('3:1'),
    seamless: z.boolean().default(true),
  }),
  z.object({
    ...base,
    compose: z.literal('layer'),
    /** The cut asset every layer is drawn on (`<target>/<asset>`). */
    base: assetRef,
    /** Short description of the base, for the prompt ("a round blob critter body"). */
    subject: z.string().min(1),
    /**
     * One overlay per entry. Each is generated as an edit of the base, then
     * registered to the base silhouette and differenced against it, so only
     * the new pixels remain. The output shares the base's scale and pivot.
     */
    layers: z
      .array(
        z.object({
          id: nameSchema,
          /** What to add, e.g. "a white chef coat". */
          label: z.string().min(1),
          /** Per-layer base, e.g. the back view for a back-facing layer. */
          base: assetRef.optional(),
        }),
      )
      .min(1)
      .max(12),
    /** Colour the base is shown in to the model, so a white overlay differs from it. */
    baseTint: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#8FB3E0'),
    /** Colour distance above which a pixel inside the base counts as new. */
    diffThreshold: z.number().min(1).default(64),
    /** Draw order in the combination preview. Higher draws on top. */
    order: z.number().default(0),
  }),
  z.object({
    ...base,
    compose: z.literal('parts'),
    subject: z.string().min(1),
    /** Output names in detected reading order; defaults to slugified part labels. */
    names: z.array(nameSchema).optional(),
    /**
     * A cut asset of another target (`<target>/<asset>`) showing the assembled
     * character. The sheet is generated as an edit of it, so the parts match.
     */
    reference: z.string().regex(/^[a-z0-9-]+\/[a-z0-9-]+$/).optional(),
    /**
     * Height of each part as a fraction of the kind height, by output name.
     * Every skin then gets identical proportions, whatever the model drew.
     */
    proportions: z.record(z.string(), z.number().positive()).optional(),
    /**
     * Scale every part by ONE factor, chosen so this part reaches its
     * proportion. Keeps outline weight identical across parts; the model's
     * relative sizes are kept as drawn. A part that also has its own entry
     * in `proportions` gets that height instead; set `stroke` to keep its
     * outline even with the rest.
     */
    uniformFrom: z.string().optional(),
    rigType: z.enum(['mascot', 'humanoid', 'quadruped', 'floating', 'machine']).default('mascot'),
    parts: z
      .array(z.object({ label: z.string().min(1), required: z.boolean().default(true), pivotHint: z.string().optional() }))
      .min(2),
    animations: z.array(z.string()).default(['idle']),
  }),
]);

export const manifestSchema = z.array(targetSchema);

export type Target = z.infer<typeof targetSchema>;
export type Manifest = Target[];

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'asset';
}

/** The output asset names a target produces, in order. */
export function assetNames(target: Target): string[] {
  switch (target.compose) {
    case 'sheet':
      return target.names ?? target.assets.map(slugify);
    case 'strip':
      return target.frames;
    case 'parts':
      return target.names ?? target.parts.map((part) => slugify(part.label));
    case 'layer':
      return target.layers.map((layer) => layer.id);
    case 'single':
    case 'backdrop':
      return [target.target];
  }
}

export function loadManifest(manifestPath: string): Manifest {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid manifest ${manifestPath}:\n${parsed.error.issues.map((i) => `  [${i.path.join('.')}] ${i.message}`).join('\n')}`);
  }
  const seen = new Set<string>();
  for (const target of parsed.data) {
    if (seen.has(target.target)) {
      throw new Error(`Duplicate target "${target.target}" in manifest`);
    }
    seen.add(target.target);
  }
  for (const target of parsed.data) {
    if (target.compose !== 'layer') continue;
    for (const ref of [target.base, ...target.layers.map((l) => l.base).filter((b): b is string => Boolean(b))]) {
      const [name, asset] = ref.split('/') as [string, string];
      const owner = parsed.data.find((t) => t.target === name);
      if (!owner) throw new Error(`Layer target "${target.target}": base target "${name}" is not in the manifest`);
      if (!assetNames(owner).includes(asset)) throw new Error(`Layer target "${target.target}": "${name}" has no asset "${asset}"`);
      if (parsed.data.indexOf(owner) > parsed.data.indexOf(target)) {
        throw new Error(`Layer target "${target.target}" must come after its base target "${name}" in the manifest`);
      }
    }
  }
  return parsed.data;
}

export function exampleManifest(): Manifest {
  return [
    {
      target: 'items-1',
      kind: 'item',
      compose: 'sheet',
      game: 'main',
      category: 'Cafe ingredients',
      assets: ['tea leaf', 'coffee bean', 'milk bottle', 'matcha tin', 'espresso cup', 'green tea cup'],
    },
    {
      target: 'guest-fox',
      kind: 'visitor',
      compose: 'strip',
      game: 'main',
      subject: 'a small round fox in a knitted scarf',
      frames: ['idle', 'step-a', 'step-b', 'sit'],
    },
    {
      target: 'counter',
      kind: 'furniture',
      compose: 'single',
      game: 'main',
      subject: 'a wooden cafe counter with a small till and a cake dome',
      height: 2.5,
    },
    {
      target: 'wall',
      kind: 'backdrop',
      compose: 'backdrop',
      game: 'main',
      subject: 'warm wood-panel cafe wall with one window and a shelf line',
      aspect: '3:1',
      seamless: true,
    },
  ];
}

export function writeManifest(manifestPath: string, manifest: Manifest): void {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

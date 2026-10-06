import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { referenceEntrySchema } from './manifest.js';
import { loadStyle, type StyleGuide } from './style.js';

export const CONFIG_FILE = 'ukiyo.json';

const anchorSchema = z.enum(['top-left', 'top-center', 'center', 'bottom-center', 'bottom-left']);
export type Anchor = z.infer<typeof anchorSchema>;

const kindSchema = z.object({
  /** Target height in board units. Omit for backdrops (they use `width`). */
  height: z.number().positive().optional(),
  /** Target width in board units. Backdrops only. */
  width: z.number().positive().optional(),
  anchor: anchorSchema.default('bottom-center'),
  /**
   * Width:height ratio of every final PNG of this kind, e.g. "3:2". `final`
   * pads each asset with transparent pixels to this ratio, anchored on
   * `anchor`. Omit to leave the trimmed size as it is.
   */
  aspect: z.string().regex(/^\d+(\.\d+)?:\d+(\.\d+)?$/, 'expected "width:height", e.g. "3:2"').optional(),
});

/** `[low, high]`: a value is picked in this band per piece, from its id, so pieces never move in step. */
const bandSchema = z.tuple([z.number(), z.number()]);

/**
 * One motion of a material. `kind` is the project's own motion name
 * (`swing`, `flutter`, `flicker` …); ukiyo only copies it into the atlas, and
 * the game maps it to its own loops.
 */
const rigMotionSchema = z.object({
  kind: z.string().min(1),
  amount: bandSchema,
  periodMs: bandSchema.optional(),
  durationMs: bandSchema.optional(),
});

/** How one material of a prop moves, and where it turns. */
const rigMaterialSchema = z.object({
  /** What the model looks for, e.g. "things that hang from a hook or a cord: lanterns, bells, buckets". */
  describe: z.string().min(1),
  /** At rest, in a loop. */
  rest: rigMotionSchema.optional(),
  /** Once, when the prop is used or tapped. */
  use: rigMotionSchema.optional(),
  /** Once, when a gust reaches it. */
  gust: rigMotionSchema.optional(),
  /**
   * Where the piece turns:
   * `contact-top` / `contact-bottom` / `contact`: the top, bottom or middle of
   * where it touches the rest (a hook, the top of a trunk, a hinge);
   * `top` / `bottom` / `center`: that point of its own box (a flame's base, a hub).
   */
  pivot: z.enum(['contact-top', 'contact-bottom', 'contact', 'top', 'bottom', 'center']),
  /** What the base keeps under the piece. Default: `detach` when the piece mostly touches air, else `fill`. */
  mode: z.enum(['detach', 'cover', 'fill']).optional(),
  /** Each level of a chain (a rope under a bell) starts this many ms after its parent. Default 0. */
  lag: z.number().min(0).default(0),
  /** Only in these phases, for the game (a lamp glows at night). */
  phases: z.array(z.string()).optional(),
  /**
   * The piece gives off light (see `ops/lights.ts`). `lit`: one light per
   * region drawn lit (a window, a flame, a glowing panel). `body`: one light
   * at the bright body of the piece (a paper lantern drawn unlit by day).
   */
  emits: z.enum(['lit', 'body']).optional(),
});

/** How `ukiyo final` finds lit regions. Every value has a default (`DEFAULT_LIGHT_RULES`). */
const lightRulesSchema = z.object({
  /**
   * Assets whose `<target>/<asset>` or subject matches this (case-insensitive
   * regular expression) are light sources. One with no emitting split piece is
   * searched as a whole for `lit` regions.
   */
  match: z.string().optional(),
  lit: z
    .object({
      minValue: z.number().min(0).max(1).optional(),
      hue: z.tuple([z.number(), z.number()]).optional(),
      minSat: z.number().min(0).max(1).optional(),
      core: z.object({ maxSat: z.number().min(0).max(1), minValue: z.number().min(0).max(1) }).optional(),
    })
    .optional(),
  body: z.object({ minValue: z.number().min(0).max(1) }).optional(),
  open: z.number().int().min(0).max(4).optional(),
  minArea: z.number().int().min(1).optional(),
  minThick: z.number().int().min(1).optional(),
  minShare: z.number().min(0).max(1).optional(),
});

/** One input of the complexity score: `[low, high, weight]`. Below `low` scores 0, above `high` scores 1. */
const scoreTermSchema = z.tuple([z.number(), z.number(), z.number().min(0)]);

/**
 * Rules for multipart props (`ukiyo plan`). Every value is the project's:
 * ukiyo has no built-in materials, thresholds or weights.
 */
const rigSchema = z.object({
  materials: z.record(z.string(), rigMaterialSchema),
  /** Per kind: the complexity score from which a sprite gets a plan, and the most pieces a plan may have. */
  kinds: z.record(z.string(), z.object({ threshold: z.number().min(0).max(1), maxParts: z.number().int().min(1) })),
  /** Weights of the complexity score (see `ops/complexity.ts`). */
  score: z.object({
    /** Colour regions, a count. */
    regions: scoreTermSchema,
    /** Share of the silhouette's row and column spans that is not art: overhangs, gaps, hanging things. */
    protrusion: scoreTermSchema,
    /** Share of the art's pixels on a colour edge. */
    edges: scoreTermSchema,
    /** Separate pieces of art, a count. */
    components: scoreTermSchema,
  }),
  /** Siblings of one material react this many ms apart (a row of chimes). Default 0. */
  stagger: z.number().min(0).default(0),
  /**
   * Plan a sprite whatever its score when its name or subject matches one of
   * these (case-insensitive regular expressions): kinds of things that always
   * have a moving material, such as a lantern, a tree or a banner. The score
   * then only sets the order.
   */
  triggers: z.array(z.object({ match: z.string().min(1), material: z.string().optional() })).default([]),
  /** Never plan assets whose `<target>/<asset>` matches one of these (icons, flat ground). */
  exclude: z.array(z.string().min(1)).default([]),
  /** Only plan assets of these atlas groups. Default: every group. */
  groups: z.array(z.string()).optional(),
  /** Atlas group of the split targets `ukiyo plan` writes. Default: the base's group. */
  group: z.string().optional(),
  /** Declared aspect of the split targets `ukiyo plan` writes, e.g. "1:1". Default: the base kind's. */
  aspect: z.string().regex(/^\d+(\.\d+)?:\d+(\.\d+)?$/).optional(),
  /** `notes` of the split targets `ukiyo plan` writes: the art brief for their plate and add edits. */
  notes: z.string().optional(),
  /** Prefix of the split targets `ukiyo plan` writes: `<prefix><asset>`. Default "prop-". */
  prefix: z.string().default('prop-'),
  /** Light emitters: which assets are light sources and how lit regions are found (`ops/lights.ts`). */
  lights: lightRulesSchema.optional(),
  /**
   * The wind and light pass of `ukiyo plan` (see `effects` in meta.json).
   * `materials`: the materials the wind moves (paper, stems, canopies). A
   * sprite whose split has a piece of one of them, or whose name matches a
   * trigger of one of them, is proposed as moving in the wind.
   */
  wind: z.object({ materials: z.array(z.string()).default([]) }).optional(),
});

export type RigConfig = z.infer<typeof rigSchema>;
export type RigMaterial = z.infer<typeof rigMaterialSchema>;
export type RigMotion = z.infer<typeof rigMotionSchema>;
export type RigLightRules = z.infer<typeof lightRulesSchema>;

export const configSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    description: z.string().default(''),
  }),
  style: z
    .object({
      /** The project's style guide: YAML front matter plus a Markdown STYLE body. */
      file: z.string().default('art/style.md'),
      /** Appended as ADDITIONAL DETAILS. */
      additionalDetails: z.string().default(''),
    })
    .prefault({}),
  prompts: z
    .object({
      /** Built-in template version, a folder under ukiyo's `prompts/`. */
      version: z.string().default('v1'),
      /** Project folder with template files that override the built-in ones by name. */
      dir: z.string().optional(),
    })
    .prefault({}),
  manifest: z.string().default('art/manifest.json'),
  out: z.string().default('art/generated'),
  provider: z
    .object({
      name: z.enum(['codex', 'openai', 'manual']).default('codex'),
      concurrency: z.number().int().min(1).max(4).default(1),
      gapMs: z.number().int().min(0).default(8000),
      model: z.string().default('gpt-image-2'),
      /** Codex agent model that relays the prompt (`-m`). Omit for the CLI default. */
      agentModel: z.string().optional(),
      /** Codex reasoning effort for the wrapper agent. */
      effort: z.enum(['low', 'medium', 'high']).default('low'),
      timeoutMs: z.number().int().min(10000).default(420000),
    })
    .prefault({}),
  cutout: z
    .object({
      mode: z.enum(['flood', 'chroma', 'ink']).default('flood'),
      chroma: z.string().default('#00FF00'),
      threshold: z.number().min(1).default(102),
      feather: z.number().min(0).max(8).default(1.5),
      despill: z.boolean().default(true),
      /** Component detection. */
      detectThreshold: z.number().min(1).default(34),
      minArea: z.number().int().min(1).default(400),
      mergeGap: z.number().int().min(0).default(14),
    })
    .prefault({}),
  atlas: z
    .object({
      dir: z.string().default('public/assets/atlas'),
      groupBy: z.string().default('game'),
      /** Device pixel ratio the atlas is authored at. */
      scale: z.number().positive().default(2),
      /**
       * Per-group override of `scale`, e.g. `{ "critters": 4 }` for small
       * art that the game draws large. The atlas JSON records the group's
       * scale in `meta.scale`, and `stroke` stays the same width on screen.
       */
      groupScale: z.record(z.string(), z.number().positive()).default({}),
      /** One board unit in CSS px at scale 1. */
      unit: z.number().positive().default(64),
      format: z.enum(['phaser-hash', 'folder']).default('phaser-hash'),
      padding: z.number().int().min(0).default(2),
      maxSize: z.number().int().min(256).default(4096),
      /**
       * Palette-quantize the atlas PNG (256 colours + alpha). About a quarter
       * of the bytes, but it bands gradients and anti-aliased edges. Off by default.
       */
      quantize: z.boolean().default(false),
      /** Pack into a power-of-two sheet, so WebGL 1 can build mipmaps for it. */
      pot: z.boolean().default(false),
      quality: z.number().int().min(1).max(100).default(90),
    })
    .prefault({}),
  /**
   * Sample colours per tint channel ("fur", "fabric"). The review page uses
   * them to preview tinted assets and random layer combinations.
   */
  tints: z.record(z.string(), z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).min(1)).default({}),
  /** Multipart prop rules for `ukiyo plan`. Optional: without it `plan` does nothing. */
  rig: rigSchema.optional(),
  /**
   * Reference images sent with every generation call (see `src/references.ts`).
   * Optional. Without it, the first target's raw.png is the only reference.
   */
  references: z
    .object({
      /** Always sent: file paths relative to ukiyo.json, or `<target>/<asset>` ids. */
      anchors: z.array(referenceEntrySchema).default([]),
      /** Also send the first target's ref.png or raw.png, as ukiyo did before `references`. */
      firstTarget: z.boolean().default(false),
      /** Picks from finished assets of the project. */
      auto: z
        .object({
          /** The most automatic picks per call. 0 turns them off. */
          max: z.number().int().min(0).default(2),
          /** A candidate qualifies when it has the same `kind`, the same atlas group, or a shared tag. */
          match: z.array(z.enum(['kind', 'group', 'tag'])).min(1).default(['kind']),
          /** The most picks from one target, so the picks come from different sheets. */
          perTarget: z.number().int().min(1).default(1),
        })
        .prefault({}),
      /** Automatic picks may use pending assets. Default: approved assets only. */
      includePending: z.boolean().default(false),
      /** The most reference images per call, not counting the input image of an edit. */
      max: z.number().int().min(0).default(4),
      /** The most images per call in total, including the input image. Set it to what the provider accepts. */
      maxImages: z.number().int().min(1).default(5),
      /** Tell the model the frame, content box and game size of each asset reference. */
      framing: z.boolean().default(true),
    })
    .optional(),
  kinds: z.record(z.string(), kindSchema).default({
    backdrop: { width: 8, anchor: 'top-left' },
    furniture: { height: 2, anchor: 'bottom-center' },
    visitor: { height: 1.5, anchor: 'bottom-center' },
    item: { height: 0.75, anchor: 'center' },
    icon: { height: 0.5, anchor: 'center' },
    fx: { height: 0.75, anchor: 'center' },
  }),
});

export type UkiyoConfig = z.infer<typeof configSchema>;

export type ResolvedConfig = UkiyoConfig & {
  /** Directory that holds ukiyo.json. Every relative path resolves from here. */
  root: string;
  styleGuide: StyleGuide;
  styleFile: string;
  /** Absolute `prompts.dir`, when set. */
  promptsDir?: string;
  manifestPath: string;
  outDir: string;
  atlasDir: string;
};

export function findConfigPath(start = process.cwd()): string | null {
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

export function loadConfig(explicitPath?: string): ResolvedConfig {
  const configPath = explicitPath ? path.resolve(explicitPath) : findConfigPath();
  if (!configPath) {
    throw new Error(`No ${CONFIG_FILE} found here or above. Run \`ukiyo init\`.`);
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as unknown;
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${configPath}:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  if (raw && typeof raw === 'object' && 'style' in raw && raw.style && typeof raw.style === 'object' && 'preset' in raw.style) {
    throw new Error(`${configPath}: style.preset was removed. Put the style in a project file and set style.file (default art/style.md).`);
  }
  const config = parsed.data;
  const root = path.dirname(configPath);
  const styleFile = path.resolve(root, config.style.file);
  return {
    ...config,
    root,
    styleGuide: loadStyle(styleFile),
    styleFile,
    promptsDir: config.prompts.dir ? path.resolve(root, config.prompts.dir) : undefined,
    manifestPath: path.resolve(root, config.manifest),
    outDir: path.resolve(root, config.out),
    atlasDir: path.resolve(root, config.atlas.dir),
  };
}

export function defaultConfig(name: string): UkiyoConfig {
  return configSchema.parse({ project: { name, description: '' } });
}

export function writeConfig(dir: string, config: UkiyoConfig): string {
  const target = path.join(dir, CONFIG_FILE);
  fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
  return target;
}

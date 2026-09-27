import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
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
});

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

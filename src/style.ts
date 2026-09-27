import fs from 'node:fs';
import { parse, stringify } from 'yaml';
import { z } from 'zod';

/**
 * The project's style guide. It lives in the project (default
 * `art/style.md`), not in ukiyo: YAML front matter holds the structured
 * fields, and the Markdown body is the STYLE text written into every prompt.
 */

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected #RRGGBB');

const paletteEntrySchema = z.object({
  name: z.string().min(1),
  hex,
  usage: z.enum(['background', 'outline', 'fill', 'shade']),
});

const frontMatterSchema = z.object({
  name: z.string().min(1),
  /** One-paragraph summary. Used when the body is empty. */
  description: z.string().default(''),
  canvas: z
    .object({
      aspectRatio: z.enum(['1:1', '16:9', '9:16', '3:1', '2:1']).default('1:1'),
      backgroundColor: hex.default('#FFFFFF'),
      layout: z.enum(['sticker-sheet', 'single-object', 'parts-sheet']).default('sticker-sheet'),
    })
    .prefault({}),
  linework: z
    .object({
      /** A colour, or `none` for lineless art. */
      outlineColor: z.string().default('none'),
      outlineThickness: z.string().default(''),
      caps: z.literal('rounded').default('rounded'),
      joins: z.literal('rounded').default('rounded'),
      wobble: z.enum(['none', 'subtle', 'medium']).default('none'),
    })
    .prefault({}),
  /** Shading instruction. When unset, prompts ask for flat fills with one shade step. */
  shading: z.string().optional(),
  shapeLanguage: z.array(z.string()).default([]),
  palette: z.array(paletteEntrySchema).default([]),
  renderingRules: z.array(z.string()).default([]),
  /** Written into the NEGATIVE PROMPT. */
  bannedTraits: z.array(z.string()).default([]),
  detail: z
    .object({
      readableAtPx: z.number().int().positive().default(48),
      maxFillColorsPerAsset: z.number().int().positive().default(3),
      allowTinyDetails: z.boolean().default(false),
    })
    .prefault({}),
});

export type PaletteEntry = z.infer<typeof paletteEntrySchema>;

export type StyleGuide = z.infer<typeof frontMatterSchema> & {
  /** The Markdown body. Written into the STYLE section verbatim. */
  styleLock: string;
};

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseStyle(text: string, source = 'style file'): StyleGuide {
  const match = FRONT_MATTER.exec(text);
  if (!match) {
    throw new Error(`${source}: expected YAML front matter between --- lines at the top`);
  }
  const parsed = frontMatterSchema.safeParse(parse(match[1] ?? '') ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid ${source}:\n${parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  return { ...parsed.data, styleLock: (match[2] ?? '').trim() };
}

export function loadStyle(file: string): StyleGuide {
  if (!fs.existsSync(file)) {
    throw new Error(`Style file not found: ${file}. Run \`ukiyo init\` or set style.file in ukiyo.json.`);
  }
  return parseStyle(fs.readFileSync(file, 'utf8'), file);
}

export function renderStyle(style: StyleGuide): string {
  const { styleLock, ...front } = style;
  return `---\n${stringify(front, { lineWidth: 0 })}---\n\n${styleLock}\n`;
}

/** Written by `ukiyo init`. A neutral starting point for the project to rewrite. */
export const starterStyle: StyleGuide = {
  name: 'Starter',
  description:
    'Cute flat game sprites with a soft dark-brown outline, flat fills with one shade step, chunky rounded shapes, front-facing, readable at small sizes.',
  canvas: { aspectRatio: '1:1', backgroundColor: '#FFFFFF', layout: 'sticker-sheet' },
  linework: {
    outlineColor: '#3B2A20',
    outlineThickness: 'about 3% of object width, even weight',
    caps: 'rounded',
    joins: 'rounded',
    wobble: 'subtle',
  },
  shapeLanguage: ['chunky', 'rounded corners', 'simple silhouettes', 'front-facing', 'flat bottom edge'],
  palette: [
    { name: 'Paper', hex: '#FFFFFF', usage: 'background' },
    { name: 'Ink', hex: '#3B2A20', usage: 'outline' },
    { name: 'Warm Sand', hex: '#F2C98B', usage: 'fill' },
    { name: 'Sand Shade', hex: '#D9A868', usage: 'shade' },
    { name: 'Leaf', hex: '#8DB860', usage: 'fill' },
    { name: 'Sky', hex: '#8FBCE0', usage: 'fill' },
    { name: 'Berry', hex: '#D9605A', usage: 'fill' },
  ],
  renderingRules: [
    'flat fills with one darker shade step',
    'even outline weight on every shape',
    'no text or labels',
    'readable at small mobile sizes',
    'isolated presentation with large spacing',
  ],
  bannedTraits: ['realism', '3D render', 'gradients', 'glossy highlights', 'tiny details', 'text', 'labels', 'watermark', 'scene background'],
  detail: { readableAtPx: 48, maxFillColorsPerAsset: 3, allowTinyDetails: false },
  styleLock: `STYLE LOCK: Cute flat sprites for a small mobile game.

Describe the look of your game here. This text goes into every prompt as the STYLE section. Cover the core aesthetic, edges and outlines, colour, shading, view and proportion, detail level and composition. Keep it specific: name colours by hex and say what is not allowed.`,
};

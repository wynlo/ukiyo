import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';

/**
 * Prompt templates are static Handlebars files in `prompts/<version>/`.
 * Files that start with `_` are partials. A project can override any file by
 * putting one with the same name in its `prompts.dir`.
 */

/** `prompts/` at the package root. Same relative path from `src/` and `dist/`. */
export const BUILTIN_PROMPTS_DIR = fileURLToPath(new URL('../../prompts', import.meta.url));

export function builtinVersions(): string[] {
  return fs
    .readdirSync(BUILTIN_PROMPTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export type TemplateSet = {
  version: string;
  render(name: string, view: object): string;
  poses: Record<string, string>;
};

const cache = new Map<string, TemplateSet>();

function readDir(dir: string | undefined): Map<string, string> {
  const files = new Map<string, string>();
  if (!dir || !fs.existsSync(dir)) return files;
  for (const file of fs.readdirSync(dir)) {
    files.set(file, path.join(dir, file));
  }
  return files;
}

/** Loads the built-in version, with any files in `overrideDir` taking precedence. */
export function loadTemplates(version: string, overrideDir?: string): TemplateSet {
  const key = `${version}\0${overrideDir ?? ''}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const builtinDir = path.join(BUILTIN_PROMPTS_DIR, version);
  if (!fs.existsSync(builtinDir)) {
    throw new Error(`Unknown prompts.version "${version}". Known: ${builtinVersions().join(', ')}`);
  }
  const files = new Map([...readDir(builtinDir), ...readDir(overrideDir)]);

  const hb = Handlebars.create();
  const templates = new Map<string, Handlebars.TemplateDelegate>();
  for (const [file, full] of files) {
    if (!file.endsWith('.md')) continue;
    const source = fs.readFileSync(full, 'utf8');
    const name = file.slice(0, -3);
    if (name.startsWith('_')) hb.registerPartial(name.slice(1), source);
    else templates.set(name, hb.compile(source, { noEscape: true, strict: false }));
  }

  const posesFile = files.get('poses.json');
  const poses = posesFile ? (JSON.parse(fs.readFileSync(posesFile, 'utf8')) as Record<string, string>) : {};

  const set: TemplateSet = {
    version,
    poses,
    render(name, view) {
      const template = templates.get(name);
      if (!template) throw new Error(`Prompt template "${name}.md" not found in prompts/${version}`);
      return template(view).replace(/\n{3,}/g, '\n\n').trim();
    },
  };
  cache.set(key, set);
  return set;
}

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { findConfigPath, loadConfig, type ResolvedConfig } from './config.js';
import { loadManifest } from './manifest.js';
import { createProvider } from './providers/index.js';
import { skillInstallState } from './skill.js';

export type Check = { name: string; ok: boolean; details: string[] };

export async function runDoctor(configPath?: string): Promise<Check[]> {
  const checks: Check[] = [];

  // sharp
  try {
    const buffer = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#fff' } }).png().toBuffer();
    checks.push({ name: 'sharp', ok: buffer.length > 0, details: [`sharp ${sharp.versions.sharp}, libvips ${sharp.versions.vips}`] });
  } catch (error) {
    checks.push({ name: 'sharp', ok: false, details: [error instanceof Error ? error.message : String(error)] });
  }

  // config
  let config: ResolvedConfig | null = null;
  const found = configPath ?? findConfigPath();
  if (!found) {
    checks.push({ name: 'config', ok: false, details: ['no ukiyo.json here or above. Run `ukiyo init`'] });
  } else {
    try {
      config = loadConfig(found);
      checks.push({ name: 'config', ok: true, details: [found, `style ${path.relative(config.root, config.styleFile)} (${config.styleGuide.name})`, `prompts ${config.prompts.version}${config.promptsDir ? ` + ${path.relative(config.root, config.promptsDir)}` : ''}`, `provider ${config.provider.name}`] });
    } catch (error) {
      checks.push({ name: 'config', ok: false, details: [error instanceof Error ? error.message : String(error)] });
    }
  }

  // manifest
  if (config) {
    try {
      const manifest = loadManifest(config.manifestPath);
      const unknownKinds = manifest.filter((t) => !config!.kinds[t.kind]).map((t) => `${t.target} uses kind "${t.kind}"`);
      checks.push({ name: 'manifest', ok: unknownKinds.length === 0, details: [`${manifest.length} targets in ${path.relative(config.root, config.manifestPath)}`, ...unknownKinds] });
    } catch (error) {
      checks.push({ name: 'manifest', ok: false, details: [error instanceof Error ? error.message : String(error)] });
    }
    // out dir writable
    try {
      fs.mkdirSync(config.outDir, { recursive: true });
      fs.accessSync(config.outDir, fs.constants.W_OK);
      checks.push({ name: 'output', ok: true, details: [config.outDir] });
    } catch (error) {
      checks.push({ name: 'output', ok: false, details: [error instanceof Error ? error.message : String(error)] });
    }
    // provider
    try {
      const result = await createProvider(config).check();
      checks.push({ name: `provider:${config.provider.name}`, ok: result.ok, details: result.details });
    } catch (error) {
      checks.push({ name: `provider:${config.provider.name}`, ok: false, details: [error instanceof Error ? error.message : String(error)] });
    }
  }

  // skill
  const skill = skillInstallState();
  checks.push({ name: 'skill', ok: skill.installed, details: [skill.installed ? `installed at ${skill.path}` : 'not installed. Run `ukiyo skill install`'] });

  return checks;
}

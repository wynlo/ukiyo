import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The bundled skill directory, next to `dist/` inside the package. */
export function bundledSkillDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/skill.js -> ../skills/ukiyo ; src/skill.ts -> ../skills/ukiyo
  return path.resolve(here, '..', 'skills', 'ukiyo');
}

export function userSkillDir(): string {
  return path.join(os.homedir(), '.claude', 'skills', 'ukiyo');
}

export function projectSkillDir(root = process.cwd()): string {
  return path.join(root, '.claude', 'skills', 'ukiyo');
}

export function skillInstallState(): { installed: boolean; path: string } {
  const user = userSkillDir();
  const project = projectSkillDir();
  if (fs.existsSync(path.join(project, 'SKILL.md'))) return { installed: true, path: project };
  if (fs.existsSync(path.join(user, 'SKILL.md'))) return { installed: true, path: user };
  return { installed: false, path: user };
}

/** Symlink the bundled skill into the user or project skills folder. */
export function installSkill(scope: 'user' | 'project', root = process.cwd()): string {
  const source = bundledSkillDir();
  if (!fs.existsSync(path.join(source, 'SKILL.md'))) {
    throw new Error(`Bundled skill missing at ${source}`);
  }
  const target = scope === 'user' ? userSkillDir() : projectSkillDir(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target) || isBrokenLink(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
  }
  fs.symlinkSync(source, target, 'dir');
  return target;
}

function isBrokenLink(file: string): boolean {
  try {
    fs.lstatSync(file);
    return !fs.existsSync(file);
  } catch {
    return false;
  }
}

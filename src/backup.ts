import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ResolvedConfig } from './config.js';
import { targetDir } from './meta.js';

/**
 * Backups of a target's outputs, taken before `redo` removes them. A redo
 * followed by a failed `gen` used to lose the art for good. The copy lives
 * outside the project (`~/.cache/ukiyo/prev/<project>/<target>`), so it never
 * shows up in git, and `ukiyo restore <target>` puts it back. One backup per
 * target: the next redo replaces it.
 */
export function backupRoot(config: ResolvedConfig): string {
  const base = process.env.UKIYO_CACHE ?? path.join(os.homedir(), '.cache', 'ukiyo');
  const project = createHash('sha256').update(config.outDir).digest('hex').slice(0, 12);
  return path.join(base, 'prev', project);
}

export function backupPath(config: ResolvedConfig, target: string): string {
  return path.join(backupRoot(config), target);
}

/** Copies the target's output folder to its backup. Returns the backup path, or null when there was nothing to copy. */
export function backupTarget(config: ResolvedConfig, target: string): string | null {
  const dir = targetDir(config, target);
  if (!fs.existsSync(dir)) return null;
  const to = backupPath(config, target);
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(dir, to, { recursive: true });
  return to;
}

/** Puts the backup back over the target's outputs. Returns false when there is no backup. */
export function restoreTarget(config: ResolvedConfig, target: string): boolean {
  const from = backupPath(config, target);
  if (!fs.existsSync(from)) return false;
  const dir = targetDir(config, target);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(from, dir, { recursive: true });
  return true;
}

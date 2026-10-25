import { execa } from 'execa';
import type { ResolvedConfig } from './config.js';
import type { Target } from './manifest.js';
import type { GateRecord } from './meta.js';

/**
 * Post-final gates: project commands that judge a target's final art, set in
 * `ukiyo.json` `gates`. Each runs after `ukiyo final` (and in `ukiyo all`)
 * from the folder of ukiyo.json, with `{target}` and `{config}` replaced by
 * the target name and the path of ukiyo.json. Exit code 0 passes. A gate may
 * also write review fields into `meta.json` (a project gauge marks assets
 * `rejected` with a note); ukiyo reads meta.json again after the gates.
 *
 * The result is stored in meta.json as `gate`. `ukiyo pack` refuses a target
 * whose last gate failed, and the review page shows the output.
 */
export async function runGates(config: ResolvedConfig, target: Target): Promise<GateRecord | null> {
  if (!config.gates.length) return null;
  const results: GateRecord['results'] = [];
  for (const gate of config.gates) {
    const command = gate.command.replaceAll('{target}', target.target).replaceAll('{config}', config.configPath);
    const run = await execa(command, { cwd: config.root, shell: true, reject: false, all: true, timeout: gate.timeoutMs });
    const output = (run.all ?? '').trim().split('\n').slice(-20).join('\n');
    results.push({ name: gate.name, code: run.exitCode ?? (run.timedOut ? 124 : 1), output, blocksPack: gate.blocksPack });
  }
  return { at: new Date().toISOString(), passed: results.every((r) => r.code === 0), results };
}

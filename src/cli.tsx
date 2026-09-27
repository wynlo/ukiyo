#!/usr/bin/env node
import { Command } from 'commander';
import { render, Text } from 'ink';
import open from 'open';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { CONFIG_FILE, defaultConfig, findConfigPath, loadConfig, writeConfig, type ResolvedConfig } from './config.js';
import { runDoctor } from './doctor.js';
import { exampleManifest, loadManifest, writeManifest, type Manifest } from './manifest.js';
import { createPipeline, type Emit, type Pipeline } from './pipeline.js';
import { composePrompt } from './prompt/compose.js';
import { renderStyle, starterStyle } from './style.js';
import { BUILTIN_PROMPTS_DIR, builtinVersions } from './prompt/templates.js';
import { startReviewServer } from './review/server.js';
import { installSkill } from './skill.js';
import { Dashboard } from './ui/Dashboard.js';
import { Runner } from './ui/Runner.js';
import { StatusTable } from './ui/StatusTable.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const program = new Command();
program.name('ukiyo').description('Game art pipeline: prompts, generation, cut-out, review, atlas.').version(pkg.version);
program.option('-C, --config <path>', `path to ${CONFIG_FILE}`);

type Ctx = { config: ResolvedConfig; manifest: Manifest };

function ctx(): Ctx {
  const opts = program.opts<{ config?: string }>();
  const config = loadConfig(opts.config);
  const manifest = loadManifest(config.manifestPath);
  return { config, manifest };
}

function runInk(title: string, task: (emit: Emit) => Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    let failed = false;
    const app = render(
      <Runner
        title={title}
        task={task}
        onFinish={(f) => {
          failed = f;
        }}
      />,
    );
    app.waitUntilExit().then(() => {
      if (failed) process.exitCode = 1;
      resolve();
    });
  });
}

function pipelineTask(fn: (p: Pipeline, c: Ctx) => Promise<unknown>): (emit: Emit) => Promise<void> {
  const c = ctx();
  return async (emit) => {
    await fn(createPipeline(c.config, c.manifest, emit), c);
  };
}

async function copyToClipboard(text: string): Promise<void> {
  const { execa } = await import('execa');
  const commands: [string, string[]][] =
    process.platform === 'darwin' ? [['pbcopy', []]] : process.platform === 'win32' ? [['clip', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of commands) {
    try {
      await execa(cmd, args, { input: text });
      return;
    } catch {
      // try the next one
    }
  }
  throw new Error(`No clipboard command found (tried ${commands.map(([cmd]) => cmd).join(', ')})`);
}

function fail(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// ---- init / style / prompt -------------------------------------------------------------

program
  .command('init')
  .description(`write ${CONFIG_FILE}, a starter style file, and an example manifest into the current directory`)
  .option('-n, --name <name>', 'project name', path.basename(process.cwd()))
  .option('--force', 'overwrite existing files')
  .action((opts: { name: string; force?: boolean }) => {
    const dir = process.cwd();
    const configFile = path.join(dir, CONFIG_FILE);
    if (fs.existsSync(configFile) && !opts.force) fail(`${CONFIG_FILE} already exists (use --force to overwrite)`);
    const config = defaultConfig(opts.name);
    writeConfig(dir, config);
    const written = [CONFIG_FILE];
    const stylePath = path.join(dir, config.style.file);
    if (!fs.existsSync(stylePath) || opts.force) {
      fs.mkdirSync(path.dirname(stylePath), { recursive: true });
      fs.writeFileSync(stylePath, renderStyle(starterStyle));
      written.push(config.style.file);
    }
    const manifestPath = path.join(dir, config.manifest);
    if (!fs.existsSync(manifestPath) || opts.force) {
      writeManifest(manifestPath, exampleManifest());
      written.push(config.manifest);
    }
    console.log(`wrote ${written.join(', ')}. Describe your art in ${config.style.file}, edit the manifest, then run \`ukiyo doctor\` and \`ukiyo all\`.`);
  });

program
  .command('style')
  .description('validate the style file and print it as JSON')
  .action(() => {
    try {
      console.log(JSON.stringify(ctx().config.styleGuide, null, 2));
    } catch (error) {
      fail(error);
    }
  });

const promptsCmd = program.command('prompts').description('list prompt template versions');
promptsCmd.action(() => {
  const configPath = findConfigPath();
  const active = configPath ? loadConfig(configPath).prompts.version : undefined;
  for (const version of builtinVersions()) console.log(`${version === active ? '*' : ' '} ${version}`);
});
promptsCmd
  .command('eject [dir]')
  .description('copy the active template version into the project and set prompts.dir')
  .option('--force', 'overwrite existing files')
  .action((dir: string | undefined, opts: { force?: boolean }) => {
    try {
      const { config } = ctx();
      const relative = dir ?? config.prompts.dir ?? 'art/prompts';
      const target = path.resolve(config.root, relative);
      fs.mkdirSync(target, { recursive: true });
      const source = path.join(BUILTIN_PROMPTS_DIR, config.prompts.version);
      let copied = 0;
      for (const file of fs.readdirSync(source)) {
        const destination = path.join(target, file);
        if (fs.existsSync(destination) && !opts.force) continue;
        fs.copyFileSync(path.join(source, file), destination);
        copied += 1;
      }
      const configFile = path.join(config.root, CONFIG_FILE);
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf8')) as { prompts?: { version?: string; dir?: string } };
      raw.prompts = { ...raw.prompts, version: config.prompts.version, dir: relative };
      fs.writeFileSync(configFile, `${JSON.stringify(raw, null, 2)}\n`);
      console.log(`copied ${copied} ${config.prompts.version} templates to ${relative} and set prompts.dir. Files there override the built-in ones by name.`);
    } catch (error) {
      fail(error);
    }
  });

program
  .command('prompt <target>')
  .description('compose and print the prompt for a target')
  .option('--copy', 'copy to the clipboard')
  .action(async (name: string, opts: { copy?: boolean }) => {
    try {
      const { config, manifest } = ctx();
      const target = manifest.find((t) => t.target === name);
      if (!target) fail(`Unknown target "${name}"`);
      const text = composePrompt(config, target);
      console.log(text);
      if (opts.copy) {
        await copyToClipboard(text);
        console.error('\n(copied to clipboard)');
      }
    } catch (error) {
      fail(error);
    }
  });

// ---- pipeline steps -------------------------------------------------------------------

const names = (list: string[]) => (list.length ? list : undefined);

program
  .command('gen [targets...]')
  .description('generate raw images for targets that have none')
  .option('--all', 'every target (default when none given)')
  .option('--force', 'regenerate even when raw.png exists')
  .action((targets: string[], opts: { force?: boolean }) => runInk('gen', pipelineTask((p) => p.gen(names(targets), opts.force))).catch(fail));

program
  .command('import <file>')
  .description('bring in an image generated elsewhere as a target\'s raw.png')
  .requiredOption('-t, --target <name>', 'target name')
  .option('-a, --asset <name>', 'layer id, for layer targets')
  .action((file: string, opts: { target: string; asset?: string }) => runInk('import', pipelineTask((p) => p.importFile(opts.target, file, opts.asset))).catch(fail));

program
  .command('animate [targets...]')
  .description('per-frame edit calls for strip targets whose frames need redrawing')
  .option('--force', 'redo frames that exist')
  .action((targets: string[], opts: { force?: boolean }) => runInk('animate', pipelineTask((p) => p.animate(names(targets), opts.force))).catch(fail));

program
  .command('edit <target> <asset> <instruction>')
  .description('iterate one cut asset with an instruction')
  .action((target: string, asset: string, instruction: string) => runInk('edit', pipelineTask((p) => p.edit(target, asset, instruction))).catch(fail));

program
  .command('cut [targets...]')
  .description('detect components, cut them out, remove the background')
  .option('--force', 'redo targets already cut')
  .action((targets: string[], opts: { force?: boolean }) => runInk('cut', pipelineTask((p) => p.cut(names(targets), opts.force))).catch(fail));

program
  .command('final [targets...]')
  .alias('crop')
  .alias('fit')
  .description('trim, align frames, resize to the kind height, write final/')
  .option('--force', 'redo targets already finalised')
  .action((targets: string[], opts: { force?: boolean }) => runInk('final', pipelineTask((p) => p.finalize(names(targets), opts.force))).catch(fail));

program
  .command('sheet [targets...]')
  .description('write sheet.png and sheet.html (frame player) per target')
  .option('--open', 'open the first sheet in the browser')
  .action((targets: string[], opts: { open?: boolean }) =>
    runInk(
      'sheet',
      pipelineTask(async (p) => {
        const files = await p.sheet(names(targets));
        if (opts.open && files[0]) await open(files[0]);
      }),
    ).catch(fail),
  );

program
  .command('pack [groups...]')
  .description('pack approved final assets into atlases')
  .option('--allow-pending', 'include assets that are not approved yet')
  .action((groups: string[], opts: { allowPending?: boolean }) => runInk('pack', pipelineTask((p) => p.pack(names(groups), opts.allowPending))).catch(fail));

program
  .command('all [targets...]')
  .description('gen, cut, final, sheet; stop at the review gate; pack when everything is approved')
  .action((targets: string[]) => runInk('all', pipelineTask((p) => p.all(names(targets)))).catch(fail));

program
  .command('redo <target> [asset]')
  .description('delete outputs so the next run regenerates them')
  .action((target: string, asset?: string) => runInk('redo', pipelineTask(async (p) => p.redo(target, asset))).catch(fail));

// ---- review / status --------------------------------------------------------------------

program
  .command('review')
  .description('serve the review page: approve, reject, redo per asset')
  .option('--port <n>', 'port', '4177')
  .option('--no-open', 'do not open the browser')
  .action(async (opts: { port: string; open: boolean }) => {
    try {
      const { config, manifest } = ctx();
      const { url } = await startReviewServer(config, manifest, Number(opts.port), (change) => {
        console.log(`${change.redo ? 'redo' : change.status}  ${change.target}/${change.asset}${change.note ? `  — ${change.note}` : ''}`);
      });
      console.log(`review page: ${url}  (ctrl-c to stop)`);
      if (opts.open) await open(url);
    } catch (error) {
      fail(error);
    }
  });

program
  .command('status')
  .description('table of every target; exit 1 when anything is pending or rejected')
  .option('--json', 'machine-readable')
  .action((opts: { json?: boolean }) => {
    try {
      const { config, manifest } = ctx();
      const rows = createPipeline(config, manifest, () => {}).status();
      const blocked = rows.some((r) => r.review.pending > 0 || r.review.rejected > 0);
      if (opts.json) console.log(JSON.stringify(rows, null, 2));
      else {
        const app = render(<StatusTable rows={rows} />);
        app.unmount();
      }
      if (blocked) {
        console.error('review gate: pending or rejected assets remain');
        process.exitCode = 1;
      }
    } catch (error) {
      fail(error);
    }
  });

// ---- doctor / skill ---------------------------------------------------------------------

program
  .command('doctor')
  .description('check codex, sharp, config, manifest, and the skill')
  .action(async () => {
    const opts = program.opts<{ config?: string }>();
    const checks = await runDoctor(opts.config);
    let ok = true;
    for (const check of checks) {
      ok &&= check.ok;
      console.log(`${check.ok ? '✓' : '✗'} ${check.name}`);
      for (const line of check.details) console.log(`    ${line}`);
    }
    if (!ok) process.exitCode = 1;
  });

const skill = program.command('skill').description('the bundled Claude Code skill');
skill
  .command('install')
  .description('symlink the skill into ~/.claude/skills (or .claude/skills with --project)')
  .option('--project', 'install into the current project instead of the user folder')
  .action((opts: { project?: boolean }) => {
    try {
      const target = installSkill(opts.project ? 'project' : 'user');
      console.log(`skill linked at ${target}`);
    } catch (error) {
      fail(error);
    }
  });

// ---- default: dashboard -------------------------------------------------------------------

program.action(() => {
  try {
    const { config, manifest } = ctx();
    if (!process.stdin.isTTY) {
      const rows = createPipeline(config, manifest, () => {}).status();
      const app = render(<StatusTable rows={rows} />);
      app.unmount();
      return;
    }
    render(<Dashboard config={config} manifest={manifest} />);
  } catch (error) {
    if (!findConfigPath()) {
      render(<Text color="yellow">No {CONFIG_FILE} here. Run `ukiyo init` to start.</Text>).unmount();
      return;
    }
    fail(error);
  }
});

program.parseAsync(process.argv).catch(fail);

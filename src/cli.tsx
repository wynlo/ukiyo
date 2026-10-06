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
import { createPipeline, type Emit, type Pipeline, type PipelineOptions } from './pipeline.js';
import { createReferenceResolver, describePlan, type ReferenceRequest } from './references.js';
import { stagePath } from './meta.js';
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

function pipelineTask(fn: (p: Pipeline, c: Ctx) => Promise<unknown>, options: PipelineOptions = {}): (emit: Emit) => Promise<void> {
  const c = ctx();
  return async (emit) => {
    await fn(createPipeline(c.config, c.manifest, emit, undefined, options), c);
  };
}

type RefFlags = { ref?: string[]; refs?: boolean; refsOnly?: string[]; maxRefs?: string; pendingRefs?: boolean };

const collect = (value: string, previous: string[] = []) => [...previous, ...value.split(',').map((v) => v.trim()).filter(Boolean)];

/** The per-request reference flags. Every command that generates takes them. */
function withRefFlags(command: Command): Command {
  return command
    .option('--ref <ref>', 'add a reference image: <target>/<asset> or a file path (repeatable, or comma-separated)', collect)
    .option('--no-refs', 'send no reference images (an edit still sends its input image)')
    .option('--refs-only <ref>', 'send only these reference images (repeatable, or comma-separated)', collect)
    .option('--max-refs <n>', 'the most reference images per call, not counting the input image')
    .option('--pending-refs', 'automatic references may use assets that are not approved yet');
}

function refRequest(flags: RefFlags): ReferenceRequest {
  const max = flags.maxRefs === undefined ? undefined : Number(flags.maxRefs);
  if (max !== undefined && !(Number.isInteger(max) && max >= 0)) fail(`--max-refs expects a whole number, got "${flags.maxRefs}"`);
  return { add: flags.ref, only: flags.refsOnly, none: flags.refs === false, max, pending: flags.pendingRefs };
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

withRefFlags(
  program
    .command('prompt <target>')
    .description('compose and print the prompt for a target, and the reference images a generation would send')
    .option('--copy', 'copy the prompt to the clipboard')
    .option('--json', 'print the prompt and the reference list as JSON'),
).action(async (name: string, opts: RefFlags & { copy?: boolean; json?: boolean }) => {
  try {
    const { config, manifest } = ctx();
    const target = manifest.find((t) => t.target === name);
    if (!target) fail(`Unknown target "${name}"`);
    const resolver = createReferenceResolver(config, manifest);
    // The input image of an edit-based target, as `gen` would send it.
    const input =
      target.compose === 'parts' && target.reference
        ? { file: stagePath(config, target.reference.split('/')[0]!, 'cut', target.reference.split('/')[1]!), id: target.reference }
        : target.compose === 'layer' || target.compose === 'split'
          ? { file: stagePath(config, target.base.split('/')[0]!, 'cut', target.base.split('/')[1]!), id: target.base }
          : undefined;
    const plan = resolver.resolve(target, { request: refRequest(opts), input, exclude: input?.id ? [input.id] : undefined });
    const block = resolver.promptBlock(target, plan);
    const text = block ? `${composePrompt(config, target)}\n\n${block}` : composePrompt(config, target);
    if (opts.json) {
      console.log(JSON.stringify({ target: target.target, prompt: text, input: plan.input, references: plan.refs, dropped: plan.dropped }, null, 2));
      return;
    }
    console.log(text);
    const lines = describePlan(plan);
    console.log(`\n---\nIMAGES TO ATTACH, IN THIS ORDER${target.compose === 'layer' || target.compose === 'split' ? ' (for image 1, `ukiyo gen` sends the base on the background, in the marker colour for a layer or an add)' : ''}:`);
    console.log(lines.length ? lines.join('\n') : '(none)');
    if (opts.copy) {
      await copyToClipboard(text);
      console.error('\n(prompt copied to the clipboard; attach the images above)');
    }
  } catch (error) {
    fail(error);
  }
});

// ---- pipeline steps -------------------------------------------------------------------

const names = (list: string[]) => (list.length ? list : undefined);

program
  .command('plan [targets...]')
  .description('score sprites and write multipart part plans (split targets) for the complex ones')
  .option('--relabel', 'ask the model again instead of using cached labels')
  .option('--dry', 'report the plans without writing the manifest')
  .option('--score', 'only score the assets; no labels, no plans')
  .option('--ignore-locks', 'with --dry: plan locked targets too, to compare with the hand plans')
  .option('--label-all', 'label every sprite, whatever its score or triggers (a full material pass)')
  .option('--json', 'print the rows as JSON')
  .action(async (targets: string[], opts: { relabel?: boolean; dry?: boolean; json?: boolean; score?: boolean; ignoreLocks?: boolean; labelAll?: boolean }) => {
    try {
      const { config, manifest } = ctx();
      const pipeline = createPipeline(config, manifest, (event) => {
        if (event.type === 'error' || event.type === 'warn') console.error(`${event.type} ${'target' in event ? event.target : ''}: ${'message' in event ? event.message : ''}`);
        else if (event.type === 'start' && !opts.json) console.log(`… ${event.target}: ${event.message ?? ''}`);
      });
      const rows = await pipeline.plan(names(targets), { relabel: opts.relabel, dry: opts.dry, scoreOnly: opts.score, ignoreLocks: opts.ignoreLocks && opts.dry, labelAll: opts.labelAll });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      for (const row of rows) {
        console.log(`${row.score.toFixed(2)} ${row.score >= row.threshold ? '≥' : '<'} ${row.threshold.toFixed(2)}${row.trigger ? ` [${row.trigger}]` : ''}  ${row.target}/${row.asset}  ${row.action}${row.pieces?.length ? `: ${row.pieces.join(', ')}` : ''}`);
        for (const d of row.dropped ?? []) console.log(`      dropped ${d}`);
        if (row.effects) console.log(`      effects: ${row.effects}`);
      }
    } catch (error) {
      fail(error);
    }
  });

withRefFlags(
  program
    .command('gen [targets...]')
    .description('generate raw images for targets that have none')
    .option('--all', 'every target (default when none given)')
    .option('--force', 'regenerate even when raw.png exists'),
).action((targets: string[], opts: RefFlags & { force?: boolean }) => runInk('gen', pipelineTask((p) => p.gen(names(targets), opts.force), { refs: refRequest(opts) })).catch(fail));

program
  .command('import <file>')
  .description('bring in an image generated elsewhere as a target\'s raw.png')
  .requiredOption('-t, --target <name>', 'target name')
  .option('-a, --asset <name>', 'layer id, for layer targets')
  .action((file: string, opts: { target: string; asset?: string }) => runInk('import', pipelineTask((p) => p.importFile(opts.target, file, opts.asset))).catch(fail));

withRefFlags(
  program
    .command('animate [targets...]')
    .description('per-frame edit calls for strip targets whose frames need redrawing')
    .option('--force', 'redo frames that exist'),
).action((targets: string[], opts: RefFlags & { force?: boolean }) => runInk('animate', pipelineTask((p) => p.animate(names(targets), opts.force), { refs: refRequest(opts) })).catch(fail));

withRefFlags(program.command('edit <target> <asset> <instruction>').description('iterate one cut asset with an instruction')).action(
  (target: string, asset: string, instruction: string, opts: RefFlags) => runInk('edit', pipelineTask((p) => p.edit(target, asset, instruction), { refs: refRequest(opts) })).catch(fail),
);

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
  .option('--allow-pending', 'include assets that are not approved yet (not auto part plans nobody has reviewed)')
  .option('--allow-pending-plans', 'with --allow-pending: include auto part plans that are not approved yet')
  .action((groups: string[], opts: { allowPending?: boolean; allowPendingPlans?: boolean }) => runInk('pack', pipelineTask((p) => p.pack(names(groups), opts.allowPending, opts.allowPendingPlans))).catch(fail));

withRefFlags(program.command('all [targets...]').description('gen, cut, final, sheet; stop at the review gate; pack when everything is approved')).action(
  (targets: string[], opts: RefFlags) => runInk('all', pipelineTask((p) => p.all(names(targets)), { refs: refRequest(opts) })).catch(fail),
);

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

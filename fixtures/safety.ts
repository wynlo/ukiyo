/**
 * Checks of the generation safety rules on a small project in a temp folder,
 * with a fake provider. No image API is called. Run with `npm run check:safety`.
 *
 * 1. `redo` keeps a backup, and `restore` puts it back.
 * 2. New art from `gen --force` and `import` goes back to `pending`.
 * 3. Locked anchors are sent under `replace`, `none` and `--refs-only`.
 * 4. Automatic references honour `auto.since` and `auto.requireGate`.
 * 5. Post-final gates run, are recorded, and a failed gate stops `pack`
 *    and `approve`.
 * 6. `approve` and `reject` write the review fields.
 * 7. The cross-process limiter keeps one call at a time, the gap and a pause.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { loadManifest } from '../src/manifest.js';
import { readMeta } from '../src/meta.js';
import { createLimiter } from '../src/limiter.js';
import { createPipeline, type PipelineEvent } from '../src/pipeline.js';
import type { ImageProvider } from '../src/providers/types.js';
import { createReferenceResolver } from '../src/references.js';
import { renderStyle, starterStyle } from '../src/style.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ukiyo-safety-check-'));
process.env.UKIYO_CACHE = path.join(root, '.cache');

const png = async (file: string, color: string, width = 64, height = 64) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 4, background: color } }).png().toFile(file);
};

/** A provider that draws one coloured square on chroma green. */
let made = 0;
const fake: ImageProvider = {
  name: 'fake',
  async generate() {
    made += 1;
    const file = path.join(root, `.made-${made}.png`);
    await sharp({ create: { width: 512, height: 512, channels: 4, background: '#00FF00' } })
      .composite([{ input: await sharp({ create: { width: 200, height: 200, channels: 4, background: '#DB4032' } }).png().toBuffer(), left: 156, top: 156 }])
      .png()
      .toFile(file);
    return { file };
  },
  async edit(prompt, _image, options) {
    return this.generate(prompt, options);
  },
  async check() {
    return { ok: true, details: [] };
  },
};

const manifest = [
  { target: 'prop', kind: 'item', compose: 'single', game: 'g', subject: 'a red box', background: '#00FF00' },
  { target: 'old', kind: 'item', compose: 'single', game: 'g', subject: 'old art' },
  { target: 'gated', kind: 'item', compose: 'single', game: 'g', subject: 'gated art' },
  { target: 'own', kind: 'item', compose: 'single', game: 'g', subject: 'own', references: ['ref.png'], referencesMode: 'replace', maxReferences: 1 },
  { target: 'off', kind: 'item', compose: 'single', game: 'g', subject: 'off', referencesMode: 'none' },
];

function writeConfig(extra: object) {
  const config = {
    project: { name: 'safety check' },
    provider: { name: 'manual', concurrency: 1, gapMs: 0 },
    cutout: { mode: 'flood', chroma: '#00FF00' },
    kinds: { item: { height: 1, anchor: 'bottom-center', aspect: '1:1' } },
    ...extra,
  };
  fs.writeFileSync(path.join(root, 'ukiyo.json'), JSON.stringify(config, null, 2));
  return loadConfig(path.join(root, 'ukiyo.json'));
}

async function setup() {
  fs.mkdirSync(path.join(root, 'art'), { recursive: true });
  fs.writeFileSync(path.join(root, 'art/style.md'), renderStyle(starterStyle));
  fs.writeFileSync(path.join(root, 'art/manifest.json'), JSON.stringify(manifest, null, 2));
  await png(path.join(root, 'anchor.png'), '#ff0000');
  await png(path.join(root, 'ref.png'), '#0000ff');
  for (const [target, generatedAt, gate] of [
    ['old', '2025-01-01T00:00:00Z', undefined],
    ['gated', '2026-06-01T00:00:00Z', { at: '2026-06-01T00:00:00Z', passed: true, results: [] }],
  ] as const) {
    await png(path.join(root, `art/generated/${target}/final/${target}.png`), target === 'old' ? '#111111' : '#222222');
    const meta = { target, compose: 'single', kind: 'item', warnings: [], generatedAt, ...(gate ? { gate } : {}), assets: { [target]: { name: target, status: 'approved', reviewedAt: generatedAt, width: 64, height: 64 } } };
    fs.writeFileSync(path.join(root, `art/generated/${target}/meta.json`), JSON.stringify(meta, null, 2));
  }
}

const quiet = (_e: PipelineEvent) => undefined;
const events: PipelineEvent[] = [];
const record = (e: PipelineEvent) => events.push(e);

async function main() {
  await setup();
  const manifestPath = path.join(root, 'art/manifest.json');
  const target = (name: string) => loadManifest(manifestPath).find((t) => t.target === name)!;

  // ---- 2. new art goes back to pending
  let config = writeConfig({});
  let pipe = createPipeline(config, loadManifest(manifestPath), quiet, fake);
  await pipe.gen(['prop']);
  await pipe.cut(['prop']);
  await pipe.finalize(['prop']);
  pipe.review('prop', [], 'approved');
  assert.equal(readMeta(config, target('prop')).assets.prop!.status, 'approved', 'approve sets approved');
  await pipe.gen(['prop'], true);
  const regen = readMeta(config, target('prop')).assets.prop!;
  assert.equal(regen.status, 'pending', 'gen --force resets an approved asset to pending');
  assert.equal(regen.reviewedAt, undefined, 'gen --force clears reviewedAt');
  pipe.review('prop', [], 'approved');
  await pipe.importFile('prop', path.join(root, 'ref.png'));
  assert.equal(readMeta(config, target('prop')).assets.prop!.status, 'pending', 'import resets to pending');

  // ---- 1. redo keeps a backup; restore puts it back
  const raw = path.join(config.outDir, 'prop', 'raw.png');
  const before = fs.readFileSync(raw);
  pipe.redo('prop');
  assert.equal(fs.existsSync(raw), false, 'redo removes the outputs');
  pipe.restore('prop');
  assert.ok(fs.existsSync(raw) && fs.readFileSync(raw).equals(before), 'restore brings raw.png back');
  assert.throws(() => pipe.restore('old'), /No backup/, 'restore without a backup fails');

  // ---- 6. approve / reject
  pipe.review('prop', ['prop'], 'rejected', 'too glossy');
  const rejected = readMeta(config, target('prop')).assets.prop!;
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.note, 'too glossy');
  assert.throws(() => pipe.review('prop', ['nope'], 'approved'), /no asset/, 'unknown asset is refused');

  // ---- 3. locked anchors
  config = writeConfig({ references: { anchors: ['anchor.png'], lockAnchors: true, auto: { max: 0 } } });
  let refs = createReferenceResolver(config, loadManifest(manifestPath));
  const paths = (plan: { refs: { path: string; id?: string }[] }) => plan.refs.map((r) => r.id ?? r.path);
  assert.deepEqual(paths(refs.resolve(target('own'))), ['anchor.png', 'ref.png'], 'locked anchor first under replace, outside maxReferences 1');
  assert.deepEqual(paths(refs.resolve(target('off'))), ['anchor.png'], 'locked anchor under none');
  assert.deepEqual(paths(refs.resolve(target('prop'), { request: { only: ['ref.png'] } })), ['anchor.png', 'ref.png'], 'locked anchor under --refs-only');
  assert.deepEqual(paths(refs.resolve(target('prop'), { request: { none: true } })), [], '--no-refs drops locked anchors');
  config = writeConfig({ references: { anchors: ['anchor.png'], auto: { max: 0 } } });
  refs = createReferenceResolver(config, loadManifest(manifestPath));
  assert.deepEqual(paths(refs.resolve(target('own'))), ['ref.png'], 'unlocked anchors are still dropped by replace');

  // ---- 4. auto picks: since and requireGate
  config = writeConfig({ references: { auto: { max: 3, since: '2026-01-01' } } });
  refs = createReferenceResolver(config, loadManifest(manifestPath));
  let picked = paths(refs.resolve(target('prop')));
  assert.ok(picked.includes('gated/gated') && !picked.includes('old/old'), `auto.since skips old art (${picked})`);
  config = writeConfig({ references: { auto: { max: 3, requireGate: true } } });
  refs = createReferenceResolver(config, loadManifest(manifestPath));
  picked = paths(refs.resolve(target('prop')));
  assert.deepEqual(picked, ['gated/gated'], 'auto.requireGate keeps only targets whose gate passed');

  // ---- 5. gates
  const gateScript = path.join(root, 'gate.mjs');
  fs.writeFileSync(gateScript, "process.exit(process.argv[2] === 'prop' ? 1 : 0)\n");
  config = writeConfig({ gates: [{ name: 'gauge', command: `node ${gateScript} {target}` }] });
  events.length = 0;
  pipe = createPipeline(config, loadManifest(manifestPath), record, fake);
  await pipe.finalize(['prop'], true);
  const gate = readMeta(config, target('prop')).gate;
  assert.ok(gate && gate.passed === false && gate.results[0]!.name === 'gauge', 'a failed gate is recorded');
  assert.ok(events.some((e) => e.type === 'warn' && /gate failed/.test(e.message ?? '')), 'a failed gate is reported');
  assert.throws(() => pipe.review('prop', [], 'approved'), /failed its gate/, 'approve refuses a target whose gate failed');
  const packed = await pipe.pack(['g'], true);
  assert.ok(packed.every((r) => r.skipped.some((s) => /gate gauge failed/.test(s))), 'pack refuses it, even with --allow-pending');
  config = writeConfig({ gates: [{ name: 'gauge', command: `node ${gateScript} {target}`, blocksPack: false }] });
  pipe = createPipeline(config, loadManifest(manifestPath), quiet, fake);
  await pipe.finalize(['prop'], true);
  const loose = await pipe.pack(['g'], true);
  assert.ok(loose.every((r) => !r.skipped.some((s) => /gate/.test(s))), 'blocksPack false lets the target pack');
  const nogate = createPipeline(config, loadManifest(manifestPath), quiet, fake, { noGates: true });
  fs.writeFileSync(path.join(config.outDir, 'prop', 'meta.json'), JSON.stringify({ ...readMeta(config, target('prop')), gate: undefined }, null, 2));
  await nogate.finalize(['prop'], true);
  assert.equal(readMeta(config, target('prop')).gate, undefined, '--no-gates skips the gates');

  // ---- 7. limiter
  const dir = path.join(root, '.cache', 'limiter-check');
  const a = createLimiter({ concurrency: 1, gapMs: 150, dir, pollMs: 10 });
  const b = createLimiter({ concurrency: 1, gapMs: 150, dir, pollMs: 10 });
  let running = 0;
  let most = 0;
  const starts: number[] = [];
  const job = async () => {
    starts.push(Date.now());
    running += 1;
    most = Math.max(most, running);
    await new Promise((r) => setTimeout(r, 40));
    running -= 1;
  };
  await Promise.all([a.run(job), b.run(job), a.run(job)]);
  assert.equal(most, 1, 'one call at a time across limiters');
  starts.sort((x, y) => x - y);
  for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i]! - starts[i - 1]! >= 140, `calls are gapMs apart (${starts[i]! - starts[i - 1]!} ms)`);
  b.pauseUntil(Date.now() + 300);
  const t0 = Date.now();
  await a.run(async () => undefined);
  assert.ok(Date.now() - t0 >= 280, 'a pause set by one limiter holds the others');

  fs.rmSync(root, { recursive: true, force: true });
  console.log('check:safety: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

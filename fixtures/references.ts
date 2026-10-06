/**
 * Checks of the reference selection rules (`src/references.ts`) on a small
 * project in a temp folder. No provider is called. Run with `npm run check:refs`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { loadConfig } from '../src/config.js';
import { loadManifest } from '../src/manifest.js';
import { createReferenceResolver, referenceRecords } from '../src/references.js';
import { renderStyle, starterStyle } from '../src/style.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ukiyo-refs-check-'));
const png = async (file: string, color: string, width = 64, height = 64) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 4, background: color } }).png().toFile(file);
};

type Asset = { name: string; status: 'approved' | 'pending' | 'rejected'; reviewedAt?: string };

const manifest = [
  { target: 'style-sheet', kind: 'item', compose: 'sheet', game: 'style', assets: ['one'] },
  { target: 'a', kind: 'item', compose: 'sheet', game: 'g1', assets: ['a1', 'a2'] },
  { target: 'b', kind: 'item', compose: 'single', game: 'g1', subject: 'b' },
  { target: 'c', kind: 'icon', compose: 'single', game: 'g1', subject: 'c' },
  { target: 'd', kind: 'item', compose: 'single', game: 'g2', subject: 'd' },
  { target: 'new', kind: 'item', compose: 'single', game: 'g1', subject: 'new' },
  { target: 'new-g2', kind: 'item', compose: 'single', game: 'g2', subject: 'new' },
  { target: 'own', kind: 'item', compose: 'single', game: 'g1', subject: 'own', references: ['c/c'], referencesMode: 'replace' },
  { target: 'off', kind: 'item', compose: 'single', game: 'g1', subject: 'off', referencesMode: 'none' },
  { target: 'bad', kind: 'item', compose: 'single', game: 'g1', subject: 'bad', references: ['a/a2', 'missing.png'] },
];

const assets: Record<string, Asset[]> = {
  a: [
    { name: 'a1', status: 'approved', reviewedAt: '2026-01-02T00:00:00Z' },
    { name: 'a2', status: 'rejected', reviewedAt: '2026-01-05T00:00:00Z' },
  ],
  b: [{ name: 'b', status: 'approved', reviewedAt: '2026-01-03T00:00:00Z' }],
  c: [{ name: 'c', status: 'approved', reviewedAt: '2026-01-04T00:00:00Z' }],
  d: [{ name: 'd', status: 'pending' }],
  new: [{ name: 'new', status: 'approved', reviewedAt: '2026-01-06T00:00:00Z' }],
};

function writeProject(references: object | undefined) {
  const config = {
    project: { name: 'refs check' },
    kinds: { item: { height: 1, anchor: 'bottom-center', aspect: '1:1' }, icon: { height: 0.5, anchor: 'center', aspect: '1:1' } },
    ...(references ? { references } : {}),
  };
  fs.writeFileSync(path.join(root, 'ukiyo.json'), JSON.stringify(config, null, 2));
  return loadConfig(path.join(root, 'ukiyo.json'));
}

async function setup() {
  fs.mkdirSync(path.join(root, 'art'), { recursive: true });
  fs.writeFileSync(path.join(root, 'art/style.md'), renderStyle(starterStyle));
  fs.writeFileSync(path.join(root, 'art/manifest.json'), JSON.stringify(manifest, null, 2));
  await png(path.join(root, 'anchor.png'), '#ff0000');
  await png(path.join(root, 'art/generated/style-sheet/raw.png'), '#00ff00');
  let shade = 16;
  for (const [target, list] of Object.entries(assets)) {
    const meta = { target, compose: 'sheet', kind: 'item', warnings: [], assets: {} as Record<string, object> };
    for (const asset of list) {
      shade += 16;
      await png(path.join(root, `art/generated/${target}/final/${asset.name}.png`), `#0000${shade.toString(16).padStart(2, '0')}`, 64, 64);
      meta.assets[asset.name] = { ...asset, width: 64, height: 64, content: { x: 8, y: 0, width: 48, height: 64 } };
    }
    fs.writeFileSync(path.join(root, `art/generated/${target}/meta.json`), JSON.stringify(meta, null, 2));
  }
}

const ids = (plan: { refs: { id?: string; path: string }[] }) => plan.refs.map((r) => r.id ?? r.path);

async function main() {
  await setup();
  const manifestPath = path.join(root, 'art/manifest.json');
  const target = (name: string) => loadManifest(manifestPath).find((t) => t.target === name)!;

  // Without a `references` section: only the first target's raw.png, as before.
  {
    const config = writeProject(undefined);
    const r = createReferenceResolver(config, loadManifest(manifestPath));
    assert.deepEqual(ids(r.resolve(target('new'))), ['art/generated/style-sheet/raw.png']);
    assert.deepEqual(ids(r.resolve(target('style-sheet'))), [], 'the first target is not its own reference');
  }

  const config = writeProject({ anchors: ['anchor.png'], auto: { max: 2, match: ['kind'] } });
  const r = createReferenceResolver(config, loadManifest(manifestPath));

  // Anchor first, then same kind + same group by most recent approval. Rejected, pending, other kinds and the target itself are out.
  const plan = r.resolve(target('new'));
  assert.deepEqual(ids(plan), ['anchor.png', 'b/b', 'a/a1']);
  assert.deepEqual(plan.refs.map((x) => x.role), ['style', 'proportions', 'proportions']);
  assert.deepEqual(ids(r.resolve(target('new'))), ids(plan), 'the same state gives the same list');

  // Pending assets only with the flag; same group then ranks first.
  assert.deepEqual(ids(r.resolve(target('new-g2'))), ['anchor.png', 'new/new', 'b/b']);
  assert.deepEqual(ids(r.resolve(target('new-g2'), { request: { pending: true } })), ['anchor.png', 'd/d', 'new/new']);

  // Per request.
  assert.deepEqual(ids(r.resolve(target('new'), { request: { none: true } })), []);
  assert.deepEqual(ids(r.resolve(target('new'), { request: { only: ['c/c'] } })), ['c/c']);
  assert.equal(r.resolve(target('new'), { request: { only: ['c/c'] } }).refs[0]!.role, 'family', 'other kind, same group');
  assert.deepEqual(ids(r.resolve(target('new'), { request: { add: ['c/c'] } })), ['anchor.png', 'c/c', 'b/b', 'a/a1']);
  const capped = r.resolve(target('new'), { request: { max: 1 } });
  assert.deepEqual(ids(capped), ['anchor.png']);
  assert.ok(capped.dropped.some((d) => d.ref === 'b/b' && d.reason.startsWith('over the limit')));

  // Per target.
  assert.deepEqual(ids(r.resolve(target('own'))), ['c/c'], 'replace');
  assert.deepEqual(ids(r.resolve(target('off'))), [], 'none');
  assert.deepEqual(ids(r.resolve(target('off'), { request: { add: ['b/b'] } })), ['b/b'], 'a request still adds to none');
  const bad = r.resolve(target('bad'));
  assert.ok(!ids(bad).includes('a/a2'), 'rejected assets are never sent');
  assert.deepEqual(bad.dropped.map((d) => d.reason).sort(), ['file not found (missing.png)', 'rejected']);

  // The asset itself: dropped on gen; on an edit, other assets of the target are allowed.
  const self = r.resolve(target('a'), { request: { add: ['a/a1'] } });
  assert.ok(!ids(self).includes('a/a1'));
  const input = path.join(root, 'art/generated/a/final/a1.png');
  const editing = r.resolve(target('new'), { request: { add: ['new/new'] }, input: { file: input, id: 'a/a1' }, editing: 'other' });
  assert.equal(editing.input?.n, 1);
  assert.equal(editing.refs[0]!.n, 2, 'references follow the input image');
  assert.ok(ids(editing).includes('new/new'));
  assert.ok(!ids(editing).includes('a/a1'), 'the input image is not sent twice');

  // The provider limit counts the input image.
  const tight = createReferenceResolver(writeProject({ anchors: ['anchor.png'], maxImages: 2 }), loadManifest(manifestPath));
  assert.equal(tight.resolve(target('new'), { input: { file: input } }).refs.length, 1);

  // The same picture under two names is sent once.
  fs.copyFileSync(path.join(root, 'anchor.png'), path.join(root, 'anchor-copy.png'));
  const dup = createReferenceResolver(writeProject({ anchors: ['anchor.png', 'anchor-copy.png'] }), loadManifest(manifestPath));
  assert.deepEqual(ids(dup.resolve(target('new'))).slice(0, 1), ['anchor.png']);
  assert.ok(!ids(dup.resolve(target('new'))).includes('anchor-copy.png'));

  // The prompt names the role of each image, and meta records ids and hashes.
  const block = r.promptBlock(target('new'), r.resolve(target('new'), { request: { add: ['c/c'] } }));
  assert.match(block, /style reference/);
  assert.match(block, /match the proportions and framing of/);
  assert.match(block, /same family as/);
  assert.match(block, /1:1 frame/);
  const records = referenceRecords(plan);
  assert.ok(records.every((x) => /^[0-9a-f]{16}$/.test(x.sha256)));

  fs.rmSync(root, { recursive: true, force: true });
  console.log('references: all checks passed');
}

main().catch((error) => {
  console.error(error);
  console.error(`project left in ${root}`);
  process.exit(1);
});

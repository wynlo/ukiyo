import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ResolvedConfig } from '../config.js';
import { assetNames, type Manifest } from '../manifest.js';
import { rawPath, readMeta, removeOutputs, stagePath, targetDir, writeMeta, type EffectsReview, type ReferenceRecord, type ReviewStatus } from '../meta.js';
import { fileHash } from '../references.js';

export type ReviewChange = { target: string; asset: string; status: ReviewStatus; note?: string; redo?: boolean };
/** A review of a split target's part plan as a whole. */
export type PlanChange = { target: string; status: ReviewStatus; note?: string };
/** A review of the light points of an asset with no split (`AssetMeta.lightReview`). */
export type LightsChange = { target: string; asset: string; status: ReviewStatus; note?: string };
/** A review of an asset's wind and light classification (`AssetMeta.effects`). A changed `wind` or `light` makes it a hand review. */
export type EffectsChange = { target: string; asset: string; status: ReviewStatus; note?: string; wind?: string[] | 'none'; light?: 'art' | 'none' };

/** A light point in px of the image it is drawn on. */
type LightDot = { x: number; y: number; radius: number; piece?: string };
/** The light points of an asset with no split, for the Plans tab. */
type LightCard = { asset: string; url: string; width: number; height: number; lights: LightDot[]; status: ReviewStatus; note?: string };

type PlanPiece = { id: string; url: string; role: string; x: number; y: number; w: number; h: number; joint: { x: number; y: number }; z: number; parent?: string; mode?: string; material?: string; rest?: { kind: string; amount: [number, number]; periodMs?: [number, number] } };
type PlanView = { status: ReviewStatus; note?: string; source: string; score?: number; base: string | null; width: number; height: number; baseIsPlate: boolean; pieces: PlanPiece[]; lights: LightDot[] };

type ReviewAsset = {
  name: string;
  frame: string;
  status: ReviewStatus;
  note?: string;
  width?: number;
  height?: number;
  sourceBox?: { x: number; y: number; width: number; height: number };
  final: string | null;
  cut: string | null;
  anchor?: { x: number; y: number };
  tint?: string;
  /** Layer targets: the base this asset is drawn on. */
  base?: string;
  registration?: { iou: number; scale: number; coverage: number };
  /** The wind and light review, from `ukiyo plan`. */
  effects?: EffectsReview;
  /** The images sent with the call that made this asset, each with a URL for its thumbnail when the file still exists. */
  references?: (ReferenceRecord & { url: string | null; changed: boolean })[];
};

type ReviewTarget = {
  target: string;
  compose: string;
  kind: string;
  game?: string;
  raw: string | null;
  rawSize?: { width: number; height: number };
  warnings: string[];
  prompt?: string;
  tint?: string;
  order?: number;
  assets: ReviewAsset[];
  /** Split targets: the part plan, drawn with its pieces outlined and animated. */
  plan?: PlanView;
  /** Assets with light points and no split: each drawn with its points, for review. */
  lights?: LightCard[];
};

function snapshot(config: ResolvedConfig, manifest: Manifest): ReviewTarget[] {
  return manifest.map((target) => {
    const meta = readMeta(config, target);
    const raw = rawPath(config, target.target);
    const names = assetNames(target);
    return {
      target: target.target,
      compose: target.compose,
      kind: target.kind,
      game: target.game,
      raw: fs.existsSync(raw) ? `/file/${target.target}/raw.png` : null,
      warnings: meta.warnings,
      prompt: meta.prompt,
      tint: target.tint,
      order: target.compose === 'layer' ? target.order : undefined,
      plan: target.compose === 'split' ? planView(config, target, meta) : undefined,
      lights: target.compose === 'split' ? undefined : lightCards(target, names, meta),
      assets: names.map((name) => {
        const asset = meta.assets[name]!;
        const final = stagePath(config, target.target, 'final', name);
        const cut = stagePath(config, target.target, 'cut', name);
        return {
          name,
          frame: target.compose === 'single' || target.compose === 'backdrop' ? target.target : `${target.target}/${name}`,
          status: asset.status,
          note: asset.note,
          width: asset.width,
          height: asset.height,
          sourceBox: asset.sourceBox,
          final: fs.existsSync(final) ? `/file/${target.target}/final/${name}.png` : null,
          cut: fs.existsSync(cut) ? `/file/${target.target}/cut/${name}.png` : null,
          anchor: asset.anchor,
          tint: asset.tint,
          base: target.compose === 'layer' ? (target.layers.find((l) => l.id === name)?.base ?? target.base) : undefined,
          registration: asset.registration,
          effects: asset.effects,
          references: (asset.references ?? meta.references)?.map((r) => {
            const file = path.resolve(config.root, r.path);
            const exists = fs.existsSync(file);
            return { ...r, url: exists ? `/root/${r.path.split(path.sep).map(encodeURIComponent).join('/')}` : null, changed: exists && Boolean(r.sha256) && fileHash(file) !== r.sha256 };
          }),
        };
      }),
    };
  });
}

function lightCards(target: Manifest[number], names: string[], meta: ReturnType<typeof readMeta>): LightCard[] | undefined {
  const cards = names
    .filter((name) => meta.assets[name]?.lights?.length)
    .map((name) => {
      const asset = meta.assets[name]!;
      return {
        asset: name,
        url: `/file/${target.target}/final/${name}.png`,
        width: asset.width ?? 0,
        height: asset.height ?? 0,
        lights: asset.lights!.map((l) => ({ x: l.x, y: l.y, radius: l.radius })),
        status: asset.lightReview?.status ?? 'pending',
        note: asset.lightReview?.note,
      };
    });
  return cards.length ? cards : undefined;
}

export function applyLightsChange(config: ResolvedConfig, manifest: Manifest, change: LightsChange): void {
  const target = manifest.find((t) => t.target === change.target);
  if (!target || target.compose === 'split') throw new Error(`${change.target}: review a split's lights with its plan`);
  const meta = readMeta(config, target);
  const asset = meta.assets[change.asset];
  if (!asset?.lights) throw new Error(`${change.target}/${change.asset} has no light points`);
  asset.lightReview = { status: change.status, note: change.note?.trim() || undefined, reviewedAt: new Date().toISOString() };
  writeMeta(config, meta);
}

export function applyEffectsChange(config: ResolvedConfig, manifest: Manifest, change: EffectsChange): void {
  const target = manifest.find((t) => t.target === change.target);
  if (!target) throw new Error(`${change.target}: no such target`);
  const meta = readMeta(config, target);
  const asset = meta.assets[change.asset];
  if (!asset?.effects) throw new Error(`${change.target}/${change.asset} has no wind and light review; run \`ukiyo plan --score\``);
  const wind = change.wind === undefined ? asset.effects.wind : change.wind === 'none' || change.wind.length === 0 ? 'none' : [...new Set(change.wind.map((m) => m.trim()).filter(Boolean))].sort();
  const light = change.light ?? asset.effects.light;
  const edited = JSON.stringify(wind) !== JSON.stringify(asset.effects.wind) || light !== asset.effects.light;
  asset.effects = { ...asset.effects, wind, light, ...(edited ? { source: 'hand' as const } : {}), status: change.status, note: change.note?.trim() || undefined, reviewedAt: new Date().toISOString() };
  writeMeta(config, meta);
}

function planView(config: ResolvedConfig, target: Extract<Manifest[number], { compose: 'split' }>, meta: ReturnType<typeof readMeta>): PlanView {
  const [baseName, baseAsset] = target.base.split('/') as [string, string];
  const baseFile = stagePath(config, baseName, 'final', baseAsset);
  const pieces: PlanPiece[] = [];
  let width = 0;
  let height = 0;
  for (const name of assetNames(target)) {
    const part = meta.assets[name]?.part;
    const file = stagePath(config, target.target, 'final', name);
    if (!part || !fs.existsSync(file)) continue;
    width = part.baseWidth;
    height = part.baseHeight;
    const piece = target.pieces.find((p) => p.id === name);
    pieces.push({
      id: name,
      url: `/file/${target.target}/final/${name}.png`,
      role: part.role,
      x: part.x,
      y: part.y,
      w: meta.assets[name]?.width ?? 0,
      h: meta.assets[name]?.height ?? 0,
      joint: part.joint,
      z: part.z,
      parent: part.parent,
      mode: part.mode,
      material: piece?.material,
      rest: part.rig?.rest,
    });
  }
  return {
    status: meta.plan?.status ?? 'pending',
    note: meta.plan?.note,
    source: target.plan?.source ?? 'hand',
    score: target.plan?.score,
    base: fs.existsSync(baseFile) ? `/file/${baseName}/final/${baseAsset}.png` : null,
    width,
    height,
    baseIsPlate: !pieces.some((p) => p.role === 'plate'),
    pieces: pieces.sort((a, b) => a.z - b.z),
    lights: (meta.lights ?? []).map((l) => ({ x: l.x, y: l.y, radius: l.radius, piece: l.piece })),
  };
}

export function applyPlanChange(config: ResolvedConfig, manifest: Manifest, change: PlanChange): void {
  const target = manifest.find((t) => t.target === change.target);
  if (!target || target.compose !== 'split') throw new Error(`${change.target} is not a split target`);
  const meta = readMeta(config, target);
  meta.plan = { status: change.status, note: change.note?.trim() || undefined, reviewedAt: new Date().toISOString() };
  writeMeta(config, meta);
}

export function applyChange(config: ResolvedConfig, manifest: Manifest, change: ReviewChange): void {
  const target = manifest.find((t) => t.target === change.target);
  if (!target) throw new Error(`Unknown target ${change.target}`);
  if (change.redo) {
    removeOutputs(config, target, change.asset);
  }
  const meta = readMeta(config, target);
  const asset = meta.assets[change.asset];
  if (!asset) throw new Error(`Unknown asset ${change.asset} in ${change.target}`);
  asset.status = change.redo ? 'rejected' : change.status;
  asset.note = change.note?.trim() || undefined;
  asset.reviewedAt = new Date().toISOString();
  writeMeta(config, meta);
}

const PAGE = (background: string, scale: number, unit: number, projectName: string, tints: Record<string, string[]>) => `<!doctype html>
<meta charset="utf-8">
<title>ukiyo review · ${projectName}</title>
<style>
  :root { --bg: ${background}; --ink: #4A3328; --ok: #7E9B78; --bad: #C9786B; --pending: #C89B6A; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.4 system-ui, sans-serif; color: var(--ink); background: #efe6d3; }
  header { position: sticky; top: 0; background: #fff8ea; border-bottom: 1px solid #d9c9a8; padding: 12px 20px; display: flex; gap: 20px; align-items: center; z-index: 2; }
  header h1 { font-size: 16px; margin: 0; }
  header .counts span { margin-right: 14px; }
  main { padding: 20px; display: grid; gap: 24px; }
  section.target { background: #fff8ea; border: 1px solid #d9c9a8; border-radius: 12px; padding: 16px; }
  section.target h2 { margin: 0 0 4px; font-size: 15px; }
  .muted { color: #8b7a63; }
  .warn { color: var(--bad); }
  .refs { display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-end; margin: 6px 0; font-size: 11px; }
  .refs figure { margin: 0; max-width: 88px; }
  .refs img { display: block; max-width: 64px; max-height: 64px; border: 1px solid #e3d5b8; border-radius: 4px; background: #fff; }
  .refs figcaption { overflow-wrap: anywhere; }
  .assets { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; margin-top: 12px; }
  .asset { border: 1px solid #e3d5b8; border-radius: 10px; padding: 12px; background: var(--bg); min-width: 0; }
  .asset.approved { border-color: var(--ok); box-shadow: inset 0 0 0 2px var(--ok); }
  .asset.rejected { border-color: var(--bad); box-shadow: inset 0 0 0 2px var(--bad); }
  .asset h3 { margin: 0 0 8px; font-size: 13px; display: flex; justify-content: space-between; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; color: #fff; background: var(--pending); }
  .pill.approved { background: var(--ok); } .pill.rejected { background: var(--bad); }
  .scales { display: flex; gap: 16px; align-items: flex-end; min-height: 120px; overflow-x: auto; }
  .scales figure { margin: 0; text-align: center; }
  .scales figcaption { font-size: 11px; color: #8b7a63; }
  .scales img { display: block; image-rendering: auto; }
  .phone { position: relative; width: 120px; height: 200px; border: 3px solid #4A3328; border-radius: 16px; background: var(--bg); overflow: hidden; display: flex; align-items: flex-end; justify-content: center; }
  .phone img { position: relative; }
  .actions { display: flex; gap: 6px; margin-top: 10px; align-items: center; flex-wrap: wrap; }
  button { border: 1px solid #4A3328; background: #fff; color: #4A3328; border-radius: 8px; padding: 4px 10px; cursor: pointer; font: inherit; }
  button.ok { background: var(--ok); color: #fff; border-color: var(--ok); }
  button.bad { background: var(--bad); color: #fff; border-color: var(--bad); }
  input.note { flex: 1; min-width: 120px; border: 1px solid #d9c9a8; border-radius: 8px; padding: 4px 8px; font: inherit; }
  .raw { position: relative; display: inline-block; max-width: 100%; margin-top: 8px; }
  .raw img { max-width: 100%; display: block; }
  .raw .box { position: absolute; border: 2px solid var(--bad); font-size: 10px; color: #fff; background: rgba(201,120,107,.15); }
  .raw .box span { background: var(--bad); padding: 0 4px; }
  details { margin-top: 8px; }
  pre { white-space: pre-wrap; font-size: 11px; background: #fff; padding: 8px; border-radius: 8px; max-height: 240px; overflow: auto; }
  .strip { display: flex; gap: 8px; align-items: flex-end; }
  .strip .play img { display: none; } .strip .play img.on { display: block; }
  nav.tabs { display: flex; gap: 6px; }
  nav.tabs button.on { background: #4A3328; color: #fff; }
  .combos { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
  .combos figure { margin: 0; min-width: 0; background: var(--bg); border: 1px solid #e3d5b8; border-radius: 10px; padding: 8px; text-align: center; }
  .combos canvas { display: block; margin: 0 auto; max-width: 100%; height: auto; }
  .combos figcaption { font-size: 11px; color: #8b7a63; line-height: 1.3; }
</style>
<header>
  <h1>ukiyo review · ${projectName}</h1>
  <div class="counts" id="counts"></div>
  <nav class="tabs"><button id="tab-assets" class="on">Assets</button><button id="tab-plans">Plans</button><button id="tab-effects">Wind &amp; light</button><button id="tab-combos">Combinations</button></nav>
  <span class="muted">Atlas scale ${scale}x, unit ${unit}px. Sizes shown at 1x device (atlas ÷ ${scale}), 2x, and 3x.</span>
</header>
<main id="main"></main>
<script>
const SCALE = ${scale};
const UNIT = ${unit};
const TINTS = ${JSON.stringify(tints)};
let DATA = [];
let TAB = location.hash === '#combos' ? 'combos' : location.hash === '#effects' ? 'effects' : location.hash.startsWith('#plans') ? 'plans' : 'assets';
// '#plans=<target>' shows one plan.
const ONLY = location.hash.startsWith('#plans=') ? decodeURIComponent(location.hash.slice(7)) : null;
function draw() {
  if (TAB === 'combos') renderCombos(DATA);
  else if (TAB === 'effects') renderEffects(DATA);
  else if (TAB === 'plans') render(DATA.filter(t => (t.plan || t.lights) && (!ONLY || t.target === ONLY)), true);
  else render(DATA);
}
async function load() {
  DATA = await (await fetch('/api/state')).json();
  draw();
}
function showTab(tab) {
  TAB = tab;
  for (const name of ['assets', 'plans', 'effects', 'combos']) document.getElementById('tab-' + name).classList.toggle('on', tab === name);
  if (!ONLY) history.replaceState(null, '', tab === 'assets' ? location.pathname : '#' + tab);
  if (DATA) draw();
}
showTab(TAB);
document.getElementById('tab-assets').addEventListener('click', () => showTab('assets'));
document.getElementById('tab-combos').addEventListener('click', () => showTab('combos'));
document.getElementById('tab-plans').addEventListener('click', () => showTab('plans'));
document.getElementById('tab-effects').addEventListener('click', () => showTab('effects'));
/*
 * Wind & light: every sprite the rig rules cover, with what \`ukiyo plan\` proposed.
 * Wind is a list of wind materials or none; light is art (points from the art) or none.
 * Editing either and saving makes it a hand review, which later passes keep.
 */
function renderEffects(data) {
  const rows = data.flatMap(t => t.assets.filter(a => a.effects).map(a => ({ t, a })));
  const c = { approved: 0, rejected: 0, pending: 0 };
  rows.forEach(r => { c[r.a.effects.status] += 1; });
  document.getElementById('counts').replaceChildren(h('span', {}, '✅ ' + c.approved), h('span', {}, '❌ ' + c.rejected), h('span', {}, '⏳ ' + c.pending));
  const main = document.getElementById('main');
  if (!rows.length) { main.replaceChildren(h('p', { class: 'muted' }, 'No wind and light reviews yet. Run ukiyo plan --score.')); return; }
  main.replaceChildren(h('section', { class: 'target' },
    h('h2', {}, 'Wind & light ', h('span', { class: 'muted' }, rows.length + ' sprites · pending first')),
    h('div', { class: 'assets' }, rows.sort((x, y) => (x.a.effects.status === 'pending' ? 0 : 1) - (y.a.effects.status === 'pending' ? 0 : 1)).map(({ t, a }) => effectsCard(t, a)))));
}
function effectsCard(t, a) {
  const e = a.effects;
  const wind = h('input', { class: 'note', value: e.wind === 'none' ? 'none' : e.wind.join(', '), title: 'wind materials, comma separated, or none' });
  const light = h('select', {}, h('option', { value: 'none' }, 'light: none'), h('option', { value: 'art' }, 'light: art'));
  light.value = e.light;
  const note = h('input', { class: 'note', placeholder: 'note', value: e.note || '' });
  const post = (status) => fetch('/api/effects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: t.target, asset: a.name, status, note: note.value, light: light.value, wind: wind.value.trim() === 'none' ? 'none' : wind.value.split(',').map(s => s.trim()).filter(Boolean) }) }).then(load);
  return h('div', { class: 'asset ' + e.status },
    h('h3', {}, h('span', {}, t.target + '/' + a.name), h('span', { class: 'pill ' + e.status }, e.status + (e.source === 'hand' ? ' · hand' : ''))),
    a.final ? h('img', { src: a.final, style: 'max-width:160px;max-height:120px;background:var(--bg);border-radius:8px' }) : null,
    h('p', { class: 'muted' }, e.why),
    e.note ? h('p', { class: 'muted' }, 'note: ' + e.note) : null,
    h('div', { class: 'actions' }, wind, light),
    h('div', { class: 'actions' },
      h('button', { class: 'ok', onclick: () => post('approved') }, 'Approve'),
      h('button', { class: 'bad', onclick: () => post('rejected') }, 'Reject'),
      h('button', { onclick: () => post('pending') }, 'Save'),
      note,
    ),
  );
}

const images = new Map();
function image(src) {
  if (!images.has(src)) images.set(src, new Promise((resolve) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => resolve(null); img.src = src; }));
  return images.get(src);
}
// Multiply tint that keeps the image's alpha, as a game engine does.
function tinted(img, color) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  if (color) {
    g.globalCompositeOperation = 'multiply'; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-in'; g.drawImage(img, 0, 0);
  }
  return c;
}
function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
function tintFor(channel) { return channel && TINTS[channel] ? pick(TINTS[channel]) : null; }

/*
 * Random stacks: each base that layer targets are drawn on, plus one random
 * asset (or nothing) from each layer target, with random tints per channel.
 * Every layer shares the base's scale and pivot, so all are drawn with their
 * pivots on one point.
 */
async function renderCombos(data) {
  const main = document.getElementById('main');
  const byFrame = new Map();
  data.forEach(t => t.assets.forEach(a => byFrame.set(t.target + '/' + a.name, { t, a })));
  const layers = data.filter(t => t.compose === 'layer');
  const bases = [...new Set(layers.flatMap(t => t.assets.map(a => a.base)))].filter(b => byFrame.has(b));
  const again = h('button', { onclick: () => renderCombos(DATA) }, 'Reroll');
  const blocks = [];
  if (bases.length === 0) blocks.push(h('p', { class: 'muted' }, 'No layer targets with a finalised base yet.'));
  for (const baseRef of bases) {
    const base = byFrame.get(baseRef);
    const families = layers.filter(t => t.assets.some(a => a.base === baseRef));
    const grid = h('div', { class: 'combos' });
    blocks.push(h('section', { class: 'target' }, h('h2', {}, baseRef, ' ', h('span', { class: 'muted' }, families.map(f => f.target).join(' + '))), grid));
    for (let n = 0; n < 12; n += 1) {
      // Layers on the same channel as the base (ears on fur) share its colour.
      const baseChannel = base.a.tint || base.t.tint;
      const colors = {};
      if (baseChannel) colors[baseChannel] = tintFor(baseChannel);
      const stack = [{ asset: base.a, color: baseChannel ? colors[baseChannel] : null, order: 0, label: base.a.name }];
      for (const f of families) {
        const options = f.assets.filter(a => a.base === baseRef && a.final);
        if (options.length === 0 || Math.random() < 1 / (options.length + 1)) continue;
        const a = pick(options);
        const channel = a.tint || f.tint;
        colors[channel] ??= tintFor(channel);
        stack.push({ asset: a, color: colors[channel], order: f.order || 0, label: a.name });
      }
      stack.sort((x, y) => x.order - y.order);
      grid.append(await comboFigure(stack));
    }
  }
  main.replaceChildren(h('div', {}, again), ...blocks);
}
async function comboFigure(stack) {
  const zoom = 2 / SCALE;
  const loaded = await Promise.all(stack.map(s => image(s.asset.final || s.asset.cut)));
  // Extents around the shared pivot.
  let left = 0, right = 0, top = 0, bottom = 0;
  stack.forEach((s, i) => {
    const img = loaded[i]; if (!img) return;
    const an = s.asset.anchor || { x: 0.5, y: 1 };
    left = Math.max(left, an.x * img.naturalWidth); right = Math.max(right, (1 - an.x) * img.naturalWidth);
    top = Math.max(top, an.y * img.naturalHeight); bottom = Math.max(bottom, (1 - an.y) * img.naturalHeight);
  });
  const c = document.createElement('canvas');
  c.width = Math.ceil((left + right) * zoom) + 8; c.height = Math.ceil((top + bottom) * zoom) + 8;
  const g = c.getContext('2d');
  stack.forEach((s, i) => {
    const img = loaded[i]; if (!img) return;
    const an = s.asset.anchor || { x: 0.5, y: 1 };
    g.drawImage(tinted(img, s.color), 4 + (left - an.x * img.naturalWidth) * zoom, 4 + (top - an.y * img.naturalHeight) * zoom, img.naturalWidth * zoom, img.naturalHeight * zoom);
  });
  return h('figure', {}, c, h('figcaption', {}, stack.map(s => s.label + (s.color ? ' ' + s.color : '')).join(' · ')));
}
function counts(data) {
  const c = { approved: 0, rejected: 0, pending: 0 };
  data.forEach(t => t.assets.forEach(a => c[a.status]++));
  return c;
}
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function sizedImg(src, w, h0, factor) {
  return h('img', { src, width: Math.max(1, Math.round(w / SCALE * factor)), height: Math.max(1, Math.round(h0 / SCALE * factor)) });
}
async function post(change) {
  await fetch('/api/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) });
  await load();
}
function assetCard(t, a) {
  const note = h('input', { class: 'note', placeholder: 'note (why, or what to change)', value: a.note || '' });
  let src = a.final || a.cut;
  const w = a.width || 64, hh = a.height || 64;
  const channel = a.tint || t.tint;
  const sample = a.final && channel && TINTS[channel] ? TINTS[channel][0] : null;
  const preview = src ? h('div', { class: 'scales' },
    h('figure', {}, h('div', { class: 'phone' }, sizedImg(src, w, hh, 1)), h('figcaption', {}, '1x in a 375px phone (÷3.1)')),
    h('figure', {}, sizedImg(src, w, hh, 1), h('figcaption', {}, '1x · ' + Math.round(w / SCALE) + '×' + Math.round(hh / SCALE) + ' css px')),
    h('figure', {}, sizedImg(src, w, hh, 2), h('figcaption', {}, '2x')),
    h('figure', {}, sizedImg(src, w, hh, 3), h('figcaption', {}, '3x')),
    sample ? tintPreview(src, w, hh, channel) : null,
  ) : h('p', { class: 'muted' }, 'not cut yet');
  return h('div', { class: 'asset ' + a.status },
    h('h3', {}, h('span', {}, a.frame), h('span', { class: 'pill ' + a.status }, a.status)),
    preview,
    a.registration ? h('p', { class: a.registration.iou < 0.8 ? 'warn' : 'muted' }, 'registered to ' + a.base + ': overlap ' + a.registration.iou + ', scale ' + a.registration.scale + ', covers ' + Math.round(a.registration.coverage * 100) + '% of base') : null,
    a.note ? h('p', { class: 'muted' }, 'note: ' + a.note) : null,
    a.references && a.references.length ? h('div', { class: 'refs' },
      h('span', { class: 'muted' }, 'references:'),
      ...a.references.map((r) => h('figure', { title: (r.id || r.path) + ' · ' + r.source + (r.status ? ' · ' + r.status : '') + ' · sha256 ' + r.sha256 + (r.changed ? ' · file changed since' : '') },
        r.url ? h('img', { src: r.url, loading: 'lazy' }) : null,
        h('figcaption', { class: r.changed ? 'warn' : 'muted' }, r.n + '. ' + r.role + ' · ' + (r.id || r.path.split('/').pop())))),
    ) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'ok', onclick: () => post({ target: t.target, asset: a.name, status: 'approved', note: note.value }) }, 'Approve'),
      h('button', { class: 'bad', onclick: () => post({ target: t.target, asset: a.name, status: 'rejected', note: note.value }) }, 'Reject'),
      h('button', { onclick: () => post({ target: t.target, asset: a.name, status: 'rejected', note: note.value, redo: true }) }, 'Redo'),
      h('button', { onclick: () => post({ target: t.target, asset: a.name, status: 'pending', note: note.value }) }, 'Reset'),
      note,
    ),
  );
}
function tintPreview(src, w, hh, channel) {
  const row = h('div', { style: 'display:flex;gap:4px;align-items:flex-end;flex-wrap:wrap;max-width:220px' });
  const fig = h('figure', {}, row, h('figcaption', {}, 'tint: ' + channel));
  image(src).then(img => {
    if (!img) return;
    for (const color of TINTS[channel].slice(0, 4)) {
      const c = tinted(img, color);
      c.style.width = Math.round(w / SCALE) + 'px'; c.style.height = Math.round(hh / SCALE) + 'px';
      row.append(c);
    }
  });
  return fig;
}
function stripPlayer(t) {
  if (t.compose !== 'strip') return null;
  const frames = t.assets.filter(a => a.final || a.cut);
  if (frames.length < 2) return null;
  const imgs = frames.map((a, i) => h('img', { src: a.final || a.cut, width: Math.round((a.width || 64) / SCALE * 2), class: i === 0 ? 'on' : '' }));
  const play = h('div', { class: 'play' }, imgs);
  let i = 0;
  setInterval(() => { i = (i + 1) % imgs.length; imgs.forEach((img, j) => img.classList.toggle('on', j === i)); }, 1000 / 6);
  return h('div', { class: 'strip' }, h('span', { class: 'muted' }, 'strip at 6 fps, 2x:'), play);
}
function rawView(t) {
  if (!t.raw) return h('p', { class: 'muted' }, 'no raw.png yet');
  const img = h('img', { src: t.raw });
  const wrap = h('div', { class: 'raw' }, img);
  img.addEventListener('load', () => {
    const sx = img.clientWidth / img.naturalWidth, sy = img.clientHeight / img.naturalHeight;
    t.assets.forEach(a => {
      if (!a.sourceBox) return;
      const b = a.sourceBox;
      wrap.append(h('div', { class: 'box', style: 'left:' + (b.x * sx) + 'px;top:' + (b.y * sy) + 'px;width:' + (b.width * sx) + 'px;height:' + (b.height * sy) + 'px' }, h('span', {}, a.name)));
    });
  });
  return h('details', {}, h('summary', {}, 'raw.png with detected boxes'), wrap);
}
/*
 * A part plan: the base with each piece outlined in its own colour and its
 * joint marked, next to a live preview that swings, flutters, glows and spins
 * the pieces about their joints with their rest motion.
 */
const PLAN_COLORS = ['#d9412e', '#2f7fd6', '#2e9e57', '#c77a12', '#8a4fd1', '#1c9aa6', '#c2408f', '#6b8a1e'];
function planCard(t) {
  const plan = t.plan;
  plan.lights.forEach((l, i) => { l.n = i + 1; });
  const note = h('input', { class: 'note', placeholder: 'note (why, or what to change)', value: plan.note || '' });
  const zoom = Math.min(2, 360 / Math.max(1, plan.width));
  const W = Math.round(plan.width * zoom), H = Math.round(plan.height * zoom);
  const outline = h('canvas', { width: W, height: H, style: 'background:var(--bg);border-radius:8px' });
  const live = h('canvas', { width: W, height: H, style: 'background:var(--bg);border-radius:8px' });
  const legend = h('div', { class: 'muted', style: 'font-size:12px' });
  Promise.all([plan.base ? image(plan.base) : null, ...plan.pieces.map(p => image(p.url))]).then(([base, ...imgs]) => {
    const g = outline.getContext('2d');
    if (base) { g.globalAlpha = 0.45; g.drawImage(base, 0, 0, W, H); g.globalAlpha = 1; }
    const moving = plan.pieces.map((p, i) => ({ p, img: imgs[i] })).filter(e => e.p.role === 'piece');
    moving.forEach(({ p, img }, i) => {
      if (!img) return;
      const color = PLAN_COLORS[i % PLAN_COLORS.length];
      // The piece's own silhouette, filled in its colour: its mask.
      const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
      const cg = c.getContext('2d'); cg.drawImage(img, 0, 0); cg.globalCompositeOperation = 'source-in'; cg.fillStyle = color; cg.fillRect(0, 0, c.width, c.height);
      g.globalAlpha = 0.55; g.drawImage(c, p.x * zoom, p.y * zoom, p.w * zoom, p.h * zoom); g.globalAlpha = 1;
      const jx = (p.x + p.joint.x) * zoom, jy = (p.y + p.joint.y) * zoom;
      g.fillStyle = '#fff'; g.beginPath(); g.arc(jx, jy, 5, 0, Math.PI * 2); g.fill();
      g.fillStyle = color; g.beginPath(); g.arc(jx, jy, 3.5, 0, Math.PI * 2); g.fill();
      legend.append(h('span', { style: 'color:' + color + ';margin-right:10px' }, '● ' + p.id + ' · ' + (p.material || 'still') + ' · ' + (p.mode || '') + (p.parent ? ' · on ' + p.parent : '') + (p.rest ? ' · ' + p.rest.kind + ' ' + p.rest.amount.join('–') : '')));
    });
    // Light points (docs: "Lights" in the manifest reference): one per lit region, numbered.
    drawLights(g, plan.lights, zoom);
    if (plan.lights.length) legend.append(h('span', { style: 'color:#b88a00;margin-right:10px' }, '✦ ' + plan.lights.length + ' light' + (plan.lights.length === 1 ? '' : 's') + ': ' + plan.lights.map((l, i) => (i + 1) + (l.piece ? ' on ' + l.piece : '')).join(', ')));
    animatePlan(live, plan, base, imgs, zoom);
  });
  return h('div', { class: 'asset ' + plan.status, style: 'grid-column:1/-1' },
    h('h3', {}, h('span', {}, 'part plan · ' + plan.source + (plan.score != null ? ' · complexity ' + plan.score.toFixed(2) : '')), h('span', { class: 'pill ' + plan.status }, plan.status)),
    h('div', { style: 'display:flex;gap:12px;flex-wrap:wrap' }, h('figure', { style: 'margin:0' }, outline, h('figcaption', { class: 'muted' }, 'pieces, joints and lights')), h('figure', { style: 'margin:0' }, live, h('figcaption', { class: 'muted' }, 'live, rest motion, lights follow their piece'))),
    legend,
    plan.note ? h('p', { class: 'muted' }, 'note: ' + plan.note) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'ok', onclick: () => postPlan({ target: t.target, status: 'approved', note: note.value }) }, 'Approve plan'),
      h('button', { class: 'bad', onclick: () => postPlan({ target: t.target, status: 'rejected', note: note.value }) }, 'Reject plan'),
      h('button', { onclick: () => postPlan({ target: t.target, status: 'pending', note: note.value }) }, 'Reset'),
      note,
    ),
  );
}
/* A light point: a ring at the lit region's size, a dot at its centre and its number. */
function drawLights(g, lights, zoom, transformFor) {
  lights.forEach((l, i) => {
    g.save();
    if (transformFor) transformFor(l);
    const x = l.x * zoom, y = l.y * zoom;
    g.strokeStyle = '#ffd400'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, Math.max(3, l.radius * zoom), 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#1a1a1a'; g.beginPath(); g.arc(x, y, 3.5, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#ffd400'; g.beginPath(); g.arc(x, y, 2.2, 0, Math.PI * 2); g.fill();
    g.font = 'bold 11px system-ui'; g.fillStyle = '#1a1a1a'; g.fillText(String(l.n ?? i + 1), x + 5, y - 5);
    g.restore();
  });
}
/* The light points of an asset with no split, drawn on its final PNG, with their own review. */
function lightCard(t, card) {
  const note = h('input', { class: 'note', placeholder: 'note (why, or what to change)', value: card.note || '' });
  const zoom = Math.min(2, 360 / Math.max(1, card.width));
  const canvas = h('canvas', { width: Math.round(card.width * zoom), height: Math.round(card.height * zoom), style: 'background:var(--bg);border-radius:8px' });
  image(card.url).then((img) => { const g = canvas.getContext('2d'); if (img) g.drawImage(img, 0, 0, canvas.width, canvas.height); drawLights(g, card.lights, zoom); });
  const post = (status) => fetch('/api/lights', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: t.target, asset: card.asset, status, note: note.value }) }).then(load);
  return h('div', { class: 'asset ' + card.status },
    h('h3', {}, h('span', {}, 'lights · ' + card.asset + ' · ' + card.lights.length), h('span', { class: 'pill ' + card.status }, card.status)),
    canvas,
    card.note ? h('p', { class: 'muted' }, 'note: ' + card.note) : null,
    h('div', { class: 'actions' },
      h('button', { class: 'ok', onclick: () => post('approved') }, 'Approve lights'),
      h('button', { class: 'bad', onclick: () => post('rejected') }, 'Reject lights'),
      note,
    ),
  );
}
async function postPlan(change) {
  await fetch('/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) });
  await load();
}
function seededUnit(text) { let h0 = 2166136261; for (let i = 0; i < text.length; i++) { h0 ^= text.charCodeAt(i); h0 = Math.imul(h0, 16777619); } return ((h0 >>> 0) % 10000) / 10000; }
function animatePlan(canvas, plan, base, imgs, zoom) {
  const g = canvas.getContext('2d');
  const byId = new Map(plan.pieces.map((p, i) => [p.id, { p, img: imgs[i] }]));
  const angleOf = (p, t) => {
    if (!p.rest) return 0;
    const a = (p.rest.amount[0] + p.rest.amount[1]) / 2, per = p.rest.periodMs ? (p.rest.periodMs[0] + p.rest.periodMs[1]) / 2 : 3000, ph = seededUnit(p.id) * Math.PI * 2;
    if (p.rest.kind === 'spin') return (t / 1000) * a;
    if (p.rest.kind === 'swing' || p.rest.kind === 'sway') return a * Math.sin((t / per) * Math.PI * 2 + ph);
    if (p.rest.kind === 'flutter') return a * (0.7 * Math.sin((t / per) * Math.PI * 2 + ph) + 0.3 * Math.sin((t / (per / 2.7)) * Math.PI * 2 + ph * 2));
    return 0;
  };
  function place(p, t) {
    // The parent's turn first, then this piece's own turn about its joint.
    const chain = []; let at = p; while (at) { chain.unshift(at); at = at.parent ? byId.get(at.parent)?.p : null; }
    chain.forEach(q => { const jx = (q.x + q.joint.x) * zoom, jy = (q.y + q.joint.y) * zoom; g.translate(jx, jy); g.rotate(angleOf(q, t) * Math.PI / 180); g.translate(-jx, -jy); });
  }
  function frame(t) {
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (plan.baseIsPlate && base) g.drawImage(base, 0, 0, canvas.width, canvas.height);
    plan.pieces.forEach((p, i) => {
      const img = imgs[i]; if (!img) return;
      g.save();
      if (p.role === 'piece') place(p, t);
      if (p.rest && (p.rest.kind === 'glow' || p.rest.kind === 'shimmer')) {
        g.drawImage(img, p.x * zoom, p.y * zoom, p.w * zoom, p.h * zoom);
        g.globalCompositeOperation = 'lighter'; g.globalAlpha = ((p.rest.amount[0] + p.rest.amount[1]) / 2) * (0.5 + 0.5 * Math.sin(t / 400 + seededUnit(p.id) * 6));
      }
      let sy = 1;
      if (p.rest && (p.rest.kind === 'flicker' || p.rest.kind === 'stretch')) sy = 1 + ((p.rest.amount[0] + p.rest.amount[1]) / 2) * (0.5 + 0.5 * Math.sin(t / 160 + seededUnit(p.id) * 6));
      const jy = (p.y + p.joint.y) * zoom;
      g.translate(0, jy); g.scale(1, sy); g.translate(0, -jy);
      g.drawImage(img, p.x * zoom, p.y * zoom, p.w * zoom, p.h * zoom);
      g.restore();
      g.save();
      if (p.role === 'piece') place(p, t);
      drawLights(g, plan.lights.filter((l) => l.piece === p.id), zoom);
      g.restore();
    });
    drawLights(g, plan.lights.filter((l) => !l.piece), zoom);
    if (canvas.isConnected) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
function render(data, plansOnly) {
  const c = counts(data);
  document.getElementById('counts').replaceChildren(
    h('span', {}, '✅ ' + c.approved), h('span', {}, '❌ ' + c.rejected), h('span', {}, '⏳ ' + c.pending));
  const main = document.getElementById('main');
  main.replaceChildren(...data.map(t => h('section', { class: 'target' },
    h('h2', {}, t.target, ' ', h('span', { class: 'muted' }, t.compose + ' · ' + t.kind + (t.game ? ' · ' + t.game : ''))),
    t.warnings.length ? h('div', { class: 'warn' }, t.warnings.join(' ')) : null,
    stripPlayer(t),
    t.plan ? planCard(t) : null,
    plansOnly && t.lights ? h('div', { class: 'assets' }, t.lights.map(card => lightCard(t, card))) : null,
    plansOnly ? null : h('div', { class: 'assets' }, t.assets.map(a => assetCard(t, a))),
    plansOnly ? null : rawView(t),
    t.prompt ? h('details', {}, h('summary', {}, 'prompt'), h('pre', {}, t.prompt)) : null,
  )));
}
load();
</script>
`;

export function startReviewServer(config: ResolvedConfig, manifest: Manifest, port: number, onChange?: (change: ReviewChange) => void): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE(config.styleGuide.canvas.backgroundColor, config.atlas.scale, config.atlas.unit, config.project.name, config.tints));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snapshot(config, manifest)));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/plan') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          applyPlanChange(config, manifest, JSON.parse(body) as PlanChange);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/effects') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          applyEffectsChange(config, manifest, JSON.parse(body) as EffectsChange);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/lights') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          applyLightsChange(config, manifest, JSON.parse(body) as LightsChange);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/status') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const change = JSON.parse(body) as ReviewChange;
          applyChange(config, manifest, change);
          onChange?.(change);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
      });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/root/')) {
      // Reference thumbnails: image files inside the project only.
      const rel = decodeURIComponent(url.pathname.slice('/root/'.length));
      const file = path.resolve(config.root, rel);
      if (!file.startsWith(config.root + path.sep) || !/\.(png|jpe?g|webp)$/i.test(file) || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/file/')) {
      const rel = decodeURIComponent(url.pathname.slice('/file/'.length));
      const file = path.resolve(config.outDir, rel);
      if (!file.startsWith(config.outDir) || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

export { targetDir };

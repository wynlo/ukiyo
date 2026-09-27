import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ResolvedConfig } from '../config.js';
import { assetNames, type Manifest } from '../manifest.js';
import { rawPath, readMeta, removeOutputs, stagePath, targetDir, writeMeta, type ReviewStatus } from '../meta.js';

export type ReviewChange = { target: string; asset: string; status: ReviewStatus; note?: string; redo?: boolean };

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
        };
      }),
    };
  });
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
  <nav class="tabs"><button id="tab-assets" class="on">Assets</button><button id="tab-combos">Combinations</button></nav>
  <span class="muted">Atlas scale ${scale}x, unit ${unit}px. Sizes shown at 1x device (atlas ÷ ${scale}), 2x, and 3x.</span>
</header>
<main id="main"></main>
<script>
const SCALE = ${scale};
const UNIT = ${unit};
const TINTS = ${JSON.stringify(tints)};
let DATA = [];
let TAB = location.hash === '#combos' ? 'combos' : 'assets';
async function load() {
  DATA = await (await fetch('/api/state')).json();
  TAB === 'combos' ? renderCombos(DATA) : render(DATA);
}
function showTab(tab) {
  TAB = tab;
  document.getElementById('tab-assets').classList.toggle('on', tab === 'assets');
  document.getElementById('tab-combos').classList.toggle('on', tab === 'combos');
  history.replaceState(null, '', tab === 'combos' ? '#combos' : location.pathname);
  if (DATA) tab === 'combos' ? renderCombos(DATA) : render(DATA);
}
showTab(TAB);
document.getElementById('tab-assets').addEventListener('click', () => showTab('assets'));
document.getElementById('tab-combos').addEventListener('click', () => showTab('combos'));

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
function render(data) {
  const c = counts(data);
  document.getElementById('counts').replaceChildren(
    h('span', {}, '✅ ' + c.approved), h('span', {}, '❌ ' + c.rejected), h('span', {}, '⏳ ' + c.pending));
  const main = document.getElementById('main');
  main.replaceChildren(...data.map(t => h('section', { class: 'target' },
    h('h2', {}, t.target, ' ', h('span', { class: 'muted' }, t.compose + ' · ' + t.kind + (t.game ? ' · ' + t.game : ''))),
    t.warnings.length ? h('div', { class: 'warn' }, t.warnings.join(' ')) : null,
    stripPlayer(t),
    h('div', { class: 'assets' }, t.assets.map(a => assetCard(t, a))),
    rawView(t),
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

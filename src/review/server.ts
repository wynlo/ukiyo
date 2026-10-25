import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ResolvedConfig } from '../config.js';
import { assetNames, loadManifest, slugify, type Manifest } from '../manifest.js';
import { rawPath, readMeta, removeOutputs, stagePath, targetDir, writeMeta, type EffectsReview, type ReferenceRecord, type ReviewStatus } from '../meta.js';
import { fileHash } from '../references.js';

export type ReviewChange = { target: string; asset: string; status: ReviewStatus; note?: string; redo?: boolean };
/** A review of a split target's part plan as a whole. */
export type PlanChange = { target: string; status: ReviewStatus; note?: string };
/** A review of the light points of an asset with no split (`AssetMeta.lightReview`). */
export type LightsChange = { target: string; asset: string; status: ReviewStatus; note?: string };
/** A review of an asset's wind and light classification (`AssetMeta.effects`). A changed `wind` or `light` makes it a hand review. */
export type EffectsChange = { target: string; asset: string; status: ReviewStatus; note?: string; wind?: string[] | 'none'; light?: 'art' | 'none' };

/** One ukiyo project on the review page. */
export type ReviewProject = { config: ResolvedConfig; manifest: Manifest };

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
  /** The newest of the final PNG, the cut PNG and the target's last generation. */
  updatedAt?: string;
  reviewedAt?: string;
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
  project: string;
  target: string;
  /** The atlas group (`game`), or an empty string. */
  group: string;
  compose: string;
  kind: string;
  generatedAt?: string;
  raw: string | null;
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

type ProjectInfo = { id: string; name: string; root: string; background: string; scale: number; unit: number; tints: Record<string, string[]>; error?: string };

type Served = ReviewProject & { id: string; error?: string };

function mtime(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function snapshot(project: Served): ReviewTarget[] {
  const { config, manifest } = project;
  const prefix = `/p/${project.id}`;
  return manifest.map((target) => {
    const meta = readMeta(config, target);
    const raw = rawPath(config, target.target);
    const names = assetNames(target);
    const generated = meta.generatedAt ? Date.parse(meta.generatedAt) || 0 : 0;
    return {
      project: project.id,
      target: target.target,
      group: target.game ?? '',
      compose: target.compose,
      kind: target.kind,
      generatedAt: meta.generatedAt,
      raw: fs.existsSync(raw) ? `${prefix}/file/${target.target}/raw.png` : null,
      warnings: meta.warnings,
      prompt: meta.prompt,
      tint: target.tint,
      order: target.compose === 'layer' ? target.order : undefined,
      plan: target.compose === 'split' ? planView(config, target, meta, prefix) : undefined,
      lights: target.compose === 'split' ? undefined : lightCards(target, names, meta, prefix),
      assets: names.map((name) => {
        const asset = meta.assets[name]!;
        const final = stagePath(config, target.target, 'final', name);
        const cut = stagePath(config, target.target, 'cut', name);
        const updated = Math.max(mtime(final), mtime(cut), generated);
        return {
          name,
          frame: target.compose === 'single' || target.compose === 'backdrop' ? target.target : `${target.target}/${name}`,
          status: asset.status,
          note: asset.note,
          updatedAt: updated ? new Date(updated).toISOString() : undefined,
          reviewedAt: asset.reviewedAt,
          width: asset.width,
          height: asset.height,
          sourceBox: asset.sourceBox,
          final: fs.existsSync(final) ? `${prefix}/file/${target.target}/final/${name}.png` : null,
          cut: fs.existsSync(cut) ? `${prefix}/file/${target.target}/cut/${name}.png` : null,
          anchor: asset.anchor,
          tint: asset.tint,
          base: target.compose === 'layer' ? (target.layers.find((l) => l.id === name)?.base ?? target.base) : undefined,
          registration: asset.registration,
          effects: asset.effects,
          references: (asset.references ?? meta.references)?.map((r) => {
            const file = path.resolve(config.root, r.path);
            const exists = fs.existsSync(file);
            return { ...r, url: exists ? `${prefix}/root/${r.path.split(path.sep).map(encodeURIComponent).join('/')}` : null, changed: exists && Boolean(r.sha256) && fileHash(file) !== r.sha256 };
          }),
        };
      }),
    };
  });
}

function lightCards(target: Manifest[number], names: string[], meta: ReturnType<typeof readMeta>, prefix: string): LightCard[] | undefined {
  const cards = names
    .filter((name) => meta.assets[name]?.lights?.length)
    .map((name) => {
      const asset = meta.assets[name]!;
      return {
        asset: name,
        url: `${prefix}/file/${target.target}/final/${name}.png`,
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

function planView(config: ResolvedConfig, target: Extract<Manifest[number], { compose: 'split' }>, meta: ReturnType<typeof readMeta>, prefix: string): PlanView {
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
      url: `${prefix}/file/${target.target}/final/${name}.png`,
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
    base: fs.existsSync(baseFile) ? `${prefix}/file/${baseName}/final/${baseAsset}.png` : null,
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

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>ukiyo review</title>
<style>
  :root { --paper: #fff8ea; --page: #efe6d3; --line: #d9c9a8; --line2: #e3d5b8; --hover: #f3e8d2; --ink: #4A3328; --muted: #8b7a63; --ok: #7E9B78; --bad: #C9786B; --pending: #C89B6A; --sel: #2f7fd6; --thumb: 160px; --bg: #fff; }
  * { box-sizing: border-box; }
  body { margin: 0; height: 100vh; font: 13px/1.4 system-ui, sans-serif; color: var(--ink); background: var(--page); display: grid; grid-template-columns: 250px minmax(0, 1fr) 0; grid-template-rows: auto minmax(0, 1fr); }
  body.drawer { grid-template-columns: 250px minmax(0, 1fr) min(560px, 45vw); }
  header { grid-column: 1 / -1; display: flex; gap: 16px; align-items: center; padding: 8px 16px; background: var(--paper); border-bottom: 1px solid var(--line); }
  header h1 { font-size: 15px; margin: 0; white-space: nowrap; }
  input.search { flex: 1; max-width: 360px; margin-left: auto; border: 1px solid var(--line); border-radius: 8px; padding: 5px 10px; font: inherit; background: #fff; }
  nav.tabs { display: flex; gap: 4px; }
  button { border: 1px solid var(--ink); background: #fff; color: var(--ink); border-radius: 7px; padding: 3px 10px; cursor: pointer; font: inherit; }
  button.on { background: var(--ink); color: #fff; }
  button.ok { background: var(--ok); color: #fff; border-color: var(--ok); }
  button.bad { background: var(--bad); color: #fff; border-color: var(--bad); }
  button.link { border: 0; background: none; padding: 0; text-decoration: underline; }
  select { font: inherit; border: 1px solid var(--line); border-radius: 7px; padding: 3px 6px; background: #fff; color: var(--ink); }
  #side { overflow: auto; border-right: 1px solid var(--line); background: var(--paper); padding: 6px 8px 24px; }
  #side h4 { margin: 14px 8px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .row { display: flex; align-items: center; gap: 6px; padding: 3px 8px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
  .row:hover { background: var(--hover); }
  .row.on { background: var(--ink); color: #fff; }
  .row.on .n, .row.on .age { color: #fff; }
  .row .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .row.l1 { padding-left: 20px; } .row.l2 { padding-left: 34px; }
  .row.proj { font-weight: 600; }
  .n { font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .n.p { color: var(--pending); font-weight: 700; }
  .age { font-size: 11px; color: var(--muted); width: 34px; text-align: right; }
  #main { overflow: auto; padding: 12px 16px 60px; }
  #detail { overflow: auto; border-left: 1px solid var(--line); background: var(--paper); padding: 14px 16px 40px; display: none; }
  body.drawer #detail { display: block; }
  #detail h2 { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
  .dhead { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
  .toolbar { display: flex; gap: 12px; align-items: center; margin-bottom: 4px; flex-wrap: wrap; }
  .toolbar label { display: flex; gap: 6px; align-items: center; color: var(--muted); }
  .day { margin: 18px 0 8px; font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .day .n { font-weight: 400; text-transform: none; letter-spacing: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(var(--thumb), 1fr)); gap: 10px; }
  .card { background: var(--paper); border: 1px solid var(--line2); border-radius: 10px; overflow: hidden; cursor: pointer; position: relative; display: flex; flex-direction: column; min-width: 0; }
  .card:hover { border-color: var(--line); }
  .card.cur { outline: 2px solid var(--sel); outline-offset: 1px; }
  .card .thumb { height: var(--thumb); display: flex; align-items: center; justify-content: center; padding: 8px; }
  .card .thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .card .meta { padding: 6px 8px; border-top: 1px solid var(--line2); display: flex; gap: 6px; align-items: center; min-width: 0; }
  .card .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 12px; }
  .card .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--muted); }
  .card .quick { position: absolute; top: 6px; right: 6px; display: none; gap: 4px; }
  .card:hover .quick, .card.cur .quick { display: flex; }
  .card .quick button { padding: 1px 8px; }
  .card.approved .thumb { opacity: .75; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--pending); flex: none; }
  .dot.approved { background: var(--ok); } .dot.rejected { background: var(--bad); }
  .muted { color: var(--muted); }
  .warn { color: var(--bad); }
  .empty { padding: 40px 0; text-align: center; color: var(--muted); }
  .theader { display: flex; gap: 8px; align-items: baseline; margin: 18px 0 8px; }
  .theader h3 { margin: 0; font-size: 13px; }
  .keys { margin-top: 16px; font-size: 11px; }
  kbd { font: 11px ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 0 4px; background: #fff; }
  #toast { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--bad); color: #fff; padding: 8px 14px; border-radius: 8px; display: none; z-index: 9; }
  .refs { display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-end; margin: 6px 0; font-size: 11px; }
  .refs figure { margin: 0; max-width: 88px; }
  .refs img { display: block; max-width: 64px; max-height: 64px; border: 1px solid var(--line2); border-radius: 4px; background: #fff; }
  .refs figcaption { overflow-wrap: anywhere; }
  section.target { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  section.target h2 { margin: 0 0 4px; font-size: 15px; }
  .assets { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; margin-top: 12px; }
  .asset { border: 1px solid var(--line2); border-radius: 10px; padding: 12px; background: var(--bg); min-width: 0; }
  .asset.approved { border-color: var(--ok); box-shadow: inset 0 0 0 2px var(--ok); }
  .asset.rejected { border-color: var(--bad); box-shadow: inset 0 0 0 2px var(--bad); }
  .asset h3 { margin: 0 0 8px; font-size: 13px; display: flex; justify-content: space-between; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; color: #fff; background: var(--pending); }
  .pill.approved { background: var(--ok); } .pill.rejected { background: var(--bad); }
  .scales { display: flex; gap: 16px; align-items: flex-end; min-height: 120px; overflow-x: auto; padding: 10px; margin: 10px 0; border-radius: 10px; background: var(--bg); }
  .scales figure { margin: 0; text-align: center; }
  .scales figcaption { font-size: 11px; color: var(--muted); }
  .scales img { display: block; }
  .phone { position: relative; width: 120px; height: 200px; border: 3px solid var(--ink); border-radius: 16px; background: var(--bg); overflow: hidden; display: flex; align-items: flex-end; justify-content: center; }
  .actions { display: flex; gap: 6px; margin-top: 10px; align-items: center; flex-wrap: wrap; }
  input.note { flex: 1; min-width: 120px; border: 1px solid var(--line); border-radius: 8px; padding: 4px 8px; font: inherit; }
  .raw { position: relative; display: inline-block; max-width: 100%; margin-top: 8px; }
  .raw img { max-width: 100%; display: block; }
  .raw .box { position: absolute; border: 2px solid var(--bad); font-size: 10px; color: #fff; background: rgba(201,120,107,.15); }
  .raw .box span { background: var(--bad); padding: 0 4px; }
  details { margin-top: 10px; }
  summary { cursor: pointer; }
  pre { white-space: pre-wrap; font-size: 11px; background: #fff; padding: 8px; border-radius: 8px; max-height: 240px; overflow: auto; }
  .strip { display: flex; gap: 8px; align-items: flex-end; margin-top: 10px; }
  .strip .play img { display: none; } .strip .play img.on { display: block; }
  .combos { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
  .combos figure { margin: 0; min-width: 0; background: var(--bg); border: 1px solid var(--line2); border-radius: 10px; padding: 8px; text-align: center; }
  .combos canvas { display: block; margin: 0 auto; max-width: 100%; height: auto; }
  .combos figcaption { font-size: 11px; color: var(--muted); line-height: 1.3; }
</style>
<header>
  <h1 id="title">ukiyo review</h1>
  <nav class="tabs"><button data-tab="assets">Assets</button><button data-tab="plans">Plans</button><button data-tab="effects">Wind &amp; light</button><button data-tab="combos">Combinations</button></nav>
  <input id="q" class="search" type="search" placeholder="Search targets, assets, groups   ( / )">
</header>
<aside id="side"></aside>
<main id="main"></main>
<aside id="detail"></aside>
<div id="toast"></div>
<script>
let DATA = { projects: [], targets: [] };
const PROJ = new Map();
const DEFAULTS = { tab: 'assets', project: '', family: '', group: '', status: 'pending', sort: 'new', q: '', thumb: '160' };
const S = { ...DEFAULTS };
// The focused asset (its key), the drawer, and the list of visible assets in display order.
let CUR = null;
let OPEN = false;
let ITEMS = [];
let LAST = 0;

function readHash() {
  const hash = location.hash.slice(1);
  // Old links: #combos, #effects, #plans, #plans=<target>.
  if (['combos', 'effects', 'plans'].includes(hash)) { S.tab = hash; return; }
  if (hash.startsWith('plans=')) { S.tab = 'plans'; S.q = decodeURIComponent(hash.slice(6)); S.status = 'all'; return; }
  const p = new URLSearchParams(hash);
  for (const k of Object.keys(DEFAULTS)) if (p.has(k)) S[k] = p.get(k);
}
function writeHash() {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(S)) if (v !== DEFAULTS[k]) p.set(k, v);
  const s = p.toString();
  history.replaceState(null, '', s ? '#' + s : location.pathname);
}
function set(change) {
  Object.assign(S, change);
  writeHash();
  draw();
}

const $ = (id) => document.getElementById(id);
const P = (t) => PROJ.get(t.project);
const keyOf = (t, a) => t.project + '|' + t.target + '|' + a.name;
function familyOf(group) { return group ? group.split('-')[0] : ''; }
function inScope(t) {
  if (S.project && t.project !== S.project) return false;
  if (S.group) return t.group === S.group;
  if (S.family) return familyOf(t.group) === S.family;
  return true;
}
function matches(t, a) {
  if (!S.q) return true;
  return (t.target + '/' + (a ? a.name : '') + ' ' + t.group + ' ' + t.kind + ' ' + t.compose).toLowerCase().includes(S.q.toLowerCase());
}
function statusOk(status) { return S.status === 'all' || S.status === status; }
function newest(a, b) { return (a || '') > (b || '') ? a : b; }

function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 86400 * 60) return Math.floor(s / 86400) + 'd';
  return Math.floor(s / 86400 / 30) + 'mo';
}
function dayLabel(iso) {
  if (!iso) return 'No date';
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

async function load() {
  DATA = await (await fetch('/api/state')).json();
  PROJ.clear();
  DATA.projects.forEach((p) => PROJ.set(p.id, p));
  DATA.targets.forEach((t, i) => {
    t.index = i;
    t.latest = t.assets.reduce((m, a) => newest(m, a.updatedAt), t.generatedAt || '');
  });
  const names = DATA.projects.map((p) => p.name).join(', ');
  document.title = 'ukiyo review · ' + names;
  $('title').textContent = 'ukiyo review · ' + (DATA.projects.length === 1 ? names : DATA.projects.length + ' projects');
  draw();
}
async function api(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.ok) return true;
  const e = await r.json().catch(() => ({}));
  toast(e.error || r.statusText);
  return false;
}
function toast(text) {
  const el = $('toast');
  el.textContent = text; el.style.display = 'block';
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.style.display = 'none'; }, 5000);
}

function draw() {
  document.querySelectorAll('nav.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  if ($('q').value !== S.q) $('q').value = S.q;
  document.documentElement.style.setProperty('--thumb', S.thumb + 'px');
  renderSide();
  const main = $('main');
  const top = main.scrollTop;
  if (S.tab === 'combos') renderCombos();
  else if (S.tab === 'effects') renderEffects();
  else if (S.tab === 'plans') renderPlans();
  else renderAssets();
  main.scrollTop = top;
  renderDetail();
}

/* ---- sidebar: status, then project > family > group, newest first ---- */

// The review statuses of the current tab, for every target in scope.
function tabStatuses(t) {
  if (S.tab === 'plans') return [t.plan ? t.plan.status : null, ...(t.lights || []).map((l) => l.status)].filter(Boolean);
  if (S.tab === 'effects') return t.assets.filter((a) => a.effects && matches(t, a)).map((a) => a.effects.status);
  return t.assets.filter((a) => matches(t, a)).map((a) => a.status);
}
function row(label, opts) {
  return h('div', { class: 'row ' + (opts.cls || '') + (opts.on ? ' on' : ''), title: opts.title || label, onclick: opts.onclick },
    opts.caret != null ? h('span', { class: 'muted', style: 'width:10px' }, opts.caret) : null,
    h('span', { class: 'label' }, label),
    opts.n != null ? h('span', { class: 'n' + (opts.hot ? ' p' : '') }, opts.n) : null,
    opts.age != null ? h('span', { class: 'age' }, opts.age) : null);
}
function summary(targets) {
  let pending = 0, latest = '';
  targets.forEach((t) => { tabStatuses(t).forEach((s) => { if (s === 'pending') pending += 1; }); latest = newest(latest, t.latest); });
  return { pending, latest };
}
function renderSide() {
  const side = $('side');
  const blocks = [];
  if (S.tab !== 'combos') {
    const c = { pending: 0, rejected: 0, approved: 0 };
    DATA.targets.filter(inScope).forEach((t) => tabStatuses(t).forEach((s) => { c[s] += 1; }));
    const total = c.pending + c.rejected + c.approved;
    blocks.push(h('h4', {}, 'Status'),
      row('Pending', { n: c.pending, hot: c.pending > 0, on: S.status === 'pending', onclick: () => set({ status: 'pending' }) }),
      row('Rejected', { n: c.rejected, on: S.status === 'rejected', onclick: () => set({ status: 'rejected' }) }),
      row('Approved', { n: c.approved, on: S.status === 'approved', onclick: () => set({ status: 'approved' }) }),
      row('All', { n: total, on: S.status === 'all', onclick: () => set({ status: 'all' }) }));
  }
  blocks.push(h('h4', {}, 'Projects'));
  const all = summary(DATA.targets);
  blocks.push(row('Everything', { n: all.pending || '', hot: true, age: ago(all.latest), on: !S.project, onclick: () => set({ project: '', family: '', group: '' }) }));
  const multi = DATA.projects.length > 1;
  for (const p of DATA.projects) {
    const targets = DATA.targets.filter((t) => t.project === p.id);
    const open = !multi || S.project === p.id;
    if (multi) {
      const s = summary(targets);
      blocks.push(row(p.name, { cls: 'proj', caret: open ? '▾' : '▸', title: p.name + ' · ' + p.root + (p.error ? ' · ' + p.error : ''), n: s.pending || '', hot: true, age: ago(s.latest), on: S.project === p.id && !S.family && !S.group, onclick: () => set({ project: p.id, family: '', group: '' }) }));
    }
    if (p.error) blocks.push(h('div', { class: 'warn', style: 'padding:2px 20px;font-size:11px' }, p.error));
    if (!open) continue;
    // Groups by family: the part of the group name before its first dash.
    const families = new Map();
    for (const t of targets) {
      const f = familyOf(t.group);
      if (!families.has(f)) families.set(f, new Map());
      const groups = families.get(f);
      if (!groups.has(t.group)) groups.set(t.group, []);
      groups.get(t.group).push(t);
    }
    const ranked = [...families.entries()].map(([f, groups]) => ({ f, groups, s: summary([...groups.values()].flat()) })).sort((x, y) => (y.s.latest || '').localeCompare(x.s.latest || ''));
    const pad = multi ? 'l1' : '';
    for (const { f, groups, s } of ranked) {
      const only = groups.size === 1 && groups.has(f);
      const fOpen = S.project === p.id && (S.family === f || familyOf(S.group) === f) && !only;
      const label = f || '(no group)';
      if (only) {
        blocks.push(row(label, { cls: pad, caret: '', n: s.pending || '', hot: true, age: ago(s.latest), on: S.project === p.id && S.group === f && !S.family, onclick: () => set({ project: p.id, family: '', group: f }) }));
        continue;
      }
      blocks.push(row(label, { cls: pad, caret: fOpen ? '▾' : '▸', n: s.pending || '', hot: true, age: ago(s.latest), on: S.project === p.id && S.family === f && !S.group, onclick: () => set({ project: p.id, family: f, group: '' }) }));
      if (!fOpen) continue;
      const gs = [...groups.entries()].map(([g, ts]) => ({ g, s: summary(ts) })).sort((x, y) => (y.s.latest || '').localeCompare(x.s.latest || ''));
      for (const { g, s: gsum } of gs) {
        blocks.push(row(g === f ? g : g.slice(f.length + 1), { cls: multi ? 'l2' : 'l1', title: g, n: gsum.pending || '', hot: true, age: ago(gsum.latest), on: S.project === p.id && S.group === g, onclick: () => set({ project: p.id, family: f, group: g }) }));
      }
    }
  }
  side.replaceChildren(...blocks);
}

/* ---- assets: a grid of cards, newest first by default ---- */

function assetItems() {
  const out = [];
  for (const t of DATA.targets) {
    if (!inScope(t)) continue;
    t.assets.forEach((a, i) => { if (matches(t, a) && statusOk(a.status)) out.push({ t, a, i, key: keyOf(t, a) }); });
  }
  const byOrder = (x, y) => x.t.index - y.t.index || x.i - y.i;
  // Newest: a target's assets stay together, ordered by the target's newest file.
  if (S.sort === 'new') out.sort((x, y) => (y.t.latest || '').localeCompare(x.t.latest || '') || byOrder(x, y));
  else if (S.sort === 'reviewed') out.sort((x, y) => (y.a.reviewedAt || '').localeCompare(x.a.reviewedAt || '') || byOrder(x, y));
  else out.sort(byOrder);
  return out;
}
function curItem() { return ITEMS.find((x) => x.key === CUR) || null; }
function renderAssets() {
  ITEMS = assetItems();
  if (!curItem()) CUR = ITEMS.length ? ITEMS[Math.min(LAST, ITEMS.length - 1)].key : null;
  const pending = ITEMS.filter((x) => x.a.status === 'pending');
  const toolbar = h('div', { class: 'toolbar' },
    h('strong', {}, ITEMS.length + ' asset' + (ITEMS.length === 1 ? '' : 's')),
    h('label', {}, 'Sort', select(S.sort, [['new', 'Newest first'], ['reviewed', 'Recently reviewed'], ['manifest', 'Manifest order']], (v) => set({ sort: v }))),
    h('label', {}, 'Size', h('input', { type: 'range', min: '90', max: '360', step: '10', value: S.thumb, oninput: (e) => { S.thumb = e.target.value; document.documentElement.style.setProperty('--thumb', S.thumb + 'px'); }, onchange: () => writeHash() })),
    pending.length > 1 ? h('button', { onclick: () => approveAll(pending) }, 'Approve ' + pending.length + ' shown') : null,
    h('span', { class: 'muted', style: 'margin-left:auto' }, h('kbd', {}, 'j'), ' ', h('kbd', {}, 'k'), ' move · ', h('kbd', {}, 'a'), ' approve · ', h('kbd', {}, 'x'), ' reject · ', h('kbd', {}, '↵'), ' details'));
  const blocks = [toolbar];
  if (!ITEMS.length) {
    blocks.push(h('div', { class: 'empty' }, 'No ' + (S.status === 'all' ? '' : S.status + ' ') + 'assets here. ', S.status !== 'all' ? h('button', { class: 'link', onclick: () => set({ status: 'all' }) }, 'Show all') : null));
  } else if (S.sort === 'manifest') {
    let grid = null, last = null;
    for (const item of ITEMS) {
      if (item.t !== last) {
        last = item.t;
        const t = item.t;
        blocks.push(h('div', { class: 'theader' }, h('h3', {}, t.target), h('span', { class: 'muted' }, [t.compose, t.kind, t.group, DATA.projects.length > 1 ? P(t).name : ''].filter(Boolean).join(' · ')), t.warnings.length ? h('span', { class: 'warn' }, '⚠ ' + t.warnings.length) : null));
        grid = h('div', { class: 'grid' });
        blocks.push(grid);
      }
      grid.append(card(item));
    }
  } else {
    const when = (x) => S.sort === 'reviewed' ? x.a.reviewedAt : x.t.latest;
    let grid = null, label = null, count = null, n = 0;
    for (const item of ITEMS) {
      const d = S.sort === 'reviewed' && !item.a.reviewedAt ? 'Not reviewed' : dayLabel(when(item));
      if (d !== label) {
        label = d; n = 0;
        count = h('span', { class: 'n' });
        blocks.push(h('div', { class: 'day' }, d + ' ', count));
        grid = h('div', { class: 'grid' });
        blocks.push(grid);
      }
      n += 1; count.textContent = '· ' + n;
      grid.append(card(item));
    }
  }
  $('main').replaceChildren(...blocks);
}
function select(value, options, onchange) {
  const el = h('select', { onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h('option', { value: v }, l)));
  el.value = value;
  return el;
}
function card(item) {
  const { t, a } = item;
  const src = a.final || a.cut;
  const sub = [DATA.projects.length > 1 ? P(t).name : '', t.group, ago(a.updatedAt)].filter(Boolean).join(' · ');
  return h('div', { class: 'card ' + a.status + (item.key === CUR ? ' cur' : ''), 'data-key': item.key, onclick: () => { focus(item.key); OPEN = true; renderDetail(); } },
    h('div', { class: 'thumb', style: 'background:' + P(t).background }, src ? h('img', { src, loading: 'lazy', alt: '' }) : h('span', { class: 'muted' }, 'not cut yet')),
    h('div', { class: 'quick' },
      h('button', { class: 'ok', title: 'Approve (a)', onclick: (e) => { e.stopPropagation(); act(item, 'approved'); } }, '✓'),
      h('button', { class: 'bad', title: 'Reject (x)', onclick: (e) => { e.stopPropagation(); act(item, 'rejected'); } }, '✗')),
    h('div', { class: 'meta', title: a.frame + (a.note ? ' · note: ' + a.note : '') },
      h('span', { class: 'dot ' + a.status }),
      h('div', { style: 'min-width:0;flex:1' }, h('div', { class: 'name' }, a.frame), h('div', { class: 'sub' }, sub)),
      a.note ? h('span', { class: 'muted', title: a.note }, '✎') : null));
}
// Move the focus without a full redraw.
function focus(key) {
  CUR = key;
  LAST = Math.max(0, ITEMS.findIndex((x) => x.key === key));
  document.querySelectorAll('.card.cur').forEach((el) => el.classList.remove('cur'));
  const el = document.querySelector('.card[data-key="' + CSS.escape(key) + '"]');
  if (el) { el.classList.add('cur'); el.scrollIntoView({ block: 'nearest' }); }
}
async function act(item, status, note, redo) {
  const text = note ?? item.a.note ?? '';
  const ok = await api('/api/status', { project: item.t.project, target: item.t.target, asset: item.a.name, status, note: text, redo: redo || undefined });
  if (!ok) return;
  if (redo) { await load(); return; }
  Object.assign(item.a, { status, note: text.trim() || undefined, reviewedAt: new Date().toISOString() });
  const i = ITEMS.findIndex((x) => x.key === item.key);
  // The next asset gets the focus. With a status filter the reviewed one drops out of the list.
  if (statusOk(status) && ITEMS[i + 1]) CUR = ITEMS[i + 1].key;
  else if (!statusOk(status)) CUR = null;
  LAST = Math.max(0, i);
  draw();
}
async function approveAll(items) {
  if (!confirm('Approve ' + items.length + ' pending assets?')) return;
  for (const item of items) {
    if (!(await api('/api/status', { project: item.t.project, target: item.t.target, asset: item.a.name, status: 'approved', note: item.a.note || '' }))) break;
  }
  await load();
}

/* ---- detail drawer ---- */

function renderDetail() {
  const item = S.tab === 'assets' && OPEN ? curItem() : null;
  document.body.classList.toggle('drawer', Boolean(item));
  if (!item) { $('detail').replaceChildren(); return; }
  const { t, a } = item;
  const p = P(t);
  const note = h('input', { class: 'note', id: 'note', placeholder: 'note: why, or what to change', value: a.note || '' });
  const w = a.width || 64, hh = a.height || 64;
  const src = a.final || a.cut;
  const channel = a.tint || t.tint;
  const preview = src ? h('div', { class: 'scales', style: 'background:' + p.background },
    h('figure', {}, h('div', { class: 'phone', style: 'background:' + p.background }, sizedImg(src, w, hh, 1, p.scale)), h('figcaption', {}, '1x in a 375px phone')),
    h('figure', {}, sizedImg(src, w, hh, 1, p.scale), h('figcaption', {}, '1x · ' + Math.round(w / p.scale) + '×' + Math.round(hh / p.scale))),
    h('figure', {}, sizedImg(src, w, hh, 2, p.scale), h('figcaption', {}, '2x')),
    h('figure', {}, sizedImg(src, w, hh, 3, p.scale), h('figcaption', {}, '3x')),
    a.final && channel && p.tints[channel] ? tintPreview(src, w, hh, channel, p) : null,
  ) : h('p', { class: 'muted' }, 'not cut yet');
  const i = ITEMS.indexOf(item);
  // h() drops the null parts; replaceChildren() would print them.
  $('detail').replaceChildren(h('div', {},
    h('div', { class: 'dhead' }, h('h2', {}, a.frame), h('span', { class: 'pill ' + a.status }, a.status), h('button', { title: 'Close (Esc)', onclick: () => { OPEN = false; renderDetail(); } }, '×')),
    h('div', { class: 'muted' }, [DATA.projects.length > 1 ? p.name : '', t.group, t.compose + ' · ' + t.kind, (i + 1) + ' of ' + ITEMS.length].filter(Boolean).join(' · ')),
    h('div', { class: 'muted' }, 'updated ' + (a.updatedAt ? new Date(a.updatedAt).toLocaleString() : '—') + (a.reviewedAt ? ' · reviewed ' + ago(a.reviewedAt) + ' ago' : '')),
    h('div', { class: 'actions' },
      h('button', { class: 'ok', onclick: () => act(item, 'approved', note.value) }, 'Approve'),
      h('button', { class: 'bad', onclick: () => act(item, 'rejected', note.value) }, 'Reject'),
      h('button', { title: 'Delete the outputs and mark it rejected', onclick: () => act(item, 'rejected', note.value, true) }, 'Redo'),
      h('button', { onclick: () => act(item, 'pending', note.value) }, 'Reset')),
    h('div', { class: 'actions' }, note),
    preview,
    a.registration ? h('p', { class: a.registration.iou < 0.8 ? 'warn' : 'muted' }, 'registered to ' + a.base + ': overlap ' + a.registration.iou + ', scale ' + a.registration.scale + ', covers ' + Math.round(a.registration.coverage * 100) + '% of base') : null,
    a.references && a.references.length ? h('div', { class: 'refs' },
      h('span', { class: 'muted' }, 'references:'),
      ...a.references.map((r) => h('figure', { title: (r.id || r.path) + ' · ' + r.source + (r.status ? ' · ' + r.status : '') + ' · sha256 ' + r.sha256 + (r.changed ? ' · file changed since' : '') },
        r.url ? h('img', { src: r.url, loading: 'lazy' }) : null,
        h('figcaption', { class: r.changed ? 'warn' : 'muted' }, r.n + '. ' + r.role + ' · ' + (r.id || r.path.split('/').pop()))))) : null,
    t.warnings.length ? h('p', { class: 'warn' }, t.warnings.join(' ')) : null,
    stripPlayer(t, p),
    rawView(t, a),
    t.prompt ? h('details', {}, h('summary', {}, 'prompt'), h('pre', {}, t.prompt)) : null,
    h('p', { class: 'muted keys' }, h('kbd', {}, 'j'), ' ', h('kbd', {}, 'k'), ' next, previous · ', h('kbd', {}, 'a'), ' approve · ', h('kbd', {}, 'x'), ' reject · ', h('kbd', {}, 'u'), ' reset · ', h('kbd', {}, 'n'), ' note · ', h('kbd', {}, 'esc'), ' close'),
  ));
}

/* ---- keyboard ---- */

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (e.key === 'Escape') e.target.blur();
    if (e.key === 'Enter' && e.target.id === 'note') { const item = curItem(); if (item) act(item, item.a.status, e.target.value); }
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); $('q').focus(); return; }
  if (S.tab !== 'assets') return;
  const item = curItem();
  const i = item ? ITEMS.indexOf(item) : -1;
  const go = (d) => { const next = ITEMS[Math.max(0, Math.min(ITEMS.length - 1, i + d))]; if (next) { focus(next.key); renderDetail(); } };
  const noteValue = () => (OPEN && $('note') ? $('note').value : undefined);
  switch (e.key) {
    case 'j': case 'ArrowRight': go(1); break;
    case 'k': case 'ArrowLeft': go(-1); break;
    case 'Enter': case 'o': OPEN = !OPEN; renderDetail(); break;
    case 'Escape': OPEN = false; renderDetail(); break;
    case 'a': if (item) act(item, 'approved', noteValue()); break;
    case 'x': if (item) act(item, 'rejected', noteValue()); break;
    case 'u': if (item) act(item, 'pending', noteValue()); break;
    case 'n': if (OPEN && $('note')) $('note').focus(); break;
    default: return;
  }
  e.preventDefault();
});

/* ---- plans, wind and light ---- */

function renderPlans() {
  const targets = DATA.targets.filter((t) => (t.plan || t.lights) && inScope(t) && matches(t) && tabStatuses(t).some(statusOk));
  const main = $('main');
  if (!targets.length) { main.replaceChildren(h('div', { class: 'empty' }, 'No ' + (S.status === 'all' ? '' : S.status + ' ') + 'part plans or light points here.')); return; }
  main.replaceChildren(...targets.map((t) => h('section', { class: 'target', style: '--bg:' + P(t).background },
    h('h2', {}, t.target, ' ', h('span', { class: 'muted' }, [t.compose, t.kind, t.group, DATA.projects.length > 1 ? P(t).name : ''].filter(Boolean).join(' · '))),
    t.warnings.length ? h('div', { class: 'warn' }, t.warnings.join(' ')) : null,
    t.plan && statusOk(t.plan.status) ? planCard(t) : null,
    t.lights ? h('div', { class: 'assets' }, t.lights.filter((l) => statusOk(l.status)).map((card) => lightCard(t, card))) : null,
  )));
}
/*
 * Wind & light: every sprite the rig rules cover, with what \`ukiyo plan\` proposed.
 * Wind is a list of wind materials or none; light is art (points from the art) or none.
 * Editing either and saving makes it a hand review, which later passes keep.
 */
function renderEffects() {
  const rows = DATA.targets.filter(inScope).flatMap((t) => t.assets.filter((a) => a.effects && matches(t, a) && statusOk(a.effects.status)).map((a) => ({ t, a })));
  if (S.sort === 'new') rows.sort((x, y) => (y.t.latest || '').localeCompare(x.t.latest || ''));
  const main = $('main');
  if (!rows.length) { main.replaceChildren(h('div', { class: 'empty' }, 'No ' + (S.status === 'all' ? '' : S.status + ' ') + 'wind and light reviews here. Run ukiyo plan --score.')); return; }
  main.replaceChildren(h('div', { class: 'assets' }, rows.map(({ t, a }) => effectsCard(t, a))));
}
function effectsCard(t, a) {
  const e = a.effects;
  const wind = h('input', { class: 'note', value: e.wind === 'none' ? 'none' : e.wind.join(', '), title: 'wind materials, comma separated, or none' });
  const light = h('select', {}, h('option', { value: 'none' }, 'light: none'), h('option', { value: 'art' }, 'light: art'));
  light.value = e.light;
  const note = h('input', { class: 'note', placeholder: 'note', value: e.note || '' });
  const post = (status) => api('/api/effects', { project: t.project, target: t.target, asset: a.name, status, note: note.value, light: light.value, wind: wind.value.trim() === 'none' ? 'none' : wind.value.split(',').map((s) => s.trim()).filter(Boolean) }).then(load);
  return h('div', { class: 'asset ' + e.status, style: '--bg:' + P(t).background },
    h('h3', {}, h('span', {}, a.frame), h('span', { class: 'pill ' + e.status }, e.status + (e.source === 'hand' ? ' · hand' : ''))),
    a.final ? h('img', { src: a.final, loading: 'lazy', style: 'max-width:160px;max-height:120px;border-radius:8px' }) : null,
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

/*
 * Random stacks: each base that layer targets are drawn on, plus one random
 * asset (or nothing) from each layer target, with random tints per channel.
 * Every layer shares the base's scale and pivot, so all are drawn with their
 * pivots on one point.
 */
async function renderCombos() {
  const main = $('main');
  const data = DATA.targets.filter((t) => inScope(t) && matches(t));
  const byFrame = new Map();
  data.forEach((t) => t.assets.forEach((a) => byFrame.set(t.project + '|' + t.target + '/' + a.name, { t, a })));
  const layers = data.filter((t) => t.compose === 'layer');
  const bases = [...new Set(layers.flatMap((t) => t.assets.map((a) => t.project + '|' + a.base)))].filter((b) => byFrame.has(b));
  const again = h('button', { onclick: () => renderCombos() }, 'Reroll');
  const blocks = [];
  if (bases.length === 0) blocks.push(h('div', { class: 'empty' }, 'No layer targets with a finalised base here.'));
  main.replaceChildren(h('div', { class: 'toolbar' }, again), ...blocks);
  for (const baseRef of bases) {
    const base = byFrame.get(baseRef);
    const p = P(base.t);
    const tintFor = (channel) => channel && p.tints[channel] ? pick(p.tints[channel]) : null;
    const families = layers.filter((t) => t.project === base.t.project && t.assets.some((a) => t.project + '|' + a.base === baseRef));
    const grid = h('div', { class: 'combos' });
    main.append(h('section', { class: 'target', style: '--bg:' + p.background }, h('h2', {}, baseRef.split('|')[1], ' ', h('span', { class: 'muted' }, families.map((f) => f.target).join(' + '))), grid));
    for (let n = 0; n < 12; n += 1) {
      // Layers on the same channel as the base (ears on fur) share its colour.
      const baseChannel = base.a.tint || base.t.tint;
      const colors = {};
      if (baseChannel) colors[baseChannel] = tintFor(baseChannel);
      const stack = [{ asset: base.a, color: baseChannel ? colors[baseChannel] : null, order: 0, label: base.a.name }];
      for (const f of families) {
        const options = f.assets.filter((a) => f.project + '|' + a.base === baseRef && a.final);
        if (options.length === 0 || Math.random() < 1 / (options.length + 1)) continue;
        const a = pick(options);
        const channel = a.tint || f.tint;
        colors[channel] ??= tintFor(channel);
        stack.push({ asset: a, color: colors[channel], order: f.order || 0, label: a.name });
      }
      stack.sort((x, y) => x.order - y.order);
      grid.append(await comboFigure(stack, p.scale));
    }
  }
}
async function comboFigure(stack, scale) {
  const zoom = 2 / scale;
  const loaded = await Promise.all(stack.map((s) => image(s.asset.final || s.asset.cut)));
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
  return h('figure', {}, c, h('figcaption', {}, stack.map((s) => s.label + (s.color ? ' ' + s.color : '')).join(' · ')));
}
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function sizedImg(src, w, h0, factor, scale) {
  return h('img', { src, width: Math.max(1, Math.round(w / scale * factor)), height: Math.max(1, Math.round(h0 / scale * factor)) });
}
function tintPreview(src, w, hh, channel, p) {
  const row = h('div', { style: 'display:flex;gap:4px;align-items:flex-end;flex-wrap:wrap;max-width:220px' });
  const fig = h('figure', {}, row, h('figcaption', {}, 'tint: ' + channel));
  image(src).then((img) => {
    if (!img) return;
    for (const color of p.tints[channel].slice(0, 4)) {
      const c = tinted(img, color);
      c.style.width = Math.round(w / p.scale) + 'px'; c.style.height = Math.round(hh / p.scale) + 'px';
      row.append(c);
    }
  });
  return fig;
}
function stripPlayer(t, p) {
  if (t.compose !== 'strip') return null;
  const frames = t.assets.filter((a) => a.final || a.cut);
  if (frames.length < 2) return null;
  const imgs = frames.map((a, i) => h('img', { src: a.final || a.cut, width: Math.round((a.width || 64) / p.scale * 2), class: i === 0 ? 'on' : '' }));
  const play = h('div', { class: 'play' }, imgs);
  let i = 0;
  const timer = setInterval(() => {
    if (!play.isConnected) { clearInterval(timer); return; }
    i = (i + 1) % imgs.length; imgs.forEach((img, j) => img.classList.toggle('on', j === i));
  }, 1000 / 6);
  return h('div', { class: 'strip' }, h('span', { class: 'muted' }, 'strip at 6 fps, 2x:'), play);
}
function rawView(t, only) {
  if (!t.raw) return null;
  const img = h('img', { src: t.raw });
  const wrap = h('div', { class: 'raw' }, img);
  img.addEventListener('load', () => {
    const pct = (v, total) => (v / total * 100) + '%';
    t.assets.forEach((a) => {
      if (!a.sourceBox) return;
      const b = a.sourceBox, W = img.naturalWidth, H = img.naturalHeight;
      wrap.append(h('div', { class: 'box', style: 'left:' + pct(b.x, W) + ';top:' + pct(b.y, H) + ';width:' + pct(b.width, W) + ';height:' + pct(b.height, H) + (a === only ? ';border-width:3px' : ';opacity:.5') }, h('span', {}, a.name)));
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
      h('button', { class: 'ok', onclick: () => postPlan(t, 'approved', note.value) }, 'Approve plan'),
      h('button', { class: 'bad', onclick: () => postPlan(t, 'rejected', note.value) }, 'Reject plan'),
      h('button', { onclick: () => postPlan(t, 'pending', note.value) }, 'Reset'),
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
  const post = (status) => api('/api/lights', { project: t.project, target: t.target, asset: card.asset, status, note: note.value }).then(load);
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
async function postPlan(t, status, note) {
  if (await api('/api/plan', { project: t.project, target: t.target, status, note })) await load();
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

for (const b of document.querySelectorAll('nav.tabs button')) b.addEventListener('click', () => { OPEN = false; set({ tab: b.dataset.tab }); });
$('q').addEventListener('input', (e) => { S.q = e.target.value; writeHash(); draw(); });
// New art from a generation run shows up when the page gets the focus again, unless a note is being edited.
window.addEventListener('focus', () => { const n = $('note'); const item = curItem(); if (n && item && n.value !== (item.a.note || '')) return; load(); });
readHash();
load();
</script>
`;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendFile(res: http.ServerResponse, file: string, type: string): void {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

/**
 * Serve the review page for one or more projects. The first project is the one
 * `ukiyo review` runs in. Each request for the state reads the manifest again,
 * so new targets show without a restart.
 */
export function startReviewServer(projects: ReviewProject[], port: number, onChange?: (project: ReviewProject, change: ReviewChange) => void): Promise<{ url: string; close: () => void }> {
  const served: Served[] = [];
  for (const project of projects) {
    const base = slugify(project.config.project.name);
    let id = base;
    for (let n = 2; served.some((s) => s.id === id); n += 1) id = `${base}-${n}`;
    served.push({ ...project, id });
  }
  const root = served[0]!.config.root;
  const info = (p: Served): ProjectInfo => ({
    id: p.id,
    name: p.config.project.name,
    root: path.relative(root, p.config.root) || '.',
    background: p.config.styleGuide.canvas.backgroundColor,
    scale: p.config.atlas.scale,
    unit: p.config.atlas.unit,
    tints: p.config.tints,
    error: p.error,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        for (const p of served) {
          try {
            p.manifest = loadManifest(p.config.manifestPath);
            p.error = undefined;
          } catch (error) {
            p.error = `manifest: ${error instanceof Error ? error.message : String(error)}`;
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ projects: served.map(info), targets: served.flatMap(snapshot) }));
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        const body = JSON.parse(await readBody(req)) as { project?: string };
        const p = served.find((s) => s.id === body.project) ?? (served.length === 1 ? served[0] : undefined);
        if (!p) throw new Error(`Unknown project ${body.project}`);
        if (url.pathname === '/api/status') {
          const change = body as ReviewChange;
          applyChange(p.config, p.manifest, change);
          onChange?.(p, change);
        } else if (url.pathname === '/api/plan') applyPlanChange(p.config, p.manifest, body as PlanChange);
        else if (url.pathname === '/api/effects') applyEffectsChange(p.config, p.manifest, body as EffectsChange);
        else if (url.pathname === '/api/lights') applyLightsChange(p.config, p.manifest, body as LightsChange);
        else {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      const match = req.method === 'GET' ? /^\/p\/([^/]+)\/(file|root)\/(.+)$/.exec(url.pathname) : null;
      const p = match ? served.find((s) => s.id === match[1]) : undefined;
      if (match && p) {
        const rel = decodeURIComponent(match[3]!);
        if (match[2] === 'root') {
          // Reference thumbnails: image files inside the project only.
          const file = path.resolve(p.config.root, rel);
          if (file.startsWith(p.config.root + path.sep) && /\.(png|jpe?g|webp)$/i.test(file) && fs.existsSync(file)) {
            sendFile(res, file, /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg');
            return;
          }
        } else {
          const file = path.resolve(p.config.outDir, rel);
          if (file.startsWith(p.config.outDir + path.sep) && fs.existsSync(file)) {
            sendFile(res, file, 'image/png');
            return;
          }
        }
      }
      res.writeHead(404);
      res.end();
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

export { targetDir };

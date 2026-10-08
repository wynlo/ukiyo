import type { ResolvedConfig } from '../config.js';
import type { Target } from '../manifest.js';
import { declaredAspect } from '../ops/aspect.js';
import { loadTemplates, type TemplateSet } from './templates.js';

/**
 * Prompt composer. The wording lives in the template files under
 * `prompts/<version>/`. This module builds the view each template reads:
 * project context, the style file, and the target's fields.
 */

export function templatesFor(config: ResolvedConfig): TemplateSet {
  return loadTemplates(config.prompts.version, config.promptsDir);
}

function styleView(config: ResolvedConfig) {
  const style = config.styleGuide;
  return {
    lock: style.styleLock.trim() || style.description.trim(),
    palette: style.palette.map((entry) => `${entry.name} ${entry.hex} (${entry.usage})`).join(', '),
    shapeLanguage: style.shapeLanguage.join(', '),
    renderingRules: style.renderingRules,
    negative: [...new Set(style.bannedTraits.map((trait) => trait.trim()).filter(Boolean))].join(', '),
    lineless: style.linework.outlineColor.toLowerCase() === 'none',
    outlineColor: style.linework.outlineColor,
    outlineThickness: style.linework.outlineThickness,
    shading: style.shading?.trim() ?? '',
    detail: style.detail,
  };
}

function baseView(config: ResolvedConfig, target: Target) {
  return {
    project: { name: config.project.name, description: config.project.description.trim() },
    style: styleView(config),
    additional: [config.style.additionalDetails.trim(), target.notes?.trim() ?? ''].filter(Boolean).join('\n'),
    subject: 'subject' in target ? target.subject.trim() : '',
    size: defaultSize(target),
    background: target.background ?? config.styleGuide.canvas.backgroundColor,
    tint: Boolean(target.tint),
    // Backdrops state their aspect in their own template; a layer copies its base.
    aspect: target.compose === 'backdrop' || target.compose === 'layer' || target.compose === 'split' ? '' : (declaredAspect(config, target)?.label ?? ''),
  };
}

export function defaultSize(target: Target): string {
  if (target.size) {
    return target.size;
  }
  switch (target.compose) {
    case 'sheet':
    case 'parts':
    case 'layer':
    case 'split':
      return '1024x1024';
    case 'single':
      return '1024x1024';
    case 'strip':
      return target.frames.length > 3 ? '1536x1024' : '1024x1024';
    case 'backdrop':
      switch (target.aspect) {
        case '3:1':
          return '1536x512';
        case '2:1':
          return '1536x768';
        case '16:9':
          return '1536x864';
        case '9:16':
          return '864x1536';
        default:
          return '1024x1024';
      }
  }
}

function posesFor(templates: TemplateSet, target: Extract<Target, { compose: 'strip' }>): string[] {
  if (target.poses && target.poses.length === target.frames.length) {
    return target.poses;
  }
  return target.frames.map((frame) => templates.poses[frame] ?? frame.replace(/-/g, ' '));
}

export function composePrompt(config: ResolvedConfig, target: Target): string {
  const templates = templatesFor(config);
  const view = baseView(config, target);

  switch (target.compose) {
    case 'sheet':
      return templates.render('sheet', {
        ...view,
        category: target.category?.trim() || 'Game assets',
        assets: target.assets
          .map((name) => name.trim())
          .filter(Boolean)
          .map((name, index) => ({ n: index + 1, name })),
        trueScale: Boolean(target.trueScale),
      });

    case 'single':
      return templates.render('single', view);

    case 'strip': {
      const poses = posesFor(templates, target);
      return templates.render('strip', { ...view, frames: target.frames.map((name, index) => ({ n: index + 1, name, pose: poses[index] })) });
    }

    case 'backdrop':
      return templates.render('backdrop', { ...view, aspect: target.aspect, seamless: Boolean(target.seamless) });

    case 'layer':
      return target.layers.map((layer) => `## ${layer.id}\n${composeLayerPrompt(config, target, layer)}`).join('\n\n');

    case 'split':
      return [
        ...(target.plate ? [`## plate\n${composeSplitPrompt(config, target, 'plate', target.plate)}`] : []),
        ...target.add.map((entry) => `## ${entry.id}\n${composeSplitPrompt(config, target, 'add', entry.label)}`),
      ].join('\n\n') || '(no generation: the pieces are cut from the base)';

    case 'parts':
      return templates.render('parts', {
        ...view,
        reference: Boolean(target.reference),
        rigged: Boolean(target.rig),
        rigType: target.rigType,
        parts: target.parts.map((part) => ({ label: part.label, required: part.required, pivotHint: part.pivotHint?.toLowerCase() })),
      });
  }
}

/**
 * One overlay for a `layer` target. The source image is the base drawn in a
 * flat marker colour; the model redraws it with one thing added. ukiyo then
 * registers the result to the base and keeps only the new pixels.
 */
export function composeLayerPrompt(config: ResolvedConfig, target: Extract<Target, { compose: 'layer' }>, layer: { id: string; label: string }): string {
  return templatesFor(config).render('layer', {
    ...baseView(config, target),
    background: target.background ?? (config.cutout.mode === 'chroma' ? config.cutout.chroma : config.styleGuide.canvas.backgroundColor),
    label: layer.label.trim(),
    baseTint: target.baseTint,
  });
}

/**
 * One edit for a `split` target. `plate` removes things from the base (the
 * base is shown in its own colours); `add` draws a new thing onto it (the
 * base is shown in a flat marker colour, like a `layer`).
 */
export function composeSplitPrompt(config: ResolvedConfig, target: Extract<Target, { compose: 'split' }>, kind: 'plate' | 'add', label: string): string {
  return templatesFor(config).render(kind === 'plate' ? 'split-plate' : 'split-add', {
    ...baseView(config, target),
    background: target.background ?? (config.cutout.mode === 'chroma' ? config.cutout.chroma : config.styleGuide.canvas.backgroundColor),
    label: label.trim(),
    baseTint: target.baseTint,
  });
}

/** Prompt for `ukiyo edit`: the original prompt plus one instruction. */
export function composeEditPrompt(config: ResolvedConfig, originalPrompt: string, instruction: string, background = config.styleGuide.canvas.backgroundColor): string {
  return templatesFor(config).render('edit', { background, originalPrompt, instruction: instruction.trim() });
}

/** A per-frame edit instruction for `ukiyo animate`. */
export function framePoseInstruction(config: ResolvedConfig, target: Extract<Target, { compose: 'strip' }>, frame: string): string {
  const templates = templatesFor(config);
  const pose = posesFor(templates, target)[target.frames.indexOf(frame)] ?? frame;
  return templates.render('frame', { pose });
}

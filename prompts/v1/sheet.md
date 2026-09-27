TASK:
Create one production-ready sticker sheet containing exactly {{assets.length}} game sprites.

{{> head}}

CATEGORY:
{{category}}

EXACT ASSETS:
{{#each assets}}
{{n}}. {{name}}
{{/each}}

CANVAS AND LAYOUT:
{{> canvas}}
Arrange the assets in a neat grid in reading order (left to right, then top to bottom), one asset per cell.
Keep every asset isolated.
Do not let assets touch or overlap.
Use front-facing views only.
Leave generous crop-safe spacing around every asset, at least one asset-width apart.
No labels, text, numbers, scene, ground line, or decorative filler.

SPRITE RULES:
Use strong, rounded silhouettes that remain readable at {{style.detail.readableAtPx}}x{{style.detail.readableAtPx}}px.
Use no more than {{style.detail.maxFillColorsPerAsset}} {{#if style.shading}}base colours per asset, plus their shading tones{{else}}flat fill colors per asset{{/if}}.
{{#if style.shading}}
{{> shading}}
{{/if}}
{{#if style.detail.allowTinyDetails}}
Small details are allowed when they remain readable.
{{else}}
Avoid tiny details, intricate textures, and visual clutter.
{{/if}}
{{> outline}}
Keep the palette, {{#if style.lineless}}edge treatment{{else}}outline weight{{/if}}, proportions, and detail level consistent across the whole sheet.
{{#if trueScale}}
Draw every asset at its TRUE relative size, as they would stand together in one room. Small things stay small: do not enlarge an asset to fill its cell.
{{else}}
Draw every asset at a similar visual scale.
{{/if}}
{{> tint}}

{{> negative}}

FINAL CHECK:
Exactly {{assets.length}} assets.
Every requested asset is present once, in the listed order.
Every asset is separate, readable, and crop-safe.
{{> additional}}

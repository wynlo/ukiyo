# Style file

The style file is the project's art direction. It lives in the project, not in
ukiyo. `ukiyo init` writes a starter at `art/style.md`. Set `style.file` in
`ukiyo.json` to use another path. `ukiyo style` validates the file and prints
it as JSON.

## Format

YAML front matter between `---` lines, then a Markdown body. The body is
written into every prompt as the STYLE section, verbatim. When the body is
empty, prompts use `description`.

```markdown
---
name: Soft Paper
description: Lineless flat colour blocks with soft edges, chunky shapes, front-facing.
canvas:
  aspectRatio: "1:1"
  backgroundColor: "#FFFFFF"
  layout: sticker-sheet
linework:
  outlineColor: none
  outlineThickness: shapes are separated by colour alone
  wobble: subtle
shading: A darker same-hue band on the lower side of every form.
shapeLanguage: [chunky, pillowy, big rounded corners]
palette:
  - { name: Paper, hex: "#FFFFFF", usage: background }
  - { name: Apricot, hex: "#F7BB5C", usage: fill }
  - { name: Apricot Band, hex: "#E69B4B", usage: shade }
renderingRules:
  - no outlines
  - readable at small mobile sizes
bannedTraits: [outlines, isometric view, realism, text, watermark]
detail:
  readableAtPx: 48
  maxFillColorsPerAsset: 3
  allowTinyDetails: false
---

STYLE LOCK: Warm cheerful sprites for a phone game with a flat top-down map.

CORE AESTHETIC: ...
EDGES: ...
COLOR: ...
```

## Fields

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | yes | | Shown in `doctor` and the dashboard. |
| `description` | no | `''` | One paragraph. Used when the body is empty. |
| `canvas.aspectRatio` | no | `1:1` | `1:1`, `16:9`, `9:16`, `3:1`, `2:1`. |
| `canvas.backgroundColor` | no | `#FFFFFF` | The colour `cut` removes. |
| `canvas.layout` | no | `sticker-sheet` | `sticker-sheet`, `single-object`, `parts-sheet`. |
| `linework.outlineColor` | no | `none` | A colour, or `none` for lineless art. |
| `linework.outlineThickness` | no | `''` | Free text. For lineless art, describe how shapes separate. |
| `linework.wobble` | no | `none` | `none`, `subtle`, `medium`. |
| `shading` | no | flat fills, one shade step | Free text. |
| `shapeLanguage[]` | no | `[]` | Short phrases. |
| `palette[]` | no | `[]` | `name`, `hex` (`#RRGGBB`), `usage` (`background`, `outline`, `fill`, `shade`). |
| `renderingRules[]` | no | `[]` | One rule per item. |
| `bannedTraits[]` | no | `[]` | Written into the NEGATIVE PROMPT. |
| `detail` | no | `48`, `3`, `false` | `readableAtPx`, `maxFillColorsPerAsset`, `allowTinyDetails`. |

## Writing the body

Cover these, one short paragraph each: primary goal, core aesthetic, edges and
outlines, colour (with hex values), shading, view and proportion, detail
level, composition. Say what is not allowed as well as what is.

Use `style.additionalDetails` in `ukiyo.json` for small project notes. It is
appended to every prompt as `ADDITIONAL DETAILS:`. Use a target's `notes` for
one target.

## Background colour and cut-out

`canvas.backgroundColor` is what `cut` removes (flood fill from the edges in
`flood` mode). Subjects must not use a colour within `cutout.threshold` of it.
For subjects that need a colour close to the background, set `background` on
that target, or switch the project to chroma mode:
`"cutout": { "mode": "chroma", "chroma": "#00FF00" }` and
`canvas.backgroundColor: "#00FF00"`.

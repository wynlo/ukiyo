# Manifest reference

`art/manifest.json` (path set by `manifest` in `ukiyo.json`) is a JSON array of
targets. A target is one generated image. It yields one or more assets.

## Common fields

| Field | Required | Meaning |
|---|---|---|
| `target` | yes | Unique id. Lowercase letters, digits, dashes. Output folder name. |
| `compose` | yes | `sheet`, `single`, `strip`, `backdrop`, `parts`, `layer`. |
| `kind` | yes | Key in `ukiyo.json` `kinds`. Sets default height and anchor. |
| `game` | no | Atlas group. Default field for `atlas.groupBy`. |
| `height` | no | Override kind height, in board units. |
| `width` | no | Override kind width, in board units (backdrops). |
| `notes` | no | Extra prompt lines for this target only. |
| `size` | no | Output size hint, `WxH`, multiples of 16. |
| `tint` | no | Tint channel (`fur`, `fabric`). Prompt asks for white and light-grey fills. `final` makes fills neutral and keeps the outline. The atlas frame gets `tint`. |
| `stroke` | no | Outline width in final atlas px. `final` redraws the dark outline on its inner side so it has this width after the resize, whatever the target's scale. Isolated dark marks (eyes) do not change. Thin fills keep at least half their depth. Use one value for targets drawn together. |
| `strokeColor` | no | Outline colour for `stroke`, `#RRGGBB`. Default: the target's own outline colour. |
| `view` | no | `front`. Every style is front-facing; kept for older manifests. |
| `background` | no | Generate and cut on this solid colour instead of the style background. |

## Per compose

### sheet

Several assets in one image. One component per asset. Reading order.

```json
{ "target": "cafe-items-1", "compose": "sheet", "kind": "item", "game": "cafe",
  "category": "Cafe ingredients",
  "assets": ["tea leaf", "coffee bean", "milk bottle", "matcha tin"],
  "names": ["tea-leaf", "coffee-bean", "milk", "matcha"] }
```

`names` is optional; defaults to slugified `assets`. Frame names in the atlas
are `<target>/<name>`.

### single

One asset, centred. Frame name in the atlas is `<target>`.

```json
{ "target": "cafe-counter", "compose": "single", "kind": "furniture", "game": "cafe",
  "subject": "a wooden cafe counter with a small till and a cake dome", "height": 2.5 }
```

### strip

One character, N poses in a row. Frames are aligned on the kind anchor so they
do not jitter. Frame names are `<target>/<frame>`.

```json
{ "target": "cafe-guest-fox", "compose": "strip", "kind": "visitor", "game": "cafe",
  "subject": "a small round fox in a knitted scarf",
  "frames": ["idle", "step-a", "step-b", "sit"] }
```

Known frame names get a pose description automatically: `idle`, `step-a`,
`step-b`, `sit`, `happy`, `sleep`, `eat`, `wave`, `talk`. Any other name is used
as the pose text. `poses` (same length as `frames`) overrides.

### backdrop

A band that fills the canvas. No cut-out. Resized by width.

```json
{ "target": "cafe-wall", "compose": "backdrop", "kind": "backdrop", "game": "cafe",
  "subject": "warm wood-panel cafe wall with one window and a shelf line",
  "aspect": "3:1", "seamless": true }
```

### layer

Overlays for one shared base: outfits, hats, faces, patterns. Each layer is an
edit of the base shown in a flat marker colour (`baseTint`). ukiyo registers
the edit to the base (scale and translation), keeps the pixels that are new,
and writes the overlay at the base's scale. Its pivot is the base's anchor
point, so the pivot can be outside 0..1. Draw base and overlay at the same
position.

```json
{ "target": "crt-outfits-1", "compose": "layer", "kind": "visitor", "game": "critters",
  "base": "crt-body/body-front", "subject": "a round blob critter body, front view",
  "tint": "fabric", "order": 2,
  "layers": [ { "id": "apron-front", "label": "a simple apron" },
              { "id": "apron-back", "label": "the apron's back ties", "base": "crt-body/body-back" } ] }
```

- The base target must come earlier in the manifest and be finalised first.
- One layer target is one slot family. The Combinations tab picks at most one
  asset per layer target, so put hats and outfits in separate targets.
- `order` sets the draw order in the Combinations tab. The base is 0. Use a negative order for layers drawn behind it (ears, tails).
- `diffThreshold` (default 64) is the colour distance at which a pixel inside
  the base counts as new. Raise it when base-coloured noise stays in the overlay.
- `meta.json` records `registration` per layer: `iou` (fit, 0..1), `scale`,
  `coverage` (share of the base the overlay covers). `final` warns below 0.8.
- Rejected layer: `ukiyo redo <target> <id>`, then `ukiyo gen <target>` redraws
  only the missing layers. Manual path: `ukiyo import <file> --target <t> --asset <id>`.

### parts

A separated character-parts sheet for a skeletal rig. ukiyo does not rig. It
cuts the parts and scales them consistently.

```json
{ "target": "rig-fox", "compose": "parts", "kind": "visitor", "game": "cafe",
  "subject": "a small round orange fox in a knitted scarf", "rigType": "mascot",
  "reference": "cafe-guest-mika/idle",
  "parts": [ { "label": "head with face" }, { "label": "left ear" }, { "label": "right ear" },
             { "label": "body" }, { "label": "left arm" }, { "label": "right arm" },
             { "label": "left foot" }, { "label": "right foot" }, { "label": "tail", "required": false } ],
  "proportions": { "body": 0.92 }, "uniformFrom": "body", "height": 1.0 }
```

- `reference` (`<target>/<asset>`, a cut asset) makes the sheet an **edit** of
  the assembled character, so every part matches it.
- `uniformFrom` + `proportions`: one scale factor for all parts, chosen so the
  named part reaches its proportion of the kind height. Outline weight stays
  even. Another part listed in `proportions` gets its own height instead; set
  `stroke` so its outline stays even. Without `uniformFrom`, each listed
  proportion is applied per part.
- `names` overrides the output names in reading order.
- The prompt tells the model: head without ears, clothes on the body, small
  limbs with cut ends, true relative sizes, strict grid order.

## Kinds (in `ukiyo.json`)

```json
"kinds": {
  "backdrop":  { "width": 8,    "anchor": "top-left" },
  "furniture": { "height": 2,   "anchor": "bottom-center" },
  "visitor":   { "height": 1.5, "anchor": "bottom-center" },
  "item":      { "height": 0.75, "anchor": "center" },
  "icon":      { "height": 0.5, "anchor": "center" }
}
```

Final pixel size = units × `atlas.unit` × `atlas.scale`. With unit 64 and
scale 2, a 1.5-unit visitor is 192 px tall in the atlas and 96 CSS px on a
2x phone.

## Output layout

```
art/generated/<target>/
  raw.png            the generated image
  frames/<name>.png  per-asset regenerations (edit, animate)
  cut/<name>.png     cut out, background removed
  final/<name>.png   trimmed, aligned, resized
  meta.json          prompt, boxes, sizes, anchors, review status, notes
  sheet.png          contact sheet
  sheet.html         frame player
```

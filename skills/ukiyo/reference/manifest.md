# Manifest reference

`art/manifest.json` (path set by `manifest` in `ukiyo.json`) is a JSON array of
targets. A target is one generated image. It yields one or more assets.

## Common fields

| Field | Required | Meaning |
|---|---|---|
| `target` | yes | Unique id. Lowercase letters, digits, dashes. Output folder name. |
| `compose` | yes | `sheet`, `single`, `strip`, `backdrop`, `parts`, `layer`, `split`. |
| `kind` | yes | Key in `ukiyo.json` `kinds`. Sets default height, anchor and aspect. |
| `game` | no | Atlas group. Default field for `atlas.groupBy`. |
| `height` | no | Override kind height, in board units. |
| `width` | no | Override kind width, in board units (backdrops). |
| `aspect` | no | Override the kind's `aspect`: width:height of every final PNG of this target, e.g. `"16:9"`. For a backdrop this is also the generation aspect. |
| `notes` | no | Extra prompt lines for this target only. |
| `size` | no | Output size hint, `WxH`, multiples of 16. |
| `tint` | no | Tint channel (`fur`, `fabric`). Prompt asks for white and light-grey fills. `final` makes fills neutral and keeps the outline. The atlas frame gets `tint`. |
| `stroke` | no | Outline width in final atlas px. `final` redraws the dark outline on its inner side so it has this width after the resize, whatever the target's scale. Isolated dark marks (eyes) do not change. Thin fills keep at least half their depth. Use one value for targets drawn together. |
| `strokeColor` | no | Outline colour for `stroke`, `#RRGGBB`. Default: the target's own outline colour. |
| `view` | no | `front`. Every style is front-facing; kept for older manifests. |
| `background` | no | Generate and cut on this solid colour instead of the style background. |
| `references` | no | Reference images for this target: `<target>/<asset>` ids or file paths relative to `ukiyo.json`. An entry can be `{ "ref": "...", "role": "style" \| "proportions" \| "family" }` to set its role in the prompt. See "References". |
| `referencesMode` | no | `add` (default): the list is added to the project anchors and automatic picks. `replace`: only this list. `none`: no reference images. `--ref` still adds to all three. |
| `maxReferences` | no | The most reference images per call for this target. Overrides `references.max`. |
| `tags` | no | Free labels. Automatic picks can match on a shared tag (`references.auto.match`). |

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

A band that fills the canvas. No cut-out. Resized by width. Its `aspect` is
the declared aspect of the final PNG too. A seamless backdrop is never padded;
`final` warns when it does not match.

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

### split

Pieces of an approved asset, cut by mask so they keep its pixels, for props
whose pieces move on their own. Every coordinate is in px of the base's
final PNG, from its top-left.

```json
{ "target": "prop-bell-rope", "compose": "split", "kind": "furniture", "game": "props", "aspect": "1:1",
  "base": "shrine-feat-tall/bell-rope", "subject": "a golden bell with a rope under a wooden frame",
  "pieces": [
    { "id": "bell", "poly": [[244, 28], [268, 28], [268, 41], [300, 41], [300, 121], [212, 121], [212, 41], [244, 41]],
      "colors": ["#fcc83a", "#e39213"], "tolerance": 40, "seeds": [[256, 70]], "joint": [256, 34] },
    { "id": "rope", "box": [226, 116, 288, 256], "seeds": [[256, 160]], "joint": [256, 118], "parent": "bell" } ] }
```

- `base`: an asset of an earlier target, finalised first.
- A piece selects the pixels inside `box` and `poly` (both when both are
  set), near one of `colors` and not near one of `except` (within
  `tolerance`), in the connected regions that hold `seeds`. `fillHoles`
  (default true) adds pixels the selection encloses. A pixel belongs to the
  first piece that selects it.
- `joint`: the point the piece turns about.
- `cap`: joint cap radius in base px. The parent (or the plate, for a piece
  with no parent) keeps the piece's pixels within this distance of the
  joint. A disc turns onto itself, so a shoulder or elbow stays closed when
  the piece turns. Set it to about half the limb's width, and put the joint
  at the centre of the round end.
- `mode`: what the plate keeps under the piece.
  - `detach` (default): nothing, except `seam` px (default 2) along each cut
    where the piece touches art that stays. For a piece with only air behind it.
  - `cover`: the piece itself. For a piece that only glows, stretches over
    its own place or turns about its centre.
  - `fill`: the `plate` edit. Set `plate` to what to remove ("the paper
    strips"); ukiyo asks for an edit of the base without it, registers the
    edit and blends it in under the piece.
- `add`: `[{ "id", "label", "rest" }]`. A new thing drawn onto the base in the
  marker colour `baseTint`, kept by difference (`diffThreshold`) like a
  `layer`. Cut pieces from it with `"from": "<id>"`. `rest: false` drops what
  is left after its pieces are cut (edge noise from the edit).
- `z`: draw order (plate 0, pieces from 1 in list order). `parent`: another
  piece this one hangs from.
- Outputs: `plate` (when a piece leaves the base), each add with `rest`, then
  each piece. Each is cropped to its art and padded to the target's
  `aspect` about its centre. `meta.json` and the atlas frame record `part`
  (see "Multipart props" in `phaser.md`).
- `final` always rebuilds a split (it is quick), writes the registered edits
  to `registered/<id>.png` for checking, warns when the outputs do not rebuild
  the base, and sets an output whose pixels changed back to pending.

#### Multipart rules (`ukiyo plan`)

`ukiyo plan` writes `split` targets by rule. The rules live in `ukiyo.json`:

```json
"rig": {
  "prefix": "prop-", "group": "props", "aspect": "1:1", "stagger": 100,
  "groups": ["features"],
  "score": { "regions": [15, 45, 0.3], "protrusion": [0.02, 0.3, 0.4], "edges": [0.15, 0.45, 0.15], "components": [1, 4, 0.15] },
  "kinds": { "furniture": { "threshold": 0.3, "maxParts": 8 } },
  "materials": {
    "hanging": { "describe": "a thing that hangs from a hook or a cord: a lantern, a bell",
                 "pivot": "contact-top", "lag": 120,
                 "rest": { "kind": "swing", "amount": [0.8, 1.3], "periodMs": [3000, 4200] },
                 "use":  { "kind": "swing", "amount": [2.5, 4.5], "periodMs": [600, 900], "durationMs": [1600, 2400] } },
    "flame":   { "describe": "a candle flame", "pivot": "bottom", "mode": "cover",
                 "rest": { "kind": "flicker", "amount": [0.1, 0.14], "periodMs": [2400, 2800] } } } }
```

- `score`: each term is `[low, high, weight]`; the score is the weighted mean
  of each measure mapped from `low..high` to `0..1`.
- `kinds.<kind>.threshold`: sprites at or above it get a plan.
  `maxParts`: the most pieces a plan keeps (largest first).
- `materials.<name>`: `describe` is what the model looks for. `rest`, `use`
  and `gust` are motion bands (the game picks a value in each band per
  piece). `kind` is the project's own motion name; ukiyo copies it into the
  atlas. `pivot`: `contact-top`, `contact-bottom` or `contact` (where the
  piece touches the rest), or `top`, `bottom`, `center` of its own box.
  `contact-top` is the hook: the topmost point where the piece touches what
  it hangs from (the plate or its parent), near its vertical axis, not a
  neighbour at its side. Use it for everything that hangs.
  `mode` forces what the plate keeps; without it a piece that mostly touches
  air is `detach` and any other is `fill`. `lag`: ms per level of a chain.
  `phases`: copied to the game.
- `stagger`: ms between siblings of one material.
- `groups`: only plan assets of these atlas groups. `group`, `aspect`,
  `prefix`: for the split targets it writes.

How the plan cuts a piece:

- A `contact-top` piece (it hangs) may extend 20% past the model's box, and
  stops at colour boundaries. Its mask never takes the carrier (a rope, beam
  or post that runs through the box) or another labelled piece's body, and
  keeps its own cap, rim and cord. When `box` and `except` alone would select
  more, the plan writes the mask's outline as `poly`.
- `except` holds only colours of the carrier and of the other pieces that
  the piece does not have. A colour in the piece's own area is never
  excluded: for a hanging piece its body, cap, rim, cord and the art in its
  box nearer its seed than any other seed; for any other piece the art round
  its seed.
- Pieces with `locked: true` are cut first and the plan cuts round them.

Check a plan against the approved hand plans before you replace them:
`ukiyo plan <targets> --dry --ignore-locks --json`.

On a split target, pieces take `material` and an optional `motion`
override (`{ "rest": {...}, "use": {...}, "gust": {...} }`), and `locked:
true` keeps a piece through `ukiyo plan`. `plan` records `source` (`auto`
or `hand`), `score` and `locked` (keep the whole target). The plan's review
status is in the target's `meta.json` (`plan.status`).

#### Lights

Light points come from the art: one light per lit region, never placed by
hand. A game draws one glow per point.

```json
"rig": {
  "materials": {
    "lantern": { "describe": "a paper lantern that hangs and glows at night", "pivot": "contact-top", "emits": "body", "rest": { "kind": "swing", "amount": [0.8, 1.3] } },
    "light":   { "describe": "a lit window or paper panel", "pivot": "center", "mode": "cover", "emits": "lit" }
  },
  "lights": { "match": "lantern|toro|andon|candle", "lit": { "minValue": 0.9, "hue": [35, 75], "minSat": 0.25, "core": { "maxSat": 0.35, "minValue": 0.95 } },
              "body": { "minValue": 0.72 }, "open": 1, "minArea": 8, "minThick": 4, "minShare": 0.15 }
}
```

- `emits: "lit"`: one light per region drawn lit in the piece: bright
  (`lit.minValue`) and warm (`lit.hue`, `lit.minSat`), or pale and very
  bright (`lit.core`, a flame's core). Regions under `minArea` px, thinner
  than `minThick` px or under `minShare` of the largest in the piece are
  dropped, after the mask is opened by `open` px.
- `emits: "body"`: one light at the bright body of the piece (value at least
  `body.minValue`), for a paper lantern drawn unlit by day.
- `lights.match`: assets of the `rig.groups` atlases whose name or subject
  matches are light sources. One with no emitting split piece is searched as
  a whole for `lit` regions.
- Output: `ukiyo final` writes `lights` to `meta.json`; `ukiyo pack` writes
  them into each frame: `{ "x", "y", "radius", "color", "intensity",
  "piece" }`, `x` and `y` as shares of the content box, `radius` as a share
  of its width. A base frame carries the lights of its pieces cut from its
  own pixels, tagged with `piece`; lights on an `add` are on the piece only.
- Override, on any target, keyed by output (asset name or piece id), in px
  of the final PNG (for a split, of the base's final PNG, like joints):

  ```json
  "lights": { "window": { "locked": true, "points": [{ "x": 256, "y": 122, "radius": 18 }] } }
  ```

  A locked entry replaces what is found. `points: []` says the output gives
  no light.
- Review: the Plans tab draws the points, numbered, on the part plan and in
  the live preview. An asset with lights and no split has a light card; a
  rejected card packs no lights.

#### Wind and light review

Every sprite the rig rules cover gets a wind and light review. `ukiyo plan`
runs the pass on every asset of the `rig.groups` atlases, planned or not,
and `ukiyo plan --score` runs it without asking the model for labels.

```json
"rig": {
  "wind": { "materials": ["paper", "chime", "streamer", "hanging", "lantern", "stem", "canopy", "blade", "awning"] }
}
```

- `wind.materials`: the materials the wind moves. Stone, wood, metal,
  flames, water and lit panels are not in the list.
- The pass writes `effects` on the asset in `meta.json`:

  ```json
  "effects": { "wind": ["canopy", "paper"], "light": "none", "lights": 0, "lit": 7,
               "why": "split pieces of canopy, paper; ...", "hash": "…",
               "source": "plan", "status": "pending" }
  ```

  - `wind`: the wind materials of the pieces of its split. A sprite with no
    split takes the material of a trigger that matches its name (check it:
    "bell" also matches "belly"). `none` when nothing moves.
  - `light`: `art` for a light source (`lights.match`, or an emitting
    piece), with `lights` points found by `final`. `lit` counts regions that
    look lit to the detector, whatever the name. A warm palette gives many;
    the reviewer checks them for a lamp the rules missed.
  - `hash`: the final PNG when the pass ran. A regenerated sprite gets a new
    proposal. A review set by hand (`source: "hand"`) or approved is kept
    while the art is the same.
- Review: the Wind & light tab lists every sprite, pending first. Edit the
  wind materials or the light, then Approve, Reject or Save. An edit makes
  it a hand review.
- A game guard can require the review (the Hidamari Shrine project runs
  `tools/check-wind.mjs`).

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
- `rig` assembles the parts into a skeleton. `root` is the part every other
  part hangs from (the body). It is written as the plate; `pivot` is where it
  squashes and turns (default: its bottom centre). Each entry of `bones` gives
  `joint` (the pivot in the part's final px), `at` (where that joint sits in
  its parent's final px), `parent` (default: the root), `z` (draw order, the
  root is 0, negative draws behind it), `material`, and optional `mirror`
  (flip the part left to right) and `planted` (not attached to the root: feet
  stay on the ground when the body moves). `final` writes `part` like a
  split, so `pack` and the game read both the same way.
- `rig.animations` holds keyframed clips (`idle`, `attack`, ...). Each key
  gives a part's pose at `t` ms: `a` degrees about its joint, `dx`/`dy` px,
  `sx`/`sy` scale about its joint. Missing channels are the rest pose; keys
  ease in and out. The clips are written to the root part's
  `part.animations`.
- Rigs work best with few joints: a round body with floating hands and feet,
  and each held item as its own part attached to its hand. With a `rig`, the
  prompt asks for whole parts in the character's own view and colours.

  ```json
  "rig": { "root": "body", "bones": {
    "front-hand": { "joint": [29, 31], "at": [235, 204], "z": 3 },
    "weapon":     { "joint": [76, 108], "at": [29, 31], "parent": "front-hand", "z": 2 },
    "front-foot": { "joint": [34, 45], "at": [154, 258], "z": -1, "planted": true } },
    "animations": { "idle": { "durationMs": 1600, "keys": {
      "body": [{ "t": 0 }, { "t": 800, "sx": 1.03, "sy": 0.96 }, { "t": 1600 }] } } } }
  ```

## Kinds (in `ukiyo.json`)

```json
"kinds": {
  "backdrop":  { "width": 8,    "anchor": "top-left",      "aspect": "1:1" },
  "furniture": { "height": 2,   "anchor": "bottom-center", "aspect": "2:1" },
  "visitor":   { "height": 1.5, "anchor": "bottom-center", "aspect": "1:1" },
  "item":      { "height": 0.75, "anchor": "center",       "aspect": "1:1" },
  "icon":      { "height": 0.5, "anchor": "center",        "aspect": "1:1" }
}
```

The `aspect` values above are an example. Each project picks its own.

### Aspect ratio

`aspect` (optional, `"width:height"`) fixes the shape of every final PNG of
the kind. A target's `aspect` overrides it. Without one, the final keeps its
trimmed size. With one:

- `final` pads the PNG with transparent pixels to the ratio. It never
  stretches or crops. The padding follows the kind's `anchor`:
  `bottom-center` splits extra width evenly and puts extra height on top, so
  the ground contact stays at the bottom centre; `center` splits both evenly;
  `top-left` pads on the right and at the bottom. An even split is rounded up
  to an even number of pixels. A size matches when it is within 1 px of the
  ratio in either dimension.
- `final` without `--force` pads finals that already exist, in place.
- The frame pivot moves with the art, so `layer` overlays still register to
  their base.
- `meta.json` and the atlas frame record `content`: the art's box inside the
  padded frame (`{ x, y, w, h }` in the atlas). Fit an icon, a nine-slice or a
  rig's part sizes to `content`. Place a world object by the full frame.
- The prompt asks for the ratio, so new art needs little padding.
- `ukiyo status` lists finals that do not match; `ukiyo pack` warns.

Pick a ratio that suits most assets of the kind. For fixed-height kinds that
stand on the ground, a ratio at least as wide as the widest asset pads only at
the sides, so heights and ground points do not change.

Final pixel size = units × `atlas.unit` × `atlas.scale`. With unit 64 and
scale 2, a 1.5-unit visitor is 192 px tall in the atlas and 96 CSS px on a
2x phone.

## References (in `ukiyo.json`)

```json
"references": {
  "anchors": ["docs/references/style-anchor.png"],
  "firstTarget": false,
  "auto": { "max": 2, "match": ["kind"], "perTarget": 1 },
  "includePending": false,
  "max": 4,
  "maxImages": 5,
  "framing": true
}
```

| Field | Default | Meaning |
|---|---|---|
| `anchors` | `[]` | Sent with every call. File paths relative to `ukiyo.json`, or `<target>/<asset>` ids. Same entry forms as the manifest `references`. |
| `firstTarget` | `false` | Also send the first target's `ref.png`, else its `raw.png`. Skipped when that target has a rejected asset and no `ref.png`. |
| `auto.max` | `2` | The most automatic picks per call. `0` turns them off. |
| `auto.match` | `["kind"]` | Which assets qualify: `kind` (same kind), `group` (same atlas group), `tag` (a shared `tags` entry). |
| `auto.perTarget` | `1` | The most picks from one target, so the picks come from different sheets. |
| `includePending` | `false` | Automatic picks may use pending assets. `--pending-refs` sets it for one run. |
| `max` | `4` | The most reference images per call, not counting the input image of an edit. |
| `maxImages` | `5` | The most images per call in total, including the input image. Set it to what the provider accepts. |
| `framing` | `true` | Give the frame aspect, content box and game size of each asset reference in the prompt. |

Without a `references` section, ukiyo sends the first target's `ref.png` or
`raw.png` as the only reference, as before.

Order of the images in a call, and precedence when `max` cuts the list:

1. the input image of an edit (`edit`, `animate`, a `layer` or `split` edit, a
   `parts` sheet with `reference`);
2. `anchors`;
3. `--ref` on the command line;
4. the target's `references`;
5. the first target (`firstTarget`);
6. automatic picks.

Rules:

- Automatic picks are finals (`final/<asset>.png`) of `sheet`, `single`,
  `strip`, `backdrop` and `parts` targets. Overlays of `layer` targets and
  pieces of `split` targets are never picked. They are sorted by same kind,
  then same group, then shared tag, then same declared aspect, then the most
  recent approval (`reviewedAt`), then id. The same project state gives the
  same list.
- Approved assets only, unless `includePending` or `--pending-refs`. An
  explicit id (`anchors`, `references`, `--ref`) may be pending.
- A rejected asset is never sent, from any source. `ukiyo prompt` lists it
  under `not used`.
- A target never gets its own assets, and never the base it is an edit of
  (a layer's or a split's base is already the input image). `edit` and
  `animate` may use other assets of the same target through `--ref`.
- The same picture is sent once, even under two names (same SHA-256).
- An asset reference is sent flattened on the target's background, at the
  full size of its final PNG, so the model sees its frame.

The role in the prompt:

| Role | Given to | Prompt wording |
|---|---|---|
| `style` | files, the first target, assets of another kind and group | "is a style reference" |
| `proportions` | assets of the same kind | "match the proportions and framing of this asset", with its frame and size |
| `family` | assets of the same group or tag | "draw the new art in the same family as this asset" |

Per request, on `gen`, `all`, `edit`, `animate` and `prompt`:

| Flag | Effect |
|---|---|
| `--ref <ref>` | Add a reference. Repeatable, or comma-separated. |
| `--no-refs` | Send no reference images. An edit still sends its input image. |
| `--refs-only <ref>` | Send only these. Skips anchors, the manifest list, the first target and automatic picks. |
| `--max-refs <n>` | Override `max` for this run. |
| `--pending-refs` | Automatic picks may use pending assets. |

`plan` and `redo` generate no images and take no reference flags. Pass the
flags to the `gen` that follows a `redo`.

`meta.json` records the images of the last call as `references` on the target
and on each asset it made: `n` (position), `id`, `path`, `role`, `source`
(`edit`, `anchor`, `request`, `explicit`, `first-target`, `auto`), `status`
and `sha256` (first 16 hex digits). The review page shows them under each
asset and marks a file that changed since.

## Output layout

```
art/generated/<target>/
  raw.png            the generated image
  frames/<name>.png  per-asset regenerations (edit, animate)
  cut/<name>.png     cut out, background removed
  final/<name>.png   trimmed, aligned, resized, padded to the declared aspect
  meta.json          prompt, references, boxes, sizes, anchors, content boxes, review status, notes
  sheet.png          contact sheet
  sheet.html         frame player
```

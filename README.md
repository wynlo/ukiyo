# ukiyo

A CLI that turns a manifest of named sprites into reviewed, packed texture
atlases. It composes image prompts from your project's style file, generates
images, cuts sheets into sprites, removes backgrounds, aligns animation frames,
puts every sprite through a review page, and packs atlases for Phaser, React or
any engine that reads a JSON hash.

![ukiyo dashboard](docs/cli.png)

![A generated sheet cut into sprites](docs/pipeline.png)

## Requirements

- Node 22.12 or newer.
- One image provider:
  - `codex` (default): [Codex CLI](https://github.com/openai/codex) logged in
    with the `image_generation` feature on. Uses your ChatGPT plan, no API key.
  - `openai`: set `OPENAI_API_KEY`.
  - `manual`: run `ukiyo prompt <target> --copy`, generate the image in any
    tool, then bring it in with `ukiyo import`.

## Install

```bash
git clone https://github.com/wynlo/ukiyo.git
cd ukiyo
npm install
npm link            # puts `ukiyo` on PATH
```

Optional, for [Claude Code](https://claude.com/claude-code) users:

```bash
ukiyo skill install            # links the skill into ~/.claude/skills/ukiyo
ukiyo skill install --project  # or into ./.claude/skills/ukiyo
```

## Usage

In your game project:

```bash
ukiyo init --name "My Game"   # writes ukiyo.json, art/style.md, art/manifest.json
# describe your art in art/style.md
# list your sprites in art/manifest.json
ukiyo doctor
ukiyo all          # gen, cut, final, sheet; stops at the review gate
ukiyo review       # approve / reject / redo each asset in the browser
ukiyo pack         # approved assets only
```

Run `ukiyo` with no arguments for the dashboard.

### Review

`ukiyo review` opens a local page with every asset at 1x, 2x and 3x, and
inside a phone frame. Approve, reject or redo each one. `pack` only takes
approved assets.

![Review page](docs/review.png)

The Combinations tab draws each base with random layers and tints. Use it to
check that layered characters fit together.

![Combinations tab](docs/combinations.png)

### Prompts and checks

`ukiyo prompt <target>` prints the composed prompt. `ukiyo doctor` checks the
setup.

<p>
  <img src="docs/prompt.png" alt="ukiyo prompt" width="58%">
  <img src="docs/doctor.png" alt="ukiyo doctor" width="40%">
</p>

| Command | Description |
|---|---|
| `init [--name] [--force]` | Write `ukiyo.json`, a starter `art/style.md` and an example manifest. |
| `style` | Validate the style file and print it as JSON. |
| `prompt <target> [--copy] [--json]` | Print the composed prompt and the reference images a generation would send. |
| `prompts` | List prompt template versions. |
| `prompts eject [dir]` | Copy the active templates into the project to edit them. |
| `gen [targets] [--force]` | Generate raw images. Takes the reference flags. |
| `import <file> --target <t> [--asset <id>]` | Bring in an image generated elsewhere. Layer targets need `--asset`. |
| `animate [targets]` | Regenerate strip frames as edits of the first frame. Takes the reference flags. |
| `edit <target> <asset> "<instruction>"` | Iterate one asset. Takes the reference flags. |
| `cut [targets]` | Detect components, cut out, remove background. |
| `final [targets]` | Trim, align frames, resize to the kind height. |
| `sheet [targets] [--open]` | Contact sheet and frame player. |
| `review [--port]` | Serve the review page (the approval gate). |
| `status [--json]` | Status table. Exits 1 while anything is pending or rejected. |
| `pack [groups] [--allow-pending]` | Write atlases. |
| `all [targets]` | Every step up to the gate. Packs when everything is approved. Takes the reference flags. |
| `redo <target> [asset]` | Delete outputs so the next run regenerates them. |
| `doctor` | Check sharp, config, style, manifest, provider and skill. |
| `skill install [--project]` | Link the Claude Code skill. |

## Style file

The art direction for a project is in its `art/style.md`. ukiyo does not
include any styles. The file has YAML front matter (palette, linework, shading, rendering rules,
banned traits, background colour) and a Markdown body. The body goes into every
prompt as the STYLE section.

```markdown
---
name: Soft Paper
canvas:
  backgroundColor: "#FFFFFF"
linework:
  outlineColor: none
palette:
  - { name: Apricot, hex: "#F7BB5C", usage: fill }
bannedTraits: [outlines, realism, text]
---

STYLE LOCK: Warm cheerful sprites for a phone game with a flat top-down map.
...
```

The full field list is in
[`skills/ukiyo/reference/style.md`](skills/ukiyo/reference/style.md).

## Prompt templates

Prompt wording is in static template files under [`prompts/`](prompts/), one
folder per version (`prompts/v1/`). A project pins a version with
`prompts.version`, and each target's `meta.json` records the version used.
Released versions do not change. New wording goes into a new version folder.

To customise the wording for one project, run `ukiyo prompts eject`. It
copies the templates to `art/prompts` and sets `prompts.dir`. Files there
override the built-in files of the same name. See
[`prompts/README.md`](prompts/README.md).

## Configuration

`ukiyo.json` in the project root. Every path is relative to it. Every field
except `project.name` is optional.

```json
{
  "project": { "name": "My Game", "description": "Cozy idle game in a seaside town" },
  "style": { "file": "art/style.md", "additionalDetails": "" },
  "prompts": { "version": "v1" },
  "manifest": "art/manifest.json",
  "out": "art/generated",
  "provider": { "name": "codex", "gapMs": 8000, "model": "gpt-image-2", "effort": "low" },
  "cutout": { "mode": "flood", "threshold": 102, "feather": 1.5, "despill": true, "mergeGap": 14, "minArea": 400 },
  "atlas": { "dir": "public/assets/atlas", "groupBy": "game", "scale": 2, "unit": 64, "format": "phaser-hash" },
  "kinds": {
    "backdrop":  { "width": 8, "anchor": "top-left", "aspect": "3:1" },
    "furniture": { "height": 2, "anchor": "bottom-center", "aspect": "2:1" },
    "visitor":   { "height": 1.5, "anchor": "bottom-center", "aspect": "1:1" },
    "item":      { "height": 0.75, "anchor": "center", "aspect": "1:1" },
    "icon":      { "height": 0.5, "anchor": "center", "aspect": "1:1" }
  }
}
```

`kinds.<kind>.aspect` (optional, `"width:height"`) fixes the aspect ratio of
every final PNG of the kind. A target's `aspect` in the manifest overrides
it. `ukiyo final` pads each PNG with transparent pixels to the ratio,
anchored on the kind's `anchor`, and never stretches or crops. The atlas
frame's `sourceSize` then always has the declared ratio, so a game can place
art by its frame size and the placement stays right when the art is
regenerated. Each frame also carries `content`, the art's box inside the
padded frame. `ukiyo status` lists finals that do not match. Without `aspect`
a final keeps its trimmed size. The values are per project; ukiyo has no
defaults for them. See "Aspect ratio" in the
[manifest reference](skills/ukiyo/reference/manifest.md).

`style.additionalDetails` is appended to every prompt as `ADDITIONAL DETAILS:`.

`tints` (optional) lists sample colours per tint channel. The review page uses
them to preview tint-ready assets and random layer combinations:

```json
"tints": { "fur": ["#E8A866", "#9C8F84"], "fabric": ["#A7BFA3", "#EFD88B"] }
```

The manifest schema is in
[`skills/ukiyo/reference/manifest.md`](skills/ukiyo/reference/manifest.md).
Engine notes are in [`phaser.md`](skills/ukiyo/reference/phaser.md) and
[`react.md`](skills/ukiyo/reference/react.md).

## References

Every generation call sends reference images with the prompt, so new art
matches the project's approved art in style, size and framing. Configure the
project defaults in `ukiyo.json`:

```json
"references": {
  "anchors": ["docs/references/style-anchor.png"],
  "auto": { "max": 2, "match": ["kind"] }
}
```

- `anchors` are sent with every call.
- `auto` picks approved finals of the project: same kind first, then same
  atlas group, then same aspect, then the most recent approval. Rejected
  assets are never sent. A target never gets its own old images.
- The prompt names the role of each image (style reference, match the
  proportions and framing, same family) and gives the frame aspect, content
  box and game size of each asset reference.

A target in the manifest can add its own (`references`), or replace or turn
off the project list (`referencesMode`). Per request:

| Flag | Effect |
|---|---|
| `--ref <target/asset or path>` | Add a reference. Repeatable. |
| `--no-refs` | No reference images. An edit still sends its input image. |
| `--refs-only <refs>` | Only these. |
| `--max-refs <n>` | The most reference images for this run. |
| `--pending-refs` | Automatic picks may use assets that are not approved yet. |

`ukiyo prompt <target>` prints the list a generation would send, in order,
with ids, roles and hashes. On the manual path, attach those images in that
order. Each asset's `meta.json` records the list it was made with, and the
review page shows it.

Without a `references` section, ukiyo sends the first target's `raw.png` (or
`ref.png`) as the only reference, as before. The full schema and the selection
rules are under "References" in the
[manifest reference](skills/ukiyo/reference/manifest.md).

## Layered characters

To make many characters from a small set of assets, draw one shared base (a
body) and add items as `layer` targets. Each layer is an edit of the base. ukiyo registers
the edit to the base, keeps only the new pixels, and writes the overlay at the
base's scale with its pivot on the base's anchor point. An engine draws the
base and any overlays at the same position.

Set `tint` on the base and on layers to make them tint-ready: fills come out
neutral grey and the outline keeps its colour, so a multiply tint recolours
them. The atlas frame carries the tint channel.

## Multipart props

To make a prop whose pieces move on their own (a lantern on a hook, paper
strips on a rope, a canopy over a trunk) without redrawing it, add a `split`
target for an approved sprite. ukiyo cuts each piece from the sprite by a box,
a polygon, colours and seed points, so the piece keeps the approved pixels.
The base keeps a plate under the moving pieces: transparent where only air
was behind a piece, the piece itself for a piece that only glows or
stretches, or a generated edit with the piece removed. New pieces (a lantern
the sprite did not have) are `add` edits, found by difference like a layer.

Every output records its place on the base frame and the joint it turns
about (`part` in the atlas frame). Drawn at those offsets the outputs rebuild
the base; `ukiyo final` warns when they do not. See `split` in the
[manifest reference](skills/ukiyo/reference/manifest.md) and "Multipart
props" in [`phaser.md`](skills/ukiyo/reference/phaser.md).

## Multipart rules

`ukiyo plan` decides which sprites become multipart props and plans their
pieces by rule, so a project does not cut every prop by hand. The rules are
the project's: add a `rig` section to `ukiyo.json` (materials and their
motion, per-kind thresholds, score weights). ukiyo has no built-in values.

1. `ukiyo plan --score` measures every sprite's complexity from its pixels:
   colour regions, silhouette protrusion (things that hang or stick out),
   edge density and separate pieces. The score is written to `meta.json`.
2. `ukiyo plan [targets]` asks the model to label, for each sprite at or
   above its kind's threshold, the pieces that would move and their
   material. The answer is cached in `<split>/plan-labels.json`, so a re-run
   gives the same plan. The masks, modes, joints and chains are measured on
   the pixels (see "How a plan cuts a piece" below). The plan is written into
   the manifest as a `split` target with `plan.source: "auto"`. A target with
   `plan.locked` is kept as it is, and so is every piece with `locked: true`.
3. `ukiyo gen`, `cut` and `final` make the plate (when a piece has art behind
   it) and cut the pieces. Each piece frame gets a `rig` block: its material
   and motion bands.
4. The review page's Plans tab shows each plan with its pieces and joints
   and a live preview. Approve or reject the plan as a whole. A rejected plan
   never packs; an auto plan that nobody has approved packs only with
   `--allow-pending --allow-pending-plans`.

### How a plan cuts a piece

- A piece whose material has `pivot: "contact-top"` hangs: a lantern, a
  bell, a chime, paper on a rope. Its mask may extend 20% past the model's
  box on each side, and stops at colour boundaries. The mask never takes the
  carrier (a rope, a beam or a post that runs through the box) or the bodies
  of the other labelled pieces. It keeps the cap, rim and cord on the
  piece's body. When the box and `except` alone would select more than the
  mask (a cream lantern under a cream rope), the plan writes the outline of
  the mask as `poly`.
- `except` holds only colours of the carrier and of the other pieces that
  the piece does not have. A colour in the piece's own area is never
  excluded. For a hanging piece the own area is its body, cap, rim and cord,
  and the art in its box that is nearer its seed than any other seed. For
  any other piece it is the art round its seed, and `except` holds the
  colours round its box that the seed area does not have.
- The joint of a `contact-top` piece is the hook: the topmost point where the
  piece touches what it hangs from (the plate, or its parent piece), near
  the piece's vertical axis. A neighbour that touches it from the side is not
  a hook. A piece that touches nothing gets the top of its mask (the end of
  its cord).
- Pieces with `locked: true` are cut first, in manifest order, and the plan
  cuts round them. A label with the id of a locked piece is not planned
  again.
- `npm run check:plan` runs the planner checks on drawn scenes (a row of
  lanterns on a rope, a canopy on a trunk).

## Lights

Light points come from the art: one light per lit region (a lantern
window, a flame, a glowing paper panel, a firefly, a paper lantern's body),
never placed by hand.

- A material that gives off light sets `emits` in `rig.materials`: `lit`
  finds every region drawn lit (bright and warm, or the pale core of a
  flame); `body` gives one light at the bright body of a piece (a paper
  lantern drawn unlit).
- `ukiyo final` finds the regions on each emitting piece of a split, and on
  assets that match `rig.lights.match` but have no emitting piece. It writes
  them to `meta.json` (`lights`) and prints the count.
- `ukiyo pack` writes them into the atlas frame as `lights`: `x` and `y` as
  shares of the frame's content box, `radius` as a share of its width, plus
  `color`, `intensity` and, on a base frame, the `piece` that carries each
  light.
- A locked `lights` entry on a manifest target replaces what is found for an
  output; `points: []` says it gives no light.
- The review page's Plans tab draws the points, numbered, on each part plan
  and in its live preview, where they follow their piece. Assets with lights
  and no split get a light card to approve or reject; a rejected card packs
  no lights.

Detection values are in `rig.lights` (defaults in `src/ops/lights.ts`). See
"Lights" in the [manifest reference](skills/ukiyo/reference/manifest.md).

## Project layout

```
src/cli.tsx          commander entry, Ink screens
src/config.ts        ukiyo.json schema
src/style.ts         style file parser and the init starter
src/manifest.ts      manifest schema
src/prompt/          template loader and prompt composer
prompts/v1/          prompt templates (Handlebars)
src/providers/       codex, openai, manual
src/ops/             autocrop, complexity, cutout, crop, plan, raster, register, split, stroke, tint, pack, sheet
src/pipeline.ts      the steps
src/review/          review page server
src/ui/              Ink components
skills/ukiyo/        Claude Code skill
fixtures/            smoke test (npm run fixtures)
```

## Development

```bash
npm run typecheck
npm run build
npm run check:refs   # checks the reference selection rules on a temp project
npm run fixtures     # writes fixtures/out with fake generated images
cd fixtures/out
ukiyo cut && ukiyo final && ukiyo sheet && ukiyo review
```

## Troubleshooting

See [`skills/ukiyo/reference/troubleshooting.md`](skills/ukiyo/reference/troubleshooting.md).

## License

[MIT](LICENSE)

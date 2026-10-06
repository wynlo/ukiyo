---
name: ukiyo
description: "Use when a project needs game sprites, icons, backdrops, or frame animations made or updated with the ukiyo CLI: writing or editing art/manifest.json, generating art (Codex image_gen or pasted ChatGPT images), cutting sheets into sprites, running the review gate, packing atlases, or wiring ukiyo output into Phaser or React. Triggers: sprites, art pack, atlas, manifest, ukiyo, generate art, cut-outs, review sprites, frame strip, backdrop."
version: 0.1.0
---

# ukiyo

`ukiyo` is a CLI that turns a manifest of named sprites into reviewed, packed
atlases. It reads the project's style file, composes prompts, generates images
through the user's Codex CLI login, cuts sheets into sprites, removes backgrounds,
aligns animation frames, and packs atlases. Nothing is packed until the user
approves it on the review page.

Read `reference/style.md` before you edit `art/style.md`. Read
`reference/manifest.md` before you edit a manifest. Read
`reference/troubleshooting.md` when a step fails.

## Rules

1. Never call `codex` or an image API directly. Use `ukiyo gen`, `ukiyo animate`,
   or `ukiyo edit`.
2. Never run `ukiyo pack` while `ukiyo status` reports pending or rejected assets,
   unless the user asked for a throwaway preview (`--allow-pending`).
3. The review gate is the user's decision. Show the assets, stop the turn, wait.
4. Do not hand-draw replacement art. If a sprite is wrong, change its subject,
   add a note in `additionalDetails`, and regenerate.
5. Keep `art/generated/` in git. `review`, `redo` and `pack` read from it.
6. Every new object gets a wind and light review through `ukiyo plan`. Do not
   leave it implicit, and do not approve it for the user.
7. Lights come from the art. Never place a light point by hand in game code.
   A light source gets one light per lit region (a window, a flame, a paper
   panel, a lantern body), found by `ukiyo final` from the `emits` materials
   and `rig.lights`, and packed into the frame as `lights`. A wrong point is
   fixed in the rules or with a locked `lights` entry in the manifest. See
   "Lights" in `reference/manifest.md`.

## Procedure

### 1. Preflight

```bash
ukiyo doctor
```

If there is no `ukiyo.json`:

```bash
ukiyo init --name "<project>"
```

`init` writes a starter `art/style.md`. Write it with the user before you
generate anything. The Markdown body is the STYLE text in every prompt. The
front matter holds the palette, linework, rendering rules and banned traits. See `reference/style.md`.
If the project already has an art bible, copy its rules into the style file.
Run `ukiyo style` to validate it.

Prompt wording comes from ukiyo's versioned templates (`prompts.version`,
default `v1`). Do not edit files in ukiyo's `prompts/` folder for one project.
Run `ukiyo prompts eject` and edit the copies in the project instead.

For a lineless style (`linework.outlineColor: none`), do not set `stroke` on
targets: `stroke` draws a dark outline.

### 2. Write the manifest

Edit `art/manifest.json`. One entry per target. See `reference/manifest.md` for
the schema. Rules:

- `sheet`: 4 to 8 assets of one `kind` per sheet. Name assets with one noun
  phrase each ("tea leaf", "round oak table with two chairs").
- `strip`: one character, frames in order, `idle` first. Use 3 or 4 frames.
- `single`: one asset wider than 2 units, or anything that must be large.
- `backdrop`: a background band or seamless ground texture. Set `aspect`.
- `layer`: overlays (outfits, hats, faces) for one shared base. One target per
  slot family. The base target comes first and is finalised first. Set `tint`
  when the game colours it at runtime.
- `split`: moving pieces of an approved asset (a lantern on a hook, paper
  strips, a canopy), cut by mask so they keep its pixels. Set a `joint` per
  piece. Use `plate` for a piece with art behind it, `add` for a new piece.
  `ukiyo final` rebuilds it every run; check `registered/` and the warnings.
- Subjects: front view, no text, no colours close to the style background.
- Set `game` (or the configured `groupBy` field) on every target. One atlas per
  group.

### 3. Generate

```bash
ukiyo gen --all
```

Every call sends reference images with the prompt. See "References" below.
On a rate-limit pause the CLI waits and retries by itself. Do not run it again
in parallel.

Manual path (no Codex): `ukiyo prompt <target> --copy`, paste into ChatGPT,
attach the images listed under `IMAGES TO ATTACH` in that order, save the PNG,
then `ukiyo import <file> --target <target>`.

### References

Each generation call (`gen`, `all`, `edit`, `animate`, and the edits of
`layer` and `split` targets) sends reference images with the prompt. The
prompt names the role of each image: a style reference, an asset whose
proportions and framing to match (same kind), or an asset of the same family
(same atlas group or tag). For an asset reference the prompt also gives its
frame aspect, how much of the frame the art fills, and its size in the game.
`meta.json` records the list with file hashes, and the review page shows it
under each asset.

The list, in order:

1. the input image of an edit;
2. `references.anchors` in `ukiyo.json` (the style anchor);
3. `--ref` on the command line;
4. `references` on the target in the manifest;
5. the first target's `ref.png` or `raw.png`, when `references.firstTarget` is
   true (the only reference when `ukiyo.json` has no `references` section);
6. automatic picks: approved finals of the same kind, then the same group,
   then the same aspect, then the most recent approval.

Rejected assets are never sent. A target never gets its own old images.

Check the list before you generate:

```bash
ukiyo prompt <target>            # prompt, then IMAGES TO ATTACH with ids, roles and hashes
ukiyo prompt <target> --json     # the same for a script
```

Add a reference when:

- a new asset must match one existing asset closely (a second lantern next to
  an approved one): `--ref shrine-feat-tall/stone-toro`;
- a new kind has no approved assets yet: point it at the nearest approved
  asset with `references` on the target;
- the user gives an image: `--ref path/to/image.png`.

Drop references when:

- the prompt asks for a different look on purpose (a UI icon set in a world
  style project): `referencesMode: "replace"` on the target, with its own list;
- the model copies the subject of a reference into the new image:
  `--max-refs 1`, or `--refs-only <anchor>`;
- the call is an exact edit that must keep the input as it is and the result
  drifts: `--no-refs`.

Use `--pending-refs` only when the user wants to match art that is not
approved yet. Do not add `references` to hide a bad style file: fix
`art/style.md` instead.

### 4. Process

```bash
ukiyo cut
ukiyo final
ukiyo sheet
```

`cut` prints a warning when the detected component count differs from the
expected count. Open that target's `sheet.html` and check the boxes before
moving on. `ukiyo cut <target> --force` re-cuts after changing `cutout` settings
in `ukiyo.json`.

### 4b. Multipart rules

New complex art goes through `ukiyo plan`, not through hand-cut pieces.

1. The project's `ukiyo.json` needs a `rig` section: materials with their
   motion and pivot rule, per-kind `threshold` and `maxParts`, and score
   weights. See "Multipart rules" in `reference/manifest.md`. Do not add
   materials or values to ukiyo itself.
2. `ukiyo plan --score` to see the scores; `ukiyo plan <target>` to plan.
3. Read the output: dropped labels and "nothing moves" are normal. Then
   `ukiyo gen <split>` (only for plans with `fill` pieces), `cut`, `final`.
4. Show the Plans tab of `ukiyo review` to the user and stop. A plan they
   reject does not pack.
5. To tune one plan by hand, edit its pieces and set `locked: true` on them,
   or `plan.locked` on the target. `ukiyo plan` keeps them.
6. Lights: label a paper lantern `lantern` and a lit window, panel or flame
   `light` or `flame` (materials with `emits`). `ukiyo final` prints the
   light count per target; check it against the lit regions you can count
   in the art, then show the points on the Plans tab with the plan.
7. Wind and light review: every new or regenerated sprite gets one. After
   `ukiyo final`, run `ukiyo plan --score` (or `ukiyo plan`). It writes
   `effects` into `meta.json`: the wind materials that move the sprite (or
   `none`) and whether its light comes from the art. Check the proposal:
   keyword triggers can match inside other words. Show the Wind & light tab
   of `ukiyo review` to the user with the plans and stop. See "Wind and
   light review" in `reference/manifest.md`.

### 5. Review gate (required)

```bash
ukiyo review
```

The page shows every asset at 1x, 2x, and 3x with a phone frame, plays strips,
and shows the raw sheet with detected boxes. Take screenshots of the page (one
per target group is enough) and send them to the user. Then stop the turn.

When the user approves or rejects on the page, `meta.json` is updated. For a
rejection with a note:

- Wrong subject or detail: edit the subject or add `notes` on the target, then
  `ukiyo redo <target> <asset>` and `ukiyo gen <target> --force` for singles,
  or `ukiyo edit <target> <asset> "<instruction>"` for one asset on a sheet.
- Wrong pose in a strip: `ukiyo animate <target> --force`.
- Bad cut: adjust `cutout.threshold` or `cutout.mergeGap`, then
  `ukiyo cut <target> --force`.
- Bad layer: `ukiyo redo <target> <id>`, then `ukiyo gen <target>`, `cut`,
  `final`. Check the Combinations tab after every layer batch.

Re-run `ukiyo final` and `ukiyo review` after any change.

### 6. Pack and wire

```bash
ukiyo status
ukiyo pack
```

`status` exits 1 while anything is pending or rejected. `pack` writes
`<atlas.dir>/<group>.png` and `.json` (TexturePacker JSON hash with `pivot` per
frame). Engine notes: `reference/phaser.md`, `reference/react.md`.

### 7. Report

State what was generated, what is approved, what is pending or rejected, and
the atlas sizes. Do not restate the procedure.

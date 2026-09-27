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
- Subjects: front view, no text, no colours close to the style background.
- Set `game` (or the configured `groupBy` field) on every target. One atlas per
  group.

### 3. Generate

```bash
ukiyo gen --all
```

The first target in the manifest becomes the style reference for every later
call. Put a representative sheet first. On a rate-limit pause the CLI waits and
retries by itself. Do not run it again in parallel.

Manual path (no Codex): `ukiyo prompt <target> --copy`, paste into ChatGPT,
save the PNG, then `ukiyo import <file> --target <target>`.

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

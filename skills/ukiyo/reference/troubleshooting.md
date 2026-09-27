# Troubleshooting

## `ukiyo doctor` fails on codex

- `codex is not on PATH`: `npm i -g @openai/codex`.
- `not logged in`: run `codex login` in a terminal (the user must do this).
- `image_generation feature is off`: `codex features enable image_generation`.

## `codex produced no image`

The relay agent did not call the tool. Read the last lines in the error. Usual
causes: the prompt tripped a content check (change the subject wording), or
Codex asked a question instead of acting. Re-run `ukiyo gen <target> --force`.
If it repeats, set `provider.effort` to `medium` in `ukiyo.json`.

## Rate or usage limit

The CLI waits (30 s, then 60 s, then 90 s) and retries three times, then stops
the queue. Wait, then run the same command again. It only does missing work.

## Detected N components, expected M

Open `art/generated/<target>/sheet.html` or the review page and look at the
boxes on `raw.png`.

- Too many boxes: two parts of one asset are separated (a cup and its saucer).
  Raise `cutout.mergeGap` (14 → 24) and `ukiyo cut <target> --force`.
- Too few boxes: assets touch. Lower `cutout.mergeGap`, or regenerate with
  `notes: "leave twice as much space between assets"`.
- Specks: stray dots become boxes. Raise `cutout.minArea`.

## Cream or green fringe around a sprite

Raise `cutout.threshold` (102 → 130) or `cutout.feather` (1.5 → 2.5), keep
`despill: true`, then `ukiyo cut <target> --force`.

## Part of the sprite was removed

The subject contained a colour close to the background. Lower
`cutout.threshold`, or switch the whole project to chroma mode (see
`style.md`).

## Strip frames drift (size or design changes between frames)

Run `ukiyo animate <target> --force`. It regenerates every frame after the
first as an edit of the first frame, so the design stays the same.

## Frames jitter when played

`final` aligns frames on the kind anchor. If the anchor is `center` for a
walking character, feet will move. Set the kind anchor to `bottom-center`.

## Atlas overflow

`pack` reports `(overflow)` for frames that did not fit `atlas.maxSize`.
Raise `maxSize` to 8192 or split the group with a different `game` value.

## Review page shows nothing

`ukiyo review` serves from `art/generated`. Run `ukiyo cut` first. The page
lists targets that have a `meta.json` or a `raw.png`.

## Layer: weak registration or no new pixels

`final` warns when a layer edit does not line up with its base (fit below 0.8)
or when nothing new was found.

- Weak fit: the model moved, reshaped or recoloured the body. Redo the layer.
  If it repeats, add `notes: "do not change the body at all"`.
- No new pixels: the item is too close to the marker colour. Change `baseTint`
  to a colour far from the item, or lower `diffThreshold`.
- Body-coloured fringe in the overlay: raise `diffThreshold` (64 → 90).
- Parts of the item missing where it covers the body: lower `diffThreshold`.

# Wiring an atlas into Phaser

`ukiyo pack` writes `<atlas.dir>/<group>.png` and `<group>.json` in the
TexturePacker JSON hash format. Each frame carries `pivot` (0..1 fractions),
which Phaser applies as a custom pivot.

## Load

```ts
preload() {
  this.load.atlas('cafe', '/assets/atlas/cafe.png', '/assets/atlas/cafe.json');
}
```

## Draw

```ts
// Frame names: "<target>/<asset>" for sheets and strips, "<target>" for single and backdrop.
const counter = this.add.image(x, y, 'cafe', 'cafe-counter');
counter.setOrigin(0.5, 1); // or read pivot from the JSON meta

const fox = this.add.sprite(x, y, 'cafe', 'cafe-guest-fox/idle').setOrigin(0.5, 1);
this.anims.create({
  key: 'fox-walk',
  frames: [{ key: 'cafe', frame: 'cafe-guest-fox/step-a' }, { key: 'cafe', frame: 'cafe-guest-fox/step-b' }],
  frameRate: 6,
  repeat: -1,
});
fox.play('fox-walk');
```

## Scale

The atlas is authored at `atlas.scale` (default 2). Either render the canvas
at device pixel ratio and use frames 1:1, or `setScale(1 / atlas.scale)` on
each sprite. Do not use `pixelArt: true`. The sprites are smooth raster art, not pixel art.

## Reading pivots from the JSON

```ts
const json = this.cache.json.get('cafe-json'); // load the .json separately as 'cafe-json' if needed
const frame = json.frames['cafe-guest-fox/idle'];
sprite.setOrigin(frame.pivot.x, frame.pivot.y);
```

Phaser also sets `frame.customPivot` when `pivot` is present, so
`sprite.setOrigin()` with no arguments uses it.

## Content box

A frame of a target with a declared `aspect` is padded with transparent
pixels to that ratio. The frame's `content` (`{ x, y, w, h }` in frame px) is
the art's box inside it. Phaser copies it to `frame.customData.content`:

```ts
const content = sprite.frame.customData.content; // { x, y, w, h }
const fit = 24 / Math.max(content.w, content.h);   // fit the art, not the padding
```

Place a sprite by the full frame. Fit an icon, a nine-slice or a rig's part
sizes to `content`.

## Multipart props

The outputs of a `split` target carry `part` in their atlas frame:

```json
"prop-bell-rope/bell": { "frame": { "x": 265, "y": 192, "w": 99, "h": 99 }, "...": "...",
  "part": { "base": "shrine-feat-tall/bell-rope", "baseWidth": 513, "baseHeight": 256,
            "x": 207, "y": 26, "joint": { "x": 49, "y": 8 }, "z": 1, "role": "piece", "mode": "detach" } }
```

- `base`, `baseWidth`, `baseHeight`: the frame it was cut from, and its size.
- `x`, `y`: this frame's top-left on the base frame, in base px.
- `joint`: the point the piece turns about, in this frame's px.
- `z`: draw order. The plate is 0; negative draws behind it.
- `role`: `plate` (the base without its moving pieces), `add` or `piece`.
- `mode`: what the plate keeps under the piece (see the manifest reference).
- `parent`: the piece this one hangs from.

Draw a prop as a container at the base sprite's position. Put each output at
its offset from the base's centre, turn it about its joint, and nest a
piece's children in a group so they turn with it:

```ts
const k = 1 / atlasScale; // world px per atlas px
const cx = (part.x + frame.w / 2 - part.baseWidth / 2) * k;
const cy = (part.y + frame.h / 2 - part.baseHeight / 2) * k;
const piece = scene.add.image(cx, cy, key, name).setScale(k);
// turn about the joint: offset from the piece's centre
const jx = (part.joint.x - frame.w / 2) * k;
const jy = (part.joint.y - frame.h / 2) * k;
```

A piece with a `material` also carries `part.rig`: its material's motion
bands and chain lag, so a game can move it with no per-prop code:

```json
"rig": { "material": "hanging", "lag": 120, "stagger": 100,
         "rest": { "kind": "swing", "amount": [0.8, 1.3], "periodMs": [3000, 4200] },
         "use":  { "kind": "swing", "amount": [2.5, 4.5], "periodMs": [600, 900], "durationMs": [1600, 2400] } }
```

Pick a value in each band per piece (seeded by the frame name, so pieces of
one material never move in step). Start a piece's `use` impulse `lag` ms per
level of its chain after the root, plus `stagger` ms per sibling of the same
material. `kind` is the project's own motion name: map it to your engine's
loops (swing to a pendulum, flicker to a quick scale, glow to an add-blend
alpha). Find a sprite's prop by its frame: the pieces whose `part.base` is
that frame.

When a split has no `plate` output (every piece is `cover`), draw the base
sprite under the pieces. Bake a shadow or a hit box from the base sprite, not
from the pieces, so they do not move with a piece.


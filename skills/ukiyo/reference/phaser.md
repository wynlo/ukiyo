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

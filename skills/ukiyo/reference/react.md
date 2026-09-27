# Using atlas frames in the DOM (React)

Read the atlas JSON once and crop a frame with `background-position`.

```tsx
type Frame = { frame: { x: number; y: number; w: number; h: number } };
type Atlas = { frames: Record<string, Frame>; meta: { image: string; size: { w: number; h: number }; scale: string } };

export function AtlasSprite({ atlas, url, name, height }: { atlas: Atlas; url: string; name: string; height: number }) {
  const f = atlas.frames[name];
  if (!f) return null;
  const scale = height / f.frame.h;
  return (
    <span
      role="img"
      aria-label={name}
      style={{
        display: 'inline-block',
        width: f.frame.w * scale,
        height,
        backgroundImage: `url(${url})`,
        backgroundPosition: `${-f.frame.x * scale}px ${-f.frame.y * scale}px`,
        backgroundSize: `${atlas.meta.size.w * scale}px ${atlas.meta.size.h * scale}px`,
        backgroundRepeat: 'no-repeat',
      }}
    />
  );
}
```

Or use `atlas.format: "folder"` in `ukiyo.json` to get one PNG per frame and
render them with `<img>`.

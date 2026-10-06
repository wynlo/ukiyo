TASK:
You are planning a game prop whose pieces move on their own. The attached image is one sprite: {{subject}}. A grid is drawn over it, with a line every tenth of the width and the height, labelled 0.1 to 0.9. Give every coordinate as a fraction of the image width (x) or height (y), from 0 to 1, with three decimals, read against the grid.

List the pieces of this sprite that would move by themselves in a calm, cozy game, and say what each is made of. Use only these materials:
{{#each materials}}
- {{name}}: {{describe}}
{{/each}}

RULES:
- A piece is a clearly separate thing in the picture: a lantern on a hook, a paper strip on a rope, a canopy over a trunk, a flame on a candle. Never list the main body, a frame, a post, a trunk, walls, a roof, a base or anything made of stone.
- List at most {{maxParts}} pieces. List none when nothing would move.
- `box` is `[left, top, right, bottom]` around the whole piece, as fractions. Keep it tight. It must not cover other pieces.
- `seed` is `[x, y]` as fractions: one point well inside the piece, on its own colour.
- `hangsFrom` is the label of another listed piece this one hangs from (a rope under a bell), else null.
- Labels are short nouns in English, unique, like "lantern", "left shide", "canopy".

Answer with JSON only, no other text:
{"parts": [{"label": "...", "material": "...", "box": [0.000, 0.000, 0.000, 0.000], "seed": [0.000, 0.000], "hangsFrom": null}]}

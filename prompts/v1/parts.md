TASK:
Create a production-ready separated character-parts sheet for a cozy mobile game: the character below taken apart into its pieces, each piece drawn alone.
{{#if reference}}
Take apart the EXACT character in the attached image: same colours, same face, same clothes, same outline. Do not redesign it.
{{/if}}

{{> head}}

CHARACTER:
{{subject}}

RIG TYPE:
{{rigType}}

SELECTED PARTS:
{{#each parts}}
- {{label}} ({{#if required}}required{{else}}optional{{/if}}{{#if pivotHint}}; pivot near {{pivotHint}}{{/if}})
{{/each}}

{{#if rigged}}
PART RULES (skeleton rig):
Every part is drawn in the SAME view, angle and style as the assembled character, so the parts fit back together. Each part is drawn ONCE, alone, whole and closed, exactly as it looks on the character.
Where one part covers another on the character, draw the covered area too, so each part is whole and has no hole or flat cut.
Hands and feet are drawn whole and round, the same size as on the character.
When a held item is listed as its own part, the hand is an empty closed fist and the item is drawn alone, whole, upright, at its true size.
Every colour on a part is a colour the character has in that same place. Do not add joints, balls, stubs, sockets or skin that the character does not show.
Keep TRUE RELATIVE SIZES, exactly as on the assembled character. Do not enlarge small pieces to fill their cell.

{{else}}
PART RULES:
Each part is drawn ONCE, alone, complete and closed, exactly as it appears on the assembled character.
The head piece has NO ears attached; the ears are their own pieces. The head keeps its face, cheeks and any hat or glasses the character wears.
The body piece is the torso ONLY: a rounded blob with NO head, NO arms, NO legs, NO feet, NO paws and NO tail attached. Its bottom edge is ONE smooth convex curve with no bumps, notches or leg stubs. Any clothing (scarf, apron, overalls, collar, satchel) is drawn ON the body piece as part of it, never as a separate piece.
Each leg piece is a short stubby leg ending in a paw or foot, drawn upright, with a flat cut end at the top where it meets the body. Each arm piece is a short stubby arm with a flat cut end at the top. The tail has a flat cut end at its base.
Keep TRUE RELATIVE SIZES: the body and head are the big pieces; an ear is about a third of the head; an arm or foot is about a quarter of the body. Do not enlarge small pieces to fill their cell.
{{/if}}

CANVAS AND LAYOUT:
{{> canvas}}
Parts-sheet layout: a 3-column grid, one part per invisible cell, filled in reading order (left to right, then top to bottom) in EXACTLY the order the parts are listed above. The first listed part is top-left; the last is bottom-right. Do not rearrange for looks.
Large crop-safe gutters between cells. No part touches another. Do not show the assembled character.
No labels, text, numbers, arrows, scene, or decorative filler.
{{#unless rigged}}Draw each part front-facing, as it appears on the assembled character.{{/unless}}
{{> tint}}

{{> negative}}

FINAL CHECK:
{{#if rigged}}Every listed part is present once, fully separated, whole, in the character's view and colours, at true relative size, and crop-safe, with no added joints, stubs or skin.{{else}}Every listed part is present once, fully separated, closed, rounded, at true relative size, and crop-safe. The head has no ears. The body is a plain torso blob with a smooth bottom edge and no legs or paws. Legs are separate pieces.{{/if}}
{{> additional}}

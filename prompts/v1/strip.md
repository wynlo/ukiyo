TASK:
Create one animation frame strip of a single game character: {{subject}}.
Draw the SAME character exactly {{frames.length}} times in one horizontal row, one pose per frame, in this order:
{{#each frames}}
{{n}}. {{name}}: {{pose}}
{{/each}}

{{> head}}

CANVAS AND LAYOUT:
{{> canvas}}
{{frames.length}} frames in a single horizontal row, evenly spaced, same size, same camera, same scale, feet on one shared invisible baseline.
Keep every frame isolated with wide crop-safe gaps. Frames must not touch.
No labels, numbers, text, ground line, scene, or decorative filler.

CHARACTER RULES:
Identical design in every frame: same colours, same {{#if style.lineless}}edges{{else}}outline weight{{/if}}, same proportions, same accessories.
Only the pose changes. Keep the head size constant.
{{> outline}}
Face the viewer or turn three-quarter.
{{> tint}}

{{> negative}}

FINAL CHECK:
Exactly {{frames.length}} frames of one identical character, in order, separate and crop-safe.
{{> additional}}

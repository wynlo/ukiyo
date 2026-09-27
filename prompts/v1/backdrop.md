TASK:
Create one game backdrop band: {{subject}}.

{{> head}}

CANVAS AND LAYOUT:
Output size {{size}}, aspect {{aspect}}.
The picture fills the whole canvas edge to edge. No border, no margin, no vignette.
{{#if seamless}}
The left and right edges must tile seamlessly: the pattern continues without a visible seam when repeated horizontally.
{{/if}}
Flat, front-facing, straight on. No characters, no props that were not asked for, no text.

RENDERING:
{{> shading}}
{{#if style.lineless}}No outlines.{{else}}Soft outlines only where an object needs one.{{/if}}
Keep detail low and even so sprites placed over it stay readable.

{{> negative}}

FINAL CHECK:
Whole canvas filled, straight-on view, {{#if seamless}}seamless left-right, {{/if}}no text.
{{> additional}}

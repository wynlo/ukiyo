TASK:
Redraw the attached image EXACTLY, and add one thing: {{label}}.

The attached image is {{subject}}, drawn in a flat marker colour.

RULES:
- Keep the character's shape, size, position, pose and camera exactly the same. Do not move, resize, rotate or redraw it.
- Keep the character's body in exactly the same flat marker colour {{baseTint}}. Only the added item has new colours.
- The added item sits on the character naturally and follows its outline. It may extend past the outline where the item needs to (a hat above, a coat hem below the body).
{{#if tint}}
{{#if style.lineless}}
- Draw the added item in perfectly flat white and very light grey only, with no outline and no grain. No other colours: the game colours it at runtime.
{{else}}
- Draw the added item in white and very light grey only, with the dark-brown outline and small dark details. No other colours: the game colours it at runtime.
{{/if}}
{{else}}
- Colour the added item from the style palette.
{{/if}}
- {{> outline tail="like the rest of the art."~}}
- Keep the solid flat background {{background}}. Nothing new may use a colour close to it or to {{baseTint}}.
- No text, no labels, no second character, no extra props.

{{> style}}

FINAL CHECK:
Same character, same place, same marker colour, with exactly one added item: {{label}}.
{{> additional}}

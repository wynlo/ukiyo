REFERENCE IMAGES:
{{#if input}}
Image 1 is the image to edit. The other attached images are references only. Do not copy their subjects into the new image.
{{else}}
The attached images are references only. Do not copy their subjects into the new image.
{{/if}}
{{#each refs}}
{{#if style}}
- Image {{n}} ({{name}}) is a style reference. Match its palette, edge treatment, shading and level of detail.
{{/if}}
{{#if proportions}}
- Image {{n}} ({{name}}): match the proportions and framing of this asset{{#if framing}}. It sits in {{framing}}{{/if}}. Match its palette, edge treatment and level of detail too.
{{/if}}
{{#if family}}
- Image {{n}} ({{name}}): draw the new art in the same family as this asset: same palette, shape language and level of detail{{#if framing}}. It sits in {{framing}}{{/if}}.
{{/if}}
{{/each}}
{{#if own}}
The new art: {{own}}. Keep its size relative to the references in the same ratio as their sizes in the game.
{{/if}}

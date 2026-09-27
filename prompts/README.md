# Prompt templates

Every prompt ukiyo sends is built from the files in this folder. Each folder
(`v1`, `v2`, ...) is one version. A project selects a version with
`prompts.version` in `ukiyo.json` (default `v1`), and each target's
`meta.json` records the version it was generated with.

## Files

| File | Used for |
|---|---|
| `sheet.md`, `single.md`, `strip.md`, `backdrop.md`, `parts.md`, `layer.md` | `ukiyo gen`, one per compose mode |
| `edit.md` | `ukiyo edit` and `ukiyo animate` |
| `frame.md` | The per-frame instruction for `ukiyo animate` |
| `codex-relay.md` | The wrapper sent to Codex around every image prompt |
| `_*.md` | Partials, included with `{{> name}}` (file name without `_`) |
| `poses.json` | Default pose text per strip frame name |

Templates use [Handlebars](https://handlebarsjs.com/guide/) with HTML
escaping off. Runs of blank lines are collapsed and the result is trimmed.
`ukiyo prompt <target>` prints the rendered prompt.

## Versioning

- Do not change the wording of a released version. Generated art in projects
  depends on it, and `redo` must reproduce the same prompt.
- To change wording, copy the latest folder to the next version, edit the
  copy, and note the change in the table below.
- Fixes that do not change the rendered text (comments, whitespace that is
  collapsed anyway) may go into an existing version.

| Version | Changes |
|---|---|
| `v1` | First template release. |

## Overriding in a project

```bash
ukiyo prompts eject            # copies the active version to art/prompts and sets prompts.dir
```

A file in `prompts.dir` replaces the built-in file of the same name. Delete
the files you did not change so they keep following the built-in version.

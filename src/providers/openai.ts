import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GenerateOptions, ImageProvider } from './types.js';
import { RateLimitError } from './types.js';

/** Optional API backend. Needs OPENAI_API_KEY. Same interface as codex. */
export function createOpenAiProvider(model: string): ImageProvider {
  const key = () => {
    const value = process.env.OPENAI_API_KEY;
    if (!value) throw new Error('OPENAI_API_KEY is not set');
    return value;
  };
  const save = (b64: string): string => {
    const dir = path.join(os.tmpdir(), 'ukiyo');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
    fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    return file;
  };
  const handle = async (response: Response): Promise<string> => {
    if (response.status === 429) throw new RateLimitError('OpenAI rate limit');
    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);
    const json = (await response.json()) as { data?: { b64_json?: string }[] };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI returned no image');
    return save(b64);
  };
  return {
    name: 'openai',
    async generate(prompt, options: GenerateOptions) {
      // The generations endpoint takes no images; with references, the edits endpoint takes them all.
      const refs = [...new Set([...(options.ref ? [options.ref] : []), ...(options.refs ?? [])])];
      if (refs.length > 0) return this.edit(prompt, refs[0]!, { ...options, ref: undefined, refs: refs.slice(1) });
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt, n: 1, size: options.size ?? '1024x1024', quality: 'high', output_format: 'png' }),
      });
      return { file: await handle(response) };
    },
    async edit(prompt, image, options: GenerateOptions) {
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', prompt);
      form.append('n', '1');
      form.append('size', options.size ?? '1024x1024');
      form.append('image[]', new Blob([fs.readFileSync(image)], { type: 'image/png' }), path.basename(image));
      for (const ref of [...new Set([...(options.ref ? [options.ref] : []), ...(options.refs ?? [])])]) {
        form.append('image[]', new Blob([fs.readFileSync(ref)], { type: 'image/png' }), path.basename(ref));
      }
      const response = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key()}` },
        body: form,
      });
      return { file: await handle(response) };
    },
    async check() {
      const ok = Boolean(process.env.OPENAI_API_KEY);
      return { ok, details: [ok ? 'OPENAI_API_KEY is set' : 'OPENAI_API_KEY is not set', `model ${model}`] };
    },
  };
}

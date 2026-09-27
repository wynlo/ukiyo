import type { ResolvedConfig } from '../config.js';
import { templatesFor } from '../prompt/compose.js';
import { createCodexProvider } from './codex.js';
import { createOpenAiProvider } from './openai.js';
import type { ImageProvider } from './types.js';

export type { ImageProvider, GenerateOptions, ProviderResult } from './types.js';
export { RateLimitError } from './types.js';

/** The manual provider never produces a file: `ukiyo prompt` + `ukiyo import` is the path. */
const manual: ImageProvider = {
  name: 'manual',
  async generate() {
    return { file: null };
  },
  async edit() {
    return { file: null };
  },
  async check() {
    return { ok: true, details: ['manual: paste prompts into ChatGPT, then `ukiyo import`'] };
  },
};

export function createProvider(config: ResolvedConfig): ImageProvider {
  switch (config.provider.name) {
    case 'codex':
      return createCodexProvider({
        model: config.provider.model,
        agentModel: config.provider.agentModel,
        effort: config.provider.effort,
        timeoutMs: config.provider.timeoutMs,
        cwd: config.root,
        relayPrompt: (view) => templatesFor(config).render('codex-relay', view),
      });
    case 'openai':
      return createOpenAiProvider(config.provider.model === 'gpt-image-2' ? 'gpt-image-1' : config.provider.model);
    case 'manual':
      return manual;
  }
}

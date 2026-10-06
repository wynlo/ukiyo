import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { GenerateOptions, ImageProvider, ProviderResult } from './types.js';
import { RateLimitError } from './types.js';

/**
 * Image generation through the Codex CLI's built-in `image_gen` tool, which
 * runs on the user's ChatGPT login. No API key. Output lands in
 * `$CODEX_HOME/generated_images/<session>/*.png`. The session id comes from
 * the `thread.started` event, and the newest file in that folder is the
 * result, so concurrent runs never swap images.
 */

export type CodexOptions = {
  model: string;
  /** The Codex agent model that relays the prompt. Omit for the CLI default. */
  agentModel?: string;
  effort: 'low' | 'medium' | 'high';
  timeoutMs: number;
  cwd: string;
  /** Renders the `codex-relay` prompt template. */
  relayPrompt: (view: { prompt: string; size?: string; ref: boolean; refs: number; edit: boolean }) => string;
};

type CodexEvent = {
  type?: string;
  /** `thread.started` carries the session id; images land in a folder of that name. */
  thread_id?: string;
  message?: string;
  error?: { message?: string };
  item?: { type?: string; text?: string };
};

function parseEvents(stdout: string): CodexEvent[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CodexEvent];
      } catch {
        return [];
      }
    });
}

const RATE_LIMIT_PATTERNS = [/rate limit/i, /\b429\b/, /usage limit/i, /too many requests/i, /quota/i, /try again (later|in)/i];

export function codexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
}

function generatedImagesDir(): string {
  return path.join(codexHome(), 'generated_images');
}

function listPngs(dir: string): { file: string; mtime: number }[] {
  if (!fs.existsSync(dir)) return [];
  const out: { file: string; mtime: number }[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(png|jpe?g|webp)$/i.test(entry.name)) out.push({ file: full, mtime: fs.statSync(full).mtimeMs });
    }
  };
  walk(dir);
  return out;
}

/** `ref` and `refs` as one list, without repeats. */
function referenceList(genOptions: GenerateOptions): string[] {
  return [...new Set([...(genOptions.ref ? [genOptions.ref] : []), ...(genOptions.refs ?? [])])];
}

export function createCodexProvider(options: CodexOptions): ImageProvider {
  const run = async (prompt: string, images: string[], genOptions: GenerateOptions): Promise<ProviderResult> => {
    const started = Date.now() - 1000;
    const before = new Set(listPngs(generatedImagesDir()).map((e) => e.file));
    const args = [
      'exec',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--json',
      '-c',
      `model_reasoning_effort="${options.effort}"`,
      '--color',
      'never',
    ];
    if (options.agentModel) {
      args.push('-m', options.agentModel);
    }
    for (const image of images) {
      args.push('-i', image);
    }
    // The prompt goes on stdin: `-i <FILE>...` is variadic and would swallow
    // a positional prompt as another file name.
    args.push('-');
    genOptions.log?.(`codex ${args.slice(0, 6).join(' ')} … (${prompt.length} chars${images.length ? `, ${images.length} image${images.length === 1 ? '' : 's'}` : ''})`);
    let stdout = '';
    let stderr = '';
    try {
      /*
       * `input` writes the prompt and closes stdin. An inherited pipe never
       * closes, and `codex exec` reads stdin to the end, so the call would sit
       * until the timeout with nothing generated.
       */
      const result = await execa('codex', args, { cwd: options.cwd, timeout: options.timeoutMs, reject: false, input: prompt, env: { ...process.env, NO_COLOR: '1' } });
      stdout = result.stdout ?? '';
      stderr = result.stderr ?? '';
      const events = parseEvents(stdout);
      const failures = events
        .filter((event) => event.type === 'error' || event.type === 'turn.failed')
        .map((event) => event.error?.message ?? event.message ?? 'unknown error');
      const transcript = `${failures.join('\n')}\n${stderr}`;
      if (RATE_LIMIT_PATTERNS.some((p) => p.test(transcript))) {
        throw new RateLimitError('Codex reported a rate or usage limit.');
      }
      if (result.timedOut) {
        throw new Error(`codex exec timed out after ${Math.round(options.timeoutMs / 1000)}s`);
      }
      if (failures.length > 0) {
        throw new Error(failures.join('; '));
      }
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (RATE_LIMIT_PATTERNS.some((p) => p.test(message))) throw new RateLimitError(message);
      throw new Error(`codex exec failed: ${message}`);
    }
    /*
     * Take the image from this run's own session folder. Two ukiyo processes
     * can run Codex at the same time, and "the newest image anywhere" would
     * then hand one run the other's picture.
     */
    const threadId = parseEvents(stdout).find((event) => event.type === 'thread.started' && event.thread_id)?.thread_id;
    const sessionDir = threadId ? path.join(generatedImagesDir(), threadId) : null;
    const pool = sessionDir && fs.existsSync(sessionDir) ? listPngs(sessionDir) : threadId ? [] : listPngs(generatedImagesDir());
    if (!threadId) genOptions.log?.('codex reported no session id; falling back to the newest image, which is unsafe when two runs overlap');
    const created = pool
      .filter((e) => !before.has(e.file) && e.mtime >= started)
      .sort((a, b) => b.mtime - a.mtime);
    const newest = created[0];
    if (!newest) {
      const said = parseEvents(stdout)
        .filter((event) => event.item?.type === 'agent_message')
        .map((event) => event.item?.text ?? '')
        .join(' ')
        .slice(0, 400);
      const tail = stderr.trim().split('\n').filter((line) => !line.includes('codex_models_manager')).slice(-4).join('\n');
      throw new Error(`codex produced no image. Agent said: ${said || '(nothing)'} ${tail}`.trim());
    }
    return { file: newest.file, transcript: `${stdout}\n${stderr}`.trim() };
  };

  /** A text answer about an image: the agent's last message. */
  const describe = async (prompt: string, image: string, genOptions: GenerateOptions): Promise<string> => {
    const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '-c', `model_reasoning_effort="${options.effort}"`, '--color', 'never'];
    if (options.agentModel) args.push('-m', options.agentModel);
    args.push('-i', image, '-');
    genOptions.log?.(`codex ${args.slice(0, 6).join(' ')} … (${prompt.length} chars, describe)`);
    const result = await execa('codex', args, { cwd: options.cwd, timeout: options.timeoutMs, reject: false, input: prompt, env: { ...process.env, NO_COLOR: '1' } });
    const events = parseEvents(result.stdout ?? '');
    const failures = events.filter((event) => event.type === 'error' || event.type === 'turn.failed').map((event) => event.error?.message ?? event.message ?? 'unknown error');
    const transcript = `${failures.join('\n')}\n${result.stderr ?? ''}`;
    if (RATE_LIMIT_PATTERNS.some((p) => p.test(transcript))) throw new RateLimitError('Codex reported a rate or usage limit.');
    if (result.timedOut) throw new Error(`codex exec timed out after ${Math.round(options.timeoutMs / 1000)}s`);
    if (failures.length > 0) throw new Error(failures.join('; '));
    const messages = events.filter((event) => event.item?.type === 'agent_message').map((event) => event.item?.text ?? '');
    const last = messages[messages.length - 1];
    if (!last) throw new Error('codex gave no answer');
    return last;
  };

  return {
    name: 'codex',
    describe,
    generate: (prompt, genOptions) => {
      const refs = referenceList(genOptions);
      return run(options.relayPrompt({ prompt, size: genOptions.size, ref: refs.length > 0, refs: refs.length, edit: false }), refs, genOptions);
    },
    edit: (prompt, image, genOptions) => {
      const refs = referenceList(genOptions);
      return run(options.relayPrompt({ prompt, size: genOptions.size, ref: false, refs: refs.length, edit: true }), [image, ...refs], genOptions);
    },
    check: async () => {
      const details: string[] = [];
      let ok = true;
      try {
        const version = await execa('codex', ['--version'], { reject: false });
        details.push(`codex ${version.stdout.trim() || 'found'}`);
      } catch {
        ok = false;
        details.push('codex is not on PATH. Install: npm i -g @openai/codex');
        return { ok, details };
      }
      const auth = path.join(codexHome(), 'auth.json');
      if (fs.existsSync(auth)) details.push(`logged in (${auth})`);
      else {
        ok = false;
        details.push('not logged in. Run: codex login');
      }
      try {
        const features = await execa('codex', ['features', 'list'], { reject: false });
        const line = features.stdout.split('\n').find((l) => l.startsWith('image_generation'));
        if (line && /\btrue\b/.test(line)) details.push('image_generation feature: on');
        else {
          ok = false;
          details.push('image_generation feature is off. Run: codex features enable image_generation');
        }
      } catch {
        details.push('could not read codex features');
      }
      details.push(`images dir: ${generatedImagesDir()}`);
      return { ok, details };
    },
  };
}

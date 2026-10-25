import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { GenerateOptions, ImageProvider, ProviderResult } from './types.js';
import { formatReset, RateLimitError } from './types.js';

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

/*
 * The image_gen tool has its own quota, separate from the Codex agent quota.
 * When it runs out, the tool call fails with
 *   image generation failed: http 429 Too Many Requests: {"error":{"type":"usage_limit_reached","plan_type":"plus","resets_at":...,"resets_in_seconds":...}}
 * but the turn itself completes: `codex exec` shows no error event, and the
 * agent only says so in its last message. The session log has the details.
 */
const IMAGE_LIMIT_PATTERN = /image generation failed: http 429/i;
const IMAGE_LIMIT_SAID = /image[- _]?gen(eration)?\b[^.]{0,60}\blimit/i;

/** The last value of a JSON key in text that may hold escaped JSON. */
function jsonField(text: string, key: string): string | undefined {
  const matches = [...text.matchAll(new RegExp(`${key}\\\\*"\\s*:\\s*\\\\*"?([\\w.]+)`, 'g'))];
  return matches[matches.length - 1]?.[1];
}

/** The reset time from a usage_limit_reached body, in epoch ms. */
function resetsAt(text: string): number | undefined {
  const at = Number(jsonField(text, 'resets_at')) * 1000;
  return Number.isFinite(at) && at > Date.now() ? at : undefined;
}

function imageLimitError(text: string): RateLimitError {
  // Read only the 429 body: the session log also has the agent's own `resets_at` values.
  const at = text.search(new RegExp(`${IMAGE_LIMIT_PATTERN.source}(?![\\s\\S]*${IMAGE_LIMIT_PATTERN.source})`, 'i'));
  const details = at >= 0 ? (text.slice(at).split('\n')[0] ?? '') : '';
  const plan = jsonField(details, 'plan_type');
  const reset = resetsAt(details);
  if (reset) recordImageLimit(reset, Date.now());
  const message = `Codex image generation limit reached${plan ? ` (${plan} plan)` : ''}.${reset ? ` Resets in ${formatReset(reset)}.` : ''} The Codex agent limit is separate and not affected.`;
  return new RateLimitError(message, { scope: 'image', resetsAt: reset });
}

function accountLimitError(details: string): RateLimitError {
  const reset = resetsAt(details);
  return new RateLimitError(`Codex usage limit reached.${reset ? ` Resets in ${formatReset(reset)}.` : ''}`, { scope: 'account', resetsAt: reset });
}

/** The folder of Codex session logs for a day, `offset` days back. */
function sessionDay(offset: number): string {
  const d = new Date(Date.now() - offset * 86400000);
  return path.join(codexHome(), 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
}

/** The session log Codex writes for a thread: `sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`. */
function sessionLog(threadId: string): string | null {
  for (const dir of [sessionDay(0), sessionDay(1)]) {
    if (!fs.existsSync(dir)) continue;
    const file = fs.readdirSync(dir).find((name) => name.endsWith(`-${threadId}.jsonl`));
    if (file) return path.join(dir, file);
  }
  return null;
}

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

/*
 * Codex does not report how much of the image quota is left. ukiyo estimates
 * it: it counts the images in `generated_images` since the window started, and
 * compares that count with the count at the last limit hit. Images made in
 * Codex outside ukiyo use the same quota, so they are counted too. OpenAI does
 * not publish the window length. 24 hours matches the limit seen on a Plus plan.
 */
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

type QuotaState = { cap: number; hitAt: number; resetsAt: number };

export type ImageQuota = { used: number; cap: number; hitAt: number };

function quotaFile(): string {
  return path.join(os.homedir(), '.ukiyo', 'codex-image-quota.json');
}

function readQuota(): QuotaState | null {
  try {
    return JSON.parse(fs.readFileSync(quotaFile(), 'utf8')) as QuotaState;
  } catch {
    return null;
  }
}

/** The start of the quota window at `at`: the last known reset, or 24 hours back. */
function windowStart(at: number, state: QuotaState | null): number {
  return Math.max(state && state.resetsAt <= at ? state.resetsAt : 0, at - QUOTA_WINDOW_MS);
}

function imagesBetween(from: number, to: number): number {
  return listPngs(generatedImagesDir()).filter((e) => e.mtime >= from && e.mtime <= to).length;
}

/** Saves the image count at a limit hit as the quota cap. */
function recordImageLimit(resetsAt: number, hitAt: number): void {
  const previous = readQuota();
  if (previous && previous.hitAt >= hitAt) return;
  const cap = imagesBetween(windowStart(hitAt, previous), hitAt);
  if (cap === 0) return;
  fs.mkdirSync(path.dirname(quotaFile()), { recursive: true });
  fs.writeFileSync(quotaFile(), `${JSON.stringify({ cap, hitAt, resetsAt } satisfies QuotaState, null, 2)}\n`);
}

let sessionsScanned = false;

/** Finds the last image limit hit in the last two days of session logs. Runs once per process, and only when no cap is saved. */
function learnFromSessions(): void {
  if (sessionsScanned || readQuota()) return;
  sessionsScanned = true;
  let last: { hitAt: number; resetsAt: number } | null = null;
  for (const dir of [sessionDay(1), sessionDay(0)]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      if (!IMAGE_LIMIT_PATTERN.test(text)) continue;
      for (const line of text.split('\n')) {
        if (!IMAGE_LIMIT_PATTERN.test(line)) continue;
        const hitAt = Date.parse(line.match(/^\{"timestamp":"([^"]+)"/)?.[1] ?? '');
        const reset = Number(jsonField(line.slice(line.search(IMAGE_LIMIT_PATTERN)), 'resets_at')) * 1000;
        if (Number.isFinite(hitAt) && Number.isFinite(reset) && (!last || hitAt > last.hitAt)) last = { hitAt, resetsAt: reset };
      }
    }
  }
  if (last) recordImageLimit(last.resetsAt, last.hitAt);
}

/** The estimated image quota use in the current window. Null until a limit hit has set the cap. */
export function codexImageQuota(now = Date.now()): ImageQuota | null {
  learnFromSessions();
  const state = readQuota();
  if (!state) return null;
  return { used: imagesBetween(windowStart(now, state), now), cap: state.cap, hitAt: state.hitAt };
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
      if (IMAGE_LIMIT_PATTERN.test(`${stdout}\n${stderr}`)) throw imageLimitError(`${stdout}\n${stderr}`);
      if (RATE_LIMIT_PATTERNS.some((p) => p.test(transcript))) throw accountLimitError(transcript);
      if (result.timedOut) {
        throw new Error(`codex exec timed out after ${Math.round(options.timeoutMs / 1000)}s`);
      }
      if (failures.length > 0) {
        throw new Error(failures.join('; '));
      }
    } catch (error) {
      if (error instanceof RateLimitError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (RATE_LIMIT_PATTERNS.some((p) => p.test(message))) throw accountLimitError(message);
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
      const log = threadId ? sessionLog(threadId) : null;
      const details = log ? fs.readFileSync(log, 'utf8') : '';
      if (IMAGE_LIMIT_PATTERN.test(details) || IMAGE_LIMIT_SAID.test(said)) throw imageLimitError(details);
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
    if (RATE_LIMIT_PATTERNS.some((p) => p.test(transcript))) throw accountLimitError(transcript);
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
    imageQuota: () => codexImageQuota(),
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
      const quota = codexImageQuota();
      details.push(quota ? `image quota: about ${quota.used} of ${quota.cap} used in this window (estimate)` : 'image quota: unknown until the first limit hit');
      return { ok, details };
    },
  };
}

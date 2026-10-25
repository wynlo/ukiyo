import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One rate limit for every ukiyo process on the machine. Several sessions
 * can run ukiyo at once against one Codex login, and each used to keep its
 * own `concurrency` and `gapMs`, so together they sent more than either
 * setting allowed. The limiter keeps its state in files under
 * `~/.cache/ukiyo/limiter` (or `UKIYO_CACHE`):
 *
 * - `slot-<n>.lock` holds the pid of the process using slot n. A process
 *   takes a free slot (or one whose pid is gone) before a provider call and
 *   frees it after. There are `concurrency` slots.
 * - `last` holds the time of the last call. A call starts at least `gapMs`
 *   after it.
 * - `pause` holds a time before which no call starts. A process that meets a
 *   quota limit writes the reset time here, so every process waits.
 */
export type LimiterOptions = { concurrency: number; gapMs: number; dir?: string; pollMs?: number };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function limiterDir(): string {
  return path.join(process.env.UKIYO_CACHE ?? path.join(os.homedir(), '.cache', 'ukiyo'), 'limiter');
}

const readNumber = (file: string): number => {
  try {
    return Number(fs.readFileSync(file, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
};

export function createLimiter(options: LimiterOptions) {
  const dir = options.dir ?? limiterDir();
  const poll = options.pollMs ?? 250;
  const slots = Math.max(1, options.concurrency);
  fs.mkdirSync(dir, { recursive: true });
  const slotFile = (n: number) => path.join(dir, `slot-${n}.lock`);
  const lastFile = path.join(dir, 'last');
  const pauseFile = path.join(dir, 'pause');

  /** Takes a slot: creates its lock file exclusively, or replaces one whose owner is gone. */
  const tryTake = (): number | null => {
    for (let n = 0; n < slots; n += 1) {
      const file = slotFile(n);
      try {
        fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
        return n;
      } catch {
        const owner = readNumber(file);
        if (!alive(owner)) {
          fs.rmSync(file, { force: true });
          try {
            fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
            return n;
          } catch {
            // another process took it first
          }
        }
      }
    }
    return null;
  };

  /** Writes a time before which no ukiyo process starts a call. */
  const pauseUntil = (ms: number): void => {
    if (ms > readNumber(pauseFile)) fs.writeFileSync(pauseFile, String(ms));
  };

  /** Runs `fn` when a slot is free, the gap has passed and no pause is set. */
  const run = async <T>(fn: () => Promise<T>, onWait?: (message: string) => void): Promise<T> => {
    let told = false;
    let slot: number | null = null;
    for (;;) {
      const pause = readNumber(pauseFile);
      if (pause > Date.now()) {
        if (!told && onWait) onWait(`Another ukiyo process met a quota limit. Waiting until ${new Date(pause).toLocaleTimeString()}.`);
        told = true;
        await sleep(Math.min(pause - Date.now(), 60000));
        continue;
      }
      slot = tryTake();
      if (slot === null) {
        if (!told && onWait) onWait('Waiting for a free provider slot (other ukiyo processes are generating).');
        told = true;
        await sleep(poll);
        continue;
      }
      const wait = readNumber(lastFile) + options.gapMs - Date.now();
      if (wait > 0) {
        fs.rmSync(slotFile(slot), { force: true });
        slot = null;
        await sleep(Math.min(wait, 60000));
        continue;
      }
      fs.writeFileSync(lastFile, String(Date.now()));
      break;
    }
    try {
      return await fn();
    } finally {
      fs.rmSync(slotFile(slot), { force: true });
    }
  };

  return { run, pauseUntil, dir };
}

export type Limiter = ReturnType<typeof createLimiter>;

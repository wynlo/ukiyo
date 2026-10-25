export type GenerateOptions = {
  /** A style reference image attached to the request. Kept for callers that send one; prefer `refs`. */
  ref?: string;
  /** Reference images attached after the input image, in order. Their roles are named in the prompt. */
  refs?: string[];
  /** Requested output size, "WxH". */
  size?: string;
  /** Log sink for provider chatter. */
  log?: (line: string) => void;
};

export type ProviderResult = {
  /** Absolute path of the produced PNG, or null when the provider is manual. */
  file: string | null;
  /** Raw provider output, for the log. */
  transcript?: string;
};

/**
 * Which quota ran out. `image` is the image generation quota only: the
 * provider still answers text requests (`describe`). `account` blocks every
 * request to the provider.
 */
export type LimitScope = 'image' | 'account';

export class RateLimitError extends Error {
  readonly scope: LimitScope;
  /** Time until the limit resets, when the provider reports it. */
  readonly retryAfterMs?: number;
  /** Epoch ms of the reset, when the provider reports it. */
  readonly resetsAt?: number;

  constructor(message: string, options: { scope?: LimitScope; retryAfterMs?: number; resetsAt?: number } = {}) {
    super(message);
    this.name = 'RateLimitError';
    this.scope = options.scope ?? 'account';
    this.retryAfterMs = options.retryAfterMs ?? (options.resetsAt !== undefined ? Math.max(0, options.resetsAt - Date.now()) : undefined);
    this.resetsAt = options.resetsAt ?? (options.retryAfterMs !== undefined ? Date.now() + options.retryAfterMs : undefined);
  }
}

/** "21m (10:28)" for a reset time. */
export function formatReset(resetsAt: number): string {
  const ms = Math.max(0, resetsAt - Date.now());
  const minutes = Math.ceil(ms / 60000);
  const span = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const clock = new Date(resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${span} (${clock})`;
}

export type ImageProvider = {
  name: string;
  /** Text to image. */
  generate(prompt: string, options: GenerateOptions): Promise<ProviderResult>;
  /** Image + text to image. `image` is the source to iterate on. */
  edit(prompt: string, image: string, options: GenerateOptions): Promise<ProviderResult>;
  /**
   * Image + text to text: look at an image and answer (`ukiyo plan` asks
   * which parts of a sprite would move). Optional; a provider without it
   * cannot label parts.
   */
  describe?(prompt: string, image: string, options: GenerateOptions): Promise<string>;
  /**
   * The estimated image quota use in the current window. Optional. Returns
   * null while the cap is unknown.
   */
  imageQuota?(): { used: number; cap: number } | null;
  /** Preflight for `ukiyo doctor`. */
  check(): Promise<{ ok: boolean; details: string[] }>;
};

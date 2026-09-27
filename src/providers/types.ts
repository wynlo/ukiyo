export type GenerateOptions = {
  /** A style reference image attached to the request. */
  ref?: string;
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

export class RateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export type ImageProvider = {
  name: string;
  /** Text to image. */
  generate(prompt: string, options: GenerateOptions): Promise<ProviderResult>;
  /** Image + text to image. `image` is the source to iterate on. */
  edit(prompt: string, image: string, options: GenerateOptions): Promise<ProviderResult>;
  /** Preflight for `ukiyo doctor`. */
  check(): Promise<{ ok: boolean; details: string[] }>;
};

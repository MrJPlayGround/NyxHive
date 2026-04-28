import { logger } from "../utils/logger.js";

const DEFAULT_BASE_DELAY = 1000;
const DEFAULT_MAX_DELAY = 60_000;
const DEFAULT_MAX_ATTEMPTS = 10;

export interface ReconnectOpts {
  name: string;
  baseDelay?: number;
  maxDelay?: number;
  maxAttempts?: number;
}

export class Reconnector {
  private name: string;
  private baseDelay: number;
  private maxDelay: number;
  private maxAttempts: number;
  private attempts = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(opts: ReconnectOpts) {
    this.name = opts.name;
    this.baseDelay = opts.baseDelay ?? DEFAULT_BASE_DELAY;
    this.maxDelay = opts.maxDelay ?? DEFAULT_MAX_DELAY;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  schedule(connectFn: () => Promise<void>): void {
    if (this.stopped) return;

    if (this.attempts >= this.maxAttempts) {
      logger.error(`[${this.name}] Max reconnect attempts (${this.maxAttempts}) reached`);
      return;
    }

    const delay = Math.min(
      this.baseDelay * 2 ** this.attempts,
      this.maxDelay,
    );
    this.attempts++;

    logger.info(`[${this.name}] Reconnecting in ${(delay / 1000).toFixed(0)}s (attempt ${this.attempts}/${this.maxAttempts})`);

    this.timer = setTimeout(async () => {
      try {
        await connectFn();
        this.attempts = 0;
        logger.info(`[${this.name}] Reconnected`);
      } catch (err) {
        logger.error(`[${this.name}] Reconnect failed: ${err}`);
        this.schedule(connectFn);
      }
    }, delay);
  }

  reset(): void {
    this.attempts = 0;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

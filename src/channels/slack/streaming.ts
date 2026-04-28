export interface StreamManagerOpts {
  updateIntervalMs: number;
  maxChars: number;
  onUpdate: (text: string) => Promise<void>;
  onFinalize: (text: string) => Promise<void>;
}

export class SlackStreamManager {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdate = 0;
  private opts: StreamManagerOpts;
  private finalized = false;

  constructor(opts: StreamManagerOpts) {
    this.opts = opts;
  }

  append(chunk: string): void {
    if (this.finalized) return;
    this.buffer += chunk;
    this.scheduleUpdate();
  }

  getCurrentText(): string {
    if (this.buffer.length <= this.opts.maxChars) return this.buffer;
    return `${this.buffer.slice(0, this.opts.maxChars)}...`;
  }

  private scheduleUpdate(): void {
    if (this.timer) return;
    const elapsed = Date.now() - this.lastUpdate;
    const delay = Math.max(0, this.opts.updateIntervalMs - elapsed);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastUpdate = Date.now();
      if (!this.finalized) {
        this.opts.onUpdate(this.getCurrentText()).catch(() => {});
      }
    }, delay);
  }

  async finalize(): Promise<void> {
    this.finalized = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.opts.onFinalize(this.buffer);
  }
}

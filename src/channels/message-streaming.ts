export interface MessageStreamManagerOpts<TMessage> {
  updateIntervalMs: number;
  forceFlushChars: number;
  maxPreviewChars: number;
  onStart: () => Promise<TMessage>;
  onUpdate: (message: TMessage, text: string) => Promise<void>;
  render: (text: string, truncated: boolean) => string;
  onError?: (error: unknown) => void;
}

export class MessageStreamManager<TMessage> {
  private buffer = "";
  private pendingChars = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextFlushAt = 0;
  private message: TMessage | null = null;
  private startPromise: Promise<TMessage> | null = null;
  private updateChain: Promise<void> = Promise.resolve();
  private finalized = false;
  private opts: MessageStreamManagerOpts<TMessage>;

  constructor(opts: MessageStreamManagerOpts<TMessage>) {
    this.opts = opts;
  }

  append(chunk: string): void {
    if (this.finalized || !chunk) return;
    this.buffer += chunk;
    this.pendingChars += chunk.length;
    void this.ensureStarted();
    if (this.pendingChars >= this.opts.forceFlushChars) {
      this.scheduleFlush(0);
      return;
    }
    const elapsed = this.nextFlushAt > 0 ? Math.max(0, this.nextFlushAt - Date.now()) : this.opts.updateIntervalMs;
    this.scheduleFlush(elapsed);
  }

  getMessage(): TMessage | null {
    return this.message;
  }

  getFullText(): string {
    return this.buffer;
  }

  getPreviewText(): { text: string; truncated: boolean } {
    if (this.buffer.length <= this.opts.maxPreviewChars) {
      return { text: this.buffer, truncated: false };
    }
    return {
      text: this.buffer.slice(0, this.opts.maxPreviewChars),
      truncated: true,
    };
  }

  async finalize(): Promise<{ message: TMessage | null; fullText: string }> {
    this.finalized = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.updateChain.catch(() => {});
    return { message: this.message, fullText: this.buffer };
  }

  private scheduleFlush(delayMs: number): void {
    if (this.finalized) return;
    const targetAt = Date.now() + delayMs;
    if (this.timer && this.nextFlushAt <= targetAt) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextFlushAt = targetAt;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.nextFlushAt = 0;
      this.pendingChars = 0;
      this.queueFlush();
    }, delayMs);
  }

  private queueFlush(): void {
    this.updateChain = this.updateChain
      .then(async () => {
        const message = await this.ensureStarted().catch(() => null);
        if (message === null || this.finalized) return;
        const { text, truncated } = this.getPreviewText();
        await this.opts.onUpdate(message, this.opts.render(text, truncated));
      })
      .catch((error) => {
        this.opts.onError?.(error);
      });
  }

  private async ensureStarted(): Promise<TMessage> {
    if (this.message !== null) return this.message;
    if (!this.startPromise) {
      this.startPromise = this.opts.onStart()
        .then((message) => {
          this.message = message;
          return message;
        })
        .catch((error) => {
          this.opts.onError?.(error);
          throw error;
        });
    }
    return this.startPromise;
  }
}

export class InflightTracker {
  private readonly pending = new Set<Promise<unknown>>();

  track<T>(promise: Promise<T>): Promise<T> {
    let tracked!: Promise<T>;
    tracked = promise.finally(() => {
      this.pending.delete(tracked);
    });
    this.pending.add(tracked);
    return tracked;
  }

  size(): number {
    return this.pending.size;
  }

  async waitForIdle(timeoutMs: number): Promise<{ drained: boolean; pending: number }> {
    if (this.pending.size === 0) {
      return { drained: true, pending: 0 };
    }

    const snapshot = Array.from(this.pending);
    try {
      await Promise.race([
        Promise.allSettled(snapshot),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
      ]);
    } catch {
      // Timeout is handled by the final pending count below.
    }

    return {
      drained: this.pending.size === 0,
      pending: this.pending.size,
    };
  }
}

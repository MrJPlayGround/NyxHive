import { describe, it, expect } from "bun:test";
import { withRetry } from "../utils/retry.js";

async function captureRetryDelay(error: unknown, options?: Parameters<typeof withRetry>[1]): Promise<number> {
  const originalSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];

  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    delays.push(delay ?? 0);
    if (typeof handler === "function") {
      handler(...args);
    }
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;

  try {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) throw error;
        return "ok";
      },
      { maxRetries: 1, baseDelayMs: 25, ...options },
    );
    expect(result).toBe("ok");
    expect(delays).toHaveLength(1);
    return delays[0]!;
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

describe("withRetry", () => {
  it("returns the result on first success", async () => {
    const result = await withRetry(() => Promise.resolve(42), { baseDelayMs: 1 });
    expect(result).toBe(42);
  });

  it("retries on retryable status and succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error("fail"), { status: 500 });
        return Promise.resolve("ok");
      },
      { maxRetries: 3, baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("429 rate limit retries only once then bails", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          throw Object.assign(new Error("rate limited"), { status: 429 });
        },
        { maxRetries: 5, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("rate limited");
    expect(attempts).toBe(2); // initial + 1 retry (not 6)
  });

  it("throws immediately on non-retryable status", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          throw Object.assign(new Error("forbidden"), { status: 403 });
        },
        { maxRetries: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("forbidden");
    expect(attempts).toBe(1);
  });

  it("throws after exhausting all retries", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          throw Object.assign(new Error("server error"), { status: 500 });
        },
        { maxRetries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("server error");
    expect(attempts).toBe(3); // initial + 2 retries
  });

  it("retries errors without a status code (generic errors)", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          throw new Error("network down");
        },
        { maxRetries: 1, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("network down");
    expect(attempts).toBe(2); // initial + 1 retry
  });

  it("respects custom retryOn list", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          throw Object.assign(new Error("rate limited"), { status: 429 });
        },
        { maxRetries: 3, baseDelayMs: 1, retryOn: [500] }, // 429 not in list
      ),
    ).rejects.toThrow("rate limited");
    expect(attempts).toBe(1);
  });

  it("handles statusCode property (alternative to status)", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts++;
          throw Object.assign(new Error("bad gateway"), { statusCode: 502 });
        },
        { maxRetries: 1, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("bad gateway");
    expect(attempts).toBe(2); // 502 is retryable, so initial + 1 retry
  });

  it("uses exponential backoff delays", async () => {
    const timestamps: number[] = [];
    let attempts = 0;
    try {
      await withRetry(
        () => {
          timestamps.push(Date.now());
          attempts++;
          throw Object.assign(new Error("fail"), { status: 500 });
        },
        { maxRetries: 2, baseDelayMs: 50 },
      );
    } catch {
      // expected
    }
    expect(attempts).toBe(3);
    // First delay: 50ms (50 * 2^0), second delay: 100ms (50 * 2^1)
    const delay1 = timestamps[1] - timestamps[0];
    const delay2 = timestamps[2] - timestamps[1];
    expect(delay1).toBeGreaterThanOrEqual(40); // ~50ms with some tolerance
    expect(delay2).toBeGreaterThanOrEqual(80); // ~100ms with some tolerance
    expect(delay2).toBeGreaterThan(delay1);    // second delay > first
  });

  it("uses a valid retry-after header when it exceeds exponential backoff", async () => {
    const delay = await captureRetryDelay(
      Object.assign(new Error("rate limited"), {
        status: 429,
        headers: { "retry-after": "0.2" },
      }),
      { baseDelayMs: 10 },
    );

    expect(delay).toBe(200);
  });

  it("ignores an invalid retry-after header", async () => {
    const delay = await captureRetryDelay(
      Object.assign(new Error("rate limited"), {
        status: 429,
        headers: { "retry-after": "invalid" },
      }),
      { baseDelayMs: 10 },
    );

    expect(delay).toBe(50);
  });

  it("caps retry-after delays at 60 seconds", async () => {
    const delay = await captureRetryDelay(
      Object.assign(new Error("rate limited"), {
        status: 429,
        headers: { "retry-after": "120" },
      }),
      { baseDelayMs: 10 },
    );

    expect(delay).toBe(60_000);
  });
});

import type { MiddlewareHandler } from "hono";

export function rateLimiter(opts: {
  windowMs?: number;
  maxRequests?: number;
} = {}): MiddlewareHandler {
  const windowMs = opts.windowMs ?? 60_000;
  const maxRequests = opts.maxRequests ?? 60;
  const requests = new Map<string, number[]>();
  let requestCount = 0;

  return async (c, next) => {
    // Get key (API key or IP)
    const authHeader = c.req.header("authorization");
    const apiKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      || c.req.header("x-real-ip")
      || "unknown";
    const key = apiKey ?? ip;

    // Internal authenticated clients are trusted server-to-server workspace calls.
    // Do not let workspace route fan-out consume the user-facing API bucket.
    const isInternal = c.req.header("x-client-type") === "nyx-internal" && apiKey != null;
    if (isInternal) {
      await next();
      return;
    }
    const effectiveMax = maxRequests;

    const now = Date.now();
    const timestamps = requests.get(key) ?? [];

    // Remove expired
    const valid = timestamps.filter(t => t > now - windowMs);

    if (valid.length >= effectiveMax) {
      const oldestValid = valid[0];
      const retryAfter = Math.ceil((oldestValid + windowMs - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "Rate limit exceeded", retry_after_seconds: retryAfter }, 429);
    }

    valid.push(now);
    requests.set(key, valid);

    // Deterministic cleanup of stale keys every 100 requests or if map exceeds 10k entries
    requestCount++;
    if (requestCount >= 100 || requests.size > 10_000) {
      requestCount = 0;
      for (const [k, v] of requests) {
        const active = v.filter(t => t > now - windowMs);
        if (active.length === 0) requests.delete(k);
        else requests.set(k, active);
      }
    }

    await next();
  };
}

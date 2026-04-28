import { logger } from "./logger.js";

export async function withRetry<T>(
  fn: () => Promise<T>,
  { maxRetries = 5, baseDelayMs = 1000, retryOn = [429, 500, 502, 503] } = {},
): Promise<T> {
  // 429 = rate limited: retry only once with longer backoff, then bail.
  // Hammering a rate-limited API 5x makes it worse for all concurrent requests.
  const rateLimitMaxRetries = 1;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as any)?.status ?? (err as any)?.statusCode;
      if (status && !retryOn.includes(status)) throw err;

      // For 429s, bail after fewer retries
      const effectiveMax = status === 429 ? rateLimitMaxRetries : maxRetries;
      if (attempt >= effectiveMax) throw err;

      // Respect retry-after header from Anthropic/OpenRouter if present
      const retryAfter = (err as any)?.headers?.["retry-after"];
      const parsedRetryAfter = retryAfter ? Number(retryAfter) : 0;
      const retryAfterMs = Number.isFinite(parsedRetryAfter)
        ? Math.min(parsedRetryAfter * 1000, 60_000)
        : 0;
      const exponentialDelay = baseDelayMs * 2 ** attempt;
      // 429s get a minimum 5x base delay to actually let the rate limit window pass
      const rateLimitFloor = status === 429 ? baseDelayMs * 5 : 0;
      const delay = Math.max(retryAfterMs, exponentialDelay, rateLimitFloor);

      logger.info(`[retry] Attempt ${attempt + 1}/${effectiveMax} failed${status ? ` (${status})` : ""}, retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

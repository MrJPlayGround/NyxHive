import type { MiddlewareHandler } from "hono";

/**
 * Origin validation middleware for state-changing requests (POST/PUT/PATCH/DELETE).
 * Prevents cross-origin attacks by checking the Origin or Referer header against allowed origins.
 * GET/HEAD/OPTIONS are exempt (safe methods per HTTP spec).
 *
 * This is the appropriate CSRF defense for Bearer-token-authenticated APIs —
 * full CSRF tokens are unnecessary since browsers don't auto-send Authorization headers.
 */
export function originCheck(allowedOrigins: string[]): MiddlewareHandler {
  const allowedSet = new Set(allowedOrigins.map(normalizeOrigin));

  return async (c, next) => {
    const method = c.req.method;

    // Safe methods are exempt
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }

    // Internal/API-key-only clients (CLI, agents, cron) won't have an Origin header.
    // Only validate when Origin is present (browser requests).
    const origin = c.req.header("origin");
    const referer = c.req.header("referer");

    if (!origin && !referer) {
      // No browser context — allow (API clients, curl, agents)
      return next();
    }

    const requestOrigin = origin
      ? normalizeOrigin(origin)
      : referer
        ? normalizeOrigin(new URL(referer).origin)
        : null;

    if (requestOrigin && !allowedSet.has(requestOrigin)) {
      return c.json({ error: "Origin not allowed" }, 403);
    }

    return next();
  };
}

function normalizeOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`;
  } catch {
    return origin.toLowerCase();
  }
}

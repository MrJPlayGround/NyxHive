import type { MiddlewareHandler } from "hono";
import { randomBytes } from "node:crypto";

const CSRF_COOKIE = "csrf_token";
const CSRF_HEADER = "x-csrf-token";
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Double-submit cookie CSRF protection.
 *
 * On every request, ensures a `csrf_token` cookie exists (generates one if missing).
 * On state-changing methods (POST/PUT/PATCH/DELETE), validates that the
 * `X-CSRF-Token` header matches the cookie value.
 *
 * API key auth is exempt — programmatic clients don't use cookies.
 */
export function csrfProtection(): MiddlewareHandler {
  return async (c, next) => {
    // Skip pre-auth endpoints (register, login) — no session exists yet
    const path = c.req.path;
    if (path === "/api/auth/register" || path === "/api/auth/login" || path === "/api/auth/status") {
      return next();
    }

    // API key auth is exempt — they already have a secret token and don't use cookies
    const auth = c.get("auth") as { type: string } | undefined;
    if (auth?.type === "api_key") {
      return next();
    }

    // Read or generate CSRF token
    const cookies = parseCookies(c.req.header("cookie") ?? "");
    let token = cookies[CSRF_COOKIE];

    if (!token) {
      token = randomBytes(32).toString("hex");
    }

    // Always set/refresh the cookie (httpOnly=false so JS can read it)
    c.header("Set-Cookie", `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict; Secure`, { append: true });

    // Validate on state-changing methods
    if (STATE_CHANGING_METHODS.has(c.req.method)) {
      const headerToken = c.req.header(CSRF_HEADER);
      if (!headerToken || headerToken !== token) {
        return c.json({ error: "CSRF token missing or invalid" }, 403);
      }
    }

    await next();
  };
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) cookies[key] = rest.join("=");
  }
  return cookies;
}

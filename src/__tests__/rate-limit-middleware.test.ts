import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { rateLimiter } from "../server/middleware/rate-limit.js";

function createApp(opts?: { windowMs?: number; maxRequests?: number }) {
  const app = new Hono();
  app.use("/*", rateLimiter(opts));
  app.get("/test", (c) => c.json({ ok: true }));
  return app;
}

function req(app: Hono, headers?: Record<string, string>) {
  return app.request("/test", { headers });
}

describe("rateLimiter middleware", () => {
  test("allows requests under the limit", async () => {
    const app = createApp({ maxRequests: 5 });
    for (let i = 0; i < 5; i++) {
      const res = await req(app);
      expect(res.status).toBe(200);
    }
  });

  test("blocks requests over the limit with 429", async () => {
    const app = createApp({ maxRequests: 3 });
    for (let i = 0; i < 3; i++) {
      await req(app);
    }
    const res = await req(app);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toBe("Rate limit exceeded");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  test("keys by Bearer token when present", async () => {
    const app = createApp({ maxRequests: 2 });
    const h1 = { Authorization: "Bearer token-a" };
    const h2 = { Authorization: "Bearer token-b" };

    // Exhaust limit for token-a
    await req(app, h1);
    await req(app, h1);
    const blocked = await req(app, h1);
    expect(blocked.status).toBe(429);

    // token-b should still work
    const ok = await req(app, h2);
    expect(ok.status).toBe(200);
  });

  test("internal client without auth does NOT get higher limit", async () => {
    const app = createApp({ maxRequests: 2 });
    const headers = { "X-Client-Type": "nyx-internal" };

    await req(app, headers);
    await req(app, headers);
    const res = await req(app, headers);
    expect(res.status).toBe(429);
  });

  test("internal client with auth bypasses the user-facing rate limit", async () => {
    const app = createApp({ maxRequests: 3 });
    const headers = {
      Authorization: "Bearer valid-key",
      "X-Client-Type": "nyx-internal",
    };

    for (let i = 0; i < 20; i++) {
      const res = await req(app, headers);
      expect(res.status).toBe(200);
    }
  });

  test("external client still capped at base limit alongside internal", async () => {
    const app = createApp({ maxRequests: 2 });
    const internal = {
      Authorization: "Bearer key-1",
      "X-Client-Type": "nyx-internal",
    };
    const external = { Authorization: "Bearer key-2" };

    // Internal traffic is trusted only when it also has bearer auth.
    for (let i = 0; i < 12; i++) {
      const res = await req(app, internal);
      expect(res.status).toBe(200);
    }

    // External: still capped at 2
    await req(app, external);
    await req(app, external);
    const res = await req(app, external);
    expect(res.status).toBe(429);
  });

  test("default behavior bypasses authenticated internal clients", async () => {
    const app = createApp({ maxRequests: 1 });
    const headers = {
      Authorization: "Bearer key",
      "X-Client-Type": "nyx-internal",
    };

    for (let i = 0; i < 12; i++) {
      const res = await req(app, headers);
      expect(res.status).toBe(200);
    }
  });
});

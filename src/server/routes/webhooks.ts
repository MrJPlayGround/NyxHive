import { Hono } from "hono";
import type { WebhookChannel } from "../../channels/webhook.js";
import { canRead, canWrite } from "../middleware/rbac.js";

const MAX_BODY_SIZE = 1024 * 1024; // 1MB

export function webhookRoutes(channel: WebhookChannel): Hono {
  const app = new Hono();

  // POST /webhooks/:source — receive a webhook event
  app.post("/:source", canWrite, async (c) => {
    const sourceName = c.req.param("source");

    const rawBody = await c.req.text();
    if (rawBody.length > MAX_BODY_SIZE) {
      return c.json({ error: "Payload too large" }, 413);
    }

    // Collect headers with lowercase keys
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const result = await channel.handleRequest(sourceName, headers, rawBody);
    return c.json({ message: result.body }, result.status as 200 | 401 | 404 | 413 | 429 | 500);
  });

  // GET /webhooks/:source/health — check if source is configured
  app.get("/:source/health", canRead, (c) => {
    const sourceName = c.req.param("source");
    if (channel.hasSource(sourceName)) {
      return c.json({ source: sourceName, status: "ok" }, 200);
    }
    return c.json({ source: sourceName, status: "not_found" }, 404);
  });

  return app;
}

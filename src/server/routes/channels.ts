import { Hono } from "hono";
import { z } from "zod";
import type { QueueProcessor } from "../../queue/processor.js";
import { adminOnly, canRead } from "../middleware/rbac.js";

const sendSchema = z.object({
  channel: z.string().min(1),
  recipient: z.string().min(1),
  message: z.string().min(1),
});

export function channelsRoutes(processor: QueueProcessor): Hono {
  const app = new Hono();

  // GET /api/channels — list connected channels with outbound capability
  app.get("/", canRead, (c) => {
    const channels = processor.getChannels() ?? [];
    return c.json(
      channels.map((ch) => ({
        name: ch.name,
        connected: ch.isConnected(),
        supports_outbound: typeof ch.sendOutbound === "function",
      })),
    );
  });

  // POST /api/channels/send — send a message to a specific channel/recipient
  app.post("/send", adminOnly, async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = sendSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid payload", details: parsed.error.flatten() }, 400);
    }

    const { channel, recipient, message } = parsed.data;
    const channels = processor.getChannels() ?? [];
    const ch = channels.find((ch) => ch.name.toLowerCase() === channel.toLowerCase());

    if (!ch) {
      return c.json({ error: `Channel "${channel}" not found` }, 404);
    }
    if (!ch.sendOutbound) {
      return c.json({ error: `Channel "${channel}" does not support outbound messages` }, 400);
    }

    try {
      await ch.sendOutbound(recipient, message);
      return c.json({ sent: true, channel, recipient });
    } catch (err) {
      return c.json({ error: `Failed to send: ${err}` }, 500);
    }
  });

  return app;
}

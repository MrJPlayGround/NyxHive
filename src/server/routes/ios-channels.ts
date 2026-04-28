import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../auth/types.js";
import type { iOSChannel } from "../../channels/ios.js";
import { parseBody } from "./validate.js";
import { adminOnly, canRead } from "../middleware/rbac.js";

const markReadSchema = z.object({
  message_ids: z.array(z.string()).min(1).max(100),
});

const registerDeviceSchema = z.object({
  device_token: z.string().min(1),
  sender_id: z.string().min(1),
});

const removeDeviceSchema = z.object({
  device_token: z.string().min(1),
});

const notificationPrefSchema = z.object({
  level: z.enum(["all", "muted", "urgent"]),
  sender_id: z.string().min(1),
});

export function iosChannelRoutes(iosChannel: iOSChannel): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // GET /api/channels/ios — list available channels
  app.get("/", canRead, (c) => {
    return c.json({ channels: iosChannel.getChannels() });
  });

  // GET /api/channels/ios/messages?channel=ios:forge&since=<ts>&limit=50
  app.get("/messages", canRead, (c) => {
    const channel = c.req.query("channel");
    if (!channel) return c.json({ error: "channel query param required" }, 400);
    const since = c.req.query("since") ? Number(c.req.query("since")) : undefined;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50), 1), 100);
    const messages = iosChannel.getOutboundMessages(channel, since, limit);
    return c.json({ messages });
  });

  // POST /api/channels/ios/messages/read — mark messages as read
  app.post("/messages/read", adminOnly, async (c) => {
    const result = await parseBody(c, markReadSchema);
    if (result instanceof Response) return result;
    iosChannel.markRead(result.message_ids);
    return c.json({ ok: true });
  });

  // POST /api/channels/ios/register-device — register APNs device token
  app.post("/register-device", adminOnly, async (c) => {
    const result = await parseBody(c, registerDeviceSchema);
    if (result instanceof Response) return result;
    iosChannel.registerDevice(result.device_token, result.sender_id);
    return c.json({ registered: true });
  });

  // DELETE /api/channels/ios/register-device — unregister device token
  app.delete("/register-device", adminOnly, async (c) => {
    const result = await parseBody(c, removeDeviceSchema);
    if (result instanceof Response) return result;
    iosChannel.removeDevice(result.device_token);
    return c.json({ removed: true });
  });

  // PUT /api/channels/ios/notifications/:channel — set notification preference
  app.put("/notifications/:channel", adminOnly, async (c) => {
    const channel = c.req.param("channel");
    const result = await parseBody(c, notificationPrefSchema);
    if (result instanceof Response) return result;
    iosChannel.setNotificationPref(result.sender_id, channel, result.level);
    return c.json({ updated: true });
  });

  return app;
}

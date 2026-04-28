import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../auth/types.js";
import { RELAY_PRESENTING_INSTANCE_HEADER, type RelayCallbackManager } from "../../federation/relay.js";
import type { QueueProcessor } from "../../queue/processor.js";
import { parseBody } from "./validate.js";

const relayCallbackSchema = z.object({
  message: z.string().min(1),
  nonce: z.string().optional(),
  sender: z.string().optional(),
  sender_id: z.string().optional(),
  agent: z.string().optional(),
  files: z.array(z.object({
    name: z.string(),
    type: z.string(),
    data: z.string().max(10 * 1024 * 1024, "File data exceeds 10MB limit"),
  })).max(5).optional(),
});

export function relayRoutes(processor: QueueProcessor, relayCallbacks: RelayCallbackManager): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  app.post("/callback", async (c) => {
    const result = await parseBody(c, relayCallbackSchema);
    if (result instanceof Response) return result;
    const body = result;
    const token = c.req.header("X-NyxRelay-Token")?.trim();
    const presentedBy = c.req.header(RELAY_PRESENTING_INSTANCE_HEADER)?.trim();
    if (!token) return c.json({ error: "Missing relay token" }, 401);

    const nonceResult = relayCallbacks.registerCallbackNonce(token, body.nonce, presentedBy);
    if (!nonceResult.ok) {
      return c.json({ status: nonceResult.duplicate ? "duplicate" : "invalid" }, nonceResult.duplicate ? 202 : 401);
    }

    const files = body.files?.map((file) => ({
      name: file.name,
      mimeType: file.type,
      base64: file.data,
      size: Math.ceil(file.data.length * 3 / 4),
    }));
    const relayIdentity = nonceResult.issuedFor ?? presentedBy ?? "relay";
    const sender = body.sender?.trim() || relayIdentity;
    const senderId = body.sender_id?.trim() || body.sender?.trim() || relayIdentity;

    const relayResult = await processor.processImmediate({
      channel: "relay",
      sender,
      sender_id: senderId,
      message: body.message,
      agent: body.agent,
      files,
      trust: "system",
    });

    return c.json(relayResult);
  });

  return app;
}

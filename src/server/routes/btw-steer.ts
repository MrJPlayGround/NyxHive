import { Hono } from "hono";
import { z } from "zod";
import type { QueueProcessor } from "../../queue/processor.js";
import { canWrite } from "../middleware/rbac.js";

const btwRequestSchema = z.object({
  question: z.string().min(1).max(2000),
  conversation_id: z.string().optional(),
  source: z.string().default("human"),
});

const steerRequestSchema = z.object({
  message: z.string().min(1).max(5000),
  conversation_id: z.string().optional(),
  priority: z.enum(["normal", "interrupt"]).default("normal"),
  source: z.string().default("human"),
  ttl_seconds: z.number().int().positive().optional().default(300),
  on_expire: z.enum(["discard"]).optional().default("discard"),
});

export function btwSteerRoutes(processor: QueueProcessor): Hono {
  const app = new Hono();

  // BTW — ephemeral side query
  app.post("/:agentKey/btw", canWrite, async (c) => {
    const agentKey = c.req.param("agentKey");
    const body = btwRequestSchema.safeParse(await c.req.json());
    if (!body.success) {
      return c.json({ error: "invalid_request", details: body.error.issues }, 400);
    }

    const target = processor.resolveActiveTaskTarget(agentKey, {
      conversationId: body.data.conversation_id,
    });
    if ("error" in target) {
      const { status, ...rest } = target;
      return c.json(rest, status as 400);
    }

    try {
      const result = await processor.handleBtw(agentKey, target.message_id, body.data.question, body.data.source);
      if (!result) {
        return c.json({ error: "context_unavailable", message: "No cached context for this task" }, 404);
      }
      return c.json(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes("Rate limit")) {
        return c.json({ error: "rate_limited", message: err.message }, 429);
      }
      throw err;
    }
  });

  // Steer — mid-task context injection
  app.post("/:agentKey/steer", canWrite, async (c) => {
    const agentKey = c.req.param("agentKey");
    const body = steerRequestSchema.safeParse(await c.req.json());
    if (!body.success) {
      return c.json({ error: "invalid_request", details: body.error.issues }, 400);
    }

    const target = processor.resolveActiveTaskTarget(agentKey, {
      conversationId: body.data.conversation_id,
    });
    if ("error" in target) {
      const { status, ...rest } = target;
      return c.json(rest, status as 400);
    }

    try {
      const result = await processor.handleSteer(agentKey, target.message_id, target.conversation_id, body.data);
      return c.json(result, 201);
    } catch (err) {
      if (err instanceof Error && err.message.includes("Steers not initialized")) {
        return c.json({ error: "steers_not_initialized", message: err.message }, 503);
      }
      throw err;
    }
  });

  return app;
}

import { Hono } from "hono";
import type { QueueDB } from "../../queue/db.js";
import type { DelegationRunStore } from "../../runs/store.js";
import { clampInt } from "../../utils/parse.js";
import { canRead, canWrite } from "../middleware/rbac.js";

export function queueRoutes(queue: QueueDB, runs?: DelegationRunStore): Hono {
  const app = new Hono();

  // GET /api/queue/stats — Queue statistics
  app.get("/stats", canRead, (c) => {
    return c.json(queue.getQueueStats());
  });

  // GET /api/queue/messages — Recent messages
  app.get("/messages", canRead, (c) => {
    const limit = clampInt(c.req.query("limit"), 20, 1, 200);
    return c.json(queue.getRecentMessages(limit));
  });

  // GET /api/queue/dead-letters — Failed messages
  app.get("/dead-letters", canRead, (c) => {
    return c.json(queue.getDeadLetters());
  });

  // GET /api/queue/failed — Failed messages awaiting review/cleanup
  app.get("/failed", canRead, (c) => {
    return c.json(queue.getFailedMessages());
  });

  app.get("/health", canRead, (c) => {
    const deadLetterLimit = clampInt(c.req.query("dead_letter_limit"), 20, 1, 100);
    const report = queue.getQueueHealth({ deadLetterLimit });
    const staleRunning = runs?.getStaleRunningCount() ?? 0;
    return c.json({
      ...report,
      stale_running: staleRunning,
      queueDepth: report.stats.pending,
      processing: report.stats.processing,
      deadLetters: report.dead_letters.total,
      retryableDeadLetters: report.dead_letters.retryable,
      staleProcessing: report.stale_processing.length,
      stalePending: report.stale_pending.length,
      staleRunning,
    });
  });

  // DELETE /api/queue/dead-letters — Clear all dead letters
  app.delete("/dead-letters", canWrite, (c) => {
    const cleared = queue.clearDeadLetters();
    return c.json({ cleared });
  });

  // DELETE /api/queue/dead-letters/:id — Clear specific dead letter
  app.delete("/dead-letters/:id", canWrite, (c) => {
    const id = c.req.param("id");
    const ok = queue.clearDeadLetter(id);
    if (!ok) return c.json({ error: "Not found" }, 404);
    return c.json({ cleared: 1 });
  });

  // DELETE /api/queue/failed — Clear all failed messages
  app.delete("/failed", canWrite, (c) => {
    const cleared = queue.clearFailedMessages();
    return c.json({ cleared });
  });

  // DELETE /api/queue/failed/:id — Clear specific failed message
  app.delete("/failed/:id", canWrite, (c) => {
    const id = c.req.param("id");
    const ok = queue.clearFailedMessage(id);
    if (!ok) return c.json({ error: "Not found" }, 404);
    return c.json({ cleared: 1 });
  });

  // POST /api/responses/ack — Acknowledge responses
  app.post("/responses/ack", canWrite, async (c) => {
    const body = await c.req.json<{ ids: number[] }>();
    if (!body.ids?.length) {
      return c.json({ error: "ids array is required" }, 400);
    }
    queue.ackResponses(body.ids);
    return c.json({ acked: body.ids.length });
  });

  return app;
}

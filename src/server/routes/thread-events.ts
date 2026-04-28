import { Hono } from "hono";
import type { AuthEnv } from "../../auth/types.js";
import type { ThreadDB } from "../db/threads.js";
import type { QueueProcessor } from "../../queue/processor.js";
import { canRead } from "../middleware/rbac.js";

export function threadEventRoutes(
  threadDb: ThreadDB,
  processor: QueueProcessor,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // GET /api/threads/:id/events — Per-thread SSE stream
  app.get("/threads/:id/events", canRead, (c) => {
    const threadId = c.req.param("id");
    const thread = threadDb.getThread(threadId);
    if (!thread) return c.json({ error: "Thread not found" }, 404);

    const encoder = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval>;
    let unsubscribe: () => void;

    const stream = new ReadableStream({
      start(controller) {
        // Send initial connected comment
        controller.enqueue(encoder.encode(": connected\n\n"));

        // Send current thread status as first event
        try {
          const statusData = JSON.stringify({
            type: "thread:status",
            status: thread.status,
            agent: thread.agent,
            timestamp: Date.now(),
          });
          controller.enqueue(encoder.encode(`event: thread:status\ndata: ${statusData}\n\n`));
        } catch { /* stream closed */ }

        // Subscribe to this thread's events
        unsubscribe = processor.onThreadEvent(threadId, (event) => {
          try {
            const data = JSON.stringify({ type: event.type, ...event.data, timestamp: event.timestamp });
            controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${data}\n\n`));
          } catch { /* stream closed */ }
        });

        // Heartbeat every 15s
        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            clearInterval(heartbeat);
            if (unsubscribe) unsubscribe();
          }
        }, 15_000);

        // Cleanup on abort
        c.req.raw.signal.addEventListener("abort", () => {
          if (unsubscribe) unsubscribe();
          clearInterval(heartbeat);
        });
      },
      cancel() {
        if (unsubscribe) unsubscribe();
        clearInterval(heartbeat);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });

  return app;
}

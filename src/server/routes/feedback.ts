import { Hono } from "hono";
import type { FeedbackStore } from "../../memory/feedback.js";
import { canRead, canWrite } from "../middleware/rbac.js";

export function feedbackRoutes(feedbackStore: FeedbackStore): Hono {
  const app = new Hono();

  // POST /api/feedback — submit feedback on a response
  app.post("/", canWrite, async (c) => {
    const body = await c.req.json<{
      message_id: string;
      rating: 1 | -1;
      channel?: string;
      sender_id?: string;
      comment?: string;
      knowledge_sources?: string[];
    }>();

    if (!body.message_id) {
      return c.json({ error: "message_id is required" }, 400);
    }
    if (body.rating !== 1 && body.rating !== -1) {
      return c.json({ error: "rating must be 1 (positive) or -1 (negative)" }, 400);
    }

    const feedback = feedbackStore.addFeedback({
      messageId: body.message_id,
      channel: body.channel,
      senderId: body.sender_id,
      rating: body.rating,
      comment: body.comment,
      knowledgeSources: body.knowledge_sources,
    });

    return c.json(feedback, 201);
  });

  // GET /api/feedback — recent feedback
  app.get("/", canRead, (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(feedbackStore.getRecentFeedback(limit));
  });

  // GET /api/feedback/stats — feedback statistics
  app.get("/stats", canRead, (c) => {
    return c.json(feedbackStore.getStats());
  });

  // GET /api/feedback/flagged — flagged knowledge chunks
  app.get("/flagged", canRead, (c) => {
    return c.json(feedbackStore.getFlaggedChunks());
  });

  // GET /api/feedback/scores — all chunk scores
  app.get("/scores", canRead, (c) => {
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(feedbackStore.getChunkScores(limit));
  });

  // POST /api/feedback/unflag — unflag a knowledge chunk (after review)
  app.post("/unflag", canWrite, async (c) => {
    const body = await c.req.json<{ source_path: string; section?: string }>();
    if (!body.source_path) {
      return c.json({ error: "source_path is required" }, 400);
    }
    const ok = feedbackStore.unflagChunk(body.source_path, body.section);
    return c.json({ ok });
  });

  return app;
}

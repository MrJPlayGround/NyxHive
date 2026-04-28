import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../auth/types.js";
import type { ThreadDB } from "../db/threads.js";
import { generateTitle } from "../db/threads.js";
import type { QueueProcessor } from "../../queue/processor.js";
import type { DelegationRunStore } from "../../runs/store.js";
import { parseBody } from "./validate.js";
import { formatError } from "../../utils/error.js";
import { canRead, canWrite } from "../middleware/rbac.js";
import { MAX_BASE64_ATTACHMENT_CHARS, normalizeInboundAttachments } from "../../security/attachments.js";
import { buildAttachmentBlockedPathReport } from "../../runs/blockers.js";
import { recordInboundArtifactAcquisitionFailures } from "../../artifacts/inbound.js";

const createSessionSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._:-]+$/)
    .optional(),
  agent: z.string().optional(),
  title: z.string().optional(),
});

const renameSessionSchema = z.object({
  title: z.string().optional(),
  label: z.string().optional(),
});

const sessionMessageSchema = z.object({
  message: z.string().min(1),
  agent: z.string().optional(),
  model_override: z.string().optional(),
  reasoning_effort: z.enum(["low", "medium", "high", "max"]).optional(),
  conversation_mode: z.enum(["quick", "task", "build", "deep"]).optional(),
  sender: z.string().trim().min(1).max(200).optional(),
  sender_id: z.string().trim().min(1).max(200).optional(),
  senderId: z.string().trim().min(1).max(200).optional(),
  async: z.boolean().optional(),
  stream: z.boolean().optional(),
  images: z.array(z.object({
    type: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    data: z.string().max(MAX_BASE64_ATTACHMENT_CHARS, "Image data exceeds 10MB limit"),
  })).max(5).optional(),
  files: z.array(z.object({
    name: z.string(),
    type: z.string(),
    data: z.string().max(MAX_BASE64_ATTACHMENT_CHARS, "File data exceeds 10MB limit"),
  })).max(5).optional(),
});

export function sessionRoutes(
  threadDb: ThreadDB,
  processor: QueueProcessor,
  instance: string,
  opts?: {
    runs?: DelegationRunStore;
  },
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // POST /api/sessions — Create a new session
  app.post("/", canWrite, async (c) => {
    const result = await parseBody(c, createSessionSchema);
    if (result instanceof Response) return result;
    const body = result;
    if (body.id) {
      const existing = threadDb.getThread(body.id);
      if (existing && existing.category === "session") {
        return c.json({
          session_id: existing.id,
          created_at: existing.created_at,
          agent: existing.agent,
          title: existing.title,
        });
      }
      if (existing) {
        return c.json({ error: "Thread id already exists" }, 409);
      }
    }

    const session = threadDb.createSession({
      id: body.id,
      agent: body.agent,
      title: body.title,
      instance,
    });

    return c.json({
      session_id: session.id,
      created_at: session.created_at,
      agent: session.agent,
      title: session.title,
    }, 201);
  });

  // POST /api/sessions/:id/message — Process a turn within a session
  app.post("/:id/message", canWrite, async (c) => {
    const sessionId = c.req.param("id");
    const session = threadDb.getThread(sessionId);
    if (!session || session.category !== "session") {
      return c.json({ error: "Session not found" }, 404);
    }

    const result = await parseBody(c, sessionMessageSchema);
    if (result instanceof Response) return result;
    const body = result;

    const auth = c.get("auth");
    const isInternalClient =
      c.req.header("x-client-type")?.toLowerCase() === "nyx-internal";
    const sender =
      (isInternalClient ? body.sender : undefined) ||
      (auth?.type === "session" && auth.user
        ? auth.user.display_name
        : "api");
    const senderId =
      (isInternalClient ? body.sender_id || body.senderId : undefined) ||
      (auth?.type === "session" && auth.user ? auth.user.id : "api_key");
    const sessionChannel = `session:${sessionId}`;
    const prefersAsyncResponse = c.req.header("Prefer")
      ?.split(",")
      .map((value) => value.trim().toLowerCase())
      .includes("respond-async") ?? false;
    const useAsyncByDefault =
      body.async === undefined &&
      body.stream === undefined &&
      (isInternalClient || prefersAsyncResponse);
    let files;
    try {
      files = normalizeInboundAttachments({ images: body.images, files: body.files });
    } catch (error) {
      const blockedPath = opts?.runs?.recordBlockedPath(buildAttachmentBlockedPathReport({
        error,
        channel: sessionChannel,
        failed_path: "session.message.attachments.normalize",
      }));
      recordInboundArtifactAcquisitionFailures(opts?.runs, {
        channel: sessionChannel,
        source_prefix: "session.message",
        error,
        images: body.images,
        files: body.files,
      });
      return c.json({
        error: formatError(error),
        ...(blockedPath ? { blocked_path: blockedPath } : {}),
      }, 400);
    }
    const mergedFiles = files.length > 0 ? files : undefined;

    // Store user message in thread_messages before processing
    threadDb.addThreadMessage(sessionId, {
      role: "user",
      content: body.message,
    });

    // Stable channel per session — ConversationManager uses this to isolate history
    const agentKey = body.agent ?? session.agent ?? undefined;

    const doAfterComplete = (response: string, agent: string, messageId: string, cost: number, tokensIn: number, tokensOut: number) => {
      if (threadDb.getThreadMessageByMessageId(sessionId, messageId)) {
        return;
      }
      // Store assistant response
      threadDb.addThreadMessage(sessionId, {
        role: "assistant",
        content: response,
        agent,
        message_id: messageId,
        cost_cents: Math.round(cost * 100),
        tokens: tokensIn + tokensOut,
      });

      // Update session: auto-title on first exchange, accumulate cost
      const current = threadDb.getThread(sessionId);
      const accumulatedCost = (current?.cost_cents ?? 0) + Math.round(cost * 100);
      const messages = threadDb.getThreadMessages(sessionId);
      const isFirstExchange = messages.filter((m) => m.role === "assistant").length === 1;

      const updates: Parameters<typeof threadDb.updateThread>[1] = {
        cost_cents: accumulatedCost,
      };
      if (isFirstExchange && (!current?.title || current.title === "New Session")) {
        updates.title = generateTitle(body.message);
      }

      threadDb.updateThread(sessionId, updates);
    };

    if (body.async || useAsyncByDefault) {
      Promise.resolve()
        .then(() => processor.processImmediate({
          channel: sessionChannel,
          sender,
          sender_id: senderId,
          thread_id: sessionId,
          message: body.message,
          agent: agentKey,
          modelOverride: body.model_override,
          reasoningEffort: body.reasoning_effort,
          conversationMode: body.conversation_mode,
          files: mergedFiles,
        }))
        .then((r) => {
          doAfterComplete(r.response, r.agent, r.message_id, r.cost ?? 0, r.tokens_in ?? 0, r.tokens_out ?? 0);
        })
        .catch((err) => {
          threadDb.addThreadMessage(sessionId, {
            role: "assistant",
            content: `[Error: ${formatError(err)}]`,
            agent: agentKey,
          });
        });

      return c.json({
        session_id: sessionId,
        status: "accepted",
      }, 202);
    }

    // Stream mode (default) — SSE response
    if (body.stream !== false) {
      const encoder = new TextEncoder();
      let heartbeat: ReturnType<typeof setInterval>;
      let settled = false;

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(": connected\n\n"));

          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(": heartbeat\n\n"));
            } catch {
              clearInterval(heartbeat);
            }
          }, 15_000);

          const writeEvent = (type: string, data: Record<string, unknown>) => {
            try {
              const json = JSON.stringify({ type, ...data, timestamp: Date.now() });
              controller.enqueue(encoder.encode(`event: ${type}\ndata: ${json}\n\n`));
            } catch { /* stream closed */ }
          };

          processor.processImmediate({
            channel: sessionChannel,
            sender,
            sender_id: senderId,
            thread_id: sessionId,
            message: body.message,
            agent: agentKey,
            modelOverride: body.model_override,
            reasoningEffort: body.reasoning_effort,
            conversationMode: body.conversation_mode,
            files: mergedFiles,
            onEvent: (event) => writeEvent(event.type, event.data as Record<string, unknown>),
          }).then((r) => {
            settled = true;
            doAfterComplete(r.response, r.agent, r.message_id, r.cost ?? 0, r.tokens_in ?? 0, r.tokens_out ?? 0);
            writeEvent("response", {
              message_id: r.message_id,
              response: r.response,
              agent: r.agent,
              trace_id: r.trace_id,
              cost_cents: Math.round((r.cost ?? 0) * 100),
            });
            clearInterval(heartbeat);
            try { controller.close(); } catch { /* already closed */ }
          }).catch((err) => {
            settled = true;
            writeEvent("error", { error: formatError(err) });
            clearInterval(heartbeat);
            try { controller.close(); } catch { /* already closed */ }
          });
        },
        cancel() {
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
    }

    // Sync mode (stream: false)
    try {
      const r = await processor.processImmediate({
        channel: sessionChannel,
        sender,
        sender_id: senderId,
        thread_id: sessionId,
        message: body.message,
        agent: agentKey,
        modelOverride: body.model_override,
        reasoningEffort: body.reasoning_effort,
        conversationMode: body.conversation_mode,
        files: mergedFiles,
      });

      doAfterComplete(r.response, r.agent, r.message_id, r.cost ?? 0, r.tokens_in ?? 0, r.tokens_out ?? 0);

      return c.json({
        message_id: r.message_id,
        response: r.response,
        agent: r.agent,
        trace_id: r.trace_id,
      });
    } catch (err) {
      return c.json({ error: formatError(err) }, 500);
    }
  });

  // PATCH /api/sessions/:id — Rename a session
  app.patch("/:id", canWrite, async (c) => {
    const id = c.req.param("id");
    const session = threadDb.getThread(id);
    if (!session || session.category !== "session") {
      return c.json({ error: "Session not found" }, 404);
    }

    const result = await parseBody(c, renameSessionSchema);
    if (result instanceof Response) return result;
    const body = result;

    const rawTitle = body.title ?? body.label ?? "";
    const title = rawTitle.trim().slice(0, 120);
    if (!title) {
      return c.json({ error: "Title is required" }, 400);
    }

    const updated = threadDb.updateThread(id, { title });
    if (!updated) return c.json({ error: "Rename failed" }, 500);

    return c.json({
      session_id: updated.id,
      title: updated.title,
      agent: updated.agent,
      total_cost_cents: updated.cost_cents ?? 0,
      created_at: updated.created_at,
      updated_at: updated.updated_at,
    });
  });

  // GET /api/sessions/:id — Session info + last 20 messages
  app.get("/:id", canRead, (c) => {
    const id = c.req.param("id");
    const session = threadDb.getThread(id);
    if (!session || session.category !== "session") {
      return c.json({ error: "Session not found" }, 404);
    }

    const messages = threadDb.getThreadMessages(id, 20);

    return c.json({
      session_id: session.id,
      title: session.title,
      agent: session.agent,
      message_count: threadDb.countThreadMessages(id),
      total_cost_cents: session.cost_cents ?? 0,
      created_at: session.created_at,
      updated_at: session.updated_at,
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        agent: m.agent ?? null,
        created_at: m.timestamp,
      })),
    });
  });

  // GET /api/sessions — List sessions, ordered by updated_at desc
  app.get("/", canRead, (c) => {
    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
    const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

    const result = threadDb.listThreads({ category: "session", limit, offset });

    return c.json({
      sessions: result.threads.map((t) => ({
        session_id: t.id,
        title: t.title,
        agent: t.agent ?? null,
        total_cost_cents: t.cost_cents ?? 0,
        created_at: t.created_at,
        updated_at: t.updated_at,
      })),
      total: result.total,
    });
  });

  // POST /api/sessions/:id/undo — Remove last exchange (assistant + user message pair)
  app.post("/:id/undo", canWrite, (c) => {
    const id = c.req.param("id");
    const session = threadDb.getThread(id);
    if (!session || session.category !== "session") {
      return c.json({ error: "Session not found" }, 404);
    }
    const deleted = threadDb.undoLastExchange(id);
    return c.json({ deleted });
  });

  // DELETE /api/sessions/:id — Delete session + messages
  app.delete("/:id", canWrite, (c) => {
    const id = c.req.param("id");
    const session = threadDb.getThread(id);
    if (!session || session.category !== "session") {
      return c.json({ error: "Session not found" }, 404);
    }

    const deleted = threadDb.deleteThread(id);
    if (!deleted) return c.json({ error: "Delete failed" }, 500);

    return c.json({ deleted: true });
  });

  return app;
}

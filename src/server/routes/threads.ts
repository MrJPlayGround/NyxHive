import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../auth/types.js";
import type { ThreadDB } from "../db/threads.js";
import type { QueueProcessor } from "../../queue/processor.js";
import type { QueueDB } from "../../queue/db.js";
import type { NyxHiveConfig } from "../../types.js";
import { parseBody } from "./validate.js";
import { canRead, canWrite } from "../middleware/rbac.js";
import { resolveAgentRuntimePath } from "../../agents/paths.js";

const createThreadSchema = z.object({
  message: z.string().min(1),
  project_id: z.string().optional(),
  agent: z.string().optional(),
  title: z.string().optional(),
});

const followUpSchema = z.object({
  message: z.string().min(1),
  agent: z.string().optional(),
});

const updateThreadSchema = z.object({
  title: z.string().optional(),
  project_id: z.string().nullable().optional(),
  archived: z.boolean().optional(),
});

/**
 * Resolve a project_id for a new thread:
 * 1. Use explicit project_id if provided
 * 2. Match agent's working_directory against configured project repo_paths
 * 3. Fall back to the default project
 * 4. Fall back to the first project for this instance
 */
function resolveProjectId(
  threadDb: ThreadDB,
  config: NyxHiveConfig,
  baseDir: string,
  agent?: string,
  explicitProjectId?: string,
): string | undefined {
  if (explicitProjectId) return explicitProjectId;

  const projects = config.daemon.projects;
  if (!projects?.length) return undefined;

  const instanceName = config.daemon.name;
  const dbProjects = threadDb.listProjects().filter(p => p.instance === instanceName);

  // If agent specified, try to match agent's working_directory against project repo_paths
  if (agent && config.agents[agent]) {
    const agentDir = resolveAgentRuntimePath(baseDir, config.agents[agent].working_directory);
    if (agentDir) {
      for (const proj of projects) {
        if (agentDir.startsWith(proj.repo_path) || proj.repo_path.startsWith(agentDir)) {
          const match = dbProjects.find(p => p.name === proj.name);
          if (match) return match.id;
        }
      }
    }
  }

  // Fall back to default project
  const defaultProj = projects.find(p => p.default);
  if (defaultProj) {
    const match = dbProjects.find(p => p.name === defaultProj.name);
    if (match) return match.id;
  }

  // Fall back to first project
  return dbProjects[0]?.id;
}

function resolveInitialThreadTitle(body: z.infer<typeof createThreadSchema>): string | undefined {
  const explicitTitle = body.title?.trim();
  if (explicitTitle) return explicitTitle;
  const message = body.message.trim();
  return message.length <= 60 ? message : undefined;
}

export function threadRoutes(
  threadDb: ThreadDB,
  processor: QueueProcessor,
  queue: QueueDB,
  instance: string,
  config: NyxHiveConfig,
  baseDir: string,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // POST /api/threads — Create thread + enqueue
  app.post("/threads", canWrite, async (c) => {
    const result = await parseBody(c, createThreadSchema);
    if (result instanceof Response) return result;
    const body = result;

    // Resolve project: explicit > agent match > default
    const projectId = resolveProjectId(threadDb, config, baseDir, body.agent, body.project_id);

    // Validate project exists if explicitly provided
    if (body.project_id) {
      const project = threadDb.getProject(body.project_id);
      if (!project) return c.json({ error: "Project not found" }, 404);
    }

    // Create thread record
    const thread = threadDb.createThread({
      message: body.message,
      project_id: projectId,
      agent: body.agent,
      title: resolveInitialThreadTitle(body),
      instance,
    });

    // Enqueue to the real queue with thread_id
    const auth = c.get("auth");
    const sender = auth?.type === "session" && auth.user
      ? auth.user.display_name
      : "api";
    const senderId = auth?.type === "session" && auth.user
      ? auth.user.id
      : "api_key";

    const messageId = queue.enqueueMessage({
      channel: "api",
      sender,
      sender_id: senderId,
      message: body.message,
      agent: body.agent,
      thread_id: thread.id,
    });

    // Update thread with queued status and message_id
    const queued = threadDb.updateThread(thread.id, {
      status: "queued",
      message_id: messageId,
    });

    // Emit status event
    processor.emitThreadEvent(thread.id, "thread:status", { status: "queued" });

    return c.json({
      id: queued!.id,
      title: queued!.title,
      status: queued!.status,
      message_id: messageId,
    }, 201);
  });

  // GET /api/threads/search — Full-text search
  app.get("/threads/search", canRead, (c) => {
    const q = c.req.query("q");
    if (!q) return c.json({ results: [] });
    const results = threadDb.searchThreads(q);
    return c.json({ results });
  });

  // GET /api/threads — List with filters
  app.get("/threads", canRead, (c) => {
    const projectId = c.req.query("project_id");
    const status = c.req.query("status");
    const agent = c.req.query("agent");
    const archived = c.req.query("archived") === "true";
    const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
    const offset = Math.max(Number(c.req.query("offset")) || 0, 0);

    const result = threadDb.listThreads({
      project_id: projectId,
      status,
      agent,
      archived,
      limit,
      offset,
    });

    return c.json(result);
  });

  // GET /api/threads/:id — Thread + messages
  app.get("/threads/:id", canRead, (c) => {
    const id = c.req.param("id");
    const thread = threadDb.getThread(id);
    if (!thread) return c.json({ error: "Thread not found" }, 404);
    return c.json(thread);
  });

  // PUT /api/threads/:id — Update
  app.put("/threads/:id", canWrite, async (c) => {
    const id = c.req.param("id");
    const existing = threadDb.getThread(id);
    if (!existing) return c.json({ error: "Thread not found" }, 404);

    const result = await parseBody(c, updateThreadSchema);
    if (result instanceof Response) return result;
    const body = result;

    const updates: Record<string, unknown> = {};
    if (body.title !== undefined) updates.title = body.title;
    if (body.project_id !== undefined) updates.project_id = body.project_id;
    if (body.archived !== undefined) updates.archived = body.archived;

    const updated = threadDb.updateThread(id, updates as Parameters<typeof threadDb.updateThread>[1]);
    return c.json(updated);
  });

  // DELETE /api/threads/:id — Delete
  app.delete("/threads/:id", canWrite, (c) => {
    const id = c.req.param("id");
    const deleted = threadDb.deleteThread(id);
    if (!deleted) return c.json({ error: "Thread not found" }, 404);
    return c.json({ deleted: true });
  });

  // POST /api/threads/:id/messages — Follow-up
  app.post("/threads/:id/messages", canWrite, async (c) => {
    const id = c.req.param("id");
    const thread = threadDb.getThread(id);
    if (!thread) return c.json({ error: "Thread not found" }, 404);

    if (thread.status !== "completed" && thread.status !== "failed") {
      return c.json({ error: `Cannot send follow-up to thread in '${thread.status}' status` }, 400);
    }

    const result = await parseBody(c, followUpSchema);
    if (result instanceof Response) return result;
    const body = result;

    // Insert user message
    threadDb.addThreadMessage(id, {
      role: "user",
      content: body.message,
    });

    // Enqueue follow-up to the real queue
    const auth = c.get("auth");
    const sender = auth?.type === "session" && auth.user
      ? auth.user.display_name
      : "api";
    const senderId = auth?.type === "session" && auth.user
      ? auth.user.id
      : "api_key";

    const messageId = queue.enqueueMessage({
      channel: "api",
      sender,
      sender_id: senderId,
      message: body.message,
      agent: body.agent ?? thread.agent ?? undefined,
      thread_id: id,
    });

    // Update thread status back to queued
    threadDb.updateThread(id, { status: "queued", message_id: messageId });

    // Emit status event
    processor.emitThreadEvent(id, "thread:status", { status: "queued" });

    return c.json({ message_id: messageId, status: "queued" });
  });

  // POST /api/threads/:id/cancel — Cancel
  app.post("/threads/:id/cancel", canWrite, (c) => {
    const id = c.req.param("id");
    const thread = threadDb.getThread(id);
    if (!thread) return c.json({ error: "Thread not found" }, 404);

    if (thread.status === "completed" || thread.status === "cancelled") {
      return c.json({ error: `Cannot cancel thread in '${thread.status}' status` }, 400);
    }

    threadDb.updateThread(id, { status: "cancelled" });
    processor.emitThreadEvent(id, "thread:status", { status: "cancelled" });

    return c.json({ status: "cancelled" });
  });

  // GET /api/threads/:id/changes — File changes for a thread
  app.get("/threads/:id/changes", canRead, (c) => {
    const threadId = c.req.param("id");
    const thread = threadDb.getThread(threadId);
    if (!thread) return c.json({ error: "Thread not found" }, 404);
    const changes = threadDb.getFileChanges(threadId);
    return c.json({ changes });
  });

  return app;
}

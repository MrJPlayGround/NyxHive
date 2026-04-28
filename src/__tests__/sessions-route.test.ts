import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AuthEnv } from "../auth/types.js";
import { DelegationRunStore } from "../runs/store.js";
import { ThreadDB } from "../server/db/threads.js";
import { sessionRoutes } from "../server/routes/sessions.js";

function withAuth(
  routes: Hono<AuthEnv>,
  basePath: string,
  auth: Record<string, unknown> = { type: "api_key", role: "owner" },
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("auth" as never, auth as never);
    return next();
  });
  app.route(basePath, routes);
  return app;
}

describe("session routes", () => {
  let tmpDir: string;
  let db: Database;
  let threadDb: ThreadDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sessions-route-test-"));
    db = new Database(join(tmpDir, "threads.db"));
    threadDb = new ThreadDB(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("POST /api/sessions creates a session and GET /api/sessions lists sessions newest-first", async () => {
    const app = withAuth(sessionRoutes(threadDb, {} as any, "test"), "/api/sessions");

    const first = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "onyx", title: "First session" }),
    });
    const firstBody = await first.json();

    await Bun.sleep(2);

    const second = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "opal", title: "Second session" }),
    });
    const secondBody = await second.json();

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(threadDb.getThread(firstBody.session_id)?.category).toBe("session");
    expect(threadDb.getThread(secondBody.session_id)?.agent).toBe("opal");

    const res = await app.request("/api/sessions");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0]).toMatchObject({
      session_id: secondBody.session_id,
      title: "Second session",
      agent: "opal",
      total_cost_cents: 0,
    });
    expect(body.sessions[1]).toMatchObject({
      session_id: firstBody.session_id,
      title: "First session",
      agent: "onyx",
      total_cost_cents: 0,
    });
  });

  test("POST /api/sessions honors requested ids and is idempotent for existing sessions", async () => {
    const app = withAuth(
      sessionRoutes(threadDb, {} as any, "test"),
      "/api/sessions",
    );

    const first = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "workspace-thread-1",
        agent: "nyx",
        title: "Workspace chat",
      }),
    });
    const second = await app.request("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "workspace-thread-1",
        agent: "nyx",
        title: "Workspace chat",
      }),
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({
      session_id: "workspace-thread-1",
      agent: "nyx",
      title: "Workspace chat",
    });
    expect(await second.json()).toMatchObject({
      session_id: "workspace-thread-1",
      agent: "nyx",
      title: "Workspace chat",
    });
    expect(threadDb.getThread("workspace-thread-1")?.category).toBe("session");
  });

  test("GET /api/sessions/:id returns the true message count, not the sliced page length", async () => {
    const session = threadDb.createSession({ instance: "test", agent: "onyx", title: "Big Session" });

    for (let idx = 0; idx < 42; idx += 1) {
      threadDb.addThreadMessage(session.id, {
        role: idx % 2 === 0 ? "user" : "assistant",
        content: `message ${idx}`,
        agent: idx % 2 === 0 ? undefined : "onyx",
      });
    }
    threadDb.updateThread(session.id, { cost_cents: 123 });

    const app = withAuth(sessionRoutes(threadDb, {} as any, "test"), "/api/sessions");
    const res = await app.request(`/api/sessions/${session.id}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session_id).toBe(session.id);
    expect(body.message_count).toBe(42);
    expect(body.total_cost_cents).toBe(123);
    expect(body.messages).toHaveLength(20);
    expect(body.messages[0]?.content).toBe("message 22");
    expect(body.messages[19]?.content).toBe("message 41");
  });

  test("PATCH /api/sessions/:id renames a session and persists the title", async () => {
    const session = threadDb.createSession({
      instance: "test",
      agent: "onyx",
      title: "Old title",
    });
    const app = withAuth(
      sessionRoutes(threadDb, {} as any, "test"),
      "/api/sessions",
    );

    const res = await app.request(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Organized session" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      session_id: session.id,
      title: "Organized session",
      agent: "onyx",
    });
    expect(threadDb.getThread(session.id)?.title).toBe("Organized session");

    const list = await app.request("/api/sessions");
    const listBody = await list.json();
    expect(listBody.sessions[0]).toMatchObject({
      session_id: session.id,
      title: "Organized session",
    });
  });

  test("PATCH /api/sessions/:id rejects blank titles", async () => {
    const session = threadDb.createSession({
      instance: "test",
      agent: "onyx",
      title: "Old title",
    });
    const app = withAuth(
      sessionRoutes(threadDb, {} as any, "test"),
      "/api/sessions",
    );

    const res = await app.request(`/api/sessions/${session.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });

    expect(res.status).toBe(400);
    expect(threadDb.getThread(session.id)?.title).toBe("Old title");
  });

  test("POST /api/sessions/:id/message sync mode stores both turns, auto-titles the first exchange, and accumulates cost", async () => {
    const session = threadDb.createSession({ instance: "test", agent: "onyx", title: "New Session" });
    const calls: Array<Record<string, unknown>> = [];
    let invocation = 0;
    const processor = {
      processImmediate: async (opts: Record<string, unknown>) => {
        calls.push(opts);
        invocation += 1;
        if (invocation === 1) {
          return {
            response: "alive",
            agent: "onyx",
            message_id: "msg-1",
            trace_id: "trace-1",
            cost: 0.12,
            tokens_in: 10,
            tokens_out: 5,
          };
        }
        return {
          response: "second reply",
          agent: "opal",
          message_id: "msg-2",
          trace_id: "trace-2",
          cost: 0.34,
          tokens_in: 20,
          tokens_out: 10,
        };
      },
    };

    const auth = {
      type: "session",
      role: "user",
      user: {
        id: "user-1",
        email: "casey@example.com",
        display_name: "Casey",
        role: "user",
        is_active: 1,
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-01-01T00:00:00.000Z",
        last_login_at: null,
      },
    };
    const app = withAuth(sessionRoutes(threadDb, processor as any, "test"), "/api/sessions", auth);

    const first = await app.request(`/api/sessions/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Reply with exactly: alive", stream: false }),
    });
    const second = await app.request(`/api/sessions/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "What changed?",
        stream: false,
        agent: "opal",
        model_override: "gpt-4.1",
        reasoning_effort: "low",
        conversation_mode: "quick",
      }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({
      message_id: "msg-1",
      response: "alive",
      agent: "onyx",
      trace_id: "trace-1",
    });
    expect(await second.json()).toMatchObject({
      message_id: "msg-2",
      response: "second reply",
      agent: "opal",
      trace_id: "trace-2",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      channel: `session:${session.id}`,
      sender: "Casey",
      sender_id: "user-1",
      message: "Reply with exactly: alive",
      agent: "onyx",
      modelOverride: undefined,
      reasoningEffort: undefined,
    });
    expect(calls[1]).toMatchObject({
      channel: `session:${session.id}`,
      sender: "Casey",
      sender_id: "user-1",
      message: "What changed?",
      agent: "opal",
      modelOverride: "gpt-4.1",
      reasoningEffort: "low",
      conversationMode: "quick",
    });

    const updated = threadDb.getThread(session.id);
    const messages = threadDb.getThreadMessages(session.id);

    expect(updated?.title).toBe("Ping check");
    expect(updated?.cost_cents).toBe(46);
    expect(messages).toHaveLength(4);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(messages[1]).toMatchObject({
      content: "alive",
      agent: "onyx",
      message_id: "msg-1",
      cost_cents: 12,
      tokens: 15,
    });
    expect(messages[3]).toMatchObject({
      content: "second reply",
      agent: "opal",
      message_id: "msg-2",
      cost_cents: 34,
      tokens: 30,
    });
  });

  test("POST /api/sessions/:id/message async mode accepts the turn without waiting for processor completion", async () => {
    const session = threadDb.createSession({
      instance: "test",
      agent: "nyx",
      title: "New Session",
    });
    let resolveWork: (() => void) | undefined;
    const processor = {
      processImmediate: mock((_opts: Record<string, unknown>) => new Promise((resolve) => {
        resolveWork = () => resolve({
          response: "accepted later",
          agent: "nyx",
          message_id: "msg-async",
          trace_id: "trace-async",
          cost: 0,
          tokens_in: 1,
          tokens_out: 1,
        });
      })),
    };
    const app = withAuth(sessionRoutes(threadDb, processor as any, "test"), "/api/sessions");

    const res = await app.request(`/api/sessions/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Long execution brief",
        async: true,
      }),
    });

    try {
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({
        status: "accepted",
        session_id: session.id,
      });
      expect(processor.processImmediate).toHaveBeenCalledTimes(1);
      expect(threadDb.getThreadMessages(session.id)).toHaveLength(1);
    } finally {
      resolveWork?.();
      await Bun.sleep(1);
    }

    const messages = threadDb.getThreadMessages(session.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "accepted later",
      agent: "nyx",
      message_id: "msg-async",
    });
  });

  test("POST /api/sessions/:id/message defaults internal handoffs to async acceptance", async () => {
    const session = threadDb.createSession({
      instance: "test",
      agent: "nyx",
      title: "New Session",
    });
    let resolveWork: (() => void) | undefined;
    const processor = {
      processImmediate: mock((_opts: Record<string, unknown>) => new Promise((resolve) => {
        resolveWork = () => resolve({
          response: "accepted later",
          agent: "nyx",
          message_id: "msg-internal-async",
          trace_id: "trace-internal-async",
          cost: 0,
          tokens_in: 1,
          tokens_out: 1,
        });
      })),
    };
    const app = withAuth(sessionRoutes(threadDb, processor as any, "test"), "/api/sessions");

    const res = await app.request(`/api/sessions/${session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Type": "nyx-internal",
      },
      body: JSON.stringify({
        message: "Execute the full brief.",
      }),
    });

    try {
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({
        status: "accepted",
        session_id: session.id,
      });
      expect(processor.processImmediate).toHaveBeenCalledTimes(1);
      expect(threadDb.getThreadMessages(session.id)).toHaveLength(1);
    } finally {
      resolveWork?.();
      await Bun.sleep(1);
    }

    const messages = threadDb.getThreadMessages(session.id);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "accepted later",
      agent: "nyx",
      message_id: "msg-internal-async",
    });
  });

  test("POST /api/sessions/:id/message preserves explicit streaming for internal callers", async () => {
    const session = threadDb.createSession({
      instance: "test",
      agent: "nyx",
      title: "New Session",
    });
    const processor = {
      processImmediate: async (opts: {
        onEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
      }) => {
        opts.onEvent?.({ type: "token", data: { text: "ok", agent: "nyx" } });
        return {
          response: "streamed",
          agent: "nyx",
          message_id: "msg-internal-stream",
          trace_id: "trace-internal-stream",
          cost: 0,
          tokens_in: 1,
          tokens_out: 1,
        };
      },
    };
    const app = withAuth(sessionRoutes(threadDb, processor as any, "test"), "/api/sessions");

    const res = await app.request(`/api/sessions/${session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Type": "nyx-internal",
      },
      body: JSON.stringify({
        message: "Stream this reply.",
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain("event: token");
    expect(body).toContain("event: response");
  });

  test("POST /api/sessions/:id/message honors Prefer: respond-async for wrapper-friendly handoffs", async () => {
    const session = threadDb.createSession({
      instance: "test",
      agent: "nyx",
      title: "New Session",
    });
    let resolveWork: (() => void) | undefined;
    const processor = {
      processImmediate: mock((_opts: Record<string, unknown>) => new Promise((resolve) => {
        resolveWork = () => resolve({
          response: "accepted later",
          agent: "nyx",
          message_id: "msg-prefer-async",
          trace_id: "trace-prefer-async",
          cost: 0,
          tokens_in: 1,
          tokens_out: 1,
        });
      })),
    };
    const app = withAuth(sessionRoutes(threadDb, processor as any, "test"), "/api/sessions");

    const res = await app.request(`/api/sessions/${session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Prefer: "respond-async",
      },
      body: JSON.stringify({
        message: "Execute the full brief.",
      }),
    });

    try {
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({
        status: "accepted",
        session_id: session.id,
      });
      expect(processor.processImmediate).toHaveBeenCalledTimes(1);
      expect(threadDb.getThreadMessages(session.id)).toHaveLength(1);
    } finally {
      resolveWork?.();
      await Bun.sleep(1);
    }

    expect(threadDb.getThreadMessages(session.id)).toHaveLength(2);
  });

  test("POST /api/sessions/:id/message lets workspace API-key calls provide the human sender identity", async () => {
    const session = threadDb.createSession({
      instance: "test",
      agent: "nyx",
      title: "New Session",
    });
    const calls: Array<Record<string, unknown>> = [];
    const processor = {
      processImmediate: async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return {
          response: "hi jay",
          agent: "nyx",
          message_id: "msg-identity",
          trace_id: "trace-identity",
          cost: 0,
          tokens_in: 1,
          tokens_out: 1,
        };
      },
    };
    const app = withAuth(sessionRoutes(threadDb, processor as any, "test"), "/api/sessions");

    const res = await app.request(`/api/sessions/${session.id}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client-Type": "nyx-internal",
      },
      body: JSON.stringify({
        message: "Hi",
        stream: false,
        sender: "User",
        sender_id: "jay",
      }),
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      channel: `session:${session.id}`,
      sender: "User",
      sender_id: "jay",
      thread_id: session.id,
      message: "Hi",
    });
  });

  test("POST /api/sessions/:id/message sync mode forwards file attachments to the processor", async () => {
    const session = threadDb.createSession({
      instance: "test",
      agent: "nyx",
      title: "New Session",
    });
    const calls: Array<Record<string, unknown>> = [];
    const processor = {
      processImmediate: async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return {
          response: "saw image",
          agent: "nyx",
          message_id: "msg-attachment",
          trace_id: "trace-attachment",
          cost: 0,
          tokens_in: 1,
          tokens_out: 1,
        };
      },
    };
    const app = withAuth(
      sessionRoutes(threadDb, processor as any, "test"),
      "/api/sessions",
    );

    const res = await app.request(`/api/sessions/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "What is in this screenshot?",
        stream: false,
        files: [
          {
            name: "screenshot.png",
            type: "image/png",
            data: "aGVsbG8=",
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.files).toEqual([
      {
        name: "screenshot.png",
        mimeType: "image/png",
        base64: "aGVsbG8=",
        size: 5,
      },
    ]);
  });

  test("POST /api/sessions/:id/message records blocked path reports for unsupported attachment types", async () => {
    const session = threadDb.createSession({
      instance: "test",
      agent: "nyx",
      title: "New Session",
    });
    const runs = new DelegationRunStore(tmpDir, "session-blocked-paths");
    const processor = {
      processImmediate: mock(async () => ({
        response: "processed",
        agent: "nyx",
        message_id: "unused",
      })),
    };
    const app = withAuth(
      sessionRoutes(threadDb, processor as any, "test", { runs }),
      "/api/sessions",
    );

    const res = await app.request(`/api/sessions/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "read this",
        stream: false,
        files: [
          {
            name: "run.sh",
            type: "application/x-sh",
            data: "aGVsbG8=",
          },
        ],
      }),
    });

    expect(res.status).toBe(400);
    expect(processor.processImmediate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toContain("Unsupported attachment MIME type");
    expect(body.blocked_path).toMatchObject({
      channel: `session:${session.id}`,
      area: "attachment",
      failed_path: "session.message.attachments.normalize",
      missing_primitive: "attachment.mime.supported_handler",
      next_action: "fix",
      requires_approval: false,
    });

    const blockedPaths = runs.listBlockedPaths({ limit: 10 });
    expect(blockedPaths).toHaveLength(1);
    expect(blockedPaths[0]).toEqual(body.blocked_path);

    runs.close();
  });

  test("POST /api/sessions/:id/message ignores sender overrides from non-internal API-key calls", async () => {
    const session = threadDb.createSession({
      instance: "test",
      agent: "nyx",
      title: "New Session",
    });
    const calls: Array<Record<string, unknown>> = [];
    const processor = {
      processImmediate: async (opts: Record<string, unknown>) => {
        calls.push(opts);
        return {
          response: "hi",
          agent: "nyx",
          message_id: "msg-identity-fallback",
          trace_id: "trace-identity-fallback",
          cost: 0,
          tokens_in: 1,
          tokens_out: 1,
        };
      },
    };
    const app = withAuth(sessionRoutes(threadDb, processor as any, "test"), "/api/sessions");

    const res = await app.request(`/api/sessions/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Hi",
        stream: false,
        sender: "Mallory",
        sender_id: "mallory",
      }),
    });

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sender: "api",
      sender_id: "api_key",
      message: "Hi",
    });
  });

  test("POST /api/sessions/:id/message stream cancel detaches without aborting the active processor task", async () => {
    const session = threadDb.createSession({ instance: "test", agent: "onyx", title: "New Session" });
    const cancelTask = mock(() => ({ cancelled: true, agent: "onyx", elapsed: 1 }));
    const processor = {
      processImmediate: mock(() => new Promise(() => {})),
      cancelTask,
    };
    const app = withAuth(sessionRoutes(threadDb, processor as any, "test"), "/api/sessions");

    const res = await app.request(`/api/sessions/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Please wait" }),
    });

    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.cancel();

    expect(cancelTask).not.toHaveBeenCalled();
  });

  test("DELETE /api/sessions/:id removes the session and its messages", async () => {
    const session = threadDb.createSession({ instance: "test", title: "Disposable" });
    threadDb.addThreadMessage(session.id, { role: "user", content: "hello" });

    const app = withAuth(sessionRoutes(threadDb, {} as any, "test"), "/api/sessions");
    const res = await app.request(`/api/sessions/${session.id}`, { method: "DELETE" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(threadDb.getThread(session.id)).toBeNull();
    expect(threadDb.getThreadMessages(session.id)).toHaveLength(0);
  });
});

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { QueueDB } from "../queue/db.js";
import { DelegationRunStore } from "../runs/store.js";
import { messagesRoutes } from "../server/routes/messages.js";
import type { AuthEnv } from "../auth/types.js";

function withAuth(routes: Hono<AuthEnv>): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("auth" as never, { type: "api_key", role: "owner" } as never);
    return next();
  });
  app.route("/", routes);
  return app;
}

function getMessageStatus(msgStatus: string, hasResponse: boolean): string {
  if (msgStatus === "failed" || msgStatus === "dead_letter") return msgStatus;
  if (msgStatus === "suspended") return "suspended";
  if (hasResponse) return "completed";
  if (msgStatus === "processing") return "processing";
  if (msgStatus === "completed") return "completed";
  return "queued";
}

function getMessageError(status: string, lastError?: string): string | null {
  if (status !== "failed" && status !== "dead_letter") return null;
  return lastError?.trim() || null;
}

describe("QueueDB message lookup", () => {
  let tmpDir: string;
  let queue: QueueDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "msg-test-"));
    queue = new QueueDB(tmpDir);
  });

  afterEach(() => {
    queue.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("getMessageByMessageId returns enqueued message", () => {
    const id = queue.enqueueMessage({
      channel: "api",
      sender: "test",
      sender_id: "user1",
      message: "hello",
    });

    const msg = queue.getMessageByMessageId(id);
    expect(msg).not.toBeNull();
    expect(msg!.message_id).toBe(id);
    expect(msg!.message).toBe("hello");
    expect(msg!.status).toBe("pending");
  });

  test("getMessageByMessageId returns null for unknown id", () => {
    const msg = queue.getMessageByMessageId("nonexistent");
    expect(msg).toBeNull();
  });

  test("getResponseByMessageId returns null when no response exists", () => {
    const id = queue.enqueueMessage({
      channel: "api",
      sender: "test",
      message: "hello",
    });

    const resp = queue.getResponseByMessageId(id);
    expect(resp).toBeNull();
  });

  test("getResponseByMessageId returns response after enqueue", () => {
    const id = queue.enqueueMessage({
      channel: "api",
      sender: "test",
      message: "hello",
    });

    queue.enqueueResponse({
      message_id: id,
      channel: "api",
      sender: "test",
      message: "world",
      original_message: "hello",
      agent: "nyx",
    });

    const resp = queue.getResponseByMessageId(id);
    expect(resp).not.toBeNull();
    expect(resp!.message).toBe("world");
    expect(resp!.agent).toBe("nyx");
  });
});

describe("GET /api/message/:id route", () => {
  let tmpDir: string;
  let queue: QueueDB;
  let app: Hono;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "msg-route-test-"));
    queue = new QueueDB(tmpDir);

    // Minimal Hono app with just the GET route (no auth for unit tests)
    app = new Hono();
    app.get("/api/message/:id", (c) => {
      const messageId = c.req.param("id");
      const msg = queue.getMessageByMessageId(messageId);
      if (!msg) return c.json({ error: "Message not found" }, 404);

      const response = queue.getResponseByMessageId(messageId);
      const status = getMessageStatus(msg.status, Boolean(response));
      const suspended = status === "suspended" ? queue.getSuspendedMessage(messageId) : null;
      return c.json({
        message_id: messageId,
        status,
        response: response?.message ?? null,
        input_request: suspended ? suspended.request : null,
        error: getMessageError(status, msg.last_error),
        agent: response?.agent ?? msg.agent ?? null,
        activity: response ? null : (msg.last_activity ?? null),
        progress_text: response ? null : (msg.last_progress_text ?? null),
        progress_at: response ? null : (msg.last_progress_at ?? null),
        status_message: response ? null : (status === "processing" ? "Nyx is working..." : null),
        created_at: msg.created_at,
        completed_at: response?.created_at ?? null,
      });
    });
  });

  afterEach(() => {
    queue.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns 404 for unknown message", async () => {
    const res = await app.request("/api/message/nonexistent");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Message not found");
  });

  test("returns queued status for pending message", async () => {
    const id = queue.enqueueMessage({
      channel: "api",
      sender: "test",
      sender_id: "user1",
      message: "hello",
    });

    const res = await app.request(`/api/message/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message_id).toBe(id);
    expect(body.status).toBe("queued");
    expect(body.response).toBeNull();
  });

  test("returns processing status for claimed message", async () => {
    const id = queue.enqueueMessage({
      channel: "api",
      sender: "test",
      message: "hello",
      agent: "nyx",
    });

    // Claim the message to set status to processing
    queue.claimMessage("nyx");

    const res = await app.request(`/api/message/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("processing");
  });

  test("returns progress fields for in-flight work", async () => {
    const id = queue.enqueueMessage({
      channel: "api",
      sender: "test",
      message: "implement the fix",
      agent: "nyx",
      status: "processing",
    });
    queue.updateMessageProgress(id, {
      activity: "Reading src/agents/invoke-cli.ts",
      text: "Starting with the invocation path.",
    });

    const res = await app.request(`/api/message/${id}`);
    const body = await res.json();
    expect(body.status).toBe("processing");
    expect(body.activity).toBe("Reading src/agents/invoke-cli.ts");
    expect(body.progress_text).toBe("Starting with the invocation path.");
    expect(body.status_message).toBe("Nyx is working...");
    expect(body.progress_at).not.toBeNull();
    expect(body.error).toBeNull();
  });

  test("returns completed status with response", async () => {
    const id = queue.enqueueMessage({
      channel: "api",
      sender: "test",
      message: "hello",
    });

    queue.enqueueResponse({
      message_id: id,
      channel: "api",
      sender: "test",
      message: "Done!",
      original_message: "hello",
      agent: "forge",
    });

    const res = await app.request(`/api/message/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("completed");
    expect(body.response).toBe("Done!");
    expect(body.agent).toBe("forge");
    expect(body.completed_at).not.toBeNull();
  });

  test("preserves dead_letter status and exposes the error", async () => {
    const id = queue.enqueueMessage({
      channel: "api",
      sender: "test",
      message: "explode",
      agent: "nyx",
    });

    queue.updateMessageProgress(id, {
      activity: "Writing the risky change",
      text: "Halfway through the bad idea.",
    });
    queue.claimMessage("nyx");
    queue.failMessage(id, "kaboom", 1);
    queue.enqueueResponse({
      message_id: id,
      channel: "api",
      sender: "test",
      message: "I wasn't able to process your request.",
      original_message: "explode",
      agent: "nyx",
    });

    const res = await app.request(`/api/message/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("dead_letter");
    expect(body.error).toBe("kaboom");
    expect(body.response).toBe("I wasn't able to process your request.");
    expect(body.activity).toBeNull();
    expect(body.progress_text).toBeNull();
    expect(body.status_message).toBeNull();
  });

  test("returns suspended status with the active input request", async () => {
    const id = queue.enqueueMessage({
      channel: "api",
      sender: "test",
      sender_id: "user-1",
      message: "need clarification",
      agent: "nyx",
    });

    queue.suspendMessage({
      messageId: id,
      channel: "api",
      sender: "test",
      sender_id: "user-1",
      agent: "nyx",
      original_message: "need clarification",
      requestId: "clarify:test-1",
      request: {
        question: "Which repo should I touch?",
        options: [{ key: "nyxhive", description: "Backend orchestrator" }],
      },
      responseText: "Which repo should I touch?",
    });

    const res = await app.request(`/api/message/${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("suspended");
    expect(body.input_request).toEqual({
      question: "Which repo should I touch?",
      options: [{ key: "nyxhive", description: "Backend orchestrator" }],
    });
    expect(body.response).toBeNull();
  });
});

describe("POST /api/message route", () => {
  let tmpDir: string;
  let queue: QueueDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "msg-post-test-"));
    queue = new QueueDB(tmpDir);
  });

  afterEach(() => {
    queue.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("forwards benchmark mode to immediate processing", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "bench-msg",
        response: "benchmark reply",
        agent: "nyx",
        trace_id: null,
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "benchmark this",
        benchmark: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(processor.processImmediate).toHaveBeenCalledTimes(1);
    expect(processor.processImmediate).toHaveBeenCalledWith(expect.objectContaining({
      channel: "api",
      sender: "api",
      sender_id: "api_key",
      message: "benchmark this",
      benchmark: true,
    }));
  });

  test("forwards task_id to immediate processing", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "task-msg",
        response: "ok",
        agent: "nyx",
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: "onyx-task-7",
        message: "ship it",
      }),
    });

    expect(res.status).toBe(200);
    expect(processor.processImmediate).toHaveBeenCalledWith(expect.objectContaining({
      task_id: "onyx-task-7",
      message: "ship it",
    }));
  });

  test("forwards model overrides to immediate processing", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "model-msg",
        response: "ok",
        agent: "nyx",
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "ship it",
        model_override: "claude-opus-4-6",
      }),
    });

    expect(res.status).toBe(200);
    expect(processor.processImmediate).toHaveBeenCalledWith(expect.objectContaining({
      message: "ship it",
      modelOverride: "claude-opus-4-6",
    }));
  });

  test("accepts attachment-only requests", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "file-only",
        response: "processed",
        agent: "nyx",
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "",
        files: [
          { name: "clip.mp3", type: "audio/mpeg", data: "aGVsbG8=" },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(processor.processImmediate).toHaveBeenCalledWith(expect.objectContaining({
      message: "",
      files: [
        { name: "clip.mp3", mimeType: "audio/mpeg", base64: "aGVsbG8=", size: 5 },
      ],
    }));
  });

  test("rejects empty requests without message or attachments", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "unused",
        response: "processed",
        agent: "nyx",
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });

    expect(res.status).toBe(400);
    expect(processor.processImmediate).not.toHaveBeenCalled();
  });

  test("rejects unsafe attachment names", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "unused",
        response: "processed",
        agent: "nyx",
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "read this",
        files: [
          { name: "../secret.txt", type: "text/plain", data: "aGVsbG8=" },
        ],
      }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("path separators");
    expect(processor.processImmediate).not.toHaveBeenCalled();
  });

  test("records blocked path reports for unsupported attachment types", async () => {
    const runs = new DelegationRunStore(tmpDir, "blocked-paths");
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "unused",
        response: "processed",
        agent: "nyx",
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue, { runs }));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "read this",
        files: [
          { name: "run.sh", type: "application/x-sh", data: "aGVsbG8=" },
        ],
      }),
    });

    expect(res.status).toBe(400);
    expect(processor.processImmediate).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toContain("Unsupported attachment MIME type");
    expect(body.blocked_path).toMatchObject({
      channel: "api",
      area: "attachment",
      failed_path: "api.message.attachments.normalize",
      missing_primitive: "attachment.mime.supported_handler",
      next_action: "fix",
      requires_approval: false,
    });
    expect(body.blocked_path.id).toBeString();

    const blockedPaths = runs.listBlockedPaths({ limit: 10 });
    expect(blockedPaths).toHaveLength(1);
    expect(blockedPaths[0]).toEqual(body.blocked_path);

    const artifacts = runs.listArtifacts({ channel: "api", limit: 10 });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      channel: "api",
      source: "api.message.files[0]",
      name: "run.sh",
      mime_type: "application/x-sh",
      acquisition_status: "failed",
      handler_status: "unsupported",
    });
    expect(artifacts[0].acquisition_error).toContain("Unsupported attachment MIME type");

    runs.close();
  });

  test("does not cross-channel-dedup different senders with the same message", async () => {
    queue.enqueueMessage({
      channel: "discord",
      sender: "alice",
      sender_id: "discord-alice",
      message: "ok",
    });

    const processor = {
      processImmediate: mock(async () => ({
        message_id: "telegram-msg",
        response: "processed",
        agent: "nyx",
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "telegram",
        sender: "bob",
        sender_id: "telegram-bob",
        message: "ok",
        async: true,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("enqueued");
    const stored = queue.getMessageByMessageId(body.message_id);
    expect(stored?.channel).toBe("telegram");
    expect(stored?.sender).toBe("bob");
  });

  test("still cross-channel-dedups the same sender", async () => {
    const existingId = queue.enqueueMessage({
      channel: "discord",
      sender: "alice",
      sender_id: "alice",
      message: "ok",
    });

    const processor = {
      processImmediate: mock(async () => ({
        message_id: "telegram-msg",
        response: "processed",
        agent: "nyx",
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "telegram",
        sender: "alice",
        sender_id: "alice",
        message: "ok",
        async: true,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      message_id: existingId,
      status: "duplicate",
      hint: "Already sent on discord channel within the last 60 seconds",
    });
  });

  test("preserves attachments when async requests are queued", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "unused",
        response: "processed",
        agent: "nyx",
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "queue this",
        async: true,
        files: [
          { name: "report.txt", type: "text/plain", data: "aGVsbG8=" },
        ],
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("enqueued");
    const stored = queue.getMessageByMessageId(body.message_id);
    expect(stored?.files).toBe(JSON.stringify([
      { name: "report.txt", mimeType: "text/plain", base64: "aGVsbG8=", size: 5 },
    ]));
  });

  test("preserves attachments when timed-out sync requests are re-queued", async () => {
    const processor = {
      processImmediate: mock(() => new Promise(() => {})),
    };
    const app = withAuth(messagesRoutes(processor as any, queue, { requestTimeoutMs: 5 }));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "slow request",
        files: [
          { name: "report.txt", type: "text/plain", data: "aGVsbG8=" },
        ],
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("running");
    expect(body.timeout).toBe(true);
    const stored = queue.getMessageByMessageId(body.message_id);
    expect(stored?.files).toBe(JSON.stringify([
      { name: "report.txt", mimeType: "text/plain", base64: "aGVsbG8=", size: 5 },
    ]));
  });

  test("rejects benchmark mode in async queueing mode", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "bench-msg",
        response: "benchmark reply",
        agent: "nyx",
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "benchmark this",
        async: true,
        benchmark: true,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Benchmark mode is only supported for sync or stream requests.");
    expect(processor.processImmediate).not.toHaveBeenCalled();
    expect(queue.getQueueStats()).toEqual({
      pending: 0,
      processing: 0,
      suspended: 0,
      completed: 0,
      failed: 0,
      dead_letter: 0,
    });
  });

  test("resumes suspended messages through the reply endpoint", async () => {
    const messageId = queue.enqueueMessage({
      channel: "api",
      sender: "test",
      sender_id: "user-1",
      message: "need clarification",
      agent: "nyx",
    });
    queue.suspendMessage({
      messageId,
      channel: "api",
      sender: "test",
      sender_id: "user-1",
      agent: "nyx",
      original_message: "need clarification",
      requestId: "clarify:reply-test",
      request: { question: "Which repo should I touch?" },
      responseText: "Which repo should I touch?",
    });

    const processor = {
      processImmediate: mock(async () => ({
        message_id: "unused",
        response: "unused",
        agent: "nyx",
      })),
      resumeSuspendedMessage: mock(async () => ({
        message_id: messageId,
        status: "queued",
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue));

    const res = await app.request(`/${messageId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply: "nyxhive" }),
    });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(processor.resumeSuspendedMessage).toHaveBeenCalledWith(messageId, "nyxhive", { async: true });
    expect(body).toEqual({ message_id: messageId, status: "queued" });
  });

  test("forwards relay context to immediate processing", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "relay-msg",
        response: "relay reply",
        agent: "nyx",
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "handle this remotely",
        relay: {
          origin_instance: "NyxAI",
          callback_url: "https://nyx.example.com/core/api/relay/callback",
          callback_token: "relay-token",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(processor.processImmediate).toHaveBeenCalledWith(expect.objectContaining({
      relay: {
        originInstance: "NyxAI",
        callbackUrl: "https://nyx.example.com/core/api/relay/callback",
        callbackToken: "relay-token",
      },
    }));
  });

  test("queues async relay requests with durable relay context", async () => {
    const processor = {
      processImmediate: mock(async () => ({
        message_id: "unused",
        response: "processed",
        agent: "nyx",
      })),
    };
    const app = withAuth(messagesRoutes(processor as any, queue));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "queue this remotely",
        async: true,
        relay: {
          origin_instance: "NyxAI",
          callback_url: "https://nyx.example.com/core/api/relay/callback",
          callback_token: "relay-token",
        },
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("enqueued");
    expect(processor.processImmediate).not.toHaveBeenCalled();
    const stored = queue.getMessageByMessageId(body.message_id);
    expect(stored?.relay_origin_instance).toBe("NyxAI");
    expect(stored?.relay_callback_url).toBe("https://nyx.example.com/core/api/relay/callback");
    expect(stored?.relay_callback_token).toBe("relay-token");
  });

  test("re-queues timed-out relay requests", async () => {
    const processor = {
      processImmediate: mock(() => new Promise(() => {})),
    };
    const app = withAuth(messagesRoutes(processor as any, queue, { requestTimeoutMs: 5 }));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "slow relay",
        relay: {
          origin_instance: "NyxAI",
          callback_url: "https://nyx.example.com/core/api/relay/callback",
          callback_token: "relay-token",
        },
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("running");
    expect(body.timeout).toBe(true);
    expect(body.message_id).toBeTruthy();
    expect(queue.getPendingCountAll()).toBe(1);
    const stored = queue.getMessageByMessageId(body.message_id);
    expect(stored?.relay_origin_instance).toBe("NyxAI");
  });

  test("relay channel uses its own shorter timeout (relayTimeoutMs), not requestTimeoutMs", async () => {
    const processor = {
      processImmediate: mock(() => new Promise(() => {})), // never resolves
    };
    // relayTimeoutMs=5 fires first; requestTimeoutMs=60_000 would take too long
    const app = withAuth(messagesRoutes(processor as any, queue, { requestTimeoutMs: 60_000, relayTimeoutMs: 5 }));

    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: "relay",
        sender: "Onyx",
        message: "do something slow",
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe("running");
    expect(body.timeout).toBe(true);
    expect(body.message_id).toBeTruthy();
    // Message should be queued so Onyx can poll for it
    expect(queue.getMessageByMessageId(body.message_id)).not.toBeNull();
  });
});

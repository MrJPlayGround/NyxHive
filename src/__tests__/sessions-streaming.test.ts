import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AuthEnv } from "../auth/types.js";
import { ThreadDB } from "../server/db/threads.js";
import { sessionRoutes } from "../server/routes/sessions.js";

function withAuth(routes: Hono<AuthEnv>, basePath: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("auth" as never, { type: "api_key", role: "owner" } as never);
    return next();
  });
  app.route(basePath, routes);
  return app;
}

function parseSSEEvents(raw: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of raw.split("\n\n")) {
    if (!block.trim() || block.trim().startsWith(":")) continue;
    const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    events.push(JSON.parse(dataLine.slice(6)) as Record<string, unknown>);
  }
  return events;
}

describe("session streaming", () => {
  let tmpDir: string;
  let db: Database;
  let threadDb: ThreadDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sessions-streaming-test-"));
    db = new Database(join(tmpDir, "threads.db"));
    threadDb = new ThreadDB(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("streams token events before the final response payload and persists the exchange", async () => {
    const session = threadDb.createSession({ instance: "test", agent: "onyx", title: "New Session" });
    let seenModelOverride: string | undefined;
    const processor = {
      processImmediate: async (opts: {
        modelOverride?: string;
        onEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
      }) => {
        seenModelOverride = opts.modelOverride;
        opts.onEvent?.({ type: "token", data: { text: "Hel", agent: "onyx" } });
        opts.onEvent?.({ type: "token", data: { text: "lo", agent: "onyx" } });
        return {
          response: "Hello",
          agent: "onyx",
          message_id: "msg-1",
          trace_id: "trace-1",
          cost: 0.12,
          tokens_in: 10,
          tokens_out: 5,
        };
      },
    };

    const app = withAuth(sessionRoutes(threadDb, processor as any, "test"), "/api/sessions");
    const res = await app.request(`/api/sessions/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Reply with exactly: alive",
        stream: true,
        model_override: "claude-opus-4-6",
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const raw = await res.text();
    const events = parseSSEEvents(raw);

    expect(events.map((event) => event.type)).toEqual(["token", "token", "response"]);
    expect(events[0]?.text).toBe("Hel");
    expect(events[1]?.text).toBe("lo");
    expect(events[2]).toMatchObject({
      type: "response",
      response: "Hello",
      agent: "onyx",
      message_id: "msg-1",
      trace_id: "trace-1",
      cost_cents: 12,
    });
    expect(seenModelOverride).toBe("claude-opus-4-6");

    const updated = threadDb.getThread(session.id);
    const messages = threadDb.getThreadMessages(session.id);

    expect(updated?.title).toBe("Ping check");
    expect(updated?.cost_cents).toBe(12);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: "user",
      content: "Reply with exactly: alive",
    });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "Hello",
      agent: "onyx",
      message_id: "msg-1",
      cost_cents: 12,
      tokens: 15,
    });
  });

  test("streams while forwarding file attachments to the processor", async () => {
    const session = threadDb.createSession({
      instance: "test",
      agent: "nyx",
      title: "New Session",
    });
    let seenFiles: unknown;
    const processor = {
      processImmediate: async (opts: {
        files?: unknown;
        onEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
      }) => {
        seenFiles = opts.files;
        opts.onEvent?.({ type: "token", data: { text: "ok", agent: "nyx" } });
        return {
          response: "saw image",
          agent: "nyx",
          message_id: "msg-image",
          trace_id: "trace-image",
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
        stream: true,
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
    await res.text();
    expect(seenFiles).toEqual([
      {
        name: "screenshot.png",
        mimeType: "image/png",
        base64: "aGVsbG8=",
        size: 5,
      },
    ]);
  });

  test("passes model overrides through to processImmediate", async () => {
    let seenModelOverride: string | undefined;
    const threadDb = {
      getThread: (id: string) => id === "session-1"
        ? { id, category: "session", agent: "onyx", title: "Session", cost_cents: 0 }
        : null,
      addThreadMessage: () => {},
      getThreadMessages: () => [{ role: "assistant" }],
      updateThread: () => {},
    };

    const processor = {
      processImmediate: async (opts: { modelOverride?: string }) => {
        seenModelOverride = opts.modelOverride;
        return {
          response: "Hello",
          agent: "onyx",
          message_id: "msg-1",
          trace_id: "trace-1",
          cost: 0,
          tokens_in: 0,
          tokens_out: 0,
        };
      },
    };

    const app = withAuth(sessionRoutes(threadDb as any, processor as any, "test"), "/api/sessions");
    const res = await app.request("/api/sessions/session-1/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hi", stream: true, model_override: "claude-opus-4-6" }),
    });

    expect(res.status).toBe(200);
    expect(seenModelOverride).toBe("claude-opus-4-6");
  });
});

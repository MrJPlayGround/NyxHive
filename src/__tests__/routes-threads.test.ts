import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { ThreadDB } from "../server/db/threads.js";
import { threadRoutes } from "../server/routes/threads.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { QueueDB } from "../queue/db.js";
import type { NyxHiveConfig } from "../types.js";
import type { AuthEnv } from "../auth/types.js";

// --- Config stub ---

function makeConfig(overrides: Partial<NyxHiveConfig> = {}): NyxHiveConfig {
  return {
    daemon: {
      name: "test-instance",
      log_level: "error",
      data_dir: "/tmp",
      projects: [
        { name: "NyxHive", repo_path: "/dev/nyxhive", default: true },
      ],
    },
    server: { port: 3000 },
    agents: {
      nyx: { name: "Nyx", provider: "anthropic", model: "sonnet", working_directory: "/dev/nyxhive" } as any,
    },
    providers: {},
    routing: { classifier_model: "m", classifier_provider: "p", cli_escalation_tasks: [] },
    context: { max_history: 10, summary_threshold: 5 },
    ...overrides,
  };
}

// --- Processor stub ---

function makeProcessor(): Partial<QueueProcessor> {
  return {
    emitThreadEvent: () => {},
  } as any;
}

// --- Queue stub ---

function makeQueue(): Partial<QueueDB> {
  let counter = 0;
  return {
    enqueueMessage: () => `msg-${++counter}`,
  } as any;
}

// --- Auth wrapper: injects owner auth context ---

function withAuth(app: Hono<AuthEnv>, basePath: string): Hono {
  const wrapper = new Hono();
  wrapper.use("/*", async (c, next) => {
    c.set("auth" as never, { type: "api_key", role: "owner" } as never);
    return next();
  });
  wrapper.route(basePath, app);
  return wrapper;
}

describe("threads routes", () => {
  let db: Database;
  let threadDb: ThreadDB;
  let config: NyxHiveConfig;
  let app: Hono;

  beforeEach(() => {
    db = new Database(":memory:");
    threadDb = new ThreadDB(db);
    config = makeConfig();

    // Seed a project so thread creation can resolve project_id
    threadDb.createProject({
      name: "NyxHive",
      instance: "test-instance",
      repo_path: "/dev/nyxhive",
    });

    const routes = threadRoutes(
      threadDb,
      makeProcessor() as QueueProcessor,
      makeQueue() as QueueDB,
      "test-instance",
      config,
      "/",
    );
    app = withAuth(routes, "/api");
  });

  afterEach(() => {
    threadDb.close();
  });

  // === POST /api/threads ===

  describe("POST /api/threads", () => {
    test("creates a thread and returns 201", async () => {
      const res = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Implement dark mode" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.id).toBeTruthy();
      expect(body.title).toBe("Implement dark mode");
      expect(body.status).toBe("queued");
      expect(body.message_id).toBeTruthy();
    });

    test("auto-generates title from long message", async () => {
      const res = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: "This is a very long message that should be truncated to create a reasonable title for the thread",
        }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.title.length).toBeLessThanOrEqual(60);
    });

    test("uses explicit title when provided", async () => {
      const res = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Do the thing", title: "Custom Title" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(body.title).toBe("Custom Title");
    });

    test("matches a relative agent working_directory to the configured project", async () => {
      config.agents.nyx.working_directory = "./dev/nyxhive";

      const res = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Ship it", agent: "nyx" }),
      });

      expect(res.status).toBe(201);
      const body = await res.json() as any;
      expect(threadDb.getThread(body.id)?.project_id).toBeTruthy();
    });

    test("returns 404 for invalid explicit project_id", async () => {
      const res = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello", project_id: "nonexistent" }),
      });
      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error).toBe("Project not found");
    });

    test("rejects empty message", async () => {
      const res = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "" }),
      });
      expect(res.status).toBe(400);
    });

    test("rejects missing message", async () => {
      const res = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    test("rejects non-JSON body", async () => {
      const res = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  // === GET /api/threads ===

  describe("GET /api/threads", () => {
    test("returns empty list initially", async () => {
      const res = await app.request("/api/threads");
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.threads).toHaveLength(0);
      expect(body.total).toBe(0);
    });

    test("returns created threads", async () => {
      // Create two threads
      await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Thread one" }),
      });
      await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Thread two" }),
      });

      const res = await app.request("/api/threads");
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.threads).toHaveLength(2);
      expect(body.total).toBe(2);
    });

    test("filters by agent", async () => {
      await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "For nyx", agent: "nyx" }),
      });
      await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "For analyst", agent: "analyst" }),
      });

      const res = await app.request("/api/threads?agent=nyx");
      const body = await res.json() as any;
      expect(body.threads).toHaveLength(1);
      expect(body.threads[0].agent).toBe("nyx");
    });

    test("hides archived threads by default", async () => {
      const createRes = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Will be archived" }),
      });
      const created = await createRes.json() as any;

      // Archive it
      await app.request(`/api/threads/${created.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });

      const res = await app.request("/api/threads");
      const body = await res.json() as any;
      expect(body.threads).toHaveLength(0);

      // But shows with archived=true
      const res2 = await app.request("/api/threads?archived=true");
      const body2 = await res2.json() as any;
      expect(body2.threads).toHaveLength(1);
    });
  });

  // === GET /api/threads/:id ===

  describe("GET /api/threads/:id", () => {
    test("returns thread with messages", async () => {
      const createRes = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Hello Nyx" }),
      });
      const created = await createRes.json() as any;

      const res = await app.request(`/api/threads/${created.id}`);
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.id).toBe(created.id);
      expect(body.message).toBe("Hello Nyx");
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].role).toBe("user");
      expect(body.messages[0].content).toBe("Hello Nyx");
    });

    test("returns 404 for unknown thread", async () => {
      const res = await app.request("/api/threads/nonexistent");
      expect(res.status).toBe(404);
      const body = await res.json() as any;
      expect(body.error).toBe("Thread not found");
    });
  });

  // === PUT /api/threads/:id ===

  describe("PUT /api/threads/:id", () => {
    test("updates thread title", async () => {
      const createRes = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Original" }),
      });
      const created = await createRes.json() as any;

      const res = await app.request(`/api/threads/${created.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "New Title" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.title).toBe("New Title");
    });

    test("sets project_id to null", async () => {
      const createRes = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Has project" }),
      });
      const created = await createRes.json() as any;

      const res = await app.request(`/api/threads/${created.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: null }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.project_id).toBeNull();
    });

    test("returns 404 for unknown thread", async () => {
      const res = await app.request("/api/threads/nonexistent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Won't work" }),
      });
      expect(res.status).toBe(404);
    });
  });

  // === DELETE /api/threads/:id ===

  describe("DELETE /api/threads/:id", () => {
    test("deletes a thread", async () => {
      const createRes = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Delete me" }),
      });
      const created = await createRes.json() as any;

      const res = await app.request(`/api/threads/${created.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.deleted).toBe(true);

      // Verify it's gone
      const getRes = await app.request(`/api/threads/${created.id}`);
      expect(getRes.status).toBe(404);
    });

    test("returns 404 for unknown thread", async () => {
      const res = await app.request("/api/threads/nonexistent", {
        method: "DELETE",
      });
      expect(res.status).toBe(404);
    });
  });

  // === POST /api/threads/:id/messages ===

  describe("POST /api/threads/:id/messages (follow-up)", () => {
    test("rejects follow-up to non-completed thread", async () => {
      const createRes = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Initial" }),
      });
      const created = await createRes.json() as any;

      const res = await app.request(`/api/threads/${created.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Follow up" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toContain("Cannot send follow-up");
    });

    test("accepts follow-up to completed thread", async () => {
      const createRes = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Initial" }),
      });
      const created = await createRes.json() as any;

      // Mark as completed directly
      threadDb.updateThread(created.id, { status: "completed" });

      const res = await app.request(`/api/threads/${created.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Follow up" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.message_id).toBeTruthy();
      expect(body.status).toBe("queued");
    });

    test("returns 404 for unknown thread", async () => {
      const res = await app.request("/api/threads/nonexistent/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "hello" }),
      });
      expect(res.status).toBe(404);
    });
  });

  // === POST /api/threads/:id/cancel ===

  describe("POST /api/threads/:id/cancel", () => {
    test("cancels a queued thread", async () => {
      const createRes = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Cancel me" }),
      });
      const created = await createRes.json() as any;

      const res = await app.request(`/api/threads/${created.id}/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.status).toBe("cancelled");
    });

    test("rejects cancelling a completed thread", async () => {
      const createRes = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Done" }),
      });
      const created = await createRes.json() as any;

      threadDb.updateThread(created.id, { status: "completed" });

      const res = await app.request(`/api/threads/${created.id}/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(400);
      const body = await res.json() as any;
      expect(body.error).toContain("Cannot cancel");
    });

    test("rejects cancelling an already cancelled thread", async () => {
      const createRes = await app.request("/api/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Already cancelled" }),
      });
      const created = await createRes.json() as any;

      threadDb.updateThread(created.id, { status: "cancelled" });

      const res = await app.request(`/api/threads/${created.id}/cancel`, {
        method: "POST",
      });
      expect(res.status).toBe(400);
    });

    test("returns 404 for unknown thread", async () => {
      const res = await app.request("/api/threads/nonexistent/cancel", {
        method: "POST",
      });
      expect(res.status).toBe(404);
    });
  });
});

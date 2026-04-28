import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { QueueDB } from "../queue/db.js";
import { queueRoutes } from "../server/routes/queue.js";
import type { AuthEnv } from "../auth/types.js";
import type { UserRole } from "../auth/types.js";

function withAuth(routes: Hono, role: UserRole = "owner"): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("auth" as never, { type: "api_key", role } as never);
    return next();
  });
  app.route("/api/queue", routes);
  return app;
}

function withoutAuth(routes: Hono): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.route("/api/queue", routes);
  return app;
}

describe("queue routes", () => {
  let tmpDir: string;
  let queue: QueueDB;
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "queue-routes-test-"));
    queue = new QueueDB(tmpDir);
    app = withAuth(queueRoutes(queue));
  });

  afterEach(() => {
    queue.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("GET /api/queue/health exposes compatibility aliases for scripts", async () => {
    const deadId = queue.enqueueMessage({
      channel: "cli",
      sender: "jay",
      task_id: "task-dead",
      message: "retry me",
    });
    queue.failMessage(deadId, "Agent timed out after 30s", 1);

    const stalePendingId = queue.enqueueMessage({
      channel: "cli",
      sender: "jay",
      task_id: "task-pending",
      message: "old pending",
    });

    const dbConn = (queue as unknown as { db: { run: (sql: string, params: unknown[]) => void } }).db;
    const stalePendingTs = Date.now() - 3 * 24 * 60 * 60 * 1000;
    dbConn.run("UPDATE messages SET created_at = ?, updated_at = ? WHERE message_id = ?", [
      stalePendingTs,
      stalePendingTs,
      stalePendingId,
    ]);

    const res = await app.request("/api/queue/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.stats.dead_letter).toBe(1);
    expect(body.dead_letters.total).toBe(1);
    expect(body.deadLetters).toBe(1);
    expect(body.queueDepth).toBe(1);
    expect(body.processing).toBe(0);
    expect(body.retryableDeadLetters).toBe(1);
    expect(body.stalePending).toBe(1);
    expect(body.staleProcessing).toBe(0);
  });

  test("GET /api/queue/failed allows canRead roles and returns failed rows", async () => {
    const appForViewer = withAuth(queueRoutes(queue), "viewer");
    const failedId = queue.enqueueMessage({
      channel: "cli",
      sender: "jay",
      message: "failed item",
      status: "failed",
    });
    queue.enqueueMessage({
      channel: "cli",
      sender: "jay",
      message: "pending item",
    });

    const res = await appForViewer.request("/api/queue/failed");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].message_id).toBe(failedId);
    expect(body[0].status).toBe("failed");
  });

  test("GET /api/queue/failed requires auth", async () => {
    const unauthApp = withoutAuth(queueRoutes(queue));
    const res = await unauthApp.request("/api/queue/failed");
    expect(res.status).toBe(401);

    const body = await res.json();
    expect(body.error).toBe("Not authenticated");
  });

  test("DELETE /api/queue/failed rejects viewer role", async () => {
    const viewerApp = withAuth(queueRoutes(queue), "viewer");
    queue.enqueueMessage({
      channel: "cli",
      sender: "jay",
      message: "failed item",
      status: "failed",
    });

    const res = await viewerApp.request("/api/queue/failed", { method: "DELETE" });
    expect(res.status).toBe(403);

    const body = await res.json();
    expect(body.error).toBe("Insufficient permissions");
    expect(queue.getFailedMessages()).toHaveLength(1);
  });

  test("DELETE /api/queue/failed clears all failed rows for canWrite roles", async () => {
    const userApp = withAuth(queueRoutes(queue), "user");
    queue.enqueueMessage({
      channel: "cli",
      sender: "jay",
      message: "failed-1",
      status: "failed",
    });
    queue.enqueueMessage({
      channel: "cli",
      sender: "jay",
      message: "failed-2",
      status: "failed",
    });
    queue.enqueueMessage({
      channel: "cli",
      sender: "jay",
      message: "pending",
    });

    const res = await userApp.request("/api/queue/failed", { method: "DELETE" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.cleared).toBe(2);
    expect(queue.getFailedMessages()).toHaveLength(0);
    expect(queue.getRecentMessages().some((msg) => msg.status === "pending")).toBe(true);
  });

  test("DELETE /api/queue/failed/:id clears one failed row", async () => {
    const failedId = queue.enqueueMessage({
      channel: "cli",
      sender: "jay",
      message: "failed-1",
      status: "failed",
    });
    const otherFailedId = queue.enqueueMessage({
      channel: "cli",
      sender: "jay",
      message: "failed-2",
      status: "failed",
    });

    const res = await app.request(`/api/queue/failed/${failedId}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.cleared).toBe(1);
    expect(queue.getMessageByMessageId(failedId)).toBeNull();
    expect(queue.getMessageByMessageId(otherFailedId)?.status).toBe("failed");
  });

  test("DELETE /api/queue/failed/:id returns 404 for unknown id", async () => {
    const res = await app.request("/api/queue/failed/missing-id", { method: "DELETE" });
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Not found");
  });
});

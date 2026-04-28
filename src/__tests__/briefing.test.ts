import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { briefingRoutes } from "../server/routes/briefing.js";
import { classifyAutonomy } from "../proposals/autonomy.js";
import type { Scheduler, ScheduledTask } from "../scheduler/index.js";
import type { AuthEnv } from "../auth/types.js";

function withAuth(routes: Hono, basePath: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("auth" as never, { type: "api_key", role: "owner" } as never);
    return next();
  });
  app.route(basePath, routes);
  return app;
}

// --- Minimal scheduler mock ---

function makeScheduler(overrides: Partial<{
  getTaskResult: Scheduler["getTaskResult"];
  listTasks: Scheduler["listTasks"];
}>): Scheduler {
  return {
    getTaskResult: overrides.getTaskResult ?? ((_id) => null),
    listTasks: overrides.listTasks ?? ((_includeDisabled) => []),
  } as unknown as Scheduler;
}

function makeTask(partial: Partial<ScheduledTask>): ScheduledTask {
  const now = Date.now();
  return {
    id: "task-1",
    name: "test:task",
    description: null,
    cron_expression: null,
    run_at: null,
    agent: "system",
    prompt: "",
    channel: "api",
    recipient: null,
    enabled: 1,
    last_run_at: null,
    next_run_at: now + 60000,
    last_status: null,
    last_error: null,
    last_result: null,
    category: null,
    run_count: 0,
    consecutive_failures: 0,
    notify_channels: null,
    notify_thread_id: null,
    webhook_url: null,
    chain_to: null,
    created_by: "system",
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

// --- Briefing route: GET /api/briefing/latest ---

describe("GET /api/briefing/latest", () => {
  test("returns 404 when no briefing task exists", async () => {
    const scheduler = makeScheduler({ getTaskResult: () => null });
    const app = withAuth(briefingRoutes(scheduler), "/api/briefing");

    const res = await app.request("/api/briefing/latest");
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/no briefing/i);
  });

  test("returns 404 when task exists but has no result yet", async () => {
    const scheduler = makeScheduler({
      getTaskResult: () => ({
        task_name: "briefing:daily",
        agent: "nyx",
        last_status: null,
        last_result: null,
        last_run_at: null,
      }),
    });
    const app = withAuth(briefingRoutes(scheduler), "/api/briefing");

    const res = await app.request("/api/briefing/latest");
    expect(res.status).toBe(404);
  });

  test("returns briefing result when available", async () => {
    const now = Date.now();
    const scheduler = makeScheduler({
      getTaskResult: () => ({
        task_name: "briefing:daily",
        agent: "nyx",
        last_status: "success",
        last_result: "# Morning Briefing\nAll clear.",
        last_run_at: now,
      }),
    });
    const app = withAuth(briefingRoutes(scheduler), "/api/briefing");

    const res = await app.request("/api/briefing/latest");
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.last_result).toBe("# Morning Briefing\nAll clear.");
    expect(body.last_status).toBe("success");
    expect(body.last_run_at).toBe(now);
  });
});

// --- Briefing route: GET /api/briefing/data ---

describe("GET /api/briefing/data", () => {
  test("returns empty task list when no tasks", async () => {
    const scheduler = makeScheduler({ listTasks: () => [] });
    const app = withAuth(briefingRoutes(scheduler), "/api/briefing");

    const res = await app.request("/api/briefing/data");
    expect(res.status).toBe(200);
    const body = await res.json() as { period_start: number; period_end: number; tasks: unknown[] };
    expect(body.tasks).toEqual([]);
    expect(body.period_start).toBeLessThan(body.period_end);
  });

  test("filters out tasks with no last_run_at", async () => {
    const scheduler = makeScheduler({
      listTasks: () => [makeTask({ name: "scout:codebase", last_run_at: null })],
    });
    const app = withAuth(briefingRoutes(scheduler), "/api/briefing");

    const res = await app.request("/api/briefing/data");
    const body = await res.json() as { tasks: unknown[] };
    expect(body.tasks).toHaveLength(0);
  });

  test("includes tasks that ran within the last 24h", async () => {
    const recentRun = Date.now() - 60 * 60 * 1000; // 1 hour ago
    const scheduler = makeScheduler({
      listTasks: () => [
        makeTask({
          name: "scout:codebase",
          agent: "scout",
          category: "scout",
          last_run_at: recentRun,
          last_status: "success",
          last_result: "Found 3 issues in 2 files.",
        }),
      ],
    });
    const app = withAuth(briefingRoutes(scheduler), "/api/briefing");

    const res = await app.request("/api/briefing/data");
    const body = await res.json() as { tasks: Array<{ name: string; result_preview: string | null }> };
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0].name).toBe("scout:codebase");
    expect(body.tasks[0].result_preview).toBe("Found 3 issues in 2 files.");
  });

  test("excludes tasks that ran more than 24h ago", async () => {
    const oldRun = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
    const scheduler = makeScheduler({
      listTasks: () => [makeTask({ name: "old:task", last_run_at: oldRun })],
    });
    const app = withAuth(briefingRoutes(scheduler), "/api/briefing");

    const res = await app.request("/api/briefing/data");
    const body = await res.json() as { tasks: unknown[] };
    expect(body.tasks).toHaveLength(0);
  });

  test("truncates result_preview to 300 chars", async () => {
    const longResult = "x".repeat(500);
    const scheduler = makeScheduler({
      listTasks: () => [
        makeTask({ name: "heavy:task", last_run_at: Date.now() - 1000, last_result: longResult }),
      ],
    });
    const app = withAuth(briefingRoutes(scheduler), "/api/briefing");

    const res = await app.request("/api/briefing/data");
    const body = await res.json() as { tasks: Array<{ result_preview: string | null }> };
    expect(body.tasks[0].result_preview).toHaveLength(300);
  });

  test("passes includeDisabled=true to listTasks", async () => {
    let capturedArg: boolean | undefined;
    const scheduler = makeScheduler({
      listTasks: (includeDisabled) => {
        capturedArg = includeDisabled;
        return [];
      },
    });
    const app = withAuth(briefingRoutes(scheduler), "/api/briefing");

    await app.request("/api/briefing/data");
    expect(capturedArg).toBe(true);
  });

  test("result_preview is null when task has no result", async () => {
    const scheduler = makeScheduler({
      listTasks: () => [
        makeTask({ name: "empty:task", last_run_at: Date.now() - 1000, last_result: null }),
      ],
    });
    const app = withAuth(briefingRoutes(scheduler), "/api/briefing");

    const res = await app.request("/api/briefing/data");
    const body = await res.json() as { tasks: Array<{ result_preview: string | null }> };
    expect(body.tasks[0].result_preview).toBeNull();
  });
});

// --- classifyAutonomy (task category classification from autonomy.ts) ---

describe("classifyAutonomy — task category classification", () => {
  test("maintenance + small + safe files → auto", () => {
    expect(classifyAutonomy("maintenance", "small", ["src/utils/helper.ts"])).toBe("auto");
  });

  test("bugfix + small + safe files → auto", () => {
    expect(classifyAutonomy("bugfix", "small", ["src/queue/processor.ts"])).toBe("auto");
  });

  test("feature always requires approval regardless of effort/files", () => {
    expect(classifyAutonomy("feature", "small", [])).toBe("requires_approval");
  });

  test("improvement always requires approval", () => {
    expect(classifyAutonomy("improvement", "small", [])).toBe("requires_approval");
  });

  test("new_instance always requires approval", () => {
    expect(classifyAutonomy("new_instance", "small", [])).toBe("requires_approval");
  });

  test("maintenance + medium effort → requires approval", () => {
    expect(classifyAutonomy("maintenance", "medium", [])).toBe("requires_approval");
  });

  test("maintenance + large effort → requires approval", () => {
    expect(classifyAutonomy("maintenance", "large", [])).toBe("requires_approval");
  });

  test("bugfix + small + auth file → requires approval (protected path)", () => {
    expect(classifyAutonomy("bugfix", "small", ["src/server/routes/auth.ts"])).toBe("requires_approval");
  });

  test("bugfix + small + middleware file → requires approval (protected path)", () => {
    expect(classifyAutonomy("bugfix", "small", ["src/middleware/rate-limit.ts"])).toBe("requires_approval");
  });

  test("bugfix + small + schema.sql → requires approval (protected path)", () => {
    expect(classifyAutonomy("bugfix", "small", ["db/schema.sql"])).toBe("requires_approval");
  });

  test("bugfix + small + package.json → requires approval (protected path)", () => {
    expect(classifyAutonomy("bugfix", "small", ["package.json"])).toBe("requires_approval");
  });

  test("bugfix + small + .env file → requires approval (protected path)", () => {
    expect(classifyAutonomy("bugfix", "small", [".env"])).toBe("requires_approval");
  });

  test("bugfix + small + migration file → requires approval (protected path)", () => {
    expect(classifyAutonomy("bugfix", "small", ["db/migrations/001-init.sql"])).toBe("requires_approval");
  });

  test("empty files list is treated as safe", () => {
    expect(classifyAutonomy("maintenance", "small", [])).toBe("auto");
  });

  test("one protected file among many safe files triggers approval", () => {
    expect(
      classifyAutonomy("bugfix", "small", ["src/utils/logger.ts", "src/server/routes/auth.ts"]),
    ).toBe("requires_approval");
  });
});

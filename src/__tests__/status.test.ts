import { describe, test, expect } from "bun:test";
import { Hono } from "hono";
import { Database } from "bun:sqlite";
import { statusRoutes } from "../server/routes/status.js";
import { schedulerRoutes } from "../server/routes/scheduler.js";
import { Scheduler } from "../scheduler/index.js";
import { createSSEStream } from "../server/sse.js";
import type { SSEEvent } from "../types.js";
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

// ── Minimal NyxHiveConfig ─────────────────────────────────────────────────────
const TEST_CONFIG = {
  daemon: { name: "test", log_level: "error", data_dir: "/tmp" },
  server: { port: 3000 },
  agents: {},
  teams: {},
  providers: {},
  routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
  context: { max_history: 10, summary_threshold: 5 },
} as any;

// ── Mock helpers ──────────────────────────────────────────────────────────────
function makeProcessor(delegations?: Map<string, {
  agent: string; task: string; dispatchedAt: number; convId: string; fromAgent: string;
}>) {
  const listeners = new Set<(event: SSEEvent) => void>();
  const _delegations = delegations ?? new Map();
  return {
    getActiveDelegations: () => _delegations,
    onEvent: (listener: (event: SSEEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitEvent: (type: string, data: Record<string, unknown>): void => {
      const event: SSEEvent = { type, data, timestamp: Date.now() };
      for (const l of listeners) l(event);
    },
    processImmediate: async (_msg: unknown): Promise<{ response: string; agent: string }> =>
      ({ response: "scan result text", agent: "tester" }),
    shouldRunAutonomousTask: (_taskName: string, _isCritical?: boolean): boolean => true,
    getChannels: (): undefined => undefined,
  };
}

// Parse all data: lines from raw SSE text, skipping comments.
function parseSSEEvents(raw: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of raw.split("\n\n")) {
    if (block.trim().startsWith(":")) continue; // SSE comment line
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (dataLine) {
      try {
        events.push(JSON.parse(dataLine.slice(6)));
      } catch {
        // malformed — skip
      }
    }
  }
  return events;
}

// Emit events via processor mock and collect N chunks from an SSE stream.
async function collectSSEEvents(
  processor: ReturnType<typeof makeProcessor>,
  emittedEvents: Array<{ type: string; data: Record<string, unknown> }>,
): Promise<Array<Record<string, unknown>>> {
  const response = createSSEStream((listener) => processor.onEvent(listener));
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  // Emit events — they are buffered synchronously into the stream.
  for (const ev of emittedEvents) {
    processor.emitEvent(ev.type, ev.data);
  }

  // Read exactly (1 connected comment + N events) chunks, then cancel.
  const totalChunks = 1 + emittedEvents.length;
  let rawData = "";
  let read = 0;

  while (read < totalChunks) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      rawData += decoder.decode(value);
      read++;
    }
  }

  await reader.cancel();
  return parseSSEEvents(rawData);
}

// ── Status endpoint ───────────────────────────────────────────────────────────
describe("GET /api/status/active", () => {
  test("returns idle state when no delegations or traces", async () => {
    const processor = makeProcessor();
    const app = withAuth(statusRoutes(processor as any), "/api/status");

    const res = await app.request("/api/status/active");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.delegations).toEqual([]);
    expect(body.running_traces).toEqual([]);
    expect(typeof body.timestamp).toBe("number");
  });

  test("includes active delegations with computed elapsed_ms", async () => {
    const dispatchedAt = Date.now() - 500;
    const delegations = new Map([
      [
        "key-forge-1",
        { agent: "forge", task: "Build the feature", dispatchedAt, convId: "conv-1", fromAgent: "nyx" },
      ],
    ]);

    const processor = makeProcessor(delegations);
    const app = withAuth(statusRoutes(processor as any), "/api/status");

    const res = await app.request("/api/status/active");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.delegations).toHaveLength(1);
    const d = body.delegations[0];
    expect(d.key).toBe("key-forge-1");
    expect(d.agent).toBe("forge");
    expect(d.task).toBe("Build the feature");
    expect(d.from_agent).toBe("nyx");
    expect(d.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(d.dispatched_at).toBe(dispatchedAt);
  });

  test("includes running traces when TraceStore provided", async () => {
    const processor = makeProcessor();
    const createdAt = Date.now() - 1000;
    const traceStore = {
      getRecentTraces: (_limit: number, _status?: string) => [
        {
          id: "trace-abc",
          agent_count: 3,
          input_message: "check the codebase for issues",
          sender: "user1",
          channel: "ios:nyx",
          created_at: createdAt,
        },
      ],
    };

    const app = withAuth(statusRoutes(processor as any, traceStore as any), "/api/status");

    const res = await app.request("/api/status/active");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.running_traces).toHaveLength(1);
    const t = body.running_traces[0];
    expect(t.id).toBe("trace-abc");
    expect(t.agent_count).toBe(3);
    expect(t.sender).toBe("user1");
    expect(t.channel).toBe("ios:nyx");
    expect(t.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  test("returns empty running_traces without TraceStore", async () => {
    const processor = makeProcessor();
    const app = withAuth(statusRoutes(processor as any), "/api/status");

    const res = await app.request("/api/status/active");
    const body = await res.json();
    expect(body.running_traces).toEqual([]);
  });

  test("truncates long input_message in trace to 100 chars", async () => {
    const processor = makeProcessor();
    const longMessage = "a".repeat(200);
    const traceStore = {
      getRecentTraces: () => [
        { id: "t1", agent_count: 1, input_message: longMessage, sender: "s", channel: "api", created_at: Date.now() },
      ],
    };

    const app = withAuth(statusRoutes(processor as any, traceStore as any), "/api/status");

    const res = await app.request("/api/status/active");
    const body = await res.json();
    expect(body.running_traces[0].input_message.length).toBe(100);
  });
});

// ── SSE lifecycle event ordering ──────────────────────────────────────────────
describe("SSE scan lifecycle events", () => {
  test("emits scan:started before scan:completed in order", async () => {
    const processor = makeProcessor();
    const events = await collectSSEEvents(processor, [
      { type: "scan:started", data: { task_id: "t1", task_name: "scout:code-quality", agent: "scout" } },
      { type: "scan:completed", data: { task_id: "t1", task_name: "scout:code-quality", agent: "scout", status: "completed" } },
    ]);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("scan:started");
    expect(events[1].type).toBe("scan:completed");
  });

  test("scan:started event carries task metadata", async () => {
    const processor = makeProcessor();
    const events = await collectSSEEvents(processor, [
      { type: "scan:started", data: { task_id: "t42", task_name: "scout:test-health", agent: "scout" } },
    ]);

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.type).toBe("scan:started");
    expect(ev.task_id).toBe("t42");
    expect(ev.task_name).toBe("scout:test-health");
    expect(ev.agent).toBe("scout");
    expect(typeof ev.timestamp).toBe("number");
  });

  test("scan:completed includes status field", async () => {
    const processor = makeProcessor();
    const events = await collectSSEEvents(processor, [
      { type: "scan:completed", data: { task_id: "t1", task_name: "health-check", agent: "heartbeat", status: "completed" } },
    ]);

    expect(events[0].type).toBe("scan:completed");
    expect(events[0].status).toBe("completed");
  });

  test("scan:completed with failed status includes error field", async () => {
    const processor = makeProcessor();
    const events = await collectSSEEvents(processor, [
      { type: "scan:completed", data: { task_id: "t1", task_name: "test", agent: "scout", status: "failed", error: "LLM timeout" } },
    ]);

    expect(events[0].type).toBe("scan:completed");
    expect(events[0].status).toBe("failed");
    expect(events[0].error).toBe("LLM timeout");
  });

  test("SSE response has correct Content-Type and Cache-Control headers", () => {
    const processor = makeProcessor();
    const response = createSSEStream((listener) => processor.onEvent(listener));
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  test("scheduler emits scan:started and scan:completed through processor", async () => {
    // Integration: real Scheduler calls processor.emitEvent on execute
    const db = new Database(":memory:");
    const captured: Array<{ type: string; data: Record<string, unknown> }> = [];
    const processor = makeProcessor();
    const origEmit = processor.emitEvent.bind(processor);
    processor.emitEvent = (type, data) => {
      captured.push({ type, data });
      origEmit(type, data);
    };

    const scheduler = new Scheduler(db, processor as any, TEST_CONFIG);
    const taskId = scheduler.addTask({ name: "test:scan", agent: "tester", prompt: "check code", channel: "api" });
    await scheduler.triggerTask(taskId);

    const scanEvents = captured.filter((e) => e.type.startsWith("scan:"));
    expect(scanEvents.length).toBeGreaterThanOrEqual(2);

    const types = scanEvents.map((e) => e.type);
    expect(types[0]).toBe("scan:started");
    expect(types[types.length - 1]).toBe("scan:completed");

    const started = scanEvents[0];
    expect(started.data.task_id).toBe(taskId);
    expect(started.data.task_name).toBe("test:scan");

    const completed = scanEvents[scanEvents.length - 1];
    expect(completed.data.status).toBe("completed");
  });
});

// ── Scan result persistence ───────────────────────────────────────────────────
describe("scan result persistence", () => {
  test("last_result is stored after task execution", async () => {
    const db = new Database(":memory:");
    const processor = makeProcessor();
    const scheduler = new Scheduler(db, processor as any, TEST_CONFIG);

    const taskId = scheduler.addTask({
      name: "test:scan",
      agent: "tester",
      prompt: "Check the codebase health",
      channel: "api",
    });

    await scheduler.triggerTask(taskId);

    const result = scheduler.getTaskResult(taskId);
    expect(result).not.toBeNull();
    expect(result!.task_name).toBe("test:scan");
    expect(result!.last_status).toBe("completed");
    expect(result!.last_result).toBe("scan result text");
    expect(result!.last_run_at).not.toBeNull();
  });

  test("last_result is queryable by task name", async () => {
    const db = new Database(":memory:");
    const processor = makeProcessor();
    const scheduler = new Scheduler(db, processor as any, TEST_CONFIG);

    const taskId = scheduler.addTask({ name: "scout:named-task", agent: "scout", prompt: "Scan", channel: "api" });
    await scheduler.triggerTask(taskId);

    const result = scheduler.getTaskResult("scout:named-task");
    expect(result).not.toBeNull();
    expect(result!.last_result).toBe("scan result text");
  });

  test("last_result survives across Scheduler restarts (same DB)", async () => {
    const db = new Database(":memory:");
    const processor = makeProcessor();

    const scheduler1 = new Scheduler(db, processor as any, TEST_CONFIG);
    const taskId = scheduler1.addTask({ name: "test:persistent", agent: "tester", prompt: "Persist scan", channel: "api" });
    await scheduler1.triggerTask(taskId);

    // New Scheduler instance on the same DB — simulates a restart
    const scheduler2 = new Scheduler(db, processor as any, TEST_CONFIG);
    const result = scheduler2.getTaskResult(taskId);

    expect(result).not.toBeNull();
    expect(result!.last_result).toBe("scan result text");
    expect(result!.last_status).toBe("completed");
  });

  test("last_result is truncated to 5000 chars", async () => {
    const longResponse = "x".repeat(6000);
    const processor = makeProcessor();
    processor.processImmediate = async () => ({ response: longResponse, agent: "tester" });

    const db = new Database(":memory:");
    const scheduler = new Scheduler(db, processor as any, TEST_CONFIG);

    const taskId = scheduler.addTask({ name: "test:long", agent: "tester", prompt: "Long", channel: "api" });
    await scheduler.triggerTask(taskId);

    const result = scheduler.getTaskResult(taskId);
    expect(result!.last_result!.length).toBe(5000);
  });

  test("failed task stores error status and null last_result", async () => {
    const processor = makeProcessor();
    processor.processImmediate = async () => { throw new Error("Agent unavailable"); };

    const db = new Database(":memory:");
    const scheduler = new Scheduler(db, processor as any, TEST_CONFIG);

    const taskId = scheduler.addTask({ name: "test:fail", agent: "tester", prompt: "Will fail", channel: "api" });
    await scheduler.triggerTask(taskId);

    const result = scheduler.getTaskResult(taskId);
    expect(result!.last_status).toBe("failed");
    expect(result!.last_result).toBeNull();
  });
});

// ── Scheduler task list API endpoint ─────────────────────────────────────────
describe("GET /api/scheduler/tasks", () => {
  test("humanizes hourly cron schedules", async () => {
    const db = new Database(":memory:");
    const processor = makeProcessor();
    const scheduler = new Scheduler(db, processor as any, TEST_CONFIG);

    scheduler.addTask({
      name: "evolution:hourly-self-improvement",
      agent: "nyx",
      prompt: "Improve the stack",
      channel: "scheduler",
      cron_expression: "0 * * * *",
    });

    const app = withAuth(schedulerRoutes(scheduler), "/api/scheduler");
    const res = await app.request("/api/scheduler/tasks?all=true");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].name).toBe("evolution:hourly-self-improvement");
    expect(body[0].schedule_human).toBe("Hourly");
  });

  test("does not mislabel constrained monthly cron schedules as daily", async () => {
    const db = new Database(":memory:");
    const processor = makeProcessor();
    const scheduler = new Scheduler(db, processor as any, TEST_CONFIG);

    scheduler.addTask({
      name: "maintenance:monthly-report",
      agent: "nyx",
      prompt: "Report",
      channel: "scheduler",
      cron_expression: "0 10 1 * *",
    });

    const app = withAuth(schedulerRoutes(scheduler), "/api/scheduler");
    const res = await app.request("/api/scheduler/tasks?all=true");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body[0].name).toBe("maintenance:monthly-report");
    expect(body[0].schedule_human).toBe("0 10 1 * *");
  });
});

// ── Scheduler task result API endpoint ───────────────────────────────────────
describe("GET /api/scheduler/tasks/:id/result", () => {
  test("returns 404 for unknown task ID", async () => {
    const db = new Database(":memory:");
    const processor = makeProcessor();
    const scheduler = new Scheduler(db, processor as any, TEST_CONFIG);

    const app = withAuth(schedulerRoutes(scheduler), "/api/scheduler");

    const res = await app.request("/api/scheduler/tasks/nonexistent/result");
    expect(res.status).toBe(404);
  });

  test("returns task result after execution", async () => {
    const db = new Database(":memory:");
    const processor = makeProcessor();
    const scheduler = new Scheduler(db, processor as any, TEST_CONFIG);

    const app = withAuth(schedulerRoutes(scheduler), "/api/scheduler");

    const taskId = scheduler.addTask({ name: "api:result-test", agent: "tester", prompt: "Test scan", channel: "api" });
    await scheduler.triggerTask(taskId);

    const res = await app.request(`/api/scheduler/tasks/${taskId}/result`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.task_name).toBe("api:result-test");
    expect(body.last_status).toBe("completed");
    expect(body.last_result).toBe("scan result text");
    expect(body.agent).toBe("tester");
  });

  test("result endpoint works with task name as path param", async () => {
    const db = new Database(":memory:");
    const processor = makeProcessor();
    const scheduler = new Scheduler(db, processor as any, TEST_CONFIG);

    const app = withAuth(schedulerRoutes(scheduler), "/api/scheduler");

    scheduler.addTask({ name: "scout:code-quality", agent: "scout", prompt: "Scan code", channel: "api" });

    const res = await app.request("/api/scheduler/tasks/scout:code-quality/result");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.task_name).toBe("scout:code-quality");
    // No execution yet — last_result and last_status should be null
    expect(body.last_result).toBeNull();
    expect(body.last_status).toBeNull();
  });
});

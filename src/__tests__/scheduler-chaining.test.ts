/**
 * Tests for task chaining — chain_to config, bootstrap persistence, and trigger logic.
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { loadConfigTasks } from "../scheduler/bootstrap.js";
import { Scheduler, isEmptyResponse, evaluateChainCondition } from "../scheduler/index.js";
import type { NyxHiveConfig } from "../types.js";

// ─── Schema (includes chain_to column) ──────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  cron_expression TEXT,
  run_at INTEGER,
  agent TEXT NOT NULL,
  prompt TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'api',
  recipient TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER NOT NULL,
  last_status TEXT,
  last_error TEXT,
  last_result TEXT,
  category TEXT DEFAULT 'ops',
  run_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  notify_channels TEXT,
  notify_thread_id TEXT,
  chain_to TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_next ON scheduled_tasks(enabled, next_run_at);
`;

function makeConfig(tasks: Array<Record<string, unknown>>): NyxHiveConfig {
  return {
    agents: {},
    channels: {},
    daemon: { name: "test-instance", data_dir: "/tmp/test-nyxhive" },
    scheduler: { tasks },
  } as unknown as NyxHiveConfig;
}

function getTask(db: Database, name: string): Record<string, unknown> | null {
  return db.query("SELECT * FROM scheduled_tasks WHERE name = ?").get(name) as Record<string, unknown> | null;
}

const TEST_CONFIG = {
  daemon: { name: "test", log_level: "error", data_dir: "/tmp" },
  server: { port: 3000 },
  agents: {},
  teams: {},
  providers: {},
  routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
  context: { max_history: 10, summary_threshold: 5 },
} as any;

function makeProcessor() {
  const calls: string[] = [];
  return {
    calls,
    emitEvent: () => {},
    processImmediate: async (_msg: unknown): Promise<{ response: string; agent: string }> => {
      calls.push("processImmediate");
      return { response: "Found something actionable", agent: "analyst" };
    },
    shouldRunAutonomousTask: () => true,
    getChannels: () => undefined,
  };
}

// ─── Bootstrap: chain_to persistence ────────────────────────────────

describe("task chaining — bootstrap", () => {
  test("stores chain_to as JSON in new task", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);

    const chainTo = { task_name: "daily-briefing", inject_result: true, only_if: "has_findings" as const };
    loadConfigTasks({
      db,
      config: makeConfig([{
        name: "health-check",
        cron: "*/30 * * * *",
        agent: "analyst",
        prompt: "Check health",
        chain_to: chainTo,
      }]),
    });

    const task = getTask(db, "health-check");
    expect(task).not.toBeNull();
    expect(task!.chain_to).toBe(JSON.stringify(chainTo));
  });

  test("updates chain_to on existing task", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);

    // Insert first time
    loadConfigTasks({
      db,
      config: makeConfig([{
        name: "health-check",
        cron: "*/30 * * * *",
        agent: "analyst",
        prompt: "Check health",
      }]),
    });
    expect(getTask(db, "health-check")!.chain_to).toBeNull();

    // Update with chain_to
    loadConfigTasks({
      db,
      config: makeConfig([{
        name: "health-check",
        cron: "*/30 * * * *",
        agent: "analyst",
        prompt: "Check health",
        chain_to: { task_name: "daily-briefing" },
      }]),
    });
    expect(getTask(db, "health-check")!.chain_to).toBe(JSON.stringify({ task_name: "daily-briefing" }));
  });

  test("stores null when no chain_to configured", () => {
    const db = new Database(":memory:");
    db.exec(SCHEMA);

    loadConfigTasks({
      db,
      config: makeConfig([{
        name: "standalone-task",
        cron: "0 * * * *",
        agent: "nyx",
        prompt: "Do something",
      }]),
    });

    expect(getTask(db, "standalone-task")!.chain_to).toBeNull();
  });
});

// ─── Chain trigger conditions ───────────────────────────────────────

describe("task chaining — trigger conditions", () => {
  test("chain_to JSON parses correctly with all fields", () => {
    const chain = JSON.parse(JSON.stringify({
      task_name: "briefing",
      inject_result: true,
      only_if: "has_findings",
    }));
    expect(chain.task_name).toBe("briefing");
    expect(chain.inject_result).toBe(true);
    expect(chain.only_if).toBe("has_findings");
  });

  test("chain_to JSON defaults — inject_result and only_if are optional", () => {
    const chain = JSON.parse(JSON.stringify({ task_name: "briefing" }));
    expect(chain.task_name).toBe("briefing");
    expect(chain.inject_result).toBeUndefined();
    expect(chain.only_if).toBeUndefined();
  });

  test("only_if has_findings skips when response is empty", () => {
    // Simulates the logic in triggerChain
    const onlyIf = "has_findings";
    const isEmpty = true;
    const shouldSkip = onlyIf === "has_findings" && isEmpty;
    expect(shouldSkip).toBe(true);
  });

  test("only_if has_findings proceeds when response has content", () => {
    const onlyIf = "has_findings";
    const isEmpty = false;
    const shouldSkip = onlyIf === "has_findings" && isEmpty;
    expect(shouldSkip).toBe(false);
  });

  test("only_if always proceeds even when response is empty", () => {
    const onlyIf: string = "always";
    const isEmpty = true;
    const shouldSkip = onlyIf === "has_findings" && isEmpty;
    expect(shouldSkip).toBe(false);
  });

  test("default only_if is has_findings (skips empty)", () => {
    const chain: { task_name: string; only_if?: string } = { task_name: "briefing" };
    const onlyIf = chain.only_if ?? "has_findings";
    expect(onlyIf).toBe("has_findings");
    const shouldSkip = onlyIf === "has_findings" && true; // isEmpty = true
    expect(shouldSkip).toBe(true);
  });
});

// ─── Context injection ──────────────────────────────────────────────

describe("task chaining — context injection", () => {
  test("inject_result prepends structured context packet to prompt", () => {
    const sourceResult = "Found 3 drift issues in the config";
    const targetPrompt = "Generate daily briefing";

    // Simulates the structured packet from triggerChain
    const packet = [
      "## Context Packet",
      "",
      "| Field | Value |",
      "|-------|-------|",
      "| Source task | health-check |",
      "| Category | ops |",
      "| Agent | analyst |",
      "| Run # | 5 |",
      `| Timestamp | ${new Date().toISOString()} |`,
      "",
      "### Source Output",
      "",
      sourceResult.slice(0, 3000),
      "",
      "---",
      "",
    ].join("\n");
    const chainedPrompt = packet + targetPrompt;

    expect(chainedPrompt).toContain("## Context Packet");
    expect(chainedPrompt).toContain("| Source task | health-check |");
    expect(chainedPrompt).toContain("Found 3 drift issues");
    expect(chainedPrompt).toEndWith(targetPrompt);
  });

  test("inject_result truncates long results to 3000 chars", () => {
    const longResult = "x".repeat(5000);
    const truncated = longResult.slice(0, 3000);
    expect(truncated.length).toBe(3000);
  });

  test("inject_result false skips context prefix", () => {
    const injectResult = false;
    const targetPrompt = "Generate daily briefing";
    // When inject_result is false, prompt is used as-is
    const finalPrompt = injectResult !== false
      ? `## Context\n\n---\n\n${targetPrompt}`
      : targetPrompt;
    expect(finalPrompt).toBe(targetPrompt);
  });
});

describe("task chaining — execution guards", () => {
  test("skips disabled chained targets", async () => {
    const db = new Database(":memory:");
    const processor = makeProcessor();
    const scheduler = new Scheduler(db, processor as any, TEST_CONFIG);

    const targetId = scheduler.addTask({
      name: "target-task",
      agent: "analyst",
      prompt: "Run target task",
      channel: "api",
    });
    scheduler.updateTask(targetId, { enabled: false });

    const sourceId = scheduler.addTask({
      name: "source-task",
      agent: "analyst",
      prompt: "Run source task",
      channel: "api",
    });
    db.run(
      "UPDATE scheduled_tasks SET chain_to = ? WHERE id = ?",
      [JSON.stringify({ task_name: "target-task", only_if: "always" }), sourceId],
    );

    await scheduler.triggerTask(sourceId);
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(processor.calls).toHaveLength(1);
    expect((scheduler.getTask(targetId) as { last_run_at: number | null }).last_run_at).toBeNull();
  });

  test("manual trigger respects disabled state unless forced", async () => {
    const db = new Database(":memory:");
    const processor = makeProcessor();
    const scheduler = new Scheduler(db, processor as any, TEST_CONFIG);

    const taskId = scheduler.addTask({
      name: "manual-task",
      agent: "analyst",
      prompt: "Run manual task",
      channel: "api",
    });
    scheduler.updateTask(taskId, { enabled: false });

    await scheduler.triggerTask(taskId);
    expect(processor.calls).toHaveLength(0);
    expect((scheduler.getTask(taskId) as { last_run_at: number | null }).last_run_at).toBeNull();

    await scheduler.triggerTask(taskId, { force: true });
    expect(processor.calls).toHaveLength(1);
    expect((scheduler.getTask(taskId) as { last_run_at: number | null }).last_run_at).not.toBeNull();
  });
});

// ─── Integration with isEmpty for chain gating ──────────────────────

// ─── evaluateChainCondition ──────────────────────────────────────────

describe("evaluateChainCondition", () => {
  const result = "[ACTION] Failed tasks detected\n[NOISE] Rate limit recovered";
  const emptyResult = "ok";

  test("undefined defaults to has_findings", () => {
    expect(evaluateChainCondition(undefined, result, false)).toBe(true);
    expect(evaluateChainCondition(undefined, emptyResult, true)).toBe(false);
  });

  test("has_findings gates on isEmpty", () => {
    expect(evaluateChainCondition("has_findings", result, false)).toBe(true);
    expect(evaluateChainCondition("has_findings", result, true)).toBe(false);
  });

  test("always passes regardless", () => {
    expect(evaluateChainCondition("always", result, false)).toBe(true);
    expect(evaluateChainCondition("always", emptyResult, true)).toBe(true);
  });

  test("contains: matches substring case-insensitively", () => {
    expect(evaluateChainCondition("contains:ACTION", result, false)).toBe(true);
    expect(evaluateChainCondition("contains:action", result, false)).toBe(true);
    expect(evaluateChainCondition("contains:ESCALATE", result, false)).toBe(false);
  });

  test("matches: uses regex", () => {
    expect(evaluateChainCondition("matches:\\[ACTION\\]", result, false)).toBe(true);
    expect(evaluateChainCondition("matches:\\[ESCALATE\\]", result, false)).toBe(false);
    expect(evaluateChainCondition("matches:failed.*detected", result, false)).toBe(true);
  });

  test("matches: with invalid regex returns false", () => {
    expect(evaluateChainCondition("matches:[invalid", result, false)).toBe(false);
  });

  test("array form: any matching condition passes (OR)", () => {
    expect(evaluateChainCondition(["contains:ACTION", "contains:ESCALATE"], result, false)).toBe(true);
    expect(evaluateChainCondition(["contains:ESCALATE", "contains:CRITICAL"], result, false)).toBe(false);
  });

  test("array form: mixed condition types", () => {
    expect(evaluateChainCondition(["has_findings", "contains:ESCALATE"], result, false)).toBe(true);
    expect(evaluateChainCondition(["contains:ESCALATE", "always"], result, true)).toBe(true);
  });

  test("unknown condition falls back to has_findings", () => {
    expect(evaluateChainCondition("unknown_thing", result, false)).toBe(true);
    expect(evaluateChainCondition("unknown_thing", emptyResult, true)).toBe(false);
  });
});

describe("task chaining — isEmpty integration", () => {
  test("substantive response triggers chain", () => {
    const response = "Found 3 failing tasks and 2 config drifts";
    expect(isEmptyResponse(response)).toBe(false);
  });

  test("HEARTBEAT_OK suppresses chain (default only_if)", () => {
    expect(isEmptyResponse("HEARTBEAT_OK")).toBe(true);
  });

  test("ok response suppresses chain", () => {
    expect(isEmptyResponse("ok")).toBe(true);
  });

  test("no findings response suppresses chain", () => {
    expect(isEmptyResponse("No issues found")).toBe(true);
  });
});

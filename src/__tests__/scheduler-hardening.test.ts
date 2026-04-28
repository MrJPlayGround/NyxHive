import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Scheduler, getMinuteStep, stableSchedulerPhaseOffsetMinutes } from "../scheduler/index.js";
import type { NyxHiveConfig } from "../types.js";

function spawnResult(exitCode: number, stdout = "", stderr = ""): ReturnType<typeof Bun.spawnSync> {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode,
    success: exitCode === 0,
  } as ReturnType<typeof Bun.spawnSync>;
}

let spawnSyncSpy: ReturnType<typeof spyOn<typeof Bun, "spawnSync">>;

afterEach(() => {
  spawnSyncSpy?.mockRestore();
});

function makeProcessor() {
  return {
    shouldRunAutonomousTask: () => true,
    getInflightCount: () => 0,
    emitEvent: () => {},
  };
}

function makeExecutingProcessor() {
  const calls: Array<Record<string, any>> = [];
  const events: Array<Record<string, any>> = [];
  const scheduledRunArtifacts: Array<Record<string, any>> = [];
  return {
    calls,
    events,
    scheduledRunArtifacts,
    shouldRunAutonomousTask: () => true,
    getInflightCount: () => 0,
    emitEvent: (type: string, data: Record<string, any>) => {
      events.push({ type, data });
    },
    processImmediate: async (opts: Record<string, any>) => {
      calls.push(opts);
      return { response: "analysis complete", agent: opts.agent, trace_id: "trace-scheduled-1" };
    },
    clearCliSessionsByConvId: () => {},
    getTraces: () => ({
      recordScheduledRunArtifact: (artifact: Record<string, any>) => {
        scheduledRunArtifacts.push(artifact);
      },
    }),
  };
}

function makeScheduler(db: Database): Scheduler {
  return new Scheduler(
    db,
    makeProcessor() as any,
    {
      agents: {},
      channels: {},
      daemon: { name: "test-instance", data_dir: "/tmp/nyxhive-test" },
      scheduler: { tick_interval_ms: 60_000 },
    } as unknown as NyxHiveConfig,
  );
}

function makeSchedulerWithProject(db: Database, processor = makeExecutingProcessor()): { scheduler: Scheduler; processor: ReturnType<typeof makeExecutingProcessor> } {
  return {
    scheduler: new Scheduler(
      db,
      processor as any,
      {
        agents: {},
        channels: {},
        daemon: {
          name: "test-instance",
          data_dir: "/tmp/nyxhive-test",
          projects: [{ name: "nyxhive", repo_path: "/repo/nyxhive", default: true }],
        },
        scheduler: { tick_interval_ms: 60_000 },
      } as unknown as NyxHiveConfig,
    ),
    processor,
  };
}

function insertTask(
  db: Database,
  overrides: Partial<{
    id: string;
    name: string;
    cron_expression: string | null;
    run_at: number | null;
    agent: string;
    next_run_at: number | null;
  }> = {},
): void {
  const now = Date.now();
  const cronExpression: string | null = Object.hasOwn(overrides, "cron_expression")
    ? overrides.cron_expression ?? null
    : "*/10 * * * *";
  const runAt: number | null = Object.hasOwn(overrides, "run_at") ? overrides.run_at ?? null : null;
  const nextRunAt: number = Object.hasOwn(overrides, "next_run_at") ? overrides.next_run_at ?? 0 : now + 60_000;
  db.run(
    `INSERT INTO scheduled_tasks
      (id, name, description, cron_expression, run_at, agent, prompt, channel, recipient, enabled, next_run_at, created_by, created_at, updated_at)
    VALUES (?, ?, NULL, ?, ?, ?, 'test prompt', 'api', NULL, 1, ?, 'test', ?, ?)`,
    [
      overrides.id ?? "task-1",
      overrides.name ?? "test:task",
      cronExpression,
      runAt,
      overrides.agent ?? "analyst",
      nextRunAt,
      now,
      now,
    ],
  );
}

function getTask(db: Database, id = "task-1"): Record<string, any> {
  return db.query("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) as Record<string, any>;
}

describe("scheduler hardening", () => {
  test("extracts supported minute-step cron expressions", () => {
    expect(getMinuteStep("*/10 * * * *")).toBe(10);
    expect(getMinuteStep("0 * * * *")).toBeNull();
    expect(getMinuteStep("* * * * *")).toBeNull();
    expect(getMinuteStep("*/1 * * * *")).toBeNull();
  });

  test("phases high-frequency minute-step crons deterministically", () => {
    const db = new Database(":memory:");
    const scheduler = makeScheduler(db);
    insertTask(db, { id: "phase-task", cron_expression: "*/10 * * * *" });

    const task = getTask(db, "phase-task");
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const nextRun = (scheduler as any).computeNextRun(task, now) as number;
    const expectedOffset = stableSchedulerPhaseOffsetMinutes("test-instance:phase-task:analyst", 10);

    expect(new Date(nextRun).getUTCMinutes() % 10).toBe(expectedOffset);
    db.close();
  });

  test("does not phase exact wall-clock cron expressions", () => {
    const db = new Database(":memory:");
    const scheduler = makeScheduler(db);
    insertTask(db, { id: "exact-task", cron_expression: "0 * * * *" });

    const task = getTask(db, "exact-task");
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const nextRun = (scheduler as any).computeNextRun(task, now) as number;

    expect(new Date(nextRun).getUTCMinutes()).toBe(0);
    db.close();
  });

  test("repairs stale cron next_run_at instead of firing old clustered state", () => {
    const db = new Database(":memory:");
    const scheduler = makeScheduler(db);
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    insertTask(db, { next_run_at: now - 60 * 60_000 });

    const repaired = (scheduler as any).repairPersistedSchedules(now) as number;
    const task = getTask(db);

    expect(repaired).toBe(1);
    expect(task.next_run_at).toBeGreaterThan(now);
    expect(task.enabled).toBe(1);
    db.close();
  });

  test("disables invalid one-shot schedules with a structured error", () => {
    const db = new Database(":memory:");
    const scheduler = makeScheduler(db);
    insertTask(db, { cron_expression: null, run_at: null, next_run_at: 0 });

    const repaired = (scheduler as any).repairPersistedSchedules(Date.now()) as number;
    const task = getTask(db);

    expect(repaired).toBe(1);
    expect(task.enabled).toBe(0);
    expect(task.last_status).toBe("failed");
    expect(task.last_error).toContain("Invalid one-shot schedule");
    db.close();
  });

  test("runs api-default tasks under scheduled authority with bounded timeout", async () => {
    const db = new Database(":memory:");
    const processor = makeExecutingProcessor();
    const scheduler = new Scheduler(
      db,
      processor as any,
      {
        agents: {},
        channels: {},
        daemon: { name: "test-instance", data_dir: "/tmp/nyxhive-test" },
        scheduler: { tick_interval_ms: 60_000 },
      } as unknown as NyxHiveConfig,
    );
    const id = scheduler.addTask({
      name: "test:authority",
      agent: "analyst",
      prompt: "Run the scheduled check",
      channel: "api",
      timeout_ms: 1_000,
    });

    await scheduler.triggerTask(id);

    expect(processor.calls).toHaveLength(1);
    expect(processor.calls[0].channel).toBe("scheduler");
    expect(processor.calls[0].trust).toBe("agent");
    expect(processor.calls[0].timeout_ms).toBe(30_000);
    db.close();
  });

  test("system authority preserves the explicit execution channel", async () => {
    const db = new Database(":memory:");
    const processor = makeExecutingProcessor();
    const scheduler = new Scheduler(
      db,
      processor as any,
      {
        agents: {},
        channels: {},
        daemon: { name: "test-instance", data_dir: "/tmp/nyxhive-test" },
        scheduler: { tick_interval_ms: 60_000 },
      } as unknown as NyxHiveConfig,
    );
    const id = scheduler.addTask({
      name: "test:system-authority",
      agent: "analyst",
      prompt: "Run the system check",
      channel: "system",
      authority_profile: "system",
    });

    await scheduler.triggerTask(id);

    expect(processor.calls).toHaveLength(1);
    expect(processor.calls[0].channel).toBe("system");
    expect(processor.calls[0].trust).toBe("system");
    db.close();
  });

  test("defers evolution tasks when the default repo is not on main or master", async () => {
    const db = new Database(":memory:");
    const { scheduler, processor } = makeSchedulerWithProject(db);
    spawnSyncSpy = spyOn(Bun, "spawnSync").mockReturnValueOnce(spawnResult(0, "proposal/5a60f9ef\n"));
    const id = scheduler.addTask({
      name: "evolution:codebase-review",
      agent: "scout",
      prompt: "Audit the codebase",
      cron_expression: "*/10 * * * *",
    });

    await scheduler.triggerTask(id);

    const task = getTask(db, id);
    expect(processor.calls).toHaveLength(0);
    expect(task.last_status).toBe("deferred");
    expect(task.last_error).toContain('branch "proposal/5a60f9ef"');
    expect(task.run_count).toBe(0);
    expect(processor.events.at(-1)).toMatchObject({
      type: "scan:completed",
      data: { task_name: "evolution:codebase-review", status: "deferred" },
    });
    expect(spawnSyncSpy).toHaveBeenCalledTimes(1);
    db.close();
  });

  test("defers evolution tasks when the default repo has dirty changes", async () => {
    const db = new Database(":memory:");
    const { scheduler, processor } = makeSchedulerWithProject(db);
    spawnSyncSpy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce(spawnResult(0, "master\n"))
      .mockReturnValueOnce(spawnResult(0, " M src/scheduler/index.ts\n"));
    const id = scheduler.addTask({
      name: "evolution:codebase-review",
      agent: "scout",
      prompt: "Audit the codebase",
      cron_expression: "*/10 * * * *",
    });

    await scheduler.triggerTask(id);

    const task = getTask(db, id);
    expect(processor.calls).toHaveLength(0);
    expect(task.last_status).toBe("deferred");
    expect(task.last_error).toContain("dirty working tree");
    expect(task.last_error).toContain("src/scheduler/index.ts");
    expect(spawnSyncSpy).toHaveBeenCalledTimes(2);
    db.close();
  });

  test("defers evolution tasks when the default repo has unpushed commits", async () => {
    const db = new Database(":memory:");
    const { scheduler, processor } = makeSchedulerWithProject(db);
    spawnSyncSpy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce(spawnResult(0, "master\n"))
      .mockReturnValueOnce(spawnResult(0, ""))
      .mockReturnValueOnce(spawnResult(0, "0 2\n"));
    const id = scheduler.addTask({
      name: "evolution:codebase-review",
      agent: "scout",
      prompt: "Audit the codebase",
      cron_expression: "*/10 * * * *",
    });

    await scheduler.triggerTask(id);

    const task = getTask(db, id);
    expect(processor.calls).toHaveLength(0);
    expect(task.last_status).toBe("deferred");
    expect(task.last_error).toContain("2 unpushed local commit");
    expect(spawnSyncSpy).toHaveBeenCalledTimes(3);
    db.close();
  });

  test("runs evolution tasks when the default repo is clean on a base branch", async () => {
    const db = new Database(":memory:");
    const { scheduler, processor } = makeSchedulerWithProject(db);
    spawnSyncSpy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce(spawnResult(0, "master\n"))
      .mockReturnValueOnce(spawnResult(0, ""))
      .mockReturnValueOnce(spawnResult(0, "0 0\n"));
    const id = scheduler.addTask({
      name: "evolution:codebase-review",
      agent: "scout",
      prompt: "Audit the codebase",
      cron_expression: "*/10 * * * *",
    });

    await scheduler.triggerTask(id);

    const task = getTask(db, id);
    expect(processor.calls).toHaveLength(1);
    expect(task.last_status).toBe("completed");
    expect(task.last_error).toBeNull();
    expect(processor.calls[0].task_id).toBe(id);
    expect(processor.scheduledRunArtifacts).toHaveLength(1);
    expect(processor.scheduledRunArtifacts[0]).toMatchObject({
      taskId: id,
      taskName: "evolution:codebase-review",
      traceId: "trace-scheduled-1",
      question: "What is the one highest-leverage bounded improvement NyxHive should make this run?",
      decision: "reported",
      outcome: "completed",
      notified: false,
    });
    expect(processor.scheduledRunArtifacts[0].evidence).toMatchObject({
      proposalsCreated: 0,
      empty: false,
      authorityProfile: "scheduled",
    });
    expect(processor.scheduledRunArtifacts[0].artifacts).toContainEqual({
      kind: "trace",
      ref: "trace-scheduled-1",
    });
    expect(spawnSyncSpy).toHaveBeenCalledTimes(3);
    db.close();
  });
});

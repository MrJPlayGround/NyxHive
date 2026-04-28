/**
 * Tests for scheduler/adaptive.ts — adaptive cron frequency adjustment.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { doubleInterval, halveInterval, adjustScheduleFrequency } from "../scheduler/adaptive.js";

// ─── Helpers ────────────────────────────────────────────────────────

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
  original_cron TEXT,
  adjusted_cron TEXT,
  consecutive_empty INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

function makeDb(): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

function insertTask(
  db: Database,
  overrides: Partial<{
    id: string;
    name: string;
    cron_expression: string;
    original_cron: string;
    adjusted_cron: string;
    consecutive_empty: number;
    agent: string;
  }> = {},
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO scheduled_tasks
      (id, name, cron_expression, original_cron, adjusted_cron, consecutive_empty, agent, prompt, channel, next_run_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'api', ?, ?, ?)`,
    [
      overrides.id ?? "task-1",
      overrides.name ?? "test:task",
      overrides.cron_expression ?? "0 2 * * *",
      overrides.original_cron ?? overrides.cron_expression ?? "0 2 * * *",
      overrides.adjusted_cron ?? null,
      overrides.consecutive_empty ?? 0,
      overrides.agent ?? "analyst",
      "test prompt",
      now,
      now,
      now,
    ],
  );
}

function getTask(db: Database, name = "test:task"): Record<string, unknown> | null {
  return db.query("SELECT * FROM scheduled_tasks WHERE name = ?").get(name) as Record<string, unknown> | null;
}

// ─── doubleInterval ──────────────────────────────────────────────────

describe("doubleInterval", () => {
  test("converts daily to every-2-days", () => {
    expect(doubleInterval("0 2 * * *")).toBe("0 2 */2 * *");
  });

  test("converts every-2-days to every-4-days", () => {
    expect(doubleInterval("0 2 */2 * *")).toBe("0 2 */4 * *");
  });

  test("caps at weekly", () => {
    // every-4-days doubled = 8 days >= 7, so caps at weekly
    expect(doubleInterval("0 2 */4 * *")).toBe("0 2 * * 1");
  });

  test("weekly stays weekly (already at cap)", () => {
    expect(doubleInterval("0 2 * * 1")).toBe("0 2 * * 1");
  });

  test("doubles hourly-step patterns", () => {
    expect(doubleInterval("0 */4 * * *")).toBe("0 */8 * * *");
  });

  test("returns complex patterns unchanged", () => {
    expect(doubleInterval("30 */2 * * *")).toBe("30 */2 * * *");
  });
});

// ─── halveInterval ───────────────────────────────────────────────────

describe("halveInterval", () => {
  test("converts every-2-days to daily", () => {
    expect(halveInterval("0 2 */2 * *")).toBe("0 2 * * *");
  });

  test("converts weekly to every-4-days", () => {
    expect(halveInterval("0 2 * * 1")).toBe("0 2 */4 * *");
  });

  test("converts every-4-days to every-2-days", () => {
    expect(halveInterval("0 2 */4 * *")).toBe("0 2 */2 * *");
  });

  test("floors at every-4-hours", () => {
    expect(halveInterval("0 */4 * * *")).toBe("0 */4 * * *");
  });

  test("halves hourly step above floor", () => {
    expect(halveInterval("0 */12 * * *")).toBe("0 */6 * * *");
  });

  test("daily halves to every-12-hours", () => {
    expect(halveInterval("0 2 * * *")).toBe("0 */12 * * *");
  });

  test("returns complex patterns unchanged", () => {
    expect(halveInterval("30 */2 * * *")).toBe("30 */2 * * *");
  });
});

// ─── adjustScheduleFrequency ────────────────────────────────────────

describe("adjustScheduleFrequency", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  test("increments consecutive_empty on no findings", () => {
    insertTask(db, { consecutive_empty: 0 });
    adjustScheduleFrequency(db, "test:task", false);

    const task = getTask(db);
    expect(task?.consecutive_empty).toBe(1);
    // Cron should not change yet
    expect(task?.cron_expression).toBe("0 2 * * *");
  });

  test("doubles interval after 3 empty runs", () => {
    insertTask(db, { consecutive_empty: 2, cron_expression: "0 2 * * *" });
    adjustScheduleFrequency(db, "test:task", false);

    const task = getTask(db);
    expect(task?.consecutive_empty).toBe(3);
    expect(task?.cron_expression).toBe("0 2 */2 * *");
    expect(task?.adjusted_cron).toBe("0 2 */2 * *");
  });

  test("resets to original on findings", () => {
    insertTask(db, {
      cron_expression: "0 2 */4 * *",
      original_cron: "0 2 * * *",
      adjusted_cron: "0 2 */4 * *",
      consecutive_empty: 5,
    });
    adjustScheduleFrequency(db, "test:task", true);

    const task = getTask(db);
    expect(task?.consecutive_empty).toBe(0);
    expect(task?.cron_expression).toBe("0 2 * * *");
    expect(task?.adjusted_cron).toBeNull();
  });

  test("halves interval on high-priority finding", () => {
    insertTask(db, {
      cron_expression: "0 2 */4 * *",
      original_cron: "0 2 * * *",
      consecutive_empty: 5,
    });
    adjustScheduleFrequency(db, "test:task", true, "high");

    const task = getTask(db);
    expect(task?.consecutive_empty).toBe(0);
    // Halves from original (daily) -> every 12 hours
    expect(task?.cron_expression).toBe("0 */12 * * *");
    expect(task?.adjusted_cron).toBe("0 */12 * * *");
  });

  test("leaves cron unchanged when consecutive_empty < 3", () => {
    insertTask(db, { consecutive_empty: 1, cron_expression: "0 2 * * *" });
    adjustScheduleFrequency(db, "test:task", false);

    const task = getTask(db);
    expect(task?.consecutive_empty).toBe(2);
    expect(task?.cron_expression).toBe("0 2 * * *");
  });

  test("does nothing for unknown task", () => {
    // No task inserted — should not throw
    adjustScheduleFrequency(db, "nonexistent:task", false);
  });

  test("progressive doubling on continued empty runs", () => {
    insertTask(db, { consecutive_empty: 2, cron_expression: "0 2 * * *", original_cron: "0 2 * * *" });

    // 3rd empty run: daily -> every 2 days
    adjustScheduleFrequency(db, "test:task", false);
    let task = getTask(db);
    expect(task?.cron_expression).toBe("0 2 */2 * *");

    // 4th empty run: still >= 3, doubles again: every 2 -> every 4
    adjustScheduleFrequency(db, "test:task", false);
    task = getTask(db);
    expect(task?.cron_expression).toBe("0 2 */4 * *");

    // 5th empty run: every 4 -> weekly (cap)
    adjustScheduleFrequency(db, "test:task", false);
    task = getTask(db);
    expect(task?.cron_expression).toBe("0 2 * * 1");
  });
});

import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { QueueProcessor } from "../queue/processor.js";
import { QueueDB } from "../queue/db.js";

/**
 * Tests for budget-gated autonomous task execution.
 * Validates that the processor correctly gates non-critical autonomous tasks
 * when daily budget usage exceeds the autonomous ceiling, while always allowing
 * critical system maintenance tasks.
 */

function createProcessor(opts: {
  dailyCost?: number;
  monthlyBudget?: number;
  autonomousCeiling?: number;
  hasMemory?: boolean;
}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "budget-gate-"));
  const queueDb = new QueueDB(tmpDir, "test");

  const memory = opts.hasMemory !== false
    ? {
        getTotalCost: (_hours: number) => opts.dailyCost ?? 0,
        getDb: () => null,
      } as any
    : undefined;

  const budgetConfig: Record<string, unknown> = {
    monthly_limit: opts.monthlyBudget ?? 0,
  };
  if (opts.autonomousCeiling !== undefined) {
    budgetConfig.autonomous_ceiling = opts.autonomousCeiling;
  }

  const processor = new QueueProcessor(queueDb, {
    agents: { nyx: { provider: "anthropic", model: "test" } as any },
    teams: {},
    baseDir: "/tmp/test",
    memory,
    nyxhiveConfig: {
      budget: budgetConfig,
    } as any,
  });

  return processor;
}

describe("shouldRunAutonomousTask", () => {
  it("allows critical tasks regardless of budget", () => {
    // Daily budget = $100/30 = ~$3.33, cost = $3.50 (>95%)
    const processor = createProcessor({
      dailyCost: 3.5,
      monthlyBudget: 100,
    });

    // Explicit critical flag
    expect(processor.shouldRunAutonomousTask("some-expensive-scan", true)).toBe(true);

    // Known critical task names
    expect(processor.shouldRunAutonomousTask("heartbeat:health-check")).toBe(true);
    expect(processor.shouldRunAutonomousTask("dev:execute-approved")).toBe(true);
    expect(processor.shouldRunAutonomousTask("proposals:sync-merged")).toBe(true);
    expect(processor.shouldRunAutonomousTask("proposals:reset-stale-reviewing")).toBe(true);
  });

  it("defers non-critical tasks when budget exceeds autonomous ceiling", () => {
    // monthly = $100, daily = $3.33, ceiling = 0.8 => threshold = $2.67
    // dailyCost = $2.80 => over ceiling but under 95%
    const processor = createProcessor({
      dailyCost: 2.8,
      monthlyBudget: 100,
      autonomousCeiling: 0.8,
    });

    expect(processor.shouldRunAutonomousTask("evolution:codebase-review")).toBe(false);
  });

  it("halts all non-critical tasks at 95% daily budget", () => {
    // monthly = $100, daily = $3.33, 95% = $3.17
    // dailyCost = $3.20 => over 95%
    const processor = createProcessor({
      dailyCost: 3.2,
      monthlyBudget: 100,
    });

    expect(processor.shouldRunAutonomousTask("evolution:codebase-review")).toBe(false);
    expect(processor.shouldRunAutonomousTask("briefing:daily")).toBe(false);
    expect(processor.shouldRunAutonomousTask("maintenance:drift-and-sync")).toBe(false);
  });

  it("allows tasks when no budget configured", () => {
    const processor = createProcessor({
      dailyCost: 999,
      monthlyBudget: 0, // no budget
    });

    expect(processor.shouldRunAutonomousTask("evolution:codebase-review")).toBe(true);
  });

  it("allows tasks when budget usage is low", () => {
    // monthly = $100, daily = $3.33, ceiling = 0.8 => threshold = $2.67
    // dailyCost = $0.50 => well under ceiling
    const processor = createProcessor({
      dailyCost: 0.5,
      monthlyBudget: 100,
      autonomousCeiling: 0.8,
    });

    expect(processor.shouldRunAutonomousTask("evolution:codebase-review")).toBe(true);
    expect(processor.shouldRunAutonomousTask("briefing:daily")).toBe(true);
  });

  it("allows tasks when memory store is not configured", () => {
    const processor = createProcessor({
      hasMemory: false,
      monthlyBudget: 100,
    });

    expect(processor.shouldRunAutonomousTask("evolution:codebase-review")).toBe(true);
  });

  it("recognizes all system tasks as critical", () => {
    // Over 95% of daily budget
    const processor = createProcessor({
      dailyCost: 3.5,
      monthlyBudget: 100,
    });

    const criticalTasks = [
      "health-check",
      "heartbeat:health-check",
      "reset-stale-reviewing",
      "proposals:reset-stale-reviewing",
      "sync-merged",
      "proposals:sync-merged",
      "execute-approved",
      "dev:execute-approved",
      "memory:maintenance",
    ];

    for (const task of criticalTasks) {
      expect(processor.shouldRunAutonomousTask(task)).toBe(true);
    }
  });

  it("uses default 0.8 ceiling when autonomous_ceiling not configured", () => {
    // monthly = $100, daily = $3.33, default ceiling = 0.8 => threshold = $2.67
    // dailyCost = $2.70 => just over default ceiling
    const processor = createProcessor({
      dailyCost: 2.7,
      monthlyBudget: 100,
      // no autonomousCeiling set — uses default 0.8
    });

    expect(processor.shouldRunAutonomousTask("evolution:codebase-review")).toBe(false);
  });
});

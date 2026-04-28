import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueProcessor } from "../queue/processor.js";
import { QueueDB } from "../queue/db.js";
import { IDLE_THRESHOLD_MS, IDLE_COOLDOWN_MS, AUTONOMOUS_BUDGET_CEILING } from "../defaults.js";

function makeProcessor(opts?: {
  nyxhiveConfig?: any;
  memory?: any | null;
  registry?: any;
  agents?: Record<string, any>;
}): any {
  const tmpDir = mkdtempSync(join(tmpdir(), "idle-test-"));
  const queue = new QueueDB(tmpDir);
  return new QueueProcessor(queue, {
    agents: opts?.agents ?? {
      nyx: { name: "Nyx", role: "lead", provider: "anthropic", model: "claude-sonnet-4-6", system_prompt: "test" },
    },
    teams: {},
    baseDir: tmpDir,
    nyxhiveConfig: opts?.nyxhiveConfig,
    memory: opts?.memory,
    registry: opts?.registry,
  });
}

describe("idle discovery defaults", () => {
  test("IDLE_THRESHOLD_MS is 30 minutes", () => {
    expect(IDLE_THRESHOLD_MS).toBe(30 * 60 * 1000);
  });

  test("IDLE_COOLDOWN_MS is 2 hours", () => {
    expect(IDLE_COOLDOWN_MS).toBe(2 * 60 * 60 * 1000);
  });

  test("AUTONOMOUS_BUDGET_CEILING is 0.8", () => {
    expect(AUTONOMOUS_BUDGET_CEILING).toBe(0.8);
  });
});

describe("checkIdleDiscovery", () => {
  test("is disabled by default", () => {
    const proc = makeProcessor();
    proc.lastActivityAt = Date.now() - 31 * 60 * 1000;
    proc.lastIdleTriggerAt = 0;

    proc.checkIdleDiscovery();

    expect(proc.queue.getPendingCount()).toBe(0);
  });

  test("triggers scout task after idle threshold", () => {
    const proc = makeProcessor({ nyxhiveConfig: { scheduler: { idle_discovery_enabled: true } } });
    // Set lastActivityAt to 31 min ago
    proc.lastActivityAt = Date.now() - 31 * 60 * 1000;
    proc.lastIdleTriggerAt = 0;

    proc.checkIdleDiscovery();

    // Should have enqueued a message
    const pending = proc.queue.getPendingCount();
    expect(pending).toBe(1);

    // Verify the enqueued message content
    const msg = proc.queue.claimMessage("nyx");
    expect(msg).not.toBeNull();
    expect(msg!.message).toContain("Idle discovery");
    expect(msg!.channel).toBe("system");
    expect(msg!.sender).toBe("system");
  });

  test("does not trigger when not idle long enough", () => {
    const proc = makeProcessor({ nyxhiveConfig: { scheduler: { idle_discovery_enabled: true } } });
    // Set lastActivityAt to 10 min ago (below 30 min threshold)
    proc.lastActivityAt = Date.now() - 10 * 60 * 1000;
    proc.lastIdleTriggerAt = 0;

    proc.checkIdleDiscovery();

    expect(proc.queue.getPendingCount()).toBe(0);
  });

  test("respects cooldown between idle triggers", () => {
    const proc = makeProcessor({ nyxhiveConfig: { scheduler: { idle_discovery_enabled: true } } });
    // Idle for 31 min
    proc.lastActivityAt = Date.now() - 31 * 60 * 1000;
    // But last trigger was 30 min ago (within 2h cooldown)
    proc.lastIdleTriggerAt = Date.now() - 30 * 60 * 1000;

    proc.checkIdleDiscovery();

    expect(proc.queue.getPendingCount()).toBe(0);
  });

  test("triggers after cooldown elapses", () => {
    const proc = makeProcessor({ nyxhiveConfig: { scheduler: { idle_discovery_enabled: true } } });
    // Idle for 3 hours
    proc.lastActivityAt = Date.now() - 3 * 60 * 60 * 1000;
    // Last trigger was 2.5 hours ago (past 2h cooldown)
    proc.lastIdleTriggerAt = Date.now() - 2.5 * 60 * 60 * 1000;

    proc.checkIdleDiscovery();

    expect(proc.queue.getPendingCount()).toBe(1);
  });

  test("skips when messages are pending", () => {
    const proc = makeProcessor({ nyxhiveConfig: { scheduler: { idle_discovery_enabled: true } } });
    proc.lastActivityAt = Date.now() - 31 * 60 * 1000;
    proc.lastIdleTriggerAt = 0;

    // Enqueue a message to make pending > 0
    proc.queue.enqueueMessage({
      message: "existing task",
      agent: "nyx",
      sender: "user",
      channel: "api",
    });

    proc.checkIdleDiscovery();

    // Only the pre-existing message should be there
    expect(proc.queue.getPendingCount()).toBe(1);
    const msg = proc.queue.claimMessage("nyx");
    expect(msg!.message).toBe("existing task");
  });

  test("skips idle trigger when budget exceeds autonomous ceiling", () => {
    const mockMemory = {
      getTotalCost: (_hours: number) => 10, // $10/day — well over $8/day * 0.8 ceiling
      getDb: () => null,
    };
    const proc = makeProcessor({
      memory: mockMemory,
      nyxhiveConfig: {
        budget: { monthly_limit: 240 }, // $8/day, ceiling 0.8 = $6.40
        scheduler: { idle_discovery_enabled: true },
      },
    });
    proc.lastActivityAt = Date.now() - 31 * 60 * 1000;
    proc.lastIdleTriggerAt = 0;

    proc.checkIdleDiscovery();

    expect(proc.queue.getPendingCount()).toBe(0);
  });

  test("triggers when budget is below autonomous ceiling", () => {
    const mockMemory = {
      getTotalCost: (_hours: number) => 2, // $2/day — below $6.40 ceiling
      getDb: () => null,
    };
    const proc = makeProcessor({
      memory: mockMemory,
      nyxhiveConfig: {
        budget: { monthly_limit: 240 },
        scheduler: { idle_discovery_enabled: true },
      },
    });
    proc.lastActivityAt = Date.now() - 31 * 60 * 1000;
    proc.lastIdleTriggerAt = 0;

    proc.checkIdleDiscovery();

    expect(proc.queue.getPendingCount()).toBe(1);
  });

  test("triggers when no budget config is set (no monthly_limit)", () => {
    const mockMemory = {
      getTotalCost: (_hours: number) => 100, // high cost but no limit set
      getDb: () => null,
    };
    const proc = makeProcessor({ memory: mockMemory, nyxhiveConfig: { scheduler: { idle_discovery_enabled: true } } });
    proc.lastActivityAt = Date.now() - 31 * 60 * 1000;
    proc.lastIdleTriggerAt = 0;

    proc.checkIdleDiscovery();

    // monthly = 0 means budget check is skipped
    expect(proc.queue.getPendingCount()).toBe(1);
  });

  test("uses configurable idle threshold from scheduler config", () => {
    const proc = makeProcessor({
      nyxhiveConfig: {
        scheduler: { idle_discovery_enabled: true, idle_threshold_minutes: 10 }, // 10 min threshold
      },
    });
    // Idle for 11 min — past the custom 10 min threshold
    proc.lastActivityAt = Date.now() - 11 * 60 * 1000;
    proc.lastIdleTriggerAt = 0;

    proc.checkIdleDiscovery();

    expect(proc.queue.getPendingCount()).toBe(1);
  });

  test("uses configurable cooldown from scheduler config", () => {
    const proc = makeProcessor({
      nyxhiveConfig: {
        scheduler: { idle_discovery_enabled: true, idle_cooldown_minutes: 60 }, // 1h cooldown
      },
    });
    proc.lastActivityAt = Date.now() - 31 * 60 * 1000;
    // Last trigger was 61 min ago — past 1h cooldown
    proc.lastIdleTriggerAt = Date.now() - 61 * 60 * 1000;

    proc.checkIdleDiscovery();

    expect(proc.queue.getPendingCount()).toBe(1);
  });

  test("uses custom autonomous_ceiling from budget config", () => {
    const mockMemory = {
      getTotalCost: (_hours: number) => 5, // $5/day
      getDb: () => null,
    };
    const proc = makeProcessor({
      memory: mockMemory,
      nyxhiveConfig: {
        budget: {
          monthly_limit: 240, // $8/day
          autonomous_ceiling: 0.5, // 50% → $4/day max
        },
        scheduler: { idle_discovery_enabled: true },
      },
    });
    proc.lastActivityAt = Date.now() - 31 * 60 * 1000;
    proc.lastIdleTriggerAt = 0;

    proc.checkIdleDiscovery();

    // $5 > $4 ceiling → should NOT trigger
    expect(proc.queue.getPendingCount()).toBe(0);
  });

  test("updates lastIdleTriggerAt when triggered", () => {
    const proc = makeProcessor({ nyxhiveConfig: { scheduler: { idle_discovery_enabled: true } } });
    proc.lastActivityAt = Date.now() - 31 * 60 * 1000;
    proc.lastIdleTriggerAt = 0;

    const before = Date.now();
    proc.checkIdleDiscovery();

    expect(proc.lastIdleTriggerAt).toBeGreaterThanOrEqual(before);
  });

  test("routes idle task to orchestrator/lead agent", () => {
    const proc = makeProcessor({
      nyxhiveConfig: { scheduler: { idle_discovery_enabled: true } },
      agents: {
        nyx: { name: "Nyx", role: "lead", provider: "anthropic", model: "test", system_prompt: "test" },
        analyst: { name: "Analyst", role: "worker", provider: "openrouter", model: "test", system_prompt: "test" },
      },
    });
    proc.lastActivityAt = Date.now() - 31 * 60 * 1000;
    proc.lastIdleTriggerAt = 0;

    proc.checkIdleDiscovery();

    const msg = proc.queue.claimMessage("nyx");
    expect(msg).not.toBeNull();
    expect(msg!.agent).toBe("nyx");
  });

  test("falls back to first agent when no orchestrator/lead exists", () => {
    const proc = makeProcessor({
      nyxhiveConfig: { scheduler: { idle_discovery_enabled: true } },
      agents: {
        worker1: { name: "Worker1", role: "worker", provider: "test", model: "test", system_prompt: "test" },
      },
    });
    proc.lastActivityAt = Date.now() - 31 * 60 * 1000;
    proc.lastIdleTriggerAt = 0;

    proc.checkIdleDiscovery();

    const msg = proc.queue.claimMessage("worker1");
    expect(msg).not.toBeNull();
  });

  test("does nothing when no agents configured", () => {
    const proc = makeProcessor({
      nyxhiveConfig: { scheduler: { idle_discovery_enabled: true } },
      agents: {},
    });
    proc.lastActivityAt = Date.now() - 31 * 60 * 1000;
    proc.lastIdleTriggerAt = 0;

    proc.checkIdleDiscovery();

    expect(proc.queue.getPendingCount()).toBe(0);
  });
});

describe("lastActivityAt updates", () => {
  test("lastActivityAt is initialized to current time", () => {
    const before = Date.now();
    const proc = makeProcessor();
    expect(proc.lastActivityAt).toBeGreaterThanOrEqual(before);
    expect(proc.lastActivityAt).toBeLessThanOrEqual(Date.now());
  });
});

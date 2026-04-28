import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { DevPlanStore } from "../development/plan.js";
import { executeDevPlan, type DevLoopOpts } from "../development/loop.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { MemoryStore } from "../memory/store.js";
import type { NyxHiveConfig } from "../types.js";

function makeConfig(overrides?: Partial<NyxHiveConfig>): NyxHiveConfig {
  return {
    agents: {},
    channels: {},
    instance_id: "test",
    data_dir: "/tmp/test",
    ...overrides,
  } as NyxHiveConfig;
}

function makeOpts(overrides: Partial<DevLoopOpts> & { planStore: DevPlanStore }): DevLoopOpts {
  const mockProcessor = {
    processImmediate: mock(() =>
      Promise.resolve({ message_id: "msg-1", response: "Done successfully", agent: "forge" }),
    ),
  } as unknown as QueueProcessor;

  const mockRegistry = {
    get: mock((key: string) => (key === "forge" ? { name: "forge", provider: "anthropic", model: "claude-3", working_directory: "/tmp" } : undefined)),
  } as unknown as AgentRegistry;

  return {
    planStore: overrides.planStore,
    processor: overrides.processor ?? mockProcessor,
    registry: overrides.registry ?? mockRegistry,
    memory: overrides.memory,
    config: overrides.config ?? makeConfig(),
  };
}

describe("executeDevPlan", () => {
  let db: Database;
  let store: DevPlanStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new DevPlanStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("does nothing if plan not found", async () => {
    const opts = makeOpts({ planStore: store });
    await executeDevPlan("plan-nonexistent", opts);
    // Should return without error
  });

  test("does nothing if plan not in running state", async () => {
    const plan = store.createPlan({ feature: "F", branch: "b", agent: "forge", createdBy: "jay" });
    // Plan is in "planning" state, not "running"
    const opts = makeOpts({ planStore: store });
    await executeDevPlan(plan.id, opts);
    expect(store.getPlan(plan.id)!.status).toBe("planning");
  });

  test("fails plan if agent not found in registry", async () => {
    const plan = store.createPlan({ feature: "F", branch: "b", agent: "unknown-agent", createdBy: "jay" });
    store.updatePlanStatus(plan.id, "running");

    const mockRegistry = {
      get: mock(() => undefined),
    } as unknown as AgentRegistry;

    const opts = makeOpts({ planStore: store, registry: mockRegistry });
    await executeDevPlan(plan.id, opts);

    expect(store.getPlan(plan.id)!.status).toBe("failed");
  });

  test("completes plan when all stories pass", async () => {
    const plan = store.createPlan({ feature: "F", branch: "b", agent: "forge", createdBy: "jay" });
    store.addStories(plan.id, [{ title: "Story 1" }, { title: "Story 2" }]);
    store.updatePlanStatus(plan.id, "running");

    const mockProcessor = {
      processImmediate: mock(() =>
        Promise.resolve({ message_id: "msg-1", response: "All good, task completed.", agent: "forge" }),
      ),
    } as unknown as QueueProcessor;

    const opts = makeOpts({ planStore: store, processor: mockProcessor });
    await executeDevPlan(plan.id, opts);

    expect(store.getPlan(plan.id)!.status).toBe("completed");
    const progress = store.getPlanProgress(plan.id);
    expect(progress.passed).toBe(2);
    expect(progress.failed).toBe(0);
  });

  test("marks plan failed when a story fails after max retries", async () => {
    const plan = store.createPlan({ feature: "F", branch: "b", agent: "forge", createdBy: "jay" });
    store.addStory(plan.id, "Flaky story");
    store.updatePlanStatus(plan.id, "running");

    const mockProcessor = {
      processImmediate: mock(() =>
        Promise.resolve({ message_id: "msg-1", response: "[BLOCKED] could not complete the task", agent: "forge" }),
      ),
    } as unknown as QueueProcessor;

    const opts = makeOpts({ planStore: store, processor: mockProcessor });
    await executeDevPlan(plan.id, opts);

    expect(store.getPlan(plan.id)!.status).toBe("failed");
    const progress = store.getPlanProgress(plan.id);
    expect(progress.failed).toBe(1);
  });

  test("retries stories before declaring failure", async () => {
    const plan = store.createPlan({ feature: "F", branch: "b", agent: "forge", createdBy: "jay" });
    store.addStory(plan.id, "Retry me");
    store.updatePlanStatus(plan.id, "running");

    let callCount = 0;
    const mockProcessor = {
      processImmediate: mock(() => {
        callCount++;
        // Fail first 2 attempts, succeed on 3rd
        if (callCount < 3) {
          return Promise.resolve({ message_id: `msg-${callCount}`, response: "[failed] something broke", agent: "forge" });
        }
        return Promise.resolve({ message_id: `msg-${callCount}`, response: "Done!", agent: "forge" });
      }),
    } as unknown as QueueProcessor;

    const opts = makeOpts({ planStore: store, processor: mockProcessor });
    await executeDevPlan(plan.id, opts);

    expect(store.getPlan(plan.id)!.status).toBe("completed");
    expect(callCount).toBe(3);
    const progress = store.getPlanProgress(plan.id);
    expect(progress.passed).toBe(1);
  });

  test("handles processImmediate throwing an exception", async () => {
    const plan = store.createPlan({ feature: "F", branch: "b", agent: "forge", createdBy: "jay" });
    store.addStory(plan.id, "Boom story");
    store.updatePlanStatus(plan.id, "running");

    const mockProcessor = {
      processImmediate: mock(() => Promise.reject(new Error("Connection timeout"))),
    } as unknown as QueueProcessor;

    const opts = makeOpts({ planStore: store, processor: mockProcessor });
    await executeDevPlan(plan.id, opts);

    // Should eventually fail after max retries (3)
    expect(store.getPlan(plan.id)!.status).toBe("failed");
    const stories = store.getStories(plan.id);
    expect(stories[0].status).toBe("failed");
    expect(stories[0].last_error).toContain("Connection timeout");
  });

  test("stops loop if plan is externally paused", async () => {
    const plan = store.createPlan({ feature: "F", branch: "b", agent: "forge", createdBy: "jay" });
    store.addStories(plan.id, [{ title: "Story 1" }, { title: "Story 2" }]);
    store.updatePlanStatus(plan.id, "running");

    let callCount = 0;
    const mockProcessor = {
      processImmediate: mock(() => {
        callCount++;
        // After first story, externally pause the plan
        if (callCount === 1) {
          store.updatePlanStatus(plan.id, "paused");
        }
        return Promise.resolve({ message_id: `msg-${callCount}`, response: "Done.", agent: "forge" });
      }),
    } as unknown as QueueProcessor;

    const opts = makeOpts({ planStore: store, processor: mockProcessor });
    await executeDevPlan(plan.id, opts);

    // Only one story should have been processed before pausing was detected
    expect(callCount).toBe(1);
    expect(store.getPlan(plan.id)!.status).toBe("paused");
  });

  test("pauses plan when budget exceeds 90%", async () => {
    const plan = store.createPlan({ feature: "F", branch: "b", agent: "forge", createdBy: "jay" });
    store.addStory(plan.id, "Expensive story");
    store.updatePlanStatus(plan.id, "running");

    const mockMemory = {
      getTotalCost: mock(() => 95), // $95 of $100 budget = 95%
    } as unknown as MemoryStore;

    const config = makeConfig({ budget: { monthly_limit: 100 } } as Partial<NyxHiveConfig>);
    const opts = makeOpts({ planStore: store, memory: mockMemory, config });
    await executeDevPlan(plan.id, opts);

    expect(store.getPlan(plan.id)!.status).toBe("paused");
  });

  test("does not check budget when no memory store", async () => {
    const plan = store.createPlan({ feature: "F", branch: "b", agent: "forge", createdBy: "jay" });
    store.addStory(plan.id, "Simple story");
    store.updatePlanStatus(plan.id, "running");

    const opts = makeOpts({ planStore: store, memory: undefined });
    await executeDevPlan(plan.id, opts);

    expect(store.getPlan(plan.id)!.status).toBe("completed");
  });

  test("extracts learnings from agent response", async () => {
    const plan = store.createPlan({ feature: "F", branch: "b", agent: "forge", createdBy: "jay" });
    store.addStory(plan.id, "Learn something");
    store.updatePlanStatus(plan.id, "running");

    const mockProcessor = {
      processImmediate: mock(() =>
        Promise.resolve({
          message_id: "msg-1",
          response: "Task done.\n\n## Learnings\n- SQLite WAL mode is faster for writes\n- Bun test runs in parallel by default\n",
          agent: "forge",
        }),
      ),
    } as unknown as QueueProcessor;

    const opts = makeOpts({ planStore: store, processor: mockProcessor });
    await executeDevPlan(plan.id, opts);

    const stories = store.getStories(plan.id);
    expect(stories[0].learnings).toContain("SQLite WAL mode");
    expect(stories[0].learnings).toContain("Bun test runs in parallel");
  });

  test("truncates error messages to 2000 chars", async () => {
    const plan = store.createPlan({ feature: "F", branch: "b", agent: "forge", createdBy: "jay" });
    store.addStory(plan.id, "Big error");
    store.updatePlanStatus(plan.id, "running");

    const longError = "x".repeat(5000);
    const mockProcessor = {
      processImmediate: mock(() =>
        Promise.resolve({
          message_id: "msg-1",
          response: `[failed] ${longError}`,
          agent: "forge",
        }),
      ),
    } as unknown as QueueProcessor;

    const opts = makeOpts({ planStore: store, processor: mockProcessor });
    await executeDevPlan(plan.id, opts);

    const stories = store.getStories(plan.id);
    expect(stories[0].last_error!.length).toBeLessThanOrEqual(2000);
  });

  test("completes plan with no stories immediately", async () => {
    const plan = store.createPlan({ feature: "Empty", branch: "b", agent: "forge", createdBy: "jay" });
    store.updatePlanStatus(plan.id, "running");

    const opts = makeOpts({ planStore: store });
    await executeDevPlan(plan.id, opts);

    // No stories means 0 failed, so completed
    expect(store.getPlan(plan.id)!.status).toBe("completed");
  });

  test("processes multiple stories in sequence", async () => {
    const plan = store.createPlan({ feature: "Multi", branch: "b", agent: "forge", createdBy: "jay" });
    store.addStories(plan.id, [
      { title: "First", acceptance_criteria: ["AC1"] },
      { title: "Second", acceptance_criteria: ["AC2"] },
      { title: "Third", acceptance_criteria: ["AC3"] },
    ]);
    store.updatePlanStatus(plan.id, "running");

    const messages: string[] = [];
    const mockProcessor = {
      processImmediate: mock((opts: { message: string }) => {
        messages.push(opts.message);
        return Promise.resolve({ message_id: "m", response: "Done", agent: "forge" });
      }),
    } as unknown as QueueProcessor;

    const opts = makeOpts({ planStore: store, processor: mockProcessor });
    await executeDevPlan(plan.id, opts);

    expect(messages).toHaveLength(3);
    // Each prompt should contain the story title
    expect(messages[0]).toContain("First");
    expect(messages[1]).toContain("Second");
    expect(messages[2]).toContain("Third");
    // Later stories should reference completed ones
    expect(messages[1]).toContain("Previous stories completed");
    expect(messages[2]).toContain("Previous stories completed");
  });

  test("story prompt includes error context on retry", async () => {
    const plan = store.createPlan({ feature: "Retry", branch: "b", agent: "forge", createdBy: "jay" });
    store.addStory(plan.id, "Flaky");
    store.updatePlanStatus(plan.id, "running");

    const messages: string[] = [];
    let callCount = 0;
    const mockProcessor = {
      processImmediate: mock((opts: { message: string }) => {
        callCount++;
        messages.push(opts.message);
        if (callCount === 1) {
          return Promise.resolve({ message_id: "m", response: "[failed] TypeCheck error on line 42", agent: "forge" });
        }
        return Promise.resolve({ message_id: "m", response: "Fixed it!", agent: "forge" });
      }),
    } as unknown as QueueProcessor;

    const opts = makeOpts({ planStore: store, processor: mockProcessor });
    await executeDevPlan(plan.id, opts);

    // Second attempt should include the error context
    expect(messages[1]).toContain("Previous Attempt Failed");
    expect(messages[1]).toContain("TypeCheck error on line 42");
  });

  test("story prompt includes quality checks", async () => {
    const plan = store.createPlan({
      feature: "QC",
      branch: "b",
      agent: "forge",
      createdBy: "jay",
      checks: ["bun run lint", "bun test"],
    });
    store.addStory(plan.id, "Do thing");
    store.updatePlanStatus(plan.id, "running");

    let capturedMessage = "";
    const mockProcessor = {
      processImmediate: mock((opts: { message: string }) => {
        capturedMessage = opts.message;
        return Promise.resolve({ message_id: "m", response: "Done", agent: "forge" });
      }),
    } as unknown as QueueProcessor;

    const opts = makeOpts({ planStore: store, processor: mockProcessor });
    await executeDevPlan(plan.id, opts);

    expect(capturedMessage).toContain("bun run lint");
    expect(capturedMessage).toContain("bun test");
    expect(capturedMessage).toContain("Quality Checks");
  });
});

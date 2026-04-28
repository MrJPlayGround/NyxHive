import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Scheduler } from "../scheduler/index.js";
import type { TaskDefinition, HiveStores } from "../framework/types.js";
import type { NyxHiveConfig } from "../types.js";

function makeConfig(): NyxHiveConfig {
  return {
    daemon: {
      name: "test-instance",
      log_level: "info",
      data_dir: "/tmp/test-instance",
    },
    server: { port: 3777 },
    agents: {},
    providers: {},
    routing: {
      classifier_model: "test-model",
      classifier_provider: "openrouter",
      cli_escalation_tasks: [],
    },
    context: {
      max_history: 10,
      summary_threshold: 5,
    },
  } as unknown as NyxHiveConfig;
}

describe("Scheduler extension tasks", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("registerTaskDefinitions upserts active tasks and removes stale extension tasks", () => {
    const processor = {
      shouldRunAutonomousTask: mock(() => true),
      emitEvent: mock(() => {}),
      getPublicAPI: mock(() => ({ enqueue: async () => "msg-1" })),
    };
    const scheduler = new Scheduler(db, processor as any, makeConfig(), {} as any);
    const stores = {} as HiveStores;

    scheduler.addTask({
      name: "stale-extension-task",
      cron_expression: "0 * * * *",
      agent: "extension",
      prompt: "[extension:stale-extension-task]",
      created_by: "extension",
    });

    const definitions: TaskDefinition[] = [
      {
        name: "fresh-extension-task",
        schedule: "*/5 * * * *",
        handler: async () => {},
      },
    ];

    scheduler.registerTaskDefinitions(definitions, stores);

    const fresh = scheduler.getTaskByName("fresh-extension-task");
    const stale = scheduler.getTaskByName("stale-extension-task");

    expect(fresh).not.toBeNull();
    expect(fresh?.agent).toBe("extension");
    expect(fresh?.created_by).toBe("extension");
    expect(fresh?.cron_expression).toBe("*/5 * * * *");
    expect(stale).toBeNull();
  });

  test("executeTask runs the registered extension handler", async () => {
    const handler = mock(async () => {});
    const processor = {
      shouldRunAutonomousTask: mock(() => true),
      emitEvent: mock(() => {}),
      getPublicAPI: mock(() => ({ enqueue: async () => "msg-1" })),
    };
    const scheduler = new Scheduler(db, processor as any, makeConfig(), {} as any);
    const stores = { queue: {} } as HiveStores;

    scheduler.registerTaskDefinitions([
      {
        name: "fresh-extension-task",
        schedule: "*/5 * * * *",
        handler,
      },
    ], stores);

    const task = scheduler.getTaskByName("fresh-extension-task");
    expect(task).not.toBeNull();

    await (scheduler as any).executeTask(task, { force: true });

    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler as any).mock.calls[0]?.[0]).toMatchObject({
      config: expect.any(Object),
      stores,
    });

    const updated = scheduler.getTaskByName("fresh-extension-task");
    expect(updated?.last_status).toBe("completed");
    expect(updated?.last_result).toBe("[extension] fresh-extension-task completed");
  });
});

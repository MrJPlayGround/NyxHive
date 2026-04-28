import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { gatherHeartbeatContext, Scheduler } from "../scheduler/index.js";

const BASE_CONFIG = {
  daemon: { name: "test", log_level: "error", data_dir: "/tmp", owner_channel: "telegram", owner_id: "owner-123" },
  server: { port: 3000 },
  agents: {},
  teams: {},
  providers: {},
  routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
  context: { max_history: 10, summary_threshold: 5 },
} as any;

function makeProcessor(response = "HEARTBEAT_OK") {
  const notifications: Array<{ recipientId: string; content: string; channelName: string }> = [];
  const processedMessages: string[] = [];
  const telegram = {
    name: "telegram",
    sendOutbound: async (recipientId: string, content: string) => {
      notifications.push({ recipientId, content, channelName: "telegram" });
    },
  };

  return {
    notifications,
    processedMessages,
    emitEvent: () => {},
    getInflightCount: () => 0,
    getTraces: () => undefined,
    processImmediate: async (opts: { message: string }) => {
      processedMessages.push(opts.message);
      return { response, agent: "nyx" };
    },
    shouldRunAutonomousTask: () => true,
    getChannels: () => [telegram],
    clearCliSessionsByConvId: () => {},
  };
}

describe("scheduler presence state", () => {
  test("scheduler initializes durable Nyx presence state storage", () => {
    const db = new Database(":memory:");
    const processor = makeProcessor();
    new Scheduler(db, processor as any, BASE_CONFIG);

    const table = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_presence_state'").get();
    expect(table).not.toBeNull();
  });

  test("heartbeat context includes the durable presence state", async () => {
    const db = new Database(":memory:");
    const processor = makeProcessor();
    new Scheduler(db, processor as any, BASE_CONFIG);

    const context = await gatherHeartbeatContext({ db, processor: processor as any, config: BASE_CONFIG });

    expect(context).toContain("### Nyx Presence State");
    expect(context).toContain("Current tension:");
    expect(context).toContain("Active preference:");
  });

  test("heartbeat context can target Vortex presence state", async () => {
    const db = new Database(":memory:");
    const processor = makeProcessor();
    new Scheduler(db, processor as any, BASE_CONFIG);

    const context = await gatherHeartbeatContext({ db, processor: processor as any, config: BASE_CONFIG, agent: "vortex" });

    expect(context).toContain("### Vortex Presence State");
    expect(context).toContain("Current tension:");
    expect(context).toContain("trading-workflow blockers");
    expect(context).not.toContain("### Nyx Presence State");
  });

  test("quiet presence heartbeat records continuity without notifying User", async () => {
    const db = new Database(":memory:");
    const processor = makeProcessor("HEARTBEAT_OK");
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);
    const taskId = scheduler.addTask({
      name: "heartbeat:presence",
      agent: "nyx",
      prompt: "Run presence heartbeat",
      channel: "scheduler",
      notify_channels: ["telegram:owner-123"],
    });

    await scheduler.triggerTask(taskId);

    expect(processor.notifications).toHaveLength(0);
    const state = db.query("SELECT * FROM agent_presence_state WHERE id = 'nyx'").get() as {
      heartbeat_count: number;
      quiet_count: number;
      last_outbound_reason: string | null;
      current_tension: string;
    };
    expect(state.heartbeat_count).toBe(1);
    expect(state.quiet_count).toBe(1);
    expect(state.last_outbound_reason).toBeNull();
    expect(state.current_tension).toContain("quiet");
  });

  test("substantive Vortex presence heartbeat records outbound reason for the next run", async () => {
    const db = new Database(":memory:");
    const response = "User, Vortex sees product drift: journal review flow is blocked by unclear trade status semantics.";
    const processor = makeProcessor(response);
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);
    const taskId = scheduler.addTask({
      name: "heartbeat:vortex-presence",
      agent: "vortex",
      prompt: "Run presence heartbeat",
      channel: "scheduler",
      notify_channels: ["telegram:owner-123"],
    });

    await scheduler.triggerTask(taskId);

    expect(processor.notifications).toHaveLength(1);
    const state = db.query("SELECT * FROM agent_presence_state WHERE id = 'vortex'").get() as {
      heartbeat_count: number;
      quiet_count: number;
      last_outbound_reason: string | null;
      last_self_chosen_action: string | null;
      current_tension: string;
    };
    expect(state.heartbeat_count).toBe(1);
    expect(state.quiet_count).toBe(0);
    expect(state.last_outbound_reason).toContain("product drift");
    expect(state.last_self_chosen_action).toBe("notified User from Vortex presence heartbeat");
    expect(state.current_tension).toContain("trade status semantics");
  });
});

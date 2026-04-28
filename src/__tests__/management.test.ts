import { describe, test, expect, beforeEach } from "bun:test";
import { ManagementActionExecutor, type ManagementContext } from "../queue/management.js";
import type { AgentAction, AgentActionType } from "../agents/actor.js";
import { ProposalStore } from "../proposals/store.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function action(type: string, params: Record<string, string>): AgentAction {
  return { type: type as AgentActionType, params, raw: `[@${type}: test]` };
}

function makeCtx(overrides: Record<string, unknown> = {}): ManagementContext {
  return {
    registry: undefined,
    knowledge: undefined,
    embedder: undefined,
    nyxhiveConfig: undefined,
    teams: {},
    getAgent: () => undefined,
    emit: () => {},
    resolveReviewAgent: () => "analyst",
    resolveProposalReviewModel: () => "gpt-5.4",
    processImmediate: async () => ({ message_id: "test", response: "ok", agent: "test" }),
    scheduler: undefined,
    channels: undefined,
    devPlanStore: undefined,
    proposalStore: undefined,
    queue: { enqueueMessage: () => "msg-1" },
    memory: undefined,
    ...overrides,
  } as unknown as ManagementContext;
}

function makeRegistry(role: string = "orchestrator") {
  const agents = new Map<string, any>();
  return {
    getEntry: (key: string) => {
      if (key === "nyx") return { role };
      return agents.get(key) ?? undefined;
    },
    getAll: () => ({}),
    getKnownAgentKeys: () => new Set(["nyx"]),
    create: (key: string, config: any, _by?: string) => {
      const entry = { key, ...config, provider: config.provider ?? "anthropic", model: config.model ?? "claude-sonnet-4-6" };
      agents.set(key, entry);
      return { success: true };
    },
    disable: (key: string) => {
      agents.delete(key);
      return { success: true };
    },
    update: (key: string, updates: any) => {
      const existing = agents.get(key) ?? {};
      agents.set(key, { ...existing, ...updates });
      return { success: true };
    },
    get: (key: string) => agents.get(key),
  };
}

describe("ManagementActionExecutor", () => {
  let executor: ManagementActionExecutor;

  beforeEach(() => {
    executor = new ManagementActionExecutor();
  });

  describe("authorization", () => {
    test("returns error when no registry", async () => {
      const ctx = makeCtx();
      const results = await executor.execute(
        [action("hire", { key: "test", name: "Test" })],
        "nyx",
        ctx,
      );
      expect(results).toEqual(["[Management actions unavailable: no registry]"]);
    });

    test("rejects non-lead agents", async () => {
      const registry = makeRegistry("worker");
      const ctx = makeCtx({ registry: registry as any });
      const results = await executor.execute(
        [action("hire", { key: "test", name: "Test" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("not a lead/coordinator agent");
    });
  });

  describe("hire action", () => {
    test("creates new agent successfully", async () => {
      const registry = makeRegistry();
      const ctx = makeCtx({ registry: registry as any });
      const results = await executor.execute(
        [action("hire", { key: "analyst", name: "Analyst", provider: "openai", model: "gpt-4o" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("Hired");
      expect(results[0]).toContain("@analyst");
    });

    test("fails when key is missing", async () => {
      const registry = makeRegistry();
      const ctx = makeCtx({ registry: registry as any });
      const results = await executor.execute(
        [action("hire", { name: "Test" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("key and name required");
    });

    test("fails when name is missing", async () => {
      const registry = makeRegistry();
      const ctx = makeCtx({ registry: registry as any });
      const results = await executor.execute(
        [action("hire", { key: "test" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("key and name required");
    });
  });

  describe("fire action", () => {
    test("disables an agent", async () => {
      const registry = makeRegistry();
      registry.create("old_agent", { name: "Old Agent" });
      const ctx = makeCtx({ registry: registry as any });
      const results = await executor.execute(
        [action("fire", { key: "old_agent" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("Fired");
      expect(results[0]).toContain("@old_agent");
    });
  });

  describe("reassign action", () => {
    test("updates agent model", async () => {
      const registry = makeRegistry();
      registry.create("forge", { name: "Forge", model: "claude-sonnet-4-6" });
      const ctx = makeCtx({ registry: registry as any });
      const results = await executor.execute(
        [action("reassign", { key: "forge", model: "claude-opus-4-6" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("Reassigned");
      expect(results[0]).toContain("@forge");
      expect(results[0]).toContain("claude-opus-4-6");
    });

    test("fails when key or model missing", async () => {
      const registry = makeRegistry();
      const ctx = makeCtx({ registry: registry as any });
      const results = await executor.execute(
        [action("reassign", { key: "forge" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("key and model required");
    });
  });

  describe("team action", () => {
    test("creates team from comma-separated agents", async () => {
      const registry = makeRegistry();
      const teams: Record<string, any> = {};
      const ctx = makeCtx({ registry: registry as any, teams });
      const results = await executor.execute(
        [action("team", { name: "DevTeam", agents: "forge, tester, analyst" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("DevTeam");
      expect(teams["DevTeam"]).toBeDefined();
      expect(teams["DevTeam"].agents).toEqual(["forge", "tester", "analyst"]);
    });

    test("fails when name or agents missing", async () => {
      const registry = makeRegistry();
      const ctx = makeCtx({ registry: registry as any, teams: {} });
      const results = await executor.execute(
        [action("team", { name: "DevTeam" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("name and agents required");
    });
  });

  describe("schedule action", () => {
    test("fails when scheduler not available", async () => {
      const registry = makeRegistry();
      const ctx = makeCtx({ registry: registry as any });
      const results = await executor.execute(
        [action("schedule", { name: "daily-check", agent: "forge", prompt: "Run tests" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("scheduler not available");
    });

    test("creates scheduled task when scheduler exists", async () => {
      const registry = makeRegistry();
      let created: any = null;
      const scheduler = {
        addTask: (task: any) => { created = task; return { id: "task-1", ...task }; },
      };
      const ctx = makeCtx({
        registry: registry as any,
        scheduler,
        getAgent: (key: string) => key === "forge" ? { name: "Forge" } : undefined,
      });
      const results = await executor.execute(
        [action("schedule", { name: "daily-check", agent: "forge", prompt: "Run tests", cron: "0 9 * * *" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("daily-check");
      expect(created).toBeTruthy();
      expect(created.name).toBe("daily-check");
      expect(created.agent).toBe("forge");
    });

    test("fails when required params missing", async () => {
      const registry = makeRegistry();
      const ctx = makeCtx({ registry: registry as any, scheduler: {} });
      const results = await executor.execute(
        [action("schedule", { name: "test" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("name, agent, and prompt required");
    });
  });

  describe("propose action", () => {
    test("uses resolved review agent for async auto-review", async () => {
      const registry = makeRegistry();
      const tmpDir = mkdtempSync(join(tmpdir(), "management-propose-test-"));
      const store = new ProposalStore(tmpDir, "test");
      let invokedAgent = "";

      try {
        const ctx = makeCtx({
          registry: registry as any,
          proposalStore: store,
          resolveReviewAgent: () => "vortex",
          processImmediate: async (opts: { agent?: string }) => {
            invokedAgent = opts.agent ?? "";
            return { message_id: "review-1", response: "VERDICT: DO\nREASON: fine\nEFFORT: small\nOVERLAPS: none", agent: "vortex" };
          },
        });

        const results = await executor.execute(
          [action("propose", {
            title: "Tighten proposal review routing",
            description: "Use the active lead when analyst is unavailable",
            category: "improvement",
            effort: "small",
            priority: "medium",
            files: "src/queue/management.ts",
          })],
          "nyx",
          ctx,
        );

        expect(results[0]).toContain("awaiting approval");
        await Promise.resolve();
        await Bun.sleep(0);
        expect(invokedAgent).toBe("vortex");
      } finally {
        store.close();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe("unschedule action", () => {
    test("fails when scheduler not available", async () => {
      const registry = makeRegistry();
      const ctx = makeCtx({ registry: registry as any });
      const results = await executor.execute(
        [action("unschedule", { key: "daily-check" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("scheduler not available");
    });
  });

  describe("alert action", () => {
    test("sends alert to configured channel", async () => {
      const registry = makeRegistry();
      let sentMessage = "";
      let sentRecipient = "";
      const channels = [
        {
          name: "telegram",
          sendOutbound: async (recipient: string, message: string) => {
            sentRecipient = recipient;
            sentMessage = message;
          },
        },
      ];
      const ctx = makeCtx({
        registry: registry as any,
        channels: channels as any,
        nyxhiveConfig: { daemon: { owner_channel: "telegram", owner_id: "jay" } } as any,
      });
      const results = await executor.execute(
        [action("alert", { message: "Server is down!" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("Alert sent");
      expect(sentMessage).toContain("Server is down!");
      expect(sentRecipient).toBe("jay");
    });

    test("fails when message is missing", async () => {
      const registry = makeRegistry();
      const ctx = makeCtx({ registry: registry as any });
      const results = await executor.execute(
        [action("alert", {})],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("message required");
    });

    test("truncates long messages at 2000 chars", async () => {
      const registry = makeRegistry();
      let sentMessage = "";
      const channels = [{
        name: "test",
        sendOutbound: async (_r: string, msg: string) => { sentMessage = msg; },
      }];
      const ctx = makeCtx({
        registry: registry as any,
        channels: channels as any,
        nyxhiveConfig: { daemon: { owner_channel: "test", owner_id: "user" } } as any,
      });
      await executor.execute(
        [action("alert", { message: "x".repeat(3000) })],
        "nyx",
        ctx,
      );
      expect(sentMessage.length).toBeLessThanOrEqual(2000);
    });

    test("rate limits after 10 alerts per hour", async () => {
      const registry = makeRegistry();
      const channels = [{
        name: "test",
        sendOutbound: async () => {},
      }];
      const ctx = makeCtx({
        registry: registry as any,
        channels: channels as any,
        nyxhiveConfig: { daemon: { owner_channel: "test", owner_id: "user" } } as any,
      });

      // Send 10 alerts
      for (let i = 0; i < 10; i++) {
        await executor.execute(
          [action("alert", { message: `Alert ${i}` })],
          "nyx",
          ctx,
        );
      }

      // 11th should be rate limited
      const results = await executor.execute(
        [action("alert", { message: "One more" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("rate-limited");
    });

    test("alert routes to notifications.alerts config", async () => {
      const registry = makeRegistry();
      const sent: string[] = [];
      const channels = [{ name: "discord", sendOutbound: async (_r: string, msg: string) => { sent.push(msg); } }];
      const ctx = makeCtx({
        registry: registry as any,
        channels: channels as any,
        nyxhiveConfig: {
          notifications: { alerts: { channel: "discord", recipient: "alerts-channel" } },
        } as any,
      });
      const results = await executor.execute(
        [action("alert", { message: "test alert" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("Alert sent");
      expect(sent).toContain("test alert");
    });
  });

  describe("learn action", () => {
    test("fails when content is missing", async () => {
      const registry = makeRegistry();
      const ctx = makeCtx({ registry: registry as any });
      const results = await executor.execute(
        [action("learn", {})],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("content required");
    });

    test("fails when neither vault nor knowledge configured", async () => {
      const registry = makeRegistry();
      const ctx = makeCtx({
        registry: registry as any,
        nyxhiveConfig: {} as any,
      });
      const results = await executor.execute(
        [action("learn", { content: "Some useful knowledge" })],
        "nyx",
        ctx,
      );
      expect(results[0]).toContain("no vault path or knowledge store");
    });
  });

  describe("multiple actions", () => {
    test("executes all actions and returns results for each", async () => {
      const registry = makeRegistry();
      const ctx = makeCtx({ registry: registry as any });
      const results = await executor.execute(
        [
          action("hire", { key: "agent1", name: "Agent 1" }),
          action("hire", { key: "agent2", name: "Agent 2" }),
        ],
        "nyx",
        ctx,
      );
      expect(results).toHaveLength(2);
      expect(results[0]).toContain("@agent1");
      expect(results[1]).toContain("@agent2");
    });
  });
});

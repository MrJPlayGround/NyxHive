import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AgentRegistry } from "../agents/registry.js";
import { clearSoulCache } from "../soul/runtime.js";

function createRegistry() {
  const db = new Database(":memory:");
  return new AgentRegistry(db);
}

describe("Watchdog Status Tracking", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = createRegistry();
  });

  it("agents start with no running state", () => {
    expect(registry.getRunningAgents()).toEqual(new Map());
  });

  it("markRunning tracks agent as running", () => {
    registry.markRunning("nyx", { taskDescription: "fixing bug" });
    const running = registry.getRunningAgents();
    expect(running.has("nyx")).toBe(true);
    expect(running.get("nyx")!.taskDescription).toBe("fixing bug");
  });

  it("markIdle removes agent from running", () => {
    registry.markRunning("nyx", {});
    registry.markIdle("nyx");
    expect(registry.getRunningAgents().has("nyx")).toBe(false);
  });

  it("recordHeartbeat updates heartbeatAt", () => {
    registry.markRunning("nyx", {});
    const before = registry.getRunningAgents().get("nyx")!.heartbeatAt;
    registry.recordHeartbeat("nyx");
    const after = registry.getRunningAgents().get("nyx")!.heartbeatAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("getStuckAgents returns agents past threshold", () => {
    registry.markRunning("nyx", {});
    const entry = registry.getRunningAgents().get("nyx")!;
    entry.heartbeatAt = Date.now() - 60_000;
    const stuck = registry.getStuckAgents(30_000);
    expect(stuck).toHaveLength(1);
    expect(stuck[0][0]).toBe("nyx");
  });

  it("getStuckAgents excludes agents within threshold", () => {
    registry.markRunning("nyx", {});
    const stuck = registry.getStuckAgents(30_000);
    expect(stuck).toHaveLength(0);
  });

  it("seeds config agents with instance-specific soul capabilities", () => {
    clearSoulCache();
    const db = new Database(":memory:");
    const instanceSoulsDir = mkdtempSync(join(tmpdir(), "registry-instance-soul-test-"));
    const agentKey = `registry_instance_${Date.now()}`;
    const agentSoulPath = join(process.cwd(), "souls", `${agentKey}.yaml`);

    try {
      writeFileSync(
        agentSoulPath,
        `identity:\n  name: Registry Instance\n  role: worker\ncapabilities:\n  can_delegate: false\n`,
      );
      writeFileSync(
        join(instanceSoulsDir, "instance.yaml"),
        `capabilities:\n  allowed_directories:\n    - /instance/override\n`,
      );

      const seededRegistry = new AgentRegistry(
        db,
        {
          [agentKey]: {
            name: "Registry Instance",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            working_directory: `/tmp/${agentKey}`,
          },
        },
        undefined,
        ["/global"],
        "/tmp",
        instanceSoulsDir,
      );

      expect(seededRegistry.get(agentKey)?.allowed_directories).toContain("/instance/override");
      expect(seededRegistry.get(agentKey)?.allowed_directories).toContain("/global");
    } finally {
      clearSoulCache();
      db.close();
      rmSync(agentSoulPath, { force: true });
      rmSync(instanceSoulsDir, { recursive: true, force: true });
    }
  });

  it("keeps Codex/OpenAI config models from being overwritten by Claude soul bounds", () => {
    clearSoulCache();
    const db = new Database(":memory:");
    const agentKey = `registry_codex_${Date.now()}`;
    const agentSoulPath = join(process.cwd(), "souls", `${agentKey}.yaml`);

    try {
      writeFileSync(
        agentSoulPath,
        `identity:\n  name: Registry Codex\n  role: lead\ncapabilities:\n  can_delegate: true\nmodel_capabilities:\n  min_model: opus\n  default_model: opus\n  max_model: opus\n`,
      );

      const seededRegistry = new AgentRegistry(
        db,
        {
          [agentKey]: {
            name: "Registry Codex",
            provider: "openai",
            model: "gpt-5.4",
            always_cli: true,
            cli_fallback: "codex",
            working_directory: `/tmp/${agentKey}`,
          },
        },
      );

      const agent = seededRegistry.get(agentKey);
      expect(agent?.model).toBe("gpt-5.4");
      expect(agent?.min_model).toBeUndefined();
      expect(agent?.max_model).toBeUndefined();
    } finally {
      clearSoulCache();
      db.close();
      rmSync(agentSoulPath, { force: true });
    }
  });

  it("persists strict agentic mode for config-seeded agents", () => {
    const db = new Database(":memory:");
    const agentKey = `registry_strict_${Date.now()}`;

    try {
      const seededRegistry = new AgentRegistry(
        db,
        {
          [agentKey]: {
            name: "Registry Strict",
            provider: "openai",
            model: "gpt-5.4",
            always_cli: true,
            cli_fallback: "codex",
            agentic_mode: "strict",
            working_directory: `/tmp/${agentKey}`,
          },
        },
      );

      expect(seededRegistry.get(agentKey)?.agentic_mode).toBe("strict");
      expect(seededRegistry.getEntry(agentKey)?.agentic_mode).toBe("strict");
    } finally {
      db.close();
    }
  });

  it("persists effort for config-seeded Codex agents", () => {
    const db = new Database(":memory:");
    const agentKey = `registry_effort_${Date.now()}`;

    try {
      const seededRegistry = new AgentRegistry(
        db,
        {
          [agentKey]: {
            name: "Registry Effort",
            provider: "openai",
            model: "gpt-5.4",
            always_cli: true,
            cli_fallback: "codex",
            effort: "high",
            working_directory: `/tmp/${agentKey}`,
          },
        },
      );

      expect(seededRegistry.get(agentKey)?.effort).toBe("high");
      expect(seededRegistry.getEntry(agentKey)?.effort).toBe("high");
    } finally {
      db.close();
    }
  });

  it("still applies Claude soul bounds to Anthropic agents", () => {
    clearSoulCache();
    const db = new Database(":memory:");
    const agentKey = `registry_anthropic_${Date.now()}`;
    const agentSoulPath = join(process.cwd(), "souls", `${agentKey}.yaml`);

    try {
      writeFileSync(
        agentSoulPath,
        `identity:\n  name: Registry Anthropic\n  role: lead\ncapabilities:\n  can_delegate: true\nmodel_capabilities:\n  min_model: opus\n  default_model: opus\n  max_model: opus\n`,
      );

      const seededRegistry = new AgentRegistry(
        db,
        {
          [agentKey]: {
            name: "Registry Anthropic",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            cli_fallback: "claude",
            working_directory: `/tmp/${agentKey}`,
          },
        },
      );

      const agent = seededRegistry.get(agentKey);
      expect(agent?.model).toBe("claude-sonnet-4-6");
      expect(agent?.min_model).toBe("claude-opus-4-6");
      expect(agent?.max_model).toBe("claude-opus-4-6");
    } finally {
      clearSoulCache();
      db.close();
      rmSync(agentSoulPath, { force: true });
    }
  });
});

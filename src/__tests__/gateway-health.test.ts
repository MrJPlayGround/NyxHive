import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGatewayHealth } from "../server/gateway-health.js";
import { ConnectionManager } from "../server/ws/connection.js";
import { MethodRouter } from "../server/ws/router.js";
import { QueueDB } from "../queue/db.js";
import type { NyxHiveConfig } from "../types.js";

function baseConfig(overrides: Partial<NyxHiveConfig> = {}): NyxHiveConfig {
  return {
    daemon: {
      name: "test-hive",
      log_level: "info",
      data_dir: "/tmp",
      primary_agent: "nyx",
    },
    server: {
      port: 3777,
      api_key: "test-key",
    },
    agents: {
      nyx: {
        name: "Nyx",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        working_directory: "/tmp",
      },
    },
    providers: {},
    routing: {
      classifier_model: "claude-sonnet-4-6",
      classifier_provider: "anthropic",
      cli_escalation_tasks: [],
    },
    context: {
      max_history: 20,
      summary_threshold: 40,
    },
    ...overrides,
  } as NyxHiveConfig;
}

describe("gateway health collector", () => {
  let tmpDir: string;
  let queue: QueueDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "gateway-health-test-"));
    queue = new QueueDB(tmpDir);
  });

  afterEach(() => {
    queue.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reports ok when core gateway checks are clean", () => {
    const wsRouter = new MethodRouter();
    wsRouter.register("system.health", async () => ({ uptime: 1, queueDepth: 0, activeConnections: 0, agents: 1, memoryUsage: 0 }));

    const report = collectGatewayHealth({
      config: baseConfig(),
      startTime: Date.now() - 1000,
      queue,
      connections: new ConnectionManager(),
      wsRouter,
    });

    expect(report.status).toBe("ok");
    expect(report.queue?.deadLetters).toBe(0);
    expect(report.wsMethods.registered).toContain("system.health");
    expect(report.checks.some((check) => check.id === "trust.posture")).toBe(true);
  });

  test("degrades on remote URL warnings and queue dead letters", () => {
    const deadId = queue.enqueueMessage({
      channel: "cli",
      sender: "jay",
      task_id: "task-dead",
      message: "retry me",
    });
    queue.failMessage(deadId, "Agent timed out after 30s", 1);

    const report = collectGatewayHealth({
      config: baseConfig({
        remotes: {
          lab: { url: "https://lab.example.com", api_key_env: "LAB_API_KEY" },
        },
      } as Partial<NyxHiveConfig>),
      startTime: Date.now() - 1000,
      queue,
      connections: new ConnectionManager(),
      wsRouter: new MethodRouter(),
    });

    expect(report.status).toBe("degraded");
    expect(report.warnings.some((warning) => warning.includes("server.public_url"))).toBe(true);
    expect(report.queue?.deadLetters).toBe(1);
  });

  test("errors when gateway API auth is blocked", () => {
    const report = collectGatewayHealth({
      config: baseConfig({ server: { port: 3777 } } as Partial<NyxHiveConfig>),
      startTime: Date.now() - 1000,
      queue,
      connections: new ConnectionManager(),
      wsRouter: new MethodRouter(),
    });

    expect(report.status).toBe("error");
    expect(report.errors.some((error) => error.includes("No API authentication"))).toBe(true);
  });

  test("surfaces the personal-assistant trust posture in health output", () => {
    const report = collectGatewayHealth({
      config: baseConfig({
        pairing: { enabled: true },
        telegram: { bot_token_env: "TELEGRAM_BOT_TOKEN" },
        discord: { bot_token_env: "DISCORD_BOT_TOKEN" },
      } as Partial<NyxHiveConfig>),
      startTime: Date.now() - 1000,
      queue,
      connections: new ConnectionManager(),
      wsRouter: new MethodRouter(),
    });

    const trustCheck = report.checks.find((check) => check.id === "trust.posture");
    expect(trustCheck).toBeDefined();
    expect(trustCheck?.summary).toContain("Personal assistant trust boundary");
    expect(trustCheck?.details).toMatchObject({
      operatorBoundary: "single_trusted_operator",
      pairedDmSurfaces: ["telegram_dm", "discord_dm"],
      publicSafeSurfaces: ["discord_public"],
    });
  });

  test("treats single-operator DM surfaces without pairing as healthy posture", () => {
    const report = collectGatewayHealth({
      config: baseConfig({
        pairing: { enabled: false },
        telegram: { bot_token_env: "TELEGRAM_BOT_TOKEN" },
        discord: { bot_token_env: "DISCORD_BOT_TOKEN" },
      } as Partial<NyxHiveConfig>),
      startTime: Date.now() - 1000,
      queue,
      connections: new ConnectionManager(),
      wsRouter: new MethodRouter(),
    });

    const trustCheck = report.checks.find((check) => check.id === "trust.posture");
    expect(trustCheck?.status).toBe("ok");
    expect(report.status).toBe("ok");
  });
});

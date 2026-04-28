import { describe, test, expect } from "bun:test";
import { resolveNotificationTarget, resolveNotificationTargets, type NotificationType } from "../notifications/routing.js";
import type { NyxHiveConfig } from "../types.js";

function makeConfig(overrides: Record<string, unknown> = {}): NyxHiveConfig {
  return {
    daemon: { name: "test", log_level: "info", data_dir: "/tmp" },
    server: { port: 3000, require_auth: false, request_timeout_ms: 120000 },
    agents: {},
    providers: {},
    routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
    context: { max_history: 200, summary_threshold: 20, history_budget_ratio: 0.5 },
    ...overrides,
  } as NyxHiveConfig;
}

describe("resolveNotificationTarget (backward compat)", () => {
  test("returns type-specific target when configured", () => {
    const config = makeConfig({
      notifications: {
        alerts: { channel: "discord", recipient: "alerts-channel-id" },
      },
    });
    const target = resolveNotificationTarget(config, "alerts");
    expect(target).toEqual({ channel: "discord", recipient: "alerts-channel-id" });
  });

  test("falls back to daemon.owner_channel/owner_id when type not configured", () => {
    const config = makeConfig({
      daemon: { name: "test", log_level: "info", data_dir: "/tmp", owner_channel: "telegram", owner_id: "jay" },
    });
    const target = resolveNotificationTarget(config, "alerts");
    expect(target).toEqual({ channel: "telegram", recipient: "jay" });
  });

  test("returns null when neither type-specific nor owner configured", () => {
    const config = makeConfig();
    const target = resolveNotificationTarget(config, "alerts");
    expect(target).toBeNull();
  });

  test("type-specific overrides owner fallback", () => {
    const config = makeConfig({
      daemon: { name: "test", log_level: "info", data_dir: "/tmp", owner_channel: "telegram", owner_id: "jay" },
      notifications: {
        proposals: { channel: "discord", recipient: "proposals-channel" },
      },
    });
    expect(resolveNotificationTarget(config, "proposals")).toEqual({ channel: "discord", recipient: "proposals-channel" });
    expect(resolveNotificationTarget(config, "alerts")).toEqual({ channel: "telegram", recipient: "jay" });
  });

  test("handles all notification types", () => {
    const config = makeConfig({
      notifications: {
        proposals: { channel: "discord", recipient: "p" },
        alerts: { channel: "discord", recipient: "a" },
        reports: { channel: "discord", recipient: "r" },
        activity: { channel: "discord", recipient: "x" },
      },
    });
    expect(resolveNotificationTarget(config, "proposals")!.recipient).toBe("p");
    expect(resolveNotificationTarget(config, "alerts")!.recipient).toBe("a");
    expect(resolveNotificationTarget(config, "reports")!.recipient).toBe("r");
    expect(resolveNotificationTarget(config, "activity")!.recipient).toBe("x");
  });
});

describe("resolveNotificationTargets (multi-channel)", () => {
  test("returns array from single-target config", () => {
    const config = makeConfig({
      notifications: {
        alerts: { channel: "discord", recipient: "123" },
      },
    });
    const targets = resolveNotificationTargets(config, "alerts");
    expect(targets).toEqual([{ channel: "discord", recipient: "123" }]);
  });

  test("returns array from array config", () => {
    const config = makeConfig({
      notifications: {
        alerts: [
          { channel: "discord", recipient: "123" },
          { channel: "telegram", recipient: "456" },
        ],
      },
    });
    const targets = resolveNotificationTargets(config, "alerts");
    expect(targets).toHaveLength(2);
    expect(targets[0]).toEqual({ channel: "discord", recipient: "123" });
    expect(targets[1]).toEqual({ channel: "telegram", recipient: "456" });
  });

  test("falls back to daemon owner as array", () => {
    const config = makeConfig({
      daemon: { name: "test", log_level: "info", data_dir: "/tmp", owner_channel: "telegram", owner_id: "jay" },
    });
    const targets = resolveNotificationTargets(config, "alerts");
    expect(targets).toEqual([{ channel: "telegram", recipient: "jay" }]);
  });

  test("returns empty array when nothing configured", () => {
    const config = makeConfig();
    const targets = resolveNotificationTargets(config, "alerts");
    expect(targets).toEqual([]);
  });

  test("backward compat returns first target from array", () => {
    const config = makeConfig({
      notifications: {
        alerts: [
          { channel: "discord", recipient: "123" },
          { channel: "telegram", recipient: "456" },
        ],
      },
    });
    const target = resolveNotificationTarget(config, "alerts");
    expect(target).toEqual({ channel: "discord", recipient: "123" });
  });

  test("supports trades notification type", () => {
    const config = makeConfig({
      notifications: {
        trades: [
          { channel: "discord", recipient: "trades-channel" },
          { channel: "telegram", recipient: "trades-group" },
        ],
      },
    });
    const targets = resolveNotificationTargets(config, "trades");
    expect(targets).toHaveLength(2);
  });
});

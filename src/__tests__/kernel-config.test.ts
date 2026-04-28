import { describe, expect, test } from "bun:test";
import { configSchema } from "../config-schema.js";
import { resolveKernelRuntimeMode } from "../kernel/runtime-mode.js";
import type { NyxHiveConfig } from "../types.js";

function makeValidConfig(overrides: Record<string, unknown> = {}) {
  return {
    daemon: {
      name: "test-daemon",
      data_dir: "/tmp/test",
    },
    server: {
      port: 3777,
    },
    agents: {
      nyx: {
        name: "Nyx",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        working_directory: "/tmp/workspace",
      },
    },
    providers: {
      anthropic: {
        api_key_env: "ANTHROPIC_API_KEY",
      },
    },
    routing: {
      classifier_model: "deepseek/deepseek-v3.2",
      classifier_provider: "openrouter",
      cli_escalation_tasks: ["coding", "code_review"],
    },
    context: {},
    ...overrides,
  };
}

describe("kernel runtime config", () => {
  test("defaults to legacy runtime mode when unset", () => {
    const result = configSchema.safeParse(makeValidConfig());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(resolveKernelRuntimeMode(result.data)).toBe("legacy");
    }
  });

  test("accepts kernel runtime mode from config", () => {
    const result = configSchema.safeParse(makeValidConfig({ runtime: { mode: "kernel" } }));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime?.mode).toBe("kernel");
      expect(resolveKernelRuntimeMode(result.data)).toBe("kernel");
    }
  });

  test("environment override wins over config", () => {
    expect(resolveKernelRuntimeMode(
      { runtime: { mode: "legacy" } } as NyxHiveConfig,
      { NYXHIVE_RUNTIME_MODE: "kernel" },
    )).toBe("kernel");
  });
});

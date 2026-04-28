import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NyxHiveConfig } from "../types.js";
import {
  hasAnthropicAgentSdkRuntime,
  resolveClaudeConfigDir,
  resolveAnthropicBootstrapMethod,
} from "../framework/anthropic-auth-policy.js";

function makeConfig(overrides: Partial<NyxHiveConfig> = {}): NyxHiveConfig {
  return {
    daemon: {
      name: "Test",
      log_level: "info",
      data_dir: "/tmp/nyxhive-test",
      claude_config_dir: "/tmp/.claude",
      ...(overrides.daemon ?? {}),
    },
    server: {
      port: 4000,
      ...(overrides.server ?? {}),
    },
    agents: {
      nyx: {
        name: "Nyx",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        working_directory: ".",
        capabilities: ["tool_use"],
      },
      ...(overrides.agents ?? {}),
    },
    providers: {
      anthropic: {
        api_key_env: "ANTHROPIC_API_KEY",
      },
      ...(overrides.providers ?? {}),
    },
    routing: {
      classifier_model: "deepseek/deepseek-v3.2",
      classifier_provider: "openrouter",
      cli_escalation_tasks: ["coding"],
      ...(overrides.routing ?? {}),
    },
    context: {
      max_history: 50,
      summary_threshold: 20,
      ...(overrides.context ?? {}),
    },
    ...(overrides as Omit<NyxHiveConfig, "daemon" | "server" | "agents" | "providers" | "routing" | "context">),
  };
}

describe("anthropic auth policy", () => {
  test("always returns false — agent_sdk runtime has been removed", () => {
    expect(hasAnthropicAgentSdkRuntime(makeConfig().agents)).toBe(false);

    expect(hasAnthropicAgentSdkRuntime(makeConfig({
      agents: {
        nyx: {
          name: "Nyx",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: ".",
          capabilities: ["tool_use"],
        },
      },
    }).agents)).toBe(false);
  });

  test("prefers explicit auth token over API key and keychain fallback", () => {
    const config = makeConfig();
    const method = resolveAnthropicBootstrapMethod(config, {
      ANTHROPIC_API_KEY: "api-key",
      ANTHROPIC_AUTH_TOKEN: "auth-token",
    });
    expect(method).toBe("auth_token");
  });

  test("uses auth token before CLI keychain fallback when no API key is set", () => {
    const config = makeConfig();
    const method = resolveAnthropicBootstrapMethod(config, {
      ANTHROPIC_AUTH_TOKEN: "auth-token",
    });
    expect(method).toBe("auth_token");
  });

  test("allows keychain fallback for Anthropic CLI instances", () => {
    const config = makeConfig({
      agents: {
        nyx: {
          name: "Nyx",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: ".",
          capabilities: ["tool_use"],
        },
      },
    });
    const method = resolveAnthropicBootstrapMethod(config, {});
    expect(method).toBe("keychain");
  });

  test("infers the isolated Claude profile from the instance name", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "nyxhive-auth-"));
    const profileDir = join(homeDir, ".claude-profiles", "test");
    mkdirSync(profileDir, { recursive: true });

    try {
      const config = makeConfig({
        daemon: {
          name: "Test",
          log_level: "info",
          data_dir: "/tmp/nyxhive-test",
          claude_config_dir: undefined,
        },
        agents: {
          nyx: {
            name: "Nyx",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            working_directory: ".",
            capabilities: ["tool_use"],
          },
        },
      });

      expect(resolveClaudeConfigDir(config, {}, { homeDir })).toBe(profileDir);
      expect(resolveAnthropicBootstrapMethod(config, {}, { homeDir })).toBe("keychain");
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test("falls back to keychain when claude_config_dir is set and no API key or auth token", () => {
    const config = makeConfig();
    // With agent_sdk removed, all agents are CLI — keychain is available if claude_config_dir resolves
    // Without a resolvable config dir, falls back to "none"
    expect(resolveAnthropicBootstrapMethod(config, {})).toBe("keychain");
  });
});

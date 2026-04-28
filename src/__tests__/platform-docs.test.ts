import { describe, it, expect } from "bun:test";
import { generateWorkspaceDocs, generatePlatformContext } from "../agents/platform-docs.js";
import type { NyxHiveConfig, AgentConfig } from "../types.js";
import type { AgentRegistry } from "../agents/registry.js";

// --- Helpers ---

function minimalConfig(overrides: Partial<NyxHiveConfig> = {}): NyxHiveConfig {
  return {
    daemon: { name: "TestHive", log_level: "info", data_dir: "/tmp/test" },
    server: { port: 3000 },
    agents: {},
    providers: {},
    routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
    context: { max_history: 10, summary_threshold: 5 },
    ...overrides,
  } as NyxHiveConfig;
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "TestAgent",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    working_directory: "/tmp/workspace",
    ...overrides,
  };
}

function stubRegistry(agents: Record<string, AgentConfig & { role?: string }>): AgentRegistry {
  const entries = new Map<string, any>();
  for (const [key, agent] of Object.entries(agents)) {
    entries.set(key, {
      ...agent,
      enabled: true,
      role: agent.role ?? "worker",
      created_by: "config",
      created_at: Date.now(),
      updated_at: Date.now(),
      total_invocations: 0,
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_failures: 0,
      estimated_cost_cents: 0,
      last_invoked_at: null,
      delegation_expected: 0,
      delegation_actual: 0,
    });
  }

  return {
    get(key: string) {
      const entry = entries.get(key);
      if (!entry || !entry.enabled) return undefined;
      return entry as AgentConfig;
    },
    getAll() {
      const result: Record<string, AgentConfig> = {};
      for (const [key, entry] of entries) {
        if (entry.enabled) result[key] = entry;
      }
      return result;
    },
    getEntry(key: string) {
      return entries.get(key);
    },
    getAllEntries(includeDisabled = false) {
      return new Map(entries);
    },
    getStatsSummary() {
      return { agents: [], totalCostCents: 0, idleAgents: [], topConsumers: [] };
    },
  } as unknown as AgentRegistry;
}

// --- generateWorkspaceDocs ---

describe("generateWorkspaceDocs", () => {
  it("returns minimal docs for unknown agent (no registry, not in config)", () => {
    const config = minimalConfig();
    const result = generateWorkspaceDocs(config, "ghost");

    expect(result).toContain("You are **ghost**");
    expect(result).toContain("NyxHive self-improving personal runtime");
    // Should be short — no full platform docs
    expect(result.length).toBeLessThan(200);
  });

  it("renders platform name from config", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("# TestHive Platform");
    expect(result).toContain("running on **TestHive**");
  });

  it("renders agent configuration section", () => {
    const config = minimalConfig({
      agents: {
        nyx: makeAgent({
          name: "Nyx",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: "/dev/nyxhive",
          cli_fallback: "claude-haiku-4-5-20251001",
        }),
      },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("**Agent key:** nyx");
    expect(result).toContain("**Provider:** anthropic");
    expect(result).toContain("**Model:** claude-sonnet-4-6");
    expect(result).toContain("**Workspace:** /dev/nyxhive");
    expect(result).toContain("**CLI fallback:** claude-haiku-4-5-20251001");
  });

  it("omits CLI fallback line when not configured", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).not.toContain("CLI fallback");
  });

  it("renders agent roster from config when no registry", () => {
    const config = minimalConfig({
      agents: {
        nyx: makeAgent({ name: "Nyx", provider: "anthropic", model: "claude-sonnet-4-6" }),
        analyst: makeAgent({ name: "Analyst", provider: "openrouter", model: "deepseek/deepseek-v3.2", capabilities: ["research", "analysis"] }),
      },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("**Nyx** (`@nyx`)");
    expect(result).toContain("**Analyst** (`@analyst`)");
    expect(result).toContain("[research, analysis]");
  });

  it("renders agent roster from registry when provided", () => {
    const config = minimalConfig();
    const registry = stubRegistry({
      nyx: makeAgent({ name: "Nyx", provider: "anthropic", model: "claude-sonnet-4-6" }),
      tester: makeAgent({ name: "Tester", provider: "anthropic", model: "claude-haiku-4-5-20251001" }),
    });
    const result = generateWorkspaceDocs(config, "nyx", registry);

    expect(result).toContain("**Nyx** (`@nyx`)");
    expect(result).toContain("**Tester** (`@tester`)");
  });

  it("includes delegation section when multiple agents exist", () => {
    const config = minimalConfig({
      agents: {
        nyx: makeAgent({ name: "Nyx" }),
        analyst: makeAgent({ name: "Analyst" }),
      },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("Delegation (Actor Model)");
    expect(result).toContain("[@agent_key: task description]");
  });

  it("omits delegation section for single-agent config", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).not.toContain("Delegation (Actor Model)");
  });

  it("renders team structure", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      teams: {
        research: {
          name: "Research Team",
          agents: ["analyst", "data"],
          description: "Handles all research tasks",
        },
      },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("## Teams");
    expect(result).toContain("**Research Team** (`@research`)");
    expect(result).toContain("analyst → data");
    expect(result).toContain("Handles all research tasks");
  });

  it("omits teams section when no teams defined", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).not.toContain("## Teams");
  });

  it("shows HTTP API only when no channels configured", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("**HTTP API**");
  });

  it("includes Telegram channel when configured", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      telegram: { bot_token_env: "TG_TOKEN" },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("**Telegram**");
    expect(result).toContain("**HTTP API**");
    expect(result).toContain("`/crawl <url>`");
  });

  it("documents live Discord routing when Discord is configured", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      discord: {
        bot_token_env: "DISCORD_BOT_TOKEN",
        require_mention: true,
        privileged_user_ids: ["000000000000000000"],
      },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("**Discord**");
    expect(result).toContain("Discord is already configured for this workspace");
    expect(result).toContain("Private Discord DMs and explicitly listened private/guild channels are addressed automatically");
    expect(result).toContain("Privileged harness access is allowlisted to: `000000000000000000`");
  });

  it("tells agents to verify live evidence before trusting vault notes for current-state answers", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      vault: { path: "/my/vault" },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("Before answering current-state questions");
    expect(result).toContain("Verify live evidence first when feasible");
    expect(result).toContain("use vault notes as context or historical reference");
  });

  it("documents Slack slash-command parity including /cancel", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      slack: { bot_token_env: "SLACK_BOT_TOKEN", app_token_env: "SLACK_APP_TOKEN" },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("**Slack**");
    expect(result).toContain("available in Telegram/Discord/Slack");
    expect(result).toContain("`/cancel`");
  });

  it("includes Discord channel when configured", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      discord: { bot_token_env: "DISCORD_TOKEN" },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("**Discord**");
  });

  it("includes both Telegram and Discord channels", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      telegram: { bot_token_env: "TG_TOKEN" },
      discord: { bot_token_env: "DISCORD_TOKEN" },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("**Telegram**");
    expect(result).toContain("**Discord**");
    expect(result).toContain("**HTTP API**");
  });

  it("renders vault section with path when configured", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      vault: { path: "/home/user/dev/obsidian/ExampleVault" },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("**Vault path:** `/home/user/dev/obsidian/ExampleVault`");
    expect(result).toContain("full read/write access");
  });

  it("renders generic vault section when no vault configured", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("Obsidian vault ingestion");
    expect(result).not.toContain("Vault path:");
  });

  it("renders pairing enabled status", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      pairing: { enabled: true },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("**Enabled**");
    expect(result).toContain("nyxhive pairing approve");
  });

  it("renders pairing disabled status", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      pairing: { enabled: false },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("Disabled");
  });

  it("includes server port in API section", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      server: { port: 8080 },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).toContain("port **8080**");
  });

  it("does not leak API keys or token env var names in workspace docs", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      server: { port: 3000, api_key: "fake-secret-key" },
      telegram: { bot_token_env: "TG_BOT_TOKEN" },
      discord: { bot_token_env: "DISCORD_BOT_TOKEN" },
      providers: {
        anthropic: { api_key_env: "ANTHROPIC_API_KEY" },
      },
    });
    const result = generateWorkspaceDocs(config, "nyx");

    expect(result).not.toContain("fake-secret-key");
    expect(result).not.toContain("ANTHROPIC_API_KEY");
    // bot_token_env names should not appear in the output
    expect(result).not.toContain("TG_BOT_TOKEN");
    expect(result).not.toContain("DISCORD_BOT_TOKEN");
  });

  it("renders agent capabilities in roster", () => {
    const config = minimalConfig({
      agents: {
        researcher: makeAgent({
          name: "Researcher",
          capabilities: ["web_search", "brave_api"],
          cli_fallback: "claude-haiku-4-5-20251001",
        }),
      },
    });
    const result = generateWorkspaceDocs(config, "researcher");

    expect(result).toContain("[web_search, brave_api]");
    expect(result).toContain("(CLI: claude-haiku-4-5-20251001)");
  });

  it("does not include orchestrator context for non-orchestrator agent", () => {
    const registry = stubRegistry({
      nyx: { ...makeAgent({ name: "Nyx" }), role: "lead" } as any,
      analyst: { ...makeAgent({ name: "Analyst" }), role: "worker" } as any,
    });
    const config = minimalConfig();
    const result = generateWorkspaceDocs(config, "analyst", registry);

    expect(result).not.toContain("Agent Management");
    expect(result).not.toContain("Delegation Policy");
    expect(result).not.toContain("[@hire:");
  });

  it("includes lead operating context for lead role agent", () => {
    const registry = stubRegistry({
      nyx: { ...makeAgent({ name: "Nyx" }), role: "lead" } as any,
      analyst: { ...makeAgent({ name: "Analyst" }), role: "worker" } as any,
    });
    const config = minimalConfig();
    const result = generateWorkspaceDocs(config, "nyx", registry);

    expect(result).toContain("## Agent Management");
    expect(result).toContain("[@hire:");
    expect(result).toContain("[@fire:");
    expect(result).toContain("## Delegation Policy");
    expect(result).toContain("## Current Team");
    expect(result).toContain("## Scheduling");
    expect(result).toContain("## Alerts");
    expect(result).toContain("## Budget");
    expect(result).toContain("Own the conversation and final call");
  });
});

// --- generatePlatformContext ---

describe("generatePlatformContext", () => {
  it("returns minimal context for unknown agent", () => {
    const config = minimalConfig();
    const result = generatePlatformContext(config, "ghost");

    expect(result).toContain("[Platform: TestHive");
    expect(result).toContain("self-improving personal runtime");
    expect(result).toContain("You are ghost");
    expect(result).toContain("NyxHive");
  });

  it("includes agent name, provider, model", () => {
    const config = minimalConfig({
      agents: {
        nyx: makeAgent({ name: "Nyx", provider: "anthropic", model: "claude-sonnet-4-6" }),
      },
    });
    const result = generatePlatformContext(config, "nyx");

    expect(result).toContain("You are Nyx");
    expect(result).toContain("anthropic/claude-sonnet-4-6");
    expect(result).toContain("running on TestHive");
  });

  it("lists channels", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      telegram: { bot_token_env: "TG" },
    });
    const result = generatePlatformContext(config, "nyx");

    expect(result).toContain("[Channels: HTTP API, Telegram]");
  });

  it("shows HTTP API when no channels configured", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
    });
    const result = generatePlatformContext(config, "nyx");

    expect(result).toContain("[Channels: HTTP API]");
  });

  it("lists other agents with capabilities", () => {
    const config = minimalConfig({
      agents: {
        nyx: makeAgent({ name: "Nyx" }),
        analyst: makeAgent({ name: "Analyst", capabilities: ["research"] }),
        tester: makeAgent({ name: "Tester" }),
      },
    });
    const result = generatePlatformContext(config, "nyx");

    expect(result).toContain("[Other agents: Analyst (@analyst) [research], Tester (@tester)]");
  });

  it("includes delegation hint when multiple agents", () => {
    const config = minimalConfig({
      agents: {
        nyx: makeAgent({ name: "Nyx" }),
        analyst: makeAgent({ name: "Analyst" }),
      },
    });
    const result = generatePlatformContext(config, "nyx");

    expect(result).toContain("[Delegation: use [@agent_key: task]");
    expect(result).toContain("adds leverage");
  });

  it("omits other agents and delegation for single agent", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
    });
    const result = generatePlatformContext(config, "nyx");

    expect(result).not.toContain("[Other agents:");
    expect(result).not.toContain("[Delegation:");
  });

  it("includes vault path when configured", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      vault: { path: "/my/vault" },
    });
    const result = generatePlatformContext(config, "nyx");

    expect(result).toContain("[Obsidian vault: /my/vault");
  });

  it("omits vault line when no vault", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
    });
    const result = generatePlatformContext(config, "nyx");

    expect(result).not.toContain("Obsidian vault");
  });

  it("uses registry agents when provided", () => {
    const config = minimalConfig();
    const registry = stubRegistry({
      nyx: makeAgent({ name: "Nyx" }),
      scout: makeAgent({ name: "Scout", capabilities: ["discovery"] }),
    });
    const result = generatePlatformContext(config, "nyx", registry);

    expect(result).toContain("Scout (@scout) [discovery]");
  });

  it("does not leak sensitive config in platform context", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
      server: { port: 3000, api_key: "super-secret" },
      providers: { anthropic: { api_key_env: "ANTHROPIC_KEY" } },
    });
    const result = generatePlatformContext(config, "nyx");

    expect(result).not.toContain("super-secret");
    expect(result).not.toContain("ANTHROPIC_KEY");
    expect(result).not.toContain("api_key");
  });

  it("always ends with platform features reminder", () => {
    const config = minimalConfig({
      agents: { nyx: makeAgent({ name: "Nyx" }) },
    });
    const result = generatePlatformContext(config, "nyx");

    expect(result).toContain("refer to NyxHive's built-in capabilities");
  });
});

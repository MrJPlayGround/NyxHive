import { describe, test, expect, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, realpathSync } from "fs";
import { join } from "path";
import { configSchema, simpleConfigSchema } from "../config-schema.js";
import { loadConfig, resolveEnvKey, resolveConfigPath } from "../config.js";

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

describe("configSchema", () => {
  describe("valid configs", () => {
    test("accepts minimal valid config", () => {
      const result = configSchema.safeParse(makeValidConfig());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.daemon.workflow_mode).toBe("direct");
      }
    });

    test("accepts minimal simple config", () => {
      const result = simpleConfigSchema.safeParse({
        name: "Simple",
        port: 3777,
        purpose: "companion",
        provider: {
          name: "anthropic",
          auth_mode: "api_key",
          api_key_env: "ANTHROPIC_API_KEY",
          model: "claude-sonnet-4-6",
        },
      });
      expect(result.success).toBe(true);
    });

    test("accepts fully populated config with all optional sections", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          server: {
            port: 3777,
            public_url: "https://nyx.example.com/core",
          },
          teams: {
            dev: { name: "Dev Team", agents: ["forge", "tester"] },
          },
          telegram: { bot_token_env: "TELEGRAM_BOT_TOKEN" },
          discord: { bot_token_env: "DISCORD_BOT_TOKEN" },
          vault: { path: "/tmp/vault", skip_dirs: [".git", "node_modules"] },
          pairing: { enabled: true },
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.server.public_url).toBe("https://nyx.example.com/core");
      }
    });

    test("accepts ollama provider config with url and model", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          providers: {
            anthropic: { api_key_env: "ANTHROPIC_API_KEY" },
            ollama: { url: "http://localhost:11434", model: "llama3.2:3b" },
          },
          routing: {
            classifier_model: "llama3.2:3b",
            classifier_provider: "ollama",
            cli_escalation_tasks: ["coding"],
          },
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.providers.ollama?.url).toBe("http://localhost:11434");
        expect(result.data.providers.ollama?.model).toBe("llama3.2:3b");
      }
    });

    test("accepts top-level allowed_directories", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          allowed_directories: ["/home/user/dev/obsidian/ExampleVault", "/home/user/dev/obsidian/SharedMemory"],
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed_directories).toEqual([
          "/home/user/dev/obsidian/ExampleVault",
          "/home/user/dev/obsidian/SharedMemory",
        ]);
      }
    });

    test("accepts config without allowed_directories (optional)", () => {
      const result = configSchema.safeParse(makeValidConfig());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.allowed_directories).toBeUndefined();
      }
    });

    test("accepts Agents SDK orchestration flag defaulting off", () => {
      const defaultResult = configSchema.safeParse(makeValidConfig({ orchestration: {} }));
      expect(defaultResult.success).toBe(true);
      if (defaultResult.success) {
        expect(defaultResult.data.orchestration?.agents_sdk).toBeUndefined();
      }

      const enabledResult = configSchema.safeParse(
        makeValidConfig({
          orchestration: {
            agents_sdk: { enabled: true },
          },
        }),
      );
      expect(enabledResult.success).toBe(true);
      if (enabledResult.success) {
        expect(enabledResult.data.orchestration?.agents_sdk?.enabled).toBe(true);
      }
    });

    test("accepts remotes configuration", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          remotes: {
            trading: {
              url: "https://trading.example.com",
              api_key_env: "TRADING_API_KEY",
              description: "Trading journal",
              agents: ["forge", "analyst"],
            },
          },
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.remotes?.trading.url).toBe("https://trading.example.com");
        expect(result.data.remotes?.trading.agents).toEqual(["forge", "analyst"]);
      }
    });

    test("remotes with minimal fields (url + api_key_env only)", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          remotes: {
            remote: {
              url: "https://remote.example.com",
              api_key_env: "REMOTE_KEY",
            },
          },
        }),
      );
      expect(result.success).toBe(true);
    });

    test("rejects remotes with invalid url", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          remotes: {
            bad: {
              url: "not-a-url",
              api_key_env: "KEY",
            },
          },
        }),
      );
      expect(result.success).toBe(false);
    });

    test("accepts agents with all optional fields", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          agents: {
            forge: {
              name: "Forge",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              min_model: "claude-sonnet-4-6",
              always_cli: true,
              cli_fallback: "claude",
              working_directory: "/tmp/forge",
              system_prompt: "You are Forge.",
              capabilities: ["code", "review"],
            },
          },
        }),
      );
      expect(result.success).toBe(true);
    });

    test("accepts crawl configuration with sources", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          crawl: {
            enabled: true,
            default_depth: 3,
            default_page_limit: 75,
            timeout_ms: 120000,
            sources: [{
              name: "bun-docs",
              url: "https://bun.sh/docs",
              schedule: "0 3 * * 0",
              depth: 2,
              page_limit: 50,
              path_glob: "/docs/**",
              scope: "reference",
              enabled: true,
            }],
          },
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.crawl?.sources?.[0]?.scope).toBe("reference");
      }
    });

    test("accepts scheduler task_profile values", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          scheduler: {
            task_profile: "monitor",
          },
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scheduler?.task_profile).toBe("monitor");
      }
    });

    test("preserves scheduler task execution controls", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          scheduler: {
            tasks: [{
              name: "heartbeat:presence",
              cron: "17 */3 * * *",
              agent: "nyx",
              prompt: "Run presence heartbeat",
              timeout_ms: 900000,
              authority_profile: "scheduled",
            }],
          },
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scheduler?.tasks?.[0]?.timeout_ms).toBe(900000);
        expect(result.data.scheduler?.tasks?.[0]?.authority_profile).toBe("scheduled");
      }
    });
  });

  describe("scheduler task profiles", () => {
    test("rejects invalid task_profile values", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          scheduler: {
            task_profile: "everything",
          },
        }),
      );
      expect(result.success).toBe(false);
    });

    test("keeps backwards compatibility for seed_defaults=true without task_profile", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          scheduler: {
            seed_defaults: true,
          },
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scheduler?.seed_defaults).toBe(true);
        expect(result.data.scheduler?.task_profile).toBeUndefined();
      }
    });

    test("keeps backwards compatibility for seed_defaults=false without task_profile", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          scheduler: {
            seed_defaults: false,
          },
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.scheduler?.seed_defaults).toBe(false);
        expect(result.data.scheduler?.task_profile).toBeUndefined();
      }
    });
  });

  describe("defaults", () => {
    test("log_level defaults to info", () => {
      const result = configSchema.safeParse(makeValidConfig());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.daemon.log_level).toBe("info");
      }
    });

    test("max_history defaults to 200", () => {
      const result = configSchema.safeParse(makeValidConfig());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.context.max_history).toBe(200);
      }
    });

    test("summary_threshold defaults to 20", () => {
      const result = configSchema.safeParse(makeValidConfig());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.context.summary_threshold).toBe(20);
      }
    });

    test("summary_max_tokens defaults to 1500", () => {
      const result = configSchema.safeParse(makeValidConfig());
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.context.summary_max_tokens).toBe(1500);
      }
    });

    test("pairing.enabled defaults to false", () => {
      const result = configSchema.safeParse(makeValidConfig({ pairing: {} }));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.pairing?.enabled).toBe(false);
      }
    });

    test("explicit values override defaults", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          daemon: { name: "test", log_level: "debug", data_dir: "/tmp/test" },
          context: { max_history: 25, summary_threshold: 50, summary_max_tokens: 900 },
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.daemon.log_level).toBe("debug");
        expect(result.data.context.max_history).toBe(25);
        expect(result.data.context.summary_threshold).toBe(50);
        expect(result.data.context.summary_max_tokens).toBe(900);
      }
    });

    test("crawl defaults are applied when section is present", () => {
      const result = configSchema.safeParse(
        makeValidConfig({
          crawl: {
            sources: [{
              name: "docs",
              url: "https://example.com/docs",
              schedule: "0 3 * * 0",
            }],
          },
        }),
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.crawl?.enabled).toBe(false);
        expect(result.data.crawl?.default_depth).toBe(2);
        expect(result.data.crawl?.default_page_limit).toBe(50);
        expect(result.data.crawl?.sources?.[0]?.scope).toBe("general");
        expect(result.data.crawl?.sources?.[0]?.enabled).toBe(true);
      }
    });
  });

  describe("invalid configs", () => {
    test("fails when daemon section is missing", () => {
      const config = makeValidConfig();
      delete (config as any).daemon;
      expect(configSchema.safeParse(config).success).toBe(false);
    });

    test("fails when server section is missing", () => {
      const config = makeValidConfig();
      delete (config as any).server;
      expect(configSchema.safeParse(config).success).toBe(false);
    });

    test("fails when agents section is missing", () => {
      const config = makeValidConfig();
      delete (config as any).agents;
      expect(configSchema.safeParse(config).success).toBe(false);
    });

    test("fails when providers section is missing", () => {
      const config = makeValidConfig();
      delete (config as any).providers;
      expect(configSchema.safeParse(config).success).toBe(false);
    });

    test("fails when routing section is missing", () => {
      const config = makeValidConfig();
      delete (config as any).routing;
      expect(configSchema.safeParse(config).success).toBe(false);
    });

    test("fails when port is a string", () => {
      expect(
        configSchema.safeParse(makeValidConfig({ server: { port: "3777" } })).success,
      ).toBe(false);
    });

    test("fails when log_level is invalid enum", () => {
      expect(
        configSchema.safeParse(
          makeValidConfig({ daemon: { name: "test", log_level: "verbose", data_dir: "/tmp" } }),
        ).success,
      ).toBe(false);
    });

    test("fails when daemon.name is missing", () => {
      expect(
        configSchema.safeParse(makeValidConfig({ daemon: { data_dir: "/tmp" } })).success,
      ).toBe(false);
    });

    test("fails when crawl source url is invalid", () => {
      expect(
        configSchema.safeParse(
          makeValidConfig({
            crawl: {
              enabled: true,
              sources: [{
                name: "bad-docs",
                url: "not-a-url",
                schedule: "0 3 * * 0",
              }],
            },
          }),
        ).success,
      ).toBe(false);
    });

    test("fails when agent missing required fields", () => {
      expect(
        configSchema.safeParse(makeValidConfig({ agents: { nyx: { name: "Nyx" } } })).success,
      ).toBe(false);
    });

    test("fails when cli_escalation_tasks is a string", () => {
      expect(
        configSchema.safeParse(
          makeValidConfig({
            routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: "coding" },
          }),
        ).success,
      ).toBe(false);
    });
  });

  describe("Symbol stripping", () => {
    test("JSON roundtrip strips Symbol metadata from TOML-like objects", () => {
      const obj = makeValidConfig();
      (obj as any)[Symbol("type")] = "object";
      (obj as any)[Symbol("declared")] = true;
      (obj.daemon as any)[Symbol("type")] = "object";

      const stripped = JSON.parse(JSON.stringify(obj));
      const result = configSchema.safeParse(stripped);
      expect(result.success).toBe(true);
    });

    test("stripped config round-trips correctly", () => {
      const obj = makeValidConfig();
      (obj as any)[Symbol("type")] = "object";
      const stripped = JSON.parse(JSON.stringify(obj));
      const result = configSchema.safeParse(stripped);
      expect(result.success).toBe(true);
    });
  });
});

describe("resolveEnvKey", () => {
  const testKey = "NYXHIVE_TEST_ENV_KEY";

  afterEach(() => {
    delete process.env[testKey];
  });

  test("returns value when env var is set", () => {
    process.env[testKey] = "test-value";
    expect(resolveEnvKey(testKey)).toBe("test-value");
  });

  test("throws when env var is not set", () => {
    expect(() => resolveEnvKey(testKey)).toThrow(
      `Required environment variable ${testKey} is not set`,
    );
  });

  test("throws when env var is empty string", () => {
    process.env[testKey] = "";
    expect(() => resolveEnvKey(testKey)).toThrow(
      `Required environment variable ${testKey} is not set`,
    );
  });

  test("returns values with special characters", () => {
    process.env[testKey] = "sk-abc123!@#$%^&*()";
    expect(resolveEnvKey(testKey)).toBe("sk-abc123!@#$%^&*()");
  });
});

describe("resolveConfigPath", () => {
  const TEST_DIR = "/tmp/nyxhive-config-resolve-test";

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("returns .nyxhive/config.toml when it exists in cwd", () => {
    const nyxhiveDir = join(TEST_DIR, ".nyxhive");
    mkdirSync(nyxhiveDir, { recursive: true });
    writeFileSync(join(nyxhiveDir, "config.toml"), "");

    const origCwd = process.cwd();
    process.chdir(TEST_DIR);
    try {
      const result = resolveConfigPath();
      const realDir = realpathSync(TEST_DIR);
      expect(result).toBe(join(realDir, ".nyxhive", "config.toml"));
    } finally {
      process.chdir(origCwd);
    }
  });
});

describe("loadConfig", () => {
  const TEST_DIR = "/tmp/nyxhive-config-paths";

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("defaults data_dir to ~/.nyxhive/data/{name}/ when not specified", async () => {
    const { homedir } = await import("os");
    const instanceDir = join(TEST_DIR, "no-data-dir");
    mkdirSync(instanceDir, { recursive: true });

    writeFileSync(join(instanceDir, "config.toml"), `
[daemon]
name = "TestInstance"

[server]
port = 3777
public_url = "https://nyx.example.com/core"

[agents.nyx]
name = "Nyx"
provider = "anthropic"
model = "claude-sonnet-4-6"
working_directory = "/tmp/workspace"

[providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"

[routing]
classifier_model = "deepseek/deepseek-v3.2"
classifier_provider = "openrouter"
cli_escalation_tasks = ["coding"]

[context]
`);

    const config = loadConfig(join(instanceDir, "config.toml"));
    expect(config.daemon.data_dir).toBe(join(homedir(), ".nyxhive", "data", "testinstance"));
  });

  test("resolves instance-relative paths from config.toml", () => {
    const instanceDir = join(TEST_DIR, "instance");
    mkdirSync(instanceDir, { recursive: true });

    writeFileSync(join(instanceDir, "config.toml"), `
[daemon]
name = "TestInstance"
data_dir = "./data"
claude_config_dir = "./.claude"

[server]
port = 3777
public_url = "https://nyx.example.com/core"

[agents.nyx]
name = "Nyx"
provider = "anthropic"
model = "claude-sonnet-4-6"
working_directory = "./workspace/nyx"
allowed_directories = ["./repo", "../shared"]

[providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"

[routing]
classifier_model = "deepseek/deepseek-v3.2"
classifier_provider = "openrouter"
cli_escalation_tasks = ["coding"]

[context]

[vault]
path = "./vault"

[models]
cost_rates_file = "./config/costs.json"

[imessage]
db_path = "./data/chat.db"

[[daemon.projects]]
name = "App"
repo_path = "./apps/main"
default = true
`);

    const config = loadConfig(join(instanceDir, "config.toml"));

    expect(config.daemon.data_dir).toBe(join(instanceDir, "data"));
    expect(config.daemon.claude_config_dir).toBe(join(instanceDir, ".claude"));
    expect(config.agents.nyx.working_directory).toBe("./workspace/nyx");
    expect(config.agents.nyx.allowed_directories).toEqual([
      "./repo",
      "../shared",
    ]);
    expect(config.server.public_url).toBe("https://nyx.example.com/core");
    expect(config.vault?.path).toBe(join(instanceDir, "vault"));
    expect(config.models?.cost_rates_file).toBe(join(instanceDir, "config/costs.json"));
    expect(config.imessage?.db_path).toBe(join(instanceDir, "data/chat.db"));
    expect(config.daemon.projects?.[0]?.repo_path).toBe(join(instanceDir, "apps/main"));
  });

  test("normalizes legacy Obsidian paths to /home/user/dev/obsidian", () => {
    const instanceDir = join(TEST_DIR, "legacy-obsidian");
    mkdirSync(instanceDir, { recursive: true });

    writeFileSync(join(instanceDir, "config.toml"), `
allowed_directories = ["/Volumes/ExampleDrive/Obsidian/ExampleVault", "/home/user/Obsidian/SharedMemory"]

[daemon]
name = "TestInstance"

[server]
port = 3777

[agents.nyx]
name = "Nyx"
provider = "anthropic"
model = "claude-sonnet-4-6"
working_directory = "./workspace/nyx"

[providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"

[routing]
classifier_model = "deepseek/deepseek-v3.2"
classifier_provider = "openrouter"
cli_escalation_tasks = ["coding"]

[context]

[vault]
path = "/Volumes/ExampleDrive/Obsidian/ExampleVault"
`);

    const config = loadConfig(join(instanceDir, "config.toml"));

    expect(config.allowed_directories).toEqual([
      "/home/user/dev/obsidian/ExampleVault",
      "/home/user/dev/obsidian/SharedMemory",
    ]);
    expect(config.vault?.path).toBe("/home/user/dev/obsidian/ExampleVault");
  });

  test("synthesizes a default agent from simple config mode", () => {
    const instanceDir = join(TEST_DIR, "simple");
    mkdirSync(instanceDir, { recursive: true });

    writeFileSync(join(instanceDir, "config.toml"), `
name = "Companion"
port = 3788
preset = "companion"

[provider]
name = "anthropic"
api_key_env = "ANTHROPIC_API_KEY"
model = "claude-sonnet-4-6"

[telegram]
bot_token_env = "TELEGRAM_BOT_TOKEN"
`);

    const config = loadConfig(join(instanceDir, "config.toml"));

    expect(config.daemon.name).toBe("Companion");
    expect(config.daemon.primary_agent).toBe("assistant");
    expect(config.daemon.data_dir).toBe(join(instanceDir, "data"));
    expect(config.server.port).toBe(3788);
    expect(config.server.api_key_env).toBe("NYX_API_KEY");
    expect(config.agents.assistant?.name).toBe("Companion");
    expect(config.agents.assistant?.role).toBe("orchestrator");
    expect(config.agents.assistant?.provider).toBe("anthropic");
    expect(config.agents.assistant?.always_cli).toBe(true);
    expect(config.agents.assistant?.soul).toBe("preset:companion");
    expect(config.providers.anthropic?.api_key_env).toBe("ANTHROPIC_API_KEY");
    expect(config.routing.classifier_provider).toBe("anthropic");
    expect(config.routing.classifier_model).toBe("claude-sonnet-4-6");
    expect(config.telegram?.bot_token_env).toBe("TELEGRAM_BOT_TOKEN");
  });

  test("supports simple config without a preset and defaults the agent role to lead", () => {
    const instanceDir = join(TEST_DIR, "simple-no-preset");
    mkdirSync(instanceDir, { recursive: true });

    writeFileSync(join(instanceDir, "config.toml"), `
name = "Blank"
port = 3791

[provider]
name = "openrouter"
api_key_env = "OPENROUTER_API_KEY"
model = "google/gemini-2.5-flash"
`);

    const config = loadConfig(join(instanceDir, "config.toml"));

    expect(config.agents.assistant?.role).toBe("lead");
    expect(config.agents.assistant?.soul).toBeUndefined();
    expect(config.routing.classifier_provider).toBe("openrouter");
  });

  test("simple config with anthropic api_key auth does not force Claude CLI mode", () => {
    const instanceDir = join(TEST_DIR, "simple-anthropic-api");
    mkdirSync(instanceDir, { recursive: true });

    writeFileSync(join(instanceDir, "config.toml"), `
name = "ApiMode"
port = 3792
purpose = "coding"

[provider]
name = "anthropic"
auth_mode = "api_key"
api_key_env = "ANTHROPIC_API_KEY"
model = "claude-sonnet-4-6"
`);

    const config = loadConfig(join(instanceDir, "config.toml"));

    expect(config.agents.assistant?.provider).toBe("anthropic");
    expect(config.agents.assistant?.always_cli).toBeUndefined();
    expect(config.agents.assistant?.cli_fallback).toBeUndefined();
    expect(config.providers.anthropic?.auth_mode).toBe("api_key");
  });
});

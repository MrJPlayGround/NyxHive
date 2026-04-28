import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import TOML from "@iarna/toml";
import { logger } from "./utils/logger.js";
import { configSchema, simpleConfigSchema } from "./config-schema.js";
import { DEFAULT_CLI_ESCALATION_TASKS, DEFAULT_LOCAL_CLASSIFIER_MODEL } from "./defaults.js";
import { loadPresetSoul, normalizePresetName } from "./presets.js";
import { composeSystemPrompt } from "./soul/compiler.js";
import type { AgentConfig, NyxHiveConfig } from "./types.js";
import { normalizeObsidianPath } from "./utils/obsidian-paths.js";

const SIMPLE_PRIMARY_AGENT = "assistant";
const SIMPLE_DATA_DIR = "./data";

export function resolveConfigPath(): string {
  const cwd = process.cwd();
  const args = process.argv;
  const idx = args.indexOf("--config");
  if (idx !== -1 && args[idx + 1]) {
    return resolve(cwd, args[idx + 1]);
  }
  // .nyxhive/config.toml (workspace-centric)
  const nyxhivePath = resolve(cwd, ".nyxhive", "config.toml");
  if (existsSync(nyxhivePath)) return nyxhivePath;

  const flatPath = resolve(cwd, "config.toml");
  if (existsSync(flatPath)) {
    return flatPath;
  }
  return resolve(cwd, "config", "nyxhive.toml");
}

function resolveFromInstanceDir(instanceDir: string, pathValue?: string): string | undefined {
  if (!pathValue) return undefined;
  return isAbsolute(pathValue) ? pathValue : resolve(instanceDir, pathValue);
}

function resolvePathList(instanceDir: string, values?: string[]): string[] | undefined {
  if (!values) return undefined;
  return values.map((value) => normalizeObsidianPath(resolveFromInstanceDir(instanceDir, value))!);
}

function normalizeConfigPaths(config: NyxHiveConfig, configPath: string): NyxHiveConfig {
  const instanceDir = dirname(configPath);

  return {
    ...config,
    daemon: {
      ...config.daemon,
      data_dir: resolveFromInstanceDir(instanceDir, config.daemon.data_dir ?? join(homedir(), ".nyxhive", "data", "default"))!,
      claude_config_dir: resolveFromInstanceDir(instanceDir, config.daemon.claude_config_dir),
      codex_home: resolveFromInstanceDir(instanceDir, config.daemon.codex_home),
      projects: config.daemon.projects?.map((project) => ({
        ...project,
        repo_path: resolveFromInstanceDir(instanceDir, project.repo_path)!,
      })),
    },
    agents: Object.fromEntries(
      Object.entries(config.agents).map(([key, agent]) => [key, agent]),
    ),
    allowed_directories: resolvePathList(instanceDir, config.allowed_directories),
    models: config.models
      ? {
          ...config.models,
          cost_rates_file: resolveFromInstanceDir(instanceDir, config.models.cost_rates_file),
          tiers_file: resolveFromInstanceDir(instanceDir, config.models.tiers_file),
        }
      : undefined,
    imessage: config.imessage
      ? {
          ...config.imessage,
          db_path: resolveFromInstanceDir(instanceDir, config.imessage.db_path),
        }
      : undefined,
    vault: config.vault
      ? {
          ...config.vault,
          path: normalizeObsidianPath(resolveFromInstanceDir(instanceDir, config.vault.path))!,
        }
      : undefined,
  };
}

function emitFederationWarnings(config: NyxHiveConfig): void {
  const hasRemotes = Object.keys(config.remotes ?? {}).length > 0;
  if (!hasRemotes) return;

  if (!config.server.public_url?.trim()) {
    logger.warn("[config] remotes are configured but server.public_url is unset; remote MCP discovery and reverse relay will advertise localhost.");
  }

  for (const [key, agent] of Object.entries(config.agents)) {
    if (isAbsolute(agent.working_directory)) {
      logger.warn(`[config] agents.${key}.working_directory is absolute (${agent.working_directory}); prefer an instance-relative path for portable multi-machine deploys.`);
    }
  }

  if (config.vault?.path) {
    logger.info(`[config] vault.path is instance-local: ${config.vault.path}`);
  }
}

type SimpleConfigInput = ReturnType<typeof simpleConfigSchema.parse>;

export function isSimpleConfigShape(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const record = parsed as Record<string, unknown>;
  return !record.agents && typeof record.name === "string" && typeof record.port === "number" && !!record.provider;
}

function defaultApiKeyEnvForProvider(provider: string): string | undefined {
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    default:
      return undefined;
  }
}

function defaultModelForProvider(provider: string, authMode?: string): string {
  switch (provider) {
    case "anthropic":
      return "claude-sonnet-4-6";
    case "openai":
      return authMode === "codex" ? "gpt-5.5" : "gpt-5-mini";
    case "openrouter":
      return "google/gemini-2.5-flash";
    case "ollama":
      return DEFAULT_LOCAL_CLASSIFIER_MODEL;
    default:
      return "claude-sonnet-4-6";
  }
}

export function synthesizeSimpleConfig(input: SimpleConfigInput): NyxHiveConfig {
  const presetName = normalizePresetName(input.preset);
  const presetSoul = presetName ? loadPresetSoul(presetName) : undefined;
  const providerName = input.provider.name;
  const model = input.provider.model ?? defaultModelForProvider(providerName, input.provider.auth_mode);
  const providerConfig = {
    ...(input.provider.api_key_env || defaultApiKeyEnvForProvider(providerName)
      ? { api_key_env: input.provider.api_key_env ?? defaultApiKeyEnvForProvider(providerName) }
      : {}),
    ...(input.provider.auth_mode ? { auth_mode: input.provider.auth_mode } : {}),
    ...(input.provider.runtime ? { runtime: input.provider.runtime } : {}),
    ...(input.provider.fallback ? { fallback: input.provider.fallback } : {}),
    ...(input.provider.url ? { url: input.provider.url } : {}),
    ...(model ? { model } : {}),
  };
  const primaryAgent: AgentConfig = {
    name: input.name,
    role: (presetSoul?.identity.role as AgentConfig["role"] | undefined) ?? "lead",
    provider: providerName,
    model,
    working_directory: "./workspace/assistant",
    ...(presetSoul ? { system_prompt: composeSystemPrompt(presetSoul, input.name) } : {}),
    ...(presetSoul ? { soul: `preset:${presetName}` } : {}),
    ...(presetSoul?.capabilities.max_tool_turns ? { max_tool_turns: presetSoul.capabilities.max_tool_turns } : {}),
    ...(presetSoul?.capabilities.disallowed_tools?.length ? { disallowed_tools: presetSoul.capabilities.disallowed_tools } : {}),
    ...(presetSoul?.capabilities.mcp_tools?.length ? { mcp_tools: presetSoul.capabilities.mcp_tools } : {}),
    ...(presetSoul?.capabilities.context_strategy ? { context_strategy: presetSoul.capabilities.context_strategy } : {}),
    ...(presetSoul?.model_capabilities.min_model ? { min_model: presetSoul.model_capabilities.min_model } : {}),
    ...(presetSoul?.model_capabilities.max_model ? { max_model: presetSoul.model_capabilities.max_model } : {}),
    ...(presetSoul && (presetSoul.capabilities.can_run_commands || presetSoul.capabilities.can_write_files || presetSoul.capabilities.can_read_files)
      ? { capabilities: ["tool_use"] }
      : {}),
    ...(presetName === "companion" ? { companion_mode: true } : {}),
    ...(providerName === "anthropic" && input.provider.auth_mode !== "api_key"
      ? { always_cli: true, cli_fallback: "claude" as const }
      : input.provider.auth_mode === "codex"
        ? { always_cli: true, cli_fallback: "codex" as const, agentic_mode: "strict" as const }
        : {}),
  };

  return {
    daemon: {
      name: input.name,
      log_level: "info",
      data_dir: SIMPLE_DATA_DIR,
      primary_agent: SIMPLE_PRIMARY_AGENT,
    },
    server: {
      port: input.port,
      api_key_env: "NYX_API_KEY",
      require_auth: true,
      request_timeout_ms: 120000,
    },
    agents: {
      [SIMPLE_PRIMARY_AGENT]: primaryAgent,
    },
    providers: {
      [providerName]: providerConfig,
    },
    routing: {
      classifier_model: model,
      classifier_provider: providerName,
      cli_escalation_tasks: [...DEFAULT_CLI_ESCALATION_TASKS],
    },
    context: {
      max_history: 200,
      summary_threshold: 20,
      summary_max_tokens: 1500,
      history_budget_ratio: 0.5,
    },
    scheduler: input.scheduler
      ? {
          enabled: input.scheduler.enabled,
          ...(input.scheduler.notify_channels ? { notify_channels: input.scheduler.notify_channels } : {}),
        }
      : { enabled: true },
    pairing: input.pairing ?? { enabled: false },
    sandbox: input.sandbox ?? { backend: "none" },
    ...(input.telegram ? { telegram: input.telegram } : {}),
    ...(input.discord ? { discord: input.discord } : {}),
    ...(input.slack ? { slack: { ...input.slack, auto_thread: true, interactive_replies: false, mode: "socket", webhook_path: "/slack/events", streaming: { enabled: false, update_interval_ms: 500, max_preview_chars: 4000 }, chunk_limit: 3000 } } : {}),
    ...(input.imessage ? { imessage: input.imessage } : {}),
    ...(input.vault ? { vault: { ...input.vault, watch: true, generate_canvas: true } } : {}),
    ...(input.allowed_directories ? { allowed_directories: input.allowed_directories } : {}),
  };
}

export function loadConfig(configPath?: string): NyxHiveConfig {
  const path = configPath ?? resolveConfigPath();

  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }

  const raw = readFileSync(path, "utf-8");
  // JSON roundtrip strips Symbol(type)/Symbol(declared) metadata from @iarna/toml
  // which Zod v4 rejects as invalid record keys
  const parsed = JSON.parse(JSON.stringify(TOML.parse(raw)));
  const normalizedInput = (() => {
    if (!isSimpleConfigShape(parsed)) return parsed;

    const simple = simpleConfigSchema.safeParse(parsed);
    if (!simple.success) {
      logger.error("[config] Simple config validation failed:");
      for (const issue of simple.error.issues) {
        logger.error(`  ${issue.path.map(String).join(".")}: ${issue.message}`);
      }
      process.exit(1);
    }

    const presetName = normalizePresetName(simple.data.preset) ?? "none";
    logger.info(`[config] Simple mode detected (preset=${presetName}, provider=${simple.data.provider.name})`);
    return synthesizeSimpleConfig(simple.data);
  })();

  const result = configSchema.safeParse(normalizedInput);
  if (!result.success) {
    logger.error("[config] Validation failed:");
    for (const issue of result.error.issues) {
      logger.error(`  ${issue.path.map(String).join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  const data = result.data as NyxHiveConfig;
  if (!data.daemon.data_dir) {
    const name = (data.daemon.name ?? "default").toLowerCase().replace(/[^a-z0-9]+/g, "_");
    data.daemon.data_dir = join(homedir(), ".nyxhive", "data", name);
  }
  const config = normalizeConfigPaths(data, path);
  emitFederationWarnings(config);
  logger.info(`[config] Loaded from ${path}`);
  return config;
}

export function resolveEnvKey(envName: string): string {
  const value = process.env[envName];
  if (!value) {
    throw new Error(`Required environment variable ${envName} is not set`);
  }
  return value;
}

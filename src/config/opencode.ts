import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { logger } from "../utils/logger.js";
import type { NyxHiveConfig } from "../types.js";

// Canonical OpenRouter models — add new ones here when providers expand.
const OPENROUTER_MODELS: Record<string, string> = {
  "deepseek/deepseek-v3.2": "DeepSeek V3.2",
  "xiaomi/mimo-v2-flash": "MiMo v2 Flash",
  "mistralai/mistral-medium-3": "Mistral Medium 3",
  "qwen/qwen3-235b-a22b-2507": "Qwen3 235B",
  "meta-llama/llama-4-maverick": "Llama 4 Maverick",
};

// Providers that are built into OpenCode and don't need npm/baseURL config.
// We only register their models so OpenCode can resolve agent model IDs.
const BUILTIN_PROVIDERS = new Set<string>();

// Providers that are NOT routed through OpenCode (they use their own CLI/SDK).
const EXCLUDED_PROVIDERS = new Set(["anthropic", "openai", "ollama"]);

interface OpenCodeProviderConfig {
  npm?: string;
  name?: string;
  options?: { baseURL: string };
  models: Record<string, { name: string }>;
}

interface OpenCodeConfig {
  $schema: string;
  provider: Record<string, OpenCodeProviderConfig>;
}

/**
 * Generate the OpenCode config JSON from NyxHive's provider configuration.
 * Writes to ~/.nyxhive/instances/{name}/opencode.json.
 *
 * Registers models for providers that are actually intended to run through OpenCode.
 * Built-in OpenCode providers only get model entries.
 * Custom providers (e.g., openrouter) get full npm/baseURL config.
 */
export function generateOpenCodeConfig(config: NyxHiveConfig): string | null {
  // Collect models per provider from agent configs
  const providerModels = new Map<string, Set<string>>();
  for (const agent of Object.values(config.agents)) {
    if (EXCLUDED_PROVIDERS.has(agent.provider)) continue;
    if (!providerModels.has(agent.provider)) {
      providerModels.set(agent.provider, new Set());
    }
    providerModels.get(agent.provider)!.add(agent.model);
  }

  // Nothing to generate if no OpenCode-routed agents
  if (providerModels.size === 0) {
    logger.info("[opencode] No OpenCode-routed agents configured, skipping OpenCode config");
    return null;
  }

  const providers: Record<string, OpenCodeProviderConfig> = {};

  // OpenRouter: full custom provider config + canonical model list
  if (config.providers.openrouter || providerModels.has("openrouter")) {
    const models: Record<string, { name: string }> = {};
    for (const [id, name] of Object.entries(OPENROUTER_MODELS)) {
      models[id] = { name };
    }
    for (const model of providerModels.get("openrouter") ?? []) {
      if (!models[model]) {
        models[model] = { name: model.split("/").pop() ?? model };
      }
    }
    providers.openrouter = {
      npm: "@ai-sdk/openai-compatible",
      name: "OpenRouter",
      options: { baseURL: "https://openrouter.ai/api/v1" },
      models,
    };
  }

  // Built-in providers (minimax, etc.): only register models
  for (const [provider, modelSet] of providerModels) {
    if (provider === "openrouter" || EXCLUDED_PROVIDERS.has(provider)) continue;
    const models: Record<string, { name: string }> = {};
    for (const model of modelSet) {
      models[model] = { name: model };
    }
    if (BUILTIN_PROVIDERS.has(provider)) {
      // Built-in: just models, OpenCode already knows the provider details
      providers[provider] = { models };
    } else {
      // Unknown provider: register with models, user may need to add npm/options
      logger.warn(`[opencode] Provider "${provider}" is not built-in — models registered but may need manual npm/baseURL config`);
      providers[provider] = { models };
    }
  }

  const openCodeConfig: OpenCodeConfig = {
    $schema: "https://opencode.ai/config.json",
    provider: providers,
  };

  // Write to data_dir alongside other instance files
  const configPath = join(config.daemon.data_dir, "opencode.json");
  try {
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const totalModels = Object.values(providers).reduce((sum, p) => sum + Object.keys(p.models).length, 0);
    writeFileSync(configPath, JSON.stringify(openCodeConfig, null, 2), { mode: 0o600 });
    logger.info(`[opencode] Config written to ${configPath} (${Object.keys(providers).length} providers, ${totalModels} models)`);
    return configPath;
  } catch (err) {
    logger.warn(`[opencode] Failed to write config to ${configPath}: ${err}`);
    return null;
  }
}

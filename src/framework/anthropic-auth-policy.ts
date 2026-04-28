import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentConfig, NyxHiveConfig } from "../types.js";

export type AnthropicBootstrapMethod = "api_key" | "auth_token" | "keychain" | "none";
interface ClaudeConfigResolutionOptions {
  homeDir?: string;
  pathExists?: (path: string) => boolean;
}

/** Agent SDK has been removed — all agents use CLI. Always returns false. */
export function hasAnthropicAgentSdkRuntime(_agents: Record<string, AgentConfig>): boolean {
  return false;
}

function normalizeProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function resolveClaudeConfigDir(
  config: Pick<NyxHiveConfig, "daemon">,
  env: Record<string, string | undefined>,
  options: ClaudeConfigResolutionOptions = {},
): string | undefined {
  if (config.daemon.claude_config_dir?.trim()) return config.daemon.claude_config_dir;
  if (env.CLAUDE_CONFIG_DIR?.trim()) return env.CLAUDE_CONFIG_DIR;

  const profileName = normalizeProfileName(config.daemon.name);
  if (!profileName) return undefined;

  const homeDir = options.homeDir ?? homedir();
  const pathExists = options.pathExists ?? existsSync;
  const instanceProfileDir = join(homeDir, ".claude-profiles", profileName);

  return pathExists(instanceProfileDir) ? instanceProfileDir : undefined;
}

export function resolveAnthropicBootstrapMethod(
  config: Pick<NyxHiveConfig, "agents" | "providers" | "daemon">,
  env: Record<string, string | undefined>,
  options: ClaudeConfigResolutionOptions = {},
): AnthropicBootstrapMethod {
  const authToken = env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN;
  if (authToken) return "auth_token";

  const anthropicConfig = config.providers.anthropic;
  const apiKey = anthropicConfig?.api_key_env ? env[anthropicConfig.api_key_env] : undefined;
  if (apiKey) return "api_key";

  if (resolveClaudeConfigDir(config, env, options) && !hasAnthropicAgentSdkRuntime(config.agents)) {
    return "keychain";
  }

  return "none";
}

export function buildAnthropicBootstrapWarning(
  config: Pick<NyxHiveConfig, "agents" | "providers" | "daemon">,
  env: Record<string, string | undefined>,
  options: ClaudeConfigResolutionOptions = {},
): string {
  const hasAgentSdkRuntime = hasAnthropicAgentSdkRuntime(config.agents);
  const claudeConfigDir = resolveClaudeConfigDir(config, env, options);
  if (
    hasAgentSdkRuntime
    && claudeConfigDir
    && !(env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN)
    && !(config.providers.anthropic?.api_key_env && env[config.providers.anthropic.api_key_env])
  ) {
    return "Anthropic not available: an Anthropic agent is using the SDK runtime, so bootstrap needs an API key or ANTHROPIC_AUTH_TOKEN";
  }
  return "Anthropic not available: no API key, auth token, or Claude login fallback";
}

/**
 * Runtime model override management.
 * Extracted from QueueProcessor to isolate override state and validation.
 */

import { logger } from "../utils/logger.js";
import { resolveModelAlias } from "./model-utils.js";
import { MODEL_TIERS } from "../defaults.js";
import type { AgentConfig } from "../types.js";

/** Infer the correct provider + CLI backend for a given model. */
export function inferProviderForModel(model: string): { provider: string; cli_fallback?: string } | null {
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) return { provider: "openai", cli_fallback: "codex" };
  if (model.startsWith("claude-")) return { provider: "anthropic", cli_fallback: "claude" };
  if (model.startsWith("deepseek/") || model.startsWith("google/") || model.startsWith("MiniMax-") || model.startsWith("meta-llama/") ||
      model.startsWith("qwen/") || model.startsWith("xiaomi/") || model.startsWith("mistralai/")) {
    return { provider: "openrouter" };
  }
  return null;
}

export class ModelOverrideManager {
  private overrides: Map<string, { model: string; provider?: string; cli_fallback?: string; setAt: number }> = new Map();

  set(senderId: string, agentKey: string, model: string, _getAgent: (key: string) => AgentConfig | undefined): string | null {
    const resolved = resolveModelAlias(model);
    const key = `${senderId}:${agentKey}`;

    // Auto-detect provider from model prefix — full swap, not just model
    const inferred = inferProviderForModel(resolved);
    this.overrides.set(key, {
      model: resolved,
      provider: inferred?.provider,
      cli_fallback: inferred?.cli_fallback,
      setAt: Date.now(),
    });

    const providerNote = inferred ? ` (provider: ${inferred.provider})` : "";
    logger.info(`[processor] Model override: ${key} → ${resolved}${providerNote}`);

    // Validate the resolved model is known
    if (!(resolved in MODEL_TIERS)) {
      const warning = `Unknown model: ${resolved}. This may fail if not supported by the agent's provider. Known models: ${Object.keys(MODEL_TIERS).join(", ")}`;
      logger.warn(`[processor] ${warning}`);
      return warning;
    }

    return null;
  }

  clear(senderId: string, agentKey: string): void {
    this.overrides.delete(`${senderId}:${agentKey}`);
    logger.info(`[processor] Model override cleared for ${senderId}:${agentKey}`);
  }

  clearAll(senderId: string): void {
    for (const key of this.overrides.keys()) {
      if (key.startsWith(`${senderId}:`)) {
        this.overrides.delete(key);
      }
    }
    logger.info(`[processor] All model overrides cleared for ${senderId}`);
  }

  get(senderId: string, agentKey: string): string | undefined {
    return this.overrides.get(`${senderId}:${agentKey}`)?.model;
  }

  getProvider(senderId: string, agentKey: string): string | undefined {
    return this.overrides.get(`${senderId}:${agentKey}`)?.provider;
  }

  has(key: string): boolean {
    return this.overrides.has(key);
  }

  getEffective(senderId: string, agentKey: string, getAgent: (key: string) => AgentConfig | undefined): string {
    const override = this.overrides.get(`${senderId}:${agentKey}`)?.model;
    if (override) return override;
    const agent = getAgent(agentKey);
    if (!agent) return "unknown";
    // Pinned model (min === max) is the agent's true default, not the routing base
    if (agent.min_model && agent.min_model === agent.max_model) return agent.min_model;
    return agent.model;
  }

  /** Get the agent's natural default model, accounting for min/max pin. */
  getNaturalDefault(agentKey: string, getAgent: (key: string) => AgentConfig | undefined): string {
    const agent = getAgent(agentKey);
    if (!agent) return "unknown";
    if (agent.min_model && agent.min_model === agent.max_model) return agent.min_model;
    return agent.model;
  }

  /** Apply override to agent config if one exists. Returns the (possibly modified) config.
   *  Full swap: model + provider + cli_fallback all change together. */
  applyOverride(senderId: string, agentKey: string, agentConfig: AgentConfig): AgentConfig {
    const key = `${senderId}:${agentKey}`;
    const override = this.overrides.get(key);
    if (!override) return agentConfig;

    const patched: AgentConfig = { ...agentConfig, model: override.model };
    if (override.provider) patched.provider = override.provider;
    if (override.cli_fallback) patched.cli_fallback = override.cli_fallback;
    return patched;
  }

  /** Expire overrides older than the given TTL (ms). */
  expireOlderThan(ttlMs: number): void {
    const now = Date.now();
    for (const [k, v] of this.overrides) {
      if (now - v.setAt > ttlMs) {
        this.overrides.delete(k);
      }
    }
  }

  /** Direct access to the underlying Map (for delegation context). */
  getRawMap(): Map<string, { model: string; provider?: string; cli_fallback?: string; setAt: number }> {
    return this.overrides;
  }
}

import { describe, test, expect, beforeEach } from "bun:test";
import { ModelOverrideManager, inferProviderForModel } from "../queue/model-overrides.js";
import type { AgentConfig } from "../types.js";

const stubAgent: AgentConfig = {
  name: "Nyx",
  model: "claude-sonnet-4-6",
  provider: "anthropic",
  role: "lead",
  working_directory: "/tmp",
};

const getAgent = (key: string): AgentConfig | undefined =>
  key === "nyx" ? stubAgent : undefined;

describe("ModelOverrideManager", () => {
  let mgr: ModelOverrideManager;

  beforeEach(() => {
    mgr = new ModelOverrideManager();
  });

  // 1. set() stores override and get() retrieves it
  test("set stores override and get retrieves it", () => {
    mgr.set("user1", "nyx", "claude-sonnet-4-6", getAgent);
    expect(mgr.get("user1", "nyx")).toBe("claude-sonnet-4-6");
  });

  // 2. set() with unknown model returns warning
  test("set with unknown model returns warning", () => {
    const warning = mgr.set("user1", "nyx", "totally-fake-model-9000", getAgent);
    expect(warning).not.toBeNull();
    expect(warning).toContain("Unknown model");
    expect(warning).toContain("totally-fake-model-9000");
    // Override should still be stored
    expect(mgr.get("user1", "nyx")).toBe("totally-fake-model-9000");
  });

  // 3. set() with incompatible provider returns warning
  test("set with claude model on non-anthropic agent auto-swaps provider", () => {
    const openrouterAgent: AgentConfig = {
      name: "Analyst",
      model: "deepseek/deepseek-v3.2",
      provider: "openrouter",
      role: "worker",
      working_directory: "/tmp",
    };
    const getAgentOR = (key: string): AgentConfig | undefined =>
      key === "analyst" ? openrouterAgent : undefined;

    const warning = mgr.set("user1", "analyst", "claude-sonnet-4-6", getAgentOR);
    expect(warning).toBeNull(); // no warning — provider auto-swaps
    // Verify the override includes provider swap
    const applied = mgr.applyOverride("user1", "analyst", openrouterAgent);
    expect(applied.model).toBe("claude-sonnet-4-6");
    expect(applied.provider).toBe("anthropic");
    expect(applied.cli_fallback).toBe("claude");
  });

  test("set with google model on anthropic agent auto-swaps provider", () => {
    const warning = mgr.set("user1", "nyx", "deepseek/deepseek-v3.2", getAgent);
    expect(warning).toBeNull(); // no warning — provider auto-swaps
    const applied = mgr.applyOverride("user1", "nyx", stubAgent);
    expect(applied.model).toBe("deepseek/deepseek-v3.2");
    expect(applied.provider).toBe("openrouter");
  });

  test("set with codex alias swaps to openai", () => {
    const warning = mgr.set("user1", "nyx", "codex", getAgent);
    expect(warning).toBeNull();
    const applied = mgr.applyOverride("user1", "nyx", stubAgent);
    expect(applied.model).toBe("gpt-5.5");
    expect(applied.provider).toBe("openai");
    expect(applied.cli_fallback).toBe("codex");
  });

  test("set with anthropic alias resolves to sonnet", () => {
    const openaiAgent: AgentConfig = {
      name: "Strider",
      model: "gpt-5.5",
      provider: "openai",
      role: "orchestrator",
      working_directory: "/tmp",
    };
    const getOpenAIAgent = (key: string): AgentConfig | undefined =>
      key === "strider" ? openaiAgent : undefined;

    const warning = mgr.set("user1", "strider", "anthropic", getOpenAIAgent);
    expect(warning).toBeNull();
    const applied = mgr.applyOverride("user1", "strider", openaiAgent);
    expect(applied.model).toBe("claude-sonnet-4-6");
    expect(applied.provider).toBe("anthropic");
    expect(applied.cli_fallback).toBe("claude");
  });

  // 4. clear() removes specific override
  test("clear removes specific override", () => {
    mgr.set("user1", "nyx", "claude-opus-4-6", getAgent);
    mgr.set("user1", "analyst", "claude-opus-4-6", getAgent);
    mgr.clear("user1", "nyx");
    expect(mgr.get("user1", "nyx")).toBeUndefined();
    expect(mgr.get("user1", "analyst")).toBe("claude-opus-4-6");
  });

  // 5. clearAll() removes all overrides for a sender
  test("clearAll removes all overrides for a sender", () => {
    mgr.set("user1", "nyx", "claude-opus-4-6", getAgent);
    mgr.set("user1", "analyst", "claude-opus-4-6", getAgent);
    mgr.set("user2", "nyx", "claude-opus-4-6", getAgent);
    mgr.clearAll("user1");
    expect(mgr.get("user1", "nyx")).toBeUndefined();
    expect(mgr.get("user1", "analyst")).toBeUndefined();
    expect(mgr.get("user2", "nyx")).toBe("claude-opus-4-6");
  });

  // 6. getEffective() returns override when set, falls back to agent model
  test("getEffective returns override when set", () => {
    mgr.set("user1", "nyx", "claude-opus-4-6", getAgent);
    expect(mgr.getEffective("user1", "nyx", getAgent)).toBe("claude-opus-4-6");
  });

  test("getEffective falls back to agent config model", () => {
    expect(mgr.getEffective("user1", "nyx", getAgent)).toBe("claude-sonnet-4-6");
  });

  test("getEffective returns 'unknown' for unknown agent with no override", () => {
    expect(mgr.getEffective("user1", "nonexistent", getAgent)).toBe("unknown");
  });

  // 7. applyOverride() returns modified config with override model
  test("applyOverride returns modified config with override model", () => {
    mgr.set("user1", "nyx", "claude-opus-4-6", getAgent);
    const result = mgr.applyOverride("user1", "nyx", stubAgent);
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.name).toBe("Nyx"); // rest of config preserved
    expect(result.provider).toBe("anthropic");
  });

  // 8. applyOverride() returns original config when no override
  test("applyOverride returns original config when no override", () => {
    const result = mgr.applyOverride("user1", "nyx", stubAgent);
    expect(result).toBe(stubAgent); // same reference, not a copy
  });

  // 9. expireOlderThan() removes old overrides, keeps recent ones
  test("expireOlderThan removes old overrides and keeps recent ones", () => {
    mgr.set("user1", "nyx", "claude-opus-4-6", getAgent);

    // Manually inject an old override via the raw map
    const rawMap = mgr.getRawMap();
    rawMap.set("user2:nyx", { model: "claude-opus-4-6", setAt: Date.now() - 120_000 });

    mgr.expireOlderThan(60_000); // 60s TTL

    // user1's override was just set, should survive
    expect(mgr.get("user1", "nyx")).toBe("claude-opus-4-6");
    // user2's override is 120s old, should be expired
    expect(mgr.has("user2:nyx")).toBe(false);
  });

  // 10. has() returns correct boolean
  test("has returns true for existing key", () => {
    mgr.set("user1", "nyx", "claude-opus-4-6", getAgent);
    expect(mgr.has("user1:nyx")).toBe(true);
  });

  test("has returns false for non-existing key", () => {
    expect(mgr.has("user1:nyx")).toBe(false);
  });

  // set() with known + compatible model returns null (no warning)
  test("set with known compatible model returns null", () => {
    const warning = mgr.set("user1", "nyx", "claude-opus-4-6", getAgent);
    expect(warning).toBeNull();
  });
});

describe("inferProviderForModel", () => {
  test("maps OpenAI models to openai + codex", () => {
    expect(inferProviderForModel("gpt-5.5")).toEqual({ provider: "openai", cli_fallback: "codex" });
  });

  test("maps Anthropic models to anthropic + claude", () => {
    expect(inferProviderForModel("claude-sonnet-4-6")).toEqual({ provider: "anthropic", cli_fallback: "claude" });
  });

  test("maps DeepSeek models to openrouter", () => {
    expect(inferProviderForModel("deepseek/deepseek-v3.2")).toEqual({ provider: "openrouter" });
  });

  test("maps Google models to openrouter", () => {
    expect(inferProviderForModel("google/gemini-2.5-pro")).toEqual({ provider: "openrouter" });
  });
});

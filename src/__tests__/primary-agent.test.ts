import { describe, expect, it } from "bun:test";
import { applyMainBrainOverride, resolveMainBrain, resolvePrimaryAgentKey, buildDualBrainConfig, isSingleBrainMode } from "../agents/primary.js";
import type { AgentConfig } from "../types.js";

const agents: Record<string, AgentConfig> = {
  nyx: {
    name: "Nyx",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    role: "lead",
    always_cli: true,
    cli_fallback: "claude",
    working_directory: "/tmp/nyx",
  },
  analyst: {
    name: "Analyst",
    provider: "openrouter",
    model: "deepseek/deepseek-v3.2",
    role: "worker",
    working_directory: "/tmp/analyst",
  },
  tester: {
    name: "Tester",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    role: "worker",
    always_cli: true,
    cli_fallback: "claude",
    working_directory: "/tmp/tester",
  },
};

describe("primary agent resolution", () => {
  it("uses config primary_agent when set", () => {
    expect(resolvePrimaryAgentKey(agents, { primary_agent: "nyx" })).toBe("nyx");
  });

  it("falls back to the first lead when no override is set", () => {
    expect(resolvePrimaryAgentKey(agents)).toBe("nyx");
  });
});

describe("main brain resolution", () => {
  it("resolves anthropic aliases", () => {
    expect(resolveMainBrain("claude")).toBe("anthropic");
  });

  it("returns undefined for unrecognized aliases", () => {
    expect(resolveMainBrain("gpt")).toBeUndefined();
    expect(resolveMainBrain("codex")).toBeUndefined();
    expect(resolveMainBrain("openai")).toBeUndefined();
  });

  it("resolves opus as anthropic", () => {
    expect(resolveMainBrain("opus")).toBe("anthropic");
  });

  it("returns undefined for codex-only (unrecognized base)", () => {
    expect(resolveMainBrain("codex-only")).toBeUndefined();
  });

  it("resolves opus-only as anthropic (single brain)", () => {
    expect(resolveMainBrain("opus-only")).toBe("anthropic");
  });

  it("detects single-brain mode from -only suffix", () => {
    expect(isSingleBrainMode("opus-only")).toBe(true);
    expect(isSingleBrainMode("anthropic-only")).toBe(true);
    expect(isSingleBrainMode("opus")).toBe(false);
    expect(isSingleBrainMode("anthropic")).toBe(false);
    expect(isSingleBrainMode(undefined)).toBe(false);
  });
});

describe("buildDualBrainConfig", () => {
  it("builds coding=sonnet, conversation=opus when primary is anthropic", () => {
    const config = buildDualBrainConfig("anthropic");
    expect(config).not.toBeUndefined();
    expect(config!.primary).toBe("anthropic");
    expect(config!.coding.provider).toBe("anthropic");
    expect(config!.coding.model).toBe("claude-sonnet-4-6");
    expect(config!.coding.cli_fallback).toBe("claude");
    expect(config!.conversation.provider).toBe("anthropic");
    expect(config!.conversation.model).toBe("claude-opus-4-6");
    expect(config!.conversation.cli_fallback).toBe("claude");
  });

  it("returns undefined when no brain is set", () => {
    expect(buildDualBrainConfig(undefined)).toBeUndefined();
  });
});

describe("applyMainBrainOverride", () => {
  it("applies anthropic brain to primary agent", () => {
    const result = applyMainBrainOverride(agents, { primary_agent: "nyx" }, "anthropic");
    expect(result.primaryAgent).toBe("nyx");
    expect(result.agents.nyx.name).toBe("Nyx");
    expect(result.agents.nyx.provider).toBe("anthropic");
    expect(result.agents.nyx.model).toBe("claude-sonnet-4-6");
    expect(result.agents.nyx.cli_fallback).toBe("claude");
    expect(result.agents.nyx.always_cli).toBe(true);
    expect(result.affectedAgents).toEqual(["nyx"]);
  });

  it("returns dualBrain config in dual-brain mode (--brain anthropic)", () => {
    const result = applyMainBrainOverride(agents, { primary_agent: "nyx" }, "anthropic");
    expect(result.dualBrain).toBeDefined();
    expect(result.dualBrain!.primary).toBe("anthropic");
    expect(result.dualBrain!.coding.provider).toBe("anthropic");
    expect(result.dualBrain!.coding.model).toBe("claude-sonnet-4-6");
    expect(result.dualBrain!.conversation.provider).toBe("anthropic");
    expect(result.dualBrain!.conversation.model).toBe("claude-opus-4-6");
  });

  it("falls back to NYXHIVE_MAIN_BRAIN when no explicit brain is provided", () => {
    const result = applyMainBrainOverride(
      agents,
      { primary_agent: "nyx" },
      undefined,
      { NYXHIVE_MAIN_BRAIN: "anthropic" },
    );
    expect(result.mainBrain).toBe("anthropic");
    expect(result.agents.nyx.provider).toBe("anthropic");
    expect(result.dualBrain).toBeDefined();
  });

  it("returns no dualBrain config in single-brain mode (--brain opus-only)", () => {
    const result = applyMainBrainOverride(agents, { primary_agent: "nyx" }, "opus-only");
    expect(result.dualBrain).toBeUndefined();
    // Single brain still applies anthropic settings to primary agent
    expect(result.agents.nyx.provider).toBe("anthropic");
    expect(result.agents.nyx.model).toBe("claude-sonnet-4-6");
  });

  it("returns agents unchanged when brain is unrecognized", () => {
    const result = applyMainBrainOverride(agents, { primary_agent: "nyx" }, "codex");
    // codex no longer resolves — mainBrain is undefined, no override applied
    expect(result.mainBrain).toBeUndefined();
    expect(result.agents.nyx.provider).toBe("anthropic");
    expect(result.agents.nyx.model).toBe("claude-sonnet-4-6");
    expect(result.dualBrain).toBeUndefined();
  });
});

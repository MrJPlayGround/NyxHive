import { describe, expect, it } from "bun:test";
import { applySenderRolePolicy } from "../security/sender-role-policy.js";

const baseAgent = {
  name: "Morph",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  always_cli: true,
  cli_fallback: "claude",
  working_directory: "/tmp/morph",
  capabilities: ["tool_use"],
  role: "lead" as const,
};

const codexAgent = {
  ...baseAgent,
  name: "Nyx",
  provider: "openai",
  model: "gpt-5.5",
  cli_fallback: "codex",
  agentic_mode: "strict" as const,
};

describe("applySenderRolePolicy", () => {
  it("leaves operator access unchanged", () => {
    const result = applySenderRolePolicy(baseAgent, "operator");
    expect(result).toBe(baseAgent);
  });

  it("downgrades engineer access to SDK read-only analysis", () => {
    const result = applySenderRolePolicy(baseAgent, "engineer");
    expect(result).not.toBe(baseAgent);
    expect(result.always_cli).toBe(false);
    expect(result.cli_fallback).toBeUndefined();
    expect(result.capabilities).toEqual(["tool_use"]);
    expect(result.role).toBe("expert");
  });

  it("removes tool access for viewer/support roles", () => {
    const viewer = applySenderRolePolicy(baseAgent, "viewer");
    expect(viewer.always_cli).toBe(false);
    expect(viewer.cli_fallback).toBeUndefined();
    expect(viewer.capabilities).toEqual([]);
    expect(viewer.mcp_tools).toBeUndefined();

    const support = applySenderRolePolicy(baseAgent, "support");
    expect(support.always_cli).toBe(false);
    expect(support.cli_fallback).toBeUndefined();
    expect(support.capabilities).toEqual([]);
  });

  it("removes Codex escalation from viewer/support OpenAI agents", () => {
    const viewer = applySenderRolePolicy(codexAgent, "viewer");
    expect(viewer.always_cli).toBe(false);
    expect(viewer.cli_fallback).toBeUndefined();
    expect(viewer.capabilities).toEqual([]);

    const support = applySenderRolePolicy(codexAgent, "support");
    expect(support.always_cli).toBe(false);
    expect(support.cli_fallback).toBeUndefined();
    expect(support.capabilities).toEqual([]);
  });

  it("keeps engineer tool-use analysis but removes Codex CLI escalation", () => {
    const result = applySenderRolePolicy(codexAgent, "engineer");
    expect(result.always_cli).toBe(false);
    expect(result.cli_fallback).toBeUndefined();
    expect(result.capabilities).toEqual(["tool_use"]);
    expect(result.role).toBe("expert");
  });
});

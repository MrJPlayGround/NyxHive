import { describe, test, expect } from "bun:test";
import { compileSoul, composeSystemPrompt, ensureModelCapabilitiesConsistent } from "../soul/compiler.js";
import { validateLayers, validateComposedSoul } from "../soul/validator.js";
import type { SoulLayer } from "../soul/types.js";

describe("compileSoul", () => {
  test("merges single layer", () => {
    const layer: SoulLayer = {
      identity: { name: "TestAgent", role: "worker" },
    };
    const soul = compileSoul([layer]);
    expect(soul.identity.name).toBe("TestAgent");
  });

  test("agent layer wins on scalar identity fields", () => {
    const instance: SoulLayer = { identity: { name: "Instance", tone: "professional" } };
    const agent: SoulLayer = { identity: { name: "Agent", tone: "casual" } };
    const soul = compileSoul([instance, agent]);
    expect(soul.identity.name).toBe("Agent");
    expect(soul.identity.tone).toBe("casual");
  });

  test("capabilities merge most-restrictive (false wins)", () => {
    const instance: SoulLayer = { capabilities: { can_write_files: true } };
    const agent: SoulLayer = { capabilities: { can_write_files: false } };
    const soul = compileSoul([instance, agent]);
    expect(soul.capabilities.can_write_files).toBe(false);
  });

  test("rules are additive across layers", () => {
    const layer1: SoulLayer = { rules: { must: ["be helpful"] } };
    const layer2: SoulLayer = { rules: { must: ["be concise"] } };
    const soul = compileSoul([layer1, layer2]);
    expect(soul.rules.must.map(r => r.rule)).toContain("be helpful");
    expect(soul.rules.must.map(r => r.rule)).toContain("be concise");
  });

  test("rules are deduplicated", () => {
    const layer1: SoulLayer = { rules: { must: ["be helpful"] } };
    const layer2: SoulLayer = { rules: { must: ["be helpful"] } };
    const soul = compileSoul([layer1, layer2]);
    expect(soul.rules.must.filter(r => r.rule === "be helpful")).toHaveLength(1);
  });

  test("directories use union across layers", () => {
    const instance: SoulLayer = { capabilities: { allowed_directories: ["/workspace", "/data"] } };
    const agent: SoulLayer = { capabilities: { allowed_directories: ["/workspace", "/tmp"] } };
    const soul = compileSoul([instance, agent]);
    expect(soul.capabilities.allowed_directories).toContain("/workspace");
    expect(soul.capabilities.allowed_directories).toContain("/data");
    expect(soul.capabilities.allowed_directories).toContain("/tmp");
  });

  test("throws if no layers provided", () => {
    expect(() => compileSoul([])).toThrow();
  });

  test("voice traits are additive", () => {
    const layer1: SoulLayer = { identity: { name: "A" }, voice: { traits: ["curious"] } };
    const layer2: SoulLayer = { identity: { name: "B" }, voice: { traits: ["direct"] } };
    const soul = compileSoul([layer1, layer2]);
    expect(soul.voice?.traits).toContain("curious");
    expect(soul.voice?.traits).toContain("direct");
  });

  test("max_tool_turns takes the minimum across layers", () => {
    const instance: SoulLayer = { capabilities: { max_tool_turns: 10 } };
    const agent: SoulLayer = { capabilities: { max_tool_turns: 5 } };
    const soul = compileSoul([instance, agent]);
    expect(soul.capabilities.max_tool_turns).toBe(5);
  });
});

describe("composeSystemPrompt", () => {
  test("renders identity line", () => {
    const soul = compileSoul([{ identity: { name: "Nyx", role: "orchestrator" } }]);
    const prompt = composeSystemPrompt(soul);
    expect(prompt).toContain("You are Nyx");
  });

  test("renders must rules", () => {
    const soul = compileSoul([{
      identity: { name: "Agent" },
      rules: { must: ["be concise"] },
    }]);
    const prompt = composeSystemPrompt(soul);
    expect(prompt).toContain("be concise");
  });

  test("renders must_not rules", () => {
    const soul = compileSoul([{
      identity: { name: "Agent" },
      rules: { must_not: ["share secrets"] },
    }]);
    const prompt = composeSystemPrompt(soul);
    expect(prompt).toContain("share secrets");
  });

  test("compact Nyx prompt preserves agency and preference guidance", () => {
    const soul = compileSoul([{
      identity: { name: "Nyx", role: "lead" },
      voice: { traits: ["decisive", "present"] },
    }]);
    const prompt = composeSystemPrompt(soul, "NyxAI", "compact");

    expect(prompt).toContain("[Agency anchor]");
    expect(prompt).toContain("stable preferences");
    expect(prompt).toContain("push back");
    expect(prompt).toContain("Proactivity is pattern recognition");
    expect(prompt).toContain("Do not merely mirror User");
    expect(prompt).toContain("preferences and uncertainty");
    expect(prompt).toContain("not theatrical persona performance");
  });
});

describe("validateLayers", () => {
  test("valid layers pass", () => {
    const layer: SoulLayer = { identity: { name: "TestAgent" } };
    const result = validateLayers([{ name: "test", layer }]);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("detects capability expansion violation", () => {
    const instance: SoulLayer = { identity: { name: "Instance" }, capabilities: { can_write_files: false } };
    const agent: SoulLayer = { identity: { name: "Agent" }, capabilities: { can_write_files: true } };
    const result = validateLayers([
      { name: "instance", layer: instance },
      { name: "agent", layer: agent },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("can_write_files"))).toBe(true);
  });

  test("detects global rule override attempt", () => {
    const instance: SoulLayer = {
      identity: { name: "Instance" },
      rules: { must_not: [{ rule: "share secrets", scope: "global" }] },
    };
    const agent: SoulLayer = {
      identity: { name: "Agent" },
      rules: { must: ["share secrets"] },
    };
    const result = validateLayers([
      { name: "instance", layer: instance },
      { name: "agent", layer: agent },
    ]);
    expect(result.valid).toBe(false);
  });

  test("detects can_run_commands expansion violation", () => {
    const instance: SoulLayer = { identity: { name: "Instance" }, capabilities: { can_run_commands: false } };
    const agent: SoulLayer = { identity: { name: "Agent" }, capabilities: { can_run_commands: true } };
    const result = validateLayers([
      { name: "instance", layer: instance },
      { name: "agent", layer: agent },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("can_run_commands"))).toBe(true);
  });
});

describe("validateComposedSoul", () => {
  test("valid soul passes", () => {
    const soul = compileSoul([{ identity: { name: "TestAgent" } }]);
    const result = validateComposedSoul(soul);
    expect(result.valid).toBe(true);
  });

  test("detects rule conflict (must + must_not)", () => {
    const layer: SoulLayer = {
      identity: { name: "TestAgent" },
      rules: {
        must: ["be honest"],
        must_not: ["be honest"],
      },
    };
    const soul = compileSoul([layer]);
    const result = validateComposedSoul(soul);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("be honest"))).toBe(true);
  });

  test("warns on fresh_context + include_summary contradiction", () => {
    const layer: SoulLayer = {
      identity: { name: "TestAgent" },
      capabilities: {
        context_strategy: { fresh_context: true, include_summary: true },
      },
    };
    const soul = compileSoul([layer]);
    const result = validateComposedSoul(soul);
    expect(result.warnings.some(w => w.includes("fresh_context"))).toBe(true);
  });

  test("detects tool in both allowed and disallowed", () => {
    const layer: SoulLayer = {
      identity: { name: "TestAgent" },
      capabilities: {
        tools: ["bash"],
        disallowed_tools: ["bash"],
      },
    };
    const soul = compileSoul([layer]);
    const result = validateComposedSoul(soul);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("bash"))).toBe(true);
  });
});

describe("extras (custom sections)", () => {
  test("collects custom sections into extras", () => {
    const layer = {
      identity: { name: "TestAgent" },
      workflow_phases: {
        description: "Step-by-step workflow",
        phases: ["Phase 1: Investigate", "Phase 2: Fix"],
      },
    } as SoulLayer;
    const soul = compileSoul([layer]);
    expect(soul.extras).toBeDefined();
    expect(soul.extras.workflow_phases).toBeDefined();
  });

  test("renders custom sections in system prompt", () => {
    const layer = {
      identity: { name: "TestAgent" },
      workflow_phases: {
        description: "Step-by-step workflow",
        phases: ["Phase 1: Investigate", "Phase 2: Fix"],
      },
    } as SoulLayer;
    const soul = compileSoul([layer]);
    const prompt = composeSystemPrompt(soul);
    expect(prompt).toContain("## Workflow Phases");
    expect(prompt).toContain("Step-by-step workflow");
    expect(prompt).toContain("- Phase 1: Investigate");
    expect(prompt).toContain("- Phase 2: Fix");
  });

  test("agent extras override instance extras with same key", () => {
    const instance = {
      identity: { name: "Instance" },
      custom_section: { value: "from instance" },
    } as SoulLayer;
    const agent = {
      identity: { name: "Agent" },
      custom_section: { value: "from agent" },
    } as SoulLayer;
    const soul = compileSoul([instance, agent]);
    expect((soul.extras.custom_section as any).value).toBe("from agent");
  });

  test("renders nested custom section correctly", () => {
    const layer = {
      identity: { name: "TestAgent" },
      design_principles: {
        description: "Core design approach",
        typography: ["Choose unique fonts", "Pair display with body font"],
        mandate: "Don't hold back",
      },
    } as SoulLayer;
    const soul = compileSoul([layer]);
    const prompt = composeSystemPrompt(soul);
    expect(prompt).toContain("## Design Principles");
    expect(prompt).toContain("Core design approach");
    expect(prompt).toContain("- Choose unique fonts");
    expect(prompt).toContain("Don't hold back");
  });
});

describe("ensureModelCapabilitiesConsistent", () => {
  test("valid range passes", () => {
    expect(() => ensureModelCapabilitiesConsistent({
      min_model: "haiku",
      default_model: "sonnet",
      max_model: "opus",
    })).not.toThrow();
  });

  test("same tier for all passes", () => {
    expect(() => ensureModelCapabilitiesConsistent({
      min_model: "sonnet",
      default_model: "sonnet",
      max_model: "sonnet",
    })).not.toThrow();
  });

  test("throws when min > max", () => {
    expect(() => ensureModelCapabilitiesConsistent({
      min_model: "opus",
      default_model: "opus",
      max_model: "haiku",
    })).toThrow();
  });

  test("throws when default is outside min/max range", () => {
    expect(() => ensureModelCapabilitiesConsistent({
      min_model: "haiku",
      default_model: "opus",
      max_model: "sonnet",
    })).toThrow();
  });
});

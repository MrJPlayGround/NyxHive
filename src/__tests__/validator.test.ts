import { describe, it, expect } from "bun:test"
import { validateLayers, validateComposedSoul } from "../soul/validator.js"
import type { SoulLayer, ComposedSoul } from "../soul/types.js"
import { DEFAULT_CAPABILITIES, DEFAULT_MODEL_CAPABILITIES } from "../soul/types.js"

function makeComposedSoul(overrides: Partial<ComposedSoul> = {}): ComposedSoul {
  return {
    identity: { name: "TestAgent" },
    capabilities: { ...DEFAULT_CAPABILITIES },
    rules: { must: [], must_not: [], guidelines: [] },
    context: {},
    model_capabilities: { ...DEFAULT_MODEL_CAPABILITIES },
    extras: {},
    claude_md: [],
    ...overrides,
  }
}

function makeLayer(overrides: Partial<SoulLayer> = {}): SoulLayer {
  return { ...overrides }
}

describe("validateComposedSoul", () => {
  describe("identity validation", () => {
    it("passes with valid identity", () => {
      const result = validateComposedSoul(makeComposedSoul())
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it("fails when identity.name is empty", () => {
      const result = validateComposedSoul(makeComposedSoul({ identity: { name: "" } }))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("missing identity.name"))).toBe(true)
    })

    it("fails when identity.name is whitespace", () => {
      const result = validateComposedSoul(makeComposedSoul({ identity: { name: "   " } }))
      expect(result.valid).toBe(false)
    })
  })

  describe("rule conflict detection", () => {
    it("detects same rule in must and must_not", () => {
      const result = validateComposedSoul(makeComposedSoul({
        rules: {
          must: [{ rule: "always commit", scope: "agent" }],
          must_not: [{ rule: "always commit", scope: "agent" }],
          guidelines: [],
        },
      }))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("Rule conflict"))).toBe(true)
    })

    it("passes when must and must_not have different rules", () => {
      const result = validateComposedSoul(makeComposedSoul({
        rules: {
          must: [{ rule: "write tests", scope: "agent" }],
          must_not: [{ rule: "skip tests", scope: "agent" }],
          guidelines: [],
        },
      }))
      expect(result.valid).toBe(true)
    })
  })

  describe("capability contradictions", () => {
    it("detects bash tool with can_run_commands=false", () => {
      const result = validateComposedSoul(makeComposedSoul({
        capabilities: {
          ...DEFAULT_CAPABILITIES,
          can_run_commands: false,
          tools: ["bash", "read"],
        },
      }))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("Capability conflict") && e.includes("bash"))).toBe(true)
    })

    it("detects execute_command tool with can_run_commands=false", () => {
      const result = validateComposedSoul(makeComposedSoul({
        capabilities: {
          ...DEFAULT_CAPABILITIES,
          can_run_commands: false,
          tools: ["execute_command"],
        },
      }))
      expect(result.valid).toBe(false)
    })

    it("passes when bash tool present with can_run_commands=true", () => {
      const result = validateComposedSoul(makeComposedSoul({
        capabilities: {
          ...DEFAULT_CAPABILITIES,
          can_run_commands: true,
          tools: ["bash"],
        },
      }))
      expect(result.valid).toBe(true)
    })

    it("detects tool in both tools and disallowed_tools", () => {
      const result = validateComposedSoul(makeComposedSoul({
        capabilities: {
          ...DEFAULT_CAPABILITIES,
          tools: ["bash", "read"],
          disallowed_tools: ["bash"],
        },
      }))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("Tool conflict") && e.includes("bash"))).toBe(true)
    })
  })

  describe("warnings", () => {
    it("warns about SDK agent with can_run_commands=true", () => {
      const result = validateComposedSoul(makeComposedSoul({
        capabilities: {
          ...DEFAULT_CAPABILITIES,
          invocation: "sdk",
          can_run_commands: true,
        },
      }))
      expect(result.valid).toBe(true) // warning, not error
      expect(result.warnings.some((w) => w.includes("SDK agent with can_run_commands=true"))).toBe(true)
    })

    it("warns about max_tool_turns=0 with tools listed", () => {
      const result = validateComposedSoul(makeComposedSoul({
        capabilities: {
          ...DEFAULT_CAPABILITIES,
          max_tool_turns: 0,
          tools: ["read", "write"],
        },
      }))
      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.includes("max_tool_turns is 0"))).toBe(true)
    })

    it("warns about fresh_context + include_summary contradiction", () => {
      const result = validateComposedSoul(makeComposedSoul({
        capabilities: {
          ...DEFAULT_CAPABILITIES,
          context_strategy: { fresh_context: true, include_summary: true },
        },
      }))
      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.includes("Context strategy contradiction"))).toBe(true)
    })

    it("no context strategy warning when fresh_context=true with include_summary=false", () => {
      const result = validateComposedSoul(makeComposedSoul({
        capabilities: {
          ...DEFAULT_CAPABILITIES,
          invocation: "cli", // avoid SDK+can_run_commands warning
          context_strategy: { fresh_context: true, include_summary: false },
        },
      }))
      expect(result.warnings).toHaveLength(0)
    })
  })

  describe("model capabilities", () => {
    it("passes with valid model range (haiku → opus)", () => {
      const result = validateComposedSoul(makeComposedSoul({
        model_capabilities: { min_model: "haiku", default_model: "sonnet", max_model: "opus" },
      }))
      expect(result.valid).toBe(true)
    })

    it("fails when min_model > max_model", () => {
      const result = validateComposedSoul(makeComposedSoul({
        model_capabilities: { min_model: "opus", default_model: "opus", max_model: "haiku" },
      }))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("min_model") && e.includes("higher tier"))).toBe(true)
    })

    it("fails when default_model outside min/max range", () => {
      const result = validateComposedSoul(makeComposedSoul({
        model_capabilities: { min_model: "sonnet", default_model: "haiku", max_model: "opus" },
      }))
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("default_model") && e.includes("outside"))).toBe(true)
    })

    it("passes when all tiers are the same", () => {
      const result = validateComposedSoul(makeComposedSoul({
        model_capabilities: { min_model: "sonnet", default_model: "sonnet", max_model: "sonnet" },
      }))
      expect(result.valid).toBe(true)
    })
  })
})

describe("validateLayers", () => {
  describe("schema validation", () => {
    it("passes with empty layers", () => {
      const result = validateLayers([])
      expect(result.valid).toBe(true)
    })

    it("passes with valid identity", () => {
      const result = validateLayers([
        { name: "agent", layer: makeLayer({ identity: { name: "Nyx", role: "lead" } }) },
      ])
      expect(result.valid).toBe(true)
    })

    it("fails when identity.name is empty", () => {
      const result = validateLayers([
        { name: "agent", layer: makeLayer({ identity: { name: "" } }) },
      ])
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("[agent]") && e.includes("identity.name"))).toBe(true)
    })

    it("warns on unknown role", () => {
      const result = validateLayers([
        { name: "agent", layer: makeLayer({ identity: { name: "Test", role: "wizard" } }) },
      ])
      expect(result.valid).toBe(true)
      expect(result.warnings.some((w) => w.includes("wizard") && w.includes("not a known role"))).toBe(true)
    })

    it("accepts all known roles without warning", () => {
      for (const role of ["orchestrator", "lead", "coder", "reviewer", "expert", "worker", "heartbeat"]) {
        const result = validateLayers([
          { name: "agent", layer: makeLayer({ identity: { name: "Test", role } }) },
        ])
        expect(result.warnings.filter((w) => w.includes("not a known role"))).toHaveLength(0)
      }
    })

    it("fails on invalid invocation mode", () => {
      const result = validateLayers([
        { name: "agent", layer: makeLayer({ capabilities: { invocation: "docker" as any } }) },
      ])
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("invocation"))).toBe(true)
    })

    it("fails on negative max_tool_turns", () => {
      const result = validateLayers([
        { name: "agent", layer: makeLayer({ capabilities: { max_tool_turns: -1 } }) },
      ])
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("max_tool_turns"))).toBe(true)
    })

    it("fails on non-integer max_tool_turns", () => {
      const result = validateLayers([
        { name: "agent", layer: makeLayer({ capabilities: { max_tool_turns: 3.5 } }) },
      ])
      expect(result.valid).toBe(false)
    })

    it("fails on invalid model tier", () => {
      const result = validateLayers([
        { name: "agent", layer: makeLayer({ model_capabilities: { min_model: "gpt4" as any } }) },
      ])
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("min_model"))).toBe(true)
    })

    it("validates all model tier fields", () => {
      const result = validateLayers([
        {
          name: "agent",
          layer: makeLayer({
            model_capabilities: {
              min_model: "invalid" as any,
              default_model: "nope" as any,
              max_model: "fake" as any,
            },
          }),
        },
      ])
      expect(result.errors.length).toBe(3)
    })
  })

  describe("cross-layer global rule enforcement", () => {
    it("blocks later layer from adding must rule that conflicts with global must_not", () => {
      const result = validateLayers([
        {
          name: "instance",
          layer: makeLayer({
            rules: { must_not: [{ rule: "never skip tests", scope: "global" }] },
          }),
        },
        {
          name: "agent",
          layer: makeLayer({
            rules: { must: [{ rule: "never skip tests", scope: "agent" }] },
          }),
        },
      ])
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("Cannot override global rule"))).toBe(true)
    })

    it("blocks later layer from adding must_not rule that conflicts with global must", () => {
      const result = validateLayers([
        {
          name: "instance",
          layer: makeLayer({
            rules: { must: [{ rule: "always run tests", scope: "global" }] },
          }),
        },
        {
          name: "agent",
          layer: makeLayer({
            rules: { must_not: [{ rule: "always run tests", scope: "agent" }] },
          }),
        },
      ])
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("Cannot override global rule in must"))).toBe(true)
    })

    it("allows non-global rules to be overridden", () => {
      const result = validateLayers([
        {
          name: "instance",
          layer: makeLayer({
            rules: { must_not: [{ rule: "no logging", scope: "agent" }] },
          }),
        },
        {
          name: "agent",
          layer: makeLayer({
            rules: { must: [{ rule: "no logging", scope: "agent" }] },
          }),
        },
      ])
      expect(result.valid).toBe(true)
    })

    it("allows string rules (default scope=agent) to coexist", () => {
      const result = validateLayers([
        {
          name: "instance",
          layer: makeLayer({ rules: { must_not: ["no logging"] } }),
        },
        {
          name: "agent",
          layer: makeLayer({ rules: { must: ["no logging"] } }),
        },
      ])
      // String rules default to scope=agent, so no global conflict
      expect(result.valid).toBe(true)
    })
  })

  describe("capability expansion prevention", () => {
    it("blocks agent from expanding can_write_files when instance restricts it", () => {
      const result = validateLayers([
        {
          name: "instance",
          layer: makeLayer({ capabilities: { can_write_files: false } }),
        },
        {
          name: "agent",
          layer: makeLayer({ capabilities: { can_write_files: true } }),
        },
      ])
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("Cannot expand can_write_files"))).toBe(true)
    })

    it("blocks agent from expanding can_run_commands when instance restricts it", () => {
      const result = validateLayers([
        {
          name: "instance",
          layer: makeLayer({ capabilities: { can_run_commands: false } }),
        },
        {
          name: "agent",
          layer: makeLayer({ capabilities: { can_run_commands: true } }),
        },
      ])
      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.includes("Cannot expand can_run_commands"))).toBe(true)
    })

    it("allows agent to restrict further (true → false)", () => {
      const result = validateLayers([
        {
          name: "instance",
          layer: makeLayer({ capabilities: { can_write_files: true } }),
        },
        {
          name: "agent",
          layer: makeLayer({ capabilities: { can_write_files: false } }),
        },
      ])
      expect(result.valid).toBe(true)
    })

    it("allows same capability values", () => {
      const result = validateLayers([
        {
          name: "instance",
          layer: makeLayer({ capabilities: { can_run_commands: false } }),
        },
        {
          name: "agent",
          layer: makeLayer({ capabilities: { can_run_commands: false } }),
        },
      ])
      expect(result.valid).toBe(true)
    })
  })

  describe("multi-layer validation", () => {
    it("validates 3 layers correctly", () => {
      const result = validateLayers([
        {
          name: "engine",
          layer: makeLayer({
            rules: { must: [{ rule: "be safe", scope: "global" }] },
            capabilities: { can_write_files: false },
          }),
        },
        {
          name: "instance",
          layer: makeLayer({
            identity: { name: "DevInstance" },
          }),
        },
        {
          name: "agent",
          layer: makeLayer({
            identity: { name: "Nyx", role: "lead" },
          }),
        },
      ])
      expect(result.valid).toBe(true)
    })

    it("catches violations in third layer against first layer globals", () => {
      const result = validateLayers([
        {
          name: "engine",
          layer: makeLayer({
            rules: { must: [{ rule: "always verify", scope: "global" }] },
          }),
        },
        {
          name: "instance",
          layer: makeLayer({}),
        },
        {
          name: "agent",
          layer: makeLayer({
            rules: { must_not: ["always verify"] },
          }),
        },
      ])
      expect(result.valid).toBe(false)
    })

    it("accumulates errors from multiple layers", () => {
      const result = validateLayers([
        {
          name: "layer1",
          layer: makeLayer({ identity: { name: "" } }),
        },
        {
          name: "layer2",
          layer: makeLayer({ capabilities: { invocation: "bad" as any } }),
        },
      ])
      expect(result.errors.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe("edge cases", () => {
    it("handles layers with no rules", () => {
      const result = validateLayers([
        { name: "minimal", layer: makeLayer({}) },
      ])
      expect(result.valid).toBe(true)
    })

    it("handles layers with empty rules arrays", () => {
      const result = validateLayers([
        { name: "empty", layer: makeLayer({ rules: { must: [], must_not: [] } }) },
      ])
      expect(result.valid).toBe(true)
    })

    it("first layer is never checked against itself for global overrides", () => {
      // First layer can have both must and must_not with same rule (weird but not a cross-layer violation)
      const result = validateLayers([
        {
          name: "first",
          layer: makeLayer({
            rules: {
              must: [{ rule: "something", scope: "global" }],
              must_not: [{ rule: "something", scope: "global" }],
            },
          }),
        },
      ])
      // Schema validates fine (cross-layer check only fires for i > 0)
      expect(result.valid).toBe(true)
    })
  })
})

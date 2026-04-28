import { describe, it, expect } from "bun:test"
import { compileSoul, composeSystemPrompt, renderClaudeMd, renderExtraValue, ensureModelCapabilitiesConsistent } from "../soul/compiler.js"
import type { SoulLayer, ComposedSoul } from "../soul/types.js"
import { DEFAULT_CAPABILITIES, DEFAULT_MODEL_CAPABILITIES } from "../soul/types.js"

function layer(overrides: Partial<SoulLayer> = {}): SoulLayer {
  return { ...overrides }
}

describe("compileSoul", () => {
  it("throws with no layers", () => {
    expect(() => compileSoul([])).toThrow("at least one layer required")
  })

  describe("identity merge", () => {
    it("takes identity from single layer", () => {
      const result = compileSoul([layer({ identity: { name: "Nyx", role: "lead" } })])
      expect(result.identity.name).toBe("Nyx")
      expect(result.identity.role).toBe("lead")
    })

    it("last layer wins on scalar fields", () => {
      const result = compileSoul([
        layer({ identity: { name: "Instance", role: "worker" } }),
        layer({ identity: { name: "Nyx", role: "lead" } }),
      ])
      expect(result.identity.name).toBe("Nyx")
      expect(result.identity.role).toBe("lead")
    })

    it("partial identity overrides only specified fields", () => {
      const result = compileSoul([
        layer({ identity: { name: "Base", role: "worker", archetype: "helper" } }),
        layer({ identity: { name: "Override" } }),
      ])
      expect(result.identity.name).toBe("Override")
      expect(result.identity.role).toBe("worker")
      expect(result.identity.archetype).toBe("helper")
    })
  })

  describe("voice merge", () => {
    it("returns undefined when no layer has voice", () => {
      const result = compileSoul([layer({ identity: { name: "Test" } })])
      expect(result.voice).toBeUndefined()
    })

    it("description is last-wins", () => {
      const result = compileSoul([
        layer({ voice: { description: "first" } }),
        layer({ voice: { description: "second" } }),
      ])
      expect(result.voice?.description).toBe("second")
    })

    it("traits are additive across layers", () => {
      const result = compileSoul([
        layer({ voice: { traits: ["direct"] } }),
        layer({ voice: { traits: ["funny"] } }),
      ])
      expect(result.voice?.traits).toEqual(["direct", "funny"])
    })

    it("quirks are additive across layers", () => {
      const result = compileSoul([
        layer({ voice: { quirks: ["dry humor"] } }),
        layer({ voice: { quirks: ["technical references"] } }),
      ])
      expect(result.voice?.quirks).toEqual(["dry humor", "technical references"])
    })

    it("example_phrases are additive across layers", () => {
      const result = compileSoul([
        layer({ voice: { example_phrases: ["Let's ship it"] } }),
        layer({ voice: { example_phrases: ["That's elegant"] } }),
      ])
      expect(result.voice?.example_phrases).toEqual(["Let's ship it", "That's elegant"])
    })
  })

  describe("capabilities merge", () => {
    it("starts with defaults", () => {
      const result = compileSoul([layer({ identity: { name: "Test" } })])
      expect(result.capabilities.invocation).toBe("sdk")
      expect(result.capabilities.can_write_files).toBe(true)
      expect(result.capabilities.can_run_commands).toBe(true)
    })

    it("false wins on boolean flags (most restrictive)", () => {
      const result = compileSoul([
        layer({ capabilities: { can_write_files: true } }),
        layer({ capabilities: { can_write_files: false } }),
      ])
      expect(result.capabilities.can_write_files).toBe(false)
    })

    it("false stays false even if later layer says true", () => {
      const result = compileSoul([
        layer({ capabilities: { can_run_commands: false } }),
        layer({ capabilities: { can_run_commands: true } }),
      ])
      // false wins because: acc.can_run_commands (false) && layer.can_run_commands (true) = false
      expect(result.capabilities.can_run_commands).toBe(false)
    })

    it("tools are additive across layers", () => {
      const result = compileSoul([
        layer({ capabilities: { tools: ["read"] } }),
        layer({ capabilities: { tools: ["write", "bash"] } }),
      ])
      expect(result.capabilities.tools).toEqual(["read", "write", "bash"])
    })

    it("disallowed_tools are additive", () => {
      const result = compileSoul([
        layer({ capabilities: { disallowed_tools: ["bash"] } }),
        layer({ capabilities: { disallowed_tools: ["write"] } }),
      ])
      expect(result.capabilities.disallowed_tools).toEqual(["bash", "write"])
    })

    it("lower max_tool_turns wins", () => {
      const result = compileSoul([
        layer({ capabilities: { max_tool_turns: 100 } }),
        layer({ capabilities: { max_tool_turns: 10 } }),
      ])
      expect(result.capabilities.max_tool_turns).toBe(10)
    })

    it("invocation last-wins", () => {
      const result = compileSoul([
        layer({ capabilities: { invocation: "sdk" } }),
        layer({ capabilities: { invocation: "cli" } }),
      ])
      expect(result.capabilities.invocation).toBe("cli")
    })

    it("directories are unioned", () => {
      const result = compileSoul([
        layer({ capabilities: { allowed_directories: ["/home/user"] } }),
        layer({ capabilities: { allowed_directories: ["/opt/app"] } }),
      ])
      expect(result.capabilities.allowed_directories).toContain("/home/user")
      expect(result.capabilities.allowed_directories).toContain("/opt/app")
    })

    it("directories are deduplicated", () => {
      const result = compileSoul([
        layer({ capabilities: { allowed_directories: ["/home/user"] } }),
        layer({ capabilities: { allowed_directories: ["/home/user", "/opt"] } }),
      ])
      expect(result.capabilities.allowed_directories.filter(d => d === "/home/user")).toHaveLength(1)
    })

    it("context_strategy last-wins", () => {
      const result = compileSoul([
        layer({ capabilities: { context_strategy: { fresh_context: true } } }),
        layer({ capabilities: { context_strategy: { fresh_context: false, max_messages: 10 } } }),
      ])
      expect(result.capabilities.context_strategy?.fresh_context).toBe(false)
      expect(result.capabilities.context_strategy?.max_messages).toBe(10)
    })
  })

  describe("rules merge", () => {
    it("additive: rules from all layers included", () => {
      const result = compileSoul([
        layer({ rules: { must: ["rule A"] } }),
        layer({ rules: { must: ["rule B"] } }),
      ])
      expect(result.rules.must.map(r => r.rule)).toEqual(["rule A", "rule B"])
    })

    it("deduplicates rules by string", () => {
      const result = compileSoul([
        layer({ rules: { must: ["same rule"] } }),
        layer({ rules: { must: ["same rule"] } }),
      ])
      expect(result.rules.must).toHaveLength(1)
    })

    it("normalizes string rules to ScopedRule with agent scope", () => {
      const result = compileSoul([
        layer({ rules: { must: ["test rule"] } }),
      ])
      expect(result.rules.must[0]).toEqual({ rule: "test rule", scope: "agent" })
    })

    it("preserves ScopedRule with global scope", () => {
      const result = compileSoul([
        layer({ rules: { must: [{ rule: "global rule", scope: "global" }] } }),
      ])
      expect(result.rules.must[0]).toEqual({ rule: "global rule", scope: "global" })
    })

    it("merges must_not from multiple layers", () => {
      const result = compileSoul([
        layer({ rules: { must_not: ["no X"] } }),
        layer({ rules: { must_not: ["no Y"] } }),
      ])
      expect(result.rules.must_not.map(r => r.rule)).toEqual(["no X", "no Y"])
    })

    it("merges guidelines from multiple layers", () => {
      const result = compileSoul([
        layer({ rules: { guidelines: ["be concise"] } }),
        layer({ rules: { guidelines: ["be thorough"] } }),
      ])
      expect(result.rules.guidelines).toEqual(["be concise", "be thorough"])
    })

    it("deduplicates guidelines", () => {
      const result = compileSoul([
        layer({ rules: { guidelines: ["be clear"] } }),
        layer({ rules: { guidelines: ["be clear"] } }),
      ])
      expect(result.rules.guidelines).toHaveLength(1)
    })
  })

  describe("model capabilities merge", () => {
    it("starts with defaults", () => {
      const result = compileSoul([layer({})])
      expect(result.model_capabilities).toEqual(DEFAULT_MODEL_CAPABILITIES)
    })

    it("min_model: highest wins (most restrictive floor)", () => {
      const result = compileSoul([
        layer({ model_capabilities: { min_model: "haiku" } }),
        layer({ model_capabilities: { min_model: "sonnet" } }),
      ])
      expect(result.model_capabilities.min_model).toBe("sonnet")
    })

    it("max_model: lowest wins (most restrictive ceiling)", () => {
      const result = compileSoul([
        layer({ model_capabilities: { max_model: "opus" } }),
        layer({ model_capabilities: { max_model: "sonnet" } }),
      ])
      expect(result.model_capabilities.max_model).toBe("sonnet")
    })

    it("default_model: last-wins", () => {
      const result = compileSoul([
        layer({ model_capabilities: { default_model: "haiku" } }),
        layer({ model_capabilities: { default_model: "opus" } }),
      ])
      expect(result.model_capabilities.default_model).toBe("opus")
    })
  })

  describe("context merge", () => {
    it("domains are additive and deduplicated", () => {
      const result = compileSoul([
        layer({ context: { domains: ["backend", "infra"] } }),
        layer({ context: { domains: ["backend", "frontend"] } }),
      ])
      expect(result.context.domains).toEqual(["backend", "infra", "frontend"])
    })

    it("relationships are additive, deduplicated by name", () => {
      const result = compileSoul([
        layer({ context: { relationships: [{ name: "User", role: "founder" }] } }),
        layer({ context: { relationships: [{ name: "User", role: "dev" }, { name: "Alice", role: "reviewer" }] } }),
      ])
      expect(result.context.relationships).toHaveLength(2)
      expect(result.context.relationships?.[0].role).toBe("founder") // first wins
    })

    it("instance_notes: last-wins", () => {
      const result = compileSoul([
        layer({ context: { instance_notes: "first note" } }),
        layer({ context: { instance_notes: "second note" } }),
      ])
      expect(result.context.instance_notes).toBe("second note")
    })
  })

  describe("extras", () => {
    it("collects non-standard keys from layers", () => {
      const result = compileSoul([
        layer({ identity: { name: "Test" }, custom_section: "hello" } as SoulLayer),
      ])
      expect(result.extras.custom_section).toBe("hello")
    })

    it("last layer wins on extras", () => {
      const result = compileSoul([
        layer({ custom: "first" } as SoulLayer),
        layer({ custom: "second" } as SoulLayer),
      ])
      expect(result.extras.custom).toBe("second")
    })

    it("does not include known keys in extras", () => {
      const result = compileSoul([
        layer({ identity: { name: "Test" }, rules: { must: ["test"] } }),
      ])
      expect(result.extras.identity).toBeUndefined()
      expect(result.extras.rules).toBeUndefined()
    })
  })

  describe("claude_md generation", () => {
    it("generates role-based CLAUDE.md for lead", () => {
      const result = compileSoul([layer({ identity: { name: "Nyx", role: "lead" } })])
      expect(result.claude_md.some(l => l.includes("implement code directly"))).toBe(true)
    })

    it("generates role-based CLAUDE.md for coder", () => {
      const result = compileSoul([layer({ identity: { name: "Coder", role: "coder" } })])
      expect(result.claude_md.some(l => l.includes("autonomous coding agent"))).toBe(true)
    })

    it("generates role-based CLAUDE.md for orchestrator", () => {
      const result = compileSoul([layer({ identity: { name: "Orch", role: "orchestrator" } })])
      expect(result.claude_md.some(l => l.includes("coordinate work"))).toBe(true)
    })

    it("includes file write access line when can_write_files", () => {
      const result = compileSoul([layer({ identity: { name: "Test" }, capabilities: { can_write_files: true } })])
      expect(result.claude_md.some(l => l.includes("file write access"))).toBe(true)
    })

    it("includes no-delegate line when can_delegate=false", () => {
      const result = compileSoul([layer({ identity: { name: "Test" }, capabilities: { can_delegate: false } })])
      expect(result.claude_md.some(l => l.includes("cannot delegate"))).toBe(true)
    })

    it("always includes AskUserQuestion warning", () => {
      const result = compileSoul([layer({ identity: { name: "Test" } })])
      expect(result.claude_md.some(l => l.includes("AskUserQuestion"))).toBe(true)
    })

    it("includes explicit claude_md from layers", () => {
      const result = compileSoul([layer({ claude_md: ["Custom instruction"] })])
      expect(result.claude_md).toContain("Custom instruction")
    })

    it("deduplicates claude_md lines", () => {
      const result = compileSoul([
        layer({ claude_md: ["Same line"] }),
        layer({ claude_md: ["Same line"] }),
      ])
      expect(result.claude_md.filter(l => l === "Same line")).toHaveLength(1)
    })
  })
})

describe("composeSystemPrompt", () => {
  function makeSoul(overrides: Partial<ComposedSoul> = {}): ComposedSoul {
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

  it("starts with identity line", () => {
    const prompt = composeSystemPrompt(makeSoul())
    expect(prompt).toMatch(/^You are TestAgent,/)
  })

  it("includes instance name", () => {
    const prompt = composeSystemPrompt(makeSoul(), "MyInstance")
    expect(prompt).toContain("for MyInstance")
  })

  it("uses archetype in opening line", () => {
    const prompt = composeSystemPrompt(makeSoul({ identity: { name: "Nyx", archetype: "lead engineer" } }))
    expect(prompt).toContain("lead engineer")
  })

  it("falls back to role when no archetype", () => {
    const prompt = composeSystemPrompt(makeSoul({ identity: { name: "Nyx", role: "lead" } }))
    expect(prompt).toContain("lead")
  })

  it("renders identity section with tone", () => {
    const prompt = composeSystemPrompt(makeSoul({ identity: { name: "Test", tone: "Direct and clear" } }))
    expect(prompt).toContain("## Identity")
    expect(prompt).toContain("Direct and clear")
  })

  it("renders voice traits (requires description to trigger Identity section)", () => {
    const prompt = composeSystemPrompt(makeSoul({ voice: { description: "A direct voice", traits: ["witty", "concise"] } }))
    expect(prompt).toContain("Traits: witty, concise.")
  })

  it("renders a recency voice anchor in compact prompts", () => {
    const prompt = composeSystemPrompt(
      makeSoul({
        identity: { name: "Nyx", role: "lead" },
        voice: { description: "Direct and warm.", traits: ["sharp", "concise"] },
      }),
      "NyxAI",
      "compact",
    )

    expect(prompt).toContain("[Voice anchor]")
    expect(prompt).toContain("Runtime, tool, policy, and memory context are scaffolding")
    expect(prompt).toContain("For Nyx: sharp opinions")
    expect(prompt).toContain("Avoid assistant filler")
  })

  it("renders Vortex-specific compact voice and agency anchors", () => {
    const prompt = composeSystemPrompt(
      makeSoul({
        identity: { name: "Vortex", role: "lead" },
        voice: { description: "Direct product operator.", traits: ["builder", "domain-sharp"] },
      }),
      "NyxLabs",
      "compact",
    )

    expect(prompt).toContain("[Voice anchor]")
    expect(prompt).toContain("For Vortex: product-and-domain operator voice")
    expect(prompt).toContain("[Agency anchor]")
    expect(prompt).toContain("trading-workflow judgment")
    expect(prompt).not.toContain("For Nyx: sharp opinions")
  })

  it("renders voice quirks", () => {
    const prompt = composeSystemPrompt(makeSoul({ voice: { description: "Sharp", quirks: ["dry humor"] } }))
    expect(prompt).toContain("Quirks:")
    expect(prompt).toContain("- dry humor")
  })

  it("renders capabilities section", () => {
    const prompt = composeSystemPrompt(makeSoul())
    expect(prompt).toContain("## Capabilities")
  })

  it("renders delegation for orchestrator", () => {
    const prompt = composeSystemPrompt(makeSoul({ identity: { name: "Orch", role: "orchestrator" } }))
    expect(prompt).toContain("delegating work")
  })

  it("renders delegation for lead with can_delegate", () => {
    const prompt = composeSystemPrompt(makeSoul({
      identity: { name: "Nyx", role: "lead" },
      capabilities: { ...DEFAULT_CAPABILITIES, can_delegate: true },
    }))
    expect(prompt).toContain("delegate to specialist agents")
  })

  it("renders no file system access when all disabled", () => {
    const prompt = composeSystemPrompt(makeSoul({
      capabilities: { ...DEFAULT_CAPABILITIES, can_read_files: false, can_write_files: false, can_run_commands: false },
    }))
    expect(prompt).toContain("no file system or command access")
  })

  it("renders read-only when only can_read_files", () => {
    const prompt = composeSystemPrompt(makeSoul({
      capabilities: { ...DEFAULT_CAPABILITIES, can_read_files: true, can_write_files: false },
    }))
    expect(prompt).toContain("read files but cannot write")
  })

  it("renders allowed directories", () => {
    const prompt = composeSystemPrompt(makeSoul({
      capabilities: { ...DEFAULT_CAPABILITIES, allowed_directories: ["/home/user", "/opt/app"] },
    }))
    expect(prompt).toContain("Allowed directories: /home/user, /opt/app")
  })

  it("renders disallowed tools", () => {
    const prompt = composeSystemPrompt(makeSoul({
      capabilities: { ...DEFAULT_CAPABILITIES, disallowed_tools: ["bash", "write"] },
    }))
    expect(prompt).toContain("Disallowed tools: bash, write")
  })

  it("renders must rules", () => {
    const prompt = composeSystemPrompt(makeSoul({
      rules: { must: [{ rule: "always test", scope: "agent" }], must_not: [], guidelines: [] },
    }))
    expect(prompt).toContain("### You MUST:")
    expect(prompt).toContain("- always test")
  })

  it("renders must_not rules", () => {
    const prompt = composeSystemPrompt(makeSoul({
      rules: { must: [], must_not: [{ rule: "skip tests", scope: "agent" }], guidelines: [] },
    }))
    expect(prompt).toContain("### You MUST NOT:")
    expect(prompt).toContain("- skip tests")
  })

  it("renders guidelines", () => {
    const prompt = composeSystemPrompt(makeSoul({
      rules: { must: [], must_not: [], guidelines: ["prefer simplicity"] },
    }))
    expect(prompt).toContain("### Guidelines:")
    expect(prompt).toContain("- prefer simplicity")
  })

  it("renders context domains", () => {
    const prompt = composeSystemPrompt(makeSoul({
      context: { domains: ["backend", "infra"] },
    }))
    expect(prompt).toContain("Domains: backend, infra")
  })

  it("renders context relationships", () => {
    const prompt = composeSystemPrompt(makeSoul({
      context: { relationships: [{ name: "User", role: "founder", notes: "Direct, no fluff" }] },
    }))
    expect(prompt).toContain("- **User** (founder): Direct, no fluff")
  })

  it("renders instance_notes", () => {
    const prompt = composeSystemPrompt(makeSoul({
      context: { instance_notes: "Development instance" },
    }))
    expect(prompt).toContain("Development instance")
  })

  it("renders extras in full tier", () => {
    const prompt = composeSystemPrompt(makeSoul({
      extras: { debugging_tips: "Check logs first" },
    }), "Test", "full")
    expect(prompt).toContain("## Debugging Tips")
    expect(prompt).toContain("Check logs first")
  })

  it("skips extras in compact tier", () => {
    const prompt = composeSystemPrompt(makeSoul({
      extras: { debugging_tips: "Check logs first" },
    }), "Test", "compact")
    expect(prompt).not.toContain("Debugging Tips")
  })

  it("renders identity refresh at end", () => {
    const prompt = composeSystemPrompt(makeSoul({ identity: { name: "Nyx", role: "lead" } }))
    expect(prompt).toContain("Remember: You are Nyx.")
    expect(prompt).toContain("Role: lead.")
  })

  it("formats extra object values with labels", () => {
    const prompt = composeSystemPrompt(makeSoul({
      extras: { tips: { first: "do X", second: "do Y" } },
    }), "Test", "full")
    expect(prompt).toContain("**First:** do X")
    expect(prompt).toContain("**Second:** do Y")
  })

  it("formats extra array values as bullet lists", () => {
    const prompt = composeSystemPrompt(makeSoul({
      extras: { tips: ["tip 1", "tip 2"] },
    }), "Test", "full")
    expect(prompt).toContain("- tip 1")
    expect(prompt).toContain("- tip 2")
  })

  it("renders unknown identity and context fields through extra sections", () => {
    const prompt = composeSystemPrompt(makeSoul({
      identity: {
        name: "Nyx",
        role: "lead",
        origin: "Forged in production incidents.",
        what_i_care_about: ["clarity", "shipping working code"],
      } as ComposedSoul["identity"],
      context: {
        delegation_policy: {
          default_mode: "Execute directly unless specialist depth is needed.",
          escalate_when: ["deep research", "parallel validation"],
        },
      } as ComposedSoul["context"],
    }))

    expect(prompt).toContain("### Origin")
    expect(prompt).toContain("Forged in production incidents.")
    expect(prompt).toContain("### What I Care About")
    expect(prompt).toContain("- clarity")
    expect(prompt).toContain("- shipping working code")
    expect(prompt).toContain("### Delegation Policy")
    expect(prompt).toContain("**Default Mode:** Execute directly unless specialist depth is needed.")
    expect(prompt).toContain("**Escalate When:**")
    expect(prompt).toContain("- deep research")
    expect(prompt).toContain("- parallel validation")
  })
})

describe("renderExtraValue", () => {
  it("renders string values directly", () => {
    const parts: string[] = []
    renderExtraValue("Forged in production incidents.", parts, 0)
    expect(parts).toEqual(["Forged in production incidents."])
  })

  it("renders array values as bullets", () => {
    const parts: string[] = []
    renderExtraValue(["clarity", "shipping working code"], parts, 0)
    expect(parts).toEqual(["- clarity", "- shipping working code"])
  })

  it("renders nested object values recursively", () => {
    const parts: string[] = []
    renderExtraValue({
      delegation_policy: {
        default_mode: "Execute directly unless specialist depth is needed.",
        escalate_when: ["deep research", "parallel validation"],
      },
    }, parts, 0)

    expect(parts).toEqual([
      "**Delegation Policy:**",
      "**Default Mode:** Execute directly unless specialist depth is needed.",
      "**Escalate When:**",
      "- deep research",
      "- parallel validation",
    ])
  })
})

describe("renderClaudeMd", () => {
  function makeSoul(overrides: Partial<ComposedSoul> = {}): ComposedSoul {
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

  it("always renders header with agent name", () => {
    expect(renderClaudeMd(makeSoul())).toContain("# TestAgent — NyxHive Agent")
  })

  it("renders soul-file read instruction", () => {
    const md = renderClaudeMd(makeSoul())
    expect(md).toContain("Read your soul files at session start")
  })

  it("ends with newline", () => {
    expect(renderClaudeMd(makeSoul()).endsWith("\n")).toBe(true)
  })
})

describe("ensureModelCapabilitiesConsistent", () => {
  it("passes with valid range", () => {
    expect(() => ensureModelCapabilitiesConsistent({
      min_model: "haiku", default_model: "sonnet", max_model: "opus",
    })).not.toThrow()
  })

  it("passes when all same tier", () => {
    expect(() => ensureModelCapabilitiesConsistent({
      min_model: "sonnet", default_model: "sonnet", max_model: "sonnet",
    })).not.toThrow()
  })

  it("throws when min > max", () => {
    expect(() => ensureModelCapabilitiesConsistent({
      min_model: "opus", default_model: "opus", max_model: "haiku",
    })).toThrow(/min_model.*higher tier.*max_model/)
  })

  it("throws when default < min", () => {
    expect(() => ensureModelCapabilitiesConsistent({
      min_model: "sonnet", default_model: "haiku", max_model: "opus",
    })).toThrow(/default_model.*outside/)
  })

  it("throws when default > max", () => {
    expect(() => ensureModelCapabilitiesConsistent({
      min_model: "haiku", default_model: "opus", max_model: "sonnet",
    })).toThrow(/default_model.*outside/)
  })
})

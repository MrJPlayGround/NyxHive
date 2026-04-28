import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs"
import { resolve, join } from "path"
import { tmpdir } from "os"
import {
  resolveModel,
  resolveModelForTask,
  injectModelHint,
  clearSoulCache,
  loadAndCompileSoul,
  getSoulSystemPrompt,
} from "../soul/runtime.js"
import { MODEL_TIER_REGISTRY } from "../soul/types.js"
import type { ComposedSoul, ModelTier, RelativeTier } from "../soul/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal valid ComposedSoul with overridable model capabilities */
function makeSoul(overrides?: {
  min_model?: ModelTier
  default_model?: ModelTier
  max_model?: ModelTier
}): ComposedSoul {
  return {
    identity: { name: "TestAgent", role: "worker" },
    capabilities: {
      invocation: "sdk",
      tools: [],
      disallowed_tools: [],
      mcp_tools: [],
      can_delegate: false,
      can_read_files: true,
      can_write_files: false,
      can_run_commands: false,
      allowed_directories: [],
      max_tool_turns: 9999,
      context_strategy: undefined,
    },
    rules: { must: [], must_not: [], guidelines: [] },
    context: { domains: [], relationships: [] },
    model_capabilities: {
      min_model: overrides?.min_model ?? "haiku",
      default_model: overrides?.default_model ?? "sonnet",
      max_model: overrides?.max_model ?? "opus",
    },
    extras: {},
    claude_md: [],
  }
}

let tempDir: string

beforeEach(() => {
  clearSoulCache()
  tempDir = mkdtempSync(join(tmpdir(), "soul-runtime-test-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

describe("resolveModel", () => {
  it("returns default_model when no hint is provided", () => {
    const soul = makeSoul({ default_model: "sonnet" })
    expect(resolveModel(soul)).toBe(MODEL_TIER_REGISTRY["sonnet"])
  })

  it("returns default_model when classifierTier is undefined and no orchestratorHint", () => {
    const soul = makeSoul({ default_model: "flash" })
    expect(resolveModel(soul, undefined, undefined)).toBe(MODEL_TIER_REGISTRY["flash"])
  })

  describe("classifierTier (relative)", () => {
    it("maps 'min' to soul's min_model", () => {
      const soul = makeSoul({ min_model: "haiku" })
      expect(resolveModel(soul, "min")).toBe(MODEL_TIER_REGISTRY["haiku"])
    })

    it("maps 'max' to soul's max_model", () => {
      const soul = makeSoul({ max_model: "opus" })
      expect(resolveModel(soul, "max")).toBe(MODEL_TIER_REGISTRY["opus"])
    })

    it("maps 'default' to soul's default_model", () => {
      const soul = makeSoul({ default_model: "sonnet" })
      expect(resolveModel(soul, "default")).toBe(MODEL_TIER_REGISTRY["sonnet"])
    })

    it("respects custom min/max/default combination", () => {
      const soul = makeSoul({
        min_model: "flash-lite",
        default_model: "flash",
        max_model: "sonnet",
      })
      expect(resolveModel(soul, "min")).toBe(MODEL_TIER_REGISTRY["flash-lite"])
      expect(resolveModel(soul, "default")).toBe(MODEL_TIER_REGISTRY["flash"])
      expect(resolveModel(soul, "max")).toBe(MODEL_TIER_REGISTRY["sonnet"])
    })
  })

  describe("orchestratorHint (absolute)", () => {
    it("uses the hint directly when within soul range", () => {
      const soul = makeSoul({ min_model: "haiku", max_model: "opus" })
      expect(resolveModel(soul, undefined, "sonnet")).toBe(MODEL_TIER_REGISTRY["sonnet"])
    })

    it("bounds hint up to soul's min_model when hint is below range", () => {
      const soul = makeSoul({ min_model: "sonnet", max_model: "opus" })
      // requesting haiku but min is sonnet => bounded to sonnet
      expect(resolveModel(soul, undefined, "haiku")).toBe(MODEL_TIER_REGISTRY["sonnet"])
    })

    it("bounds hint down to soul's max_model when hint is above range", () => {
      const soul = makeSoul({ min_model: "haiku", max_model: "sonnet" })
      // requesting opus but max is sonnet => bounded to sonnet
      expect(resolveModel(soul, undefined, "opus")).toBe(MODEL_TIER_REGISTRY["sonnet"])
    })

    it("hint exactly at min_model boundary", () => {
      const soul = makeSoul({ min_model: "flash", max_model: "opus" })
      expect(resolveModel(soul, undefined, "flash")).toBe(MODEL_TIER_REGISTRY["flash"])
    })

    it("hint exactly at max_model boundary", () => {
      const soul = makeSoul({ min_model: "haiku", max_model: "flash" })
      expect(resolveModel(soul, undefined, "flash")).toBe(MODEL_TIER_REGISTRY["flash"])
    })

    it("orchestratorHint takes precedence over classifierTier", () => {
      const soul = makeSoul({ min_model: "haiku", default_model: "sonnet", max_model: "opus" })
      // classifier says min but orchestrator says opus => orchestrator wins
      expect(resolveModel(soul, "min", "opus")).toBe(MODEL_TIER_REGISTRY["opus"])
    })

    it("narrow range (min == max) always returns that tier", () => {
      const soul = makeSoul({ min_model: "sonnet", default_model: "sonnet", max_model: "sonnet" })
      expect(resolveModel(soul, undefined, "haiku")).toBe(MODEL_TIER_REGISTRY["sonnet"])
      expect(resolveModel(soul, undefined, "opus")).toBe(MODEL_TIER_REGISTRY["sonnet"])
    })
  })
})

// ---------------------------------------------------------------------------
// resolveModelForTask
// ---------------------------------------------------------------------------

describe("resolveModelForTask", () => {
  it("returns modelId and classifierResult", () => {
    const soul = makeSoul()
    const result = resolveModelForTask(soul, "fix a typo in readme")
    expect(result.modelId).toBeDefined()
    expect(result.classifierResult).toBeDefined()
    expect(result.classifierResult.tier).toBeDefined()
    expect(result.classifierResult.signals).toBeInstanceOf(Array)
    expect(result.classifierResult.confidence).toBeGreaterThan(0)
  })

  it("simple task gets lower tier", () => {
    const soul = makeSoul({ min_model: "haiku", default_model: "sonnet", max_model: "opus" })
    const result = resolveModelForTask(soul, "bump version")
    // "bump" is a min keyword
    expect(result.classifierResult.tier).toBe("min")
    expect(result.modelId).toBe(MODEL_TIER_REGISTRY["haiku"])
  })

  it("complex task gets higher tier", () => {
    const soul = makeSoul({ min_model: "haiku", default_model: "sonnet", max_model: "opus" })
    const result = resolveModelForTask(soul, "refactor the entire architecture of the system")
    expect(result.classifierResult.tier).toBe("max")
    expect(result.modelId).toBe(MODEL_TIER_REGISTRY["opus"])
  })

  it("orchestratorHint overrides classifier result", () => {
    const soul = makeSoul({ min_model: "haiku", default_model: "sonnet", max_model: "opus" })
    // simple task but orchestrator forces opus
    const result = resolveModelForTask(soul, "bump version", 0, "opus")
    expect(result.modelId).toBe(MODEL_TIER_REGISTRY["opus"])
  })

  it("fileCount influences complexity", () => {
    const soul = makeSoul({ min_model: "haiku", default_model: "sonnet", max_model: "opus" })
    // simple keyword but many files
    const result = resolveModelForTask(soul, "rename variable", 10)
    // 10 files => "max" file tier, which lifts overall tier
    expect(result.classifierResult.tier).toBe("max")
  })
})

// ---------------------------------------------------------------------------
// injectModelHint
// ---------------------------------------------------------------------------

describe("injectModelHint", () => {
  it("adds _soul_model_hint to context", () => {
    const ctx = { task: "do something" }
    const result = injectModelHint(ctx, "opus")
    expect(result._soul_model_hint).toBe("opus")
    expect(result.task).toBe("do something")
  })

  it("does not mutate the original context", () => {
    const ctx: Record<string, unknown> = { existing: true }
    const result = injectModelHint(ctx, "sonnet")
    expect(ctx).not.toHaveProperty("_soul_model_hint")
    expect(result._soul_model_hint).toBe("sonnet")
  })

  it("preserves existing context keys", () => {
    const ctx = { a: 1, b: "two", c: [3] }
    const result = injectModelHint(ctx, "haiku")
    expect(result.a).toBe(1)
    expect(result.b).toBe("two")
    expect(result.c).toEqual([3])
    expect(result._soul_model_hint).toBe("haiku")
  })
})

// ---------------------------------------------------------------------------
// clearSoulCache
// ---------------------------------------------------------------------------

describe("clearSoulCache", () => {
  it("clears cache so next load recompiles", () => {
    // Set up a v1 agent
    writeFileSync(
      resolve(tempDir, "cached.yaml"),
      `identity:\n  name: CachedAgent\n  role: worker\ncapabilities:\n  can_delegate: false\nrules:\n  must:\n    - Do stuff\n`,
    )

    const first = loadAndCompileSoul("cached", tempDir)
    expect(first).toBeDefined()
    expect(first!.identity.name).toBe("CachedAgent")

    // Without clearing, cache hit returns same object
    const second = loadAndCompileSoul("cached", tempDir)
    expect(first).toBe(second)

    // After clearing, recompiles (new object)
    clearSoulCache()
    const third = loadAndCompileSoul("cached", tempDir)
    expect(third).toBeDefined()
    expect(third!.identity.name).toBe("CachedAgent")
    // Different object reference after cache clear
    expect(third).not.toBe(first)
  })
})

// ---------------------------------------------------------------------------
// loadAndCompileSoul
// ---------------------------------------------------------------------------

describe("loadAndCompileSoul", () => {
  describe("v1 YAML loading", () => {
    it("loads a simple agent YAML file", () => {
      writeFileSync(
        resolve(tempDir, "simple.yaml"),
        `identity:\n  name: SimpleAgent\n  role: worker\ncapabilities:\n  can_delegate: false\nrules:\n  must:\n    - Test rule\n`,
      )

      const soul = loadAndCompileSoul("simple", tempDir)
      expect(soul).toBeDefined()
      expect(soul!.identity.name).toBe("SimpleAgent")
      expect(soul!.identity.role).toBe("worker")
      expect(soul!.rules.must.map((r) => r.rule)).toContain("Test rule")
    })

    it("merges base.yaml when present in engine souls dir", () => {
      // base.yaml is loaded from ENGINE_SOULS_DIR (not the custom soulsDir).
      // We can verify the agent file loads correctly on its own.
      writeFileSync(
        resolve(tempDir, "standalone.yaml"),
        `identity:\n  name: Standalone\n  role: worker\ncapabilities:\n  can_delegate: false\n`,
      )

      const soul = loadAndCompileSoul("standalone", tempDir)
      expect(soul).toBeDefined()
      expect(soul!.identity.name).toBe("Standalone")
    })

    it("merges instance.yaml when present", () => {
      writeFileSync(
        resolve(tempDir, "instance.yaml"),
        `identity:\n  name: InstanceName\ncontext:\n  instance_notes: "Test instance"\n`,
      )
      writeFileSync(
        resolve(tempDir, "layered.yaml"),
        `identity:\n  name: LayeredAgent\n  role: worker\ncapabilities:\n  can_delegate: false\n`,
      )

      const soul = loadAndCompileSoul("layered", tempDir)
      expect(soul).toBeDefined()
      // Agent layer overrides instance identity
      expect(soul!.identity.name).toBe("LayeredAgent")
      // Instance context is inherited
      expect(soul!.context.instance_notes).toBe("Test instance")
    })

    it("returns model_capabilities with defaults", () => {
      writeFileSync(
        resolve(tempDir, "defaults.yaml"),
        `identity:\n  name: DefaultModel\n  role: worker\ncapabilities:\n  can_delegate: false\n`,
      )

      const soul = loadAndCompileSoul("defaults", tempDir)
      expect(soul).toBeDefined()
      // Should have default model capabilities
      expect(soul!.model_capabilities.default_model).toBeDefined()
      expect(soul!.model_capabilities.min_model).toBeDefined()
      expect(soul!.model_capabilities.max_model).toBeDefined()
    })

    it("respects model_capabilities overrides", () => {
      writeFileSync(
        resolve(tempDir, "custom-model.yaml"),
        `identity:\n  name: CustomModel\n  role: worker\ncapabilities:\n  can_delegate: false\nmodel_capabilities:\n  min_model: sonnet\n  default_model: sonnet\n  max_model: opus\n`,
      )

      const soul = loadAndCompileSoul("custom-model", tempDir)
      expect(soul).toBeDefined()
      expect(soul!.model_capabilities.min_model).toBe("sonnet")
      expect(soul!.model_capabilities.default_model).toBe("sonnet")
      expect(soul!.model_capabilities.max_model).toBe("opus")
    })
  })

  describe("v2 directory loading", () => {
    it("loads v2 directory format with identity.md", () => {
      mkdirSync(resolve(tempDir, "v2agent"), { recursive: true })
      writeFileSync(
        resolve(tempDir, "v2agent", "identity.md"),
        `---\nname: V2Agent\nrole: lead\n---\n# V2Agent\n\nA test v2 agent.\n\n## Traits\n- Smart\n- Fast\n`,
      )

      const soul = loadAndCompileSoul("v2agent", tempDir)
      expect(soul).toBeDefined()
      expect(soul!.identity.name).toBe("V2Agent")
      expect(soul!.identity.role).toBe("lead")
    })

    it("extracts voice traits from identity.md body", () => {
      mkdirSync(resolve(tempDir, "voiceagent"), { recursive: true })
      writeFileSync(
        resolve(tempDir, "voiceagent", "identity.md"),
        `---\nname: VoiceAgent\nrole: worker\n---\n# VoiceAgent\n\nA concise agent.\n\n## Traits\n- Direct\n- Thorough\n`,
      )

      const soul = loadAndCompileSoul("voiceagent", tempDir)
      expect(soul).toBeDefined()
      expect(soul!.voice).toBeDefined()
      expect(soul!.voice!.traits).toContain("Direct")
      expect(soul!.voice!.traits).toContain("Thorough")
    })

    it("collects extra .md files as extras", () => {
      mkdirSync(resolve(tempDir, "extraagent"), { recursive: true })
      writeFileSync(
        resolve(tempDir, "extraagent", "identity.md"),
        `---\nname: ExtraAgent\nrole: worker\n---\n# ExtraAgent\n\nTest.\n`,
      )
      writeFileSync(
        resolve(tempDir, "extraagent", "personality.md"),
        `---\n{}\n---\nThis agent is very friendly and outgoing.\n`,
      )

      const soul = loadAndCompileSoul("extraagent", tempDir)
      expect(soul).toBeDefined()
      expect(soul!.extras).toHaveProperty("personality")
      expect(soul!.extras.personality).toContain("friendly")
    })

    it("v2 directory takes precedence over v1 YAML", () => {
      // Create both v2 dir and v1 file
      mkdirSync(resolve(tempDir, "dual"), { recursive: true })
      writeFileSync(
        resolve(tempDir, "dual", "identity.md"),
        `---\nname: DualV2\nrole: lead\n---\n# DualV2\n\nV2 version.\n`,
      )
      writeFileSync(
        resolve(tempDir, "dual.yaml"),
        `identity:\n  name: DualV1\n  role: worker\n`,
      )

      const soul = loadAndCompileSoul("dual", tempDir)
      expect(soul).toBeDefined()
      expect(soul!.identity.name).toBe("DualV2")
      expect(soul!.identity.role).toBe("lead")
    })
  })

  describe("instanceSoulsDir", () => {
    it("loads instance.yaml from instanceSoulsDir when provided", () => {
      // Create temp instance dir with a unique instance.yaml
      const instanceSoulsDir = mkdtempSync(join(tmpdir(), "soul-instance-dir-test-"))
      try {
        writeFileSync(
          resolve(instanceSoulsDir, "instance.yaml"),
          `identity:\n  name: InstanceOverride\ncontext:\n  instance_notes: "Loaded from instanceSoulsDir"\n`,
        )
        writeFileSync(
          resolve(tempDir, "agent-inst.yaml"),
          `identity:\n  name: AgentInst\n  role: worker\ncapabilities:\n  can_delegate: false\n`,
        )

        const soul = loadAndCompileSoul("agent-inst", tempDir, instanceSoulsDir)
        expect(soul).toBeDefined()
        // Agent layer keeps its own name
        expect(soul!.identity.name).toBe("AgentInst")
        // Instance context is loaded from the override dir
        expect(soul!.context.instance_notes).toBe("Loaded from instanceSoulsDir")
      } finally {
        rmSync(instanceSoulsDir, { recursive: true, force: true })
      }
    })

    it("falls back to soulsDir instance.yaml when instanceSoulsDir has none", () => {
      writeFileSync(
        resolve(tempDir, "instance.yaml"),
        `context:\n  instance_notes: "From soulsDir fallback"\n`,
      )
      writeFileSync(
        resolve(tempDir, "agent-fallback.yaml"),
        `identity:\n  name: AgentFallback\n  role: worker\ncapabilities:\n  can_delegate: false\n`,
      )

      const emptyInstanceDir = mkdtempSync(join(tmpdir(), "soul-empty-inst-"))
      try {
        const soul = loadAndCompileSoul("agent-fallback", tempDir, emptyInstanceDir)
        expect(soul).toBeDefined()
        expect(soul!.context.instance_notes).toBe("From soulsDir fallback")
      } finally {
        rmSync(emptyInstanceDir, { recursive: true, force: true })
      }
    })

    it("ignores soulsDir instance.yaml when instanceSoulsDir provides one", () => {
      // Both dirs have instance.yaml — instanceSoulsDir wins
      writeFileSync(
        resolve(tempDir, "instance.yaml"),
        `context:\n  instance_notes: "Should NOT be loaded"\n`,
      )
      const instanceSoulsDir = mkdtempSync(join(tmpdir(), "soul-priority-test-"))
      try {
        writeFileSync(
          resolve(instanceSoulsDir, "instance.yaml"),
          `context:\n  instance_notes: "Priority instance"\n`,
        )
        writeFileSync(
          resolve(tempDir, "agent-priority.yaml"),
          `identity:\n  name: AgentPriority\n  role: worker\ncapabilities:\n  can_delegate: false\n`,
        )

        const soul = loadAndCompileSoul("agent-priority", tempDir, instanceSoulsDir)
        expect(soul).toBeDefined()
        expect(soul!.context.instance_notes).toBe("Priority instance")
        expect(soul!.context.instance_notes).not.toBe("Should NOT be loaded")
      } finally {
        rmSync(instanceSoulsDir, { recursive: true, force: true })
      }
    })

    it("loads a v2 agent directory from instanceSoulsDir when present", () => {
      const instanceSoulsDir = mkdtempSync(join(tmpdir(), "soul-v2-instance-dir-test-"))
      try {
        mkdirSync(resolve(instanceSoulsDir, "assistant"), { recursive: true })
        writeFileSync(
          resolve(instanceSoulsDir, "assistant", "identity.md"),
          `---
name: InstanceAssistant
role: lead
---
# InstanceAssistant

Loaded from the instance souls directory.
`,
        )

        const soul = loadAndCompileSoul("assistant", tempDir, instanceSoulsDir)
        expect(soul).toBeDefined()
        expect(soul!.identity.name).toBe("InstanceAssistant")
        expect(soul!.identity.role).toBe("lead")
      } finally {
        rmSync(instanceSoulsDir, { recursive: true, force: true })
      }
    })

    it("applies instance.yaml when loading a v2 agent from the engine souls directory", () => {
      const instanceSoulsDir = mkdtempSync(join(tmpdir(), "soul-v2-instance-yaml-test-"))
      try {
        writeFileSync(
          resolve(instanceSoulsDir, "instance.yaml"),
          `context:\n  instance_notes: "Loaded from v2 instance.yaml"\n  relationships:\n    - name: User\n      role: founder\n`,
        )
        mkdirSync(resolve(tempDir, "v2-instance-agent"), { recursive: true })
        writeFileSync(
          resolve(tempDir, "v2-instance-agent", "identity.md"),
          `---\nname: V2InstanceAgent\nrole: lead\n---\n# V2InstanceAgent\n\nAgent body.`,
        )

        const soul = loadAndCompileSoul("v2-instance-agent", tempDir, instanceSoulsDir)

        expect(soul).toBeDefined()
        expect(soul!.identity.name).toBe("V2InstanceAgent")
        expect(soul!.context.instance_notes).toBe("Loaded from v2 instance.yaml")
        expect(soul!.context.relationships?.[0]?.name).toBe("User")
      } finally {
        rmSync(instanceSoulsDir, { recursive: true, force: true })
      }
    })
  })

  describe("missing agents", () => {
    it("returns undefined when no file or directory exists", () => {
      const soul = loadAndCompileSoul("nonexistent", tempDir)
      expect(soul).toBeUndefined()
    })
  })

  describe("caching", () => {
    it("returns same object reference on repeated calls (cache hit)", () => {
      writeFileSync(
        resolve(tempDir, "cacheable.yaml"),
        `identity:\n  name: Cacheable\n  role: worker\ncapabilities:\n  can_delegate: false\n`,
      )

      const first = loadAndCompileSoul("cacheable", tempDir)
      const second = loadAndCompileSoul("cacheable", tempDir)
      expect(first).toBe(second) // same reference = cache hit
    })

    it("v2 directory caching works by mtime", () => {
      mkdirSync(resolve(tempDir, "v2cached"), { recursive: true })
      writeFileSync(
        resolve(tempDir, "v2cached", "identity.md"),
        `---\nname: V2Cached\nrole: worker\n---\n# V2Cached\n\nTest.\n`,
      )

      const first = loadAndCompileSoul("v2cached", tempDir)
      const second = loadAndCompileSoul("v2cached", tempDir)
      expect(first).toBe(second)
    })

    it("clearSoulCache forces recompilation", () => {
      writeFileSync(
        resolve(tempDir, "recache.yaml"),
        `identity:\n  name: Recache\n  role: worker\ncapabilities:\n  can_delegate: false\n`,
      )

      const first = loadAndCompileSoul("recache", tempDir)
      clearSoulCache()
      const second = loadAndCompileSoul("recache", tempDir)
      expect(first).not.toBe(second)
      expect(first!.identity.name).toBe(second!.identity.name)
    })
  })

  describe("validation", () => {
    it("throws on validation failure (empty name)", () => {
      writeFileSync(
        resolve(tempDir, "invalid.yaml"),
        `identity:\n  name: ""\n  role: worker\n`,
      )

      expect(() => loadAndCompileSoul("invalid", tempDir)).toThrow(/validation failed/i)
    })
  })
})

// ---------------------------------------------------------------------------
// getSoulSystemPrompt
// ---------------------------------------------------------------------------

describe("getSoulSystemPrompt", () => {
  it("returns undefined for missing agent", () => {
    const prompt = getSoulSystemPrompt("ghost", tempDir)
    expect(prompt).toBeUndefined()
  })

  describe("full tier (default)", () => {
    it("returns a prompt string containing agent name", () => {
      writeFileSync(
        resolve(tempDir, "prompted.yaml"),
        `identity:\n  name: PromptAgent\n  role: worker\ncapabilities:\n  can_delegate: false\nrules:\n  must:\n    - Be helpful\n`,
      )

      const prompt = getSoulSystemPrompt("prompted", tempDir)
      expect(prompt).toBeDefined()
      expect(prompt).toContain("PromptAgent")
    })

    it("includes rules in the prompt", () => {
      writeFileSync(
        resolve(tempDir, "ruled.yaml"),
        `identity:\n  name: RuledAgent\n  role: worker\ncapabilities:\n  can_delegate: false\nrules:\n  must:\n    - Always test\n  must_not:\n    - Skip reviews\n`,
      )

      const prompt = getSoulSystemPrompt("ruled", tempDir)
      expect(prompt).toBeDefined()
      expect(prompt).toContain("Always test")
      expect(prompt).toContain("Skip reviews")
    })

    it("includes extras in full tier", () => {
      mkdirSync(resolve(tempDir, "fullextra"), { recursive: true })
      writeFileSync(
        resolve(tempDir, "fullextra", "identity.md"),
        `---\nname: FullExtra\nrole: worker\n---\n# FullExtra\n\nTest agent.\n`,
      )
      writeFileSync(
        resolve(tempDir, "fullextra", "personality.md"),
        `---\n{}\n---\nAlways cheerful and direct.\n`,
      )

      const prompt = getSoulSystemPrompt("fullextra", tempDir, "full")
      expect(prompt).toBeDefined()
      expect(prompt).toContain("cheerful")
    })
  })

  describe("compact tier", () => {
    it("strips extras from compact prompt", () => {
      mkdirSync(resolve(tempDir, "compactagent"), { recursive: true })
      writeFileSync(
        resolve(tempDir, "compactagent", "identity.md"),
        `---\nname: CompactAgent\nrole: worker\n---\n# CompactAgent\n\nTest.\n`,
      )
      writeFileSync(
        resolve(tempDir, "compactagent", "personality.md"),
        `---\n{}\n---\nShould not appear in compact mode.\n`,
      )

      const full = getSoulSystemPrompt("compactagent", tempDir, "full")
      const compact = getSoulSystemPrompt("compactagent", tempDir, "compact")

      expect(full).toBeDefined()
      expect(compact).toBeDefined()
      expect(full).toContain("Should not appear in compact mode")
      expect(compact).not.toContain("Should not appear in compact mode")
    })

    it("compact prompt is shorter than full prompt", () => {
      mkdirSync(resolve(tempDir, "shorter"), { recursive: true })
      writeFileSync(
        resolve(tempDir, "shorter", "identity.md"),
        `---\nname: ShorterAgent\nrole: coder\n---\n# ShorterAgent\n\nA verbose agent description for testing.\n`,
      )
      writeFileSync(
        resolve(tempDir, "shorter", "personality.md"),
        `---\n{}\n---\nLong personality section that adds many tokens to the full prompt.\nThis content should be excluded in compact tier to save tokens.\nMultiple lines of personality content here.\n`,
      )

      const full = getSoulSystemPrompt("shorter", tempDir, "full")
      const compact = getSoulSystemPrompt("shorter", tempDir, "compact")

      expect(full!.length).toBeGreaterThan(compact!.length)
    })
  })

  describe("caching", () => {
    it("returns cached prompt on repeated calls", () => {
      writeFileSync(
        resolve(tempDir, "promptcache.yaml"),
        `identity:\n  name: PromptCache\n  role: worker\ncapabilities:\n  can_delegate: false\n`,
      )

      const first = getSoulSystemPrompt("promptcache", tempDir)
      const second = getSoulSystemPrompt("promptcache", tempDir)
      expect(first).toBe(second)
    })

    it("detects stale cache when mtime changes (v1)", () => {
      const filePath = resolve(tempDir, "stale.yaml")
      writeFileSync(
        filePath,
        `identity:\n  name: StaleAgent\n  role: worker\ncapabilities:\n  can_delegate: false\n`,
      )

      const first = getSoulSystemPrompt("stale", tempDir)
      expect(first).toContain("StaleAgent")

      // Touch the file to change mtime
      const future = new Date(Date.now() + 5000)
      utimesSync(filePath, future, future)

      const second = getSoulSystemPrompt("stale", tempDir)
      // Should still contain the name (recompiled from same content)
      expect(second).toContain("StaleAgent")
    })

    it("full and compact are cached independently", () => {
      writeFileSync(
        resolve(tempDir, "dualcache.yaml"),
        `identity:\n  name: DualCache\n  role: worker\ncapabilities:\n  can_delegate: false\n`,
      )

      const full = getSoulSystemPrompt("dualcache", tempDir, "full")
      const compact = getSoulSystemPrompt("dualcache", tempDir, "compact")

      // Both should contain the agent name
      expect(full).toContain("DualCache")
      expect(compact).toContain("DualCache")
    })
  })

  describe("v2 agent prompts", () => {
    it("works with v2 directory format", () => {
      mkdirSync(resolve(tempDir, "v2prompt"), { recursive: true })
      writeFileSync(
        resolve(tempDir, "v2prompt", "identity.md"),
        `---\nname: V2Prompt\nrole: lead\narchetype: lead agent\n---\n# V2Prompt\n\nA v2 agent for prompt testing.\n\n## Traits\n- Concise\n`,
      )

      const prompt = getSoulSystemPrompt("v2prompt", tempDir)
      expect(prompt).toBeDefined()
      expect(prompt).toContain("V2Prompt")
      expect(prompt).toContain("lead agent")
    })
  })
})

// ---------------------------------------------------------------------------
// MODEL_TIER_REGISTRY coverage
// ---------------------------------------------------------------------------

describe("MODEL_TIER_REGISTRY", () => {
  it("has entries for all tiers in MODEL_TIER_ORDER", () => {
    const expectedTiers: ModelTier[] = ["haiku", "flash-lite", "flash", "sonnet", "opus"]
    for (const tier of expectedTiers) {
      expect(MODEL_TIER_REGISTRY[tier]).toBeDefined()
      expect(typeof MODEL_TIER_REGISTRY[tier]).toBe("string")
    }
  })
})

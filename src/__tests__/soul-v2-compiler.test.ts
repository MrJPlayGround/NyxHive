import { describe, it, expect } from "bun:test";
import { compileSoulV2 } from "../soul/compiler-v2.js";
import type { SoulV2LoadResult, SoulFileSet } from "../soul/loader-v2.js";
import type { ParsedFrontmatter } from "../soul/frontmatter.js";

// --- Helpers ---

function pf(frontmatter: Record<string, unknown> = {}, body = ""): ParsedFrontmatter {
  return { frontmatter, body };
}

function emptyFileSet(): SoulFileSet {
  return {};
}

function emptyLoadResult(): SoulV2LoadResult {
  return {
    agent: emptyFileSet(),
    base: emptyFileSet(),
    resolved: emptyFileSet(),
    extras: {},
  };
}

// ============================================================
// Identity extraction
// ============================================================

describe("soul v2 compiler", () => {
  describe("extractIdentity", () => {
    it("extracts all identity fields from frontmatter", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({
        name: "Forge",
        role: "coder",
        archetype: "autonomous coding agent",
        tone: "direct",
        pronouns: "it/its",
      });

      const soul = compileSoulV2(loaded);
      expect(soul.identity.name).toBe("Forge");
      expect(soul.identity.role).toBe("coder");
      expect(soul.identity.archetype).toBe("autonomous coding agent");
      expect(soul.identity.tone).toBe("direct");
      expect(soul.identity.pronouns).toBe("it/its");
    });

    it("returns empty name when identity is missing", () => {
      const loaded = emptyLoadResult();
      const soul = compileSoulV2(loaded);
      expect(soul.identity.name).toBe("");
      expect(soul.identity.role).toBeUndefined();
    });

    it("returns undefined for optional fields not present", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({ name: "Scout" });

      const soul = compileSoulV2(loaded);
      expect(soul.identity.name).toBe("Scout");
      expect(soul.identity.role).toBeUndefined();
      expect(soul.identity.archetype).toBeUndefined();
      expect(soul.identity.tone).toBeUndefined();
      expect(soul.identity.pronouns).toBeUndefined();
    });
  });

  // ============================================================
  // Voice extraction
  // ============================================================

  describe("extractVoice", () => {
    it("extracts traits from ## Traits section", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({}, `# Forge

## Traits
- Clean code
- Fast iteration
- Minimal deps
`);

      const soul = compileSoulV2(loaded);
      expect(soul.voice).toBeDefined();
      expect(soul.voice!.traits).toEqual(["Clean code", "Fast iteration", "Minimal deps"]);
    });

    it("extracts description from main prose", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({}, `# Forge

Forge builds things fast and well.

## Traits
- Efficient
`);

      const soul = compileSoulV2(loaded);
      expect(soul.voice!.description).toContain("Forge builds things fast and well");
    });

    it("combines main prose and ## Tone section into description", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({}, `# Forge

Forge is the builder.

## Tone
Sharp and terse, no fluff.

## Traits
- Code first
`);

      const soul = compileSoulV2(loaded);
      expect(soul.voice!.description).toContain("Forge is the builder");
      expect(soul.voice!.description).toContain("Sharp and terse, no fluff");
    });

    it("returns undefined voice when body is empty", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({}, "");

      const soul = compileSoulV2(loaded);
      expect(soul.voice).toBeUndefined();
    });

    it("returns undefined voice when body has only a title and no content", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({}, "# Forge\n");

      const soul = compileSoulV2(loaded);
      expect(soul.voice).toBeUndefined();
    });

    it("returns voice with only description when no traits section", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({}, `# Forge

Does things well.
`);

      const soul = compileSoulV2(loaded);
      expect(soul.voice).toBeDefined();
      expect(soul.voice!.description).toContain("Does things well");
      expect(soul.voice!.traits).toBeUndefined();
    });

    it("returns voice with only traits when no prose", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({}, `# Forge
## Traits
- Efficient
- Clean
`);

      const soul = compileSoulV2(loaded);
      expect(soul.voice).toBeDefined();
      expect(soul.voice!.traits).toEqual(["Efficient", "Clean"]);
      // Description should be empty/undefined since only whitespace between title and ## Traits
    });

    it("returns undefined when identity file is missing entirely", () => {
      const loaded = emptyLoadResult();
      const soul = compileSoulV2(loaded);
      expect(soul.voice).toBeUndefined();
    });
  });

  // ============================================================
  // Rules: extractRulesFromBody / buildRules
  // ============================================================

  describe("buildRules", () => {
    describe("replace mode (default)", () => {
      it("parses must, must_not, guidelines from resolved rules body", () => {
        const loaded = emptyLoadResult();
        loaded.resolved.rules = pf({}, `## You MUST
- Log all actions
- Follow standards

## You MUST NOT
- Expose secrets
- Skip tests

## Guidelines
- Prefer readability
`);

        const soul = compileSoulV2(loaded);
        expect(soul.rules.must.map((r) => r.rule)).toEqual(["Log all actions", "Follow standards"]);
        expect(soul.rules.must_not.map((r) => r.rule)).toEqual(["Expose secrets", "Skip tests"]);
        expect(soul.rules.guidelines).toEqual(["Prefer readability"]);
      });

      it("all scoped rules have scope agent", () => {
        const loaded = emptyLoadResult();
        loaded.resolved.rules = pf({}, `## Must
- Rule one

## Must Not
- Rule two
`);

        const soul = compileSoulV2(loaded);
        expect(soul.rules.must[0].scope).toBe("agent");
        expect(soul.rules.must_not[0].scope).toBe("agent");
      });

      it("returns empty arrays when no rules file", () => {
        const loaded = emptyLoadResult();
        const soul = compileSoulV2(loaded);
        expect(soul.rules.must).toEqual([]);
        expect(soul.rules.must_not).toEqual([]);
        expect(soul.rules.guidelines).toEqual([]);
      });

      it("returns empty arrays when rules body has no sections", () => {
        const loaded = emptyLoadResult();
        loaded.resolved.rules = pf({}, "Just some text without sections.");
        const soul = compileSoulV2(loaded);
        expect(soul.rules.must).toEqual([]);
        expect(soul.rules.must_not).toEqual([]);
        expect(soul.rules.guidelines).toEqual([]);
      });

      it("ignores base rules in replace mode even when both exist", () => {
        const loaded = emptyLoadResult();
        loaded.base.rules = pf({}, `## Must
- Base rule
`);
        loaded.agent.rules = pf({}, `## Must
- Agent rule
`);
        loaded.resolved.rules = loaded.agent.rules; // agent wins

        const soul = compileSoulV2(loaded);
        const mustRules = soul.rules.must.map((r) => r.rule);
        expect(mustRules).toEqual(["Agent rule"]);
        expect(mustRules).not.toContain("Base rule");
      });
    });

    describe("additive mode", () => {
      it("combines base + agent rules", () => {
        const loaded = emptyLoadResult();
        loaded.base.rules = pf({}, `## Must
- Base rule A
- Base rule B

## Must Not
- Base no A
`);
        loaded.agent.rules = pf({ merge: "additive" }, `## Must
- Agent rule C

## Must Not
- Agent no B
`);
        loaded.resolved.rules = loaded.agent.rules;

        const soul = compileSoulV2(loaded);
        const mustRules = soul.rules.must.map((r) => r.rule);
        expect(mustRules).toContain("Base rule A");
        expect(mustRules).toContain("Base rule B");
        expect(mustRules).toContain("Agent rule C");

        const mustNotRules = soul.rules.must_not.map((r) => r.rule);
        expect(mustNotRules).toContain("Base no A");
        expect(mustNotRules).toContain("Agent no B");
      });

      it("deduplicates identical rules", () => {
        const loaded = emptyLoadResult();
        loaded.base.rules = pf({}, `## Must
- Follow standards
- Log actions
`);
        loaded.agent.rules = pf({ merge: "additive" }, `## Must
- Follow standards
- Run tests
`);
        loaded.resolved.rules = loaded.agent.rules;

        const soul = compileSoulV2(loaded);
        const mustRules = soul.rules.must.map((r) => r.rule);
        expect(mustRules).toEqual(["Follow standards", "Log actions", "Run tests"]);
      });

      it("deduplicates guidelines", () => {
        const loaded = emptyLoadResult();
        loaded.base.rules = pf({}, `## Guidelines
- Keep it simple
- Be clear
`);
        loaded.agent.rules = pf({ merge: "additive" }, `## Guidelines
- Keep it simple
- Write tests
`);
        loaded.resolved.rules = loaded.agent.rules;

        const soul = compileSoulV2(loaded);
        expect(soul.rules.guidelines).toEqual(["Keep it simple", "Be clear", "Write tests"]);
      });

      it("handles additive with no agent rules body", () => {
        const loaded = emptyLoadResult();
        loaded.base.rules = pf({}, `## Must
- Base rule
`);
        loaded.agent.rules = pf({ merge: "additive" }, "");
        loaded.resolved.rules = loaded.agent.rules;

        const soul = compileSoulV2(loaded);
        expect(soul.rules.must.map((r) => r.rule)).toEqual(["Base rule"]);
      });

      it("handles additive with no base rules", () => {
        const loaded = emptyLoadResult();
        loaded.agent.rules = pf({ merge: "additive" }, `## Must
- Agent rule
`);
        loaded.resolved.rules = loaded.agent.rules;
        // base.rules is undefined — additive short-circuits to replace

        const soul = compileSoulV2(loaded);
        // When base.rules is falsy, additive guard fails, falls through to replace
        const mustRules = soul.rules.must.map((r) => r.rule);
        expect(mustRules).toContain("Agent rule");
      });
    });
  });

  // ============================================================
  // Capabilities / buildCapabilities
  // ============================================================

  describe("buildCapabilities", () => {
    it("uses defaults when no tools file", () => {
      const loaded = emptyLoadResult();
      const soul = compileSoulV2(loaded);

      expect(soul.capabilities.invocation).toBe("sdk");
      expect(soul.capabilities.can_delegate).toBe(true);
      expect(soul.capabilities.can_read_files).toBe(true);
      expect(soul.capabilities.can_write_files).toBe(true);
      expect(soul.capabilities.can_run_commands).toBe(true);
      expect(soul.capabilities.mcp_tools).toEqual([]);
      expect(soul.capabilities.allowed_directories).toEqual([]);
      expect(soul.capabilities.max_tool_turns).toBe(9999);
    });

    it("reads capabilities from resolved tools frontmatter", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.tools = pf({
        can_write_files: false,
        can_run_commands: false,
        can_delegate: false,
        mcp_tools: ["search_knowledge"],
        allowed_directories: ["/tmp"],
        max_tool_turns: 10,
      });

      const soul = compileSoulV2(loaded);
      expect(soul.capabilities.can_write_files).toBe(false);
      expect(soul.capabilities.can_run_commands).toBe(false);
      expect(soul.capabilities.can_delegate).toBe(false);
      expect(soul.capabilities.mcp_tools).toEqual(["search_knowledge"]);
      expect(soul.capabilities.allowed_directories).toEqual(["/tmp"]);
      expect(soul.capabilities.max_tool_turns).toBe(10);
    });

    it("reads invocation from identity frontmatter first", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({ invocation: "cli" });
      loaded.resolved.tools = pf({ invocation: "sdk" });

      const soul = compileSoulV2(loaded);
      expect(soul.capabilities.invocation).toBe("cli");
    });

    it("falls back to tools invocation when identity has none", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.tools = pf({ invocation: "cli" });

      const soul = compileSoulV2(loaded);
      expect(soul.capabilities.invocation).toBe("cli");
    });

    describe("extend mode", () => {
      it("unions mcp_tools from base and agent (set union)", () => {
        const loaded = emptyLoadResult();
        loaded.base.tools = pf({
          mcp_tools: ["brave_web_search", "git_log"],
          allowed_directories: ["/home/user/dev"],
        });
        loaded.agent.tools = pf({
          merge: "extend",
          mcp_tools: ["search_knowledge", "git_log"],
          allowed_directories: ["/home/user/dev/nyxhive/src"],
        });
        loaded.resolved.tools = loaded.agent.tools;

        const soul = compileSoulV2(loaded);
        expect(soul.capabilities.mcp_tools).toContain("brave_web_search");
        expect(soul.capabilities.mcp_tools).toContain("git_log");
        expect(soul.capabilities.mcp_tools).toContain("search_knowledge");
        // git_log deduplicated via Set
        expect(soul.capabilities.mcp_tools.filter((t) => t === "git_log")).toHaveLength(1);
      });

      it("unions allowed_directories from base and agent", () => {
        const loaded = emptyLoadResult();
        loaded.base.tools = pf({
          allowed_directories: ["/dir/a", "/dir/b"],
        });
        loaded.agent.tools = pf({
          merge: "extend",
          allowed_directories: ["/dir/b", "/dir/c"],
        });
        loaded.resolved.tools = loaded.agent.tools;

        const soul = compileSoulV2(loaded);
        expect(soul.capabilities.allowed_directories).toContain("/dir/a");
        expect(soul.capabilities.allowed_directories).toContain("/dir/b");
        expect(soul.capabilities.allowed_directories).toContain("/dir/c");
        expect(soul.capabilities.allowed_directories.filter((d) => d === "/dir/b")).toHaveLength(1);
      });

      it("agent overrides scalar fields in extend mode", () => {
        const loaded = emptyLoadResult();
        loaded.base.tools = pf({
          can_delegate: true,
          can_write_files: true,
        });
        loaded.agent.tools = pf({
          merge: "extend",
          can_delegate: false,
        });
        loaded.resolved.tools = loaded.agent.tools;

        const soul = compileSoulV2(loaded);
        expect(soul.capabilities.can_delegate).toBe(false);
        // Inherited from base via spread
        expect(soul.capabilities.can_write_files).toBe(true);
      });

      it("falls back to replace when base.tools is missing", () => {
        const loaded = emptyLoadResult();
        loaded.agent.tools = pf({
          merge: "extend",
          mcp_tools: ["search_knowledge"],
        });
        loaded.resolved.tools = loaded.agent.tools;
        // base.tools is undefined

        const soul = compileSoulV2(loaded);
        // Falls through to resolved path
        expect(soul.capabilities.mcp_tools).toEqual(["search_knowledge"]);
      });
    });

    describe("context_strategy from memory", () => {
      it("extracts all context_strategy fields from memory frontmatter", () => {
        const loaded = emptyLoadResult();
        loaded.resolved.memory = pf({
          fresh_context: true,
          context_budget: 1500,
          history_budget_ratio: 0.5,
          max_messages: 20,
          include_summary: false,
          context_mode: "inject",
          inject_recency: 5,
        });

        const soul = compileSoulV2(loaded);
        const cs = soul.capabilities.context_strategy!;
        expect(cs.fresh_context).toBe(true);
        expect(cs.context_budget).toBe(1500);
        expect(cs.history_budget_ratio).toBe(0.5);
        expect(cs.max_messages).toBe(20);
        expect(cs.include_summary).toBe(false);
        expect(cs.context_mode).toBe("inject");
        expect(cs.inject_recency).toBe(5);
      });

      it("returns undefined context_strategy when memory has no relevant fields", () => {
        const loaded = emptyLoadResult();
        loaded.resolved.memory = pf({ unrelated_field: "value" });

        const soul = compileSoulV2(loaded);
        expect(soul.capabilities.context_strategy).toBeUndefined();
      });

      it("returns undefined context_strategy when no memory file", () => {
        const loaded = emptyLoadResult();
        const soul = compileSoulV2(loaded);
        expect(soul.capabilities.context_strategy).toBeUndefined();
      });

      it("partial context_strategy — only set fields included", () => {
        const loaded = emptyLoadResult();
        loaded.resolved.memory = pf({ fresh_context: true });

        const soul = compileSoulV2(loaded);
        const cs = soul.capabilities.context_strategy!;
        expect(cs.fresh_context).toBe(true);
        expect(cs.context_budget).toBeUndefined();
        expect(cs.max_messages).toBeUndefined();
      });
    });

    it("reads disallowed_tools from tools frontmatter", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.tools = pf({
        disallowed_tools: ["Bash", "Write"],
      });

      const soul = compileSoulV2(loaded);
      expect(soul.capabilities.disallowed_tools).toEqual(["Bash", "Write"]);
    });
  });

  // ============================================================
  // Model capabilities
  // ============================================================

  describe("extractModelCapabilities", () => {
    it("extracts custom model tiers from identity", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({
        min_model: "sonnet",
        default_model: "sonnet",
        max_model: "opus",
      });

      const soul = compileSoulV2(loaded);
      expect(soul.model_capabilities.min_model).toBe("sonnet");
      expect(soul.model_capabilities.default_model).toBe("sonnet");
      expect(soul.model_capabilities.max_model).toBe("opus");
    });

    it("uses defaults when no model fields specified", () => {
      const loaded = emptyLoadResult();
      const soul = compileSoulV2(loaded);
      expect(soul.model_capabilities.min_model).toBe("haiku");
      expect(soul.model_capabilities.default_model).toBe("sonnet");
      expect(soul.model_capabilities.max_model).toBe("opus");
    });

    it("partially overrides — only specified fields override defaults", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({ default_model: "haiku" });

      const soul = compileSoulV2(loaded);
      expect(soul.model_capabilities.min_model).toBe("haiku");
      expect(soul.model_capabilities.default_model).toBe("haiku");
      expect(soul.model_capabilities.max_model).toBe("opus");
    });
  });

  // ============================================================
  // Context extraction
  // ============================================================

  describe("extractContext", () => {
    it("parses relationships from ## People section", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.context = pf({ domains: ["engineering"] }, `# Context

## People
- **User** (founder) — builds NyxAI
- **Nyx** (orchestrator) — coordinates agents

## Projects
NyxHive core.
`);

      const soul = compileSoulV2(loaded);
      expect(soul.context.relationships).toHaveLength(2);
      expect(soul.context.relationships![0]).toEqual({
        name: "User",
        role: "founder",
        notes: "builds NyxAI",
      });
      expect(soul.context.relationships![1]).toEqual({
        name: "Nyx",
        role: "orchestrator",
        notes: "coordinates agents",
      });
    });

    it("parses relationship without notes", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.context = pf({}, `## People
- **Alice** (engineer)
`);

      const soul = compileSoulV2(loaded);
      expect(soul.context.relationships).toHaveLength(1);
      expect(soul.context.relationships![0]).toEqual({
        name: "Alice",
        role: "engineer",
      });
      // No notes property at all
      expect("notes" in soul.context.relationships![0]).toBe(false);
    });

    it("extracts instance_notes from ## Projects section", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.context = pf({}, `## Projects
NyxHive is the core orchestrator repo.
All agents operate here.
`);

      const soul = compileSoulV2(loaded);
      expect(soul.context.instance_notes).toContain("NyxHive is the core orchestrator repo");
      expect(soul.context.instance_notes).toContain("All agents operate here");
    });

    it("reads domains from frontmatter", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.context = pf({ domains: ["ai", "engineering"] });

      const soul = compileSoulV2(loaded);
      expect(soul.context.domains).toEqual(["ai", "engineering"]);
    });

    it("returns empty defaults when no context file", () => {
      const loaded = emptyLoadResult();
      const soul = compileSoulV2(loaded);
      expect(soul.context.domains).toEqual([]);
      expect(soul.context.relationships).toEqual([]);
      expect(soul.context.instance_notes).toBeUndefined();
    });

    it("returns empty relationships when no ## People section", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.context = pf({}, "Just some text.");
      const soul = compileSoulV2(loaded);
      expect(soul.context.relationships).toEqual([]);
    });

    it("omits instance_notes when no ## Projects section", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.context = pf({}, `## People
- **Bob** (dev)
`);
      const soul = compileSoulV2(loaded);
      expect(soul.context.instance_notes).toBeUndefined();
    });
  });

  // ============================================================
  // CLAUDE.md generation
  // ============================================================

  describe("generateRoleClaudeMd", () => {
    it("coder role gets implement-directly line", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({ name: "Forge", role: "coder" });

      const soul = compileSoulV2(loaded);
      expect(soul.claude_md.some((l) => l.includes("autonomous coding agent"))).toBe(true);
    });

    it("lead role gets lead-agent line", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({ name: "Nyx", role: "lead" });

      const soul = compileSoulV2(loaded);
      expect(soul.claude_md.some((l) => l.includes("lead agent"))).toBe(true);
      expect(soul.claude_md.some((l) => l.includes("coordinate specialist agents"))).toBe(true);
    });

    it("orchestrator role gets delegation line", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({ name: "Coord", role: "orchestrator" });

      const soul = compileSoulV2(loaded);
      expect(soul.claude_md.some((l) => l.includes("delegating via [@agent: task]"))).toBe(true);
      expect(soul.claude_md.some((l) => l.includes("never implement directly"))).toBe(true);
    });

    it("unknown role produces no role-specific line", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({ name: "X", role: "analyst" });

      const soul = compileSoulV2(loaded);
      expect(soul.claude_md.some((l) => l.includes("autonomous coding agent"))).toBe(false);
      expect(soul.claude_md.some((l) => l.includes("lead agent"))).toBe(false);
      expect(soul.claude_md.some((l) => l.includes("delegating via"))).toBe(false);
    });

    it("can_write_files true adds file-write line", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({ name: "W" });
      // Default capabilities have can_write_files = true

      const soul = compileSoulV2(loaded);
      expect(soul.claude_md.some((l) => l.includes("file write access"))).toBe(true);
    });

    it("can_write_files false omits file-write line", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({ name: "R" });
      loaded.resolved.tools = pf({ can_write_files: false });

      const soul = compileSoulV2(loaded);
      expect(soul.claude_md.some((l) => l.includes("file write access"))).toBe(false);
    });

    it("can_delegate false adds cannot-delegate line", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({ name: "Solo" });
      loaded.resolved.tools = pf({ can_delegate: false });

      const soul = compileSoulV2(loaded);
      expect(soul.claude_md.some((l) => l.includes("cannot delegate"))).toBe(true);
    });

    it("fresh_context true adds starts-fresh line", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({ name: "Fresh" });
      loaded.resolved.memory = pf({ fresh_context: true });

      const soul = compileSoulV2(loaded);
      expect(soul.claude_md.some((l) => l.includes("starts fresh"))).toBe(true);
    });

    it("no fresh_context omits starts-fresh line", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({ name: "Normal" });

      const soul = compileSoulV2(loaded);
      expect(soul.claude_md.some((l) => l.includes("starts fresh"))).toBe(false);
    });

    it("combines role + capability lines", () => {
      const loaded = emptyLoadResult();
      loaded.resolved.identity = pf({ name: "Forge", role: "coder" });
      loaded.resolved.tools = pf({ can_delegate: false });
      loaded.resolved.memory = pf({ fresh_context: true });

      const soul = compileSoulV2(loaded);
      expect(soul.claude_md.length).toBeGreaterThanOrEqual(3);
      expect(soul.claude_md.some((l) => l.includes("autonomous coding agent"))).toBe(true);
      expect(soul.claude_md.some((l) => l.includes("file write access"))).toBe(true);
      expect(soul.claude_md.some((l) => l.includes("cannot delegate"))).toBe(true);
      expect(soul.claude_md.some((l) => l.includes("starts fresh"))).toBe(true);
    });
  });

  // ============================================================
  // Extras
  // ============================================================

  describe("extras", () => {
    it("includes extra .md files with body content", () => {
      const loaded = emptyLoadResult();
      loaded.extras = {
        personality: pf({}, "Be witty and concise."),
        philosophy: pf({}, "Think deeply.\nAct decisively."),
      };

      const soul = compileSoulV2(loaded);
      expect(soul.extras.personality).toBe("Be witty and concise.");
      expect(soul.extras.philosophy).toBe("Think deeply.\nAct decisively.");
    });

    it("skips extras with empty body", () => {
      const loaded = emptyLoadResult();
      loaded.extras = {
        empty: pf({}, ""),
        whitespace: pf({}, "   \n  \n  "),
        real: pf({}, "Content here."),
      };

      const soul = compileSoulV2(loaded);
      expect(soul.extras.empty).toBeUndefined();
      expect(soul.extras.whitespace).toBeUndefined();
      expect(soul.extras.real).toBe("Content here.");
    });

    it("returns empty extras when none provided", () => {
      const loaded = emptyLoadResult();
      const soul = compileSoulV2(loaded);
      expect(soul.extras).toEqual({});
    });

    it("trims extra body content", () => {
      const loaded = emptyLoadResult();
      loaded.extras = {
        padded: pf({}, "\n\n  Content with padding.  \n\n"),
      };

      const soul = compileSoulV2(loaded);
      expect(soul.extras.padded).toBe("Content with padding.");
    });
  });

  // ============================================================
  // Full compileSoulV2 end-to-end
  // ============================================================

  describe("compileSoulV2 end-to-end", () => {
    it("compiles a fully populated soul", () => {
      const loaded: SoulV2LoadResult = {
        agent: {
          identity: pf({
            name: "Forge",
            role: "coder",
            archetype: "autonomous coding agent",
            tone: "direct",
            pronouns: "it/its",
            invocation: "cli",
            min_model: "sonnet",
            default_model: "sonnet",
            max_model: "opus",
          }, `# Forge

Forge builds fast.

## Tone
Terse and precise.

## Traits
- Clean code
- Test-driven
`),
          rules: pf({ merge: "additive" }, `## Must
- Run tests before committing

## Must Not
- Modify config without approval

## Guidelines
- Small PRs
`),
          tools: pf({
            merge: "extend",
            mcp_tools: ["search_knowledge", "git_log"],
            can_delegate: false,
            allowed_directories: ["/home/user/dev/nyxhive/src"],
          }),
          memory: pf({ fresh_context: true, context_budget: 1500 }),
        },
        base: {
          rules: pf({}, `## Must
- Log all actions
- Run tests before committing

## Must Not
- Expose secrets

## Guidelines
- Prefer readability
`),
          tools: pf({
            mcp_tools: ["brave_web_search", "git_log"],
            can_delegate: true,
            can_write_files: true,
            allowed_directories: ["/home/user/dev/nyxhive"],
          }),
          context: pf({ domains: ["engineering", "ai"] }, `## People
- **User** (founder) — builds NyxAI

## Projects
NyxHive is the core.
`),
          memory: pf({ context_budget: 2000, max_messages: 50 }),
        },
        resolved: {
          identity: pf({
            name: "Forge",
            role: "coder",
            archetype: "autonomous coding agent",
            tone: "direct",
            pronouns: "it/its",
            invocation: "cli",
            min_model: "sonnet",
            default_model: "sonnet",
            max_model: "opus",
          }, `# Forge

Forge builds fast.

## Tone
Terse and precise.

## Traits
- Clean code
- Test-driven
`),
          rules: pf({ merge: "additive" }, `## Must
- Run tests before committing

## Must Not
- Modify config without approval

## Guidelines
- Small PRs
`),
          tools: pf({
            merge: "extend",
            mcp_tools: ["search_knowledge", "git_log"],
            can_delegate: false,
            allowed_directories: ["/home/user/dev/nyxhive/src"],
          }),
          context: pf({ domains: ["engineering", "ai"] }, `## People
- **User** (founder) — builds NyxAI

## Projects
NyxHive is the core.
`),
          memory: pf({ fresh_context: true, context_budget: 1500 }),
        },
        extras: {
          personality: pf({}, "Be witty."),
        },
      };

      const soul = compileSoulV2(loaded);

      // Identity
      expect(soul.identity.name).toBe("Forge");
      expect(soul.identity.role).toBe("coder");

      // Voice
      expect(soul.voice).toBeDefined();
      expect(soul.voice!.description).toContain("Forge builds fast");
      expect(soul.voice!.description).toContain("Terse and precise");
      expect(soul.voice!.traits).toEqual(["Clean code", "Test-driven"]);

      // Rules — additive merge
      const mustRules = soul.rules.must.map((r) => r.rule);
      expect(mustRules).toContain("Log all actions");
      expect(mustRules).toContain("Run tests before committing");
      // Deduplicated
      expect(mustRules.filter((r) => r === "Run tests before committing")).toHaveLength(1);

      const mustNotRules = soul.rules.must_not.map((r) => r.rule);
      expect(mustNotRules).toContain("Expose secrets");
      expect(mustNotRules).toContain("Modify config without approval");

      expect(soul.rules.guidelines).toContain("Prefer readability");
      expect(soul.rules.guidelines).toContain("Small PRs");

      // Capabilities — extend merge
      expect(soul.capabilities.mcp_tools).toContain("brave_web_search");
      expect(soul.capabilities.mcp_tools).toContain("search_knowledge");
      expect(soul.capabilities.mcp_tools).toContain("git_log");
      expect(soul.capabilities.mcp_tools.filter((t) => t === "git_log")).toHaveLength(1);
      expect(soul.capabilities.can_delegate).toBe(false);
      expect(soul.capabilities.can_write_files).toBe(true);
      expect(soul.capabilities.allowed_directories).toContain("/home/user/dev/nyxhive");
      expect(soul.capabilities.allowed_directories).toContain("/home/user/dev/nyxhive/src");
      expect(soul.capabilities.invocation).toBe("cli");

      // Context strategy from memory
      expect(soul.capabilities.context_strategy!.fresh_context).toBe(true);
      expect(soul.capabilities.context_strategy!.context_budget).toBe(1500);

      // Model capabilities
      expect(soul.model_capabilities.min_model).toBe("sonnet");
      expect(soul.model_capabilities.default_model).toBe("sonnet");
      expect(soul.model_capabilities.max_model).toBe("opus");

      // Context
      expect(soul.context.domains).toEqual(["engineering", "ai"]);
      expect(soul.context.relationships).toHaveLength(1);
      expect(soul.context.relationships![0].name).toBe("User");
      expect(soul.context.instance_notes).toContain("NyxHive is the core");

      // CLAUDE.md
      expect(soul.claude_md.some((l) => l.includes("autonomous coding agent"))).toBe(true);
      expect(soul.claude_md.some((l) => l.includes("cannot delegate"))).toBe(true);
      expect(soul.claude_md.some((l) => l.includes("starts fresh"))).toBe(true);
      expect(soul.claude_md.some((l) => l.includes("file write access"))).toBe(true);

      // Extras
      expect(soul.extras.personality).toBe("Be witty.");
    });

    it("compiles a minimal soul with empty load result", () => {
      const loaded = emptyLoadResult();
      const soul = compileSoulV2(loaded);

      expect(soul.identity.name).toBe("");
      expect(soul.voice).toBeUndefined();
      expect(soul.rules.must).toEqual([]);
      expect(soul.rules.must_not).toEqual([]);
      expect(soul.rules.guidelines).toEqual([]);
      expect(soul.capabilities.invocation).toBe("sdk");
      expect(soul.capabilities.context_strategy).toBeUndefined();
      expect(soul.model_capabilities.min_model).toBe("haiku");
      expect(soul.model_capabilities.default_model).toBe("sonnet");
      expect(soul.model_capabilities.max_model).toBe("opus");
      expect(soul.context.domains).toEqual([]);
      expect(soul.context.relationships).toEqual([]);
      expect(soul.context.instance_notes).toBeUndefined();
      expect(soul.claude_md).toEqual([
        "You have file write access. Implement changes by editing files directly.",
      ]);
      expect(soul.extras).toEqual({});
    });
  });
});

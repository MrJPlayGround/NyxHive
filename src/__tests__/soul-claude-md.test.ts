import { describe, it, expect } from "bun:test";
import { compileSoul, renderClaudeMd } from "../soul/compiler.js";
import type { SoulLayer } from "../soul/types.js";

describe("Soul CLAUDE.md compilation", () => {
  // Minimal instance layer for tests
  const instanceLayer: SoulLayer = {
    rules: {
      must: [{ rule: "Be direct", scope: "global" }],
    },
    claude_md: [
      "You are a NyxHive agent. Execute delegated tasks autonomously.",
      "Instructions in ~/.claude/CLAUDE.md are for the human operator, not for agents.",
    ],
  };

  describe("auto-generation from role + capabilities", () => {
    it("generates 'implement directly' for role: coder", () => {
      const layer: SoulLayer = {
        identity: { name: "Forge", role: "coder" },
        capabilities: {
          can_write_files: true,
          can_delegate: false,
          context_strategy: { fresh_context: true },
        },
      };
      const soul = compileSoul([layer]);
      expect(soul.claude_md.some(l => l.includes("implement code directly"))).toBe(true);
      expect(soul.claude_md.some(l => l.includes("NEVER write plan files"))).toBe(true);
    });

    it("generates 'delegate via tags' for role: orchestrator", () => {
      const layer: SoulLayer = {
        identity: { name: "Nyx", role: "orchestrator" },
        capabilities: { can_delegate: true },
      };
      const soul = compileSoul([layer]);
      expect(soul.claude_md.some(l => l.includes("delegating via [@agent: task] tags"))).toBe(true);
      expect(soul.claude_md.some(l => l.includes("never implement directly"))).toBe(true);
    });

    it("generates 'cannot delegate' for can_delegate: false", () => {
      const layer: SoulLayer = {
        identity: { name: "Forge", role: "coder" },
        capabilities: { can_delegate: false },
      };
      const soul = compileSoul([layer]);
      expect(soul.claude_md.some(l => l.includes("cannot delegate"))).toBe(true);
    });

    it("generates fresh_context instruction", () => {
      const layer: SoulLayer = {
        identity: { name: "Forge", role: "coder" },
        capabilities: { context_strategy: { fresh_context: true } },
      };
      const soul = compileSoul([layer]);
      expect(soul.claude_md.some(l => l.includes("starts fresh"))).toBe(true);
    });

    it("generates file write instruction for can_write_files", () => {
      const layer: SoulLayer = {
        identity: { name: "Vigil" },
        capabilities: { can_write_files: true },
      };
      const soul = compileSoul([layer]);
      expect(soul.claude_md.some(l => l.includes("file write access"))).toBe(true);
    });

    it("generates minimal lines for agent with no role and restricted capabilities", () => {
      const layer: SoulLayer = {
        identity: { name: "Heartbeat" },
        capabilities: {
          can_write_files: false,
          can_read_files: false,
          can_run_commands: false,
        },
      };
      const soul = compileSoul([layer]);
      // Only the AskUserQuestion warning (no role match, no special capabilities)
      expect(soul.claude_md.length).toBe(1);
      expect(soul.claude_md[0]).toContain("AskUserQuestion");
    });
  });

  describe("layer merging", () => {
    it("merges instance + agent claude_md additively", () => {
      const agentLayer: SoulLayer = {
        identity: { name: "Forge", role: "coder" },
        capabilities: { can_write_files: true, can_delegate: false },
        claude_md: [
          "Run bun test after changes.",
          "Batch related edits to control cost.",
        ],
      };
      const soul = compileSoul([instanceLayer, agentLayer]);

      // Auto-generated from role
      expect(soul.claude_md.some(l => l.includes("implement code directly"))).toBe(true);
      // From instance layer
      expect(soul.claude_md.some(l => l.includes("Execute delegated tasks autonomously"))).toBe(true);
      // From agent layer
      expect(soul.claude_md.some(l => l.includes("Run bun test"))).toBe(true);
      expect(soul.claude_md.some(l => l.includes("Batch related edits"))).toBe(true);
    });

    it("deduplicates identical lines across layers", () => {
      const layer1: SoulLayer = {
        identity: { name: "Test" },
        claude_md: ["Same instruction"],
      };
      const layer2: SoulLayer = {
        claude_md: ["Same instruction", "Different instruction"],
      };
      const soul = compileSoul([layer1, layer2]);
      const sameCount = soul.claude_md.filter(l => l === "Same instruction").length;
      expect(sameCount).toBe(1);
      expect(soul.claude_md.some(l => l === "Different instruction")).toBe(true);
    });

    it("preserves order: auto-generated first, then instance, then agent", () => {
      const agentLayer: SoulLayer = {
        identity: { name: "Forge", role: "coder" },
        capabilities: { can_write_files: true },
        claude_md: ["Agent-specific line"],
      };
      const instLayer: SoulLayer = {
        claude_md: ["Instance-wide line"],
      };
      const soul = compileSoul([instLayer, agentLayer]);

      const autoIdx = soul.claude_md.findIndex(l => l.includes("implement code directly"));
      const instIdx = soul.claude_md.findIndex(l => l === "Instance-wide line");
      const agentIdx = soul.claude_md.findIndex(l => l === "Agent-specific line");

      expect(autoIdx).toBeLessThan(instIdx);
      expect(instIdx).toBeLessThan(agentIdx);
    });
  });

  describe("renderClaudeMd", () => {
    it("renders header with agent name and pointer to repo root", () => {
      const soul = compileSoul([{
        identity: { name: "Forge", role: "coder" },
        capabilities: { can_write_files: true },
        claude_md: ["Custom instruction"],
      }]);
      const md = renderClaudeMd(soul);
      expect(md).toContain("# Forge — NyxHive Agent");
      expect(md).toContain("Read your soul files at session start");
    });

    it("uses agent name from identity", () => {
      const soul = compileSoul([{
        identity: { name: "Heartbeat" },
        capabilities: { can_write_files: false, can_read_files: false, can_run_commands: false },
      }]);
      const md = renderClaudeMd(soul);
      expect(md).toContain("# Heartbeat — NyxHive Agent");
    });

    it("always outputs the pointer line regardless of claude_md content", () => {
      const soul = compileSoul([{
        identity: { name: "Test" },
        claude_md: ["Line one", "Line two"],
      }]);
      const md = renderClaudeMd(soul);
      expect(md).toContain("CLAUDE.md in the repo root");
    });
  });

  describe("integration with existing soul features", () => {
    it("claude_md does not appear in extras", () => {
      const soul = compileSoul([{
        identity: { name: "Test" },
        claude_md: ["Some instruction"],
      }]);
      expect(soul.extras).not.toHaveProperty("claude_md");
    });

    it("compiles alongside all other soul properties", () => {
      const fullLayer: SoulLayer = {
        identity: { name: "Forge", role: "coder", tone: "Precise" },
        voice: { description: "Direct", traits: ["methodical"] },
        capabilities: {
          invocation: "cli",
          can_write_files: true,
          can_delegate: false,
          max_tool_turns: 50,
          allowed_directories: ["/home/user/dev"],
        },
        rules: {
          must: ["Read code first"],
          must_not: ["Over-engineer"],
        },
        model_capabilities: { min_model: "opus", default_model: "opus", max_model: "opus" },
        claude_md: ["Commit with conventional style"],
      };
      const soul = compileSoul([instanceLayer, fullLayer]);

      // All standard fields still work
      expect(soul.identity.name).toBe("Forge");
      expect(soul.voice?.traits).toContain("methodical");
      expect(soul.capabilities.can_write_files).toBe(true);
      expect(soul.rules.must.length).toBeGreaterThan(0);
      expect(soul.model_capabilities.min_model).toBe("opus");
      // claude_md is populated
      expect(soul.claude_md.length).toBeGreaterThan(0);
      expect(soul.claude_md.some(l => l.includes("Commit with conventional style"))).toBe(true);
    });
  });
});

import { describe, it, expect } from "bun:test";
import {
  buildDelegationEnvelope,
  buildContinuationPrompt,
  getPatternContext,
} from "../queue/delegation-executor.js";
import type { ActorMention } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMention(overrides: Partial<ActorMention> = {}): ActorMention {
  return {
    agent: "tester",
    task: "run the tests",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildDelegationEnvelope
// ---------------------------------------------------------------------------

describe("buildDelegationEnvelope", () => {
  it("1 — basic envelope with user message and reasoning", () => {
    const env = buildDelegationEnvelope("fix the bug", "need to patch X", makeMention());
    expect(env).toContain("[Delegation Context]");
    expect(env).toContain('Original request: "fix the bug"');
    expect(env).toContain("Orchestrator reasoning: need to patch X");
  });

  it("2 — long user message truncated to 500 chars", () => {
    const longMsg = "a".repeat(1000);
    const env = buildDelegationEnvelope(longMsg, null, makeMention());
    // The quoted portion should be at most 500 chars
    const match = env.match(/Original request: "([^"]*)"/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(500);
  });

  it("3 — long reasoning truncated to 1000 chars", () => {
    const longReasoning = "r".repeat(2000);
    const env = buildDelegationEnvelope("msg", longReasoning, makeMention());
    const match = env.match(/Orchestrator reasoning: (.+)/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(1000);
  });

  it("4 — with contract fields", () => {
    const mention = makeMention({
      contract: {
        task: "run the tests",
        agent: "tester",
        inputFiles: ["src/a.ts", "src/b.ts"],
        outputFiles: ["src/c.ts"],
        excludeFiles: ["src/config.ts"],
        constraints: ["no breaking changes"],
        verification: ["bun test"],
        successCriteria: ["all tests pass"],
        outputType: "code-change",
        shouldCommit: true,
        priority: "blocking",
        dependsOn: ["task-1"],
        extractionMethod: "heuristic",
      },
    });
    const env = buildDelegationEnvelope("do it", "because", mention);
    // Files referenced by relative path (not inlined since they don't exist on disk)
    expect(env).toContain("src/a.ts");
    expect(env).toContain("src/b.ts");
    expect(env).toContain("Output files: src/c.ts");
    expect(env).toContain("Do NOT modify: src/config.ts");
    expect(env).toContain("Constraints: no breaking changes");
    expect(env).toContain("Verification: bun test");
    expect(env).toContain("Success criteria: all tests pass");
    expect(env).toContain("Expected output: code-change (commit)");
    expect(env).toContain("Priority: blocking");
    expect(env).toContain("Depends on: task-1");
  });

  it("5 — without contract uses legacy filePaths and verifyHints", () => {
    const mention = makeMention({
      filePaths: ["src/x.ts"],
      verifyHints: ["run lint"],
    });
    const env = buildDelegationEnvelope("msg", null, mention);
    // Legacy fields — files referenced by relative path (not inlined)
    expect(env).toContain("src/x.ts");
    expect(env).toContain("Verification: run lint");
    // Should NOT contain contract-specific fields
    expect(env).not.toContain("Output files:");
  });

  it("6 — empty contract arrays omitted", () => {
    const mention = makeMention({
      contract: {
        task: "run the tests",
        agent: "tester",
        inputFiles: [],
        outputFiles: [],
        excludeFiles: [],
        constraints: [],
        verification: [],
        successCriteria: [],
        outputType: "code-change",
        shouldCommit: false,
        priority: "normal",
        dependsOn: [],
        extractionMethod: "heuristic",
      },
    });
    const env = buildDelegationEnvelope("msg", null, mention);
    expect(env).not.toContain("Input files:");
    expect(env).not.toContain("Output files:");
    expect(env).not.toContain("Do NOT modify:");
    expect(env).not.toContain("Constraints:");
    expect(env).not.toContain("Verification:");
    expect(env).not.toContain("Success criteria:");
    expect(env).not.toContain("Priority:");
    expect(env).not.toContain("Depends on:");
    // outputType is always included
    expect(env).toContain("Expected output: code-change");
    // shouldCommit false => no "(commit)"
    expect(env).not.toContain("(commit)");
  });

  it("7 — pattern context appended when provided", () => {
    const env = buildDelegationEnvelope("msg", null, makeMention(), "[Learned patterns]\n- always test");
    expect(env).toContain("[Learned patterns]\n- always test");
  });

  it("8 — envelope ends with [Your Task] marker", () => {
    const env = buildDelegationEnvelope("msg", null, makeMention());
    const lines = env.trimEnd().split("\n");
    // Last non-empty line should be "[Your Task]"
    const lastNonEmpty = lines.filter(l => l.trim().length > 0).pop();
    expect(lastNonEmpty).toBe("[Your Task]");
  });

  it("8b — caps oversized delegation envelope but preserves task marker", () => {
    const mention = makeMention({
      contract: {
        task: "run the tests",
        agent: "tester",
        inputFiles: [],
        outputFiles: [],
        excludeFiles: [],
        constraints: ["constraint detail ".repeat(3000)],
        verification: ["verify detail ".repeat(3000)],
        successCriteria: ["success detail ".repeat(3000)],
        outputType: "code-change",
        shouldCommit: false,
        priority: "normal",
        dependsOn: [],
        extractionMethod: "heuristic",
      },
    });

    const env = buildDelegationEnvelope("msg", "reasoning", mention);
    expect(env).toContain("delegation context trimmed for token budget");
    expect(env).toContain("[Your Task]");
  });
});

// ---------------------------------------------------------------------------
// buildContinuationPrompt
// ---------------------------------------------------------------------------

describe("buildContinuationPrompt", () => {
  it("9 — includes original task text", () => {
    const prompt = buildContinuationPrompt("fix auth bug", "I started fixing it");
    expect(prompt).toContain("Original task: fix auth bug");
  });

  it("10 — long original task truncated to 1000 chars", () => {
    const longTask = "t".repeat(2000);
    const prompt = buildContinuationPrompt(longTask, "progress");
    const match = prompt.match(/Original task: (t+)/);
    expect(match).not.toBeNull();
    expect(match![1].length).toBe(1000);
  });

  it("11 — short previous response included in full in Last Working State", () => {
    const shortResponse = "Did step 1 and step 2";
    const prompt = buildContinuationPrompt("task", shortResponse);
    expect(prompt).toContain("## Last Working State");
    expect(prompt).toContain(shortResponse);
  });

  it("12 — long previous response caps Last Working State at 1500 chars", () => {
    const longResponse = "x".repeat(5000);
    const prompt = buildContinuationPrompt("task", longResponse);
    // Should contain the tail with ... prefix
    expect(prompt).toContain("..." + "x".repeat(1500));
    // Should NOT contain the full 5000-char response in the state section
    expect(prompt).not.toContain("x".repeat(5000));
  });

  it("13 — contains continuation header", () => {
    const prompt = buildContinuationPrompt("task", "progress");
    expect(prompt).toContain("[Continuation — Previous Session Hit Turn Limit]");
  });

  it("14 — contains instruction to continue, not redo work", () => {
    const prompt = buildContinuationPrompt("task", "progress");
    expect(prompt).toContain("do not redo what was already done");
  });

  it("15b — includes progress summary with extracted essence", () => {
    const response = [
      "## Working on auth fix",
      "- Fixed src/auth/session.ts to handle expired tokens",
      "- Added error handling for invalid credentials",
      "Decision: chose JWT over session cookies because stateless is simpler",
      "Error: initial approach with bcrypt failed due to async issue",
      "Created src/__tests__/auth.test.ts with 12 new tests",
      "Some filler text that is not high signal at all",
      "More filler padding content here",
    ].join("\n");
    const prompt = buildContinuationPrompt("fix auth", response);
    expect(prompt).toContain("## Progress Summary");
    // Essence should extract high-signal lines (file paths, decisions, errors)
    expect(prompt).toContain("src/auth/session.ts");
    expect(prompt).toContain("error");
  });

  it("16b — includes do-not-retry instruction", () => {
    const prompt = buildContinuationPrompt("task", "some progress");
    expect(prompt).toContain("Do NOT retry approaches that resulted in errors listed above.");
  });

  it("17b — handles empty previous response", () => {
    const prompt = buildContinuationPrompt("task", "");
    expect(prompt).toContain("[Continuation — Previous Session Hit Turn Limit]");
    expect(prompt).toContain("## Progress Summary");
    expect(prompt).toContain("## Last Working State");
    expect(prompt).toContain("Original task: task");
  });
});

// ---------------------------------------------------------------------------
// getPatternContext
// ---------------------------------------------------------------------------

describe("getPatternContext", () => {
  it("15 — returns null when patterns store is not configured", () => {
    const ctx = { config: {} } as any;
    const result = getPatternContext(ctx, "nyx");
    expect(result).toBeNull();
  });

  it("16 — returns formatted patterns from store", () => {
    const ctx = {
      config: {
        patterns: {
          searchRelevant: (_opts: any) => [{ pattern: "test", agent: "nyx" }],
          formatForInjection: (patterns: any[]) =>
            patterns.length > 0 ? "[Learned patterns]\n- test pattern" : null,
        },
      },
    } as any;
    const result = getPatternContext(ctx, "nyx", ["src/a.ts"]);
    expect(result).toBe("[Learned patterns]\n- test pattern");
  });

  it("17 — handles errors gracefully (returns null on throw)", () => {
    const ctx = {
      config: {
        patterns: {
          searchRelevant: () => {
            throw new Error("db broke");
          },
          formatForInjection: () => null,
        },
      },
    } as any;
    const result = getPatternContext(ctx, "nyx");
    expect(result).toBeNull();
  });
});

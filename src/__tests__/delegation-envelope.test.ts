import { describe, it, expect } from "bun:test";
import { buildDelegationEnvelope, buildContinuationPrompt } from "../queue/delegation-executor.js";
import type { ActorMention } from "../types.js";

describe("buildDelegationEnvelope", () => {
  const baseMention: ActorMention = {
    agent: "Tester",
    task: "Run the tests",
  };

  it("builds basic envelope with user message and task", () => {
    const result = buildDelegationEnvelope("Fix the bug in auth", null, baseMention);

    expect(result).toContain("[Delegation Context]");
    expect(result).toContain('Original request: "Fix the bug in auth"');
    expect(result).toContain("[Your Task]");
  });

  it("includes orchestrator reasoning when provided", () => {
    const result = buildDelegationEnvelope(
      "Fix auth",
      "The auth module has a race condition in token refresh",
      baseMention,
    );

    expect(result).toContain("Orchestrator reasoning: The auth module has a race condition");
  });

  it("truncates long user messages to 500 chars", () => {
    const longMsg = "x".repeat(1000);
    const result = buildDelegationEnvelope(longMsg, null, baseMention);

    const requestLine = result.split("\n").find(l => l.includes("Original request:"));
    expect(requestLine!.length).toBeLessThan(600);
  });

  it("truncates long reasoning to 1000 chars", () => {
    const longReasoning = "y".repeat(2000);
    const result = buildDelegationEnvelope("Fix it", longReasoning, baseMention);

    const reasoningLine = result.split("\n").find(l => l.includes("Orchestrator reasoning:"));
    expect(reasoningLine!.length).toBeLessThan(1100);
  });

  it("includes contract fields when present", () => {
    const mention: ActorMention = {
      agent: "Tester",
      task: "Test auth module",
      contract: {
        task: "Test auth module",
        agent: "Tester",
        extractionMethod: "heuristic",
        inputFiles: ["src/auth/session.ts"],
        outputFiles: ["src/auth/session.test.ts"],
        excludeFiles: ["src/auth/config.ts"],
        constraints: ["Do not modify production code"],
        verification: ["bun test src/__tests__/auth.test.ts"],
        successCriteria: ["All tests pass"],
        outputType: "code-change",
        shouldCommit: true,
        priority: "blocking",
        dependsOn: ["task-1"],
      },
    };

    const result = buildDelegationEnvelope("Test auth", null, mention);

    // Files referenced by relative path (not inlined since they don't exist on disk)
    expect(result).toContain("src/auth/session.ts");
    expect(result).toContain("Output files: src/auth/session.test.ts");
    expect(result).toContain("Do NOT modify: src/auth/config.ts");
    expect(result).toContain("Constraints: Do not modify production code");
    expect(result).toContain("Verification: bun test src/__tests__/auth.test.ts");
    expect(result).toContain("Success criteria: All tests pass");
    expect(result).toContain("Expected output: code-change (commit)");
    expect(result).toContain("Priority: blocking");
    expect(result).toContain("Depends on: task-1");
  });

  it("uses legacy filePaths/verifyHints when no contract", () => {
    const mention: ActorMention = {
      agent: "Tester",
      task: "Test it",
      filePaths: ["src/foo.ts", "src/bar.ts"],
      verifyHints: ["bun test", "bun run typecheck"],
    };

    const result = buildDelegationEnvelope("Fix foo", null, mention);

    // Legacy fields — files referenced by relative path (not inlined)
    expect(result).toContain("src/foo.ts");
    expect(result).toContain("src/bar.ts");
    expect(result).toContain("Verification: bun test; bun run typecheck");
  });

  it("includes pattern context when provided", () => {
    const result = buildDelegationEnvelope(
      "Fix auth",
      null,
      baseMention,
      "[Learned Pattern] Always run tests before committing",
    );

    expect(result).toContain("[Learned Pattern] Always run tests before committing");
  });

  it("omits contract fields that are empty", () => {
    const mention: ActorMention = {
      agent: "Tester",
      task: "Test",
      contract: {
        task: "Test",
        agent: "Tester",
        extractionMethod: "heuristic",
        inputFiles: [],
        outputFiles: [],
        excludeFiles: [],
        constraints: [],
        verification: [],
        successCriteria: [],
        outputType: "unknown",
        shouldCommit: false,
        priority: "normal",
        dependsOn: [],
      },
    };

    const result = buildDelegationEnvelope("Do it", null, mention);

    expect(result).not.toContain("Input files:");
    expect(result).not.toContain("Output files:");
    expect(result).not.toContain("Do NOT modify:");
    expect(result).not.toContain("Priority:");
    expect(result).toContain("Expected output: unknown");
  });
});

describe("buildContinuationPrompt", () => {
  it("includes original task and progress with structured sections", () => {
    const result = buildContinuationPrompt(
      "Fix the authentication bug",
      "I've identified the issue in session.ts line 42",
    );

    expect(result).toContain("[Continuation — Previous Session Hit Turn Limit]");
    expect(result).toContain("Original task: Fix the authentication bug");
    expect(result).toContain("I've identified the issue in session.ts line 42");
    expect(result).toContain("## Progress Summary");
    expect(result).toContain("## Last Working State");
    expect(result).toContain("Continue from the progress summary above.");
  });

  it("truncates original task to 1000 chars", () => {
    const longTask = "z".repeat(2000);
    const result = buildContinuationPrompt(longTask, "progress");

    const taskLine = result.split("\n").find(l => l.includes("Original task:"));
    expect(taskLine!.length).toBeLessThanOrEqual(1020);
  });

  it("caps Last Working State at 1500 chars", () => {
    const longResponse = "a".repeat(5000) + "IMPORTANT_TAIL";
    const result = buildContinuationPrompt("task", longResponse);

    // Tail is preserved in Last Working State
    expect(result).toContain("IMPORTANT_TAIL");
    // Extract the section and check size
    const stateStart = result.indexOf("## Last Working State");
    const stateEnd = result.indexOf("[Instructions]");
    const stateSection = result.slice(stateStart, stateEnd);
    expect(stateSection.length).toBeLessThan(1700);
  });

  it("preserves short responses fully", () => {
    const result = buildContinuationPrompt("task", "short progress");
    expect(result).toContain("short progress");
    expect(result).not.toContain("...");
  });

  it("adds ... prefix for truncated responses", () => {
    const longResponse = "x".repeat(5000);
    const result = buildContinuationPrompt("task", longResponse);
    expect(result).toContain("...");
  });

  it("includes do-not-retry instruction", () => {
    const result = buildContinuationPrompt("task", "progress");
    expect(result).toContain("Do NOT retry approaches that resulted in errors listed above.");
  });
});

import { describe, test, expect } from "bun:test";
import { buildSystemPrompt, type SystemPromptDeps } from "../queue/system-prompt-builder.js";

function minimalDeps(overrides: Partial<SystemPromptDeps> = {}): SystemPromptDeps {
  return {
    canOrchestrate: () => false,
    activeDelegations: new Map(),
    ...overrides,
  };
}

describe("Delegation Depth Guard", () => {
  test("no depth guard at depth 0", () => {
    const result = buildSystemPrompt(
      minimalDeps({ delegationDepth: 0 }),
      "forge", undefined, null,
    );
    expect(result.prompt).not.toContain("Delegation Constraint");
    const depthPart = result.trace.parts.find(p => p.label === "depth_guard");
    expect(depthPart?.injected).toBe(false);
  });

  test("depth guard injected at depth 1", () => {
    const result = buildSystemPrompt(
      minimalDeps({ delegationDepth: 1 }),
      "forge", undefined, null,
    );
    expect(result.prompt).toContain("Delegation Constraint");
    expect(result.prompt).toContain("delegation depth 1");
    expect(result.prompt).toContain("MUST NOT delegate");
    const depthPart = result.trace.parts.find(p => p.label === "depth_guard");
    expect(depthPart?.injected).toBe(true);
  });

  test("depth guard at depth 2", () => {
    const result = buildSystemPrompt(
      minimalDeps({ delegationDepth: 2 }),
      "forge", undefined, null,
    );
    expect(result.prompt).toContain("delegation depth 2");
  });

  test("no depth guard when undefined", () => {
    const result = buildSystemPrompt(
      minimalDeps(),
      "forge", undefined, null,
    );
    expect(result.prompt).not.toContain("Delegation Constraint");
  });
});

describe("Wisdom Injection", () => {
  test("wisdom injected when store and project provided", () => {
    const mockWisdom = {
      query: () => [
        { id: 1, run_id: "r1", project: "p", agent: "forge", category: "convention" as const, content: "Use Bun", confidence: 0.9, created_at: Date.now() },
      ],
      formatForInjection: (entries: any[]) => entries.length > 0 ? "## Learnings from Previous Runs\n- [Convention] Use Bun" : null,
    } as any;

    const result = buildSystemPrompt(
      minimalDeps({ wisdom: mockWisdom, project: "p" }),
      "forge", undefined, null,
    );
    expect(result.prompt).toContain("Learnings from Previous Runs");
    expect(result.prompt).toContain("Use Bun");
  });

  test("no wisdom when store missing", () => {
    const result = buildSystemPrompt(
      minimalDeps({ project: "p" }),
      "forge", undefined, null,
    );
    const wisdomPart = result.trace.parts.find(p => p.label === "wisdom");
    expect(wisdomPart?.injected).toBe(false);
  });
});

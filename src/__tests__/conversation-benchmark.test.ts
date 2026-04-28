import { describe, expect, test } from "bun:test";
import { buildSystemPrompt, type SystemPromptDeps } from "../queue/system-prompt-builder.js";
import { runConversationBenchmark, summarizePromptComposition } from "../runtime/conversation-benchmark.js";

const deps: SystemPromptDeps = {
  canOrchestrate: () => false,
  activeDelegations: new Map(),
};

describe("conversation quality benchmark harness", () => {
  test("default scenarios preserve expected runtime modes", () => {
    const results = runConversationBenchmark();
    expect(results.every((result) => result.passedModeExpectation)).toBe(true);
    expect(results.find((result) => result.name === "reflective discussion")?.runtimeMode).toBe("hybrid");
  });

  test("routes conversational replies to reply-shape and work closeouts to task diagnostics", () => {
    const results = runConversationBenchmark(undefined, {
      greeting: "Yeah. Awake enough to notice the weird edge.",
      "reflective discussion": "This is brittle, but the brittle part is the validation layer, not the voice.",
      "post-tool reflection": "Yeah, the trace confirms it: the tool path is fine, the visible reply is where the stiffness leaks in.",
      implementation: [
        "Implemented the closeout diagnostic beside reply-shape.",
        "- Changed: src/runtime/task-closeout.ts",
        "- Verification: bun test passed",
      ].join("\n"),
    });
    const greeting = results.find((result) => result.name === "greeting")!;
    const reflective = results.find((result) => result.name === "reflective discussion")!;
    const postTool = results.find((result) => result.name === "post-tool reflection")!;
    const implementation = results.find((result) => result.name === "implementation")!;

    expect(greeting.replyShape).toBeDefined();
    expect(greeting.taskCloseout).toBeUndefined();
    expect(reflective.replyShape).toBeDefined();
    expect(reflective.taskCloseout).toBeUndefined();
    expect(postTool.postActionContinuity?.passed).toBe(true);
    expect(implementation.replyShape).toBeUndefined();
    expect(implementation.taskCloseout?.passed).toBe(true);
  });

  test("conversation prompt keeps policy bounded relative to soul", () => {
    const result = buildSystemPrompt(
      deps,
      "nyx",
      "Soul voice. ".repeat(80),
      null,
      undefined,
      { taskType: "conversation", runtimeMode: "conversation", promptProfile: "conversation_light" },
      "cli",
    );
    const metrics = summarizePromptComposition(result.trace);
    expect(result.trace.promptProfile).toBe("conversation_light");
    expect(metrics.policySectionCount).toBe(1);
    expect(metrics.policyToSoulRatio).toBeLessThan(0.25);
  });

  test("agentic heavy prompt keeps execution contract available", () => {
    const result = buildSystemPrompt(
      deps,
      "nyx",
      "Soul voice.",
      null,
      undefined,
      { taskType: "coding", runtimeMode: "agentic", promptProfile: "agentic_heavy" },
      "cli",
    );
    const metrics = summarizePromptComposition(result.trace);
    expect(result.prompt).toContain("Before declaring any implementation task complete");
    expect(result.prompt).toContain("You MUST create a task list");
    expect(metrics.policySectionCount).toBeGreaterThanOrEqual(3);
  });
});

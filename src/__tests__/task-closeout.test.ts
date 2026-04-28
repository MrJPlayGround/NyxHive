import { describe, expect, test } from "bun:test";
import { inspectTaskCloseout } from "../runtime/task-closeout.js";

describe("task closeout diagnostics", () => {
  test("accepts a good task closeout with compact evidence bullets", () => {
    const response = [
      "Done - task closeout diagnostics now run separately from reply-shape.",
      "",
      "- Changed: src/runtime/task-closeout.ts and src/runtime/conversation-quality.ts",
      "- Verification: bun test src/__tests__/task-closeout.test.ts passed",
      "- Worktree: clean after commit",
    ].join("\n");

    const diagnostics = inspectTaskCloseout(response);
    expect(diagnostics.passed).toBe(true);
    expect(diagnostics.outcomeFirst).toBe(true);
    expect(diagnostics.evidenceBulletCount).toBe(3);
  });

  test("accepts outcome-first implementation summaries with changed files and verification", () => {
    const response = [
      "Implemented the task-closeout eval path beside conversational reply-shape.",
      "Changed files: src/runtime/task-closeout.ts, src/runtime/conversation-benchmark.ts.",
      "Verification: bun test and bun run typecheck passed.",
    ].join("\n");

    const diagnostics = inspectTaskCloseout(response);
    expect(diagnostics.passed).toBe(true);
    expect(diagnostics.hasCompletionEvidence).toBe(true);
    expect(diagnostics.issues).not.toContain("missing_outcome_first_opening");
  });

  test("accepts crisp diagnosis closeouts with root cause and one evidence line", () => {
    const response = [
      "Root cause: agentic samples were still being judged by conversational reply-shape, so evidence bullets looked like over-structure.",
      "Evidence: coding traces now receive taskCloseout diagnostics while conversational traces keep replyShape.",
    ].join("\n");

    const diagnostics = inspectTaskCloseout(response);
    expect(diagnostics.passed).toBe(true);
    expect(diagnostics.outcomeFirst).toBe(true);
    expect(diagnostics.hasCompletionEvidence).toBe(true);
  });

  test("rejects empty closeouts", () => {
    for (const response of ["Done.", "All set.", "Task completed."]) {
      const diagnostics = inspectTaskCloseout(response);
      expect(diagnostics.passed).toBe(false);
      expect(diagnostics.issues).toContain("empty_closeout");
    }
  });

  test("rejects long command-by-command diary closeouts", () => {
    const response = [
      "First I ran rg to find the files.",
      "Then I opened the benchmark file.",
      "Next I checked the quality report.",
      "After that, I edited the diagnostics.",
      "Then I ran the targeted test.",
      "The fix is done.",
    ].join(" ");

    const diagnostics = inspectTaskCloseout(response);
    expect(diagnostics.passed).toBe(false);
    expect(diagnostics.issues).toContain("work_diary");
  });

  test("rejects bloated closeouts that bury the outcome", () => {
    const response = [
      "I spent a while walking through the trace rows, the benchmark harness, the sample classifier, and the older reply-shape checks because the validation story had grown in a few directions over time and the surrounding calibration notes made the historical intent a little noisy.",
      "I also compared the way status checks, advice turns, casual replies, and implementation requests were represented before deciding where the measurement should live.",
      "Implemented the separate task-closeout diagnostic path.",
      "Verification: bun test passed.",
    ].join(" ");

    const diagnostics = inspectTaskCloseout(response);
    expect(diagnostics.passed).toBe(false);
    expect(diagnostics.issues).toContain("buried_outcome");
  });
});

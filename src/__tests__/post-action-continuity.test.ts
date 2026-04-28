import { describe, expect, test } from "bun:test";
import { buildPostToolReplyGuidance } from "../agents/post-tool-reply-guidance.js";
import { inspectPostActionContinuity } from "../runtime/post-action-continuity.js";

describe("post-tool reply guidance", () => {
  test("keeps lightweight post-tool replies conversational", () => {
    const guidance = buildPostToolReplyGuidance({ runtimeMode: "hybrid", taskType: "expert" });
    expect(guidance).toContain("[Post-tool reply guidance]");
    expect(guidance).toContain("same assistant");
    expect(guidance).toContain("Do not wrap this as a completion report");
    expect(guidance).not.toContain("Changed:");
    expect(guidance).not.toContain("Verification:");
  });

  test("keeps execution evidence compact without allowing work diaries", () => {
    const guidance = buildPostToolReplyGuidance({ runtimeMode: "agentic", taskType: "coding" });
    expect(guidance).toContain("Outcome first");
    expect(guidance).toContain("compact evidence");
    expect(guidance).toContain("Do not retell the tool sequence");
  });
});

describe("post-action continuity diagnostics", () => {
  test("accepts natural post-tool replies", () => {
    const diagnostics = inspectPostActionContinuity("Yeah, that directory only has the config and one README. Nothing surprising there.");
    expect(diagnostics.passed).toBe(true);
    expect(diagnostics.operatorLogTerms).toEqual([]);
  });

  test("rejects operator-log shaped post-tool replies", () => {
    const diagnostics = inspectPostActionContinuity(
      "Task completed.\n\nTool result for list_directory:\nstdout: package.json\nstderr: \n\nVerification: command exited 0.",
    );
    expect(diagnostics.passed).toBe(false);
    expect(diagnostics.operatorLogTerms).toContain("tool result");
    expect(diagnostics.operatorLogTerms).toContain("stdout");
    expect(diagnostics.reportShapeForLightAction).toBe(true);
  });
});

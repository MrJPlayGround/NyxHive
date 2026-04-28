import { describe, expect, test } from "bun:test";
import { inspectDelegationQuality } from "../agents/delegation-quality.js";

describe("delegation quality diagnostics", () => {
  test("flags unnecessary delegation for simple conversational replies", () => {
    const diagnostics = inspectDelegationQuality({
      originalRequest: "you alive?",
      mention: { agent: "analyst", task: "Answer whether you are alive" },
      availableAgents: ["analyst"],
    });
    expect(diagnostics.passed).toBe(false);
    expect(diagnostics.issues).toContain("unnecessary_delegation");
  });

  test("accepts bounded contract-driven delegation", () => {
    const diagnostics = inspectDelegationQuality({
      originalRequest: "review the runtime mode changes",
      mention: {
        agent: "tester",
        task: "Review runtime mode tests",
        contract: {
          task: "Review runtime mode tests",
          agent: "tester",
          successCriteria: ["Report regressions"],
          inputFiles: ["src/runtime/mode.ts"],
          outputFiles: [],
          excludeFiles: [],
          constraints: ["Read-only review"],
          verification: ["bun test src/__tests__/runtime-mode.test.ts"],
          outputType: "review",
          shouldCommit: false,
          priority: "normal",
          dependsOn: [],
          extractionMethod: "heuristic",
        },
      },
      availableAgents: ["tester"],
    });
    expect(diagnostics.passed).toBe(true);
  });

  test("flags raw double-voice merge-back", () => {
    const diagnostics = inspectDelegationQuality({
      originalRequest: "summarize the results",
      mention: { agent: "analyst", task: "Analyze" },
      resultResponse: "**Analyst** (@analyst):\nA\n\n**Tester** (@tester):\nB",
    });
    expect(diagnostics.issues).toContain("poor_merge_back");
  });
});

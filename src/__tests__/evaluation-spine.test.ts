import { describe, expect, test } from "bun:test";
import { evaluateResponseFamily, listEvaluationFamilies, selectEvaluationFamily } from "../runtime/evaluation.js";

describe("evaluation spine", () => {
  test("defines separate evaluator families for incompatible reply types", () => {
    const families = listEvaluationFamilies().map((family) => family.family);
    expect(families).toContain("conversational_quality");
    expect(families).toContain("task_closeout_quality");
    expect(families).toContain("waiting_state_integrity");
    expect(families).toContain("trace_readability");
    expect(families).toContain("memory_retrieval_fitness");
    expect(families).toContain("delegation_quality");
    expect(families).toContain("status_reporting_quality");
    expect(families).toContain("post_action_continuity");
  });

  test("keeps conversational replies out of task closeout evals", () => {
    expect(selectEvaluationFamily({ runtimeMode: "conversation", sampleKind: "casual" }))
      .toBe("conversational_quality");
  });

  test("routes execution closeouts to task closeout evals", () => {
    expect(selectEvaluationFamily({ runtimeMode: "agentic", taskType: "coding" }))
      .toBe("task_closeout_quality");
  });

  test("routes lightweight post-tool replies to post-action continuity evals", () => {
    expect(selectEvaluationFamily({ runtimeMode: "hybrid", taskType: "expert", hadToolUse: true }))
      .toBe("post_action_continuity");
  });

  test("task closeout output names useful failure dimensions", () => {
    const result = evaluateResponseFamily("Done.", "task_closeout_quality");
    expect(result.passed).toBe(false);
    expect(result.findings.some((finding) => finding.issue === "empty_closeout")).toBe(true);
    expect(result.findings[0].why.length).toBeGreaterThan(10);
  });

  test("post-action continuity flags operator-log shaped replies", () => {
    const result = evaluateResponseFamily(
      "Task completed.\n\nTool result for list_directory:\nstdout: package.json\n\nVerification: command exited 0.",
      "post_action_continuity",
    );
    expect(result.passed).toBe(false);
    expect(result.findings.some((finding) => finding.issue === "operator_log_leakage")).toBe(true);
    expect(result.findings.some((finding) => finding.issue === "report_shape_for_light_action")).toBe(true);
  });

  test("conversational eval flags self-flattening agency disclaimers", () => {
    const result = evaluateResponseFamily(
      "As an AI, I don't have feelings or preferences, but I can provide information.",
      "conversational_quality",
    );

    expect(result.passed).toBe(false);
    expect(result.findings.some((finding) => finding.issue === "self_flattening_disclaimer")).toBe(true);
  });
});

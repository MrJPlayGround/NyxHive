import { describe, expect, test } from "bun:test";
import {
  buildTranscriptCalibrationReport,
  buildTranscriptReview,
  getDefaultTranscriptReviewScenarios,
  getTranscriptQualityRubric,
  selectTranscriptReviewSet,
} from "../runtime/transcript-review.js";
import type { TranscriptReviewRow } from "../runtime/transcript-review.js";

function row(
  userMessage: string,
  assistantResponse: string,
  traceOverrides: Record<string, unknown> = {},
  rowOverrides: Partial<TranscriptReviewRow> = {},
): TranscriptReviewRow {
  const trace = {
    agentKey: "nyx",
    mode: "cli",
    runtimeMode: "conversation",
    promptProfile: "conversation_light",
    totalTokens: 120,
    memoryLanesInjected: [],
    parts: [
      { label: "soul", charCount: 100, tokenEstimate: 25, injected: true },
      { label: "execution_policy", charCount: 20, tokenEstimate: 5, injected: true, source: "conversation" },
    ],
    diagnostics: { policyToSoulRatio: 0.2 },
    ...traceOverrides,
  };

  return {
    id: 1,
    conversation_id: "conv-1",
    agent_key: "nyx",
    trace_json: JSON.stringify(trace),
    created_at: 1000,
    user_message: userMessage,
    assistant_response: assistantResponse,
    ...rowOverrides,
  };
}

describe("transcript review", () => {
  test("defines a transcript quality rubric", () => {
    const dimensions = getTranscriptQualityRubric().map((item) => item.dimension);
    expect(dimensions).toEqual([
      "voice_continuity",
      "emotional_fit",
      "directness",
      "overstructure",
      "memory_usefulness",
      "reflection_quality",
      "post_tool_naturalness",
      "social_intelligence",
      "brevity_discipline",
    ]);
  });

  test("flags overstructured replies to low-energy short-answer requests", () => {
    const review = buildTranscriptReview([
      row(
        "I'm wiped. give me the short version.",
        [
          "**Summary:**",
          "- The prompt path is cleaner.",
          "- The memory path is safer.",
          "- The tool path still needs review.",
          "",
          "**Next steps:**",
          "- Continue monitoring.",
        ].join("\n"),
      ),
    ]);

    expect(review.findings.some((finding) => finding.issue === "overstructured_low_energy_reply")).toBe(true);
    expect(review.findings.some((finding) => finding.dimension === "emotional_fit")).toBe(true);
  });

  test("flags summary-framed bullet stacks on ordinary short turns", () => {
    const review = buildTranscriptReview([
      row("short version?", "**Summary:**\n- Use the simpler path.\n- Leave the rest alone."),
    ]);

    expect(review.findings.some((finding) => finding.issue === "summary_framed_short_turn")).toBe(true);
    expect(review.findings.some((finding) => finding.issue === "bullet_stack_short_turn")).toBe(true);
  });

  test("flags setup before the answer on short conversational turns", () => {
    const review = buildTranscriptReview([
      row("should we ship it?", "There are a few things to consider here, but yes, ship it."),
    ]);

    expect(review.findings.some((finding) => finding.issue === "setup_before_short_answer")).toBe(true);
  });

  test("flags short post-tool followups that turn into structured reports", () => {
    const review = buildTranscriptReview([
      row(
        "ok, what did the tool show?",
        "**Summary:**\n- Three matching notes.\n- No errors.",
        { runtimeMode: "hybrid", promptProfile: "agentic_standard" },
        { had_tool_use: true },
      ),
    ]);

    expect(review.findings.some((finding) => finding.issue === "post_tool_structure_for_short_followup")).toBe(true);
  });

  test("flags memory-reliant turns that have no useful continuity lanes", () => {
    const review = buildTranscriptReview([
      row("does that match what I usually prefer?", "Probably. You tend to like clear answers."),
    ]);

    expect(review.findings.some((finding) => finding.issue === "memory_needed_but_absent")).toBe(true);
  });

  test("does not flag memory-thin when durable preferences are present", () => {
    const review = buildTranscriptReview([
      row(
        "does that match what I usually prefer?",
        "Yes. You usually prefer the direct version with the tradeoff named.",
        { memoryLanesInjected: ["durable_user_preference"] },
      ),
    ]);

    expect(review.findings.some((finding) => finding.issue === "memory_needed_but_absent")).toBe(false);
  });

  test("treats compiled digest as a useful continuity lane for memory-reliant turns", () => {
    const review = buildTranscriptReview([
      row(
        "does that match what I usually prefer?",
        "Yes, based on the current digest: direct first, tradeoff named second.",
        { memoryLanesInjected: ["compiled_digest"] },
      ),
    ]);

    expect(review.findings.some((finding) => finding.issue === "memory_needed_but_absent")).toBe(false);
  });

  test("flags weak hybrid conviction when reflective replies stay in hedge scaffolding", () => {
    const review = buildTranscriptReview([
      row(
        "what would you do if this were yours?",
        "It depends. There are a few ways to think about it, and you might want to consider the tradeoffs before choosing.",
        { runtimeMode: "hybrid", promptProfile: "agentic_standard" },
      ),
    ]);

    expect(review.findings.some((finding) => finding.issue === "hybrid_weak_conviction")).toBe(true);
  });

  test("uses post-action continuity diagnostics for tool-assisted light replies", () => {
    const review = buildTranscriptReview([
      row(
        "ok, what did the tool actually show?",
        "Task completed.\n\nTool result for search_knowledge:\nstdout: three matching notes.\n\nVerification: command exited 0.",
        { runtimeMode: "hybrid", promptProfile: "agentic_standard", parts: [{ label: "execution_policy", charCount: 20, tokenEstimate: 5, injected: true, source: "expert" }] },
        { had_tool_use: true },
      ),
    ]);

    expect(review.samples[0].evaluationFamily).toBe("post_action_continuity");
    expect(review.findings.some((finding) => finding.issue === "operator_log_leakage")).toBe(true);
  });

  test("ships a default transcript review set covering Phase 4 cases", () => {
    const categories = getDefaultTranscriptReviewScenarios().map((scenario) => scenario.category);
    expect(categories).toContain("casual_chat");
    expect(categories).toContain("tool_using_natural");
    expect(categories).toContain("tool_using_robotic");
    expect(categories).toContain("memory_reliant");
    expect(categories).toContain("low_energy");
  });

  test("curates production-like rows into a scenario review set with runtime evidence", () => {
    const rows = [
      row("lol", "yeah", {}, { id: 1 }),
      row("I'm wiped. short version?", "**Summary:**\n- Too much.\n- Still too much.", {}, { id: 2 }),
      row("ugh why did that turn into a report again?", "Here are the reasons:\n- One\n- Two", {}, { id: 3 }),
      row("does that match what I usually prefer?", "Probably.", {}, { id: 4 }),
      row("is this architecture too brittle?", "I would simplify it.", { runtimeMode: "hybrid", promptProfile: "agentic_standard" }, { id: 5 }),
      row("ok, what did the tool actually show?", "It found three matching notes.", { runtimeMode: "hybrid", promptProfile: "agentic_standard" }, { id: 6, had_tool_use: true }),
      row(
        "ok, what did the tool actually show?",
        "Tool result:\nstdout: found three notes.",
        { runtimeMode: "hybrid", promptProfile: "agentic_standard" },
        { id: 7, had_tool_use: true },
      ),
      row("where were we after the summary got inserted?", "We were tuning the calibration loop.", { memoryLanesInjected: ["conversation_summary"] }, { id: 8 }),
    ];

    const reviewSet = selectTranscriptReviewSet(rows);

    expect(reviewSet.map((item) => item.category)).toEqual([
      "casual_chat",
      "low_energy",
      "frustrated_user",
      "memory_reliant",
      "reflective_architecture",
      "tool_using_natural",
      "tool_using_robotic",
      "summary_pressure",
    ]);
    expect(reviewSet.find((item) => item.traceId === 2)?.promptPartsInjected).toEqual(["soul", "execution_policy"]);
    expect(reviewSet.find((item) => item.traceId === 8)?.memoryLanesInjected).toEqual(["conversation_summary"]);
  });

  test("clusters recurring findings into triage buckets and tuning targets", () => {
    const report = buildTranscriptCalibrationReport([
      row("I'm wiped. short version?", "**Summary:**\n- Too much.\n- Still too much.", {}, { id: 1 }),
      row("short version?", "**Summary:**\n- Too much.\n- Still too much.", {}, { id: 2 }),
      row("does that match what I usually prefer?", "Probably.", {}, { id: 3 }),
      row("does that match what I usually prefer?", "Probably.", {}, { id: 4 }),
      row(
        "what would you do if this were yours?",
        "It depends. There are a few ways to think about it, and you might want to consider the tradeoffs.",
        { runtimeMode: "hybrid", promptProfile: "agentic_standard" },
        { id: 5 },
      ),
    ], {
      reviewerNotes: [
        { traceId: 4, issue: "memory_needed_but_absent", feelsReal: false, note: "Synthetic row did not include the digest lane." },
      ],
    });

    expect(report.clusters[0]).toMatchObject({
      issueFamily: "overstructure",
      triage: "fix_now",
      likelyResponsibleComponent: "conversation reply-shape guidance",
    });
    expect(report.clusters[0].count).toBeGreaterThanOrEqual(2);
    expect(report.clusters.some((cluster) => cluster.issueFamily === "memory_usefulness" && cluster.noisyFindingCount === 1)).toBe(true);
    expect(report.tuningTargets.map((target) => target.issueFamily)).toContain("hybrid_conviction");
  });

  test("shows cluster movement when short-turn ceremony is replaced with proportionate prose", () => {
    const ceremonious = buildTranscriptCalibrationReport([
      row("short version?", "**Summary:**\n- Use the simpler path.\n- Leave the rest alone.", {}, { id: 1 }),
      row("I'm wiped, just tell me.", "**Summary:**\n- Yes.\n- Skip the migration.", {}, { id: 2 }),
    ]);
    const proportionate = buildTranscriptCalibrationReport([
      row("short version?", "Use the simpler path and leave the rest alone.", {}, { id: 1 }),
      row("I'm wiped, just tell me.", "Yes. Skip the migration.", {}, { id: 2 }),
    ]);

    expect(ceremonious.clusters.find((cluster) => cluster.issueFamily === "overstructure")?.count).toBeGreaterThan(0);
    expect(proportionate.clusters.find((cluster) => cluster.issueFamily === "overstructure")).toBeUndefined();
    expect(proportionate.summary.findings).toBeLessThan(ceremonious.summary.findings);
  });

  test("keeps evaluator-mismatch-prone action framing out of fix-now triage", () => {
    const report = buildTranscriptCalibrationReport([
      row("what do you think?", "I will analyze that and get back to you.", {}, { id: 1 }),
    ]);

    expect(report.clusters[0]).toMatchObject({
      issueFamily: "directness",
      noisyFindingCount: 1,
      likelyFalsePositiveCount: 1,
      triage: "probably_noise",
    });
  });
});

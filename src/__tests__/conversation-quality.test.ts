import { describe, expect, test } from "bun:test";
import { buildConversationQualityReport, buildConversationReviewSamples } from "../runtime/conversation-quality.js";

function row(overrides: Partial<Parameters<typeof buildConversationReviewSamples>[0][number]> = {}, traceOverrides: Record<string, unknown> = {}) {
  const trace = {
    agentKey: "nyx",
    mode: "cli",
    runtimeMode: "conversation",
    productRuntimeMode: "conversation",
    promptProfile: "conversation_light",
    totalTokens: 100,
    memoryLanesInjected: ["knowledge_chunk"],
    parts: [
      { label: "execution_policy", charCount: 12, tokenEstimate: 3, injected: true, source: "conversation" },
      { label: "soul", charCount: 120, tokenEstimate: 30, injected: true },
    ],
    diagnostics: {
      policySectionCount: 2,
      soulTokenShare: 0.5,
      policyTokenShare: 0.1,
      policyToSoulRatio: 0.2,
      memoryLaneCount: 1,
      proceduralMemoryInjected: false,
      injectedParts: ["soul", "execution_policy"],
      excludedParts: [],
      sectionTokenTotals: {},
    },
    ...traceOverrides,
  };
  return {
    id: 1,
    conversation_id: "conv-1",
    agent_key: "nyx",
    trace_json: JSON.stringify(trace),
    created_at: 1000,
    user_message: "what do you think?",
    assistant_response: "I think this is the right direction.",
    ...overrides,
  };
}

describe("conversation quality report", () => {
  test("builds review samples from context traces and nearby messages", () => {
    const samples = buildConversationReviewSamples([row()]);
    expect(samples).toHaveLength(1);
    expect(samples[0].runtimeMode).toBe("conversation");
    expect(samples[0].productRuntimeMode).toBe("conversation");
    expect(samples[0].promptProfile).toBe("conversation_light");
    expect(samples[0].sampleKind).toBe("reflective");
    expect(samples[0].evaluationFamily).toBe("conversational_quality");
    expect(samples[0].replyShape?.internalFrameworkTerms).toEqual([]);
    expect(samples[0].replyShape?.fillerOpening).toBeNull();
    expect(samples[0].taskCloseout).toBeUndefined();
  });

  test("flags generic assistant filler openings in reply shape diagnostics", () => {
    const samples = buildConversationReviewSamples([
      row({ assistant_response: "Absolutely, I would be happy to help with that." }),
    ]);

    expect(samples[0].replyShape?.fillerOpening).toBe("absolutely");
    expect(samples[0].taskCloseout).toBeUndefined();
  });

  test("uses task closeout diagnostics for agentic work samples", () => {
    const samples = buildConversationReviewSamples([
      row({
        user_message: "fix the benchmark",
        assistant_response: [
          "Implemented the task-closeout diagnostics beside reply-shape.",
          "- Changed: src/runtime/task-closeout.ts",
          "- Verification: bun test src/__tests__/task-closeout.test.ts passed",
        ].join("\n"),
      }, {
        runtimeMode: "agentic",
        productRuntimeMode: "execution",
        promptProfile: "agentic_heavy",
        parts: [{ label: "execution_policy", charCount: 6, tokenEstimate: 2, injected: true, source: "coding" }],
      }),
    ]);

    expect(samples[0].replyShape).toBeUndefined();
    expect(samples[0].evaluationFamily).toBe("task_closeout_quality");
    expect(samples[0].taskCloseout?.passed).toBe(true);
    expect(samples[0].taskCloseout?.evidenceBulletCount).toBe(2);
  });

  test("keeps reflective and advice turns on conversational reply-shape diagnostics", () => {
    const samples = buildConversationReviewSamples([
      row({
        user_message: "do you think this cleanup is worth doing now?",
        assistant_response: "Yes. I would do it now because the measurement is currently lying about the thing we already fixed.",
      }, {
        runtimeMode: "hybrid",
        promptProfile: "agentic_standard",
        parts: [{ label: "execution_policy", charCount: 6, tokenEstimate: 2, injected: true, source: "expert" }],
      }),
    ]);

    expect(samples[0].replyShape).toBeDefined();
    expect(samples[0].taskCloseout).toBeUndefined();
  });

  test("summarizes runtime distribution and possible misroutes", () => {
    const report = buildConversationQualityReport([
      row(),
      row({
        id: 2,
        trace_json: JSON.stringify({
          agentKey: "nyx",
          mode: "cli",
          runtimeMode: "agentic",
          productRuntimeMode: "execution",
          promptProfile: "agentic_heavy",
          totalTokens: 100,
          memoryLanesInjected: ["procedural_memory"],
          parts: [{ label: "execution_policy", charCount: 1, tokenEstimate: 1, injected: true, source: "coding" }],
          diagnostics: {
            policyToSoulRatio: 2,
            sectionTokenTotals: {
              knowledge: 24,
              graph_memory: 12,
            },
          },
        }),
        user_message: "I feel like this got noisy",
      }),
    ]);

    expect(report.summary.total).toBe(2);
    expect(report.summary.byRuntimeMode.conversation).toBe(1);
    expect(report.summary.byRuntimeMode.agentic).toBe(1);
    expect(report.summary.byEvaluationFamily.conversational_quality).toBe(1);
    expect(report.summary.byEvaluationFamily.task_closeout_quality).toBe(1);
    expect(report.summary.byProductRuntimeMode.conversation).toBe(1);
    expect(report.summary.byProductRuntimeMode.execution).toBe(1);
    expect(report.summary.memoryLaneCounts.procedural_memory).toBe(1);
    expect(report.summary.possibleMisroutes).toBeGreaterThanOrEqual(1);
    expect(report.summary.runtimePosture.accidentalExecutionModeRate).toBeGreaterThanOrEqual(0);
    expect(report.summary.runtimePosture.lowActionMemoryTokenPressureMedian).toBeGreaterThanOrEqual(0);
  });
});

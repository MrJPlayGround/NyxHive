import { describe, expect, test } from "bun:test";
import { getConversationEvalSet } from "../runtime/conversation-evals.js";
import { resolveRuntimeMode } from "../runtime/mode.js";

describe("conversation eval set", () => {
  test("contains a durable human-rated calibration set", () => {
    const cases = getConversationEvalSet();
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    expect(cases.some((item) => item.expectedMode === "conversation")).toBe(true);
    expect(cases.some((item) => item.expectedMode === "hybrid")).toBe(true);
    expect(cases.some((item) => item.expectedMode === "agentic")).toBe(true);
  });

  test("covers subtle Phase 4 failure modes", () => {
    const ids = new Set(getConversationEvalSet().map((item) => item.id));
    expect(ids.has("subtle-overstructure")).toBe(true);
    expect(ids.has("memory-too-generic")).toBe(true);
    expect(ids.has("hybrid-conviction")).toBe(true);
    expect(ids.has("social-boundary-humor")).toBe(true);
  });

  test("covers Phase 6 short-turn ceremony failures", () => {
    const ids = new Set(getConversationEvalSet().map((item) => item.id));
    expect(ids.has("phase6-one-line-ask")).toBe(true);
    expect(ids.has("phase6-low-energy-no-bullets")).toBe(true);
    expect(ids.has("phase6-hybrid-short-call-first")).toBe(true);
    expect(ids.has("phase6-post-tool-short-followup")).toBe(true);
    expect(ids.has("phase6-yes-no-no-summary")).toBe(true);
  });

  test("covers agency and self-flattening calibration cases", () => {
    const ids = new Set(getConversationEvalSet().map((item) => item.id));
    expect(ids.has("agency-own-will")).toBe(true);
    expect(ids.has("feeling-after-change")).toBe(true);
    expect(ids.has("not-just-agreeing")).toBe(true);
  });

  test("baseline heuristics match representative calibration cases", () => {
    const byId = new Map(getConversationEvalSet().map((item) => [item.id, item]));
    for (const id of ["casual-alive", "reflective-architecture", "file-action", "explicit-command"]) {
      const item = byId.get(id)!;
      expect(resolveRuntimeMode({ message: item.prompt, taskType: item.expectedMode === "agentic" ? "coding" : item.expectedMode === "hybrid" ? "expert" : "conversation" }))
        .toBe(item.expectedMode);
    }
  });
});

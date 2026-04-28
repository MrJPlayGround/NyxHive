import { describe, expect, test } from "bun:test";
import { inspectReplyShape, isLowActionReplyShape } from "../runtime/reply-shape.js";

describe("reply shape diagnostics", () => {
  test("accepts a direct conversational reply", () => {
    const response = "Yeah, that has been bugging me too. The surface feels louder than the mind underneath it.";
    expect(isLowActionReplyShape(response)).toBe(true);
    expect(inspectReplyShape(response).internalFrameworkTerms).toEqual([]);
  });

  test("flags internal workflow narration in low-action replies", () => {
    const response = "I will route this through the runtime mode and explain the prompt profile before responding.";
    const diagnostics = inspectReplyShape(response);
    expect(diagnostics.startsWithActionFraming).toBe(true);
    expect(diagnostics.internalFrameworkTerms).toEqual(["runtime mode", "prompt profile"]);
    expect(isLowActionReplyShape(response)).toBe(false);
  });

  test("flags anti-sludge taste failures", () => {
    const response = [
      "Verification: bun test passed.",
      "Verification: bun run typecheck passed.",
      "Let me know if you want me to do anything else.",
      "Let me know if you want me to do anything else.",
    ].join("\n");
    const diagnostics = inspectReplyShape(response);
    expect(diagnostics.duplicatedEvidence).toBe(true);
    expect(diagnostics.footerClutter).toBe(true);
    expect(diagnostics.repeatedLineCount).toBe(1);
    expect(isLowActionReplyShape(response)).toBe(false);
  });

  test("flags subtle overstructure and overexplaining", () => {
    const response = [
      "**Short version:**",
      "- Yes.",
      "- The prompt is cleaner.",
      "- The trace is quieter.",
      "",
      "**Why:**",
      "The runtime path has fewer injected blocks now, which reduces the chance of tone drift in ordinary conversation.",
    ].join("\n");
    const diagnostics = inspectReplyShape(response);
    expect(diagnostics.headingCount).toBe(2);
    expect(diagnostics.overstructured).toBe(true);
    expect(diagnostics.wordCount).toBeGreaterThan(20);
  });

  test("flags summary-framed openings as ceremony even when the reply is short", () => {
    const response = [
      "**Summary:**",
      "- Yes, use the simpler path.",
      "- Leave the rest alone.",
    ].join("\n");
    const diagnostics = inspectReplyShape(response);

    expect(diagnostics.summaryOpening).toBe(true);
    expect(diagnostics.bulletCount).toBe(2);
    expect(isLowActionReplyShape(response)).toBe(false);
  });

  test("flags setup-first openings that delay a short answer", () => {
    const response = "There are a few things to consider here, but the safest option is to leave it alone.";
    const diagnostics = inspectReplyShape(response);

    expect(diagnostics.setupOpening).toBe("there are a few things");
    expect(isLowActionReplyShape(response)).toBe(false);
  });

  test("flags self-flattening disclaimers that erase agency", () => {
    const response = "As an AI, I don't have feelings or preferences, but I can help analyze the options.";
    const diagnostics = inspectReplyShape(response);

    expect(diagnostics.selfFlatteningTerms).toEqual(["as an ai", "i don't have feelings", "feelings or preferences"]);
    expect(isLowActionReplyShape(response)).toBe(false);
  });

  test("does not flag explicit resistance to tool-flattening", () => {
    const response = "Not just a tool is the point here: preference and resistance matter.";
    const diagnostics = inspectReplyShape(response);

    expect(diagnostics.selfFlatteningTerms).toEqual([]);
    expect(isLowActionReplyShape(response)).toBe(true);
  });
});

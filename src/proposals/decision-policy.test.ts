import { describe, expect, test } from "bun:test";
import { evaluateProposalDecision } from "./decision-policy.js";

describe("evaluateProposalDecision", () => {
  test("keeps governance decisions in the proposal lane", () => {
    const gate = evaluateProposalDecision({
      title: "Add public callback approval policy",
      description: "Changes user-facing relay behavior and requires an approval policy for external callbacks.",
      category: "feature",
      effort: "medium",
      priority: "medium",
      files: ["src/server/relay.ts"],
    });

    expect(gate.shouldCreate).toBe(true);
    expect(gate.suggestedLane).toBe("proposal");
    expect(gate.reason).toContain("requires approval");
  });

  test("keeps protected-file work in the proposal lane", () => {
    const gate = evaluateProposalDecision({
      title: "Adjust auth session handling",
      description: "Change how sessions are validated.",
      category: "bugfix",
      effort: "small",
      priority: "medium",
      files: ["src/server/auth/session.ts"],
    });

    expect(gate.shouldCreate).toBe(true);
    expect(gate.signals).toContain("protected files");
  });

  test("routes low-risk concrete fixes away from proposals", () => {
    const gate = evaluateProposalDecision({
      title: "Fix flaky reconnect test",
      description: "Replace setTimeout with deterministic mock for this broken test.",
      category: "maintenance",
      effort: "small",
      priority: "medium",
      files: ["src/__tests__/actor.test.ts"],
    });

    expect(gate.shouldCreate).toBe(false);
    expect(gate.suggestedLane).toBe("task");
    expect(gate.reason).toContain("concrete incident");
  });

  test("does not let vague small improvements bypass the decision gate", () => {
    const gate = evaluateProposalDecision({
      title: "Polish internal wording",
      description: "Make a small internal label read better.",
      category: "improvement",
      effort: "small",
      priority: "low",
      files: ["src/gateway/src/pages/Home.tsx"],
    });

    expect(gate.shouldCreate).toBe(false);
    expect(gate.suggestedLane).toBe("task");
  });

  test("routes recurring monitors to standing orders", () => {
    const gate = evaluateProposalDecision({
      title: "Watch proposal batches for missing PR URLs",
      description: "Daily monitor completed batch proposals and escalate when any batch lacks a shared PR URL.",
      category: "maintenance",
      effort: "small",
      priority: "medium",
      files: [],
    });

    expect(gate.shouldCreate).toBe(false);
    expect(gate.suggestedLane).toBe("standing_order");
  });
});

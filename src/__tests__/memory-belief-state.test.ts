import { describe, expect, test } from "bun:test";
import { assessMemoryTrust, normalizeMemoryBeliefType } from "../memory/belief-state.js";

describe("memory belief state", () => {
  test("normalizes legacy categories into explicit belief types", () => {
    expect(normalizeMemoryBeliefType("preference")).toBe("inferred_preference");
    expect(normalizeMemoryBeliefType("pattern")).toBe("workflow_procedure");
    expect(normalizeMemoryBeliefType("fact")).toBe("user_stated_fact");
  });

  test("trusts current user-confirmed memory more than assistant inference", () => {
    const confirmed = assessMemoryTrust({ confidence: 0.7, userConfirmed: true });
    const inferred = assessMemoryTrust({ confidence: 0.7, sourceReliability: "assistant_inferred" });
    expect(confirmed.trusted).toBe(true);
    expect(confirmed.score).toBeGreaterThan(inferred.score);
  });

  test("marks superseded and expired memory as untrusted", () => {
    const superseded = assessMemoryTrust({ confidence: 0.95, status: "superseded" });
    const expired = assessMemoryTrust({ confidence: 0.95, expiresAt: Date.now() - 1 });
    expect(superseded.currentness).toBe("superseded");
    expect(superseded.trusted).toBe(false);
    expect(expired.currentness).toBe("expired");
    expect(expired.trusted).toBe(false);
  });
});

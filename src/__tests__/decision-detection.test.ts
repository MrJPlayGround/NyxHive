import { describe, test, expect } from "bun:test";

// Re-create the detection logic since it's a private function in management.ts
const DECISION_PATTERNS = /\b(decided|agreed|chose|chosen|went with|we will|approved)\b|(?:^|\s)(decision:|rationale:)/im;
function detectLearningCategory(content: string): string {
  if (DECISION_PATTERNS.test(content)) return "decisions";
  return "learnings";
}

describe("Decision category detection", () => {
  test("detects 'decided' keyword", () => {
    expect(detectLearningCategory("We decided to use SQLite over PostgreSQL")).toBe("decisions");
  });

  test("detects 'agreed' keyword", () => {
    expect(detectLearningCategory("Team agreed on the new API structure")).toBe("decisions");
  });

  test("detects 'chose' keyword", () => {
    expect(detectLearningCategory("We chose Bun over Node for performance")).toBe("decisions");
  });

  test("detects 'went with' keyword", () => {
    expect(detectLearningCategory("Went with the simpler approach for auth")).toBe("decisions");
  });

  test("detects 'decision:' prefix", () => {
    expect(detectLearningCategory("Decision: all proposals require review")).toBe("decisions");
  });

  test("detects 'we will' keyword", () => {
    expect(detectLearningCategory("We will migrate to the new schema next sprint")).toBe("decisions");
  });

  test("detects 'rationale:' keyword", () => {
    expect(detectLearningCategory("Rationale: performance is more important than compatibility")).toBe("decisions");
  });

  test("detects 'approved' keyword", () => {
    expect(detectLearningCategory("Approved the proposal to add caching layer")).toBe("decisions");
  });

  test("returns 'learnings' for non-decision content", () => {
    expect(detectLearningCategory("Fixed a bug in the auth module")).toBe("learnings");
  });

  test("returns 'learnings' for general observations", () => {
    expect(detectLearningCategory("The test suite runs in 32 seconds")).toBe("learnings");
  });

  test("case insensitive detection", () => {
    expect(detectLearningCategory("DECIDED to switch providers")).toBe("decisions");
    expect(detectLearningCategory("Agreed on the approach")).toBe("decisions");
  });
});

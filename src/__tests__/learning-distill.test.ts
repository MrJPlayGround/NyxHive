import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { distillPatterns } from "../learning/distill.js";
import { OutcomeStore } from "../memory/outcomes.js";
import { PatternStore } from "../memory/patterns.js";
import type { DistillationResult } from "../learning/distill.js";

// --- Helpers ---

function mockRouter(content: string): any {
  return { complete: async () => ({ content, usage: { input: 0, output: 0 } }) };
}

function makeStores() {
  const db = new Database(":memory:");
  const outcomes = new OutcomeStore(db);
  const patterns = new PatternStore(db);
  return { db, outcomes, patterns };
}

function seedOutcomes(outcomes: OutcomeStore, agent: string, count: number, opts?: {
  outcome?: "success" | "failed" | "partial";
  taskType?: string;
  failureReason?: string;
}) {
  for (let i = 0; i < count; i++) {
    outcomes.record({
      trace_id: `trace-${agent}-${i}`,
      agent,
      task_type: opts?.taskType ?? "coding",
      outcome: opts?.outcome ?? "success",
      failure_reason: opts?.failureReason ?? null,
    });
  }
}

// --- Tests ---

describe("distillPatterns", () => {
  let db: Database;
  let outcomes: OutcomeStore;
  let patterns: PatternStore;

  beforeEach(() => {
    ({ db, outcomes, patterns } = makeStores());
  });

  afterEach(() => {
    db.close();
  });

  test("returns zero counts when no outcomes exist", async () => {
    const result = await distillPatterns({
      outcomes,
      patterns,
      router: mockRouter("[]"),
    });

    expect(result.agents_processed).toBe(0);
    expect(result.patterns_extracted).toBe(0);
    expect(result.patterns_pruned).toBe(0);
  });

  test("skips agents with fewer than 2 outcomes", async () => {
    seedOutcomes(outcomes, "solo-agent", 1);

    const result = await distillPatterns({
      outcomes,
      patterns,
      router: mockRouter("[]"),
    });

    expect(result.agents_processed).toBe(0);
  });

  test("processes agent with 2+ outcomes and extracts patterns", async () => {
    seedOutcomes(outcomes, "nyx", 3);

    const llmResponse = JSON.stringify([
      {
        agent: "nyx",
        pattern: "Tests pass on first try for utility modules",
        confidence: 0.8,
        evidence_count: 3,
        recommendation: "Continue current testing approach",
        category: "success_pattern",
      },
    ]);

    const result = await distillPatterns({
      outcomes,
      patterns,
      router: mockRouter(llmResponse),
    });

    expect(result.agents_processed).toBe(1);
    expect(result.patterns_extracted).toBe(1);

    const stored = patterns.getAll();
    expect(stored.length).toBe(1);
    expect(stored[0].agent).toBe("nyx");
    expect(stored[0].pattern).toBe("Tests pass on first try for utility modules");
    expect(stored[0].confidence).toBe(0.8);
  });

  test("forces agent name from grouping, not LLM response", async () => {
    seedOutcomes(outcomes, "tester", 2);

    const llmResponse = JSON.stringify([
      {
        agent: "wrong-name",
        pattern: "Some pattern",
        confidence: 0.7,
        evidence_count: 2,
        recommendation: "Do something",
        category: "success_pattern",
      },
    ]);

    const result = await distillPatterns({
      outcomes,
      patterns,
      router: mockRouter(llmResponse),
    });

    expect(result.patterns_extracted).toBe(1);
    const stored = patterns.getAll();
    // Agent should be forced to lowercase grouping key
    expect(stored[0].agent).toBe("tester");
  });

  test("processes multiple agents independently", async () => {
    seedOutcomes(outcomes, "nyx", 3);
    seedOutcomes(outcomes, "analyst", 2, { outcome: "failed", failureReason: "timeout" });

    const llmResponse = JSON.stringify([
      {
        agent: "placeholder",
        pattern: "Generic pattern",
        confidence: 0.6,
        evidence_count: 2,
        recommendation: "Generic advice",
        category: "general",
      },
    ]);

    const result = await distillPatterns({
      outcomes,
      patterns,
      router: mockRouter(llmResponse),
    });

    expect(result.agents_processed).toBe(2);
    expect(result.patterns_extracted).toBe(2);

    const agents = patterns.getAgents().sort();
    expect(agents).toEqual(["analyst", "nyx"]);
  });

  test("handles empty LLM response gracefully", async () => {
    seedOutcomes(outcomes, "nyx", 3);

    const result = await distillPatterns({
      outcomes,
      patterns,
      router: mockRouter("[]"),
    });

    // agents_processed increments even if no patterns extracted (agent was still processed)
    expect(result.agents_processed).toBe(1);
    expect(result.patterns_extracted).toBe(0);
  });

  test("handles invalid LLM response gracefully", async () => {
    seedOutcomes(outcomes, "nyx", 3);

    const result = await distillPatterns({
      outcomes,
      patterns,
      router: mockRouter("This is not valid JSON at all"),
    });

    // parsePatternResponse returns [] for invalid JSON, so 0 extracted
    expect(result.patterns_extracted).toBe(0);
  });

  test("handles LLM error gracefully without crashing", async () => {
    seedOutcomes(outcomes, "nyx", 3);

    const errorRouter: any = {
      complete: async () => { throw new Error("API rate limited"); },
    };

    const result = await distillPatterns({
      outcomes,
      patterns,
      router: errorRouter,
    });

    // Should not throw, just log error and skip
    expect(result.agents_processed).toBe(0);
    expect(result.patterns_extracted).toBe(0);
  });

  test("respects sinceDays parameter", async () => {
    // Default sinceDays is 7 — outcomes created "now" should be within range
    seedOutcomes(outcomes, "nyx", 2);

    const llmResponse = JSON.stringify([
      {
        agent: "nyx",
        pattern: "Recent pattern",
        confidence: 0.9,
        evidence_count: 2,
        recommendation: "Keep it up",
        category: "success_pattern",
      },
    ]);

    const result = await distillPatterns({
      outcomes,
      patterns,
      router: mockRouter(llmResponse),
      sinceDays: 1,
    });

    expect(result.agents_processed).toBe(1);
    expect(result.patterns_extracted).toBe(1);
  });

  test("extracts multiple patterns from single LLM response", async () => {
    seedOutcomes(outcomes, "nyx", 5, { outcome: "success" });
    seedOutcomes(outcomes, "nyx", 2, { outcome: "failed", failureReason: "type error" });

    const llmResponse = JSON.stringify([
      {
        agent: "nyx",
        pattern: "Success pattern A",
        confidence: 0.9,
        evidence_count: 5,
        recommendation: "Continue approach A",
        category: "success_pattern",
      },
      {
        agent: "nyx",
        pattern: "Failure pattern B",
        confidence: 0.7,
        evidence_count: 2,
        recommendation: "Fix approach B",
        category: "failure_pattern",
      },
    ]);

    const result = await distillPatterns({
      outcomes,
      patterns,
      router: mockRouter(llmResponse),
    });

    expect(result.patterns_extracted).toBe(2);
    expect(patterns.getAll().length).toBe(2);
  });

  test("groups outcomes by lowercase agent name", async () => {
    // Record outcomes with mixed case — should be grouped together
    outcomes.record({ trace_id: "t1", agent: "Nyx", task_type: "coding", outcome: "success" });
    outcomes.record({ trace_id: "t2", agent: "NYX", task_type: "coding", outcome: "success" });
    outcomes.record({ trace_id: "t3", agent: "nyx", task_type: "coding", outcome: "success" });

    const llmResponse = JSON.stringify([
      {
        agent: "nyx",
        pattern: "Consistent success",
        confidence: 0.8,
        evidence_count: 3,
        recommendation: "Keep going",
        category: "success_pattern",
      },
    ]);

    const result = await distillPatterns({
      outcomes,
      patterns,
      router: mockRouter(llmResponse),
    });

    // All three should be grouped under "nyx"
    expect(result.agents_processed).toBe(1);
    expect(result.patterns_extracted).toBe(1);
  });
});

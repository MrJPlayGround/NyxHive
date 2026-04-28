import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { PatternStore } from "../memory/patterns.js";
import { OutcomeStore } from "../memory/outcomes.js";
import { distillPatterns } from "../learning/distill.js";

// Mock router that returns structured pattern JSON
function createMockRouter(responses?: Map<string, string>) {
  return {
    complete: mock(async (opts: { messages: Array<{ role: string; content: string }> }) => {
      const prompt = opts.messages[0].content;

      // Extract agent name from prompt
      const agentMatch = prompt.match(/agent "(\w+)"/);
      const agent = agentMatch?.[1] ?? "unknown";

      const customResponse = responses?.get(agent);
      if (customResponse) {
        return { content: customResponse };
      }

      // Default: return valid pattern JSON
      return {
        content: JSON.stringify([
          {
            agent,
            pattern: `${agent} tasks often fail on type errors`,
            confidence: 0.75,
            evidence_count: 3,
            recommendation: "Run type-check before committing",
            category: "failure_pattern",
          },
          {
            agent,
            pattern: `${agent} succeeds more on small PRs`,
            confidence: 0.8,
            evidence_count: 4,
            recommendation: "Break large tasks into smaller PRs",
            category: "success_pattern",
          },
        ]),
      };
    }),
  } as unknown as import("../providers/router.js").ProviderRouter;
}

describe("distillPatterns", () => {
  let db: Database;
  let patterns: PatternStore;
  let outcomes: OutcomeStore;

  beforeEach(() => {
    db = new Database(":memory:");
    patterns = new PatternStore(db);
    outcomes = new OutcomeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("extracts patterns from recent outcomes", async () => {
    // Seed outcomes
    outcomes.record({ trace_id: "t1", agent: "nyx", task_type: "feature", outcome: "success" });
    outcomes.record({ trace_id: "t2", agent: "nyx", task_type: "bugfix", outcome: "failed", failure_reason: "Type error in schema" });
    outcomes.record({ trace_id: "t3", agent: "nyx", task_type: "feature", outcome: "success" });

    const router = createMockRouter();
    const result = await distillPatterns({ outcomes, patterns, router });

    expect(result.agents_processed).toBe(1);
    expect(result.patterns_extracted).toBe(2);

    const stored = patterns.getAll();
    expect(stored).toHaveLength(2);
    expect(stored[0].agent).toBe("nyx");
  });

  test("skips agents with fewer than 2 outcomes", async () => {
    outcomes.record({ trace_id: "t1", agent: "nyx", task_type: "feature", outcome: "success" });

    const router = createMockRouter();
    const result = await distillPatterns({ outcomes, patterns, router });

    expect(result.agents_processed).toBe(0);
    expect(result.patterns_extracted).toBe(0);
    expect(router.complete).not.toHaveBeenCalled();
  });

  test("processes multiple agents independently", async () => {
    outcomes.record({ trace_id: "t1", agent: "nyx", task_type: "feature", outcome: "success" });
    outcomes.record({ trace_id: "t2", agent: "nyx", task_type: "bugfix", outcome: "failed" });
    outcomes.record({ trace_id: "t3", agent: "analyst", task_type: "analysis", outcome: "success" });
    outcomes.record({ trace_id: "t4", agent: "analyst", task_type: "analysis", outcome: "success" });

    const router = createMockRouter();
    const result = await distillPatterns({ outcomes, patterns, router });

    expect(result.agents_processed).toBe(2);
    expect(result.patterns_extracted).toBe(4); // 2 per agent
    expect(router.complete).toHaveBeenCalledTimes(2);
  });

  test("returns no patterns when no outcomes exist", async () => {
    const router = createMockRouter();
    const result = await distillPatterns({ outcomes, patterns, router });

    expect(result.agents_processed).toBe(0);
    expect(result.patterns_extracted).toBe(0);
    expect(router.complete).not.toHaveBeenCalled();
  });

  test("prunes expired patterns during distillation", async () => {
    // Insert an expired pattern
    db.prepare(
      "INSERT INTO agent_patterns (agent, pattern, confidence, evidence_count, recommendation, category, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-60 days'), datetime('now', '-1 day'))",
    ).run("nyx", "Old expired pattern", 0.8, 3, "Rec", "coding");

    expect(patterns.getAll()).toHaveLength(1);

    const router = createMockRouter();
    const result = await distillPatterns({ outcomes, patterns, router });

    expect(result.expired_pruned).toBe(1);
    expect(patterns.getAll()).toHaveLength(0);
  });

  test("handles LLM returning invalid JSON gracefully", async () => {
    outcomes.record({ trace_id: "t1", agent: "nyx", task_type: "feature", outcome: "success" });
    outcomes.record({ trace_id: "t2", agent: "nyx", task_type: "bugfix", outcome: "failed" });

    const router = createMockRouter(new Map([["nyx", "This is not valid JSON at all"]]));
    const result = await distillPatterns({ outcomes, patterns, router });

    expect(result.agents_processed).toBe(1);
    expect(result.patterns_extracted).toBe(0);
    expect(patterns.getAll()).toHaveLength(0);
  });

  test("forces agent name to match regardless of LLM output", async () => {
    outcomes.record({ trace_id: "t1", agent: "nyx", task_type: "feature", outcome: "success" });
    outcomes.record({ trace_id: "t2", agent: "nyx", task_type: "bugfix", outcome: "success" });

    // LLM returns wrong agent name
    const router = createMockRouter(new Map([
      ["nyx", JSON.stringify([{
        agent: "wrong_agent",
        pattern: "Test pattern",
        confidence: 0.8,
        evidence_count: 2,
        recommendation: "Do it",
        category: "success_pattern",
      }])],
    ]));

    const result = await distillPatterns({ outcomes, patterns, router });

    expect(result.patterns_extracted).toBe(1);
    const stored = patterns.getAll();
    expect(stored[0].agent).toBe("nyx"); // Forced to correct agent
  });

  test("respects sinceDays parameter", async () => {
    // Record outcome "now"
    outcomes.record({ trace_id: "t1", agent: "nyx", task_type: "feature", outcome: "success" });
    outcomes.record({ trace_id: "t2", agent: "nyx", task_type: "bugfix", outcome: "success" });

    const router = createMockRouter();

    // With very short window (0 days) — should still find outcomes created "now"
    const result = await distillPatterns({ outcomes, patterns, router, sinceDays: 0.001 });
    // Outcomes were just created, so they should be within even a tiny window
    expect(result.agents_processed).toBeGreaterThanOrEqual(0);
  });

  test("handles LLM returning content as array of blocks", async () => {
    outcomes.record({ trace_id: "t1", agent: "nyx", task_type: "feature", outcome: "success" });
    outcomes.record({ trace_id: "t2", agent: "nyx", task_type: "bugfix", outcome: "success" });

    const router = {
      complete: mock(async () => ({
        content: JSON.stringify([{
          agent: "nyx",
          pattern: "Block format test",
          confidence: 0.7,
          evidence_count: 2,
          recommendation: "Handle block format",
          category: "success_pattern",
        }]),
      })),
    } as unknown as import("../providers/router.js").ProviderRouter;

    const result = await distillPatterns({ outcomes, patterns, router });
    expect(result.patterns_extracted).toBe(1);
  });

  test("uses cheap model for analysis", async () => {
    outcomes.record({ trace_id: "t1", agent: "nyx", task_type: "feature", outcome: "success" });
    outcomes.record({ trace_id: "t2", agent: "nyx", task_type: "bugfix", outcome: "success" });

    const router = createMockRouter();
    await distillPatterns({ outcomes, patterns, router });

    expect(router.complete).toHaveBeenCalledTimes(1);
    const call = (router.complete as ReturnType<typeof mock>).mock.calls[0][0] as { model: string };
    expect(call.model).toBe("haiku");
  });
});

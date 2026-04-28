import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { PatternStore, parsePatternResponse } from "../memory/patterns.js";

describe("PatternStore", () => {
  let db: Database;
  let store: PatternStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new PatternStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("record creates a pattern", () => {
    const p = store.record({
      agent: "forge",
      pattern: "Schema changes require explicit migration",
      confidence: 0.8,
      evidence_count: 3,
      recommendation: "Always run bun run migrate after schema changes",
      category: "coding",
    });
    expect(p.id).toBeGreaterThan(0);
    expect(p.agent).toBe("forge");
    expect(p.confidence).toBe(0.8);
    expect(p.evidence_count).toBe(3);
  });

  test("getById returns pattern", () => {
    const created = store.record({
      agent: "forge", pattern: "Test", confidence: 0.7,
      evidence_count: 1, recommendation: "Do it", category: "coding",
    });
    const fetched = store.getById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.pattern).toBe("Test");
  });

  test("getById returns null for unknown id", () => {
    expect(store.getById(999)).toBeNull();
  });

  test("getForAgent filters by agent and confidence", () => {
    store.record({ agent: "forge", pattern: "High confidence", confidence: 0.9, evidence_count: 5, recommendation: "A", category: "coding" });
    store.record({ agent: "forge", pattern: "Low confidence", confidence: 0.3, evidence_count: 1, recommendation: "B", category: "coding" });
    store.record({ agent: "analyst", pattern: "Other agent", confidence: 0.9, evidence_count: 2, recommendation: "C", category: "analysis" });

    const forgePatterns = store.getForAgent("forge");
    expect(forgePatterns).toHaveLength(1); // Only high confidence one
    expect(forgePatterns[0].pattern).toBe("High confidence");
  });

  test("getForAgent respects custom minConfidence", () => {
    store.record({ agent: "forge", pattern: "P1", confidence: 0.4, evidence_count: 1, recommendation: "A", category: "coding" });
    store.record({ agent: "forge", pattern: "P2", confidence: 0.2, evidence_count: 1, recommendation: "B", category: "coding" });

    const results = store.getForAgent("forge", { minConfidence: 0.3 });
    expect(results).toHaveLength(1);
    expect(results[0].pattern).toBe("P1");
  });

  test("getForAgent respects limit", () => {
    for (let i = 0; i < 5; i++) {
      store.record({ agent: "forge", pattern: `P${i}`, confidence: 0.9, evidence_count: 1, recommendation: "A", category: "coding" });
    }
    const results = store.getForAgent("forge", { limit: 2 });
    expect(results).toHaveLength(2);
  });

  test("searchRelevant filters by agent and category", () => {
    store.record({ agent: "forge", pattern: "Coding pattern", confidence: 0.8, evidence_count: 3, recommendation: "A", category: "coding" });
    store.record({ agent: "forge", pattern: "Review pattern", confidence: 0.7, evidence_count: 2, recommendation: "B", category: "review" });
    store.record({ agent: "analyst", pattern: "Analysis pattern", confidence: 0.9, evidence_count: 4, recommendation: "C", category: "analysis" });

    const results = store.searchRelevant({ agent: "forge", taskType: "coding" });
    expect(results).toHaveLength(1);
    expect(results[0].pattern).toBe("Coding pattern");
  });

  test("searchRelevant returns top-3 by default", () => {
    for (let i = 0; i < 5; i++) {
      store.record({ agent: "forge", pattern: `P${i}`, confidence: 0.9 - i * 0.05, evidence_count: 5 - i, recommendation: "A", category: "coding" });
    }
    const results = store.searchRelevant({ agent: "forge" });
    expect(results).toHaveLength(3);
  });

  test("formatForInjection produces markdown", () => {
    const patterns = [
      store.record({ agent: "forge", pattern: "Always run tests", confidence: 0.9, evidence_count: 5, recommendation: "Run bun test before committing", category: "coding" }),
      store.record({ agent: "forge", pattern: "Check imports", confidence: 0.7, evidence_count: 3, recommendation: "Verify all imports resolve", category: "coding" }),
    ];

    const result = store.formatForInjection(patterns);
    expect(result).not.toBeNull();
    expect(result).toContain("## Lessons Learned");
    expect(result).toContain("Always run tests");
    expect(result).toContain("90%");
    expect(result).toContain("Check imports");
  });

  test("formatForInjection returns null for empty patterns", () => {
    expect(store.formatForInjection([])).toBeNull();
  });

  test("formatForInjection respects ~500 token limit", () => {
    const patterns: ReturnType<typeof store.record>[] = [];
    for (let i = 0; i < 50; i++) {
      patterns.push(store.record({
        agent: "forge",
        pattern: `This is a long pattern description number ${i} with lots of detail about what happened`,
        confidence: 0.9,
        evidence_count: 5,
        recommendation: `This is a detailed recommendation about what to do differently in the future for pattern ${i}`,
        category: "coding",
      }));
    }

    const result = store.formatForInjection(patterns);
    expect(result).not.toBeNull();
    // Should be truncated well before 50 items
    const lineCount = result!.split("\n").length;
    expect(lineCount).toBeLessThan(20);
  });

  test("pruneOld keeps only recent batches per agent", () => {
    // Simulate patterns from different dates by inserting with different created_at
    for (let day = 0; day < 12; day++) {
      const date = new Date(Date.now() - day * 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      db.prepare(
        "INSERT INTO agent_patterns (agent, pattern, confidence, evidence_count, recommendation, category, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime(?), datetime(?, '+56 days'))"
      ).run("forge", `Pattern from ${date}`, 0.8, 3, "Rec", "coding", date, date);
    }

    const beforePrune = store.getAll().filter(p => p.agent === "forge");
    expect(beforePrune.length).toBe(12);

    const pruned = store.pruneOld("forge", 8);
    expect(pruned).toBeGreaterThan(0);

    const afterPrune = store.getAll().filter(p => p.agent === "forge");
    expect(afterPrune.length).toBeLessThanOrEqual(8);
  });

  test("pruneExpired removes expired patterns", () => {
    // Insert an expired pattern
    db.prepare(
      "INSERT INTO agent_patterns (agent, pattern, confidence, evidence_count, recommendation, category, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-60 days'), datetime('now', '-1 day'))"
    ).run("forge", "Expired", 0.8, 3, "Rec", "coding");

    // Insert a valid pattern
    store.record({ agent: "forge", pattern: "Valid", confidence: 0.8, evidence_count: 3, recommendation: "Rec", category: "coding" });

    expect(store.getAll()).toHaveLength(2);
    const pruned = store.pruneExpired();
    expect(pruned).toBe(1);
    expect(store.getAll()).toHaveLength(1);
    expect(store.getAll()[0].pattern).toBe("Valid");
  });

  test("getAgents returns distinct agents", () => {
    store.record({ agent: "forge", pattern: "P1", confidence: 0.8, evidence_count: 1, recommendation: "A", category: "coding" });
    store.record({ agent: "forge", pattern: "P2", confidence: 0.7, evidence_count: 1, recommendation: "B", category: "coding" });
    store.record({ agent: "analyst", pattern: "P3", confidence: 0.9, evidence_count: 1, recommendation: "C", category: "analysis" });

    const agents = store.getAgents();
    expect(agents).toHaveLength(2);
    expect(agents).toContain("forge");
    expect(agents).toContain("analyst");
  });
});

describe("parsePatternResponse", () => {
  test("parses valid JSON array", () => {
    const input = JSON.stringify([
      { agent: "forge", pattern: "Tests required", confidence: 0.9, evidence_count: 5, recommendation: "Run tests", category: "coding" },
      { agent: "forge", pattern: "Check types", confidence: 0.7, evidence_count: 3, recommendation: "Type-check", category: "coding" },
    ]);

    const patterns = parsePatternResponse(input);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].pattern).toBe("Tests required");
    expect(patterns[0].confidence).toBe(0.9);
  });

  test("parses JSON in markdown fences", () => {
    const input = '```json\n[{"agent":"forge","pattern":"P1","confidence":0.8,"evidence_count":2,"recommendation":"R1","category":"coding"}]\n```';
    const patterns = parsePatternResponse(input);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBe("P1");
  });

  test("handles single object (not array)", () => {
    const input = JSON.stringify({
      agent: "forge", pattern: "Single", confidence: 0.6,
      evidence_count: 1, recommendation: "Do it", category: "general",
    });
    const patterns = parsePatternResponse(input);
    expect(patterns).toHaveLength(1);
  });

  test("clamps confidence to [0, 1]", () => {
    const input = JSON.stringify([
      { agent: "forge", pattern: "Over", confidence: 1.5, evidence_count: 1, recommendation: "R", category: "c" },
      { agent: "forge", pattern: "Under", confidence: -0.5, evidence_count: 1, recommendation: "R", category: "c" },
    ]);
    const patterns = parsePatternResponse(input);
    expect(patterns[0].confidence).toBe(1);
    expect(patterns[1].confidence).toBe(0);
  });

  test("defaults missing fields", () => {
    const input = JSON.stringify([
      { agent: "forge", pattern: "Minimal", recommendation: "R" },
    ]);
    const patterns = parsePatternResponse(input);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].confidence).toBe(0.5);
    expect(patterns[0].evidence_count).toBe(1);
    expect(patterns[0].category).toBe("general");
  });

  test("filters invalid items", () => {
    const input = JSON.stringify([
      { agent: "forge", pattern: "Valid", recommendation: "R" },
      { notAPattern: true },
      "just a string",
      null,
    ]);
    const patterns = parsePatternResponse(input);
    expect(patterns).toHaveLength(1);
  });

  test("returns empty array on invalid JSON", () => {
    const patterns = parsePatternResponse("This is not JSON");
    expect(patterns).toHaveLength(0);
  });
});

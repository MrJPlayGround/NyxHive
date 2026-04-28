import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { WisdomStore } from "../memory/wisdom.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("WisdomStore", () => {
  let store: WisdomStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "wisdom-test-"));
    store = new WisdomStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("stores and queries wisdom entries", () => {
    store.store([
      { run_id: "r1", project: "nyxhive", agent: "forge", category: "convention", content: "Always run tests before commit", confidence: 0.9 },
      { run_id: "r1", project: "nyxhive", agent: "forge", category: "gotcha", content: "SQLite WAL mode needed for concurrent access", confidence: 0.8 },
    ]);

    const results = store.query("nyxhive", "forge");
    expect(results).toHaveLength(2);
    expect(results[0].content).toBe("Always run tests before commit"); // higher confidence first
    expect(results[0].category).toBe("convention");
  });

  test("queries by project without agent filter", () => {
    store.store([
      { run_id: "r1", project: "nyxhive", agent: "forge", category: "success", content: "Feature shipped", confidence: 0.7 },
      { run_id: "r2", project: "nyxhive", agent: "analyst", category: "failure", content: "Research incomplete", confidence: 0.6 },
    ]);

    const results = store.query("nyxhive");
    expect(results).toHaveLength(2);
  });

  test("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.store([{ run_id: `r${i}`, project: "nyxhive", agent: "forge", category: "convention", content: `Rule ${i}`, confidence: 0.5 }]);
    }
    const results = store.query("nyxhive", "forge", 3);
    expect(results).toHaveLength(3);
  });

  test("filters by project", () => {
    store.store([
      { run_id: "r1", project: "nyxhive", agent: "forge", category: "convention", content: "A", confidence: 0.9 },
      { run_id: "r2", project: "other", agent: "forge", category: "convention", content: "B", confidence: 0.9 },
    ]);

    const nyxhive = store.query("nyxhive");
    expect(nyxhive).toHaveLength(1);
    expect(nyxhive[0].content).toBe("A");
  });

  test("skips invalid categories", () => {
    const count = store.store([
      { run_id: "r1", project: "p", agent: "a", category: "invalid" as any, content: "bad", confidence: 0.5 },
      { run_id: "r1", project: "p", agent: "a", category: "convention", content: "good", confidence: 0.5 },
    ]);
    expect(count).toBe(1);
  });

  test("skips empty content", () => {
    const count = store.store([
      { run_id: "r1", project: "p", agent: "a", category: "convention", content: "", confidence: 0.5 },
      { run_id: "r1", project: "p", agent: "a", category: "convention", content: "  ", confidence: 0.5 },
    ]);
    expect(count).toBe(0);
  });

  test("formats wisdom for injection", () => {
    store.store([
      { run_id: "r1", project: "p", agent: "a", category: "convention", content: "Use Bun not Node", confidence: 0.9 },
      { run_id: "r1", project: "p", agent: "a", category: "gotcha", content: "Watch for WAL locks", confidence: 0.8 },
    ]);
    const entries = store.query("p", "a");
    const formatted = store.formatForInjection(entries);
    expect(formatted).toContain("Learnings from Previous Runs");
    expect(formatted).toContain("[Convention] Use Bun not Node");
    expect(formatted).toContain("[Gotcha] Watch for WAL locks");
  });

  test("returns null for empty entries", () => {
    const formatted = store.formatForInjection([]);
    expect(formatted).toBeNull();
  });

  test("prunes old entries beyond limit", () => {
    for (let i = 0; i < 10; i++) {
      store.store([{ run_id: `r${i}`, project: "p", agent: "a", category: "convention", content: `Rule ${i}`, confidence: 0.5 }]);
    }
    const pruned = store.prune(5);
    expect(pruned).toBe(5);
    expect(store.query("p", "a", 100)).toHaveLength(5);
  });
});

describe("WisdomStore.parseExtractionResponse", () => {
  test("parses valid JSON array", () => {
    const response = `Here are the learnings: [{"category":"convention","content":"Always use Bun","confidence":0.9}]`;
    const entries = WisdomStore.parseExtractionResponse(response, "r1", "p", "a");
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe("convention");
    expect(entries[0].content).toBe("Always use Bun");
  });

  test("ignores invalid categories", () => {
    const response = `[{"category":"invalid","content":"Bad","confidence":0.5},{"category":"gotcha","content":"Good","confidence":0.5}]`;
    const entries = WisdomStore.parseExtractionResponse(response, "r1", "p", "a");
    expect(entries).toHaveLength(1);
    expect(entries[0].category).toBe("gotcha");
  });

  test("returns empty for non-JSON", () => {
    const entries = WisdomStore.parseExtractionResponse("No JSON here", "r1", "p", "a");
    expect(entries).toHaveLength(0);
  });

  test("clamps confidence to 0-1", () => {
    const response = `[{"category":"success","content":"Test","confidence":5.0}]`;
    const entries = WisdomStore.parseExtractionResponse(response, "r1", "p", "a");
    expect(entries[0].confidence).toBe(1);
  });
});

import { describe, test, expect } from "bun:test";
import { searchConversationMemory, buildMemoryInjection } from "../memory/conversation-memory.js";
import { MemoryStore } from "../memory/store.js";
import { GraphMemory } from "../memory/graph.js";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function createTestGraph(): GraphMemory {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  const schemaPath = join(import.meta.dir, "../memory/graph-schema.sql");
  const schema = readFileSync(schemaPath, "utf-8");
  // Execute schema line-by-line handling triggers
  const statements: string[] = [];
  let current = "";
  let inBlock = false;
  for (const line of schema.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("--") || trimmed === "") continue;
    current += `${line}\n`;
    if (/\bBEGIN\b/i.test(trimmed)) inBlock = true;
    if (/\bEND;/i.test(trimmed)) inBlock = false;
    if (!inBlock && trimmed.endsWith(";")) {
      statements.push(current.trim());
      current = "";
    }
  }
  if (current.trim()) statements.push(current.trim());
  for (const stmt of statements) {
    try { db.exec(stmt); } catch { /* already exists */ }
  }
  try { db.exec("ALTER TABLE memory_nodes ADD COLUMN mention_count INTEGER DEFAULT 1"); } catch { /* exists */ }
  return new GraphMemory(db);
}

describe("searchConversationMemory", () => {
  test("returns empty when no deps", async () => {
    const result = await searchConversationMemory({}, "test query");
    expect(result.results).toHaveLength(0);
    expect(result.contextBlock).toBeNull();
    expect(result.sourcesSearched).toBe(0);
  });

  test("searches graph memory", async () => {
    const graph = createTestGraph();
    graph.addNode("decision", "Use SQLite for all storage", undefined, 0.8);
    graph.addNode("preference", "User prefers TypeScript over JavaScript", undefined, 0.9);
    graph.addNode("fact", "NyxHive runs on port 3777", undefined, 0.6);

    const result = await searchConversationMemory({ graph }, "SQLite storage");
    expect(result.sourcesSearched).toBe(1);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0].source).toBe("graph");
    expect(result.results[0].content).toContain("SQLite");
  });

  test("deduplicates results", async () => {
    const graph = createTestGraph();
    graph.addNode("fact", "The server runs on port 3777", undefined, 0.7);
    graph.addNode("fact", "The server runs on port 3777", undefined, 0.6); // dupe

    const result = await searchConversationMemory({ graph }, "server port");
    const portResults = result.results.filter(r => r.content.includes("3777"));
    expect(portResults.length).toBe(1);
  });
});

describe("buildMemoryInjection", () => {
  test("returns null with no graph", () => {
    const result = buildMemoryInjection({}, "conv:1", "telegram");
    expect(result).toBeNull();
  });

  test("builds injection from graph nodes", () => {
    const graph = createTestGraph();
    graph.addNode("decision", "All APIs must use Bearer auth", undefined, 0.9);
    graph.addNode("preference", "Prefer Bun over Node", undefined, 0.85);
    graph.addNode("identity", "User is the founder of NyxAI", undefined, 0.8);

    const result = buildMemoryInjection({ graph }, "conv:1", "telegram");
    expect(result).not.toBeNull();
    expect(result).toContain("[Relevant Knowledge]");
    expect(result).toContain("Bearer auth");
    expect(result).toContain("Bun over Node");
  });

  test("respects max chars limit", () => {
    const graph = createTestGraph();
    for (let i = 0; i < 50; i++) {
      graph.addNode("fact", `Important fact number ${i}: ${"x".repeat(200)}`, undefined, 0.9);
    }

    const result = buildMemoryInjection({ graph }, "conv:1", "telegram");
    expect(result).not.toBeNull();
    // Should be bounded, not include all 50 facts
    expect(result!.length).toBeLessThan(5000);
  });
});

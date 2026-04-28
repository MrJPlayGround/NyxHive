import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { GraphMemory } from "../memory/graph.js";

// Minimal schema for in-memory graph memory
function setupGraphMemory(): GraphMemory {
  const db = new Database(":memory:");
  // Create the tables directly to avoid file system dependency
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      source_conversation TEXT,
      source_channel TEXT,
      importance REAL DEFAULT 0.5,
      access_count INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_memory_nodes_type ON memory_nodes(type);
    CREATE INDEX IF NOT EXISTS idx_memory_nodes_importance ON memory_nodes(importance DESC);

    CREATE TABLE IF NOT EXISTS memory_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
      target_id INTEGER NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(source_id, target_id, type)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_nodes_fts USING fts5(
      content, type, content=memory_nodes, content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS memory_nodes_ai AFTER INSERT ON memory_nodes BEGIN
      INSERT INTO memory_nodes_fts(rowid, content, type) VALUES (new.id, new.content, new.type);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_nodes_ad AFTER DELETE ON memory_nodes BEGIN
      INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, content, type) VALUES('delete', old.id, old.content, old.type);
    END;

    CREATE TRIGGER IF NOT EXISTS memory_nodes_au AFTER UPDATE ON memory_nodes BEGIN
      INSERT INTO memory_nodes_fts(memory_nodes_fts, rowid, content, type) VALUES('delete', old.id, old.content, old.type);
      INSERT INTO memory_nodes_fts(rowid, content, type) VALUES (new.id, new.content, new.type);
    END;
  `);
  return new GraphMemory(db);
}

describe("getRelevantBriefing", () => {
  let graph: GraphMemory;

  beforeEach(() => {
    graph = setupGraphMemory();
  });

  test("returns empty string when no nodes exist", () => {
    const result = graph.getRelevantBriefing({ keywords: ["test"] });
    expect(result).toBe("");
  });

  test("returns relevant briefing with matching file paths", () => {
    graph.addNode("decision", "Chose JWT tokens for auth in src/auth/handler.ts", undefined, 0.7);
    graph.addNode("decision", "Used SQLite for storage in src/db/store.ts", undefined, 0.7);
    graph.addNode("pattern", "Unrelated pattern about UI layout", undefined, 0.5);

    const result = graph.getRelevantBriefing({
      filePaths: ["src/auth/handler.ts"],
    });

    expect(result).toContain("## Context from Previous Sessions");
    expect(result).toContain("JWT tokens");
  });

  test("matches by keyword", () => {
    graph.addNode("decision", "Authentication uses bcrypt for password hashing", undefined, 0.7);
    graph.addNode("pattern", "Database migrations run via bun script", undefined, 0.5);

    const result = graph.getRelevantBriefing({
      keywords: ["authentication", "password"],
    });

    expect(result).toContain("## Context from Previous Sessions");
    expect(result).toContain("bcrypt");
  });

  test("respects token budget", () => {
    // Add many nodes
    for (let i = 0; i < 50; i++) {
      graph.addNode("decision", `Decision number ${i}: We chose approach ${i} for feature ${i} because it handles edge case ${i} more robustly than the alternatives considered`, undefined, 0.7);
    }

    const result = graph.getRelevantBriefing({
      keywords: ["decision"],
      maxTokens: 100,
    });

    // Should be limited — rough estimate ~4 chars per token, 100 tokens = ~400 chars max content
    expect(result.length).toBeLessThan(600);
  });

  test("boosts error nodes for debug task type", () => {
    graph.addNode("error", "TypeError: Cannot read property 'id' of undefined in auth module", undefined, 0.6);
    graph.addNode("decision", "Used express middleware for auth", undefined, 0.7);

    const result = graph.getRelevantBriefing({
      taskType: "debug",
      keywords: ["auth"],
    });

    expect(result).toContain("## Context from Previous Sessions");
    // Error should appear since debug task type boosts error nodes
    expect(result).toContain("TypeError");
  });

  test("updates access tracking for retrieved nodes", () => {
    const id = graph.addNode("decision", "Important architecture decision about API design", undefined, 0.8);

    const nodeBefore = graph.getNode(id);
    expect(nodeBefore?.access_count).toBe(0);

    graph.getRelevantBriefing({
      keywords: ["architecture", "decision"],
    });

    const nodeAfter = graph.getNode(id);
    expect(nodeAfter?.access_count).toBe(1);
  });

  test("skips expired nodes", () => {
    // Add an expired node
    const now = Date.now();
    graph.addNode("decision", "Old expired decision", undefined, 0.7, now - 1000);

    const result = graph.getRelevantBriefing({
      keywords: ["decision"],
    });

    expect(result).toBe("");
  });

  test("ranks recent nodes higher than old ones", () => {
    const now = Date.now();

    // Insert old node directly
    const db = (graph as any).db as Database;
    const oldTime = now - 100 * 24 * 60 * 60 * 1000; // 100 days ago
    db.prepare(
      `INSERT INTO memory_nodes (type, content, source_conversation, source_channel, importance, access_count, created_at, accessed_at, expires_at)
       VALUES (?, ?, NULL, NULL, ?, 0, ?, ?, NULL)`,
    ).run("decision", "Old decision about database schema", 0.7, oldTime, oldTime);
    // Sync FTS
    const oldId = Number((db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id);
    db.prepare("INSERT INTO memory_nodes_fts(rowid, content, type) VALUES (?, ?, ?)").run(oldId, "Old decision about database schema", "decision");

    // Insert recent node
    graph.addNode("decision", "Recent decision about database schema", undefined, 0.7);

    const result = graph.getRelevantBriefing({
      keywords: ["database", "schema"],
    });

    // Recent should appear first
    const recentIdx = result.indexOf("Recent decision");
    const oldIdx = result.indexOf("Old decision");
    if (recentIdx !== -1 && oldIdx !== -1) {
      expect(recentIdx).toBeLessThan(oldIdx);
    }
  });

  test("only includes briefing-relevant node types", () => {
    graph.addNode("decision", "Architecture decision about caching", undefined, 0.7);
    graph.addNode("task", "Task: implement caching layer", undefined, 0.5);
    graph.addNode("identity", "I am Forge, the coder agent", undefined, 0.5);

    const result = graph.getRelevantBriefing({
      keywords: ["caching"],
    });

    // decision is a briefing type, task and identity are not
    expect(result).toContain("caching");
    expect(result).not.toContain("I am Forge");
  });
});

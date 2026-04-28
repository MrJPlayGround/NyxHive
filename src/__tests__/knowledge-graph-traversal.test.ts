import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { GraphMemory } from "../memory/graph.js";
import { expandWithGraphContext } from "../queue/knowledge-search.js";
import type { EdgeType } from "../types.js";

function setupGraphMemory(): GraphMemory {
  const db = new Database(":memory:");
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

describe("expandWithGraphContext", () => {
  let graph: GraphMemory;

  beforeEach(() => {
    graph = setupGraphMemory();
  });

  test("returns empty array when graph is undefined", () => {
    const results = expandWithGraphContext(undefined, ["some content"]);
    expect(results).toEqual([]);
  });

  test("returns empty array when knowledgeContents is empty", () => {
    const results = expandWithGraphContext(graph, []);
    expect(results).toEqual([]);
  });

  test("returns empty array when no matching nodes found", () => {
    graph.addNode("fact", "unrelated content", undefined, 0.5);
    const results = expandWithGraphContext(graph, ["nonexistent content"]);
    expect(results).toEqual([]);
  });

  test("expands with relates_to edges", () => {
    const id1 = graph.addNode("fact", "SQLite is used for storage", undefined, 0.8);
    const id2 = graph.addNode("decision", "Use WAL mode for SQLite", undefined, 0.7);
    graph.addEdge(id1, id2, "relates_to");

    const results = expandWithGraphContext(graph, ["SQLite is used for storage"]);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Use WAL mode for SQLite");
    expect(results[0].edgeType).toBe("relates_to");
    expect(results[0].isContradiction).toBe(false);
  });

  test("excludes superseded nodes", () => {
    const id1 = graph.addNode("fact", "Config uses JSON format", undefined, 0.5);
    const id2 = graph.addNode("fact", "Config now uses TOML format", undefined, 0.8);
    const id3 = graph.addNode("fact", "Old JSON config is deprecated", undefined, 0.3);
    graph.addEdge(id2, id1, "supersedes");
    graph.addEdge(id2, id3, "relates_to");

    const results = expandWithGraphContext(graph, ["Config now uses TOML format"]);
    // superseded node (id1) should be excluded, relates_to (id3) should be included
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Old JSON config is deprecated");
  });

  test("flags contradictions and sorts them first", () => {
    const id1 = graph.addNode("fact", "API uses REST", undefined, 0.8);
    const id2 = graph.addNode("fact", "API uses GraphQL", undefined, 0.7);
    const id3 = graph.addNode("decision", "REST was chosen for simplicity", undefined, 0.9);
    graph.addEdge(id1, id2, "contradicts");
    graph.addEdge(id1, id3, "relates_to");

    const results = expandWithGraphContext(graph, ["API uses REST"]);
    expect(results.length).toBeGreaterThanOrEqual(2);
    // Contradiction should come first
    expect(results[0].isContradiction).toBe(true);
    expect(results[0].content).toBe("API uses GraphQL");
    expect(results[0].edgeType).toBe("contradicts");
  });

  test("deduplicates content (case-insensitive)", () => {
    const id1 = graph.addNode("fact", "Bun is the runtime", undefined, 0.8);
    const id2 = graph.addNode("fact", "TypeScript is the language", undefined, 0.7);
    const id3 = graph.addNode("fact", "TypeScript is the language", undefined, 0.6);
    graph.addEdge(id1, id2, "relates_to");
    graph.addEdge(id1, id3, "relates_to");

    const results = expandWithGraphContext(graph, ["Bun is the runtime"]);
    // Should only have one "TypeScript is the language" entry
    expect(results).toHaveLength(1);
  });

  test("deduplicates against input content", () => {
    const id1 = graph.addNode("fact", "Bun is the runtime", undefined, 0.8);
    const id2 = graph.addNode("fact", "Bun is the runtime", undefined, 0.7);
    graph.addEdge(id1, id2, "relates_to");

    const results = expandWithGraphContext(graph, ["Bun is the runtime"]);
    // The related node has the same content as input, should be excluded
    expect(results).toHaveLength(0);
  });

  test("respects maxResults cap", () => {
    const id1 = graph.addNode("fact", "Main node", undefined, 0.8);
    for (let i = 0; i < 10; i++) {
      const relId = graph.addNode("fact", `Related fact ${i}`, undefined, 0.5 + i * 0.01);
      graph.addEdge(id1, relId, "relates_to");
    }

    const results = expandWithGraphContext(graph, ["Main node"], 3);
    expect(results).toHaveLength(3);
  });

  test("hop-1 results have _hopWeight 1.0", () => {
    const id1 = graph.addNode("fact", "SQLite is used for storage", undefined, 0.8);
    const id2 = graph.addNode("decision", "Use WAL mode for SQLite", undefined, 0.7);
    graph.addEdge(id1, id2, "relates_to");

    const results = expandWithGraphContext(graph, ["SQLite is used for storage"]);
    expect(results).toHaveLength(1);
    expect(results[0]._hopWeight).toBe(1.0);
  });

  test("expands to hop-2 nodes with reduced weight", () => {
    const idA = graph.addNode("fact", "Node A", undefined, 0.8);
    const idB = graph.addNode("fact", "Node B", undefined, 0.7);
    const idC = graph.addNode("fact", "Node C", undefined, 0.6);
    graph.addEdge(idA, idB, "relates_to");
    graph.addEdge(idB, idC, "relates_to");

    const results = expandWithGraphContext(graph, ["Node A"]);
    expect(results).toHaveLength(2);
    const nodeB = results.find(r => r.content === "Node B");
    const nodeC = results.find(r => r.content === "Node C");
    expect(nodeB).toBeDefined();
    expect(nodeB!._hopWeight).toBe(1.0);
    expect(nodeC).toBeDefined();
    expect(nodeC!._hopWeight).toBe(0.4);
  });

  test("caps total expanded nodes at 15", () => {
    const seed = graph.addNode("fact", "Seed node", undefined, 0.8);
    for (let i = 0; i < 20; i++) {
      const relId = graph.addNode("fact", `Related fact ${i}`, undefined, 0.5 + i * 0.01);
      graph.addEdge(seed, relId, "relates_to");
    }

    const results = expandWithGraphContext(graph, ["Seed node"]);
    expect(results.length).toBeLessThanOrEqual(15);
  });

  test("skips hop-2 when hop-1 returns >= 10 nodes", () => {
    const seed = graph.addNode("fact", "Seed node", undefined, 0.8);
    // Create 12 hop-1 nodes
    const hop1Ids: number[] = [];
    for (let i = 0; i < 12; i++) {
      const relId = graph.addNode("fact", `Hop1 node ${i}`, undefined, 0.6);
      graph.addEdge(seed, relId, "relates_to");
      hop1Ids.push(relId);
    }
    // Create a hop-2 node connected to the first hop-1 node
    const hop2Id = graph.addNode("fact", "Hop2 node", undefined, 0.8);
    graph.addEdge(hop1Ids[0], hop2Id, "relates_to");

    const results = expandWithGraphContext(graph, ["Seed node"]);
    // All results should be hop-1 (weight 1.0), no hop-2
    const hop2Result = results.find(r => r.content === "Hop2 node");
    expect(hop2Result).toBeUndefined();
    for (const r of results) {
      expect(r._hopWeight).toBe(1.0);
    }
  });

  test("filters hop-2 nodes below importance 0.3", () => {
    const idA = graph.addNode("fact", "Node A", undefined, 0.8);
    const idB = graph.addNode("fact", "Node B", undefined, 0.7);
    const idC = graph.addNode("fact", "Node C low importance", undefined, 0.1);
    graph.addEdge(idA, idB, "relates_to");
    graph.addEdge(idB, idC, "relates_to");

    const results = expandWithGraphContext(graph, ["Node A"]);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe("Node B");
    // Node C should NOT be included due to low importance
    const nodeC = results.find(r => r.content === "Node C low importance");
    expect(nodeC).toBeUndefined();
  });

  test("sorts by importance (contradictions first, then by importance DESC)", () => {
    const id1 = graph.addNode("fact", "Base node", undefined, 0.8);
    const id2 = graph.addNode("fact", "High importance related", undefined, 0.9);
    const id3 = graph.addNode("fact", "Low importance related", undefined, 0.3);
    const id4 = graph.addNode("fact", "Contradiction node", undefined, 0.4);
    graph.addEdge(id1, id2, "relates_to");
    graph.addEdge(id1, id3, "relates_to");
    graph.addEdge(id1, id4, "contradicts");

    const results = expandWithGraphContext(graph, ["Base node"]);
    // Contradiction first, then by importance
    expect(results[0].isContradiction).toBe(true);
    expect(results[1].importance).toBeGreaterThanOrEqual(results[2].importance);
  });
});

describe("findByContent", () => {
  let graph: GraphMemory;

  beforeEach(() => {
    graph = setupGraphMemory();
  });

  test("returns empty array for empty input", () => {
    expect(graph.findByContent([])).toEqual([]);
  });

  test("finds nodes by exact content match", () => {
    graph.addNode("fact", "Node A", undefined, 0.8);
    graph.addNode("fact", "Node B", undefined, 0.5);
    graph.addNode("fact", "Node C", undefined, 0.3);

    const results = graph.findByContent(["Node A", "Node C"]);
    expect(results).toHaveLength(2);
    const contents = results.map(r => r.content);
    expect(contents).toContain("Node A");
    expect(contents).toContain("Node C");
  });

  test("returns results ordered by importance DESC", () => {
    graph.addNode("fact", "Low", undefined, 0.2);
    graph.addNode("fact", "High", undefined, 0.9);
    graph.addNode("fact", "Mid", undefined, 0.5);

    const results = graph.findByContent(["Low", "High", "Mid"]);
    expect(results[0].content).toBe("High");
    expect(results[1].content).toBe("Mid");
    expect(results[2].content).toBe("Low");
  });
});

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  extractAndPersistMemories,
  findSemanticMatch,
  handleSemanticMatch,
  extractKeywords,
  crossLinkMemories,
  shouldSkipMemoryExtraction,
  buildKnowledgeBridgePlan,
  type MemoryExtractionDeps,
  type SemanticMatch,
} from "../queue/memory-extraction.js";
import { GraphMemory } from "../memory/graph.js";

/** Minimal stub that satisfies the graphMemory/router checks */
function makeDeps(overrides: Partial<MemoryExtractionDeps> = {}): MemoryExtractionDeps {
  return {
    graphMemory: {
      addNodeDedup: () => null,
      addNode: () => 1,
      addEdge: () => {},
      getExistingSummary: () => "",
      findSimilar: () => [],
      getNode: () => null,
      bumpMentionCount: () => {},
      searchAcrossConversations: () => [],
    } as any,
    router: {} as any,
    lastExtractionAt: new Map(),
    ...overrides,
  };
}

describe("extractAndPersistMemories", () => {
  test("skips system-channel tasks", async () => {
    const deps = makeDeps();
    await extractAndPersistMemories(deps, "conv-1", "nyx", "msg", "resp", "system", "proposal-executor");
    expect(deps.lastExtractionAt.size).toBe(0);
  });

  test("skips scheduler senders", async () => {
    const deps = makeDeps();
    await extractAndPersistMemories(deps, "conv-1", "nyx", "msg", "resp", "discord", "scheduler:heartbeat");
    expect(deps.lastExtractionAt.size).toBe(0);
  });

  test("skips proposal senders", async () => {
    const deps = makeDeps();
    await extractAndPersistMemories(deps, "conv-1", "nyx", "msg", "resp", "discord", "proposal-abc");
    expect(deps.lastExtractionAt.size).toBe(0);
  });

  test("skips when no graphMemory", async () => {
    const deps = makeDeps({ graphMemory: undefined });
    await extractAndPersistMemories(deps, "conv-1", "nyx", "msg", "resp", "discord", "user123");
    expect(deps.lastExtractionAt.size).toBe(0);
  });

  test("skips when no router", async () => {
    const deps = makeDeps({ router: undefined });
    await extractAndPersistMemories(deps, "conv-1", "nyx", "msg", "resp", "discord", "user123");
    expect(deps.lastExtractionAt.size).toBe(0);
  });

  test("sets rate limit timestamp even when extraction yields nothing", async () => {
    const deps = makeDeps();
    // Dynamic imports in the function will succeed (auto-extractor returns []),
    // but extractMemories may fail — either way, rate limit should be set.
    await extractAndPersistMemories(deps, "conv-1", "nyx", "hello", "hi there", "discord", "user123");
    expect(deps.lastExtractionAt.has("conv-1")).toBe(true);
  });

  test("rate limits subsequent calls within 5 minutes", async () => {
    const deps = makeDeps();
    // First call — sets timestamp
    await extractAndPersistMemories(deps, "conv-1", "nyx", "hello", "hi", "discord", "user123");
    const firstTs = deps.lastExtractionAt.get("conv-1")!;
    expect(firstTs).toBeGreaterThan(0);

    // Second call immediately — should be rate-limited (timestamp unchanged)
    await extractAndPersistMemories(deps, "conv-1", "nyx", "second", "response", "discord", "user123");
    expect(deps.lastExtractionAt.get("conv-1")).toBe(firstTs);
  });

  test("different conversations have independent rate limits", async () => {
    const deps = makeDeps();
    await extractAndPersistMemories(deps, "conv-1", "nyx", "hello", "hi", "discord", "user123");
    await extractAndPersistMemories(deps, "conv-2", "nyx", "hello", "hi", "discord", "user123");
    expect(deps.lastExtractionAt.has("conv-1")).toBe(true);
    expect(deps.lastExtractionAt.has("conv-2")).toBe(true);
  });
});

// --- Semantic dedup tests ---

describe("findSemanticMatch", () => {
  test("returns no match when knowledgeStore is undefined", async () => {
    const graphMemory = { findByContent: () => [] } as any;
    const result = await findSemanticMatch("some content", undefined, {} as any, graphMemory);
    expect(result).toEqual({ nodeId: null, similarity: 0 });
  });

  test("returns no match when embedder is undefined", async () => {
    const graphMemory = { findByContent: () => [] } as any;
    const result = await findSemanticMatch("some content", {} as any, undefined, graphMemory);
    expect(result).toEqual({ nodeId: null, similarity: 0 });
  });

  test("returns no match when knowledge store search returns empty", async () => {
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) } as any;
    const knowledge = { search: () => [] } as any;
    const graphMemory = { findByContent: () => [] } as any;
    const result = await findSemanticMatch("some content", knowledge, embedder, graphMemory);
    expect(result).toEqual({ nodeId: null, similarity: 0 });
  });

  test("returns match when knowledge store finds similar and graph has matching node", async () => {
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) } as any;
    const knowledge = {
      search: () => [{ content: "similar content", similarity: 0.92 }],
    } as any;
    const graphMemory = {
      findByContent: (contents: string[]) => {
        expect(contents).toEqual(["similar content"]);
        return [{ id: 42, content: "similar content" }];
      },
    } as any;

    const result = await findSemanticMatch("some content", knowledge, embedder, graphMemory);
    expect(result).toEqual({ nodeId: 42, similarity: 0.92 });
  });

  test("falls through to a later knowledge result when the top result has no graph node", async () => {
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) } as any;
    const knowledge = {
      search: () => [
        { content: "orphaned content", similarity: 0.94 },
        { content: "graph-backed content", similarity: 0.89 },
      ],
    } as any;
    const graphMemory = {
      findByContent: (contents: string[]) => {
        if (contents[0] === "orphaned content") return [];
        if (contents[0] === "graph-backed content") return [{ id: 77, content: "graph-backed content" }];
        return [];
      },
    } as any;

    const result = await findSemanticMatch("some content", knowledge, embedder, graphMemory);
    expect(result).toEqual({ nodeId: 77, similarity: 0.89 });
  });

  test("returns no match when knowledge store finds similar but no graph node exists", async () => {
    const embedder = { embed: async () => new Float32Array([1, 0, 0]) } as any;
    const knowledge = {
      search: () => [{ content: "orphaned content", similarity: 0.85 }],
    } as any;
    const graphMemory = { findByContent: () => [] } as any;

    const result = await findSemanticMatch("some content", knowledge, embedder, graphMemory);
    expect(result).toEqual({ nodeId: null, similarity: 0 });
  });

  test("handles embedding failure gracefully", async () => {
    const embedder = { embed: async () => { throw new Error("API down"); } } as any;
    const knowledge = {} as any;
    const graphMemory = { findByContent: () => [] } as any;

    const result = await findSemanticMatch("some content", knowledge, embedder, graphMemory);
    expect(result).toEqual({ nodeId: null, similarity: 0 });
  });
});

describe("handleSemanticMatch", () => {
  test("returns false when no match nodeId", () => {
    const match: SemanticMatch = { nodeId: null, similarity: 0 };
    const graph = { bumpMentionCount: () => {}, addEdge: () => {} } as any;
    expect(handleSemanticMatch(match, 10, graph)).toBe(false);
  });

  test("high similarity (>= 0.88) bumps mention count and returns true", () => {
    let bumpedId = -1;
    const graph = {
      bumpMentionCount: (id: number) => { bumpedId = id; },
      addEdge: () => {},
    } as any;
    const match: SemanticMatch = { nodeId: 42, similarity: 0.92 };

    const result = handleSemanticMatch(match, null, graph);
    expect(result).toBe(true);
    expect(bumpedId).toBe(42);
  });

  test("near match (0.75-0.88) adds related_to edge and returns false", () => {
    const edges: Array<[number, number, string]> = [];
    const graph = {
      bumpMentionCount: () => {},
      addEdge: (src: number, tgt: number, type: string) => { edges.push([src, tgt, type]); },
    } as any;
    const match: SemanticMatch = { nodeId: 42, similarity: 0.80 };

    const result = handleSemanticMatch(match, 99, graph);
    expect(result).toBe(false);
    expect(edges).toEqual([[99, 42, "related_to"]]);
  });

  test("near match without newNodeId does not add edge", () => {
    const edges: Array<[number, number, string]> = [];
    const graph = {
      bumpMentionCount: () => {},
      addEdge: (src: number, tgt: number, type: string) => { edges.push([src, tgt, type]); },
    } as any;
    const match: SemanticMatch = { nodeId: 42, similarity: 0.80 };

    const result = handleSemanticMatch(match, null, graph);
    expect(result).toBe(false);
    expect(edges).toEqual([]);
  });

  test("exact boundary 0.88 triggers bump (not edge)", () => {
    let bumped = false;
    const graph = {
      bumpMentionCount: () => { bumped = true; },
      addEdge: () => {},
    } as any;
    const match: SemanticMatch = { nodeId: 42, similarity: 0.88 };

    const result = handleSemanticMatch(match, 99, graph);
    expect(result).toBe(true);
    expect(bumped).toBe(true);
  });

  test("exact boundary 0.75 triggers edge addition", () => {
    const edges: Array<[number, number, string]> = [];
    const graph = {
      bumpMentionCount: () => {},
      addEdge: (src: number, tgt: number, type: string) => { edges.push([src, tgt, type]); },
    } as any;
    const match: SemanticMatch = { nodeId: 42, similarity: 0.75 };

    const result = handleSemanticMatch(match, 99, graph);
    expect(result).toBe(false);
    expect(edges).toEqual([[99, 42, "related_to"]]);
  });
});

// --- Integration tests: semantic dedup in extractAndPersistMemories ---

describe("extractAndPersistMemories — semantic dedup integration", () => {
  // We test semantic dedup by controlling what findSemanticMatch returns via
  // knowledge store and graph mocks. The auto-extractor needs real content that
  // triggers extraction, so we use a response containing a file path pattern.
  const testResponse = "Modified src/memory/graph.ts to add the new method";

  // Helper: make deps with controlled knowledge store behavior
  function makeDedupDeps(opts: {
    searchSimilarity: number;
    searchContent: string;
    graphNodeId: number | null;
    onBump?: (id: number) => void;
    onAddNodeDedup?: () => number | null;
    onAddEdge?: (src: number, tgt: number, type: string) => void;
  }) {
    return makeDeps({
      graphMemory: {
        addNodeDedup: opts.onAddNodeDedup ?? (() => null),
        addNode: () => 1,
        addEdge: opts.onAddEdge ?? (() => {}),
        getExistingSummary: () => "",
        findSimilar: () => [],
        bumpMentionCount: opts.onBump ?? (() => {}),
        findByContent: () => opts.graphNodeId ? [{ id: opts.graphNodeId, content: opts.searchContent }] : [],
        getNode: () => null,
        searchAcrossConversations: () => [],
      } as any,
      knowledge: {
        search: (_emb: any, _limit: any, threshold: number) => {
          // Only return results if similarity is above the threshold passed by findSemanticMatch (0.75)
          if (opts.searchSimilarity >= threshold) {
            return [{ content: opts.searchContent, similarity: opts.searchSimilarity }];
          }
          return [];
        },
        getExistingHashes: () => new Map(),
        upsertChunk: () => {},
      } as any,
      embedder: {
        embed: async () => new Float32Array([1, 0, 0]),
        embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])),
      } as any,
    });
  }

  test("merges semantically duplicate memory instead of creating new node", async () => {
    const bumpedIds: number[] = [];
    let addNodeDedupCalled = false;

    const deps = makeDedupDeps({
      searchSimilarity: 0.92,
      searchContent: "Touched file: src/memory/graph.ts",
      graphNodeId: 77,
      onBump: (id) => { bumpedIds.push(id); },
      onAddNodeDedup: () => { addNodeDedupCalled = true; return 1; },
    });

    await extractAndPersistMemories(deps, "conv-dedup", "nyx", "hello", testResponse, "discord", "user1");

    // High similarity (>= 0.88): should bump existing node, skip insertion
    expect(bumpedIds).toContain(77);
    expect(addNodeDedupCalled).toBe(false);
  });

  test("creates related_to edge for near-match (0.75-0.88)", async () => {
    const edges: Array<[number, number, string]> = [];
    let addNodeDedupCalled = false;

    const deps = makeDedupDeps({
      searchSimilarity: 0.80,
      searchContent: "Touched file: src/memory/graph.ts",
      graphNodeId: 50,
      onAddNodeDedup: () => { addNodeDedupCalled = true; return 10; },
      onAddEdge: (src, tgt, type) => { edges.push([src, tgt, type]); },
    });

    await extractAndPersistMemories(deps, "conv-near", "nyx", "hello", testResponse, "discord", "user1");

    // Near-match (0.75-0.88): should still insert, then add related_to edge
    expect(addNodeDedupCalled).toBe(true);
    expect(edges).toContainEqual([10, 50, "related_to"]);
  });

  test("creates standalone node for low similarity (<0.75)", async () => {
    let addNodeDedupCalled = false;
    let bumpCalled = false;
    const edges: Array<[number, number, string]> = [];

    const deps = makeDedupDeps({
      searchSimilarity: 0.40,
      searchContent: "something unrelated",
      graphNodeId: null,
      onBump: () => { bumpCalled = true; },
      onAddNodeDedup: () => { addNodeDedupCalled = true; return 20; },
      onAddEdge: (src, tgt, type) => { edges.push([src, tgt, type]); },
    });

    await extractAndPersistMemories(deps, "conv-low", "nyx", "hello", testResponse, "discord", "user1");

    // Low similarity (< 0.75): should insert as standalone, no bump, no edges
    expect(addNodeDedupCalled).toBe(true);
    expect(bumpCalled).toBe(false);
    expect(edges).toEqual([]);
  });
});

// --- Cross-conversation linking tests ---

describe("extractKeywords", () => {
  test("extracts significant keywords from content", () => {
    const result = extractKeywords("Fixed the database migration error in production environment");
    expect(result).not.toBeNull();
    // Should contain quoted terms joined by OR
    expect(result).toContain("OR");
    expect(result).toContain('"');
  });

  test("returns null for content with only short/stop words", () => {
    const result = extractKeywords("the and for are but not");
    expect(result).toBeNull();
  });

  test("filters stop words and short words", () => {
    const result = extractKeywords("using the updated file from this system");
    // "using", "updated", "file", "from", "this" are all stop words; "system" is 6 chars
    // Only "system" should survive
    expect(result).toContain('"system"');
  });

  test("picks longest words first", () => {
    const result = extractKeywords("authentication middleware configuration endpoint");
    expect(result).not.toBeNull();
    // "authentication" (14) > "configuration" (13) > "middleware" (10) > "endpoint" (8)
    expect(result!.startsWith('"authentication"')).toBe(true);
  });

  test("deduplicates repeated words", () => {
    const result = extractKeywords("error error error handling error");
    expect(result).not.toBeNull();
    // Should only appear once
    const matches = result!.match(/"error"/g);
    expect(matches?.length).toBe(1);
  });
});

describe("searchAcrossConversations", () => {
  function makeGraph(): GraphMemory {
    const db = new Database(":memory:");
    return new GraphMemory(db);
  }

  test("creates related_to edge between similar nodes from different conversations", () => {
    const graph = makeGraph();

    // Pre-populate a node from an old conversation
    const oldId = graph.addNode("pattern", "SQLite datetime mismatch causes query failures", {
      conversationId: "conv-old", channel: "discord",
    }, 0.7);

    // Add a similar node from a new conversation
    const newId = graph.addNode("pattern", "SQLite datetime format inconsistency between JS and SQL", {
      conversationId: "conv-new", channel: "discord",
    }, 0.6);

    // Search across conversations excluding conv-new — should find the old node
    const results = graph.searchAcrossConversations("conv-new", '"SQLite" OR "datetime"', 5);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.id === oldId)).toBe(true);
    // The new node should NOT appear (same conv excluded)
    expect(results.some((r) => r.id === newId)).toBe(false);
  });

  test("does not link nodes from same conversation", () => {
    const graph = makeGraph();

    // Two nodes from the same conversation
    graph.addNode("fact", "Provider circuit breaker configuration details", {
      conversationId: "conv-same", channel: "discord",
    }, 0.5);

    graph.addNode("fact", "Circuit breaker threshold configuration updated", {
      conversationId: "conv-same", channel: "discord",
    }, 0.5);

    // Search excluding conv-same — should find nothing
    const results = graph.searchAcrossConversations("conv-same", '"circuit" OR "breaker" OR "configuration"', 5);
    expect(results.length).toBe(0);
  });
});

describe("crossLinkMemories", () => {
  function makeGraph(): GraphMemory {
    const db = new Database(":memory:");
    return new GraphMemory(db);
  }

  test("bumps mention_count on both linked nodes", () => {
    const graph = makeGraph();

    // Old node from a previous conversation
    const oldId = graph.addNode("pattern", "Authentication middleware needs refresh token rotation", {
      conversationId: "conv-old", channel: "discord",
    }, 0.7);

    // New node from current conversation — similar topic
    const newId = graph.addNode("pattern", "Authentication middleware token refresh implementation complete", {
      conversationId: "conv-new", channel: "discord",
    }, 0.6);

    // Get initial mention counts
    const oldBefore = graph.getNode(oldId)!;
    const newBefore = graph.getNode(newId)!;
    expect(oldBefore.mention_count).toBe(1);
    expect(newBefore.mention_count).toBe(1);

    // Run cross-linking
    crossLinkMemories(graph, "conv-new", [newId]);

    // Verify edges were created
    const related = graph.getRelated(newId);
    const hasOldLink = related.some((r) => r.node.id === oldId && r.edge === "related_to");
    expect(hasOldLink).toBe(true);

    // Verify mention counts bumped on both sides
    const oldAfter = graph.getNode(oldId)!;
    const newAfter = graph.getNode(newId)!;
    expect(oldAfter.mention_count).toBeGreaterThan(oldBefore.mention_count);
    expect(newAfter.mention_count).toBeGreaterThan(newBefore.mention_count);
  });

  test("skips nodes with no extractable keywords", () => {
    const graph = makeGraph();

    // Old node
    graph.addNode("fact", "Something meaningful about configuration patterns", {
      conversationId: "conv-old", channel: "discord",
    }, 0.5);

    // New node with content too short/stopwordy to extract keywords
    const newId = graph.addNode("fact", "the and for but", {
      conversationId: "conv-new", channel: "discord",
    }, 0.5);

    // Should not throw, just skip
    crossLinkMemories(graph, "conv-new", [newId]);

    const related = graph.getRelated(newId);
    expect(related.length).toBe(0);
  });

  test("does not create edges for nodes with no cross-conv matches", () => {
    const graph = makeGraph();

    // Only node in the system — no other conversations to match against
    const newId = graph.addNode("decision", "Switched from PostgreSQL to SQLite for simplicity", {
      conversationId: "conv-new", channel: "discord",
    }, 0.8);

    crossLinkMemories(graph, "conv-new", [newId]);

    const related = graph.getRelated(newId);
    expect(related.length).toBe(0);
  });
});

describe("shouldSkipMemoryExtraction", () => {
  test("skips scheduler senders", () => {
    expect(shouldSkipMemoryExtraction("discord", "scheduler:heartbeat")).toBe(true);
  });

  test("skips proposal and system work", () => {
    expect(shouldSkipMemoryExtraction("discord", "proposal-review:proposal-123")).toBe(true);
    expect(shouldSkipMemoryExtraction("system", "proposal-executor")).toBe(true);
    expect(shouldSkipMemoryExtraction("discord", "system")).toBe(true);
  });

  test("does not skip normal user messages", () => {
    expect(shouldSkipMemoryExtraction("discord", "user123")).toBe(false);
  });
});

describe("buildKnowledgeBridgePlan", () => {
  test("filters existing conversation-memory chunks using the same key shape as KnowledgeStore", async () => {
    const plan = await buildKnowledgeBridgePlan(
      [
        { type: "fact", content: "remember this", importance: 0.9, source: "llm" },
      ],
      new Map([["conversation://conv-1::fact:d203c161::0", "d203c161f566ee7431c98855bbf4e63d"]]),
      "conv-1",
    );

    expect(plan).toEqual([]);
  });

  test("dedupes duplicate memories inside the same bridge batch", async () => {
    const plan = await buildKnowledgeBridgePlan(
      [
        { type: "fact", content: "same memory", importance: 0.9, source: "llm" },
        { type: "fact", content: "same memory", importance: 0.5, source: "heuristic" },
        { type: "decision", content: "different memory", importance: 0.6, source: "pattern" },
      ],
      new Map(),
      "conv-2",
    );

    expect(plan).toHaveLength(2);
    expect(plan[0]).toMatchObject({
      section: "fact:fb3b86a9",
      sourcePath: "conversation://conv-2",
      priority: 2,
    });
    expect(plan[1]).toMatchObject({
      section: "decision:6ad64482",
      sourcePath: "conversation://conv-2",
      priority: 1,
    });
  });
});

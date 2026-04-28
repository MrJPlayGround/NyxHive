import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { GraphMemory } from "../memory/graph.js";

function makeGraph(): GraphMemory {
  const db = new Database(":memory:");
  return new GraphMemory(db);
}

describe("GraphMemory", () => {
  let graph: GraphMemory;

  beforeEach(() => {
    graph = makeGraph();
  });

  // --- CRUD ---

  describe("addNode / getNode / deleteNode", () => {
    it("adds a node and retrieves it by id", () => {
      const id = graph.addNode("fact", "TypeScript uses structural typing");
      expect(id).toBeGreaterThan(0);

      const node = graph.getNode(id);
      expect(node).not.toBeNull();
      expect(node!.type).toBe("fact");
      expect(node!.content).toBe("TypeScript uses structural typing");
      expect(node!.importance).toBe(0.5);
      expect(node!.access_count).toBe(0);
    });

    it("stores source info when provided", () => {
      const id = graph.addNode("decision", "Use SQLite for storage", {
        conversationId: "conv-1",
        channel: "discord",
      });
      const node = graph.getNode(id);
      expect(node!.source_conversation).toBe("conv-1");
      expect(node!.source_channel).toBe("discord");
    });

    it("stores custom importance and expiry", () => {
      const expires = Date.now() + 86400_000;
      const id = graph.addNode("task", "Review PR", undefined, 0.9, expires);
      const node = graph.getNode(id);
      expect(node!.importance).toBe(0.9);
      expect(node!.expires_at).toBe(expires);
    });

    it("returns null for non-existent node", () => {
      expect(graph.getNode(9999)).toBeNull();
    });

    it("deletes a node", () => {
      const id = graph.addNode("fact", "to be deleted");
      graph.deleteNode(id);
      expect(graph.getNode(id)).toBeNull();
    });
  });

  // --- Edges ---

  describe("addEdge / getRelated", () => {
    it("creates an edge and retrieves related nodes", () => {
      const a = graph.addNode("decision", "Use Bun runtime");
      const b = graph.addNode("fact", "Bun is faster than Node");
      graph.addEdge(a, b, "related_to");

      const related = graph.getRelated(a);
      expect(related).toHaveLength(1);
      expect(related[0].node.id).toBe(b);
      expect(related[0].edge).toBe("related_to");
    });

    it("retrieves related nodes from both directions", () => {
      const a = graph.addNode("fact", "A");
      const b = graph.addNode("fact", "B");
      graph.addEdge(a, b, "caused_by");

      const relatedFromB = graph.getRelated(b);
      expect(relatedFromB).toHaveLength(1);
      expect(relatedFromB[0].node.id).toBe(a);
    });

    it("ignores duplicate edges (INSERT OR IGNORE)", () => {
      const a = graph.addNode("fact", "X");
      const b = graph.addNode("fact", "Y");
      graph.addEdge(a, b, "related_to");
      graph.addEdge(a, b, "related_to");
      expect(graph.getRelated(a)).toHaveLength(1);
    });
  });

  // --- Retrieval ---

  describe("getByType", () => {
    it("returns nodes of a given type sorted by importance", () => {
      graph.addNode("pattern", "Low importance", undefined, 0.2);
      graph.addNode("pattern", "High importance", undefined, 0.9);
      graph.addNode("fact", "Different type", undefined, 1.0);

      const patterns = graph.getByType("pattern");
      expect(patterns).toHaveLength(2);
      expect(patterns[0].content).toBe("High importance");
    });

    it("respects limit", () => {
      for (let i = 0; i < 5; i++) graph.addNode("error", `Error ${i}`);
      expect(graph.getByType("error", 3)).toHaveLength(3);
    });
  });

  describe("findByContent", () => {
    it("finds nodes with exact content match", () => {
      graph.addNode("fact", "Alpha");
      graph.addNode("fact", "Beta");
      graph.addNode("fact", "Gamma");

      const found = graph.findByContent(["Alpha", "Gamma"]);
      expect(found).toHaveLength(2);
    });

    it("returns empty for empty input", () => {
      expect(graph.findByContent([])).toEqual([]);
    });
  });

  describe("search (FTS5)", () => {
    it("finds nodes by keyword search", () => {
      graph.addNode("fact", "TypeScript uses structural typing for interfaces");
      graph.addNode("fact", "Python uses duck typing");
      graph.addNode("decision", "We chose PostgreSQL for the database");

      const results = graph.search("TypeScript typing");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some(r => r.content.includes("TypeScript"))).toBe(true);
    });

    it("filters by type when provided", () => {
      graph.addNode("fact", "Bun runtime is fast");
      graph.addNode("decision", "Bun was chosen as the runtime");

      const decisions = graph.search("Bun runtime", ["decision"]);
      expect(decisions.every(r => r.type === "decision")).toBe(true);
    });

    it("returns empty for short words (<=2 chars)", () => {
      graph.addNode("fact", "ab cd ef");
      expect(graph.search("ab")).toEqual([]);
    });

    it("returns empty for empty query", () => {
      expect(graph.search("")).toEqual([]);
    });
  });

  // --- Importance ---

  describe("touchNode", () => {
    it("increments access_count and updates accessed_at", () => {
      const id = graph.addNode("fact", "touchable node");
      const before = graph.getNode(id)!;

      graph.touchNode(id);
      const after = graph.getNode(id)!;
      expect(after.access_count).toBe(before.access_count + 1);
      expect(after.accessed_at).toBeGreaterThanOrEqual(before.accessed_at);
    });
  });

  describe("decayImportance", () => {
    it("recalculates importance for all non-expired nodes", () => {
      const id = graph.addNode("fact", "old node", undefined, 0.8);
      const db = (graph as any).db as Database;
      const oldTime = Date.now() - 60 * 24 * 60 * 60 * 1000;
      db.prepare("UPDATE memory_nodes SET created_at = ? WHERE id = ?").run(oldTime, id);

      graph.decayImportance();
      const node = graph.getNode(id)!;
      expect(node.importance).toBeLessThan(0.8);
    });
  });

  // --- Deduplication ---

  describe("hasExactContent / addNodeDedup", () => {
    it("detects exact duplicates", () => {
      graph.addNode("fact", "unique content");
      expect(graph.hasExactContent("fact", "unique content")).toBe(true);
      expect(graph.hasExactContent("fact", "different content")).toBe(false);
      expect(graph.hasExactContent("decision", "unique content")).toBe(false);
    });

    it("addNodeDedup returns null for duplicates", () => {
      const id1 = graph.addNodeDedup("fact", "dedup test");
      expect(id1).not.toBeNull();

      const id2 = graph.addNodeDedup("fact", "dedup test");
      expect(id2).toBeNull();
    });

    it("addNodeDedup inserts when no duplicate exists", () => {
      const id = graph.addNodeDedup("pattern", "new pattern");
      expect(id).not.toBeNull();
      expect(graph.getNode(id!)).not.toBeNull();
    });
  });

  describe("findSimilar", () => {
    it("finds similar content via FTS", () => {
      graph.addNode("fact", "The authentication module uses bcrypt for password hashing");
      graph.addNode("fact", "Redis caching layer improves response times");

      const similar = graph.findSimilar("fact", "authentication bcrypt password security");
      expect(similar.length).toBeGreaterThan(0);
      expect(similar[0].content).toContain("authentication");
    });

    it("returns empty for very short words", () => {
      graph.addNode("fact", "ab cd");
      expect(graph.findSimilar("fact", "ab cd")).toEqual([]);
    });
  });

  // --- Contradiction detection ---

  describe("getContradictions", () => {
    it("returns pairs connected by contradicts edges", () => {
      const a = graph.addNode("fact", "SQLite is the best DB");
      const b = graph.addNode("fact", "PostgreSQL is the best DB");
      graph.addEdge(a, b, "contradicts");

      const contradictions = graph.getContradictions();
      expect(contradictions).toHaveLength(1);
      expect(contradictions[0].a.id).toBe(a);
      expect(contradictions[0].b.id).toBe(b);
    });

    it("returns empty when no contradictions exist", () => {
      graph.addNode("fact", "A");
      graph.addNode("fact", "B");
      expect(graph.getContradictions()).toEqual([]);
    });
  });

  // --- Cleanup ---

  describe("pruneExpired", () => {
    it("removes expired nodes", () => {
      const countBefore = graph.getNodeCount();
      const pastExpiry = Date.now() - 1000;
      graph.addNode("task", "expired task", undefined, 0.5, pastExpiry);
      graph.addNode("fact", "permanent fact");

      const pruned = graph.pruneExpired();
      expect(pruned).toBeGreaterThanOrEqual(1);
      // The permanent fact should survive
      expect(graph.getNodeCount()).toBe(countBefore + 1);
    });

    it("keeps nodes with future expiry", () => {
      const futureExpiry = Date.now() + 86400_000;
      graph.addNode("task", "future task", undefined, 0.5, futureExpiry);
      expect(graph.pruneExpired()).toBe(0);
    });
  });

  describe("pruneByImportance", () => {
    it("removes nodes below importance threshold", () => {
      graph.addNode("fact", "important", undefined, 0.9);
      const id = graph.addNode("fact", "old and unimportant", undefined, 0.01);
      const db = (graph as any).db as Database;
      db.prepare("UPDATE memory_nodes SET created_at = ? WHERE id = ?").run(
        Date.now() - 365 * 24 * 60 * 60 * 1000,
        id,
      );

      const pruned = graph.pruneByImportance(0.05);
      expect(pruned).toBeGreaterThanOrEqual(1);
    });
  });

  // --- Counts ---

  describe("getNodeCount / getEdgeCount", () => {
    it("counts nodes and edges", () => {
      expect(graph.getNodeCount()).toBe(0);
      expect(graph.getEdgeCount()).toBe(0);

      const a = graph.addNode("fact", "A");
      const b = graph.addNode("fact", "B");
      graph.addEdge(a, b, "related_to");

      expect(graph.getNodeCount()).toBe(2);
      expect(graph.getEdgeCount()).toBe(1);
    });
  });

  // --- Briefing ---

  describe("getBriefing", () => {
    it("returns formatted briefing text", () => {
      graph.addNode("decision", "Use SQLite everywhere", undefined, 0.9);
      graph.addNode("pattern", "Always run tests before commit", undefined, 0.8);

      const briefing = graph.getBriefing();
      expect(briefing).toContain("Use SQLite everywhere");
      expect(briefing).toContain("Always run tests before commit");
    });

    it("respects token budget", () => {
      for (let i = 0; i < 50; i++) {
        graph.addNode("fact", `Fact number ${i} with some extra content to use tokens`, undefined, 0.9);
      }
      const briefing = graph.getBriefing(50, undefined, 50);
      const lines = briefing.split("\n").filter(l => l.startsWith("- "));
      expect(lines.length).toBeLessThan(50);
    });

    it("filters by channel when provided", () => {
      graph.addNode("fact", "Discord fact", { conversationId: "c1", channel: "discord" });
      graph.addNode("fact", "Telegram fact", { conversationId: "c2", channel: "telegram" });

      const briefing = graph.getBriefing(20, "discord");
      expect(briefing).toContain("Discord fact");
      expect(briefing).not.toContain("Telegram fact");
    });

    it("returns empty for no nodes", () => {
      expect(graph.getBriefing()).toBe("");
    });
  });

  describe("getRelevantBriefing", () => {
    it("returns empty for no nodes", () => {
      expect(graph.getRelevantBriefing({})).toBe("");
    });

    it("boosts nodes matching file paths", () => {
      graph.addNode("decision", "The router.ts module uses circuit breakers", undefined, 0.8);
      graph.addNode("decision", "Auth uses bcrypt hashing", undefined, 0.8);

      const briefing = graph.getRelevantBriefing({
        filePaths: ["src/providers/router.ts"],
        maxTokens: 2000,
      });
      expect(briefing).toContain("router.ts");
    });

    it("boosts error nodes for debug tasks", () => {
      graph.addNode("error", "Circuit breaker trips too early", undefined, 0.5);
      graph.addNode("pattern", "Use retry with backoff", undefined, 0.5);

      const briefing = graph.getRelevantBriefing({
        taskType: "debug",
        keywords: ["circuit", "breaker"],
        maxTokens: 2000,
      });
      expect(briefing).toContain("Circuit breaker");
    });

    it("respects maxTokens budget", () => {
      for (let i = 0; i < 30; i++) {
        graph.addNode("fact", `Knowledge item ${i} about the system architecture and design decisions`, undefined, 0.8);
      }
      const briefing = graph.getRelevantBriefing({ maxTokens: 100 });
      const lines = briefing.split("\n").filter(l => l.startsWith("- "));
      expect(lines.length).toBeLessThan(30);
    });
  });

  // --- getNodeWithEdges ---

  describe("getNodeWithEdges", () => {
    it("returns node with its edges and related nodes", () => {
      const a = graph.addNode("decision", "Main decision");
      const b = graph.addNode("fact", "Supporting fact");
      const c = graph.addNode("pattern", "Related pattern");
      graph.addEdge(a, b, "caused_by");
      graph.addEdge(a, c, "related_to");

      const result = graph.getNodeWithEdges(a);
      expect(result).not.toBeNull();
      expect(result!.node.id).toBe(a);
      expect(result!.edges).toHaveLength(2);
    });

    it("returns null for non-existent node", () => {
      expect(graph.getNodeWithEdges(9999)).toBeNull();
    });
  });

  // --- Semantic dedup: mention_count ---

  describe("mention_count", () => {
    it("addNode stores mention_count default 1", () => {
      const id = graph.addNode("fact", "repeated observation");
      const db = (graph as any).db as Database;
      const row = db.prepare("SELECT mention_count FROM memory_nodes WHERE id = ?").get(id) as { mention_count: number };
      expect(row.mention_count).toBe(1);
    });

    it("bumpMentionCount increments and enforces importance floor", () => {
      const id = graph.addNode("fact", "recurring pattern", undefined, 0.3);
      graph.bumpMentionCount(id);
      graph.bumpMentionCount(id);
      // mention_count should now be 3 (1 default + 2 bumps)
      const node = graph.getNode(id)!;
      const db = (graph as any).db as Database;
      const row = db.prepare("SELECT mention_count FROM memory_nodes WHERE id = ?").get(id) as { mention_count: number };
      expect(row.mention_count).toBe(3);
      // importance should be >= 0.6 (floor enforced at mention_count >= 3)
      expect(node.importance).toBeGreaterThanOrEqual(0.6);
    });

    it("getRecurringPatterns returns nodes with mention_count >= 3", () => {
      const id1 = graph.addNode("fact", "seen often");
      graph.bumpMentionCount(id1);
      graph.bumpMentionCount(id1); // mention_count = 3

      const id2 = graph.addNode("fact", "seen once"); // mention_count = 1

      const patterns = graph.getRecurringPatterns(10);
      expect(patterns).toHaveLength(1);
      expect(patterns[0].id).toBe(id1);
    });
  });

  // --- Recurring patterns in briefing ---

  describe("recurring patterns in briefing", () => {
    it("getRelevantBriefing includes recurring patterns section", () => {
      const id = graph.addNode("fact", "Users prefer dark mode");
      graph.bumpMentionCount(id);
      graph.bumpMentionCount(id); // mention_count = 3

      const briefing = graph.getRelevantBriefing({ maxTokens: 2000 });
      expect(briefing).toContain("Recurring patterns");
      expect(briefing).toContain("Users prefer dark mode");
      expect(briefing).toContain("seen 3x");
    });

    it("recurring patterns appear before regular briefing content in getRelevantBriefing", () => {
      const recurringId = graph.addNode("fact", "Recurring dark mode preference");
      graph.bumpMentionCount(recurringId);
      graph.bumpMentionCount(recurringId); // mention_count = 3

      graph.addNode("decision", "Use SQLite for storage", undefined, 0.9);

      const briefing = graph.getRelevantBriefing({ maxTokens: 2000 });
      const recurringIdx = briefing.indexOf("Recurring patterns");
      const contextIdx = briefing.indexOf("## Context from Previous Sessions");
      expect(recurringIdx).toBeGreaterThanOrEqual(0);
      expect(contextIdx).toBeGreaterThan(recurringIdx);
    });

    it("counts recurring patterns against getRelevantBriefing token budget", () => {
      for (let i = 0; i < 10; i++) {
        const id = graph.addNode("fact", `Recurring preference ${i} with enough detail to make this line expensive in prompt context`);
        graph.bumpMentionCount(id);
        graph.bumpMentionCount(id);
      }

      const briefing = graph.getRelevantBriefing({ maxTokens: 40 });

      expect(Math.ceil(briefing.length / 4)).toBeLessThanOrEqual(50);
    });

    it("only injects task-relevant recurring patterns in getRelevantBriefing", () => {
      const statusId = graph.addNode("fact", "Current repository health is green and the worktree is clean", undefined, 0.95);
      const memoryPriorityId = graph.addNode("decision", "Memory priority is eval harness and hygiene first, then temporal provenance", undefined, 0.8);
      graph.bumpMentionCount(statusId);
      graph.bumpMentionCount(statusId);
      graph.bumpMentionCount(memoryPriorityId);
      graph.bumpMentionCount(memoryPriorityId);

      const briefing = graph.getRelevantBriefing({
        keywords: ["memory", "eval", "hygiene", "priority"],
        maxTokens: 120,
      });

      expect(briefing).toContain("Memory priority is eval harness and hygiene first");
      expect(briefing).not.toContain("Current repository health is green");
    });

    it("scores recurring candidates for relevance before applying the final limit", () => {
      for (let i = 0; i < 40; i++) {
        const id = graph.addNode("fact", `High-frequency unrelated operational memory ${i}`);
        for (let j = 0; j < 4; j++) graph.bumpMentionCount(id);
      }
      const relevantId = graph.addNode("decision", "Memory priority is eval harness and hygiene first", undefined, 0.8);
      graph.bumpMentionCount(relevantId);
      graph.bumpMentionCount(relevantId);

      const briefing = graph.getRelevantBriefing({
        keywords: ["memory", "eval", "hygiene", "priority"],
        maxTokens: 120,
      });

      expect(briefing).toContain("Memory priority is eval harness and hygiene first");
    });

    it("ranks multi-keyword matches above high-access weak matches", () => {
      const weakId = graph.addNode("fact", "Memory architecture roadmap from an older planning session", undefined, 0.95);
      for (let i = 0; i < 30; i++) graph.touchNode(weakId);
      graph.addNode("decision", "Memory priority is eval harness and hygiene first", undefined, 0.8);

      const briefing = graph.getRelevantBriefing({
        keywords: ["memory", "eval", "harness", "hygiene", "priority"],
        maxTokens: 40,
      });

      expect(briefing).toContain("Memory priority is eval harness and hygiene first");
      expect(briefing).not.toContain("older planning session");
    });

    it("no recurring patterns section in getRelevantBriefing when none exist", () => {
      graph.addNode("fact", "Single mention fact", undefined, 0.8);
      const briefing = graph.getRelevantBriefing({ maxTokens: 2000 });
      expect(briefing).not.toContain("Recurring patterns");
    });

    it("getBriefing includes recurring patterns section", () => {
      const id = graph.addNode("pattern", "Always run tests before commit");
      graph.bumpMentionCount(id);
      graph.bumpMentionCount(id); // mention_count = 3

      const briefing = graph.getBriefing();
      expect(briefing).toContain("Recurring patterns");
      expect(briefing).toContain("Always run tests before commit");
      expect(briefing).toContain("seen 3x");
    });

    it("counts recurring patterns against getBriefing token budget", () => {
      for (let i = 0; i < 10; i++) {
        const id = graph.addNode("pattern", `Recurring runtime pattern ${i} with enough detail to exhaust a small prompt budget quickly`);
        graph.bumpMentionCount(id);
        graph.bumpMentionCount(id);
      }

      const briefing = graph.getBriefing(20, undefined, 40);

      expect(Math.ceil(briefing.length / 4)).toBeLessThanOrEqual(50);
    });

    it("recurring patterns appear before regular briefing content in getBriefing", () => {
      const recurringId = graph.addNode("pattern", "Recurring test pattern");
      graph.bumpMentionCount(recurringId);
      graph.bumpMentionCount(recurringId);

      graph.addNode("decision", "Use Bun runtime", undefined, 0.9);

      const briefing = graph.getBriefing();
      const recurringIdx = briefing.indexOf("Recurring patterns");
      const typeIdx = briefing.indexOf("[");
      // Recurring patterns block starts with "**Recurring patterns:**"
      // The first "[type]" header should come after
      expect(recurringIdx).toBeGreaterThanOrEqual(0);
      // Find first type section header (skip past the recurring block)
      const afterRecurring = briefing.indexOf("\n\n", recurringIdx);
      const firstTypeHeader = briefing.indexOf("[", afterRecurring);
      expect(firstTypeHeader).toBeGreaterThan(recurringIdx);
    });

    it("no recurring patterns section in getBriefing when none exist", () => {
      graph.addNode("fact", "Single mention", undefined, 0.8);
      const briefing = graph.getBriefing();
      expect(briefing).not.toContain("Recurring patterns");
    });

    it("expires runtime briefing noise without touching durable memories", () => {
      const statusId = graph.addNode("fact", "Current repository health is green and the worktree is clean", undefined, 0.95);
      const fileId = graph.addNode("file_change", "Touched file: src/memory/graph.ts", undefined, 0.95);
      const testId = graph.addNode("fact", "Test failure resolved during coding task", undefined, 0.95);
      const durableId = graph.addNode("preference", "User prefers casual BDO chat to stay Quick/low unless action is requested.", undefined, 0.95);

      const result = graph.expireRuntimeBriefingNoise();

      expect(result.expired).toBe(3);
      expect(graph.getNode(statusId)?.expires_at).toBeLessThanOrEqual(Date.now());
      expect(graph.getNode(fileId)?.expires_at).toBeLessThanOrEqual(Date.now());
      expect(graph.getNode(testId)?.expires_at).toBeLessThanOrEqual(Date.now());
      expect(graph.getNode(durableId)?.expires_at).toBeNull();
    });
  });

  // --- getExistingSummary ---

  describe("getExistingSummary", () => {
    it("returns formatted summary of existing memories", () => {
      graph.addNode("fact", "Bun is fast");
      graph.addNode("decision", "Use TypeScript");

      const summary = graph.getExistingSummary();
      expect(summary).toContain("[fact] Bun is fast");
      expect(summary).toContain("[decision] Use TypeScript");
    });

    it("returns 'None yet.' when empty", () => {
      expect(graph.getExistingSummary()).toBe("None yet.");
    });
  });
});

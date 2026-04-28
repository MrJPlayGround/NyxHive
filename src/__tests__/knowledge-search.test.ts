import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../memory/store.js";
import { KnowledgeStore } from "../memory/knowledge.js";
import { buildKnowledgeArtifactSourceUri, hashContextSource } from "../memory/retrieval-trace.js";
import { applyRetrievalFeedback, mergeKnowledgeContext, searchKnowledgeWithChunks } from "../queue/knowledge-search.js";

function mockKnowledgeStore() {
  const nudges: Array<{ id: number; delta: number }> = [];
  return {
    nudges,
    nudgeConfidence(id: number, delta: number) { nudges.push({ id, delta }); },
  };
}

const cleanupDirs: string[] = [];
const cleanupStores: Array<{ memory: MemoryStore; knowledge: KnowledgeStore }> = [];

afterEach(() => {
  for (const stores of cleanupStores.splice(0)) {
    try { stores.knowledge.close(); } catch { /* ignore */ }
    try { stores.memory.close(); } catch { /* ignore */ }
  }
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeEmbedding(values: number[]): Float32Array {
  return new Float32Array(values);
}

function createStores() {
  const dir = mkdtempSync(join(tmpdir(), "nyxhive-knowledge-search-"));
  cleanupDirs.push(dir);
  const memory = new MemoryStore(dir);
  const knowledge = new KnowledgeStore(dir, "test", 4);
  knowledge.setContextMetadataStore(memory);
  cleanupStores.push({ memory, knowledge });
  return { dir, memory, knowledge };
}

function createEmbedder(vector = [1, 0, 0, 0]) {
  return {
    embed: async () => makeEmbedding(vector),
    embedBatch: async (texts: string[]) => texts.map(() => makeEmbedding(vector)),
    dimensions: vector.length,
  };
}

describe("applyRetrievalFeedback", () => {
  it("boosts confidence when 30%+ of 4+ char keywords match response", () => {
    const store = mockKnowledgeStore();
    const snippets = new Map<number, string>();
    // Snippet with words: "nyxhive", "multi", "agent", "orchestrator" (all 4+ chars)
    snippets.set(1, "NyxHive multi agent orchestrator");

    // Response containing enough keywords to exceed 30% threshold
    const response = "The nyxhive orchestrator handles agent routing";

    applyRetrievalFeedback(store as any, snippets, response);

    expect(store.nudges).toEqual([{ id: 1, delta: 0.02 }]);
  });

  it("decays confidence when keywords don't match", () => {
    const store = mockKnowledgeStore();
    const snippets = new Map<number, string>();
    snippets.set(1, "NyxHive multi agent orchestrator");

    const response = "The weather is nice today";

    applyRetrievalFeedback(store as any, snippets, response);

    expect(store.nudges).toEqual([{ id: 1, delta: -0.01 }]);
  });

  it("no-op when snippets map is empty", () => {
    const store = mockKnowledgeStore();
    const snippets = new Map<number, string>();

    applyRetrievalFeedback(store as any, snippets, "some response");

    expect(store.nudges).toEqual([]);
  });

  it("handles multiple chunks independently (one boosted, one decayed)", () => {
    const store = mockKnowledgeStore();
    const snippets = new Map<number, string>();
    snippets.set(1, "NyxHive multi agent orchestrator");
    snippets.set(2, "Supabase database integration testing");

    // Response references chunk 1 keywords but not chunk 2
    const response = "The nyxhive orchestrator uses multi agent routing";

    applyRetrievalFeedback(store as any, snippets, response);

    expect(store.nudges).toHaveLength(2);
    expect(store.nudges).toContainEqual({ id: 1, delta: 0.02 });
    expect(store.nudges).toContainEqual({ id: 2, delta: -0.01 });
  });
});

describe("mergeKnowledgeContext", () => {
  it("returns null when both inputs null", () => {
    expect(mergeKnowledgeContext(null, null)).toBeNull();
  });

  it("returns parent when task is null", () => {
    const parent = "[Source: [[Architecture]]]\nSome content";
    expect(mergeKnowledgeContext(parent, null)).toBe(parent);
  });

  it("returns task when parent is null", () => {
    const task = "[Source: [[Config]]]\nConfig content";
    expect(mergeKnowledgeContext(null, task)).toBe(task);
  });

  it("deduplicates by source link", () => {
    const parent = "[Source: [[Architecture]]]\nParent content";
    const task = "[Source: [[Architecture]]]\nTask content";

    const result = mergeKnowledgeContext(parent, task);

    // Should only contain the parent version (first seen wins)
    expect(result).toBe("[Source: [[Architecture]]]\nParent content");
  });

  it("merges unique chunks from both parent and task", () => {
    const parent = "[Source: [[Architecture]]]\nArch content";
    const task = "[Source: [[Config]]]\nConfig content";

    const result = mergeKnowledgeContext(parent, task);

    expect(result).toContain("[Source: [[Architecture]]]");
    expect(result).toContain("[Source: [[Config]]]");
    expect(result).toContain("Arch content");
    expect(result).toContain("Config content");
  });

  it("caps output at 2000 chars", () => {
    const longChunk = "[Source: [[Big]]]\n" + "x".repeat(1500);
    const another = "[Source: [[Also Big]]]\n" + "y".repeat(1500);

    const result = mergeKnowledgeContext(longChunk, another);

    expect(result!.length).toBeLessThanOrEqual(2000);
  });
});

describe("searchKnowledgeWithChunks", () => {
  it("captures retrieval traces and enqueues missing artifacts", async () => {
    const { memory, knowledge } = createStores();
    const enqueued: Array<{ sourceUri: string; priority: number }> = [];
    memory.setArtifactQueue({
      enqueue(job) {
        enqueued.push({ sourceUri: job.sourceUri, priority: job.priority });
      },
    });

    knowledge.upsertChunk("Doc A", "Overview", "Relevant content for the agent", "docs", "/doc-a.md", "hash-a", makeEmbedding([1, 0, 0, 0]), "global", 1, undefined, 0);
    knowledge.upsertChunk("Doc B", "Appendix", "Barely related material", "docs", "/doc-b.md", "hash-b", makeEmbedding([0.6, 0.8, 0, 0]), "global", 1, undefined, 0);

    const result = await searchKnowledgeWithChunks(
      {
        knowledge,
        memory,
        embedder: createEmbedder([1, 0, 0, 0]),
      },
      "retrieve doc a",
    );

    expect(result.context).toContain("[[Doc A#Overview]]");
    expect(result.trace.candidateCount).toBe(2);
    expect(result.trace.scannedCount).toBe(2);
    expect(result.trace.rerankedCount).toBe(2);
    expect(result.trace.strategy).toBe("fts_prefilter_with_full_scan_fallback");
    expect(result.trace.passedGateCount).toBe(1);
    expect(result.trace.injectedCount).toBe(1);
    expect(result.trace.memoryLanesInjected).toContain("knowledge_chunk");
    expect(result.trace.chunks.find((chunk) => chunk.injected)?.memoryLane).toBe("knowledge_chunk");
    expect(result.trace.chunks.some((chunk) => chunk.cutReason === "gate")).toBe(true);
    expect(enqueued).toContainEqual({ sourceUri: buildKnowledgeArtifactSourceUri(result.chunkIds[0]!), priority: 1 });
  });

  it("injects fresh L1 overviews before raw chunk content", async () => {
    const { memory, knowledge } = createStores();
    knowledge.upsertChunk("Doc A", "Overview", "Detailed raw content for the agent", "docs", "/doc-a.md", "hash-a", makeEmbedding([1, 0, 0, 0]), "global", 1, undefined, 0);
    const chunkId = knowledge.search(makeEmbedding([1, 0, 0, 0]), 1, 0.1)[0]?.id;
    expect(chunkId).toBeDefined();

    memory.saveContextArtifact({
      sourceUri: buildKnowledgeArtifactSourceUri(chunkId!),
      sourceType: "knowledge_chunk",
      sourceHash: hashContextSource("Detailed raw content for the agent"),
      l0Abstract: "Raw content summary",
      l1Overview: "- Overview bullet one\n- Overview bullet two",
      generationModel: "test/model",
    });

    const result = await searchKnowledgeWithChunks(
      {
        knowledge,
        memory,
        embedder: createEmbedder([1, 0, 0, 0]),
      },
      "retrieve doc a",
    );

    expect(result.context).toContain("[Overview]");
    expect(result.context).toContain("Overview bullet one");
    expect(result.trace.injectedCount).toBe(1);
  });

  it("adds sibling chunks through path-tree expansion when a document has multiple hits", async () => {
    const { memory, knowledge } = createStores();
    const embedder = createEmbedder([1, 0, 0, 0]);

    knowledge.upsertChunk("Guide", "Intro", "Intro content", "docs", "/guide.md", "hash-1", makeEmbedding([1, 0, 0, 0]), "global", 1, undefined, 0);
    knowledge.upsertChunk("Guide", "Install", "Install content", "docs", "/guide.md", "hash-2", makeEmbedding([0.97, 0.03, 0, 0]), "global", 1, undefined, 1);
    knowledge.upsertChunk("Guide", "Advanced", "Advanced content", "docs", "/guide.md", "hash-3", makeEmbedding([0.8, 0.2, 0, 0]), "global", 1, undefined, 2);
    knowledge.upsertChunk("Other", "Note", "Distractor content", "docs", "/other.md", "hash-4", makeEmbedding([0.95, 0.05, 0, 0]), "global", 1, undefined, 0);

    const result = await searchKnowledgeWithChunks(
      {
        knowledge,
        memory,
        embedder,
      },
      "guide",
    );

    expect(result.context).toContain("[[Guide#Advanced]]");
    expect(result.trace.chunks.some((chunk) => chunk.retrievalSource === "path_tree_expansion" && chunk.injected)).toBe(true);
  });
});

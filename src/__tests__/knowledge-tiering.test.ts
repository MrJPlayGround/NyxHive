import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { KnowledgeStore } from "../memory/knowledge.js";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function createTestStore(): KnowledgeStore {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-tier-test-"));
  return new KnowledgeStore(dir, "test", 4); // 4 dimensions for test embeddings
}

function makeEmbedding(vals: number[]): Float32Array {
  return new Float32Array(vals);
}

describe("Knowledge tiering", () => {
  let store: KnowledgeStore;

  beforeEach(() => {
    store = createTestStore();
  });

  test("pruneStale removes old chunks but not critical ones", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);

    // Insert chunks with various priorities
    store.upsertChunk("Low priority old", null, "content1", "test", "/test1.md", "h1", emb, "global", 1);
    store.upsertChunk("Critical old", null, "content2", "test", "/test2.md", "h2", emb, "global", 3);
    store.upsertChunk("Low priority recent", null, "content3", "test", "/test3.md", "h3", emb, "global", 1);

    // Manually set accessed_at: make first two chunks 100 days old, third is recent
    const db = (store as unknown as { db: Database }).db;
    const oldTs = Date.now() - 100 * 24 * 60 * 60 * 1000;
    db.exec(`UPDATE knowledge_chunks SET accessed_at = ${oldTs} WHERE source_path IN ('/test1.md', '/test2.md')`);
    db.exec(`UPDATE knowledge_chunks SET accessed_at = ${Date.now()} WHERE source_path = '/test3.md'`);

    const pruned = store.pruneStale(90);

    // Only the low-priority old chunk should be pruned
    expect(pruned).toBe(1);

    // Critical chunk should survive even though it's old
    const stats = store.getStats();
    expect(stats.totalChunks).toBe(2);
  });

  test("search updates accessed_at on returned results", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Test chunk", null, "test content", "test", "/test.md", "h1", emb);

    // Set accessed_at to something old
    const db = (store as unknown as { db: Database }).db;
    const oldTs = Date.now() - 50 * 24 * 60 * 60 * 1000;
    db.exec(`UPDATE knowledge_chunks SET accessed_at = ${oldTs}`);

    // Search should update accessed_at
    const before = Date.now();
    store.search(emb, 5, 0.5);

    const row = db.prepare("SELECT accessed_at FROM knowledge_chunks WHERE source_path = ?").get("/test.md") as { accessed_at: number };
    expect(row.accessed_at).toBeGreaterThanOrEqual(before);
  });

  test("getStats returns tier distribution", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    const db = (store as unknown as { db: Database }).db;
    const now = Date.now();

    // Insert chunks in different tiers
    store.upsertChunk("Critical", null, "c1", "test", "/c1.md", "h1", emb, "global", 3);
    store.upsertChunk("Active", null, "c2", "test", "/c2.md", "h2", emb, "global", 1);
    store.upsertChunk("Archive", null, "c3", "test", "/c3.md", "h3", emb, "global", 1);
    store.upsertChunk("Stale", null, "c4", "test", "/c4.md", "h4", emb, "global", 1);

    // Set access times
    db.exec(`UPDATE knowledge_chunks SET accessed_at = ${now} WHERE source_path = '/c2.md'`);
    db.exec(`UPDATE knowledge_chunks SET accessed_at = ${now - 60 * 24 * 60 * 60 * 1000} WHERE source_path = '/c3.md'`); // 60 days ago
    db.exec(`UPDATE knowledge_chunks SET accessed_at = ${now - 100 * 24 * 60 * 60 * 1000} WHERE source_path = '/c4.md'`); // 100 days ago

    const stats = store.getStats();
    expect(stats.tiers).toBeDefined();
    expect(stats.tiers!.critical).toBe(1);
    expect(stats.tiers!.active).toBe(1);
    expect(stats.tiers!.archive).toBe(1);
    expect(stats.tiers!.stale).toBe(1);
  });

  test("stale chunks get lower search scores", () => {
    // Two chunks with identical embeddings, different access times
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Recent", "s1", "recent content", "test", "/test.md", "h1", emb, "global", 1);
    store.upsertChunk("Stale", "s2", "stale content", "test", "/test.md", "h2", emb, "global", 1);

    const db = (store as unknown as { db: Database }).db;
    const now = Date.now();
    db.exec(`UPDATE knowledge_chunks SET accessed_at = ${now} WHERE section = 's1'`);
    db.exec(`UPDATE knowledge_chunks SET accessed_at = ${now - 100 * 24 * 60 * 60 * 1000} WHERE section = 's2'`);

    const results = store.search(emb, 10, 0.1);

    // Both should appear, but recent should rank higher
    expect(results.length).toBe(2);
    const recentResult = results.find(r => r.section === "s1");
    const staleResult = results.find(r => r.section === "s2");
    expect(recentResult).toBeDefined();
    expect(staleResult).toBeDefined();
    expect(recentResult!.similarity).toBeGreaterThan(staleResult!.similarity!);
  });

  test("pruneStale with no stale chunks returns 0", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Fresh", null, "content", "test", "/fresh.md", "h1", emb);
    expect(store.pruneStale(90)).toBe(0);
  });

  test("access_count increments on search hit", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Test", null, "test content", "test", "/test.md", "h1", emb);

    // First search
    const results1 = store.search(emb, 5, 0.5);
    expect(results1.length).toBe(1);
    const chunk1 = store.getChunkById(results1[0].id);
    expect(chunk1?.access_count).toBe(1);

    // Second search
    store.search(emb, 5, 0.5);
    const chunk2 = store.getChunkById(results1[0].id);
    expect(chunk2?.access_count).toBe(2);
  });

  test("searchDetailed narrows reranking candidates when lexical matches are available", () => {
    const targetEmbedding = makeEmbedding([1, 0, 0, 0]);
    const otherEmbedding = makeEmbedding([0.8, 0.2, 0, 0]);

    for (let index = 0; index < 20; index++) {
      store.upsertChunk(
        `Target ${index}`,
        "overview",
        `alphakey candidate ${index}`,
        "test",
        `/target-${index}.md`,
        `target-${index}`,
        targetEmbedding,
      );
    }

    for (let index = 0; index < 40; index++) {
      store.upsertChunk(
        `Other ${index}`,
        "overview",
        `betakey filler ${index}`,
        "test",
        `/other-${index}.md`,
        `other-${index}`,
        otherEmbedding,
      );
    }

    const result = store.searchDetailed(targetEmbedding, 5, 0.1, undefined, undefined, "alphakey");

    expect(result.stats.strategy).toBe("fts_prefilter");
    expect(result.stats.scannedCount).toBe(60);
    expect(result.stats.rerankedCount).toBe(20);
    expect(result.results).toHaveLength(5);
    expect(result.results.every((chunk) => chunk.title.startsWith("Target"))).toBe(true);
  });

  test("confidence defaults to 1.0 on new chunks", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Test", null, "content", "test", "/test.md", "h1", emb);

    const results = store.search(emb, 5, 0.5);
    const chunk = store.getChunkById(results[0].id);
    expect(chunk?.confidence).toBe(1.0);
  });

  test("markSuperseded halves confidence", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Test", null, "old fact", "test", "/test.md", "h1", emb);

    const results = store.search(emb, 5, 0.5);
    const id = results[0].id;

    store.markSuperseded(id);
    expect(store.getChunkById(id)?.confidence).toBe(0.5);

    store.markSuperseded(id);
    expect(store.getChunkById(id)?.confidence).toBe(0.25);
  });

  test("low confidence chunks score lower in search", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("High confidence", "s1", "reliable fact", "test", "/test.md", "h1", emb);
    store.upsertChunk("Low confidence", "s2", "unreliable fact", "test", "/test.md", "h2", emb);

    // Lower confidence on second chunk
    const db = (store as unknown as { db: Database }).db;
    db.exec("UPDATE knowledge_chunks SET confidence = 0.2 WHERE section = 's2'");

    const results = store.search(emb, 10, 0.1);
    expect(results.length).toBe(2);
    expect(results[0].section).toBe("s1"); // High confidence first
    expect(results[1].section).toBe("s2");
    expect(results[0].similarity).toBeGreaterThan(results[1].similarity!);
  });

  test("frequently accessed chunks score higher", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Popular", "s1", "popular content", "test", "/test.md", "h1", emb);
    store.upsertChunk("Unpopular", "s2", "unpopular content", "test", "/test.md", "h2", emb);

    // Boost access count on first chunk
    const db = (store as unknown as { db: Database }).db;
    db.exec("UPDATE knowledge_chunks SET access_count = 20 WHERE section = 's1'");
    db.exec("UPDATE knowledge_chunks SET access_count = 0 WHERE section = 's2'");

    const results = store.search(emb, 10, 0.1);
    expect(results.length).toBe(2);
    expect(results[0].section).toBe("s1"); // High access count first
  });

  test("pruneStale aggressively removes low-confidence unaccessed chunks after 60 days", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Low conf", null, "content", "test", "/lc.md", "h1", emb);
    store.upsertChunk("Normal", null, "content", "test", "/normal.md", "h2", emb);

    const db = (store as unknown as { db: Database }).db;
    const oldTs = Date.now() - 65 * 24 * 60 * 60 * 1000; // 65 days
    db.exec(`UPDATE knowledge_chunks SET confidence = 0.1, access_count = 0, accessed_at = ${oldTs} WHERE source_path = '/lc.md'`);

    const pruned = store.pruneStale(90);
    expect(pruned).toBe(1);
    expect(store.getStats().totalChunks).toBe(1);
  });

  test("getChunkById returns null for non-existent id", () => {
    expect(store.getChunkById(999)).toBeNull();
  });

  test("upsert preserves chunks with same section but different chunk_index", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);

    // Simulate two chunks with the same section name (repeated heading) but different chunk_index
    store.upsertChunk("Doc", "Overview", "first overview content", "test", "/doc.md", "h1", emb, "global", 1, undefined, 0);
    store.upsertChunk("Doc", "Overview", "second overview content", "test", "/doc.md", "h2", emb, "global", 1, undefined, 2);

    const stats = store.getStats();
    expect(stats.totalChunks).toBe(2);

    // Both should be searchable
    const results = store.search(emb, 10, 0.1);
    expect(results.length).toBe(2);

    const contents = results.map(r => r.content).sort();
    expect(contents).toEqual(["first overview content", "second overview content"]);
  });

  test("upsert updates existing chunk when source_path + section + chunk_index match", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);

    store.upsertChunk("Doc", "Overview", "original content", "test", "/doc.md", "h1", emb, "global", 1, undefined, 0);
    store.upsertChunk("Doc", "Overview", "updated content", "test", "/doc.md", "h2", emb, "global", 1, undefined, 0);

    const stats = store.getStats();
    expect(stats.totalChunks).toBe(1);

    const results = store.search(emb, 10, 0.1);
    expect(results[0].content).toBe("updated content");
  });

  test("getExistingHashes includes chunk_index in key", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);

    store.upsertChunk("Doc", "Overview", "content1", "test", "/doc.md", "h1", emb, "global", 1, undefined, 0);
    store.upsertChunk("Doc", "Overview", "content2", "test", "/doc.md", "h2", emb, "global", 1, undefined, 1);

    const hashes = store.getExistingHashes();
    expect(hashes.size).toBe(2);
    expect(hashes.has("/doc.md::Overview::0")).toBe(true);
    expect(hashes.has("/doc.md::Overview::1")).toBe(true);
    expect(hashes.get("/doc.md::Overview::0")).toBe("h1");
    expect(hashes.get("/doc.md::Overview::1")).toBe("h2");
  });

  test("getSiblings returns chunks across repeated headings in same document", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);

    store.upsertChunk("Doc", "Overview", "content1", "test", "/doc.md", "h1", emb, "global", 1, undefined, 0);
    store.upsertChunk("Doc", "Details", "content2", "test", "/doc.md", "h2", emb, "global", 1, undefined, 1);
    store.upsertChunk("Doc", "Overview", "content3", "test", "/doc.md", "h3", emb, "global", 1, undefined, 2);

    const results = store.search(emb, 10, 0.1);
    const firstChunk = results.find(r => r.chunk_index === 0);
    expect(firstChunk).toBeDefined();

    const siblings = store.getSiblings(firstChunk!.id);
    expect(siblings.length).toBe(2);
  });
});

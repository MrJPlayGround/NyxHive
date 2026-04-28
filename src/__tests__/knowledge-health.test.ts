import { describe, it, expect, beforeEach } from "bun:test";
import { KnowledgeStore } from "../memory/knowledge.js";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function createTestStore(): KnowledgeStore {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-health-test-"));
  return new KnowledgeStore(dir, "test", 4); // 4 dimensions for test embeddings
}

function makeEmbedding(vals: number[]): Float32Array {
  return new Float32Array(vals);
}

describe("KnowledgeStore getStats", () => {
  let store: KnowledgeStore;

  beforeEach(() => {
    store = createTestStore();
  });

  it("returns zero counts on empty store", () => {
    const stats = store.getStats();
    expect(stats.totalChunks).toBe(0);
    expect(stats.totalFiles).toBe(0);
    expect(stats.categories).toEqual({});
    expect(stats.tiers?.critical).toBe(0);
    expect(stats.tiers?.active).toBe(0);
    expect(stats.tiers?.archive).toBe(0);
    expect(stats.tiers?.stale).toBe(0);
  });

  it("reflects a single inserted chunk", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("My claim", null, "some content", "learnings", "/notes/test.md", "h1", emb);

    const stats = store.getStats();
    expect(stats.totalChunks).toBe(1);
    expect(stats.totalFiles).toBe(1);
    expect(stats.categories["learnings"]).toBe(1);
  });

  it("counts distinct files correctly", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Chunk A", null, "content a", "test", "/file1.md", "h1", emb);
    store.upsertChunk("Chunk B", null, "content b", "test", "/file1.md", "h2", emb);
    store.upsertChunk("Chunk C", null, "content c", "test", "/file2.md", "h1", emb);

    const stats = store.getStats();
    expect(stats.totalChunks).toBe(3);
    expect(stats.totalFiles).toBe(2);
  });

  it("tracks category distribution", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("A1", null, "c1", "arch", "/a1.md", "h1", emb);
    store.upsertChunk("A2", null, "c2", "arch", "/a2.md", "h1", emb);
    store.upsertChunk("L1", null, "c3", "learnings", "/l1.md", "h1", emb);

    const stats = store.getStats();
    expect(stats.categories["arch"]).toBe(2);
    expect(stats.categories["learnings"]).toBe(1);
  });

  it("pages chunk listings in both default and recent order", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("First", null, "first", "test", "/first.md", "h1", emb);
    store.upsertChunk("Second", null, "second", "test", "/second.md", "h2", emb);
    store.upsertChunk("Third", null, "third", "test", "/third.md", "h3", emb);

    expect(store.countChunks()).toBe(3);
    expect(store.getChunkPage(1, 1).map((chunk) => chunk.title)).toEqual(["Second"]);
    expect(store.getRecentChunks(2).map((chunk) => chunk.title)).toEqual(["Third", "Second"]);
  });

  it("reports critical tier for high-priority chunks", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Critical chunk", null, "important", "test", "/crit.md", "h1", emb, "global", 3);
    store.upsertChunk("Normal chunk", null, "normal", "test", "/norm.md", "h1", emb, "global", 1);

    const stats = store.getStats();
    expect(stats.tiers?.critical).toBe(1);
    expect(stats.totalChunks).toBe(2);
  });
});

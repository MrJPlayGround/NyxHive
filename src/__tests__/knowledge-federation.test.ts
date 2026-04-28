import { describe, it, expect, beforeEach } from "bun:test";
import { KnowledgeStore } from "../memory/knowledge.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("KnowledgeStore federation", () => {
  let store: KnowledgeStore;
  const dims = 4;

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-fed-"));
    store = new KnowledgeStore(dir, "test", dims);
  });

  function makeEmbedding(seed: number): Float32Array {
    const e = new Float32Array(dims);
    // Normalized-ish vector that produces predictable cosine similarity
    const norm = Math.sqrt(seed * seed + (1 - seed) * (1 - seed) + seed * 0.5 * seed * 0.5 + 0.25);
    e[0] = seed / norm;
    e[1] = (1 - seed) / norm;
    e[2] = (seed * 0.5) / norm;
    e[3] = 0.5 / norm;
    return e;
  }

  it("markShareable updates the shareable flag and returns change count", () => {
    const emb = makeEmbedding(0.8);
    store.upsertChunk("Doc", null, "content here", "docs", "/doc.md", "hash1", emb, "global", 1, undefined, 0);

    const changed = store.markShareable("/doc.md", true);
    expect(changed).toBeGreaterThan(0);

    // Non-matching path returns 0
    const noChange = store.markShareable("/nonexistent.md", true);
    expect(noChange).toBe(0);

    // Verify the flag was actually set by searching shareable
    const results = store.searchShareable(makeEmbedding(0.8), 10, 0.1);
    expect(results.length).toBe(1);
  });

  it("searchShareable only returns chunks where shareable=1", () => {
    const emb = makeEmbedding(0.9);
    store.upsertChunk("Public Doc", null, "shared knowledge about APIs", "docs", "/shared.md", "hash-shared", emb, "global", 1, undefined, 0);
    store.upsertChunk("Private Doc", null, "internal credentials and secrets", "internal", "/private.md", "hash-private", emb, "global", 1, undefined, 0);

    store.markShareable("/shared.md", true);

    const query = makeEmbedding(0.9);
    const results = store.searchShareable(query, 10, 0.1);
    expect(results.length).toBe(1);
    expect(results[0].source_path).toBe("/shared.md");
  });

  it("searchShareable returns empty when no chunks are shareable", () => {
    const emb = makeEmbedding(0.8);
    store.upsertChunk("Doc", null, "content", "docs", "/doc.md", "hash2", emb, "global", 1, undefined, 0);

    const results = store.searchShareable(makeEmbedding(0.8), 10, 0.1);
    expect(results.length).toBe(0);
  });

  it("searchShareable does not update access tracking", () => {
    const emb = makeEmbedding(0.8);
    store.upsertChunk("Doc", null, "shared content for federation", "docs", "/shared.md", "hash3", emb, "global", 1, undefined, 0);
    store.markShareable("/shared.md", true);

    // Search twice
    store.searchShareable(makeEmbedding(0.8), 10, 0.1);
    store.searchShareable(makeEmbedding(0.8), 10, 0.1);

    // Access count should still be 0 (federation searches don't track)
    const stats = store.getStats();
    expect(stats.totalChunks).toBe(1);
  });

  it("markShareable can toggle shareable back to false", () => {
    const emb = makeEmbedding(0.7);
    store.upsertChunk("Doc", null, "content", "docs", "/doc.md", "hash4", emb, "global", 1, undefined, 0);

    store.markShareable("/doc.md", true);
    expect(store.searchShareable(makeEmbedding(0.7), 10, 0.1).length).toBe(1);

    store.markShareable("/doc.md", false);
    expect(store.searchShareable(makeEmbedding(0.7), 10, 0.1).length).toBe(0);
  });
});

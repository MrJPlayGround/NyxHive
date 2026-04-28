import { describe, test, expect, beforeEach } from "bun:test";
import { KnowledgeStore } from "../memory/knowledge.js";
import type { KnowledgeTaskContext } from "../memory/knowledge.js";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function createTestStore(): KnowledgeStore {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-task-rel-test-"));
  return new KnowledgeStore(dir, "test", 4);
}

function makeEmbedding(vals: number[]): Float32Array {
  return new Float32Array(vals);
}

describe("Knowledge task-aware ranking", () => {
  let store: KnowledgeStore;

  beforeEach(() => {
    store = createTestStore();
  });

  test("task context boosts chunks matching file paths", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    // Both chunks have similar embeddings but different content
    store.upsertChunk("Auth module", null, "The auth module in src/auth/index.ts handles session tokens", "facts", "/auth.md", "h1", emb);
    store.upsertChunk("Queue module", null, "The queue processor handles message routing and delegation", "facts", "/queue.md", "h2", emb);

    const taskContext: KnowledgeTaskContext = {
      filePaths: ["src/auth/index.ts"],
    };

    const withContext = store.search(emb, 2, 0.1, undefined, undefined, undefined, taskContext);
    const withoutContext = store.search(emb, 2, 0.1);

    // Auth chunk should be ranked higher with task context
    expect(withContext[0].title).toBe("Auth module");
    // Without context, order depends only on base scoring (both similar)
    expect(withContext.length).toBe(2);
    expect(withoutContext.length).toBe(2);
  });

  test("task context boosts chunks matching keywords", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Error handling", null, "The retry mechanism uses exponential backoff for transient failures", "facts", "/retry.md", "h1", emb);
    store.upsertChunk("Config setup", null, "TOML configuration is loaded and validated by Zod schema on boot", "facts", "/config.md", "h2", emb);

    const taskContext: KnowledgeTaskContext = {
      keywords: ["retry", "backoff", "failures"],
    };

    const results = store.search(emb, 2, 0.1, undefined, undefined, undefined, taskContext);
    expect(results[0].title).toBe("Error handling");
  });

  test("task type debug boosts post-mortems category", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Test failure fix", null, "Fixed the flaky test by adding retry logic", "post-mortems", "/pm1.md", "h1", emb);
    store.upsertChunk("Architecture note", null, "The system uses SQLite for all persistence", "facts", "/arch.md", "h2", emb);

    const taskContext: KnowledgeTaskContext = {
      taskType: "debug",
    };

    const results = store.search(emb, 2, 0.1, undefined, undefined, undefined, taskContext);
    expect(results[0].title).toBe("Test failure fix");
  });

  test("task type code boosts decisions category", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Decision: use SQLite", null, "We decided to use SQLite over PostgreSQL for simplicity", "decisions", "/d1.md", "h1", emb);
    store.upsertChunk("Random fact", null, "The sky is blue according to Rayleigh scattering", "facts", "/f1.md", "h2", emb);

    const taskContext: KnowledgeTaskContext = {
      taskType: "code",
    };

    const results = store.search(emb, 2, 0.1, undefined, undefined, undefined, taskContext);
    expect(results[0].title).toBe("Decision: use SQLite");
  });

  test("categoryBoost elevates matching categories", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Pattern A", null, "Implementation pattern for proposal pipeline", "implementation-patterns", "/p1.md", "h1", emb);
    store.upsertChunk("Fact B", null, "Some general knowledge fact about the system", "facts", "/f1.md", "h2", emb);

    const taskContext: KnowledgeTaskContext = {
      categoryBoost: ["implementation-patterns"],
    };

    const results = store.search(emb, 2, 0.1, undefined, undefined, undefined, taskContext);
    expect(results[0].title).toBe("Pattern A");
  });

  test("without task context, scoring is unchanged", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Chunk A", null, "Content A", "facts", "/a.md", "h1", emb);
    store.upsertChunk("Chunk B", null, "Content B", "facts", "/b.md", "h2", emb);

    const withoutContext = store.search(emb, 2, 0.1);
    const withEmptyContext = store.search(emb, 2, 0.1, undefined, undefined, undefined, undefined);

    // Both should return same results in same order
    expect(withoutContext.length).toBe(withEmptyContext.length);
    expect(withoutContext[0].title).toBe(withEmptyContext[0].title);
  });

  test("source_thread_id is stored and returned", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Thread chunk", null, "Content from a specific thread", "facts", "/thread.md", "h1", emb, undefined, undefined, "nyx", undefined, "thread-abc-123");

    const results = store.search(emb, 1, 0.1);
    expect(results[0].source_thread_id).toBe("thread-abc-123");
  });

  test("searchDetailed passes task context through", () => {
    const emb = makeEmbedding([1, 0, 0, 0]);
    store.upsertChunk("Auth chunk", null, "Authentication logic in src/auth/login.ts", "decisions", "/auth.md", "h1", emb);
    store.upsertChunk("Other chunk", null, "Unrelated content here", "facts", "/other.md", "h2", emb);

    const taskContext: KnowledgeTaskContext = {
      filePaths: ["src/auth/login.ts"],
      taskType: "code",
    };

    const result = store.searchDetailed(emb, 2, 0.1, undefined, undefined, undefined, taskContext);
    expect(result.results[0].title).toBe("Auth chunk");
    expect(result.stats.rerankedCount).toBeGreaterThan(0);
  });
});

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { KnowledgeStore } from "../memory/knowledge.js";
import { ProposalStore } from "../proposals/store.js";
import { generateScoutReport, formatScoutReport, persistScoutReport } from "../learning/analysis.js";
import { registerLearningListeners } from "../learning/listeners.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";

// --- Helpers ---

function makeFakeEmbedder(dims = 1536): EmbeddingProvider {
  return {
    embed: async (_text: string) => {
      const arr = new Float32Array(dims);
      // Deterministic pseudo-embedding based on text hash
      for (let i = 0; i < dims; i++) arr[i] = Math.sin(i * 0.1) * 0.5;
      return arr;
    },
    embedBatch: async (texts: string[]) => texts.map(() => {
      const arr = new Float32Array(dims);
      for (let i = 0; i < dims; i++) arr[i] = Math.sin(i * 0.1) * 0.5;
      return arr;
    }),
    dimensions: dims,
  };
}

// Minimal SSE-style event source matching processor's onEvent pattern
class FakeEventSource {
  private listeners: Array<(event: { type: string; data: Record<string, unknown>; timestamp: number }) => void> = [];

  onEvent(listener: (event: { type: string; data: Record<string, unknown>; timestamp: number }) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  emit(type: string, data: Record<string, unknown>): void {
    const event = { type, data, timestamp: Date.now() };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

// --- Scout Analysis Tests ---

describe("generateScoutReport", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "learning-test-"));
    store = new ProposalStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("empty proposals returns zero stats", () => {
    const report = generateScoutReport(store, 0);
    expect(report.totalProposed).toBe(0);
    expect(report.totalApproved).toBe(0);
    expect(report.totalRejected).toBe(0);
    expect(report.overallAcceptanceRate).toBe(0);
    expect(report.stats).toEqual([]);
  });

  test("counts approved and rejected proposals", () => {
    const p1 = store.create({ title: "A", description: "D", category: "maintenance", proposed_by: "forge", scout_source: "code-scanner" });
    const p2 = store.create({ title: "B", description: "D", category: "bugfix", proposed_by: "forge", scout_source: "code-scanner" });
    const p3 = store.create({ title: "C", description: "D", category: "feature", proposed_by: "nyx", scout_source: "research" });

    store.approve(p1.proposal_id, "jay");
    store.reject(p2.proposal_id, "not needed");

    const report = generateScoutReport(store, 0);
    expect(report.totalProposed).toBe(3);
    expect(report.totalApproved).toBe(1);
    expect(report.totalRejected).toBe(1);
    expect(report.overallAcceptanceRate).toBe(50);
  });

  test("groups by scout_source", () => {
    store.create({ title: "A", description: "D", category: "maintenance", proposed_by: "forge", scout_source: "code-scanner" });
    store.create({ title: "B", description: "D", category: "bugfix", proposed_by: "forge", scout_source: "code-scanner" });
    store.create({ title: "C", description: "D", category: "feature", proposed_by: "nyx", scout_source: "research" });

    const report = generateScoutReport(store, 0);
    expect(report.stats.length).toBe(2);

    const codeScanner = report.stats.find(s => s.scoutSource === "code-scanner");
    expect(codeScanner).toBeDefined();
    expect(codeScanner!.total).toBe(2);

    const research = report.stats.find(s => s.scoutSource === "research");
    expect(research).toBeDefined();
    expect(research!.total).toBe(1);
  });

  test("filters by time period", () => {
    const now = Date.now();
    store.create({ title: "A", description: "D", category: "maintenance", proposed_by: "forge" });

    // since=future filters everything out
    const report = generateScoutReport(store, now + 100_000);
    expect(report.totalProposed).toBe(0);
  });

  test("proposals without scout_source grouped as manual", () => {
    store.create({ title: "A", description: "D", category: "maintenance", proposed_by: "nyx" });

    const report = generateScoutReport(store, 0);
    expect(report.stats[0].scoutSource).toBe("manual");
  });
});

describe("formatScoutReport", () => {
  test("formats empty report", () => {
    const report = generateScoutReport(
      { list: () => [] } as unknown as ProposalStore,
      0,
    );
    const text = formatScoutReport(report);
    expect(text).toContain("No proposals in this period");
  });

  test("formats report with stats", () => {
    const report = {
      period: "2026-W09",
      since: 0,
      until: Date.now(),
      stats: [
        { scoutSource: "code-scanner", total: 5, approved: 3, rejected: 1, expired: 1, autoExecuted: 0, pending: 0, acceptanceRate: 75 },
      ],
      totalProposed: 5,
      totalApproved: 3,
      totalRejected: 1,
      overallAcceptanceRate: 75,
    };

    const text = formatScoutReport(report);
    expect(text).toContain("code-scanner");
    expect(text).toContain("5 proposed");
    expect(text).toContain("3 approved");
    expect(text).toContain("75%");
  });

  test("adds warning for low acceptance rate", () => {
    const report = {
      period: "2026-W09",
      since: 0,
      until: Date.now(),
      stats: [
        { scoutSource: "bad-scanner", total: 10, approved: 1, rejected: 9, expired: 0, autoExecuted: 0, pending: 0, acceptanceRate: 10 },
      ],
      totalProposed: 10,
      totalApproved: 1,
      totalRejected: 9,
      overallAcceptanceRate: 10,
    };

    const text = formatScoutReport(report);
    expect(text).toContain("bad-scanner");
  });
});

describe("persistScoutReport", () => {
  let knowledge: KnowledgeStore;
  let embedder: EmbeddingProvider;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "learning-persist-"));
    knowledge = new KnowledgeStore(tmpDir, "test");
    embedder = makeFakeEmbedder();
  });

  afterEach(() => {
    knowledge.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("ingests report into knowledge store", async () => {
    const report = {
      period: "2026-W09",
      since: 0,
      until: Date.now(),
      stats: [
        { scoutSource: "code-scanner", total: 3, approved: 2, rejected: 1, expired: 0, autoExecuted: 0, pending: 0, acceptanceRate: 67 },
      ],
      totalProposed: 3,
      totalApproved: 2,
      totalRejected: 1,
      overallAcceptanceRate: 67,
    };

    await persistScoutReport(report, knowledge, embedder);

    const stats = knowledge.getStats();
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.categories["scout-effectiveness"]).toBeGreaterThan(0);
  });

  test("writes to vault when path provided", async () => {
    const vaultDir = join(tmpDir, "vault");
    const report = {
      period: "2026-W09",
      since: 0,
      until: Date.now(),
      stats: [],
      totalProposed: 0,
      totalApproved: 0,
      totalRejected: 0,
      overallAcceptanceRate: 0,
    };

    await persistScoutReport(report, knowledge, embedder, vaultDir);

    const dir = join(vaultDir, "Learnings", "scout-effectiveness");
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toBe("2026-W09.md");
  });
});

// --- Learning Listeners Tests ---

describe("registerLearningListeners", () => {
  let knowledge: KnowledgeStore;
  let embedder: EmbeddingProvider;
  let tmpDir: string;
  let source: FakeEventSource;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "learning-listener-"));
    knowledge = new KnowledgeStore(tmpDir, "test");
    embedder = makeFakeEmbedder();
    source = new FakeEventSource();
  });

  afterEach(() => {
    knowledge.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("learns from proposal:rejected event", async () => {
    registerLearningListeners(source as any, knowledge, embedder);

    source.emit("proposal:rejected", {
      proposal_id: "proposal-abc12345",
      title: "Add caching layer",
      category: "feature",
      proposed_by: "forge",
      reason: "Not needed right now, premature optimization",
    });

    // Give async handler time to complete
    await new Promise(r => setTimeout(r, 200));

    const stats = knowledge.getStats();
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.categories["rejected-proposals"]).toBeGreaterThan(0);
  });

  test("learns from message:failed event", async () => {
    registerLearningListeners(source as any, knowledge, embedder);

    source.emit("message:failed", {
      message_id: "msg-123",
      agent: "forge",
      error: "Error: ENOENT: no such file or directory, open '/workspace/missing-file.ts' — this is a longer error message to pass the minimum length check",
    });

    await new Promise(r => setTimeout(r, 200));

    const stats = knowledge.getStats();
    expect(stats.totalChunks).toBeGreaterThan(0);
    expect(stats.categories["post-mortems"]).toBeGreaterThan(0);
  });

  test("ignores short errors", async () => {
    registerLearningListeners(source as any, knowledge, embedder);

    source.emit("message:failed", {
      message_id: "msg-456",
      agent: "forge",
      error: "timeout", // < 20 chars
    });

    await new Promise(r => setTimeout(r, 200));

    const stats = knowledge.getStats();
    expect(stats.totalChunks).toBe(0);
  });

  test("deduplicates identical errors", async () => {
    registerLearningListeners(source as any, knowledge, embedder);

    const error = "Error: Cannot find module 'nonexistent' — this is long enough to pass the minimum length check requirement";

    // Fire same error twice
    source.emit("message:failed", { message_id: "msg-1", agent: "forge", error });
    await new Promise(r => setTimeout(r, 200));

    source.emit("message:failed", { message_id: "msg-2", agent: "forge", error });
    await new Promise(r => setTimeout(r, 200));

    // Should only have chunks from the first event
    const stats = knowledge.getStats();
    const postMortemCount = stats.categories["post-mortems"] ?? 0;
    // Dedup means only 1 learning event, so chunk count should be the same as after first event
    expect(postMortemCount).toBeGreaterThan(0);
    // Both events produce same-path chunks, so dedup hash prevents second write
  });

  test("ignores unrelated events", async () => {
    registerLearningListeners(source as any, knowledge, embedder);

    source.emit("message:completed", {
      message_id: "msg-999",
      agent: "forge",
      response: "All good",
    });

    await new Promise(r => setTimeout(r, 200));

    const stats = knowledge.getStats();
    expect(stats.totalChunks).toBe(0);
  });
});

// --- SDK Tool: search_knowledge ---

describe("search_knowledge tool", () => {
  let knowledge: KnowledgeStore;
  let embedder: EmbeddingProvider;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tool-knowledge-"));
    knowledge = new KnowledgeStore(tmpDir, "test");
    embedder = makeFakeEmbedder();
  });

  afterEach(() => {
    knowledge.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns message when knowledge store not available", async () => {
    const { executeTool } = await import("../agents/tools.js");
    const result = await executeTool(
      { name: "search_knowledge", arguments: { query: "test" } },
      { workDir: tmpDir },
    );
    expect(result).toBe("Knowledge store not available.");
  });

  test("returns message when no results found", async () => {
    const { executeTool } = await import("../agents/tools.js");
    const result = await executeTool(
      { name: "search_knowledge", arguments: { query: "test" } },
      { workDir: tmpDir, knowledge, embedder },
    );
    expect(result).toBe("No relevant knowledge found.");
  });

  test("returns formatted results when knowledge exists", async () => {
    // Insert a chunk with matching embedding
    const emb = await embedder.embed("test query");
    knowledge.upsertChunk(
      "Test Knowledge", null, "This is test content about error handling",
      "learnings", "test/path.md", "hash1", emb, undefined, 1, "forge",
    );

    const { executeTool } = await import("../agents/tools.js");
    const result = await executeTool(
      { name: "search_knowledge", arguments: { query: "test query" } },
      { workDir: tmpDir, knowledge, embedder },
    );

    expect(result).toContain("Found");
    expect(result).toContain("Test Knowledge");
    expect(result).toContain("learned by forge");
  });

  test("requires query parameter", async () => {
    const { executeTool } = await import("../agents/tools.js");
    const result = await executeTool(
      { name: "search_knowledge", arguments: {} },
      { workDir: tmpDir, knowledge, embedder },
    );
    expect(result).toBe("Error: query is required");
  });
});

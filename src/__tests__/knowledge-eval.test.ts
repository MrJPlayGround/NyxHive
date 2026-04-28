import { describe, test, expect, beforeEach } from "bun:test";
import { KnowledgeStore } from "../memory/knowledge.js";
import type { KnowledgeTaskContext } from "../memory/knowledge.js";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

/**
 * Knowledge retrieval eval harness.
 *
 * Measures recall@k and MRR (Mean Reciprocal Rank) across a labeled query set.
 * Queries are grouped by intent: decision, implementation, operational.
 * Each query defines expected chunk titles that should appear in top-k results.
 *
 * Run with: bun test src/__tests__/knowledge-eval.test.ts
 *
 * The harness uses 4D embeddings for fast deterministic testing.
 * Embedding vectors are designed so that:
 *   - Related content shares direction
 *   - Unrelated content is orthogonal
 *   - Task context can meaningfully shift rankings
 */

const DIM = 4;

function createEvalStore(): KnowledgeStore {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-eval-"));
  return new KnowledgeStore(dir, "eval", DIM);
}

function emb(vals: number[]): Float32Array {
  return new Float32Array(vals);
}

// --- Corpus: a realistic mini knowledge base ---

interface CorpusChunk {
  title: string;
  section: string | null;
  content: string;
  category: string;
  sourcePath: string;
  embedding: Float32Array;
  priority?: number;
  sourceAgent?: string;
}

// Embedding clusters:
// [1,0,0,0] = auth/security domain
// [0,1,0,0] = pipeline/queue domain
// [0,0,1,0] = config/operational domain
// [0,0,0,1] = testing/quality domain
// Mixed = cross-domain

const CORPUS: CorpusChunk[] = [
  // Auth cluster
  {
    title: "Auth session tokens",
    section: "auth-tokens",
    content: "Session tokens are stored in HttpOnly cookies with 24h TTL. The auth module at src/auth/session.ts handles token rotation.",
    category: "facts",
    sourcePath: "/docs/auth.md",
    embedding: emb([0.9, 0.1, 0.0, 0.0]),
  },
  {
    title: "Decision: JWT over opaque tokens",
    section: "auth-decision",
    content: "We decided to use JWT over opaque session tokens because it allows stateless validation. Rationale: reduces DB lookups per request. Agreed in roundtable-3.",
    category: "decisions",
    sourcePath: "/docs/decisions/auth.md",
    embedding: emb([0.85, 0.1, 0.05, 0.0]),
    priority: 3,
    sourceAgent: "vortex",
  },
  {
    title: "Auth rate limiting",
    section: "auth-rate-limit",
    content: "Rate limiting uses sliding window: 10 requests/minute for login, 100/minute for authenticated endpoints. Configured in src/auth/rate-limiter.ts.",
    category: "implementation-patterns",
    sourcePath: "/docs/auth-patterns.md",
    embedding: emb([0.8, 0.0, 0.2, 0.0]),
  },
  // Pipeline cluster
  {
    title: "Message queue architecture",
    section: "queue-arch",
    content: "Messages flow through a SQLite-backed queue with priority levels. The processor in src/queue/processor.ts handles delegation routing.",
    category: "facts",
    sourcePath: "/docs/architecture.md",
    embedding: emb([0.0, 0.9, 0.1, 0.0]),
  },
  {
    title: "Decision: SQLite over PostgreSQL",
    section: "db-decision",
    content: "We chose SQLite over PostgreSQL for the message queue. Rationale: single binary, no network overhead, WAL mode handles concurrent reads. Approved by User.",
    category: "decisions",
    sourcePath: "/docs/decisions/database.md",
    embedding: emb([0.0, 0.85, 0.15, 0.0]),
    priority: 3,
    sourceAgent: "nyx",
  },
  {
    title: "Proposal pipeline lifecycle",
    section: "proposal-lifecycle",
    content: "Proposals follow: proposed -> reviewing -> reviewed -> approved -> executing -> completed -> merged. Auto-creates GitHub PRs on execution completion.",
    category: "implementation-patterns",
    sourcePath: "/docs/proposals.md",
    embedding: emb([0.0, 0.8, 0.0, 0.2]),
  },
  // Config/operational cluster
  {
    title: "TOML config loading",
    section: "config-load",
    content: "Configuration is loaded from .nyxhive/config.toml, validated by Zod schema on boot. Environment variables from .env override TOML values.",
    category: "facts",
    sourcePath: "/docs/config.md",
    embedding: emb([0.0, 0.1, 0.9, 0.0]),
  },
  {
    title: "Production environment setup",
    section: "prod-env",
    content: "Production uses HOTGLUE_ENV=production, OPENROUTER_API_KEY from vault, and port 3779. The build order is: install -> type-check -> test -> start.",
    category: "facts",
    sourcePath: "/docs/operations.md",
    embedding: emb([0.0, 0.0, 0.95, 0.05]),
  },
  {
    title: "Decision: Bun over Node",
    section: "runtime-decision",
    content: "We decided to use Bun over Node.js for the runtime. Rationale: faster startup, built-in SQLite, native TypeScript. Went with Bun after benchmarks.",
    category: "decisions",
    sourcePath: "/docs/decisions/runtime.md",
    embedding: emb([0.0, 0.1, 0.8, 0.1]),
    priority: 3,
    sourceAgent: "nyx",
  },
  // Testing cluster
  {
    title: "Test patterns and conventions",
    section: "test-conventions",
    content: "Tests use bun:test with describe/it/expect. No mocking frameworks — manual stubs and in-memory SQLite. Test files mirror source modules.",
    category: "implementation-patterns",
    sourcePath: "/docs/testing.md",
    embedding: emb([0.0, 0.0, 0.1, 0.9]),
  },
  {
    title: "Post-mortem: flaky delegation test",
    section: "pm-delegation",
    content: "The delegation test was flaky due to timing-dependent message ordering. Root cause: async queue processing without deterministic drain. Fixed by adding explicit flush.",
    category: "post-mortems",
    sourcePath: "/docs/postmortems/delegation-flake.md",
    embedding: emb([0.0, 0.2, 0.0, 0.8]),
    sourceAgent: "morph",
  },
  // Cross-domain
  {
    title: "Entity processing order",
    section: "entity-order",
    content: "The canonical entity processing order is: Users -> Organizations -> Products -> Orders -> Invoices. This must be followed for foreign key integrity.",
    category: "facts",
    sourcePath: "/docs/entities.md",
    embedding: emb([0.3, 0.3, 0.3, 0.1]),
  },
  {
    title: "Build order for new integrations",
    section: "integration-build",
    content: "The strict build order for a new integration is: 1) Define schema, 2) Write mapper, 3) Add API client, 4) Wire processor, 5) Add tests, 6) Update config.",
    category: "facts",
    sourcePath: "/docs/integrations.md",
    embedding: emb([0.4, 0.4, 0.6, 0.4]),
  },
];

// --- Labeled query set ---

interface EvalQuery {
  /** Human-readable description */
  name: string;
  /** Intent category for breakdown */
  intent: "decision" | "implementation" | "operational";
  /** Query embedding (simulates what the embedding model would produce) */
  embedding: Float32Array;
  /** Task context for relevance boosting */
  taskContext?: KnowledgeTaskContext;
  /** Chunk titles that MUST appear in top-k (the expected hits) */
  expectedHits: string[];
  /** k value for recall@k */
  k: number;
}

const EVAL_QUERIES: EvalQuery[] = [
  // Decision lookups
  {
    name: "Why did we choose JWT?",
    intent: "decision",
    embedding: emb([0.85, 0.1, 0.0, 0.05]),
    taskContext: { taskType: "code", keywords: ["jwt", "token", "session"] },
    expectedHits: ["Decision: JWT over opaque tokens"],
    k: 3,
  },
  {
    name: "Why SQLite over PostgreSQL?",
    intent: "decision",
    embedding: emb([0.0, 0.85, 0.1, 0.05]),
    taskContext: { taskType: "code", keywords: ["sqlite", "postgres", "database"] },
    expectedHits: ["Decision: SQLite over PostgreSQL"],
    k: 3,
  },
  {
    name: "What runtime did we choose and why?",
    intent: "decision",
    embedding: emb([0.0, 0.1, 0.8, 0.1]),
    taskContext: { taskType: "code", keywords: ["bun", "node", "runtime"] },
    expectedHits: ["Decision: Bun over Node"],
    k: 3,
  },
  // Implementation lookups
  {
    name: "How does auth work? (while editing auth code)",
    intent: "implementation",
    embedding: emb([0.9, 0.05, 0.05, 0.0]),
    taskContext: { filePaths: ["src/auth/session.ts"], taskType: "code" },
    expectedHits: ["Auth session tokens"],
    k: 3,
  },
  {
    name: "How does the proposal pipeline work?",
    intent: "implementation",
    embedding: emb([0.0, 0.85, 0.05, 0.1]),
    taskContext: { keywords: ["proposal", "lifecycle", "pipeline"] },
    expectedHits: ["Proposal pipeline lifecycle"],
    k: 3,
  },
  {
    name: "What test patterns do we use?",
    intent: "implementation",
    embedding: emb([0.0, 0.0, 0.05, 0.95]),
    taskContext: { taskType: "review", categoryBoost: ["implementation-patterns"] },
    expectedHits: ["Test patterns and conventions"],
    k: 3,
  },
  {
    name: "What caused the flaky delegation test? (debugging)",
    intent: "implementation",
    embedding: emb([0.0, 0.2, 0.0, 0.8]),
    taskContext: { taskType: "debug", keywords: ["flaky", "delegation", "test"] },
    expectedHits: ["Post-mortem: flaky delegation test"],
    k: 3,
  },
  // Operational fact lookups
  {
    name: "What HOTGLUE_ENV should production use?",
    intent: "operational",
    embedding: emb([0.0, 0.0, 0.9, 0.1]),
    taskContext: { keywords: ["hotglue", "production", "env"] },
    expectedHits: ["Production environment setup"],
    k: 3,
  },
  {
    name: "What is the canonical entity processing order?",
    intent: "operational",
    embedding: emb([0.3, 0.3, 0.3, 0.1]),
    taskContext: { keywords: ["entity", "processing", "order"] },
    expectedHits: ["Entity processing order"],
    k: 3,
  },
  {
    name: "What is the build order for new integrations?",
    intent: "operational",
    embedding: emb([0.4, 0.4, 0.6, 0.4]),
    taskContext: { keywords: ["build", "order", "integration"] },
    expectedHits: ["Build order for new integrations"],
    k: 3,
  },
  {
    name: "How is config loaded?",
    intent: "operational",
    embedding: emb([0.0, 0.1, 0.85, 0.05]),
    taskContext: { keywords: ["config", "toml", "loading"] },
    expectedHits: ["TOML config loading"],
    k: 3,
  },
  // Cross-domain with task context
  {
    name: "Auth rate limiting (while reviewing auth code)",
    intent: "implementation",
    embedding: emb([0.8, 0.0, 0.15, 0.05]),
    taskContext: { filePaths: ["src/auth/rate-limiter.ts"], taskType: "review", categoryBoost: ["implementation-patterns"] },
    expectedHits: ["Auth rate limiting"],
    k: 3,
  },
  // Without task context — tests base retrieval
  {
    name: "Message queue architecture (no context)",
    intent: "implementation",
    embedding: emb([0.0, 0.9, 0.1, 0.0]),
    expectedHits: ["Message queue architecture"],
    k: 3,
  },
];

// --- Metrics ---

interface EvalResult {
  query: string;
  intent: string;
  expectedHits: string[];
  actualTop: string[];
  recall: number;
  reciprocalRank: number;
  hit: boolean;
}

interface EvalSummary {
  totalQueries: number;
  overallRecall: number;
  overallMRR: number;
  hitRate: number;
  byIntent: Record<string, { recall: number; mrr: number; hitRate: number; count: number }>;
  results: EvalResult[];
}

function runEval(store: KnowledgeStore, queries: EvalQuery[]): EvalSummary {
  const results: EvalResult[] = [];

  for (const q of queries) {
    const searchResults = store.search(
      q.embedding,
      q.k,
      0.01, // very low threshold — we want to measure ranking, not filtering
      undefined,
      undefined,
      undefined,
      q.taskContext,
    );

    const actualTop = searchResults.map((r) => r.title);

    // Recall@k: fraction of expected hits found in top-k
    const found = q.expectedHits.filter((title) => actualTop.includes(title));
    const recall = q.expectedHits.length > 0 ? found.length / q.expectedHits.length : 1;

    // Reciprocal rank: 1/position of first expected hit
    let reciprocalRank = 0;
    for (const expected of q.expectedHits) {
      const pos = actualTop.indexOf(expected);
      if (pos >= 0) {
        const rr = 1 / (pos + 1);
        if (rr > reciprocalRank) reciprocalRank = rr;
      }
    }

    // Hit@k: did at least one expected hit appear?
    const hit = found.length > 0;

    results.push({
      query: q.name,
      intent: q.intent,
      expectedHits: q.expectedHits,
      actualTop,
      recall,
      reciprocalRank,
      hit,
    });
  }

  // Aggregate
  const totalQueries = results.length;
  const overallRecall = results.reduce((sum, r) => sum + r.recall, 0) / totalQueries;
  const overallMRR = results.reduce((sum, r) => sum + r.reciprocalRank, 0) / totalQueries;
  const hitRate = results.filter((r) => r.hit).length / totalQueries;

  // By intent
  const byIntent: EvalSummary["byIntent"] = {};
  for (const r of results) {
    if (!byIntent[r.intent]) byIntent[r.intent] = { recall: 0, mrr: 0, hitRate: 0, count: 0 };
    byIntent[r.intent].recall += r.recall;
    byIntent[r.intent].mrr += r.reciprocalRank;
    byIntent[r.intent].hitRate += r.hit ? 1 : 0;
    byIntent[r.intent].count++;
  }
  for (const intent of Object.keys(byIntent)) {
    const g = byIntent[intent];
    g.recall /= g.count;
    g.mrr /= g.count;
    g.hitRate /= g.count;
  }

  return { totalQueries, overallRecall, overallMRR, hitRate, byIntent, results };
}

// --- Tests ---

describe("Knowledge retrieval eval harness", () => {
  let store: KnowledgeStore;

  beforeEach(() => {
    store = createEvalStore();
    // Seed corpus
    for (const chunk of CORPUS) {
      store.upsertChunk(
        chunk.title,
        chunk.section,
        chunk.content,
        chunk.category,
        chunk.sourcePath,
        `hash-${chunk.section}`,
        chunk.embedding,
        undefined,
        chunk.priority,
        chunk.sourceAgent,
      );
    }
  });

  test("overall recall@k >= 0.90", () => {
    const summary = runEval(store, EVAL_QUERIES);
    console.log(`\n=== EVAL RESULTS ===`);
    console.log(`Queries: ${summary.totalQueries}`);
    console.log(`Overall Recall@k: ${(summary.overallRecall * 100).toFixed(1)}%`);
    console.log(`Overall MRR: ${(summary.overallMRR * 100).toFixed(1)}%`);
    console.log(`Hit Rate: ${(summary.hitRate * 100).toFixed(1)}%`);
    console.log(`\nBy Intent:`);
    for (const [intent, metrics] of Object.entries(summary.byIntent)) {
      console.log(`  ${intent}: recall=${(metrics.recall * 100).toFixed(1)}% mrr=${(metrics.mrr * 100).toFixed(1)}% hit=${(metrics.hitRate * 100).toFixed(1)}% (n=${metrics.count})`);
    }
    // Log misses
    const misses = summary.results.filter((r) => !r.hit);
    if (misses.length > 0) {
      console.log(`\nMisses:`);
      for (const m of misses) {
        console.log(`  "${m.query}" — expected: [${m.expectedHits.join(", ")}], got: [${m.actualTop.join(", ")}]`);
      }
    }
    // Log non-#1 hits
    const notFirst = summary.results.filter((r) => r.hit && r.reciprocalRank < 1);
    if (notFirst.length > 0) {
      console.log(`\nHits but not #1:`);
      for (const r of notFirst) {
        const pos = r.actualTop.indexOf(r.expectedHits[0]) + 1;
        console.log(`  "${r.query}" — expected at #1, found at #${pos}`);
      }
    }

    expect(summary.overallRecall).toBeGreaterThanOrEqual(0.90);
  });

  test("hit rate >= 0.90", () => {
    const summary = runEval(store, EVAL_QUERIES);
    expect(summary.hitRate).toBeGreaterThanOrEqual(0.90);
  });

  test("MRR >= 0.85 (most expected hits at #1)", () => {
    const summary = runEval(store, EVAL_QUERIES);
    expect(summary.overallMRR).toBeGreaterThanOrEqual(0.85);
  });

  test("decision intent recall >= 0.90", () => {
    const summary = runEval(store, EVAL_QUERIES);
    expect(summary.byIntent["decision"]?.recall ?? 0).toBeGreaterThanOrEqual(0.90);
  });

  test("implementation intent recall >= 0.90", () => {
    const summary = runEval(store, EVAL_QUERIES);
    expect(summary.byIntent["implementation"]?.recall ?? 0).toBeGreaterThanOrEqual(0.90);
  });

  test("operational intent recall >= 0.90", () => {
    const summary = runEval(store, EVAL_QUERIES);
    expect(summary.byIntent["operational"]?.recall ?? 0).toBeGreaterThanOrEqual(0.90);
  });

  test("task context improves ranking vs no context", () => {
    // Use searchDetailed to avoid access tracking side-effects between calls
    const queryEmb = emb([0.9, 0.05, 0.05, 0.0]);

    // Run without context FIRST to avoid access_count boost contaminating comparison
    const withoutContext = store.searchDetailed(queryEmb, 3, 0.01);
    const noContextScore = withoutContext.results.find((r) => r.title === "Auth session tokens")?.similarity ?? 0;

    // Fresh store for context search to avoid access tracking interference
    const store2 = createEvalStore();
    for (const chunk of CORPUS) {
      store2.upsertChunk(chunk.title, chunk.section, chunk.content, chunk.category,
        chunk.sourcePath, `hash-${chunk.section}`, chunk.embedding, undefined, chunk.priority, chunk.sourceAgent);
    }
    const withContext = store2.searchDetailed(queryEmb, 3, 0.01, undefined, undefined, undefined, {
      filePaths: ["src/auth/session.ts"],
      taskType: "code",
      keywords: ["session", "token"],
    });
    const contextScore = withContext.results.find((r) => r.title === "Auth session tokens")?.similarity ?? 0;

    expect(contextScore).toBeGreaterThan(noContextScore);
  });

  test("decision priority boost surfaces decisions for code tasks", () => {
    const queryEmb = emb([0.85, 0.1, 0.05, 0.0]);
    const results = store.search(queryEmb, 3, 0.01, undefined, undefined, undefined, {
      taskType: "code",
      keywords: ["jwt", "token"],
    });

    // Decision chunk should appear in top 2 (it has priority 3 + category boost)
    const decisionIdx = results.findIndex((r) => r.title === "Decision: JWT over opaque tokens");
    expect(decisionIdx).toBeLessThan(2);
    expect(decisionIdx).toBeGreaterThanOrEqual(0);
  });

  test("debug task type boosts post-mortems", () => {
    const queryEmb = emb([0.0, 0.15, 0.0, 0.85]);
    const results = store.search(queryEmb, 3, 0.01, undefined, undefined, undefined, {
      taskType: "debug",
      keywords: ["flaky", "test"],
    });

    expect(results[0].title).toBe("Post-mortem: flaky delegation test");
  });

  test("eval results are reproducible across independent stores", () => {
    // Use separate stores to avoid access tracking drift
    const store1 = createEvalStore();
    const store2 = createEvalStore();
    for (const chunk of CORPUS) {
      store1.upsertChunk(chunk.title, chunk.section, chunk.content, chunk.category,
        chunk.sourcePath, `hash-${chunk.section}`, chunk.embedding, undefined, chunk.priority, chunk.sourceAgent);
      store2.upsertChunk(chunk.title, chunk.section, chunk.content, chunk.category,
        chunk.sourcePath, `hash-${chunk.section}`, chunk.embedding, undefined, chunk.priority, chunk.sourceAgent);
    }

    const run1 = runEval(store1, EVAL_QUERIES);
    const run2 = runEval(store2, EVAL_QUERIES);

    expect(run1.overallRecall).toBe(run2.overallRecall);
    expect(run1.overallMRR).toBe(run2.overallMRR);
    expect(run1.hitRate).toBe(run2.hitRate);
  });

  test("decision_status is stored and returned", () => {
    // Use a unique store to avoid corpus interference
    const statusStore = createEvalStore();
    const decisionEmb = emb([0.9, 0.1, 0.0, 0.0]);
    statusStore.upsertChunk(
      "Status test", "s1", "We decided to use X", "decisions",
      "/test-status.md", "hash-status", decisionEmb,
      undefined, 3, "nyx", undefined, undefined, "accepted",
    );

    const results = statusStore.search(decisionEmb, 5, 0.01);
    const match = results.find((r) => r.title === "Status test");
    expect(match).toBeDefined();
    expect(match!.decision_status).toBe("accepted");
  });

  test("supersedeDecision reduces confidence and sets status", () => {
    const decisionEmb = emb([0.7, 0.7, 0.0, 0.0]);
    store.upsertChunk(
      "Old decision", "old", "We decided to use approach A", "decisions",
      "/old-decision.md", "hash-old", decisionEmb,
      undefined, 3, "nyx", undefined, undefined, "accepted",
    );
    store.upsertChunk(
      "New decision", "new", "We decided to switch to approach B, superseding A", "decisions",
      "/new-decision.md", "hash-new", decisionEmb,
      undefined, 3, "nyx", undefined, undefined, "accepted",
    );

    // Get old decision ID
    const beforeResults = store.search(decisionEmb, 5, 0.01);
    const oldChunk = beforeResults.find((r) => r.title === "Old decision");
    expect(oldChunk).toBeDefined();

    // Supersede it
    store.supersedeDecision(oldChunk!.id);

    // New decision should now outrank old
    const afterResults = store.search(decisionEmb, 5, 0.01);
    const newIdx = afterResults.findIndex((r) => r.title === "New decision");
    const oldIdx = afterResults.findIndex((r) => r.title === "Old decision");
    expect(newIdx).toBeLessThan(oldIdx);

    // Old should have superseded status
    const oldAfter = afterResults.find((r) => r.title === "Old decision");
    expect(oldAfter!.decision_status).toBe("superseded");
  });
});

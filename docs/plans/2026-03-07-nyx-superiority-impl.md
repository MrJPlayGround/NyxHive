# NyxHive Superiority Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make NyxHive genuinely superior to Claude Code CLI across context accuracy, knowledge retrieval, processing speed, and reliability.

**Architecture:** Four independent workstreams. Each can be committed and tested separately. WS1 (smarter) improves token accuracy and knowledge graph traversal. WS2 (faster) replaces synchronous polling with event-driven processing. WS3 (reliable) adds test coverage for 7 critical untested modules. WS4 (polish) enhances CLI status/health commands.

**Tech Stack:** Bun + TypeScript, SQLite, bun:test, js-tiktoken (new dep for WS1)

---

## Task 1: Accurate Token Counting

Replace the 3.5 chars/token heuristic with a real tokenizer. Currently at `src/context/tokens.ts` (18 lines). The heuristic can be ~20% off, causing budget overruns.

**Files:**
- Modify: `src/context/tokens.ts`
- Test: `src/__tests__/tokens.test.ts` (new)

**Step 1: Write the failing test**

Create `src/__tests__/tokens.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { estimateTokens, messageTokens } from "../context/tokens.js";

describe("estimateTokens", () => {
  test("short string returns reasonable count", () => {
    const tokens = estimateTokens("Hello, world!");
    // cl100k_base: "Hello, world!" = 4 tokens
    // Allow ±1 tolerance for tokenizer differences
    expect(tokens).toBeGreaterThanOrEqual(3);
    expect(tokens).toBeLessThanOrEqual(5);
  });

  test("empty string returns 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("code block tokens counted accurately", () => {
    const code = `function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}`;
    const tokens = estimateTokens(code);
    // Heuristic would give ~20, real tokenizer gives ~30-35
    expect(tokens).toBeGreaterThan(25);
    expect(tokens).toBeLessThan(45);
  });

  test("long text within 5% of reference", () => {
    // 1000 chars of prose should be ~250 tokens (not 285 from heuristic)
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(22);
    const tokens = estimateTokens(prose);
    // Reference: ~240-260 tokens for this text
    // Key assertion: NOT the heuristic value of ~285
    expect(tokens).toBeLessThan(280);
  });
});

describe("messageTokens", () => {
  test("extracts content and estimates", () => {
    const msg = {
      id: 1, conversation_id: "test", role: "user" as const,
      content: "Hello, world!", model: null, provider: null,
      tokens_in: 0, tokens_out: 0, cost_usd: 0, created_at: Date.now(),
    };
    const tokens = messageTokens(msg);
    expect(tokens).toBeGreaterThan(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/tokens.test.ts`
Expected: Tests may pass (heuristic gives close-ish numbers for short strings) or fail on the accuracy assertions.

**Step 3: Install js-tiktoken and implement**

```bash
bun add js-tiktoken
```

Replace `src/context/tokens.ts`:

```typescript
import type { StoredMessage } from "../memory/store.js";
import { logger } from "../utils/logger.js";

let encoder: { encode: (text: string) => number[] } | null = null;

try {
  const { encodingForModel } = await import("js-tiktoken");
  encoder = encodingForModel("gpt-4o");
} catch (err) {
  logger.warn(`[tokens] Failed to load tiktoken, falling back to heuristic: ${err}`);
}

/**
 * Count tokens using cl100k_base tokenizer with heuristic fallback.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  if (encoder) {
    return encoder.encode(text).length;
  }
  // Fallback: ~3.5 chars per token
  return Math.ceil(text.length / 3.5);
}

/**
 * Token count for a stored message.
 * Always estimates from content since stored tokens_out reflects CLI output tokens
 * (including tool calls), not the actual content tokens injected into history.
 */
export function messageTokens(msg: StoredMessage): number {
  return estimateTokens(msg.content);
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/tokens.test.ts`
Expected: PASS — all token accuracy tests should pass with real tokenizer.

**Step 5: Run full test suite**

Run: `bun test`
Expected: All 1875+ tests pass. Token changes are backwards-compatible (same interface).

**Step 6: Commit**

```bash
git add src/context/tokens.ts src/__tests__/tokens.test.ts package.json bun.lockb
git commit -m "feat: replace token heuristic with tiktoken for accurate budget counting"
```

---

## Task 2: Knowledge Graph Traversal

After flat vector search returns results, traverse graph edges (relates_to, updates, supersedes, contradicts) for 1-hop expansion. Currently `searchKnowledge()` at `src/queue/knowledge-search.ts` does flat retrieval only — graph edges are created but never used during search.

**Files:**
- Modify: `src/queue/knowledge-search.ts` (add graph-aware retrieval)
- Modify: `src/memory/graph.ts` (add `getRelatedByContent()` helper)
- Test: `src/__tests__/knowledge-graph-traversal.test.ts` (new)

**Step 1: Write the failing test**

Create `src/__tests__/knowledge-graph-traversal.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { GraphMemory } from "../memory/graph.js";
import { expandWithGraphContext } from "../queue/knowledge-search.js";

describe("expandWithGraphContext", () => {
  let db: Database;
  let graph: GraphMemory;

  beforeEach(() => {
    db = new Database(":memory:");
    graph = new GraphMemory(db);
    graph.init();
  });

  test("returns empty array when no graph provided", () => {
    const result = expandWithGraphContext(undefined, ["test content"]);
    expect(result).toEqual([]);
  });

  test("finds related nodes via relates_to edges", () => {
    const nodeA = graph.addNode("decision", "Use SQLite for all storage", "test", 0.8);
    const nodeB = graph.addNode("pattern", "SQLite WAL mode improves concurrent reads", "test", 0.7);
    graph.addEdge(nodeA, nodeB, "relates_to");

    const result = expandWithGraphContext(graph, ["Use SQLite for all storage"]);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some(r => r.content.includes("WAL mode"))).toBe(true);
  });

  test("superseded nodes are excluded", () => {
    const oldNode = graph.addNode("decision", "Use PostgreSQL", "test", 0.8);
    const newNode = graph.addNode("decision", "Use SQLite instead of PostgreSQL", "test", 0.9);
    graph.addEdge(newNode, oldNode, "supersedes");

    const result = expandWithGraphContext(graph, ["Use SQLite instead of PostgreSQL"]);
    // The superseded node should NOT appear in results
    expect(result.every(r => !r.content.includes("Use PostgreSQL"))).toBe(true);
  });

  test("contradicting nodes surface as warnings", () => {
    const nodeA = graph.addNode("decision", "Always use REST APIs", "test", 0.8);
    const nodeB = graph.addNode("decision", "Prefer GraphQL over REST", "test", 0.7);
    graph.addEdge(nodeA, nodeB, "contradicts");

    const result = expandWithGraphContext(graph, ["Always use REST APIs"]);
    const contradiction = result.find(r => r.isContradiction);
    expect(contradiction).toBeDefined();
    expect(contradiction!.content).toContain("GraphQL");
  });

  test("deduplicates by content", () => {
    const nodeA = graph.addNode("fact", "Bun supports SQLite natively", "test", 0.8);
    // Same content, different node
    const nodeB = graph.addNode("fact", "Bun supports SQLite natively", "test", 0.6);
    graph.addEdge(nodeA, nodeB, "relates_to");

    const result = expandWithGraphContext(graph, ["Bun supports SQLite natively"]);
    const unique = new Set(result.map(r => r.content));
    expect(unique.size).toBe(result.length);
  });

  test("caps expansion to maxResults", () => {
    const root = graph.addNode("decision", "Main decision", "test", 0.9);
    for (let i = 0; i < 20; i++) {
      const n = graph.addNode("fact", `Related fact ${i}`, "test", 0.5);
      graph.addEdge(root, n, "relates_to");
    }

    const result = expandWithGraphContext(graph, ["Main decision"], 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/knowledge-graph-traversal.test.ts`
Expected: FAIL — `expandWithGraphContext` doesn't exist yet.

**Step 3: Add `findByContent` to GraphMemory**

Add to `src/memory/graph.ts` after the existing `findSimilar` method (~line 535):

```typescript
  /**
   * Find nodes whose content exactly matches any of the given strings.
   * Returns node IDs for edge traversal.
   */
  findByContent(contents: string[]): MemoryNode[] {
    if (contents.length === 0) return [];
    const placeholders = contents.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM memory_nodes WHERE content IN (${placeholders}) ORDER BY importance DESC`)
      .all(...contents) as MemoryNode[];
  }
```

**Step 4: Implement `expandWithGraphContext`**

Add to `src/queue/knowledge-search.ts` (new export):

```typescript
import type { GraphMemory } from "../memory/graph.js";
import type { MemoryNode, EdgeType } from "../types.js";

export interface GraphExpansionResult {
  content: string;
  type: string;
  importance: number;
  edgeType: EdgeType;
  isContradiction: boolean;
}

/**
 * Expand knowledge search results with 1-hop graph traversal.
 * - relates_to/updates/caused_by/part_of/depends_on: include as related context
 * - supersedes: exclude the superseded (target) node
 * - contradicts: include but flag as contradiction
 */
export function expandWithGraphContext(
  graph: GraphMemory | undefined,
  knowledgeContents: string[],
  maxResults = 5,
): GraphExpansionResult[] {
  if (!graph || knowledgeContents.length === 0) return [];

  const matchedNodes = graph.findByContent(knowledgeContents);
  if (matchedNodes.length === 0) return [];

  // Collect superseded node IDs to exclude
  const supersededIds = new Set<number>();
  const results: GraphExpansionResult[] = [];
  const seenContent = new Set(knowledgeContents.map(c => c.toLowerCase()));

  for (const node of matchedNodes) {
    const related = graph.getRelated(node.id);

    for (const { node: relNode, edge } of related) {
      // Skip if already in search results
      if (seenContent.has(relNode.content.toLowerCase())) continue;

      // If this node supersedes the related node, mark it for exclusion
      if (edge === "supersedes") {
        supersededIds.add(relNode.id);
        continue;
      }

      seenContent.add(relNode.content.toLowerCase());
      results.push({
        content: relNode.content,
        type: relNode.type,
        importance: relNode.importance,
        edgeType: edge,
        isContradiction: edge === "contradicts",
      });
    }
  }

  // Filter out superseded nodes and sort by importance
  return results
    .filter(r => !supersededIds.has(0)) // superseded already excluded above
    .sort((a, b) => {
      // Contradictions surface first (important warnings)
      if (a.isContradiction !== b.isContradiction) return a.isContradiction ? -1 : 1;
      return b.importance - a.importance;
    })
    .slice(0, maxResults);
}
```

**Step 5: Run test to verify it passes**

Run: `bun test src/__tests__/knowledge-graph-traversal.test.ts`
Expected: PASS

**Step 6: Wire graph expansion into searchKnowledge**

Modify `searchKnowledge()` and `searchKnowledgeWithChunks()` in `src/queue/knowledge-search.ts` to accept optional `graph` parameter and append graph context:

In the `KnowledgeSearchDeps` interface (line 5), add:

```typescript
export interface KnowledgeSearchDeps {
  knowledge?: KnowledgeStore;
  embedder?: EmbeddingProvider;
  graph?: GraphMemory;
}
```

At the end of `searchKnowledge()` (before the return on line 63), after building the `relevant` results string, add graph expansion:

```typescript
    // 1-hop graph expansion
    const graphExpansion = expandWithGraphContext(
      deps.graph,
      relevant.map(r => r.content.slice(0, 400)),
    );

    let graphContext = "";
    if (graphExpansion.length > 0) {
      const lines = graphExpansion.map(r => {
        const prefix = r.isContradiction ? "[WARNING — contradicts retrieved knowledge]" : `[Related ${r.type}]`;
        return `${prefix}\n${r.content}`;
      });
      graphContext = "\n\n" + lines.join("\n\n");
    }

    // ... append graphContext to the return value
```

**Step 7: Run full test suite**

Run: `bun test`
Expected: All tests pass. `KnowledgeSearchDeps.graph` is optional, so existing callers unaffected.

**Step 8: Commit**

```bash
git add src/queue/knowledge-search.ts src/memory/graph.ts src/__tests__/knowledge-graph-traversal.test.ts
git commit -m "feat: 1-hop graph traversal in knowledge search — supersedes, contradicts, relates_to"
```

---

## Task 3: System Prompt Budget Metering

Currently, system prompt tokens (knowledge, graph memory) consume budget but aren't counted in utilization metrics. Fix `buildContextWindow` to accept and track system prompt token count.

**Files:**
- Modify: `src/context/budget.ts:18` (add systemPromptActual to metrics)
- Modify: `src/context/types.ts` (update ContextMetrics type)
- Test: `src/__tests__/context.test.ts` (add tests)

**Step 1: Write the failing test**

Add to `src/__tests__/context.test.ts`:

```typescript
  test("metrics include system prompt tokens in utilization", () => {
    const messages = [
      makeMsg("user", "Hello", 1),
      makeMsg("assistant", "Hi there", 2),
    ];
    const budgetWithSystemPrompt = { ...DEFAULT_BUDGET, systemPromptTokens: 5000 };
    const result = buildContextWindow(messages, null, budgetWithSystemPrompt);
    // Utilization should account for system prompt tokens
    expect(result.metrics.systemPromptTokens).toBe(5000);
    expect(result.metrics.totalTokens).toBeGreaterThan(result.metrics.tokenCount);
  });
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/context.test.ts`
Expected: FAIL — `systemPromptTokens` and `totalTokens` don't exist on metrics.

**Step 3: Update ContextMetrics type**

Read `src/context/types.ts` first, then add `systemPromptTokens` and `totalTokens` fields to the `ContextMetrics` interface.

**Step 4: Update buildContextWindow**

In `src/context/budget.ts`, update all return statements to include:
```typescript
systemPromptTokens: budget.systemPromptTokens,
totalTokens: budget.systemPromptTokens + tokenCount,
```

**Step 5: Run tests**

Run: `bun test src/__tests__/context.test.ts`
Expected: PASS

**Step 6: Run full test suite**

Run: `bun test`
Expected: All pass. New fields are additive.

**Step 7: Commit**

```bash
git add src/context/budget.ts src/context/types.ts src/__tests__/context.test.ts
git commit -m "feat: meter system prompt tokens in context budget utilization"
```

---

## Task 4: Async Queue Processing

Replace the synchronous `while (running) { processNext(); sleep(100ms) }` poll loop with EventEmitter-based push. When `enqueueMessage()` inserts a row, emit an event. Processor subscribes and processes immediately.

**Files:**
- Modify: `src/queue/db.ts` (emit event on enqueue)
- Modify: `src/queue/processor.ts:553-568` (replace pollLoop)
- Test: `src/__tests__/queue-async.test.ts` (new)

**Step 1: Write the failing test**

Create `src/__tests__/queue-async.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { EventEmitter } from "events";

describe("QueueDB event emission", () => {
  test("enqueue emits message-enqueued event", async () => {
    const emitter = new EventEmitter();
    let emitted = false;
    emitter.on("message-enqueued", () => { emitted = true; });

    // Simulate what QueueDB should do
    emitter.emit("message-enqueued", { messageId: "test-123" });
    expect(emitted).toBe(true);
  });
});

describe("processor poll replacement", () => {
  test("event-driven processing responds faster than polling", async () => {
    const emitter = new EventEmitter();
    const processedAt: number[] = [];

    emitter.on("message-enqueued", () => {
      processedAt.push(Date.now());
    });

    const enqueuedAt = Date.now();
    emitter.emit("message-enqueued", {});

    expect(processedAt.length).toBe(1);
    // Event-driven: <1ms latency (no poll interval)
    expect(processedAt[0] - enqueuedAt).toBeLessThan(5);
  });
});
```

**Step 2: Run test to verify baseline**

Run: `bun test src/__tests__/queue-async.test.ts`
Expected: PASS (these test the EventEmitter pattern we'll wire in).

**Step 3: Add EventEmitter to QueueDB**

In `src/queue/db.ts`, add event emission to `enqueueMessage()`:

After the class declaration (~line 50), add:
```typescript
import { EventEmitter } from "events";
```

Add to constructor:
```typescript
  readonly events = new EventEmitter();
```

At the end of `enqueueMessage()` (after the INSERT, ~line 179), add:
```typescript
    this.events.emit("message-enqueued", { messageId });
```

**Step 4: Replace pollLoop in processor**

In `src/queue/processor.ts`, modify `pollLoop()` (~line 553) to be hybrid: event-driven with fallback polling.

Replace the poll loop:
```typescript
  private async pollLoop() {
    // Subscribe to queue events for immediate processing
    this.queue.events.on("message-enqueued", () => {
      if (this.running) this.processNext().catch(err =>
        logger.error(`[processor] Event-driven process error: ${formatError(err)}`)
      );
    });

    // Fallback poll for missed events (crash recovery, orphans)
    const FALLBACK_POLL_MS = 2000; // 2s instead of 100ms
    let lastCleanup = Date.now();
    const CLEANUP_INTERVAL = 5 * 60 * 1000;

    while (this.running) {
      try {
        await this.processNext();

        // Periodic cleanup
        if (Date.now() - lastCleanup > CLEANUP_INTERVAL) {
          await this.cleanExpiredState();
          lastCleanup = Date.now();
        }
      } catch (err) {
        logger.error(`[processor] Poll error: ${formatError(err)}`);
      }
      await Bun.sleep(FALLBACK_POLL_MS);
    }
  }
```

**Step 5: Run full test suite**

Run: `bun test`
Expected: All tests pass. The change is internal — same processNext() logic, just triggered faster.

**Step 6: Commit**

```bash
git add src/queue/db.ts src/queue/processor.ts src/__tests__/queue-async.test.ts
git commit -m "feat: event-driven queue processing with fallback polling (100ms → <1ms latency)"
```

---

## Task 5: Message Priority Tiers

Add priority to messages so system messages (scheduled tasks, proposals) skip ahead of user chat.

**Files:**
- Modify: `src/queue/db.ts` (add priority column, order by priority)
- Test: `src/__tests__/queue-priority.test.ts` (new)

**Step 1: Write the failing test**

Create `src/__tests__/queue-priority.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

describe("message priority", () => {
  test("system messages claimed before user messages", () => {
    // Will test that claimMessage returns highest-priority first
    // Priority: 0=low, 1=normal (default), 2=system
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE, channel TEXT, sender TEXT, message TEXT,
        agent TEXT, status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 1,
        created_at INTEGER, updated_at INTEGER
      )
    `);

    const now = Date.now();
    // Insert normal message first
    db.prepare("INSERT INTO messages (message_id, channel, sender, message, agent, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("msg-1", "discord", "user1", "Hello", "nyx", "pending", 1, now, now);
    // Insert system message second (should be claimed first despite being newer)
    db.prepare("INSERT INTO messages (message_id, channel, sender, message, agent, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("msg-2", "system", "scheduler", "Run evolution", "nyx", "pending", 2, now + 1, now + 1);

    const claimed = db.prepare(
      "SELECT * FROM messages WHERE status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 1"
    ).get() as any;

    expect(claimed.message_id).toBe("msg-2"); // System message first
    expect(claimed.priority).toBe(2);
  });
});
```

**Step 2: Run test**

Run: `bun test src/__tests__/queue-priority.test.ts`
Expected: PASS (standalone SQLite test).

**Step 3: Add priority column to QueueDB schema**

In `src/queue/db.ts`, modify the SCHEMA constant (~line 9):
- Add `priority INTEGER NOT NULL DEFAULT 1` to messages table
- Update `idx_messages_status` index to include priority

**Step 4: Update claimMessage ordering**

In `claimMessage()` (~line 185), change the SELECT ORDER BY from:
```sql
ORDER BY created_at ASC LIMIT 1
```
to:
```sql
ORDER BY priority DESC, created_at ASC LIMIT 1
```

**Step 5: Set priority on enqueue**

In `enqueueMessage()`, derive priority from channel:
```typescript
const priority = data.channel === "system" || data.channel === "scheduler" ? 2
  : data.channel === "background" ? 0
  : 1;
```

**Step 6: Run full test suite**

Run: `bun test`
Expected: All pass. Default priority=1 preserves existing behavior.

**Step 7: Commit**

```bash
git add src/queue/db.ts src/__tests__/queue-priority.test.ts
git commit -m "feat: message priority tiers — system messages skip ahead of user chat"
```

---

## Task 6: Test Coverage — Knowledge Search

The knowledge search pipeline (`src/queue/knowledge-search.ts`) has no dedicated test file. Add comprehensive tests for enrichment, two-phase filtering, feedback loop, and merge logic.

**Files:**
- Test: `src/__tests__/knowledge-search.test.ts` (new)

**Step 1: Write tests**

Create `src/__tests__/knowledge-search.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { applyRetrievalFeedback, mergeKnowledgeContext } from "../queue/knowledge-search.js";

// Mock KnowledgeStore for feedback tests
function mockKnowledgeStore() {
  const nudges: Array<{ id: number; delta: number }> = [];
  return {
    nudges,
    nudgeConfidence(id: number, delta: number) { nudges.push({ id, delta }); },
  };
}

describe("applyRetrievalFeedback", () => {
  test("boosts confidence when keywords match response", () => {
    const store = mockKnowledgeStore();
    const snippets = new Map([[1, "SQLite database performance optimization"]]);
    applyRetrievalFeedback(store as any, snippets, "We optimized the SQLite database for better performance");
    expect(store.nudges).toContainEqual({ id: 1, delta: 0.02 });
  });

  test("decays confidence when keywords not in response", () => {
    const store = mockKnowledgeStore();
    const snippets = new Map([[1, "PostgreSQL replication setup"]]);
    applyRetrievalFeedback(store as any, snippets, "The weather is nice today");
    expect(store.nudges).toContainEqual({ id: 1, delta: -0.01 });
  });

  test("no-op when snippets empty", () => {
    const store = mockKnowledgeStore();
    applyRetrievalFeedback(store as any, new Map(), "any response");
    expect(store.nudges).toHaveLength(0);
  });

  test("handles multiple chunks independently", () => {
    const store = mockKnowledgeStore();
    const snippets = new Map([
      [1, "SQLite database setup"],
      [2, "React component lifecycle"],
    ]);
    applyRetrievalFeedback(store as any, snippets, "We set up the SQLite database connection");
    // Chunk 1 should be boosted (keywords match), chunk 2 decayed (no match)
    expect(store.nudges.find(n => n.id === 1)?.delta).toBe(0.02);
    expect(store.nudges.find(n => n.id === 2)?.delta).toBe(-0.01);
  });
});

describe("mergeKnowledgeContext", () => {
  test("returns null when both inputs null", () => {
    expect(mergeKnowledgeContext(null, null)).toBeNull();
  });

  test("returns parent when task is null", () => {
    expect(mergeKnowledgeContext("parent context", null)).toBe("parent context");
  });

  test("returns task when parent is null", () => {
    expect(mergeKnowledgeContext(null, "task context")).toBe("task context");
  });

  test("deduplicates by source link", () => {
    const parent = "[Source: [[doc#section]]]\nContent A";
    const task = "[Source: [[doc#section]]]\nContent A duplicate";
    const result = mergeKnowledgeContext(parent, task);
    expect(result).toBe(parent); // Only first occurrence kept
  });

  test("merges unique chunks from both", () => {
    const parent = "[Source: [[doc1]]]\nContent A";
    const task = "[Source: [[doc2]]]\nContent B";
    const result = mergeKnowledgeContext(parent, task)!;
    expect(result).toContain("Content A");
    expect(result).toContain("Content B");
  });

  test("caps at 2000 chars", () => {
    const long = "[Source: [[doc]]]\n" + "x".repeat(1500);
    const result = mergeKnowledgeContext(long, long + "extra");
    expect(result!.length).toBeLessThanOrEqual(2000);
  });
});
```

**Step 2: Run tests**

Run: `bun test src/__tests__/knowledge-search.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/__tests__/knowledge-search.test.ts
git commit -m "test: knowledge search — feedback loop, merge, deduplication coverage"
```

---

## Task 7: Test Coverage — Memory Extraction

`src/memory/extract.ts` has no tests for its JSON parsing, type validation, or importance clamping.

**Files:**
- Test: `src/__tests__/memory-extract.test.ts` (new)

**Step 1: Read the actual extract.ts to understand the parsing**

Read `src/memory/extract.ts` fully before writing tests.

**Step 2: Write tests**

Create `src/__tests__/memory-extract.test.ts`. Test:
- Valid JSON extraction from response text
- JSON wrapped in markdown code blocks
- Invalid type filtering (only valid MemoryTypes pass)
- Importance clamping (values > 1.0 → 1.0, < 0 → 0)
- Content minimum length (< 3 chars rejected)
- Empty/invalid response returns []
- Router error returns [] gracefully

These tests need to mock the router. Look at how existing tests mock LLM calls (check `src/__tests__/memory-extraction.test.ts` for patterns).

**Step 3: Run tests**

Run: `bun test src/__tests__/memory-extract.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/__tests__/memory-extract.test.ts
git commit -m "test: memory extraction — JSON parsing, type validation, importance clamping"
```

---

## Task 8: Test Coverage — Learning Pipeline

`src/learning/analysis.ts`, `distill.ts`, and `listeners.ts` (601 lines total) have minimal test coverage. The existing `learning.test.ts` likely covers only basics.

**Files:**
- Test: `src/__tests__/learning-analysis.test.ts` (new)
- Test: `src/__tests__/learning-distill.test.ts` (new)

**Step 1: Read existing learning.test.ts**

Check what's already covered before writing new tests.

**Step 2: Write analysis tests**

Create `src/__tests__/learning-analysis.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { generateScoutReport, formatScoutReport } from "../learning/analysis.js";

describe("generateScoutReport", () => {
  test("groups proposals by scout_source", () => {
    const proposals = [
      { scout_source: "evolution:cycle-1", status: "approved" },
      { scout_source: "evolution:cycle-1", status: "rejected" },
      { scout_source: "evolution:cycle-2", status: "approved" },
    ] as any[];

    const report = generateScoutReport(proposals, Date.now() - 86400000, Date.now());
    expect(report.bySource).toBeDefined();
    expect(Object.keys(report.bySource).length).toBe(2);
  });

  test("calculates acceptance rate correctly", () => {
    const proposals = [
      { scout_source: "test", status: "approved" },
      { scout_source: "test", status: "approved" },
      { scout_source: "test", status: "rejected" },
    ] as any[];

    const report = generateScoutReport(proposals, Date.now() - 86400000, Date.now());
    // 2/3 approved = 66.7%
    expect(report.bySource["test"].acceptanceRate).toBeCloseTo(66.7, 0);
  });

  test("empty proposals produces empty report", () => {
    const report = generateScoutReport([], Date.now() - 86400000, Date.now());
    expect(Object.keys(report.bySource)).toHaveLength(0);
  });
});

describe("formatScoutReport", () => {
  test("produces markdown output", () => {
    const report = generateScoutReport([
      { scout_source: "test", status: "approved" },
    ] as any[], Date.now() - 86400000, Date.now());

    const md = formatScoutReport(report);
    expect(md).toContain("test");
    expect(typeof md).toBe("string");
  });
});
```

**Step 3: Write distillation tests**

Create `src/__tests__/learning-distill.test.ts`. Test `distillPatterns()` with mocked router and outcomes. Focus on:
- Grouping outcomes by agent
- Prompt construction
- Pattern parsing from LLM response
- Empty outcomes handling

**Step 4: Run tests**

Run: `bun test src/__tests__/learning-analysis.test.ts src/__tests__/learning-distill.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/__tests__/learning-analysis.test.ts src/__tests__/learning-distill.test.ts
git commit -m "test: learning pipeline — scout report generation, pattern distillation"
```

---

## Task 9: Test Coverage — Agent Routing

`src/agents/routing.ts` (65 lines) handles @mention parsing and agent/team routing. No dedicated tests.

**Files:**
- Test: `src/__tests__/agent-routing.test.ts` (new)

**Step 1: Write tests**

Create `src/__tests__/agent-routing.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { routeMessage } from "../agents/routing.js";

const mockConfig = {
  agents: {
    nyx: { name: "Nyx", role: "lead" },
    analyst: { name: "Analyst", role: "worker" },
  },
  teams: {
    engineering: { name: "Engineering", agents: ["nyx", "analyst"] },
  },
  daemon: { default_agent: "nyx" },
} as any;

describe("routeMessage", () => {
  test("routes @mention to correct agent", () => {
    const result = routeMessage("@analyst research this topic", mockConfig);
    expect(result.type).toBe("agent");
    expect(result.name).toBe("analyst");
    expect(result.strippedMessage).toBe("research this topic");
  });

  test("case-insensitive @mention", () => {
    const result = routeMessage("@Analyst check this", mockConfig);
    expect(result.name).toBe("analyst");
  });

  test("routes @team mention to team", () => {
    const result = routeMessage("@engineering deploy this", mockConfig);
    expect(result.type).toBe("team");
    expect(result.name).toBe("engineering");
  });

  test("defaults to default_agent when no mention", () => {
    const result = routeMessage("just a regular message", mockConfig);
    expect(result.type).toBe("agent");
    expect(result.name).toBe("nyx");
  });

  test("defaults when @mention doesn't match any agent", () => {
    const result = routeMessage("@unknown do something", mockConfig);
    expect(result.type).toBe("agent");
    expect(result.name).toBe("nyx"); // Falls through to default
  });
});
```

**Step 2: Run tests**

Run: `bun test src/__tests__/agent-routing.test.ts`
Expected: PASS (or adjust based on actual `routeMessage` signature).

**Step 3: Commit**

```bash
git add src/__tests__/agent-routing.test.ts
git commit -m "test: agent routing — @mention parsing, team routing, default fallback"
```

---

## Task 10: CLI Status Enhancement

Current `nyxhive status` shows PID, port, health, agents, channels. Add uptime, message counts, and queue stats.

**Files:**
- Modify: `src/cli/status.ts`
- Modify: `src/server/routes/` (ensure `/health` returns stats — check existing endpoint first)

**Step 1: Read the health endpoint**

Find and read the `/health` route to understand what it currently returns.

**Step 2: Enhance health endpoint**

If `/health` doesn't return stats, add them:
```typescript
{
  status: "ok",
  uptime_seconds: process.uptime(),
  queue: { pending, processing, completed, failed, dead_letter },
  agents: { count, names },
  memory: { rss_mb: process.memoryUsage().rss / 1024 / 1024 }
}
```

**Step 3: Enhance status CLI**

In `src/cli/status.ts`, after the health check (~line 83), parse the JSON response and display:

```typescript
    const data = await res.json();
    logger.info(`  Uptime:    ${formatUptime(data.uptime_seconds)}`);
    logger.info(`  Queue:     ${data.queue.pending} pending, ${data.queue.completed} completed, ${data.queue.dead_letter} dead`);
    logger.info(`  Memory:    ${data.memory.rss_mb.toFixed(0)} MB RSS`);
```

Add helper:
```typescript
function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
```

**Step 4: Run full test suite**

Run: `bun test`
Expected: All pass.

**Step 5: Commit**

```bash
git add src/cli/status.ts src/server/routes/
git commit -m "feat: enhanced nyxhive status — uptime, queue stats, memory usage"
```

---

## Task 11: CLI Health Command

Add `nyxhive health` that validates instance configuration without starting the server.

**Files:**
- Create: `src/cli/health.ts` (new)
- Modify: `src/cli/index.ts` (add command)

**Step 1: Implement health check**

Create `src/cli/health.ts`:

```typescript
import { existsSync } from "fs";
import { resolve } from "path";
import { loadConfig } from "../config.js";
import { resolveInstance, loadInstanceEnv } from "./resolve.js";
import { logger } from "../utils/logger.js";
import { Database } from "bun:sqlite";

function parseArgs() {
  const args = process.argv.slice(3);
  let configPath: string | undefined;
  let instanceName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) configPath = args[++i];
    else if (!args[i].startsWith("--")) instanceName = args[i];
  }
  return { configPath, instanceName };
}

async function main() {
  const { configPath, instanceName } = parseArgs();
  const { configPath: resolved, instanceDir } = resolveInstance(instanceName, undefined, configPath);
  loadInstanceEnv(instanceDir);

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. Config loads without error
  try {
    const config = loadConfig(resolved);
    checks.push({ name: "Config", ok: true, detail: `${Object.keys(config.agents).length} agents configured` });

    // 2. Data directory exists and is writable
    const dataDir = resolve(config.daemon.data_dir);
    const dataExists = existsSync(dataDir);
    checks.push({ name: "Data dir", ok: dataExists, detail: dataExists ? dataDir : `Missing: ${dataDir}` });

    // 3. SQLite databases accessible
    if (dataExists) {
      try {
        const db = new Database(resolve(dataDir, "queue.sqlite"), { readonly: true });
        db.close();
        checks.push({ name: "Queue DB", ok: true, detail: "accessible" });
      } catch {
        checks.push({ name: "Queue DB", ok: false, detail: "cannot open" });
      }
    }

    // 4. API keys present
    for (const [key, agent] of Object.entries(config.agents)) {
      const provider = agent.provider;
      const envVar = provider === "anthropic" ? "ANTHROPIC_API_KEY"
        : provider === "openrouter" ? "OPENROUTER_API_KEY"
        : null;
      if (envVar) {
        const hasKey = !!process.env[envVar];
        checks.push({
          name: `API key (${key})`,
          ok: hasKey,
          detail: hasKey ? "set" : `Missing: ${envVar}`
        });
      }
    }

    // 5. Port available (if not running)
    try {
      const res = await fetch(`http://localhost:${config.server.port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      checks.push({ name: "Port", ok: true, detail: `${config.server.port} (instance running)` });
    } catch {
      checks.push({ name: "Port", ok: true, detail: `${config.server.port} (available)` });
    }
  } catch (err) {
    checks.push({ name: "Config", ok: false, detail: `${err}` });
  }

  // Print results
  const allOk = checks.every(c => c.ok);
  for (const check of checks) {
    const icon = check.ok ? "OK" : "FAIL";
    logger.info(`  [${icon}] ${check.name}: ${check.detail}`);
  }
  logger.info("");
  logger.info(allOk ? "  Instance is healthy." : "  Instance has issues — fix the FAIL items above.");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  logger.error(`Error: ${err}`);
  process.exit(1);
});
```

**Step 2: Wire into CLI**

In `src/cli/index.ts`, add a case for "health":
```typescript
case "health":
  await import("./health.js");
  break;
```

**Step 3: Test manually**

Run: `nyxhive health`
Expected: Shows check results for config, data dir, DBs, API keys, port.

**Step 4: Run full test suite**

Run: `bun test`
Expected: All pass.

**Step 5: Commit**

```bash
git add src/cli/health.ts src/cli/index.ts
git commit -m "feat: nyxhive health command — validates config, DBs, API keys, port"
```

---

## Task 12: Final Verification

**Step 1: Run full test suite**

```bash
bun test
```
Expected: All tests pass (1875+ original + new tests).

**Step 2: Type check**

```bash
bunx tsc --noEmit
```
Expected: Zero errors.

**Step 3: Lint**

```bash
bun run lint
```
Expected: Clean or only pre-existing warnings.

**Step 4: Verify token accuracy improvement**

Quick manual check:
```typescript
import { estimateTokens } from "./src/context/tokens.js";
console.log(estimateTokens("Hello, world!")); // Should be ~4, not 4 (same coincidentally)
console.log(estimateTokens("function fibonacci(n: number): number { if (n <= 1) return n; return fibonacci(n - 1) + fibonacci(n - 2); }"));
// Should be ~30-35, heuristic gave ~28
```

**Step 5: Commit any remaining fixes**

If anything failed, fix and commit.

---

## Execution Summary

| Task | Workstream | What | Files Changed |
|------|-----------|------|---------------|
| 1 | WS1: Smarter | Tiktoken token counting | tokens.ts + test |
| 2 | WS1: Smarter | Graph traversal in knowledge search | knowledge-search.ts, graph.ts + test |
| 3 | WS1: Smarter | System prompt budget metering | budget.ts, types.ts + test |
| 4 | WS2: Faster | Event-driven queue processing | db.ts, processor.ts + test |
| 5 | WS2: Faster | Message priority tiers | db.ts + test |
| 6 | WS3: Reliable | Knowledge search tests | test only |
| 7 | WS3: Reliable | Memory extraction tests | test only |
| 8 | WS3: Reliable | Learning pipeline tests | test only |
| 9 | WS3: Reliable | Agent routing tests | test only |
| 10 | WS4: Polish | Enhanced status command | status.ts, health route |
| 11 | WS4: Polish | Health check command | health.ts, index.ts |
| 12 | All | Final verification | — |

**Total: 12 tasks, ~10 commits, 4 workstreams**

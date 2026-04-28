# Cognitive Upgrade Sprint — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make NyxHive's memory deeper (cross-conversation linking, semantic dedup), agents proactive (idle discovery, adaptive scheduling), and delegation smarter (rich continuations, outcome-weighted routing, review feedback).

**Architecture:** Three sequential pillars. Pillar 1 adds semantic dedup + multi-hop graph + cross-conversation linking to the memory layer. Pillar 2 adds reactive triggers + idle discovery + adaptive scheduling to the queue/scheduler layer. Pillar 3 upgrades delegation continuations + routing scoring + review feedback loops.

**Tech Stack:** TypeScript/Bun, SQLite, js-tiktoken, bun:test

---

## Pillar 1: Deeper Memory

### Task 1: Semantic Dedup at Extraction — Schema + Graph Method

**Files:**
- Modify: `src/memory/graph.ts` (add `mention_count` column + `findSemanticMatch` method)
- Test: `src/__tests__/graph-memory.test.ts`

**Step 1: Write the failing tests**

Add to `src/__tests__/graph-memory.test.ts`:

```typescript
describe("mention_count and semantic dedup support", () => {
  test("addNode stores mention_count default 1", () => {
    const id = graph.addNode("fact", "SQLite is preferred", { conversationId: "c1", channel: "test" }, 0.5);
    const node = db.prepare("SELECT mention_count FROM memory_nodes WHERE id = ?").get(id) as any;
    expect(node.mention_count).toBe(1);
  });

  test("bumpMentionCount increments and enforces importance floor", () => {
    const id = graph.addNode("fact", "Recurring pattern", { conversationId: "c1", channel: "test" }, 0.4);
    graph.bumpMentionCount(id);
    graph.bumpMentionCount(id);
    // Now mention_count = 3, importance should be at least 0.6
    const node = db.prepare("SELECT mention_count, importance FROM memory_nodes WHERE id = ?").get(id) as any;
    expect(node.mention_count).toBe(3);
    expect(node.importance).toBeGreaterThanOrEqual(0.6);
  });

  test("getRecurringPatterns returns nodes with mention_count >= 3", () => {
    const id1 = graph.addNode("pattern", "Always use bun test", { conversationId: "c1", channel: "test" }, 0.5);
    graph.bumpMentionCount(id1);
    graph.bumpMentionCount(id1);
    const id2 = graph.addNode("fact", "One-off note", { conversationId: "c1", channel: "test" }, 0.5);
    const recurring = graph.getRecurringPatterns(10);
    expect(recurring.length).toBe(1);
    expect(recurring[0].id).toBe(id1);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/graph-memory.test.ts --filter "mention_count"`
Expected: FAIL — `mention_count` column doesn't exist, `bumpMentionCount` not defined

**Step 3: Implement schema migration + methods**

In `src/memory/graph.ts`:

- In `init()`, add column migration after table creation:
```typescript
// Migration: add mention_count if missing
try {
  this.db.exec("ALTER TABLE memory_nodes ADD COLUMN mention_count INTEGER DEFAULT 1");
} catch { /* column already exists */ }
```

- Add `bumpMentionCount(nodeId)`:
```typescript
bumpMentionCount(nodeId: number): void {
  this.db.run(
    `UPDATE memory_nodes
     SET mention_count = mention_count + 1,
         importance = CASE
           WHEN mention_count + 1 >= 3 AND importance < 0.6 THEN 0.6
           ELSE importance
         END
     WHERE id = ?`,
    [nodeId]
  );
}
```

- Add `getRecurringPatterns(limit)`:
```typescript
getRecurringPatterns(limit: number): GraphNode[] {
  return this.db
    .prepare(
      `SELECT * FROM memory_nodes
       WHERE mention_count >= 3
       ORDER BY mention_count DESC, importance DESC
       LIMIT ?`
    )
    .all(limit) as GraphNode[];
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/graph-memory.test.ts --filter "mention_count"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/graph.ts src/__tests__/graph-memory.test.ts
git commit -m "feat(memory): add mention_count column, bumpMentionCount, getRecurringPatterns"
```

---

### Task 2: Semantic Dedup at Extraction — Matching Logic

**Files:**
- Modify: `src/queue/memory-extraction.ts` (add semantic match before insertion)
- Modify: `src/memory/graph.ts` (add `findByContent` FTS search for cross-check)
- Test: `src/__tests__/memory-extraction.test.ts`

**Step 1: Write the failing tests**

Add to `src/__tests__/memory-extraction.test.ts`:

```typescript
describe("semantic dedup at extraction", () => {
  test("merges semantically duplicate memory instead of creating new node", async () => {
    // Pre-populate graph with existing node
    const existingId = graph.addNode("fact", "User prefers SQLite over Postgres", { conversationId: "old-conv", channel: "test" }, 0.5);

    // Mock knowledgeStore.search to return high similarity
    const mockSearch = spyOn(knowledgeStore, "search").mockResolvedValue([
      { content: "User prefers SQLite over Postgres", similarity: 0.92, metadata: { graphNodeId: existingId } }
    ]);

    await extractAndPersistMemories(deps, "new-conv", messages, "nyx");

    // Should have bumped mention_count, not created new node
    const node = db.prepare("SELECT mention_count FROM memory_nodes WHERE id = ?").get(existingId) as any;
    expect(node.mention_count).toBeGreaterThan(1);
    mockSearch.mockRestore();
  });

  test("creates related_to edge for near-match (0.75-0.88)", async () => {
    const existingId = graph.addNode("fact", "Use SQLite for simple storage", { conversationId: "old-conv", channel: "test" }, 0.5);

    const mockSearch = spyOn(knowledgeStore, "search").mockResolvedValue([
      { content: "Use SQLite for simple storage", similarity: 0.80, metadata: { graphNodeId: existingId } }
    ]);

    await extractAndPersistMemories(deps, "new-conv", messages, "nyx");

    // Should create node AND edge
    const edges = db.prepare(
      "SELECT * FROM memory_edges WHERE target_id = ? AND type = 'related_to'"
    ).all(existingId) as any[];
    expect(edges.length).toBeGreaterThanOrEqual(1);
    mockSearch.mockRestore();
  });

  test("creates standalone node for low similarity (<0.75)", async () => {
    const beforeCount = (db.prepare("SELECT COUNT(*) as c FROM memory_nodes").get() as any).c;

    const mockSearch = spyOn(knowledgeStore, "search").mockResolvedValue([
      { content: "Something unrelated", similarity: 0.40, metadata: {} }
    ]);

    await extractAndPersistMemories(deps, "new-conv", messages, "nyx");

    const afterCount = (db.prepare("SELECT COUNT(*) as c FROM memory_nodes").get() as any).c;
    expect(afterCount).toBeGreaterThan(beforeCount);
    mockSearch.mockRestore();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/memory-extraction.test.ts --filter "semantic dedup"`
Expected: FAIL — current code doesn't do semantic matching

**Step 3: Implement semantic dedup in extractAndPersistMemories**

In `src/queue/memory-extraction.ts`, before each `addNodeDedup()` / `addNode()` call, add:

```typescript
async function findSemanticMatch(
  content: string,
  knowledgeStore: KnowledgeStore | undefined,
): Promise<{ nodeId: number | null; similarity: number }> {
  if (!knowledgeStore) return { nodeId: null, similarity: 0 };
  try {
    const results = await knowledgeStore.search(content, { limit: 1, threshold: 0.75 });
    if (results.length > 0 && results[0].metadata?.graphNodeId) {
      return { nodeId: results[0].metadata.graphNodeId, similarity: results[0].similarity };
    }
  } catch { /* embedding failure, proceed with standalone */ }
  return { nodeId: null, similarity: 0 };
}

function handleSemanticMatch(
  match: { nodeId: number | null; similarity: number },
  newNodeId: number | null,
  graph: GraphMemory,
): boolean {
  if (!match.nodeId) return false;
  if (match.similarity >= 0.88) {
    // Merge: bump existing, skip new
    graph.bumpMentionCount(match.nodeId);
    return true; // signal: skip insertion
  }
  if (match.similarity >= 0.75 && newNodeId) {
    // Near-match: link
    graph.addEdge(newNodeId, match.nodeId, "related_to");
    return false;
  }
  return false;
}
```

Wrap each addNode call: check semantic match first, if merged skip insertion, if near-match add edge after insertion.

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/memory-extraction.test.ts --filter "semantic dedup"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/queue/memory-extraction.ts src/memory/graph.ts src/__tests__/memory-extraction.test.ts
git commit -m "feat(memory): semantic dedup at extraction — merge duplicates, link near-matches"
```

---

### Task 3: Multi-Hop Graph Traversal

**Files:**
- Modify: `src/memory/graph.ts` (`expandWithGraphContext` → 2-hop)
- Test: `src/__tests__/knowledge-graph-traversal.test.ts`

**Step 1: Write the failing tests**

Add to `src/__tests__/knowledge-graph-traversal.test.ts`:

```typescript
describe("2-hop graph expansion", () => {
  test("expands to hop-2 nodes with reduced weight", () => {
    const a = graph.addNode("fact", "Node A", src, 0.8);
    const b = graph.addNode("fact", "Node B", src, 0.7);
    const c = graph.addNode("fact", "Node C (2-hop)", src, 0.5);

    graph.addEdge(a, b, "related_to");
    graph.addEdge(b, c, "related_to");

    const result = graph.expandWithGraphContext([a]);
    const ids = result.map(n => n.id);
    expect(ids).toContain(b);
    expect(ids).toContain(c);

    const cNode = result.find(n => n.id === c)!;
    expect(cNode._hopWeight).toBe(0.4);
  });

  test("caps total expanded nodes at 15", () => {
    const root = graph.addNode("fact", "Root", src, 0.8);
    // Create 20 hop-1 nodes
    for (let i = 0; i < 20; i++) {
      const n = graph.addNode("fact", `Hop1-${i}`, src, 0.5);
      graph.addEdge(root, n, "related_to");
    }
    const result = graph.expandWithGraphContext([root]);
    expect(result.length).toBeLessThanOrEqual(15);
  });

  test("skips hop-2 when hop-1 returns >= 10 nodes", () => {
    const root = graph.addNode("fact", "Root", src, 0.8);
    const hop1Nodes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const n = graph.addNode("fact", `Hop1-${i}`, src, 0.6);
      graph.addEdge(root, n, "related_to");
      hop1Nodes.push(n);
    }
    // Add hop-2 nodes
    const hop2 = graph.addNode("fact", "Hop2 should be skipped", src, 0.5);
    graph.addEdge(hop1Nodes[0], hop2, "related_to");

    const result = graph.expandWithGraphContext([root]);
    const ids = result.map(n => n.id);
    expect(ids).not.toContain(hop2);
  });

  test("filters hop-2 nodes below importance 0.3", () => {
    const a = graph.addNode("fact", "A", src, 0.8);
    const b = graph.addNode("fact", "B", src, 0.7);
    const lowImportance = graph.addNode("fact", "Low importance", src, 0.1);

    graph.addEdge(a, b, "related_to");
    graph.addEdge(b, lowImportance, "related_to");

    const result = graph.expandWithGraphContext([a]);
    const ids = result.map(n => n.id);
    expect(ids).toContain(b);
    expect(ids).not.toContain(lowImportance);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/knowledge-graph-traversal.test.ts --filter "2-hop"`
Expected: FAIL — no hop-2 logic, no `_hopWeight`, no cap

**Step 3: Implement 2-hop expansion**

In `src/memory/graph.ts`, modify `expandWithGraphContext()`:

```typescript
expandWithGraphContext(seedIds: number[], maxNodes = 15): ExpandedNode[] {
  if (seedIds.length === 0) return [];

  const seen = new Set(seedIds);
  const result: ExpandedNode[] = [];

  // Hop 1
  const hop1Ids: number[] = [];
  for (const id of seedIds) {
    const neighbors = this.getNeighbors(id);
    for (const n of neighbors) {
      if (!seen.has(n.id)) {
        seen.add(n.id);
        hop1Ids.push(n.id);
        result.push({ ...n, _hopWeight: 1.0 });
      }
    }
  }

  // Hop 2: only if hop-1 returned < 10 nodes
  if (hop1Ids.length < 10) {
    for (const id of hop1Ids) {
      if (result.length >= maxNodes) break;
      const neighbors = this.getNeighbors(id);
      for (const n of neighbors) {
        if (result.length >= maxNodes) break;
        if (!seen.has(n.id) && n.importance > 0.3) {
          seen.add(n.id);
          result.push({ ...n, _hopWeight: 0.4 });
        }
      }
    }
  }

  return result.slice(0, maxNodes);
}
```

Add `ExpandedNode` type (extends GraphNode with `_hopWeight`).

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/knowledge-graph-traversal.test.ts --filter "2-hop"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/graph.ts src/__tests__/knowledge-graph-traversal.test.ts
git commit -m "feat(memory): 2-hop graph expansion with importance filter and node cap"
```

---

### Task 4: Cross-Conversation Memory Linking

**Files:**
- Modify: `src/queue/memory-extraction.ts` (post-extraction cross-link pass)
- Modify: `src/memory/graph.ts` (add `searchAcrossConversations`)
- Test: `src/__tests__/memory-extraction.test.ts`

**Step 1: Write the failing tests**

```typescript
describe("cross-conversation linking", () => {
  test("creates related_to edge between similar nodes from different conversations", async () => {
    // Pre-existing node from old conversation
    const oldId = graph.addNode("pattern", "mock.module pollutes global state", {
      conversationId: "conv-old", channel: "test"
    }, 0.7);

    // New extraction finds similar pattern in different conversation
    // (mock the LLM extraction to return similar content)
    // After extraction, should find cross-conv edge
    const newId = graph.addNode("pattern", "mock.module is process-global in Bun", {
      conversationId: "conv-new", channel: "test"
    }, 0.7);

    const linked = graph.searchAcrossConversations("conv-new", "mock.module", 5);
    expect(linked.length).toBeGreaterThanOrEqual(1);
    expect(linked[0].source_conversation).toBe("conv-old");
  });

  test("does not link nodes from same conversation", () => {
    graph.addNode("fact", "Same conv A", { conversationId: "conv-1", channel: "test" }, 0.5);
    graph.addNode("fact", "Same conv B", { conversationId: "conv-1", channel: "test" }, 0.5);

    const linked = graph.searchAcrossConversations("conv-1", "Same conv", 5);
    expect(linked.length).toBe(0); // same conversation excluded
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/memory-extraction.test.ts --filter "cross-conversation"`
Expected: FAIL — `searchAcrossConversations` doesn't exist

**Step 3: Implement cross-conversation search + linking**

In `src/memory/graph.ts`:

```typescript
searchAcrossConversations(excludeConvId: string, query: string, limit: number): GraphNode[] {
  return this.db
    .prepare(
      `SELECT n.* FROM memory_nodes n
       JOIN memory_nodes_fts fts ON n.id = fts.rowid
       WHERE memory_nodes_fts MATCH ?
         AND n.source_conversation != ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(query, excludeConvId, limit) as GraphNode[];
}
```

In `src/queue/memory-extraction.ts`, add a post-extraction pass:

```typescript
async function crossLinkMemories(
  graph: GraphMemory,
  convId: string,
  newNodeIds: number[],
): Promise<void> {
  for (const nodeId of newNodeIds) {
    const node = graph.getNode(nodeId);
    if (!node) continue;
    // Extract keywords from content (first 3 significant words)
    const keywords = extractKeywords(node.content);
    if (!keywords) continue;
    const crossMatches = graph.searchAcrossConversations(convId, keywords, 3);
    for (const match of crossMatches) {
      graph.addEdge(nodeId, match.id, "related_to");
      // Bump both nodes' mention count
      graph.bumpMentionCount(nodeId);
      graph.bumpMentionCount(match.id);
    }
  }
}
```

Call `crossLinkMemories()` at the end of `extractAndPersistMemories()`, passing the IDs of all newly created nodes.

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/memory-extraction.test.ts --filter "cross-conversation"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/graph.ts src/queue/memory-extraction.ts src/__tests__/memory-extraction.test.ts
git commit -m "feat(memory): cross-conversation memory linking via FTS + mention_count bumps"
```

---

### Task 5: Recurring Patterns in Briefing

**Files:**
- Modify: `src/memory/graph.ts` (`getRelevantBriefing` — inject recurring patterns section)
- Test: `src/__tests__/graph-memory.test.ts`

**Step 1: Write the failing test**

```typescript
test("getRelevantBriefing includes recurring patterns section", () => {
  // Create a recurring pattern (mention_count >= 3)
  const id = graph.addNode("pattern", "Always use spyOn not mock.module for core modules", {
    conversationId: "c1", channel: "test"
  }, 0.7);
  graph.bumpMentionCount(id);
  graph.bumpMentionCount(id); // now mention_count = 3

  // Create a normal node
  graph.addNode("fact", "One-off observation", { conversationId: "c2", channel: "test" }, 0.5);

  const briefing = graph.getRelevantBriefing({ keywords: ["test"], tokenBudget: 2000 });
  expect(briefing).toContain("Recurring patterns");
  expect(briefing).toContain("spyOn");
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/graph-memory.test.ts --filter "recurring patterns section"`
Expected: FAIL

**Step 3: Implement recurring patterns injection**

In `getRelevantBriefing()`, after the main briefing assembly, prepend a recurring patterns block:

```typescript
const recurring = this.getRecurringPatterns(5);
if (recurring.length > 0) {
  const recurringBlock = recurring
    .map(n => `- ${n.content} (seen ${n.mention_count}x)`)
    .join("\n");
  sections.unshift(`**Recurring patterns:**\n${recurringBlock}`);
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/graph-memory.test.ts --filter "recurring patterns section"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/graph.ts src/__tests__/graph-memory.test.ts
git commit -m "feat(memory): inject recurring patterns into graph briefing"
```

---

## Pillar 2: Proactive Agents

### Task 6: Reactive Task Triggers — followup Action Tag

**Files:**
- Modify: `src/agents/actor.ts` (add `followup` action parsing)
- Modify: `src/queue/processor.ts` (handle followup actions post-response)
- Test: `src/__tests__/actor.test.ts` (or create if needed)

**Step 1: Write the failing tests**

```typescript
describe("followup action tag parsing", () => {
  test("parses [@followup: task description]", () => {
    const result = parseAgentActions("Found issue. [@followup: investigate deeper into the auth module]");
    expect(result.followups).toHaveLength(1);
    expect(result.followups[0].task).toBe("investigate deeper into the auth module");
    expect(result.followups[0].agent).toBeUndefined();
  });

  test("parses [@followup agent_name: task description]", () => {
    const result = parseAgentActions("[@followup analyst: review the cost data from last week]");
    expect(result.followups).toHaveLength(1);
    expect(result.followups[0].task).toBe("review the cost data from last week");
    expect(result.followups[0].agent).toBe("analyst");
  });

  test("handles multiple followups", () => {
    const result = parseAgentActions(
      "[@followup: task one] and also [@followup tester: task two]"
    );
    expect(result.followups).toHaveLength(2);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/actor.test.ts --filter "followup"`
Expected: FAIL — `followups` not in return type

**Step 3: Implement followup parsing**

In `src/agents/actor.ts`, add regex + parsing for `[@followup ...]`:

```typescript
const FOLLOWUP_REGEX = /\[@followup(?:\s+(\w+))?:\s*([^\]]+)\]/gi;

// In parseAgentActions return type, add:
followups: Array<{ task: string; agent?: string }>;

// In the parsing logic:
const followups: Array<{ task: string; agent?: string }> = [];
let followupMatch: RegExpExecArray | null;
while ((followupMatch = FOLLOWUP_REGEX.exec(text)) !== null) {
  followups.push({
    agent: followupMatch[1] || undefined,
    task: followupMatch[2].trim(),
  });
}
```

In `src/queue/processor.ts`, after processing agent response and parsing actions:

```typescript
// Handle followup tasks
if (actions.followups?.length) {
  for (const followup of actions.followups) {
    const targetAgent = followup.agent || agentKey;
    this.queue.enqueue({
      content: followup.task,
      agent: targetAgent,
      sender: agentKey,
      channel: "system",
      priority: msg.priority ?? 1,
    });
    logger.info(`[processor] Queued followup for ${targetAgent}: ${followup.task.slice(0, 80)}`);
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/actor.test.ts --filter "followup"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agents/actor.ts src/queue/processor.ts src/__tests__/actor.test.ts
git commit -m "feat(proactive): [@followup] action tag for reactive task chaining"
```

---

### Task 7: Idle-Aware Discovery

**Files:**
- Modify: `src/queue/processor.ts` (track idle state, trigger scout on idle)
- Modify: `src/defaults.ts` (add idle config defaults)
- Test: `src/__tests__/processor.test.ts`

**Step 1: Write the failing tests**

```typescript
describe("idle-aware discovery", () => {
  test("triggers scout task after idle threshold", async () => {
    const enqueueSpy = spyOn(processor.queue, "enqueue");

    // Simulate idle: set lastActivityAt to 31 minutes ago
    processor["lastActivityAt"] = Date.now() - 31 * 60 * 1000;
    processor["lastIdleTriggerAt"] = 0;

    // Mock budget check to allow
    spyOn(processor["config"].memory!, "getTotalCost").mockReturnValue(0);

    await processor["checkIdleDiscovery"]();

    expect(enqueueSpy).toHaveBeenCalled();
    const call = enqueueSpy.mock.calls[0][0];
    expect(call.channel).toBe("system");
    expect(call.content).toContain("evolution");
    enqueueSpy.mockRestore();
  });

  test("skips idle trigger when budget > autonomous ceiling", async () => {
    const enqueueSpy = spyOn(processor.queue, "enqueue");

    processor["lastActivityAt"] = Date.now() - 31 * 60 * 1000;
    processor["lastIdleTriggerAt"] = 0;

    // Mock high budget usage
    spyOn(processor["config"].memory!, "getTotalCost").mockReturnValue(100);

    await processor["checkIdleDiscovery"]();

    expect(enqueueSpy).not.toHaveBeenCalled();
    enqueueSpy.mockRestore();
  });

  test("respects cooldown between idle triggers", async () => {
    const enqueueSpy = spyOn(processor.queue, "enqueue");

    processor["lastActivityAt"] = Date.now() - 31 * 60 * 1000;
    processor["lastIdleTriggerAt"] = Date.now() - 30 * 60 * 1000; // 30 min ago, cooldown is 2h

    await processor["checkIdleDiscovery"]();

    expect(enqueueSpy).not.toHaveBeenCalled();
    enqueueSpy.mockRestore();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/processor.test.ts --filter "idle-aware"`
Expected: FAIL — `checkIdleDiscovery` doesn't exist

**Step 3: Implement idle discovery**

In `src/defaults.ts`, add:

```typescript
export const IDLE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
export const IDLE_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
export const AUTONOMOUS_BUDGET_CEILING = 0.8;
```

In `src/queue/processor.ts`, add:

```typescript
private lastActivityAt = Date.now();
private lastIdleTriggerAt = 0;

private checkIdleDiscovery(): void {
  const now = Date.now();
  const idleThreshold = this.config.nyxhiveConfig?.scheduler?.idle_threshold_minutes
    ? this.config.nyxhiveConfig.scheduler.idle_threshold_minutes * 60 * 1000
    : IDLE_THRESHOLD_MS;
  const cooldown = this.config.nyxhiveConfig?.scheduler?.idle_cooldown_minutes
    ? this.config.nyxhiveConfig.scheduler.idle_cooldown_minutes * 60 * 1000
    : IDLE_COOLDOWN_MS;

  if (now - this.lastActivityAt < idleThreshold) return;
  if (now - this.lastIdleTriggerAt < cooldown) return;
  if (this.queue.getPendingCountAll() > 0) return;

  // Budget check
  if (this.config.memory) {
    const dailyCost = this.config.memory.getTotalCost(24);
    const budgetCfg = getBudgetConfig(this.config.nyxhiveConfig?.budget);
    const ceiling = this.config.nyxhiveConfig?.budget?.autonomous_ceiling ?? AUTONOMOUS_BUDGET_CEILING;
    if (budgetCfg.monthly > 0 && dailyCost > (budgetCfg.monthly / 30) * ceiling) return;
  }

  this.lastIdleTriggerAt = now;
  const orchestrator = this.resolveOrchestrator();
  this.queue.enqueue({
    content: "Idle discovery: run a lightweight evolution scan for improvement opportunities.",
    agent: orchestrator,
    sender: "system",
    channel: "system",
    priority: 0, // background priority
  });
  logger.info("[processor] Idle discovery triggered — queued evolution scan");
}
```

Call `checkIdleDiscovery()` inside `pollLoop()` after `processNext()`.

Update `lastActivityAt` in `processForAgent()` and `processThreadMessage()` after completion.

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/processor.test.ts --filter "idle-aware"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/queue/processor.ts src/defaults.ts src/__tests__/processor.test.ts
git commit -m "feat(proactive): idle-aware discovery — auto-trigger scout on queue idle"
```

---

### Task 8: Adaptive Scheduling

**Files:**
- Create: `src/scheduler/adaptive.ts`
- Modify: `src/scheduler/bootstrap.ts` (add schema columns, call adaptive logic)
- Test: `src/__tests__/scheduler-adaptive.test.ts`

**Step 1: Write the failing tests**

Create `src/__tests__/scheduler-adaptive.test.ts`:

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { adjustScheduleFrequency, doubleInterval, halveInterval } from "../scheduler/adaptive";

describe("adaptive scheduling", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`CREATE TABLE scheduled_tasks (
      id INTEGER PRIMARY KEY,
      name TEXT, cron_expression TEXT, original_cron TEXT,
      adjusted_cron TEXT, consecutive_empty INTEGER DEFAULT 0,
      enabled INTEGER DEFAULT 1
    )`);
  });

  test("doubleInterval converts daily to every-2-days", () => {
    expect(doubleInterval("0 2 * * *")).toBe("0 2 */2 * *");
  });

  test("doubleInterval caps at weekly", () => {
    expect(doubleInterval("0 2 */4 * *")).toBe("0 2 * * 1"); // weekly on Monday
  });

  test("halveInterval converts every-2-days to daily", () => {
    expect(halveInterval("0 2 */2 * *")).toBe("0 2 * * *");
  });

  test("halveInterval floors at every-4-hours", () => {
    expect(halveInterval("0 */4 * * *")).toBe("0 */4 * * *"); // already at floor
  });

  test("adjustScheduleFrequency increments consecutive_empty on no findings", () => {
    db.run("INSERT INTO scheduled_tasks (name, cron_expression, original_cron, consecutive_empty) VALUES (?, ?, ?, ?)",
      ["evolution:codebase-review", "0 2 * * *", "0 2 * * *", 0]);

    adjustScheduleFrequency(db, "evolution:codebase-review", false);

    const task = db.prepare("SELECT consecutive_empty FROM scheduled_tasks WHERE name = ?").get("evolution:codebase-review") as any;
    expect(task.consecutive_empty).toBe(1);
  });

  test("adjustScheduleFrequency doubles interval after 3 empty runs", () => {
    db.run("INSERT INTO scheduled_tasks (name, cron_expression, original_cron, consecutive_empty) VALUES (?, ?, ?, ?)",
      ["evolution:codebase-review", "0 2 * * *", "0 2 * * *", 2]);

    adjustScheduleFrequency(db, "evolution:codebase-review", false);

    const task = db.prepare("SELECT cron_expression, adjusted_cron FROM scheduled_tasks WHERE name = ?").get("evolution:codebase-review") as any;
    expect(task.cron_expression).toBe("0 2 */2 * *");
    expect(task.adjusted_cron).toBe("0 2 */2 * *");
  });

  test("adjustScheduleFrequency resets to original on findings", () => {
    db.run("INSERT INTO scheduled_tasks (name, cron_expression, original_cron, adjusted_cron, consecutive_empty) VALUES (?, ?, ?, ?, ?)",
      ["evolution:codebase-review", "0 2 */2 * *", "0 2 * * *", "0 2 */2 * *", 5]);

    adjustScheduleFrequency(db, "evolution:codebase-review", true);

    const task = db.prepare("SELECT cron_expression, consecutive_empty FROM scheduled_tasks WHERE name = ?").get("evolution:codebase-review") as any;
    expect(task.cron_expression).toBe("0 2 * * *");
    expect(task.consecutive_empty).toBe(0);
  });

  test("adjustScheduleFrequency halves interval on high-priority finding", () => {
    db.run("INSERT INTO scheduled_tasks (name, cron_expression, original_cron, consecutive_empty) VALUES (?, ?, ?, ?)",
      ["evolution:codebase-review", "0 2 */2 * *", "0 2 */2 * *", 0]);

    adjustScheduleFrequency(db, "evolution:codebase-review", true, "high");

    const task = db.prepare("SELECT cron_expression FROM scheduled_tasks WHERE name = ?").get("evolution:codebase-review") as any;
    expect(task.cron_expression).toBe("0 2 * * *");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/scheduler-adaptive.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Implement adaptive.ts**

Create `src/scheduler/adaptive.ts`:

```typescript
import { Database } from "bun:sqlite";
import { logger } from "../utils/logger";

export function doubleInterval(cron: string): string {
  const parts = cron.split(" ");
  // Try to double the day interval
  if (parts[2] === "*") {
    // Daily → every 2 days
    parts[2] = "*/2";
  } else if (parts[2].startsWith("*/")) {
    const n = parseInt(parts[2].slice(2));
    if (n >= 4) {
      // Cap at weekly (Monday)
      return `${parts[0]} ${parts[1]} * * 1`;
    }
    parts[2] = `*/${n * 2}`;
  } else if (parts[1].startsWith("*/")) {
    // Hourly interval → double it
    const n = parseInt(parts[1].slice(2));
    if (n >= 12) {
      // Cap: go to daily
      parts[1] = parts[1]; // already slow enough
      parts[2] = "*/2";
    } else {
      parts[1] = `*/${n * 2}`;
    }
  }
  return parts.join(" ");
}

export function halveInterval(cron: string): string {
  const parts = cron.split(" ");
  // Weekly → every 3-4 days
  if (parts[4] !== "*") {
    parts[4] = "*";
    parts[2] = "*/3";
    return parts.join(" ");
  }
  if (parts[2].startsWith("*/")) {
    const n = parseInt(parts[2].slice(2));
    if (n <= 2) {
      parts[2] = "*"; // daily
    } else {
      parts[2] = `*/${Math.ceil(n / 2)}`;
    }
  } else if (parts[1].startsWith("*/")) {
    const n = parseInt(parts[1].slice(2));
    if (n <= 4) return cron; // floor at 4 hours
    parts[1] = `*/${Math.ceil(n / 2)}`;
  }
  return parts.join(" ");
}

export function adjustScheduleFrequency(
  db: Database,
  taskName: string,
  hadFindings: boolean,
  findingPriority?: string,
): void {
  const task = db.prepare(
    "SELECT id, cron_expression, original_cron, consecutive_empty FROM scheduled_tasks WHERE name = ?"
  ).get(taskName) as { id: number; cron_expression: string; original_cron: string; consecutive_empty: number } | null;

  if (!task) return;

  if (hadFindings) {
    // Reset to original (or halve if high priority)
    const newCron = findingPriority === "high"
      ? halveInterval(task.cron_expression)
      : task.original_cron;

    db.run(
      `UPDATE scheduled_tasks
       SET cron_expression = ?, adjusted_cron = ?, consecutive_empty = 0
       WHERE id = ?`,
      [newCron, newCron === task.original_cron ? null : newCron, task.id]
    );
    logger.info(`[adaptive] ${taskName}: findings detected, cron → ${newCron}`);
  } else {
    const newEmpty = task.consecutive_empty + 1;
    if (newEmpty >= 3) {
      const newCron = doubleInterval(task.cron_expression);
      db.run(
        `UPDATE scheduled_tasks
         SET cron_expression = ?, adjusted_cron = ?, consecutive_empty = ?
         WHERE id = ?`,
        [newCron, newCron, newEmpty, task.id]
      );
      logger.info(`[adaptive] ${taskName}: ${newEmpty} empty runs, cron → ${newCron}`);
    } else {
      db.run("UPDATE scheduled_tasks SET consecutive_empty = ? WHERE id = ?", [newEmpty, task.id]);
    }
  }
}
```

In `src/scheduler/bootstrap.ts`, add schema migration for new columns:

```typescript
try { db.exec("ALTER TABLE scheduled_tasks ADD COLUMN original_cron TEXT"); } catch {}
try { db.exec("ALTER TABLE scheduled_tasks ADD COLUMN adjusted_cron TEXT"); } catch {}
try { db.exec("ALTER TABLE scheduled_tasks ADD COLUMN consecutive_empty INTEGER DEFAULT 0"); } catch {}
```

And backfill `original_cron` from `cron_expression` where null.

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/scheduler-adaptive.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/scheduler/adaptive.ts src/scheduler/bootstrap.ts src/__tests__/scheduler-adaptive.test.ts
git commit -m "feat(proactive): adaptive scheduling — self-tuning cron frequencies"
```

---

### Task 9: Budget-Gated Autonomy

**Files:**
- Modify: `src/queue/processor.ts` (add budget gate before autonomous tasks)
- Modify: `src/defaults.ts` (add `AUTONOMOUS_BUDGET_CEILING`)
- Test: `src/__tests__/processor.test.ts`

**Step 1: Write the failing tests**

```typescript
describe("budget-gated autonomy", () => {
  test("defers non-critical autonomous task when budget > 80%", () => {
    const result = processor["shouldRunAutonomousTask"]("evolution:codebase-review", false);
    // With mocked high cost — should return false
    expect(result).toBe(false);
  });

  test("allows critical tasks regardless of budget", () => {
    const result = processor["shouldRunAutonomousTask"]("proposals:reset-stale-reviewing", true);
    expect(result).toBe(true);
  });

  test("halts all autonomous tasks at 95% budget", () => {
    // Mock 95% budget usage
    const result = processor["shouldRunAutonomousTask"]("evolution:codebase-review", false);
    expect(result).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/processor.test.ts --filter "budget-gated"`
Expected: FAIL

**Step 3: Implement budget gate**

In `src/queue/processor.ts`:

```typescript
private shouldRunAutonomousTask(taskName: string, isCritical: boolean): boolean {
  if (isCritical) return true;
  if (!this.config.memory) return true;

  const dailyCost = this.config.memory.getTotalCost(24);
  const budgetCfg = getBudgetConfig(this.config.nyxhiveConfig?.budget);
  if (budgetCfg.monthly <= 0) return true; // no budget set

  const dailyBudget = budgetCfg.monthly / 30;
  const ceiling = this.config.nyxhiveConfig?.budget?.autonomous_ceiling ?? AUTONOMOUS_BUDGET_CEILING;

  if (dailyCost > dailyBudget * 0.95) {
    logger.warn(`[budget] Autonomous task ${taskName} halted — 95% daily budget spent`);
    return false;
  }
  if (dailyCost > dailyBudget * ceiling) {
    logger.info(`[budget] Autonomous task ${taskName} deferred — ${ceiling * 100}% daily budget spent`);
    return false;
  }
  return true;
}
```

Mark critical tasks in bootstrap: `health-check`, `reset-stale-reviewing`, `sync-merged`, `execute-approved`.

Call `shouldRunAutonomousTask()` before dispatching cron/idle/followup tasks in `processForAgent()`.

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/processor.test.ts --filter "budget-gated"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/queue/processor.ts src/defaults.ts src/__tests__/processor.test.ts
git commit -m "feat(proactive): budget-gated autonomy — defer non-critical tasks at budget ceiling"
```

---

## Pillar 3: Smarter Delegation

### Task 10: Rich Continuation Context

**Files:**
- Modify: `src/queue/delegation-executor.ts` (`buildContinuationPrompt`)
- Test: `src/__tests__/delegation-executor.test.ts`

**Step 1: Write the failing tests**

```typescript
describe("rich continuation context", () => {
  test("includes progress summary with extracted essence", () => {
    const previousResponse = `
I fixed the auth bug in src/auth/login.ts by adding null check.
Error was: TypeError: Cannot read property 'token' of undefined
Decided to use optional chaining instead of explicit null check.
TODO: still need to add tests for the edge case.
Also implemented the logout handler in src/auth/logout.ts.
    `.repeat(5); // make it long enough

    const result = buildContinuationPrompt("Fix auth bugs", previousResponse);

    expect(result).toContain("## Progress Summary");
    expect(result).toContain("src/auth/login.ts");
    expect(result).toContain("TypeError");
    expect(result).toContain("[Instructions]");
    expect(result).toContain("Do NOT retry");
  });

  test("caps last working state at 1500 chars", () => {
    const longResponse = "x".repeat(5000);
    const result = buildContinuationPrompt("task", longResponse);

    // Find the "Last Working State" section and check its length
    const stateStart = result.indexOf("## Last Working State");
    const instructionsStart = result.indexOf("[Instructions]");
    const stateSection = result.slice(stateStart, instructionsStart);
    expect(stateSection.length).toBeLessThan(1700); // section header + 1500 chars + some padding
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/delegation-executor.test.ts --filter "rich continuation"`
Expected: FAIL — current implementation just does tail-paste

**Step 3: Implement rich continuation**

In `src/queue/delegation-executor.ts`, replace `buildContinuationPrompt`:

```typescript
import { extractMessageEssence } from "../context/summarize";

export function buildContinuationPrompt(originalTask: string, previousResponse: string): string {
  const STATE_CAP = 1500;
  const lastState = previousResponse.length > STATE_CAP
    ? "..." + previousResponse.slice(-STATE_CAP)
    : previousResponse;

  // Extract structured progress from full response
  const essence = extractMessageEssence("assistant", previousResponse, 2000);

  return [
    "[Continuation — Previous Session Hit Turn Limit]",
    "",
    `Original task: ${originalTask.slice(0, 1000)}`,
    "",
    "## Progress Summary",
    essence,
    "",
    "## Last Working State",
    lastState,
    "",
    "[Instructions]",
    "Continue from the progress summary above.",
    "Do NOT retry approaches that resulted in errors listed above.",
    "Focus on completing remaining work — do not redo what was already done.",
    "If everything was actually completed, confirm what was done and verify it works.",
  ].join("\n");
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/delegation-executor.test.ts --filter "rich continuation"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/queue/delegation-executor.ts src/__tests__/delegation-executor.test.ts
git commit -m "feat(delegation): rich continuation context with extractMessageEssence"
```

---

### Task 11: Outcome-Weighted Routing

**Files:**
- Modify: `src/memory/routing.ts` (composite scoring in `getSuggestions`)
- Test: `src/__tests__/routing-store.test.ts`

**Step 1: Write the failing tests**

```typescript
describe("outcome-weighted routing", () => {
  test("getSuggestions uses composite score not just success_rate", () => {
    // Agent A: 95% success, expensive ($0.50 avg)
    // Agent B: 85% success, cheap ($0.05 avg)
    // For normal priority, B should sometimes win due to cost efficiency
    store.logDecision("t1", "nyx", "agent_a", "code_review", "review code", "sonnet");
    store.resolveDecision(1, "success", 50, 10000);
    // ... (repeat to get enough trials for minTrials)

    const suggestions = store.getSuggestions(30, 2);
    // Verify composite_score exists and factors in cost
    expect(suggestions[0]).toHaveProperty("composite_score");
  });

  test("formatForInjection includes cost and speed info", () => {
    // Setup data...
    const injection = store.formatForInjection(30, 2);
    expect(injection).toContain("avg");
    expect(injection).toContain("c/task"); // cost notation
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/routing-store.test.ts --filter "outcome-weighted"`
Expected: FAIL

**Step 3: Implement composite scoring**

In `src/memory/routing.ts`, update `getSuggestions()`:

```typescript
getSuggestions(sinceDays = 30, minTrials = 3): RoutingSuggestion[] {
  const matrix = this.getSkillMatrix(sinceDays, minTrials);
  if (matrix.length === 0) return [];

  // Group by task_type to compute percentiles
  const byType = new Map<string, SkillMatrixEntry[]>();
  for (const entry of matrix) {
    const group = byType.get(entry.task_type) ?? [];
    group.push(entry);
    byType.set(entry.task_type, group);
  }

  const scored: RoutingSuggestion[] = [];
  for (const [taskType, entries] of byType) {
    // Compute percentile ranks within this task_type
    const costs = entries.map(e => e.avg_cost_cents).sort((a, b) => a - b);
    const durations = entries.map(e => e.avg_duration_ms).sort((a, b) => a - b);

    let best: { entry: SkillMatrixEntry; score: number } | null = null;
    for (const e of entries) {
      const costRank = costs.indexOf(e.avg_cost_cents) / Math.max(costs.length - 1, 1);
      const speedRank = durations.indexOf(e.avg_duration_ms) / Math.max(durations.length - 1, 1);
      const costEfficiency = (1 - costRank) * 100;
      const speedFactor = (1 - speedRank) * 100;
      const score = e.success_rate * 0.6 + costEfficiency * 0.25 + speedFactor * 0.15;

      if (!best || score > best.score) {
        best = { entry: e, score };
      }
    }

    if (best) {
      scored.push({
        agent: best.entry.agent,
        task_type: taskType,
        success_rate: best.entry.success_rate,
        total_tasks: best.entry.total,
        avg_cost_cents: best.entry.avg_cost_cents,
        avg_duration_ms: best.entry.avg_duration_ms,
        composite_score: Math.round(best.score * 10) / 10,
      });
    }
  }

  return scored;
}
```

Update `RoutingSuggestion` type to include `avg_duration_ms` and `composite_score`.

Update `formatForInjection()` to show cost/speed:
```typescript
const durationNote = s.avg_duration_ms > 0 ? `, ~${Math.round(s.avg_duration_ms / 1000)}s avg` : "";
lines.push(`- **${s.task_type}** tasks: @${s.agent} has ${s.success_rate}% success (${s.total_tasks} tasks, ~${s.avg_cost_cents.toFixed(1)}c/task${durationNote})`);
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/routing-store.test.ts --filter "outcome-weighted"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/routing.ts src/__tests__/routing-store.test.ts
git commit -m "feat(delegation): outcome-weighted routing with composite cost/speed/success scoring"
```

---

### Task 12: Review Gate Feedback Loop

**Files:**
- Modify: `src/memory/routing.ts` (add `logReviewOutcome`, extend skill matrix)
- Modify: `src/queue/delegation-executor.ts` (call `logReviewOutcome` after review gate)
- Test: `src/__tests__/routing-store.test.ts`

**Step 1: Write the failing tests**

```typescript
describe("review gate feedback loop", () => {
  test("logReviewOutcome stores review result on routing decision", () => {
    const decisionId = store.logDecision("t1", "nyx", "tester", "code_review", "review", "sonnet");
    store.resolveDecision(decisionId, "success", 10, 5000);
    store.logReviewOutcome("t1", "pass");

    const row = db.prepare("SELECT review_outcome FROM routing_decisions WHERE trace_id = ?").get("t1") as any;
    expect(row.review_outcome).toBe("pass");
  });

  test("getSkillMatrix includes review_pass_rate", () => {
    // Create 3 decisions with mixed review outcomes
    for (let i = 0; i < 3; i++) {
      const id = store.logDecision(`t${i}`, "nyx", "tester", "code_review", "review", "sonnet");
      store.resolveDecision(id, "success", 10, 5000);
      store.logReviewOutcome(`t${i}`, i < 2 ? "pass" : "warn");
    }

    const matrix = store.getSkillMatrix(30, 2);
    const entry = matrix.find(e => e.agent === "tester" && e.task_type === "code_review");
    expect(entry).toBeDefined();
    expect(entry!.review_pass_rate).toBeCloseTo(66.7, 0);
  });

  test("formatForInjection flags low review pass rate", () => {
    // Create 4 decisions, 1 pass, 3 warn/fail
    for (let i = 0; i < 4; i++) {
      const id = store.logDecision(`t${i}`, "nyx", "worker", "bugfix", "fix", "sonnet");
      store.resolveDecision(id, "success", 10, 5000);
      store.logReviewOutcome(`t${i}`, i === 0 ? "pass" : "warn");
    }

    const injection = store.formatForInjection(30, 2);
    expect(injection).toContain("clean reviews");
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/routing-store.test.ts --filter "review gate feedback"`
Expected: FAIL

**Step 3: Implement review outcome tracking**

In `src/memory/routing.ts`:

Schema migration:
```typescript
try { this.db.exec("ALTER TABLE routing_decisions ADD COLUMN review_outcome TEXT"); } catch {}
```

New method:
```typescript
logReviewOutcome(traceId: string, outcome: "pass" | "warn" | "fail"): void {
  this.db.run(
    "UPDATE routing_decisions SET review_outcome = ? WHERE trace_id = ?",
    [outcome, traceId]
  );
}
```

Update `getSkillMatrix()` SQL to include:
```sql
ROUND(
  CAST(SUM(CASE WHEN review_outcome = 'pass' THEN 1 ELSE 0 END) AS REAL) /
  NULLIF(SUM(CASE WHEN review_outcome IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 1
) as review_pass_rate
```

Update `SkillMatrixEntry` type: add `review_pass_rate: number | null`.

Update `formatForInjection()`:
```typescript
const reviewNote = s.review_pass_rate != null ? `, ${s.review_pass_rate}% clean reviews` : "";
```

In `src/queue/delegation-executor.ts`, after `runReviewGate()` (around line 675):
```typescript
if (verdict && routingStore) {
  routingStore.logReviewOutcome(traceId, verdict.verdict);
}
```

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/routing-store.test.ts --filter "review gate feedback"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/routing.ts src/queue/delegation-executor.ts src/__tests__/routing-store.test.ts
git commit -m "feat(delegation): review gate feedback loop — track review outcomes in routing store"
```

---

### Task 13: Self-Delegation Check

**Files:**
- Modify: `src/queue/processor.ts` (inject self-handling nudge)
- Modify: `src/memory/routing.ts` (add `getOrchestratorSuccessRate`)
- Test: `src/__tests__/processor.test.ts`

**Step 1: Write the failing tests**

```typescript
describe("self-delegation check", () => {
  test("getSelfHandlingNudge returns nudge for simple task with high orchestrator success", () => {
    // Setup: orchestrator has 90% success on "bugfix" task type
    // Task: short, single file
    const nudge = getSelfHandlingNudge(routingStore, "nyx", "bugfix", "Fix typo in src/utils.ts");
    expect(nudge).toContain("Consider handling this directly");
  });

  test("getSelfHandlingNudge returns null for complex tasks", () => {
    const nudge = getSelfHandlingNudge(routingStore, "nyx", "feature",
      "Implement the entire authentication system with OAuth2, JWT refresh tokens, rate limiting, and session management across src/auth/, src/middleware/, and src/models/");
    expect(nudge).toBeNull();
  });

  test("getSelfHandlingNudge returns null when orchestrator has low success rate", () => {
    // Setup: orchestrator has 40% success on task type
    const nudge = getSelfHandlingNudge(routingStore, "nyx", "code_review", "Review PR");
    expect(nudge).toBeNull();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/processor.test.ts --filter "self-delegation"`
Expected: FAIL

**Step 3: Implement self-delegation check**

In `src/memory/routing.ts`:
```typescript
getAgentSuccessRate(agent: string, taskType: string, sinceDays = 30): number | null {
  const row = this.db.prepare(`
    SELECT
      ROUND(CAST(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 1) as rate
    FROM routing_decisions
    WHERE to_agent = ? AND task_type = ? AND outcome IS NOT NULL
      AND created_at >= datetime('now', '-' || ? || ' days')
    HAVING COUNT(*) >= 2
  `).get(agent, taskType, sinceDays) as { rate: number } | null;
  return row?.rate ?? null;
}
```

In `src/queue/processor.ts` (or a new helper):
```typescript
export function getSelfHandlingNudge(
  routingStore: RoutingStore,
  orchestrator: string,
  taskType: string,
  taskDescription: string,
): string | null {
  // Complexity check: short task, few file references
  if (taskDescription.length > 200) return null;
  const fileRefs = taskDescription.match(/\b[\w/.-]+\.(ts|js|py|swift|md)\b/g) ?? [];
  if (fileRefs.length > 2) return null;

  const rate = routingStore.getAgentSuccessRate(orchestrator, taskType);
  if (rate === null || rate < 80) return null;

  return `Consider handling this directly — you have a ${rate}% success rate on ${taskType} tasks.`;
}
```

Inject the nudge into the system prompt when a delegation mention is detected but before dispatch.

**Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/processor.test.ts --filter "self-delegation"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/queue/processor.ts src/memory/routing.ts src/__tests__/processor.test.ts
git commit -m "feat(delegation): self-delegation check — nudge orchestrator to handle simple tasks directly"
```

---

### Task 14: Integration Test + Full Suite Verification

**Files:**
- Run full test suite
- Fix any regressions

**Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass, 0 failures

**Step 2: Fix any regressions**

Address any failures from schema migrations or changed function signatures.

**Step 3: Commit fixes if any**

```bash
git add -A
git commit -m "fix: address regressions from cognitive upgrade sprint"
```

**Step 4: Final commit — push to remote**

```bash
git push
```

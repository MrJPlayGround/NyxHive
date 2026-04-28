# Core Framework Upgrades Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 4 most impactful framework gaps identified in the cross-instance meeting: smart provider fallbacks for internal callers, data-driven agent routing, cross-instance knowledge federation, and wiring orphaned maintenance systems.

**Architecture:** Each task is independent and touches a separate subsystem. Task 1 adds route-specific fallback to `router.complete()` for internal callers (review gate, summarizer, distiller, etc.) that don't go through the `invoke.ts` fallback chain. Task 2 enriches `routeMessage()` with data-driven agent suggestions from the skill matrix. Task 3 adds a federated knowledge search endpoint and remote query fallback. Task 4 wires `getStale()` and scout analysis into the scheduler via the existing `executeSystemTask` switch/case pattern.

**Tech Stack:** Bun, TypeScript, SQLite, bun:test

---

## File Map

| Task | Files |
|------|-------|
| 1. Smart Provider Fallback | Modify: `src/providers/router.ts` (complete method). Test: `src/__tests__/router.test.ts` |
| 2. Data-Driven Agent Routing | Modify: `src/agents/routing.ts`, `src/queue/processor.ts`. Test: `src/__tests__/routing.test.ts` |
| 3. Knowledge Federation | Modify: `src/memory/knowledge.ts`, `src/server/routes/knowledge.ts`, `src/queue/knowledge-search.ts`. Test: `src/__tests__/knowledge-federation.test.ts` |
| 4. Wire Orphaned Maintenance | Modify: `src/scheduler/index.ts` (executeSystemTask), `src/scheduler/bootstrap.ts`. Test: `src/__tests__/bootstrap.test.ts` |

---

### Task 1: Smart Provider Fallback for Internal Callers

**Context:** The `invoke.ts` layer (lines 386-414) already uses `route.fallback` for full agent invocations. But 6 internal callers use `router.complete()` directly and don't benefit from route-specific fallbacks: `review-gate.ts:266`, `summarize.ts:131`, `extract.ts:35`, `distill.ts:109`, `processor.ts:242` (BTW), `processor.ts:1101` (titling). When their preferred provider fails, they fall to the generic `DEFAULT_FALLBACK_ORDER` with no model preference — getting whatever the fallback provider's default is.

**Files:**
- Modify: `src/providers/router.ts:399-460`
- Test: `src/__tests__/router.test.ts`

- [ ] **Step 1: Write failing test — route-specific fallback is tried before generic chain**

Add to the `complete` describe block in `src/__tests__/router.test.ts`:

```typescript
it("tries route-specific fallback with model before generic chain", async () => {
  const router = makeRouter();
  router.registerProvider("anthropic", failingProvider("primary down", 400));

  let receivedModel = "";
  router.registerProvider("openrouter", {
    name: "openrouter",
    complete: async (params) => {
      receivedModel = params.model ?? "";
      return { content: "fallback-ok", tokensIn: 1, tokensOut: 1, model: params.model ?? "m", provider: "openrouter" };
    },
    listModels: () => [],
  } as any);

  const result = await router.complete(
    baseParams,
    "anthropic",
    "claude-sonnet-4-6",
    { provider: "openrouter", model: "mistralai/mistral-medium-3" },
  );

  expect(result.content).toBe("fallback-ok");
  expect(receivedModel).toBe("mistralai/mistral-medium-3");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/router.test.ts -t "route-specific fallback"`
Expected: FAIL — `complete()` doesn't accept a 4th parameter yet

- [ ] **Step 3: Add route fallback parameter to `complete()`**

In `src/providers/router.ts`, update the `complete()` method signature (line 399):

```typescript
async complete(
  params: CompletionParams,
  preferredProvider?: ProviderName,
  preferredModel?: string,
  routeFallback?: { provider: ProviderName; model: string },
): Promise<ProviderResponse> {
```

Insert between line 429 (after primary failure) and line 431 (before generic fallback chain):

```typescript
    // Route-specific fallback — try the configured fallback provider+model
    if (routeFallback) {
      const rfProvider = this.providers.get(routeFallback.provider);
      const rfCircuit = this.getCircuitState(routeFallback.provider);
      if (rfProvider && rfCircuit.state !== "error") {
        try {
          logger.info(`[router] Route fallback → ${routeFallback.provider}/${routeFallback.model}`);
          const result = await withRetry(() => rfProvider.complete({
            ...params,
            model: routeFallback.model,
          }));
          this.recordSuccess(routeFallback.provider);
          return result;
        } catch (err) {
          logger.warn(`[router] Route fallback ${routeFallback.provider}/${routeFallback.model} failed: ${err}`);
          this.recordFailure(routeFallback.provider);
        }
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/router.test.ts -t "route-specific fallback"`
Expected: PASS

- [ ] **Step 5: Improve "All providers failed" error message**

Update the throw at line ~459 to include context:

```typescript
    const tried: string[] = [];
    // In the fallback loop above, push to tried: tried.push(fallback);
    // Also push routeFallback if attempted
    throw new Error(`All providers failed (tried: ${[providerName, routeFallback?.provider, ...tried].filter(Boolean).join(", ")})`);
```

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: All pass (the new param is optional, no existing callers break)

- [ ] **Step 7: Commit**

```bash
git add src/providers/router.ts src/__tests__/router.test.ts
git commit -m "feat: add route-specific fallback to router.complete() for internal callers"
```

---

### Task 2: Data-Driven Agent Routing

The `RoutingStore` computes a skill matrix and generates suggestions, but `routeMessage()` in `routing.ts` only does name-based `@mention` resolution. When no `@mention` is present, the message always goes to the default agent. We should enrich the `RouteResult` with a `suggestedAgent` field from the skill matrix so the processor can log it or use it for smarter routing.

This is NOT auto-routing (that would bypass the orchestrator). The `suggestedAgent` is advisory.

**Files:**
- Modify: `src/agents/routing.ts`
- Modify: `src/queue/processor.ts` (line ~2046 where routeMessage is called)
- Test: `src/__tests__/routing.test.ts`

- [ ] **Step 1: Write failing test**

Add to `src/__tests__/routing.test.ts`:

```typescript
import type { RoutingSuggestion } from "../memory/routing.js";

it("suggests best agent from routing store when no @mention", () => {
  const mockRoutingStore = {
    getSuggestions: (): RoutingSuggestion[] => [
      { agent: "analyst", task_type: "analysis", success_rate: 95, total_tasks: 10, avg_cost_cents: 5, avg_duration_ms: 3000, composite_score: 92 },
    ],
  };

  const result = routeMessage(
    "analyze the performance of our API endpoints",
    agents,
    {},
    "nyx",
    { routingStore: mockRoutingStore, taskType: "analysis" },
  );

  expect(result.name).toBe("nyx"); // still routes to default
  expect(result.suggestedAgent).toBe("analyst"); // enriched with suggestion
});

it("does not suggest agent below score threshold", () => {
  const mockRoutingStore = {
    getSuggestions: (): RoutingSuggestion[] => [
      { agent: "analyst", task_type: "analysis", success_rate: 40, total_tasks: 3, avg_cost_cents: 5, avg_duration_ms: 3000, composite_score: 45 },
    ],
  };

  const result = routeMessage(
    "analyze something",
    agents,
    {},
    "nyx",
    { routingStore: mockRoutingStore, taskType: "analysis" },
  );

  expect(result.suggestedAgent).toBeUndefined();
});

it("does not add suggestion when @mention is present", () => {
  const mockRoutingStore = {
    getSuggestions: (): RoutingSuggestion[] => [
      { agent: "analyst", task_type: "analysis", success_rate: 95, total_tasks: 10, avg_cost_cents: 5, avg_duration_ms: 3000, composite_score: 92 },
    ],
  };

  const result = routeMessage(
    "@tester run tests",
    agents,
    {},
    "nyx",
    { routingStore: mockRoutingStore, taskType: "coding" },
  );

  // Explicit @mention — no suggestion override
  expect(result.suggestedAgent).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/routing.test.ts -t "suggests best agent"`
Expected: FAIL

- [ ] **Step 3: Update routeMessage in routing.ts**

Export the `RoutingSuggestion` type from `src/memory/routing.ts` if not already exported.

In `src/agents/routing.ts`:

```typescript
import type { AgentConfig, TeamConfig } from "../types.js";
import type { RoutingSuggestion } from "../memory/routing.js";
import { logger } from "../utils/logger.js";

interface RouteResult {
  type: "agent" | "team";
  name: string;
  agent?: AgentConfig;
  team?: TeamConfig;
  strippedMessage: string;
  suggestedAgent?: string;
}

interface RoutingHints {
  routingStore?: { getSuggestions(sinceDays?: number, minTrials?: number): RoutingSuggestion[] };
  taskType?: string;
}

export function routeMessage(
  message: string,
  agents: Record<string, AgentConfig>,
  teams: Record<string, TeamConfig>,
  defaultAgent?: string,
  hints?: RoutingHints,
): RouteResult {
  // Check for @mention at the start of the message
  const mentionMatch = message.match(/^@(\w+)\s*(.*)/s);

  if (mentionMatch) {
    const mention = mentionMatch[1].toLowerCase();
    const strippedMessage = mentionMatch[2].trim() || message;

    // Check teams first
    const teamKey = Object.keys(teams).find((k) => k.toLowerCase() === mention);
    if (teamKey) {
      const team = teams[teamKey];
      logger.debug(`[routing] Routed to team: ${team.name}`);
      return { type: "team", name: teamKey, team, strippedMessage };
    }

    // Check agents
    const agentKey = Object.keys(agents).find((k) => k.toLowerCase() === mention);
    if (agentKey) {
      const agent = agents[agentKey];
      logger.debug(`[routing] Routed to agent: ${agent.name}`);
      return { type: "agent", name: agentKey, agent, strippedMessage };
    }

    // Mention not found — fall through to default
    logger.debug(`[routing] Unknown mention @${mention}, using default`);
  }

  // Default agent
  const agentKey = defaultAgent ?? Object.keys(agents)[0];
  const agent = agents[agentKey];

  if (!agent) {
    throw new Error("No agents configured");
  }

  // Enrich with data-driven suggestion when falling to default (no @mention)
  let suggestedAgent: string | undefined;
  if (hints?.routingStore && hints?.taskType) {
    const suggestions = hints.routingStore.getSuggestions();
    const match = suggestions.find(s => s.task_type === hints.taskType);
    if (match && match.composite_score >= 70 && agents[match.agent]) {
      suggestedAgent = match.agent;
      logger.debug(`[routing] Skill matrix suggests @${match.agent} for ${hints.taskType} (score: ${match.composite_score})`);
    }
  }

  return {
    type: "agent",
    name: agentKey,
    agent,
    strippedMessage: message,
    suggestedAgent,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/routing.test.ts -v`
Expected: PASS

- [ ] **Step 5: Thread hints through processor**

In `src/queue/processor.ts`, find the `routeMessage()` call site (~line 2046). The processor has `this.config.routing` (the routing store) at line ~65. Pass it as a hint. Note: classification may not have happened yet at this point — check the processor flow. If task type isn't known at route time, pass `undefined` and the suggestion won't fire (which is safe — no regression). If classification IS available, thread it.

If the suggestion is populated, log it:
```typescript
if (route.suggestedAgent) {
  logger.info(`[processor] Skill matrix suggests @${route.suggestedAgent} for this message`);
}
```

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/agents/routing.ts src/queue/processor.ts src/__tests__/routing.test.ts
git commit -m "feat: enrich route results with data-driven agent suggestions from skill matrix"
```

---

### Task 3: Knowledge Federation

Each instance has fully isolated knowledge. The `shareable` column exists in `knowledge_chunks` (defaulting to 0) but is never used. We need:
1. A `searchShareable()` method on KnowledgeStore
2. A `/api/knowledge/federated-search` POST endpoint (added to the existing knowledge routes)
3. Remote query fallback in `knowledge-search.ts` when local results are thin

**Files:**
- Modify: `src/memory/knowledge.ts` (add `searchShareable`, `markShareable`)
- Modify: `src/server/routes/knowledge.ts` (add federated-search endpoint)
- Modify: `src/queue/knowledge-search.ts` (add remote fallback)
- Test: `src/__tests__/knowledge-federation.test.ts`

- [ ] **Step 1: Write failing test — searchShareable filters by shareable column**

Create `src/__tests__/knowledge-federation.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";
import { KnowledgeStore } from "../memory/knowledge.js";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("KnowledgeStore federation", () => {
  let store: KnowledgeStore;
  const dims = 4; // tiny embeddings for tests

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "knowledge-fed-"));
    store = new KnowledgeStore(dir, "test", dims);
  });

  function makeEmbedding(seed: number): Float32Array {
    const e = new Float32Array(dims);
    e[0] = seed; e[1] = 1 - seed; e[2] = seed * 0.5; e[3] = 0.5;
    return e;
  }

  it("searchShareable only returns shareable chunks", () => {
    const emb = makeEmbedding(0.9);
    store.upsertChunk("Public Doc", null, "shared knowledge", "docs", "/shared.md", "hash1", emb, "global", 1, undefined, 0);
    store.upsertChunk("Private Doc", null, "internal only", "internal", "/private.md", "hash2", emb, "global", 1, undefined, 0);

    store.markShareable("/shared.md", true);

    const query = makeEmbedding(0.9);
    const results = store.searchShareable(query, 10, 0.1);
    expect(results.length).toBe(1);
    expect(results[0].source_path).toBe("/shared.md");
  });

  it("markShareable updates the shareable flag", () => {
    const emb = makeEmbedding(0.8);
    store.upsertChunk("Doc", null, "content", "docs", "/doc.md", "hash3", emb, "global", 1, undefined, 0);

    const changed = store.markShareable("/doc.md", true);
    expect(changed).toBe(1);

    // Verify it's now searchable as shareable
    const results = store.searchShareable(makeEmbedding(0.8), 10, 0.1);
    expect(results.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/knowledge-federation.test.ts`
Expected: FAIL — `searchShareable` and `markShareable` don't exist

- [ ] **Step 3: Implement searchShareable and markShareable**

In `src/memory/knowledge.ts`, add two methods.

`markShareable` — uses `this.db.prepare().run()` pattern (matching codebase convention):

```typescript
markShareable(sourcePath: string, shareable: boolean): number {
  const result = this.db.prepare(
    "UPDATE knowledge_chunks SET shareable = ? WHERE source_path = ?"
  ).run(shareable ? 1 : 0, sourcePath);
  return result.changes;
}
```

`searchShareable` — reuse the scoring logic. Extract a private `scoreRows()` method from the existing `searchDetailed` to share between both methods. The extraction:

1. Pull lines 248-303 of `searchDetailed` into a private method:
```typescript
private scoreRows(
  searchRows: { rows: SearchableKnowledgeRow[]; strategy: string; scannedCount: number },
  queryEmbedding: Float32Array,
  threshold: number,
  limit: number,
  trackAccess = true,
): KnowledgeSearchResult {
  // ... existing scoring logic from searchDetailed lines 249-303
}
```

2. Have `searchDetailed` call `this.scoreRows(...)` instead of inlining
3. `searchShareable` builds its own query with `AND shareable = 1` and calls `this.scoreRows(..., false)` (no access tracking for remote queries)

```typescript
searchShareable(
  queryEmbedding: Float32Array,
  limit = 5,
  threshold = 0.70,
  category?: string,
  queryText?: string,
): KnowledgeChunk[] {
  const { filterSql, params } = this.buildFilters(undefined, category);
  const shareableFilter = filterSql
    ? `${filterSql} AND shareable = 1`
    : "WHERE shareable = 1";
  const searchRows = this.selectSearchRows(queryText, shareableFilter, params, limit);
  return this.scoreRows(searchRows, queryEmbedding, threshold, limit, false).results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/knowledge-federation.test.ts`
Expected: PASS

- [ ] **Step 5: Add federated-search endpoint to existing knowledge routes**

In `src/server/routes/knowledge.ts`, add a new POST endpoint. Follow the existing pattern (function takes `store`, `embedder`, `config` as params):

```typescript
// POST /api/knowledge/federated-search — for remote instances to query shareable knowledge
app.post("/federated-search", async (c) => {
  if (!embedder) {
    return c.json({ error: "embeddings provider not configured" }, 503);
  }

  const body = await c.req.json().catch(() => null);
  if (!body?.query || typeof body.query !== "string") {
    return c.json({ error: "query is required" }, 400);
  }

  const limit = clampInt(body.limit, 5, 1, 20);
  const embedding = await embedder.embed(body.query);
  const results = store.searchShareable(embedding, limit, 0.5, body.category, body.query);
  return c.json({
    results,
    instance: config?.daemon?.name ?? "unknown",
  });
});
```

- [ ] **Step 6: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 7: Add remote knowledge fallback to knowledge-search.ts**

In `src/queue/knowledge-search.ts`, after local search, if results are thin (`results.length < 2`) and the config has remotes, query each remote's `/api/knowledge/federated-search`:

```typescript
async function queryRemoteKnowledge(
  query: string,
  remotes: Record<string, { url: string; api_key_env: string }>,
): Promise<KnowledgeChunk[]> {
  const results: KnowledgeChunk[] = [];

  for (const [name, remote] of Object.entries(remotes)) {
    const apiKey = process.env[remote.api_key_env];
    if (!apiKey) continue;

    try {
      const res = await fetch(`${remote.url}/api/knowledge/federated-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, limit: 3 }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const data = await res.json() as { results: KnowledgeChunk[]; instance: string };
      // Tag results with source instance
      for (const chunk of data.results) {
        chunk.source_path = `[${data.instance}] ${chunk.source_path}`;
        results.push(chunk);
      }
    } catch {
      // Silent — remote unavailable is not an error
    }
  }

  return results;
}
```

The caller needs access to the config's remotes. Thread it via the deps object that `knowledge-search.ts` already receives.

- [ ] **Step 8: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 9: Type check**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 10: Commit**

```bash
git add src/memory/knowledge.ts src/server/routes/knowledge.ts src/queue/knowledge-search.ts src/__tests__/knowledge-federation.test.ts
git commit -m "feat: cross-instance knowledge federation with shareable chunks and remote search"
```

---

### Task 4: Wire Orphaned Maintenance Systems

Two systems are built but never invoked at runtime:
1. `RoutingStore.getStale()` — finds unresolved routing decisions (>N minutes old), never called
2. `generateScoutReport()` in `src/learning/analysis.ts` — scout effectiveness reporting, never called

Note: `RoutingStore.prune()` is already wired in `memory:maintenance` (scheduler/index.ts:681). No need to duplicate it.

The scheduler uses a `switch/case` pattern in `executeSystemTask()` (scheduler/index.ts:642-813). New system tasks need a case in that switch and a task registration in bootstrap.

**Files:**
- Modify: `src/scheduler/index.ts` (add cases to `executeSystemTask`)
- Modify: `src/scheduler/bootstrap.ts` (register new tasks + update `DEFAULT_SYSTEM_TASK_NAMES`)
- Test: `src/__tests__/bootstrap.test.ts`

- [ ] **Step 1: Add `routing:cleanup-stale` case to executeSystemTask**

In `src/scheduler/index.ts`, add a new case in the `executeSystemTask` switch (after the `memory:maintenance` case around line 686):

```typescript
case "routing:cleanup-stale": {
  const routing = this.processor.getRouting();
  if (!routing) return "Routing store not configured";

  const stale = routing.getStale(120); // unresolved for >2 hours
  let resolved = 0;
  for (const decision of stale) {
    routing.resolveDecision(decision.id, "abandoned");
    resolved++;
  }

  return resolved > 0
    ? `Resolved ${resolved} stale routing decisions as abandoned`
    : "ok";
}
```

Note: `resolveDecision` takes a numeric `id` (line 120 of routing.ts), NOT `trace_id`.

- [ ] **Step 2: Add `learning:scout-effectiveness` case to executeSystemTask**

```typescript
case "learning:scout-effectiveness": {
  const proposalStore = this._proposalStore;
  if (!proposalStore) return "Proposal store not configured";

  const { generateScoutReport, persistScoutReport } = await import("../learning/analysis.js");
  const knowledge = this.processor.getKnowledge();
  const config = this.processor.getConfig();
  const report = generateScoutReport(proposalStore);
  if (report) {
    await persistScoutReport(report, knowledge, config?.vault?.path);
  }
  return report
    ? `Scout report: ${report.totalProposals} proposals analyzed`
    : "No proposal data for reporting";
}
```

Verify the actual signatures of `generateScoutReport` and `persistScoutReport` in `src/learning/analysis.ts` before implementing — adapt the call to match.

- [ ] **Step 3: Register tasks in bootstrap.ts**

In `src/scheduler/bootstrap.ts`, add the two new tasks to the default task list. Follow the existing SQL INSERT pattern used by other system tasks:

```typescript
// After the existing maintenance tasks:
upsertTask({
  name: "routing:cleanup-stale",
  cron: "0 */6 * * *",
  agent: "system",
  category: "maintenance",
  prompt: "",
});

upsertTask({
  name: "learning:scout-effectiveness",
  cron: "0 10 * * 1", // Monday 10am
  agent: "system",
  category: "learning",
  prompt: "",
});
```

- [ ] **Step 4: Update DEFAULT_SYSTEM_TASK_NAMES**

Add `"routing:cleanup-stale"` and `"learning:scout-effectiveness"` to the `DEFAULT_SYSTEM_TASK_NAMES` array (line ~32-48 of bootstrap.ts) so they get cleaned up properly when `seed_defaults` is disabled.

- [ ] **Step 5: Run tests**

Run: `bun test src/__tests__/bootstrap.test.ts -v`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 7: Type check**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 8: Commit**

```bash
git add src/scheduler/index.ts src/scheduler/bootstrap.ts
git commit -m "feat: wire stale routing cleanup and scout effectiveness reports to scheduler"
```

---

## Final Verification

- [ ] **Run full test suite**: `bun test`
- [ ] **Type check**: `bunx tsc --noEmit`
- [ ] **Verify no regressions in provider routing**: `bun test src/__tests__/router.test.ts -v`
- [ ] **Verify no regressions in agent routing**: `bun test src/__tests__/routing.test.ts -v`

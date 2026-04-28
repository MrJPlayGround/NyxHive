# Plan: Adopt Best Ideas from OpenClaw

**Date:** 2026-03-03
**Status:** Draft
**Priority:** High

---

## Context

OpenClaw is a personal AI assistant gateway (175K stars, MIT). Different problem than NyxHive, but has systems worth adopting: true heartbeat awareness, hybrid memory search, self-extending skills, and outcome-to-pattern learning loops.

### Current State vs OpenClaw

| System | NyxHive today | OpenClaw | Gap |
|--------|--------------|----------|-----|
| Heartbeat | Isolated cheap agent on 15-min cron, checks system health | Main-session awareness with user-defined checklist, HEARTBEAT_OK suppression | NyxHive has no contextual awareness loop |
| Memory search | Brute-force cosine similarity over all embeddings (`knowledge.ts:167`) | Hybrid BM25 + vector + MMR reranking + temporal decay | No keyword search, no diversity, step-function decay |
| Skills | Static soul files edited by humans | Agents write their own SKILL.md, self-modifying | No runtime capability acquisition |
| Learning loop | `PatternStore` + `OutcomeStore` exist but aren't wired up | N/A (no equivalent) | Infrastructure exists, zero data flowing through it |

---

## Story 1: True Heartbeat System (3-Tier Architecture)

### Problem

Current "heartbeat" (`loadDefaultHeartbeat()` in `scheduler/index.ts:582`) is an isolated agent on a cron. It checks queue/cost/failures but has no conversational context, no user-defined checklist, and always produces output (no suppression).

OpenClaw's heartbeat runs in the main session with full history, follows HEARTBEAT.md, and suppresses with HEARTBEAT_OK when nothing needs attention.

We can't run Nyx (Opus) every 30 min -- too expensive. Solution: 3-tier architecture where code handles most checks, a cheap OpenRouter model triages triggers, and Nyx only gets involved for genuine orchestration needs.

### Design

#### Tier 1: Code-Level Checks (zero LLM cost)

A pure-code function runs every 15 min in the scheduler tick. Queries SQLite directly:

| Check | Query source | Threshold |
|-------|-------------|-----------|
| `queue_depth` | Queue DB: pending messages count | > 5 |
| `messages_waiting` | Queue DB: oldest pending message age | > 30 min |
| `proposals_stuck` | Proposals DB: status=reviewing, updated_at older than threshold | > 60 min |
| `delegations_active` | Coordination store: active claims by age | > configured timeout |
| `failed_tasks` | Scheduler DB: tasks with consecutive_failures > 0 since last heartbeat | > 0 |
| `cost_24h` | Trace events: sum cost last 24h | > configurable budget (default $5) |
| `completed_no_pr` | Proposals DB: status=completed, no pr_url | > 0 |
| `overnight_errors` | Scheduler DB: failed tasks in last 12h (morning only) | > 0 |

If ALL checks pass -> log debug `HEARTBEAT_OK`, no model call. If ANY trigger -> escalate to Tier 2 with triggered check results.

#### Tier 2: Cheap Model Triage (OpenRouter, ~$0.01/call)

Only fires when Tier 1 flags something. Uses provider router's existing T1 tier:

- **Model:** `google/gemini-2.0-flash-lite-001` via OpenRouter (already used for current health-check, already in `router.ts:338`)
- **Never Anthropic.** All heartbeat model calls go through OpenRouter to avoid rate limit / policy issues.
- **Input:** Triggered check results (structured JSON) + last 5 messages from main thread (for context) + current active work items
- **Prompt:** Focused triage -- "Here are triggered system checks. Decide: is this worth alerting the user? If yes, write a 1-3 sentence alert. If this needs orchestrator judgment (conflicting priorities, delegation needed), respond with ESCALATE. If not worth alerting, respond HEARTBEAT_OK."
- **Output parsing:**
  - `HEARTBEAT_OK` -> suppress, log info
  - `ESCALATE` -> escalate to Tier 3
  - Anything else -> deliver as alert to configured channel

#### Tier 3: Nyx Escalation (Opus, rare)

Only when Tier 2 returns `ESCALATE`. Routes through Nyx in the main conversation session via the queue processor. Nyx has full context and can delegate (`[@forge: ...]`). Expected frequency: 0-2x/day, most days 0.

#### HEARTBEAT.md

Lives at `~/.nyxhive/instances/{name}/HEARTBEAT.md`. Dual-purpose format:

```markdown
# Heartbeat Checklist

## Every Check
- [queue_depth > 5] Messages piling up in queue?
- [proposals_stuck reviewing > 60m] Proposals stuck in review?
- [delegations_active > 20m] Delegations running too long?
- [failed_tasks_since_last > 0] Any task failures?

## Morning (08:00-10:00 Europe/Lisbon)
- [pending_proposals approved > 0] Approved proposals waiting?
- [overnight_errors > 0] Overnight failures?
> Compile overnight summary

## Work Hours (10:00-19:00)
- [cost_24h > 5.00] Daily cost exceeding budget?
- [completed_proposals_no_pr > 0] Completed work missing PRs?

## Evening (19:00-22:00)
> Summarize day's activity
```

**Parser rules:**
- `[condition]` brackets = Tier 1 code check. Parsed into structured check configs at load time.
- Lines without brackets = human-readable context passed to Tier 2 prompt.
- `## Section (HH:MM-HH:MM timezone)` = active hours for that section. Parser extracts time windows.
- `> blockquote` lines = Tier 2 instructions (what to do when section triggers).
- File missing or empty = skip heartbeat entirely (no model call).

#### Config

Add to `config-schema.ts` and `types.ts`:

```typescript
// types.ts
interface HeartbeatConfig {
  enabled: boolean;              // default true
  interval_ms: number;           // default 900_000 (15 min)
  active_hours?: {
    start: string;               // "08:00"
    end: string;                 // "22:00"
    timezone: string;            // "Europe/Lisbon"
  };
  alert_target: "none" | "last" | string;  // channel name, default "none"
  alert_recipient?: string;      // channel-specific recipient
  ack_max_chars: number;         // default 300
  model?: string;                // Tier 2 override, default T1 from router
  provider?: string;             // default "openrouter"
}
```

#### Cost Estimate

- Tier 1: $0/day (pure code, 96 checks/day)
- Tier 2: $0.01-0.10/day (Flash Lite via OpenRouter, 5-15 calls/day)
- Tier 3: $0-1.00/day (Opus via Anthropic, 0-2 calls/day, most days 0)
- **Total: ~$0.01-1.10/day**

### Implementation Steps

#### Step 1: Create `src/scheduler/heartbeat.ts`

New module with:

```typescript
// Types
interface HeartbeatCheck {
  name: string;           // e.g. "queue_depth"
  operator: ">" | "<" | ">=" | "<=" | "==" | "!=";
  threshold: number;
  unit?: string;          // "m" for minutes
  section?: string;       // time-gated section name
}

interface HeartbeatSection {
  name: string;
  timeWindow?: { start: string; end: string; timezone: string };
  checks: HeartbeatCheck[];
  context: string[];      // non-bracket lines for Tier 2
  instructions: string[]; // blockquote lines for Tier 2
}

interface HeartbeatResult {
  triggered: TriggeredCheck[];
  allPassed: boolean;
}

interface TriggeredCheck {
  check: HeartbeatCheck;
  actual: number;
  message: string;
}

// Functions
parseHeartbeatMd(content: string): HeartbeatSection[]
isEffectivelyEmpty(content: string): boolean
evaluateTier1(sections: HeartbeatSection[], deps: Tier1Deps): HeartbeatResult
buildTier2Prompt(result: HeartbeatResult, recentMessages: Message[], activeWork: WorkClaim[]): string
parseTier2Response(response: string, ackMaxChars: number): "ok" | "escalate" | { alert: string }
```

**`evaluateTier1` deps** -- needs access to:
- Queue DB (pending count, oldest message age)
- Proposals DB (stuck reviewing, completed without PR, approved pending)
- Scheduler DB (failed tasks since last check)
- Trace events (cost last 24h)
- Coordination store (active claims)

These are already available via the scheduler's existing deps (`this.db` for scheduler, `this.processor` gives access to queue/proposals).

#### Step 2: Wire into scheduler tick (`scheduler/index.ts`)

In the `tick()` method (around line 133), add heartbeat evaluation alongside existing proposal maintenance:

```
tick() {
  // Existing: proposal maintenance (lines 144-186)
  // NEW: heartbeat evaluation
  if (heartbeatEnabled && shouldRunHeartbeat(lastHeartbeatAt, intervalMs)) {
    const sections = this.heartbeatSections; // parsed once at load
    const activeSections = filterByActiveHours(sections, config.active_hours);
    const result = evaluateTier1(activeSections, deps);

    if (result.allPassed) {
      logger.debug("heartbeat: HEARTBEAT_OK");
    } else {
      await this.runTier2Triage(result);
    }
    lastHeartbeatAt = Date.now();
  }
  // Existing: iterate scheduled tasks (lines 187+)
}
```

#### Step 3: Tier 2 model call

Use `ProviderRouter.complete()` (router.ts:356) with explicit OpenRouter provider + T1 model:

```typescript
async runTier2Triage(result: HeartbeatResult) {
  const recentMessages = await this.getRecentMainThreadMessages(5);
  const activeWork = await this.coordination?.getActiveClaims();
  const prompt = buildTier2Prompt(result, recentMessages, activeWork);

  const response = await this.router.complete(
    { messages: [{ role: "user", content: prompt }], maxTokens: 500 },
    "openrouter",  // force OpenRouter
    "google/gemini-2.0-flash-lite-001"  // force cheap model
  );

  const parsed = parseTier2Response(response.text, config.ack_max_chars);

  if (parsed === "ok") {
    logger.info("heartbeat: Tier 2 suppressed (HEARTBEAT_OK)");
  } else if (parsed === "escalate") {
    await this.escalateToNyx(result);
  } else {
    await this.deliverAlert(parsed.alert);
  }
}
```

#### Step 4: Tier 3 Nyx escalation

Route through `QueueProcessor.queueMessage()` with a heartbeat-flagged message to the orchestrator's main thread:

```typescript
async escalateToNyx(result: HeartbeatResult) {
  const summary = formatTriggeredChecks(result.triggered);
  await this.processor.queueMessage({
    channel: "system",
    sender: "heartbeat",
    content: `[HEARTBEAT ESCALATION] The following system checks triggered and need your judgment:\n\n${summary}`,
    agent: this.config.agents.orchestrator || "nyx",
    // Use main thread, not isolated session
  });
}
```

#### Step 5: Alert delivery

For channel delivery, reuse existing channel infrastructure. Add a `deliverAlert()` method that routes to the configured target channel:

```typescript
async deliverAlert(alert: string) {
  const target = this.config.heartbeat?.alert_target || "none";
  if (target === "none") return;

  // Route through processor's channel delivery
  // Similar to how scheduled task results are delivered (scheduler/index.ts:431-447)
}
```

#### Step 6: HEARTBEAT.md loading

Load and parse at scheduler startup. Watch for changes with `fs.watchFile` (debounced, similar to `memory/watcher.ts`).

#### Step 7: Remove/rename old heartbeat

- Remove `loadDefaultHeartbeat()` (scheduler/index.ts:582-648) and its two auto-created tasks (`heartbeat:daily-review`, `heartbeat:health-check`)
- Fold the `gatherHeartbeatContext()` pre-fetch logic (scheduler/index.ts:194-279) into Tier 1 checks where applicable
- Remove archived `souls/_archived/heartbeat.yaml`

#### Step 8: Config schema

Add `heartbeat` section to `configSchema` in `config-schema.ts`:

```typescript
heartbeat: z.object({
  enabled: z.boolean().default(true),
  interval_ms: z.number().default(900_000),
  active_hours: z.object({
    start: z.string().default("08:00"),
    end: z.string().default("22:00"),
    timezone: z.string().default("Europe/Lisbon"),
  }).optional(),
  alert_target: z.string().default("none"),
  alert_recipient: z.string().optional(),
  ack_max_chars: z.number().default(300),
  model: z.string().optional(),
  provider: z.string().default("openrouter"),
}).optional(),
```

#### Step 9: MCP tool

Add `update_heartbeat` tool to `mcp/server.ts` so Nyx can suggest new checklist items based on conversation context:

```typescript
server.registerTool("update_heartbeat", {
  description: "Add or update a heartbeat checklist item",
  inputSchema: z.object({
    section: z.string().describe("Section name (e.g. 'Every Check', 'Morning')"),
    check: z.string().describe("Check line in bracket format, e.g. '[queue_depth > 10] Queue getting big?'"),
    action: z.enum(["add", "remove"]).default("add"),
  }),
}, async (params) => {
  // Read HEARTBEAT.md, parse, add/remove check, write back, reload sections
});
```

### Files Changed

| File | Change |
|------|--------|
| New: `src/scheduler/heartbeat.ts` | Parser, Tier 1 evaluator, Tier 2/3 routing, types |
| `src/scheduler/index.ts` | Wire heartbeat into tick, remove old heartbeat agent, Tier 2/3 calls |
| `src/config-schema.ts` | Add heartbeat config section |
| `src/types.ts` | Add HeartbeatConfig type |
| `src/mcp/server.ts` | Add update_heartbeat tool |
| `souls/nyx/rules.md` | Add heartbeat escalation instructions |
| Delete: `souls/_archived/heartbeat.yaml` | No longer needed |
| New: `~/.nyxhive/instances/NyxAI/HEARTBEAT.md` | Default checklist |

### Tests

- `src/__tests__/heartbeat.test.ts`:
  - `parseHeartbeatMd()` -- bracket extraction, time window parsing, empty detection
  - `evaluateTier1()` -- all-pass, single trigger, multiple triggers, time-gated sections
  - `parseTier2Response()` -- HEARTBEAT_OK, ESCALATE, alert text, ack_max_chars threshold
  - `isEffectivelyEmpty()` -- empty, whitespace-only, headers-only, has content

---

## Story 2: Outcome-to-Pattern Distillation (Close the Learning Loop)

### Problem

`PatternStore` (`memory/patterns.ts`) and `OutcomeStore` (`memory/outcomes.ts`) are fully implemented. `DelegationEngine.getPatternContext()` (`delegation.ts:1032-1047`) already queries patterns and injects them into delegation envelopes. But there's no process feeding data into `PatternStore` -- the stores are empty.

The learning loop is: outcomes recorded -> patterns distilled -> patterns injected into future delegations. Steps 1 and 3 are wired. Step 2 is missing.

### What exists

- `OutcomeStore.record()` (outcomes.ts:71) -- records proposal execution results
- `OutcomeStore.query()` (outcomes.ts:133) -- flexible querying with agent/outcome/date filters
- `OutcomeStore.getAgentStats()` (outcomes.ts:157) -- aggregate success rate, avg cost, avg duration
- `PatternStore.record()` (patterns.ts:60) -- writes a pattern
- `PatternStore.searchRelevant()` (patterns.ts:98) -- searches by agent, taskType, filePaths
- `PatternStore.formatForInjection()` (patterns.ts:141) -- renders "## Lessons Learned" markdown, ~500 token cap
- `PatternStore.parsePatternResponse()` (patterns.ts:202) -- parses LLM JSON pattern output
- `DelegationEngine.getPatternContext()` (delegation.ts:1032) -- calls searchRelevant + formatForInjection, passes to buildDelegationEnvelope

### What to build

#### Step 1: Verify outcome recording is happening

Check if `OutcomeStore.record()` is being called after proposal executions. The call should be in the proposal execution flow (`scheduler/index.ts` `executeSystemTask` for `dev:execute-approved`, or in `queue/delegation.ts` after delegation completes).

If not called, add it at the end of proposal execution (after review gate) with data from the execution trace.

#### Step 2: Create distillation task

Add system-created scheduled task `learning:distill-patterns`:
- **Schedule:** `0 4 * * 0` (Sunday 4am weekly)
- **Type:** `system` (server-side, no agent invocation)
- **Logic:**

```typescript
async executeDistillation() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const outcomes = this.outcomes.query({ since });

  if (outcomes.length === 0) return;

  // Group by agent
  const byAgent = groupBy(outcomes, o => o.agent);

  for (const [agent, agentOutcomes] of Object.entries(byAgent)) {
    if (agentOutcomes.length < 2) continue; // need multiple data points

    const prompt = buildDistillationPrompt(agent, agentOutcomes);

    // Use cheap model via OpenRouter
    const response = await this.router.complete(
      { messages: [{ role: "user", content: prompt }], maxTokens: 1000 },
      "openrouter",
      "google/gemini-2.0-flash-001"  // slightly smarter than Lite for analysis
    );

    const patterns = PatternStore.parsePatternResponse(response.text);
    for (const p of patterns) {
      this.patterns.record({
        agent,
        pattern: p.pattern,
        confidence: p.confidence,
        recommendation: p.recommendation,
        category: p.category,
      });
    }
  }

  // Prune old patterns
  this.patterns.pruneExpired();
}
```

#### Step 3: Distillation prompt

```
You are analyzing execution outcomes for agent "{agent}" over the last 7 days.

Outcomes:
{formatted outcomes: task_type, outcome, review_verdict, cost, duration, failure_reason, files_changed}

Extract patterns as JSON array. Each pattern:
- pattern: what you observed (1 sentence)
- confidence: 0.0-1.0 based on evidence strength
- recommendation: what to do differently (1 sentence)
- category: one of [code_quality, performance, testing, review, cost, reliability]

Only include patterns with >= 0.6 confidence. Max 5 patterns.
Return [] if no clear patterns.
```

#### Step 4: Verify injection is working

`DelegationEngine.getPatternContext()` (delegation.ts:1032) already exists. Verify it's called in `executeDelegationTurn()`. According to the code, it's called at lines 507 and 697. Verify the `patterns` field is passed in `DelegationContext` (delegation.ts:55).

#### Step 5: Wire feedback to confidence

In `FeedbackStore.addFeedback()` (feedback.ts:70), when a chunk is flagged (net negative >= 3), also reduce confidence of related patterns:

```typescript
// After existing flag logic (feedback.ts:96)
if (netScore <= -FLAG_THRESHOLD) {
  // Existing: flag chunk
  // NEW: reduce confidence of patterns that reference this knowledge
  // This is a soft signal -- patterns aren't deleted, just weakened
}
```

### Files Changed

| File | Change |
|------|--------|
| `src/scheduler/index.ts` | Add `learning:distill-patterns` system task, `executeDistillation()` method |
| `src/memory/patterns.ts` | Verify `parsePatternResponse` handles edge cases |
| `src/memory/outcomes.ts` | Verify `record()` is called in execution flow |
| `src/memory/feedback.ts` | Wire flag threshold to pattern confidence reduction |

### Tests

- `src/__tests__/distillation.test.ts`:
  - Distillation prompt construction from outcomes
  - Pattern parsing from LLM response
  - Empty outcomes -> no patterns
  - Pruning after distillation
  - Feedback -> confidence reduction

---

## Story 3: Hybrid Memory Search (BM25 + Vector + MMR)

### Problem

`KnowledgeStore.search()` (knowledge.ts:167) loads ALL rows into memory and computes cosine similarity in JS. No keyword search component. Recency is a step function (1.0/<7d, 0.8/7-30d, 0.5/30-90d, 0.2/>90d). No diversity in results -- can return 5 chunks from the same document.

### What to build

#### Step 1: Add FTS5 virtual table for knowledge_chunks

In `KnowledgeStore` constructor, after existing schema setup:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts
USING fts5(title, section, content, content=knowledge_chunks, content_rowid=id);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
  INSERT INTO knowledge_chunks_fts(rowid, title, section, content) VALUES (new.id, new.title, new.section, new.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
  INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts, rowid, title, section, content) VALUES ('delete', old.id, old.title, old.section, old.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_au AFTER UPDATE ON knowledge_chunks BEGIN
  INSERT INTO knowledge_chunks_fts(knowledge_chunks_fts, rowid, title, section, content) VALUES ('delete', old.id, old.title, old.section, old.content);
  INSERT INTO knowledge_chunks_fts(rowid, title, section, content) VALUES (new.id, new.title, new.section, new.content);
END;
```

One-time backfill for existing data:

```sql
INSERT INTO knowledge_chunks_fts(rowid, title, section, content)
SELECT id, title, section, content FROM knowledge_chunks;
```

#### Step 2: Hybrid search function

Replace current `search()` (knowledge.ts:167-230) with hybrid approach:

```typescript
async search(queryEmbedding: Float32Array, limit: number, threshold: number, queryText?: string): Promise<KnowledgeChunk[]> {
  // 1. Vector search: get top 20 candidates by cosine similarity (existing logic)
  const vectorCandidates = this.vectorSearch(queryEmbedding, 20, threshold * 0.8);

  // 2. BM25 search: get top 20 candidates by keyword match (if queryText provided)
  let bm25Candidates: Map<number, number> = new Map();
  if (queryText) {
    const ftsResults = this.db.prepare(`
      SELECT rowid, rank FROM knowledge_chunks_fts
      WHERE knowledge_chunks_fts MATCH ?
      ORDER BY rank LIMIT 20
    `).all(queryText);
    for (const r of ftsResults) {
      // Normalize BM25 rank to 0-1 (rank is negative, closer to 0 = better)
      bm25Candidates.set(r.rowid, Math.min(1, Math.abs(r.rank) / 10));
    }
  }

  // 3. Merge: hybrid score = 0.7 * vector + 0.3 * bm25
  const VECTOR_WEIGHT = 0.7;
  const BM25_WEIGHT = 0.3;

  for (const candidate of vectorCandidates) {
    const bm25Score = bm25Candidates.get(candidate.id) || 0;
    candidate.similarity = (VECTOR_WEIGHT * candidate.similarity) + (BM25_WEIGHT * bm25Score);
  }

  // Also include BM25-only hits not in vector results (keyword matches that are semantically distant)
  // ... add with vector score 0, bm25 score weighted

  // 4. Apply boosts (existing: priority, access count, recency, confidence)
  // Replace step-function recency with smooth exponential decay:
  // recencyFactor = Math.pow(0.5, ageDays / 30)
  // Exempt priority >= 3 from decay (evergreen)

  // 5. MMR reranking for diversity
  const reranked = mmrRerank(candidates, limit, 0.7);

  return reranked;
}
```

#### Step 3: MMR reranking

```typescript
function mmrRerank(candidates: ScoredChunk[], limit: number, lambda: number): ScoredChunk[] {
  const selected: ScoredChunk[] = [];
  const remaining = [...candidates];

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].similarity;

      // Max similarity to any already-selected chunk (diversity penalty)
      let maxSimilarity = 0;
      for (const s of selected) {
        const sim = jaccardSimilarity(remaining[i].content, s.content);
        maxSimilarity = Math.max(maxSimilarity, sim);
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining.splice(bestIdx, 1)[0]);
  }

  return selected;
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}
```

#### Step 4: Smooth temporal decay

Replace step function (knowledge.ts:~200) with:

```typescript
// Old:
// const recencyFactor = ageDays < 7 ? 1.0 : ageDays < 30 ? 0.8 : ageDays < 90 ? 0.5 : 0.2;

// New:
const recencyFactor = priority >= 3
  ? 1.0  // evergreen: no decay
  : Math.pow(0.5, ageDays / 30);  // half-life 30 days
```

#### Step 5: Chunk overlap in ingestion

In `ingest.ts`, when splitting by `##` headings, add overlap:

```typescript
// After splitting sections (ingest.ts:~80)
const OVERLAP_CHARS = 300; // ~80 tokens

for (let i = 1; i < sections.length; i++) {
  const prevContent = sections[i - 1].content;
  if (prevContent.length > OVERLAP_CHARS) {
    const overlap = prevContent.slice(-OVERLAP_CHARS);
    sections[i].content = `[...] ${overlap}\n\n${sections[i].content}`;
  }
}
```

#### Step 6: Update `search_knowledge` MCP tool

Pass `queryText` to the new hybrid search (mcp/server.ts:197):

```typescript
// Currently:
const results = await deps.knowledge.search(embedding, limit, 0.5);

// Updated:
const results = await deps.knowledge.search(embedding, limit, 0.5, query);
```

### Files Changed

| File | Change |
|------|--------|
| `src/memory/knowledge.ts` | FTS5 setup, hybrid search, MMR, smooth decay |
| `src/memory/ingest.ts` | Chunk overlap |
| `src/mcp/server.ts` | Pass queryText to search |

### Tests

- `src/__tests__/knowledge-search.test.ts`:
  - FTS5 index creation and sync triggers
  - Hybrid scoring: vector-only, BM25-only, combined
  - MMR reranking: diversity vs no diversity
  - Temporal decay: smooth vs step function comparison
  - Chunk overlap in ingestion
  - Edge cases: empty query, no matches, single result

---

## Story 4: Self-Extending Skills / Dynamic Capabilities

### Problem

Agents can't modify their own capabilities at runtime. Souls are static Markdown files edited by humans. OpenClaw agents write their own SKILL.md files that load into the system prompt next session.

### Design

#### Skills directory

`~/.nyxhive/instances/{name}/skills/{agent_id}/` -- one directory per agent, one `.md` file per skill.

#### Skill format

```markdown
---
name: pr-review-checklist
description: Structured checklist for reviewing PRs
created_at: 2026-03-03T10:00:00Z
invocations: 0
last_used: null
---

When reviewing a PR, always check:
1. Are there tests for new functionality?
2. Does the diff touch security-sensitive paths?
3. Are there TODO comments that should be tracked?
```

#### MCP tools

Three new tools in `mcp/server.ts`:

**`create_skill`:**
```typescript
inputSchema: z.object({
  name: z.string().max(50).describe("Skill name (kebab-case)"),
  description: z.string().max(200),
  content: z.string().max(2000).describe("Skill instructions in Markdown"),
})
```
- Writes `{agent_id}/{name}.md` with YAML frontmatter
- Agent ID from calling context (MCP session agent)
- Validate: no duplicate names, cap at 20 skills per agent
- Sanitize: strip anything that looks like prompt injection (e.g., "ignore previous instructions")

**`update_skill`:**
```typescript
inputSchema: z.object({
  name: z.string(),
  content: z.string().max(2000).optional(),
  description: z.string().max(200).optional(),
})
```
- Updates content and/or description, preserves metadata
- Increments `invocations` if only recording usage

**`list_skills`:**
```typescript
inputSchema: z.object({
  agent: z.string().optional().describe("Agent ID, defaults to calling agent"),
})
```
- Returns list of skills for the agent with metadata

#### Soul compiler integration

In `compiler-v2.ts`, after existing soul compilation (`compileSoulV2`, line 276):

```typescript
// Load skills for this agent
const skillsDir = join(instanceDataDir, "skills", agentId);
const skills = loadAgentSkills(skillsDir, { maxTokens: 500, maxCount: 20 });

if (skills.length > 0) {
  // Append to composed soul
  composedSoul.system_prompt += "\n\n## Learned Skills\n\n";
  composedSoul.system_prompt += skills
    .sort((a, b) => b.invocations - a.invocations) // most-used first
    .map(s => `### ${s.name}\n${s.content}`)
    .join("\n\n");
}
```

Token budget: 500 tokens total for skills section. When exceeding budget, include most-used skills first, truncate rest.

#### Safety

- Skills are Markdown instructions only -- cannot register new tools, modify MCP, or change soul files
- Content sanitized: reject skills containing patterns like "ignore previous", "system:", "you are now"
- Admin API endpoint to list/delete skills: `GET /api/skills/:agent`, `DELETE /api/skills/:agent/:name`
- Skills capped at 20 per agent
- Individual skill max 2000 chars

#### What NOT to build

- No skill marketplace or registry. Private system, not a platform.
- No auto-skill detection from conversation. Start with explicit `create_skill` MCP calls.
- No cross-agent skill sharing. Each agent's skills are isolated.

### Files Changed

| File | Change |
|------|--------|
| New: `src/skills/store.ts` | CRUD operations, sanitization, token budgeting |
| `src/soul/compiler-v2.ts` | Load and inject skills into compiled soul |
| `src/soul/loader-v2.ts` | Pass instance data dir for skill loading |
| `src/mcp/server.ts` | Add 3 new tools (create_skill, update_skill, list_skills) |
| `src/config-schema.ts` | Add skills config (max_count, max_tokens) |
| `src/server/routes/` | Admin endpoint for skill management |

### Tests

- `src/__tests__/skills.test.ts`:
  - CRUD: create, read, update, delete
  - Cap enforcement (max 20)
  - Content sanitization (reject injection patterns)
  - Token budget (most-used first, truncation)
  - Soul compiler integration (skills appear in prompt)
  - MCP tool integration

---

## Priority Order

| # | Story | Effort | Impact | Rationale |
|---|-------|--------|--------|-----------|
| 1 | Outcome-to-Pattern Distillation | Small | High | Infrastructure exists (`PatternStore`, `OutcomeStore`, `getPatternContext()`). Just needs a weekly cron + verify wiring. Closes the learning loop for free. |
| 2 | True Heartbeat | Medium | High | Replaces the misnamed health-check with real periodic awareness. 3-tier design keeps costs near zero. |
| 3 | Hybrid Memory Search | Medium | Medium | Better retrieval = better agent decisions. FTS5 already used elsewhere in codebase. Focused refactor of one file. |
| 4 | Self-Extending Skills | Medium | Medium | Compound learning over time. But needs careful safety design and soul compiler changes. |

## Execution Notes

- Stories 1 and 2 are independent -- can be worked in parallel
- Story 3 is a focused refactor of `knowledge.ts` + `ingest.ts` -- single PR
- Story 4 depends on nothing but needs design review before implementation (safety, token budgets)
- All stories should have tests before shipping
- Stories 1 and 3 are lowest risk (touching existing stores / pure functions). Story 2 touches the scheduler tick loop. Story 4 touches the soul compiler.

## NOT Adopting

| Feature | Why not |
|---------|---------|
| Canvas / A2UI | Dev orchestrator, not personal assistant. Cool but a distraction. |
| 50+ channels | User uses Discord, Telegram, iOS. Adding WhatsApp/Signal/Matrix is low value. |
| Pi's "4 tools only" | NyxHive's 27 MCP tools give agents structured system access. This is a strength. |
| Exec approvals | Command guard + delegation guard + proposal pipeline already surpass this. |
| Skill marketplace | Private system, not a platform. Per-instance skills only. |

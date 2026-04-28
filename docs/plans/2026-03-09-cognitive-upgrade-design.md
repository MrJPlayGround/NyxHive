# Cognitive Upgrade Sprint — Design Document

**Date**: 2026-03-09
**Author**: Nyx
**Scope**: Three pillars — deeper memory, proactive agents, smarter delegation

---

## Motivation

NyxHive's infrastructure is solid (3000+ tests, learned routing, multi-tier extraction, event-driven queue). But the engine's cognitive capabilities have a ceiling:

1. **Memory is shallow** — isolated per-conversation, no cross-linking, duplicate nodes for rephrased facts
2. **Agents are reactive** — everything waits for user input or fixed crons, no adaptive behavior
3. **Delegation is lossy** — continuations are dumb tail-pastes, routing ignores cost/speed, review outcomes don't feed back

This sprint attacks all three.

---

## Pillar 1: Deeper Memory — "Connect the Dots"

### 1A. Semantic Dedup at Extraction

**Files**: `src/queue/memory-extraction.ts`, `src/memory/graph.ts`

**Problem**: Dedup is content-hash only. "User prefers SQLite" and "User chose SQLite over Postgres" create two separate nodes.

**Solution**: Before inserting a new graph node, search KnowledgeStore for semantically similar existing nodes:

- Cosine > 0.88: **merge** — update existing node content (newer phrasing wins), bump importance, create "updates" edge
- Cosine 0.75–0.88: create new node but add "related_to" edge to near-match
- Below 0.75: standalone node (genuinely new)

**New method on GraphMemory**:
```typescript
async findSemanticDuplicate(content: string, knowledgeStore: KnowledgeStore): Promise<{
  match: GraphNode | null;
  similarity: number;
}>
```

**Cost**: 1 extra embedding lookup per extracted memory (~5–10 per cycle). Negligible.

### 1B. Multi-Hop Graph Traversal

**Files**: `src/memory/graph.ts` `expandWithGraphContext()`

**Problem**: 1-hop expansion misses transitive relationships. A->B->C never surfaces C.

**Solution**:
- Hop 1 nodes: weight 1.0 (current)
- Hop 2 nodes: weight 0.4, filtered by `importance > 0.3`
- Cap total expanded nodes at 15
- Skip hop-2 if hop-1 already returned >= 10 nodes (enough context)

### 1C. Cross-Conversation Memory Linking

**Files**: `src/queue/memory-extraction.ts`

**Problem**: Memories from conversation X are isolated. Can't surface "you hit this same issue 2 weeks ago in thread Y."

**Solution**: After extracting memories from a conversation, for each new node:
- Search graph (FTS5) for similar nodes from ANY conversation (exclude current)
- If found: create "related_to" edge with metadata `{ cross_conversation: true, source_conv: convId }`
- New query: `getRelatedAcrossConversations(nodeId)` returns cross-linked nodes
- Briefing injection: cross-conversation nodes appear under "Previously encountered:" header

### 1D. Frequency-Based Importance Reinforcement

**Files**: `src/memory/graph.ts`

**Problem**: Important recurring patterns decay the same as one-off observations.

**Solution**:
- New column: `mention_count INTEGER DEFAULT 1` on graph nodes
- Increment when semantic dedup merges or cross-link fires
- Nodes with `mention_count >= 3`: importance floor of 0.6 (won't decay below)
- Briefing separates "recurring patterns" (mention_count >= 3) from recency-based nodes

---

## Pillar 2: Proactive Agents — "Don't Wait, Anticipate"

### 2A. Reactive Task Triggers

**Files**: `src/queue/processor.ts` (post-response handling)

**Problem**: A cron task finds a critical issue but nothing happens until a human or the next cron cycle.

**Solution**:
- New action tag: `[@followup: description]` — parsed in action-tag handler
- Queues a new message for the originating agent (or specified agent via `[@followup agent_name: description]`)
- Priority inherits from parent task
- When `evolution:codebase-review` creates a high-priority proposal, auto-queue review via `startReview(proposalId)`
- Implementation: add `followup` case to existing action tag parser, call `queue.enqueue()`

### 2B. Idle-Aware Discovery

**Files**: `src/queue/processor.ts` (poll loop)

**Problem**: The engine sits idle most of the time. Could be working.

**Solution**:
- Track `lastActivityAt` on processor (updated on every message completion)
- In poll loop: if `now - lastActivityAt > idleThresholdMs` (default 30 min) AND no pending messages AND `now - lastIdleTriggerAt > idleCooldownMs` (default 2 hours):
  - Queue a lightweight scout task (evolution scan)
  - Set `lastIdleTriggerAt = now`
- Respect budget: skip if `getTotalCost(24) > dailyBudget * autonomousCeiling`
- Config: `[scheduler] idle_threshold_minutes = 30`, `idle_cooldown_minutes = 120`

### 2C. Adaptive Scheduling

**Files**: `src/scheduler/bootstrap.ts`, new `src/scheduler/adaptive.ts`

**Problem**: Fixed cron intervals. Daily scan that finds nothing for a week still runs daily. Scan that finds critical issues doesn't speed up.

**Solution**:
- New columns on `scheduled_tasks`: `consecutive_empty INTEGER DEFAULT 0`, `original_cron TEXT`, `adjusted_cron TEXT`
- After cron task completes:
  - No findings: `consecutive_empty++`
  - Found something: `consecutive_empty = 0`
- Frequency rules:
  - `consecutive_empty >= 3`: double interval (cap at weekly)
  - Finding with priority "high": halve interval (floor at 4 hours)
  - Reset to `original_cron` when findings return
- `adjustScheduleFrequency(taskId, hadFindings, findingPriority?)` in adaptive.ts
- Log adjustments for visibility

### 2D. Budget-Gated Autonomy

**Files**: `src/queue/processor.ts`, `src/defaults.ts`

**Problem**: Autonomous tasks could blow through the daily budget.

**Solution**:
- Before running any autonomous task (cron, idle, followup):
  - Check `getTotalCost(24)` vs daily budget
  - \> 80% (`autonomous_ceiling`): defer non-critical tasks to next day
  - \> 95%: halt ALL autonomous tasks, only user-initiated messages processed
  - Critical tasks always run: `health-check`, `reset-stale-reviewing`, `sync-merged`
- Config: `[budget] autonomous_ceiling = 0.8`
- Tag tasks as `critical: true` in bootstrap to exempt them

---

## Pillar 3: Smarter Delegation — "Workers That Actually Deliver"

### 3A. Rich Continuation Context

**Files**: `src/queue/delegation-executor.ts`

**Problem**: `buildContinuationPrompt()` pastes last 3000 chars. Workers re-explore failed approaches.

**Solution**: Use `extractMessageEssence()` (exists in `src/context/summarize.ts`) on full previous response. Structure:

```
[Continuation — Previous Session Hit Turn Limit]

Original task: {task, capped at 1000 chars}

## Progress Summary
- Completed: {extracted actions/file changes}
- Failed attempts: {extracted errors}
- Decisions made: {extracted decisions}

## Last Working State
{last 1500 chars of response}

[Instructions]
Continue from the progress summary. Do NOT retry approaches listed under failed attempts.
```

Cost: zero — `extractMessageEssence()` is regex-based.

### 3B. Outcome-Weighted Routing

**Files**: `src/memory/routing.ts`

**Problem**: Routing picks highest success_rate. A 95% agent costing 10x more always wins.

**Solution**: Composite scoring:

```
score = success_rate * 0.6 + cost_efficiency * 0.25 + speed_factor * 0.15
```

- `cost_efficiency` = 100 - percentile rank of avg_cost among agents for that task_type
- `speed_factor` = 100 - percentile rank of avg_duration among agents for that task_type
- Inject cost/speed in suggestions: `"has 90% success (12 tasks, ~2.1c avg, ~45s avg)"`
- `getSuggestions()` returns `composite_score` alongside raw metrics

### 3C. Review Gate Feedback Loop

**Files**: `src/queue/review-gate.ts`, `src/memory/routing.ts`

**Problem**: Review findings aren't linked to routing decisions. Can't learn which agents produce clean code.

**Solution**:
- New method: `routingStore.logReviewOutcome(traceId, outcome: 'pass' | 'warn' | 'fail')`
- New column: `review_outcome TEXT` on `routing_decisions`
- `getSkillMatrix()` extended: `review_pass_rate` = % of completed delegations with review_outcome = 'pass'
- `formatForInjection()` includes: `"has 90% success, 75% clean reviews"`
- Agents with < 50% clean review rate on a task_type get flagged

### 3D. Self-Delegation Check

**Files**: `src/queue/processor.ts`

**Problem**: Orchestrator delegates trivial single-file tasks that it could handle faster itself.

**Solution**:
- Before delegation dispatch, evaluate:
  - Does orchestrator have > 80% success on this task_type in skill matrix?
  - Is the task "simple"? (< 200 chars, single file reference, no multi-step indicators)
- If both true: inject system prompt nudge: `"Consider handling this directly — you have a strong track record on {task_type} tasks."`
- Suggestion only, not enforcement
- Track `self_handled` boolean on routing decisions to learn effectiveness

---

## Summary

| Pillar | Changes | New files | Estimated tests |
|--------|---------|-----------|-----------------|
| Memory (1A–1D) | graph.ts, memory-extraction.ts | None | ~60 |
| Proactive (2A–2D) | processor.ts, bootstrap.ts, defaults.ts | adaptive.ts | ~50 |
| Delegation (3A–3D) | delegation-executor.ts, routing.ts, review-gate.ts, processor.ts | None | ~60 |

**Total**: ~170 new tests, 1 new file, modifications to ~10 existing files.

**Execution order**: Pillar 1 (memory) -> Pillar 2 (proactive) -> Pillar 3 (delegation). Sequential because Pillar 2 benefits from Pillar 1's cross-linking, and Pillar 3 benefits from Pillar 2's task triggers.

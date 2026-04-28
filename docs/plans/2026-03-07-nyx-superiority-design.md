# NyxHive Superiority Plan — Design Doc

**Date:** 2026-03-07
**Goal:** Make NyxHive genuinely superior to Claude Code CLI across four dimensions
**Timeline:** 3-day sprint

## Problem Statement

NyxHive has stronger architecture than Claude Code CLI (multi-agent, persistent memory, approval gates, cost tracking) but falls short in execution quality:

- Token budget estimation is ~20% inaccurate (3.5 chars/token heuristic)
- Knowledge graph edges are created but never traversed during retrieval
- Context management doesn't prioritize important messages
- 44% of production files have zero test coverage
- Queue processing is synchronous and blocking
- Learning pipeline (7 modules) is completely untested

## Four Workstreams

### WS1: Smarter Context & Memory

**Token Accuracy**
- Replace 3.5 chars/token heuristic with `js-tiktoken` (Wasm-based, fast, accurate)
- Falls back to heuristic if tokenizer init fails
- File: `src/context/tokens.ts`

**Knowledge Graph Traversal**
- After flat vector search, traverse graph edges (relates_to, updates, supersedes) for 1-hop expansion
- Superseded nodes get deprioritized, related nodes get boosted
- Contradicting nodes surface as warnings in context
- Files: `src/memory/graph.ts`, `src/queue/knowledge-search.ts`

**Context Prioritization**
- Score messages by recency + importance (decisions, errors, user corrections weighted higher)
- Budget walk uses scores to decide what to keep vs truncate
- File: `src/context/budget.ts`

**System Prompt Budget Metering**
- Count knowledge + graph memory tokens against budget utilization
- Prevents silent overruns from large system prompts
- File: `src/context/budget.ts`

### WS2: Faster Processing

**Async Queue**
- Replace synchronous poll loop with EventEmitter-based push
- New messages emit events, processor subscribes
- Eliminates poll latency (currently 500ms+ per cycle)
- File: `src/queue/db.ts`, `src/queue/processor.ts`

**Message Priority**
- Three tiers: system (immediate), user (normal), background (low)
- System messages (scheduled tasks, proposals) skip ahead of user queue
- File: `src/queue/db.ts`

**Streaming Backpressure**
- Track agent response rate, pause queue intake if agents fall behind
- Prevents queue buildup during slow model responses
- File: `src/queue/processor.ts`

### WS3: Reliability (Test Coverage Blitz)

**Critical untested modules to cover:**

| Module | Risk | Tests Needed |
|--------|------|--------------|
| `src/memory/extract.ts` | Memory extraction logic | Heuristic extraction, rate limiting, dedup |
| `src/learning/` (7 files) | Learning pipeline | Analysis, distillation, triggers, listeners |
| `src/agents/routing.ts` | Message classification | Rule-based + LLM fallback routing |
| `src/agents/dispatch.ts` | Agent dispatch | SDK vs CLI decision, timeout handling |
| `src/queue/knowledge-search.ts` | Knowledge retrieval | Enrichment, two-phase filtering, feedback |
| `src/context/budget.ts` | Budget walk | Token counting accuracy, truncation, scoring |
| `src/server/routes/` (key routes) | API surface | Chat, threads, proposals endpoints |

**Testing principles:**
- Unit tests for pure logic, integration tests for pipelines
- Mock LLM calls (deterministic responses)
- Mock embedding calls (return fixed vectors)
- Test error paths, not just happy paths

### WS4: Developer Experience Polish

**CLI improvements:**
- `nyxhive health` — instance health check (DB accessible, port open, agents configured)
- `nyxhive logs --level warn --since 10m` — filtered log tailing
- `nyxhive status` — show uptime, message count, active agents, memory usage
- Version from package.json, not hardcoded

**Error recovery:**
- Port conflict → suggest next available port
- Missing API key → tell user which env var to set
- DB migration failure → suggest `nyxhive migrate --fix`

## Non-Goals

- Web chat UI (important but separate effort)
- iOS app changes (separate effort)
- New channel integrations
- Multi-tenant / instance onboarding (already in progress)

## Success Criteria

1. Token budget accuracy within 5% of actual (measured against tiktoken reference)
2. Knowledge retrieval uses graph traversal (1-hop expansion working)
3. Queue latency reduced by >50% (async push vs sync poll)
4. Test coverage for all 7 listed modules (with error paths)
5. `nyxhive health` and `nyxhive status` work correctly
6. All existing 1875 tests still pass
7. CI stays green

## Risk Mitigation

- Each workstream is independent — can ship incrementally
- Token accuracy change is backwards-compatible (same interface, better numbers)
- Async queue preserves existing message ordering guarantees
- Tests are additive — no existing test modifications needed
- CLI changes are additive commands, no breaking changes

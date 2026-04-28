# NyxHive Implementation Roadmap

**Date:** 2026-04-10  
**Status:** In Progress  
**Owner:** GPT-5.4 execution loop inside this repo  
**Priority:** Critical

## Mission

Upgrade NyxHive by importing the strongest ideas from Hermes and OpenClaw without importing their product sprawl.

The target state is:

- Hermes-grade procedural self-improvement
- Hermes-grade runtime resilience under provider and stream failures
- OpenClaw-grade session and control-plane contracts
- OpenClaw-grade context and memory layering
- A simpler cockpit because the backend is clearer, not because complexity is hidden

## Non-Goals

- Do not turn NyxHive into a multi-channel personal assistant clone.
- Do not copy Hermes live-skill mutation directly into production.
- Do not build a plugin architecture first.
- Do not frontload UI polish before backend contracts are clean.

## Hard Gates

Every meaningful loop must end with:

- `bun test`
- `bunx tsc --noEmit`
- `bun run gateway:build`

Every fixed bug or new behavior must leave regression protection behind.

## Baseline

Baseline captured on 2026-04-10:

- `bun test` -> `4179 pass, 3 skip, 0 fail`
- `bunx tsc --noEmit` -> pass
- `bun run gateway:build` -> pass
- worktree state before roadmap execution: clean

## Program Structure

Execution is broken into six phases. Each phase contains multiple tight loops with explicit checkpoints.

## Phase 0: Baseline Lock

### Goal

Freeze the current operating baseline and create a tracked execution spine.

### Deliverables

- this roadmap
- a live implementation ledger
- repeatable verification commands
- identified code seams for the first build slice

### Checkpoint

- baseline recorded
- ledger present
- no feature changes yet

## Phase 1: Procedural Skill System

### Goal

Import Hermes's strongest capability, but with NyxHive-safe controls:

- draft extraction
- draft review
- promotion
- selective loading
- usage feedback

### Why This Comes First

NyxHive already has:

- real memory extraction in `src/queue/memory-extraction.ts`
- a queue processor hook in `src/queue/processor.ts`
- a skill loading path in `src/agents/skill-loader.ts`

That means the shortest high-leverage path is to convert successful workflows into reusable operating knowledge.

### Loop 1.1: Procedural Skill Draft Storage

Build a durable draft store with:

- `id`
- `source_hash`
- `agent_key`
- `conversation_id`
- `title`
- `summary`
- `status` = `draft | published | rejected`
- `draft_markdown`
- `created_at`
- `updated_at`
- `published_at`
- `rejected_reason`
- `usage_count`
- `last_used_at`

Checkpoint:

- store exists
- CRUD tests exist
- duplicate transcript inputs dedupe by hash

### Loop 1.2: Post-Success Extraction Hook

Add extraction from the queue processor after strong successful runs only.

Initial extraction rules:

- skip trivial runs
- skip scheduler/system/proposal plumbing noise
- require meaningful assistant output
- require at least one sign of multi-step execution or repeated operational structure

Checkpoint:

- processor emits draft candidates only for qualifying runs
- extraction hook is independently testable
- no draft spam from trivial chat

### Loop 1.3: Draft Distillation

Transform successful transcript slices into draft procedures.

Draft format should include:

- when to use
- procedure
- pitfalls
- verification

Checkpoint:

- trivial transcripts are rejected
- non-trivial operational runs yield structured drafts
- failed distillation never breaks the main run

### Loop 1.4: Selective Skill Resolution

Replace static whole-bundle loading with:

- manual skills always included
- relevant published `auto-*` skills only
- bounded candidate selection by task/message overlap

Checkpoint:

- prompt size remains bounded
- irrelevant auto skills stay out of prompt
- manual allowlists still work

### Loop 1.5: Review And Promotion

Add the operator path to:

- list drafts
- inspect a draft
- publish a draft
- reject a draft

Checkpoint:

- promotion writes stable skill content
- rejection is durable
- same source hash does not endlessly regenerate rejected junk

### Loop 1.6: Usage Feedback And Pruning

Track:

- loaded skills
- published skills actually used
- success/failure correlation
- weak or stale drafts

Checkpoint:

- weak/stale skills can be surfaced and pruned
- usage counters update without affecting run stability

## Phase 2: Chat And Control-Plane Contracts

### Goal

Make cockpit behavior deterministic by fixing backend semantics first.

### Loop 2.1: Idempotent `chat.send`

Add:

- `runId`
- `idempotencyKey`
- `started | in_flight | ok` semantics

Checkpoint:

- duplicate resend bugs are eliminated
- retries are explicit

### Loop 2.2: Server-Side History Normalization

Normalize `chat.history` before it reaches the UI.

Strip:

- display-only control markup
- leaked model control tokens
- tool-call payload junk
- hidden reasoning markers not intended for display

Checkpoint:

- UI no longer needs defensive cleanup for transcript display

### Loop 2.3: Session Actor Queue

Serialize per-session mutating operations.

Checkpoint:

- concurrent send/history/abort/model actions stop stomping each other

### Loop 2.4: Abort And Partial Retention

Standardize partial assistant output retention on abort.

Checkpoint:

- aborted runs preserve useful partial state cleanly

### Loop 2.5: Presence And Typing Semantics

Add:

- explicit presence freshness
- explicit typing-start policies
- cleaner queue/active status surfacing

Checkpoint:

- cockpit state becomes less ambiguous under reconnect/load

## Phase 3: Runtime Resilience

### Goal

Import Hermes-style self-hardening around failures.

### Loop 3.1: Primary Provider Fallback

Add one-shot provider/model fallback for main runs.

Checkpoint:

- primary provider failure still yields a usable answer when fallback exists

### Loop 3.2: Auxiliary Task Fallback

Separate fallback behavior for:

- compression
- memory extraction
- session search
- other lightweight helper tasks

Checkpoint:

- sidecar service failures do not cascade into hard main-run failure

### Loop 3.3: Streaming Fallback

When edit/update streaming transport fails, degrade to final-send or chunked-send cleanly.

Checkpoint:

- no dropped or duplicated final text under stream failure

### Loop 3.4: Activity-Based Stall Detection

Track real activity instead of simple wall-clock timeouts.

Checkpoint:

- active long-running work survives
- idle hangs are cut off

### Loop 3.5: Oversized Result Persistence

Persist oversized tool outputs as artifacts, not destructive truncation.

Checkpoint:

- artifact previews surface in cockpit/trace

## Phase 4: Memory Architecture Upgrade

### Goal

Separate recall memory from durable maintained knowledge.

### Loop 4.1: Memory Lane Split

Keep current graph/knowledge extraction, but add a distinct compiled knowledge lane.

### Loop 4.2: Compiled Digest Layer

Produce small stable machine-facing digests from durable knowledge.

### Loop 4.3: Review And Dreaming Sweep

Add bounded review/promotion/consolidation passes for durable knowledge.

### Loop 4.4: Prompt Supplements

Inject compiled knowledge only when relevant and within budget.

### Loop 4.5: Operator Surfaces

Expose:

- promoted knowledge
- stale knowledge
- contradictions
- review outcomes

Checkpoint:

- retrieval quality improves without prompt explosion

## Phase 5: Cockpit Simplification

### Goal

Make chat the primary truth surface and demote everything else to support roles.

### Loop 5.1: Inline Trace First

Keep trace near the turn that caused it.

### Loop 5.2: Diff Rail Minimization

Keep diff powerful but independently collapsible.

### Loop 5.3: Session Search And Resume

Add cross-thread/session search and clean resumption.

### Loop 5.4: Lightweight Task Flows

Show long jobs, blocked states, and subagent outcomes without building a project manager UI.

### Loop 5.5: Usage And Status Coherence

Unify model/provider/fallback/queue state into one readable surface.

Checkpoint:

- cockpit is simpler after more power is added

## Phase 6: Final Hardening

### Goal

Close residual edge cases and make the upgraded architecture trustworthy.

### Deliverables

- regression sweep over touched surfaces
- remote smoke validation on `air`
- cleanup of dead code paths introduced during migration
- operator notes for the new skill and memory loops

## Verification Matrix

For every loop:

1. add or tighten tests
2. run targeted verification
3. run full hard gates
4. update the implementation ledger

## Done Criteria

The roadmap is complete when:

- procedural skill drafts, review, promotion, and reuse are real
- chat send/history/abort semantics are deterministic
- provider/stream failure behavior is resilient
- memory has both recall and compiled knowledge layers
- cockpit complexity is materially reduced by better backend contracts

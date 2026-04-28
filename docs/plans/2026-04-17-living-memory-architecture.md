# Living Memory Architecture

Date: 2026-04-17
Scope: architecture and implementation handoff. No behavior change in this pass.

## Summary

NyxHive does not need another memory bucket. It needs a stronger cognitive contract over the memory surfaces that already exist.

The current stack has working conversation memory, graph memory, extracted memories, semantic knowledge chunks, compiled digests, procedural skills, retrieval traces, context artifacts, and scheduler maintenance. The next step is to make those pieces behave like a living persistent cognitive layer:

1. A compact self-model that plans from memory without pretending to be canonical truth.
2. A scratchpad or dream layer for tentative synthesis that cannot silently become durable memory.
3. A promotion pipeline with graded authority, provenance, and review gates.
4. Background reflection jobs that produce reviewable insight instead of sludge.
5. Staleness and revalidation as first-class memory behavior.
6. Explicit lane authority so summaries, digests, graph nodes, chunks, procedures, and reflections are not blurred together.

This should make NyxHive feel more alive by improving continuity, contradiction handling, and self-correction. It should not make it more delusional. The architecture has to bias toward evidence, decay, review, and explicit authority.

## Existing Substrate

This design builds on the current memory stack:

- `src/memory/store.ts` persists conversations, summaries, saved memories, context traces, and context artifacts.
- `src/memory/belief-state.ts` already defines trust assessment fields: memory type, confidence, source reliability, currentness, status, supersession, expiry, and age-based uncertainty.
- `src/memory/graph.ts` stores graph memory nodes and edges with importance, access counts, expiry, updates, supersedes, contradictions, and relationship traversal.
- `src/queue/memory-extraction.ts` extracts memory from turns through heuristic, learning-trigger, and LLM phases, then bridges extracted memories into the knowledge store.
- `src/memory/knowledge.ts` stores embedded chunks with confidence, access count, recency, source metadata, supersession, stale pruning, and task-aware ranking.
- `src/memory/compiled-knowledge.ts` stores source-level and procedural-skill digests, including stale audits.
- `src/memory/retrieval-trace.ts` defines memory lanes, currentness, source reliability, retrieval traces, and assembly traces.
- `src/memory/lanes.ts` implements the current lane contract and runtime filtering.
- `src/scheduler/index.ts` already has `memory:maintenance`, graph decay, stale knowledge pruning, routing pruning, and trace pruning.
- `docs/plans/2026-04-11-memory-stack-review.md` correctly identified the main next step: make the lane contract, telemetry, and benchmarks explicit before changing behavior.
- `docs/plans/2026-04-17-memory-lane-contract.md` is the first executable contract for prompt-injected memory lanes.

The missing layer is not storage. It is governance.

## Design Call

Use the existing graph, knowledge, saved-memory, digest, and trace stores as evidence lanes. Add two new conceptual layers only when implementing:

- `self_model`: compact, derived, refreshable planning lens.
- `reflection_artifact`: tentative synthesis and review queue, not durable truth.

Do not add a second canonical long-term-memory store. Durable truth remains owned by existing durable lanes, especially graph memory and saved memories with belief-state metadata. Knowledge chunks and compiled digests remain evidence and compression, not beliefs by themselves.

## Approaches Considered

### Approach A: Add a new living-memory database

This would create a separate canonical store for self-model, dreams, reflections, beliefs, and promotion state.

Reject this. NyxHive already has enough stores. A new canonical memory DB would duplicate truth with graph memory, saved memories, and knowledge chunks. The likely failure mode is split-brain memory: two places claiming authority over the same fact.

### Approach B: Only improve retrieval ranking

This would make better search and more reliable prompt injection, but leave authority, staleness, contradiction handling, and self-model synthesis implicit.

Reject this as incomplete. Retrieval quality matters, but the core problem is not "find more facts." It is "know what kind of thing this memory is, whether it is current, how strongly to trust it, and what should happen when evidence conflicts."

### Approach C: Add governance layers over existing stores

This adds a self-model projection, tentative reflection artifacts, authority tiers, and scheduled reflection jobs over the current memory stack.

Choose this. It preserves existing investments, keeps durable truth in known lanes, and gives background cognition a reviewable promotion path.

## Lane Authority Contract

The existing lane contract should become the foundation for every prompt, tool, reflection, and promotion decision.

| Lane | Authority | Role |
| --- | --- | --- |
| `conversation_recent` | highest local authority for the active turn | Live working context. Can override stale durable memory in the current conversation. |
| `durable_user_preference` | high, if current and sourced | Stable user preference or interpersonal fact. Must carry confidence/currentness. |
| `conversation_summary` | medium | Convenience compression. Useful for continuity, not canonical truth. |
| `graph_memory` | high when sourced, current, and not contradicted | Durable structured belief and relation graph. Preferred home for accepted durable facts, decisions, preferences, and contradictions. |
| `compiled_digest` | medium | Compressed aid over chunks or procedural drafts. Good for orientation, not proof. Must defer to source chunks or graph nodes when disputed. |
| `knowledge_chunk` | evidence, not belief | Source material. Strong evidence when source is trusted, but not automatically an accepted belief. |
| `context_artifact` | evidence summary | Generated overview of source material. Lower authority than the source it summarizes. |
| `procedural_memory` | procedural authority only | How-to memory for workflows. Must not surface as personal recall in ordinary conversation. |
| `routing_history` | operational telemetry | Searchable diagnostic record, never personal memory. |
| `outcome_pattern` | operational hint | Useful for agentic execution and hybrid mode. Not conversational personal memory. |
| `reflection_artifact` | hypothesis only | Tentative synthesis. Cannot claim truth until promoted. |
| `self_model` | planning lens only | Compact derived view used for continuity and prioritization. Never canonical evidence. |

Conflict rule:

1. Recent user statement wins for the current turn.
2. User-confirmed durable memory wins over assistant inference.
3. Current graph memory beats compiled digest and conversation summary.
4. Source chunks beat generated context artifacts and compiled summaries.
5. Reflection artifacts never beat durable memory.
6. Self-model never settles factual disputes. It points to evidence.

## Self-Model Layer

The self-model is a compact evolving projection of the agent's current operating context. It should be useful enough to guide planning, but weak enough that it cannot become a fake source of truth.

### Purpose

The self-model answers:

- What projects are active?
- What priorities are currently live?
- What loops remain open?
- Which people and entities matter right now?
- What user preferences affect behavior?
- Which areas are fragile, conflicted, stale, or under review?
- What should be revalidated soon?

### Non-Purpose

The self-model is not:

- a replacement for graph memory
- a replacement for saved memories
- a source document
- a private place to smuggle assistant guesses into durable truth
- a long narrative persona blob

### Shape

Implementation should store the self-model as small typed entries, not as one giant prose summary.

Suggested entry shape:

```ts
type SelfModelEntryKind =
  | "active_project"
  | "current_priority"
  | "open_loop"
  | "important_entity"
  | "user_preference"
  | "fragile_area"
  | "revalidation_target";

interface SelfModelEntry {
  id: string;
  agent_key: string;
  kind: SelfModelEntryKind;
  label: string;
  summary: string;
  confidence: number;
  currentness: "current" | "stale" | "superseded" | "expired" | "uncertain";
  observed_at: number;
  last_verified_at: number | null;
  review_after: number | null;
  source_refs: MemoryEvidenceRef[];
  contradicted_by_refs: MemoryEvidenceRef[];
  superseded_by_id: string | null;
  updated_at: number;
}
```

Evidence refs should point back to existing lanes:

```ts
type MemoryEvidenceRef =
  | { lane: "conversation_recent"; conversation_id: string; message_id?: number }
  | { lane: "conversation_summary"; conversation_id: string }
  | { lane: "graph_memory"; node_id: number }
  | { lane: "knowledge_chunk"; chunk_id: number }
  | { lane: "compiled_digest"; page_id: number }
  | { lane: "context_artifact"; artifact_id: number }
  | { lane: "procedural_memory"; draft_id: number };
```

### Generation

The self-model should be derived by a scheduled reflection job from:

- recent conversations and summaries
- high-importance graph nodes
- current durable user preferences
- open tasks and proposal state
- recent retrieval traces
- current procedural skill audit state
- stale or contradictory memory signals

It should not update on every message. Updating every turn creates churn and overfits to transient context. A reasonable first cadence is daily, plus manual trigger.

### Prompt Use

The self-model should be injected only as a compact section when it helps continuity. It must identify itself as a planning lens, not memory truth.

Example prompt shape:

```text
[Self-model: planning lens, not canonical truth]
- Active project: NyxHive memory architecture. Evidence: graph:123, digest:44. Confidence: 0.78. Review after: 2026-04-24.
- Open loop: decide first implementation slice for reflection artifacts. Evidence: conversation:abc. Confidence: 0.7.
- Fragile area: memory lane authority can blur procedural memory with personal recall. Evidence: docs/plans/2026-04-17-memory-lane-contract.md.
```

## Scratchpad / Dream Layer

The dream layer is a low-authority private synthesis lane for things the system suspects but has not proven.

Use the word "dream" internally if we want the living-system metaphor. In code and UI, prefer `reflection_artifact` or `hypothesis` because it states the authority level clearly.

### What Belongs Here

- Hypotheses about repeated user preferences.
- Possible contradictions between durable memories.
- Suspected stale notes.
- Near-duplicate facts that might be mergeable.
- Candidate links across projects, people, and tasks.
- Tentative behavioral lessons from repeated execution failures.
- Candidate self-model updates before they are accepted.

### What Does Not Belong Here

- User-confirmed durable facts.
- Final decisions.
- Procedures that should be published as skills.
- Raw imported source material.
- Anything prompt-injected as true.

### Suggested Artifact Shape

```ts
type ReflectionArtifactKind =
  | "hypothesis"
  | "contradiction"
  | "staleness_suspicion"
  | "duplicate_suspicion"
  | "pattern_candidate"
  | "self_model_candidate"
  | "promotion_candidate";

type ReflectionArtifactStatus =
  | "open"
  | "promoted"
  | "rejected"
  | "superseded"
  | "expired";

interface ReflectionArtifact {
  id: string;
  agent_key: string;
  kind: ReflectionArtifactKind;
  status: ReflectionArtifactStatus;
  claim: string;
  rationale: string;
  confidence: number;
  evidence_refs: MemoryEvidenceRef[];
  counter_evidence_refs: MemoryEvidenceRef[];
  proposed_promotion_target:
    | "self_model"
    | "graph_memory"
    | "saved_memory"
    | "compiled_digest"
    | "procedural_skill"
    | null;
  review_gate: "auto" | "agent_review" | "jay_review";
  observed_at: number;
  stale_after: number | null;
  reviewed_at: number | null;
  reviewer: string | null;
  decision_reason: string | null;
}
```

Hard rule: reflection artifacts are not injected as truth. They can be surfaced as "possible issue" or "candidate insight" only when the emergence rules say the signal matters.

## Promotion Pipeline

Memory needs an authority ladder. The system should not jump from one extraction to permanent belief.

| Tier | Meaning | Can Prompt As Truth? | Promotion Gate |
| --- | --- | --- | --- |
| Raw retrieval artifact | Source chunk, message, trace, context artifact, or graph node retrieved for a task | Only if lane allows and trace marks it current enough | Existing retrieval gates |
| Extraction candidate | Candidate fact/procedure/pattern extracted from a turn | No | Dedup, trust assessment, source reliability |
| Reflection insight | Hypothesis synthesized across evidence | No | Reflection job plus evidence refs |
| Reviewed belief | Accepted belief with provenance, confidence, and currentness | Selectively | Agent review for low-risk, User review for high-impact |
| Durable memory | Graph node, saved memory, published skill, or accepted digest update | Yes, according to lane contract | Existing store write plus traceable promotion record |

### Auto-Promotion

Auto-promotion should be narrow:

- User explicitly states a stable preference or project fact and it matches no contradiction.
- The same low-risk fact appears in multiple independent sources.
- A stale compiled digest is regenerated from unchanged source chunks.
- A duplicate low-authority reflection is merged into an existing open reflection.
- A self-model entry is refreshed from already-current durable evidence without changing meaning.

### Review-Gated Promotion

Require agent or User review for:

- Identity, relationship, access, financial, security, or governance facts.
- Conflicts between high-authority memories.
- Any claim that changes standing operating behavior.
- Procedural skill publication.
- Demotion or deletion of high-authority memories.
- Cross-project conclusions that could affect routing or product judgment.

### Promotion Record

Promotion should write a small audit record even if the durable target is an existing table.

Suggested shape:

```ts
interface MemoryPromotionRecord {
  id: string;
  source_artifact_id: string;
  from_tier: "extraction_candidate" | "reflection_insight" | "reviewed_belief";
  to_lane: MemoryLane | "self_model" | "reflection_artifact";
  target_ref: MemoryEvidenceRef | { lane: "self_model"; entry_id: string };
  promoted_by: "system" | "agent" | "jay";
  decision_reason: string;
  evidence_refs: MemoryEvidenceRef[];
  created_at: number;
}
```

## Staleness And Revalidation

Staleness is already partially implemented through graph expiry, knowledge confidence/access pruning, compiled digest stale audits, saved-memory currentness, and belief-state trust assessment. The upgrade is to make it consistent across all belief-like artifacts.

### Required Fields For Belief-Like Artifacts

Every belief-like durable or semi-durable artifact should be able to answer:

- `observed_at`: when the system first observed the claim
- `last_verified_at`: when evidence last confirmed it
- `confidence`: how strongly to trust it
- `source_origin`: user, assistant, system, import, scheduler, external
- `source_reliability`: user-confirmed, user-stated, assistant-inferred, system-observed, imported
- `currentness`: current, stale, superseded, expired, uncertain
- `review_after` or `stale_after`: when it should be checked again
- `superseded_by`: replacement artifact
- `contradicted_by`: evidence that challenges it

### Review Horizons

Different memory types should decay differently:

| Artifact | Default Review Horizon |
| --- | --- |
| User-confirmed identity/preference | 180 days, unless contradicted |
| Assistant-inferred preference | 30 days |
| Active project priority | 7 days |
| Open loop | 3 days |
| Technical implementation fact | 30 days or source change |
| Procedural skill | audit after 3 uses with low success or every 90 days |
| Reflection artifact | 14 days unless promoted |
| Compiled digest | source hash change or 30 days |

Staleness should reduce confidence and prompt use. It should not necessarily delete memory. Old memory is often useful as history, but dangerous as current truth.

## Background Reflection Jobs

Reflection jobs should run through the existing scheduler shape, either as system tasks or extension tasks registered through `registerTaskDefinitions()`.

Do not start with an open-ended "think about memory" cron. That creates landfill. Each job needs a bounded input window, output schema, caps, and acceptance criteria.

### Job 1: Daily Self-Model Refresh

Cadence: daily, manual trigger supported.

Inputs:

- last 24h conversations and summaries
- high-importance graph nodes touched in last 7d
- open tasks/proposals
- durable user preferences
- unresolved reflection artifacts

Outputs:

- upserted self-model entries
- stale self-model entries marked uncertain
- review queue entries for conflicts

Caps:

- max 20 entries per agent
- max 5 open loops per agent
- max 5 fragile areas per agent

### Job 2: Reflection Window Synthesis

Cadence: daily for 24h, weekly for 7d, monthly for 30d.

Inputs:

- retrieval traces
- failed/superseded runs
- repeated graph memory mentions
- repeated low-confidence knowledge feedback
- procedural skill audit candidates

Outputs:

- reflection artifacts only
- no direct durable memory writes except artifact status changes

Good outputs:

- "These three failures point to a recurring verification gap."
- "This preference appears in two conversations but is still assistant-inferred."
- "This compiled digest is stale because the source hash changed."

Bad outputs:

- generic weekly summaries
- personality prose
- ungrounded advice
- duplicate "keep doing X" observations without evidence

### Job 3: Contradiction And Supersession Scan

Cadence: weekly.

Inputs:

- graph edges `contradicts`, `updates`, `supersedes`
- saved memories with `status != current`
- knowledge chunks with `decision_status = superseded`
- compiled digests marked stale
- reflection artifacts tagged `contradiction`

Outputs:

- review queue items for high-authority conflicts
- demotion candidates for stale/contradicted low-confidence artifacts
- self-model fragile-area updates

### Job 4: Duplicate And Residue Cleanup

Cadence: weekly, conservative.

Inputs:

- graph nodes with high semantic similarity
- knowledge chunks with same source path/section/content hash
- repeated reflection artifacts
- expired low-confidence observations

Outputs:

- merge suggestions
- auto-reject duplicate low-authority reflection artifacts
- never delete high-authority memory without review

### Job 5: Meaningful Emergence Scan

Cadence: after reflection jobs.

Purpose: decide what is worth surfacing to User or the operator.

This job should not generate new insight. It should select from existing reflection artifacts and review queue items.

## Meaningful Emergence Rules

The system should work quietly by default. It should surface memory insight only when one of these is true:

- A contradiction affects active work.
- A durable assumption is stale and high-impact.
- A repeated pain pattern appears across independent runs.
- A priority shift is evident from recent user statements and active project state.
- A procedural skill is repeatedly selected and failing.
- A memory lane is being misused, for example procedural memory surfacing as personal recall.
- A strong synthesis has enough evidence to review and would materially improve continuity.

Do not surface:

- routine summaries
- low-confidence guesses
- generic motivational observations
- old facts with no active relevance
- duplicate "insights" already reviewed

Emergence payloads should be compact:

```text
[Memory review]
Signal: Possible contradiction in active project priority.
Why it matters: Current self-model says X, but User stated Y today.
Evidence: conversation:abc message 42, graph:913.
Recommended action: review and either supersede graph:913 or mark this as temporary.
```

## Data Model Path

The smallest useful implementation should add reviewable synthesis, not final behavior changes.

### Phase 1 Tables

Add `memory_reflection_artifacts`:

- `id TEXT PRIMARY KEY`
- `agent_key TEXT NOT NULL`
- `kind TEXT NOT NULL`
- `status TEXT NOT NULL DEFAULT 'open'`
- `claim TEXT NOT NULL`
- `rationale TEXT NOT NULL`
- `confidence REAL NOT NULL`
- `evidence_json TEXT NOT NULL`
- `counter_evidence_json TEXT NOT NULL DEFAULT '[]'`
- `proposed_promotion_target TEXT`
- `review_gate TEXT NOT NULL`
- `observed_at INTEGER NOT NULL`
- `stale_after INTEGER`
- `reviewed_at INTEGER`
- `reviewer TEXT`
- `decision_reason TEXT`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

Add `memory_self_model_entries`:

- `id TEXT PRIMARY KEY`
- `agent_key TEXT NOT NULL`
- `kind TEXT NOT NULL`
- `label TEXT NOT NULL`
- `summary TEXT NOT NULL`
- `confidence REAL NOT NULL`
- `currentness TEXT NOT NULL`
- `evidence_json TEXT NOT NULL`
- `contradicted_by_json TEXT NOT NULL DEFAULT '[]'`
- `observed_at INTEGER NOT NULL`
- `last_verified_at INTEGER`
- `review_after INTEGER`
- `superseded_by_id TEXT`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`

Add `memory_promotion_records`:

- `id TEXT PRIMARY KEY`
- `source_artifact_id TEXT NOT NULL`
- `from_tier TEXT NOT NULL`
- `to_lane TEXT NOT NULL`
- `target_ref_json TEXT NOT NULL`
- `promoted_by TEXT NOT NULL`
- `decision_reason TEXT NOT NULL`
- `evidence_json TEXT NOT NULL`
- `created_at INTEGER NOT NULL`

Use `ensureTableSchema()` with persistent migration, following the pattern in `src/memory/store.ts`, `src/memory/compiled-knowledge.ts`, and `src/memory/procedural-skills.ts`.

### Phase 1 Store API

Add a small store module, likely `src/memory/reflection.ts`, with:

- `createReflectionArtifact(input)`
- `listReflectionArtifacts({ status, kind, agentKey, limit })`
- `reviewReflectionArtifact(id, decision)`
- `upsertSelfModelEntry(input)`
- `listSelfModelEntries({ agentKey, currentness, limit })`
- `markSelfModelEntryStale(id, reason)`
- `recordPromotion(input)`

Keep this module boring. No LLM calls. No scheduling. No prompt injection.

### Phase 1 Tests

Add deterministic tests for:

- artifact creation validates kind/status/review gate
- stale reflection artifacts are listed as review candidates
- self-model upsert preserves evidence refs
- superseding a self-model entry marks currentness and target id
- promotion records cannot be written without evidence refs

## Scheduler Integration Path

After the store exists, add scheduler tasks behind config or task-profile gates:

- `memory:reflect-daily`
- `memory:self-model-refresh`
- `memory:contradiction-scan`

Do not overload existing `memory:maintenance`. Maintenance prunes and decays. Reflection synthesizes. They should remain separate to keep failure modes clear.

Implementation options:

1. System tasks in `src/scheduler/index.ts` and default registrations in `src/scheduler/bootstrap.ts`.
2. Extension tasks through `registerTaskDefinitions()` if this needs instance-specific behavior.

Start with system tasks only if the implementation is engine-owned and deterministic. Use extension tasks if the job depends heavily on instance configuration or project-specific policy.

## Prompt Assembly Path

Self-model injection should be a separate assembly part in `src/queue/system-prompt-builder.ts`.

Rules:

- Inject only in execution, investigation, reflection, or handoff modes unless conversation explicitly needs continuity.
- Cap hard, for example 700 to 1200 tokens.
- Include evidence handles, not long evidence text.
- Mark stale or uncertain entries visibly.
- Never inject open reflection artifacts as truth.
- Allow reflection-mode prompts to inspect open reflection artifacts explicitly.

Trace requirements:

- `AssemblyTrace.parts` must include a `self_model` label.
- `memoryLanesInjected` should not pretend `self_model` is durable truth.
- Retrieval/assembly diagnostics should expose counts of self-model entries and open reflection artifacts used.

## Review UX Path

The Gateway should eventually expose a small review surface, not a sprawling memory cockpit.

Minimum useful panels:

- Open reflection artifacts needing review.
- Stale high-authority beliefs.
- Self-model entries with evidence and currentness.
- Promotion history for a selected artifact.

Actions:

- promote to self-model
- promote to saved memory
- promote to graph memory
- reject with reason
- mark stale
- mark superseded
- request revalidation

Every action should write a promotion or review record. Silent memory editing is how trust dies.

## Risks And Failure Modes

### Reflection Landfill

If background jobs create too many low-value artifacts, the system becomes noisier and less trustworthy.

Mitigation:

- hard output caps
- duplicate suppression
- expiry on low-confidence artifacts
- emergence rules
- review queue metrics

### Self-Model Overtrust

The self-model can start to feel canonical because it is compact and injected often.

Mitigation:

- call it a planning lens in prompt labels
- require evidence refs
- never settle conflicts from self-model alone
- stale entries visibly marked uncertain

### Dream Layer Leakage

Tentative hypotheses could leak into normal conversation as "I remember."

Mitigation:

- reflection artifacts not included in ordinary prompt assembly
- explicit lane authority says hypothesis only
- trace tests for runtime filtering

### Promotion Too Easy

The system could promote assistant guesses into durable memory.

Mitigation:

- review gates by artifact type and impact
- no durable writes without evidence refs
- conservative default confidence for assistant-inferred claims
- User review for governance, security, budget, identity, and standing behavior

### Stale Truth

Old correct memories can become wrong but continue to steer behavior.

Mitigation:

- review horizons by memory type
- contradiction scan
- revalidation jobs
- currentness shown in retrieval traces

### Split Authority

Graph nodes, saved memories, knowledge chunks, compiled digests, and self-model entries could disagree.

Mitigation:

- lane precedence
- source refs on projections
- contradiction artifacts
- prompt wording that treats summaries/digests/self-model as aids, not proof

## Phased Implementation Plan

### Phase 0: Contract Review

Status: this document.

Deliverables:

- Review and accept the authority model.
- Decide whether `self_model` and `reflection_artifact` should become new `MemoryLane` values or remain separate prompt labels. Recommendation: keep them separate initially so lane filtering does not imply durable truth.
- Decide review gates for high-impact promotions.

### Phase 1: Reflection Store And Tests

Goal: create the substrate for tentative synthesis without prompt injection.

Files:

- Add `src/memory/reflection.ts`
- Add tests in `src/__tests__/memory-reflection.test.ts`
- Optionally add gateway route types later, not in the first slice

Acceptance:

- Can store, list, review, stale, and promote reflection artifacts.
- Can store compact self-model entries with evidence refs.
- No LLM calls.
- No prompt assembly changes.
- No scheduler jobs.

### Phase 2: Deterministic Scans

Goal: create useful reflection artifacts without model-generated noise.

Files:

- Add deterministic helpers under `src/memory/reflection-scans.ts`
- Add tests for duplicate detection, stale self-model entries, and contradiction candidates

Acceptance:

- Scans emit bounded artifacts with evidence refs.
- No direct durable memory promotion.
- Duplicate artifacts are suppressed.

### Phase 3: Scheduler Hooks

Goal: run reflection jobs quietly on a schedule.

Files:

- `src/scheduler/bootstrap.ts`
- `src/scheduler/index.ts`
- scheduler tests

Acceptance:

- `memory:self-model-refresh` and `memory:contradiction-scan` can run manually and on cron.
- Failures show in scheduler task history.
- Jobs obey budget/inflight guards like other low-priority tasks.
- Existing `memory:maintenance` remains pruning/decay only.

### Phase 4: Prompt Injection

Goal: inject compact self-model only where it improves continuity.

Files:

- `src/queue/system-prompt-builder.ts`
- `src/memory/retrieval-trace.ts` or a prompt trace extension
- trace tests

Acceptance:

- Self-model assembly part is capped and traceable.
- Reflection artifacts are not injected in normal conversation.
- Runtime mode rules are covered by tests.

### Phase 5: Review UI And Promotion Actions

Goal: make the cognitive contract inspectable and editable.

Files:

- Gateway protocol methods
- Gateway memory/review page
- server routes

Acceptance:

- User can see why a hypothesis exists.
- Review decisions write audit records.
- Promotion targets are explicit.

### Phase 6: Model-Assisted Reflection

Goal: use LLM synthesis only after deterministic reflection scaffolding works.

Acceptance:

- LLM output is schema-validated.
- Every artifact has evidence refs.
- Max outputs are capped.
- Low-confidence or unsupported claims are rejected before storage.
- Regression fixtures prove the model cannot auto-promote hypotheses.

## First Slice Recommendation

Do not implement prompt injection first. Do not implement "dreaming" as prose.

The first implementation slice should be `src/memory/reflection.ts` plus tests:

- reflection artifacts
- self-model entries
- promotion records
- evidence refs
- review gates

This is small, shippable, and creates the authority boundary before any background cognition starts writing into the system.

## Acceptance Criteria For The Architecture

This design is ready to implement when:

- Every memory lane has a stated authority level.
- Self-model is explicitly a projection, not truth.
- Reflection artifacts are explicitly hypotheses, not durable memory.
- Promotion requires evidence and records who or what promoted it.
- Staleness applies to belief-like artifacts.
- Scheduler jobs are bounded and reviewable.
- Emergence is rare and tied to material signals.
- The first implementation slice can ship without changing prompt behavior.

That is the line: living memory, but with a spine.

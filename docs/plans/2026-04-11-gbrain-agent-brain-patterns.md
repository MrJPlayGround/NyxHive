# GBrain And Agent-Brain Pattern Review

Date: 2026-04-11
Scope: review and follow-up proposals only. Do not change routing, prompt, memory, or delegation behavior in this pass.

## Sources Reviewed

- Upstream `garrytan/gbrain` at commit `0ca2e86acb6a0feaa915a5e6c108bcce4f31f164`
  - https://github.com/garrytan/gbrain
  - `docs/guides/brain-agent-loop.md`
  - `docs/guides/brain-first-lookup.md`
  - `docs/guides/entity-detection.md`
  - `docs/guides/sub-agent-routing.md`
  - `docs/guides/source-attribution.md`
  - `docs/GBRAIN_RECOMMENDED_SCHEMA.md`
  - `docs/ethos/THIN_HARNESS_FAT_SKILLS.md`
  - `skills/query/SKILL.md`
  - `src/core/search/hybrid.ts`
  - `src/core/search/dedup.ts`
- NyxHive local code paths:
  - `src/queue/system-prompt-builder.ts`
  - `src/queue/delegation.ts`
  - `src/providers/router.ts`
  - `src/agents/routing.ts`
  - `src/agents/primary.ts`
  - `src/memory/routing.ts`
  - `src/memory/procedural-skills.ts`
  - `src/queue/procedural-skill-extraction.ts`

## Executive Summary

Do not import GBrain as a second memory runtime right now.

NyxHive already has durable graph memory, knowledge retrieval, compiled knowledge, procedural skill drafts, learned routing, dual-brain routing, delegation loops, and prompt assembly traces. Dropping in GBrain wholesale would duplicate storage and blur ownership of long-term truth.

The useful GBrain ideas are operating patterns:

1. A resolver-first prompt structure: keep the harness thin, then load task-specific procedures when the resolver says they are relevant.
2. Brain-first lookup before external enrichment: durable local knowledge should be consulted before web/API tools.
3. Async signal detection on inbound messages: capture entities, original ideas, corrections, and relationship facts without blocking the main response.
4. Explicit provenance and source precedence: user direct statements, primary artifacts, timeline/evidence, and external enrichment should not have equal authority.
5. Multi-layer retrieval discipline: keyword, semantic/hybrid, structured graph/backlink, and full-page read should be separate steps, not one opaque "memory search."

The deliberate no-op for this pass is therefore: document the adaptation path, but do not change runtime defaults until there are acceptance tests that prove routing, prompt size, and memory writes remain stable.

## Current NyxHive Fit

### Routing

NyxHive already has three routing surfaces:

- `src/providers/router.ts` classifies task type and tier, then selects a model/provider route.
- `src/agents/primary.ts` applies dual-brain routing for coding versus conversation/reasoning tasks.
- `src/memory/routing.ts` records delegation outcomes and injects learned agent routing suggestions.

This is stronger than GBrain's documented static sub-agent routing table. The gap is not "add a routing table." The gap is that NyxHive's routing intelligence is mostly model/agent selection, while GBrain also routes context and procedure: what playbook to load, what source hierarchy to respect, and what checks must run before external lookup.

### Prompt Structure

`src/queue/system-prompt-builder.ts` already assembles platform context, sender context, soul, channel guidance, knowledge context, learned patterns, routing suggestions, graph memory, work log, active delegations, execution policy, clarification guidance, wisdom, depth guard, and context pressure signals.

That is powerful, but it is also where prompt bloat can grow. GBrain's "thin harness, fat skills" pattern suggests a next step: use a resolver to choose small procedural blocks based on task type, channel, entity presence, and available knowledge. This should be traceable through `AssemblyPart` rather than hard-coded into every agent prompt.

### Delegation

`src/queue/delegation.ts` already does more than GBrain's reference pattern:

- It validates that orchestrators delegate non-trivial work.
- It re-injects explicit user delegation tags if an orchestrator swallows them.
- It routes fallback delegations by task type and registry role.
- It supports re-entry loops so orchestrators can synthesize or chain further tasks.

The missing GBrain-inspired piece is a compact decision card attached to delegated tasks: why this route was chosen, what sources were already checked, what authority rules apply, and what completion evidence is required. That would help subagents avoid redoing lookup work or reaching for external tools too early.

### Memory And Retrieval

GBrain uses a clear mental model: compiled truth for current state, timeline for append-only evidence, source attribution for every factual claim, and a query workflow that separates chunk search from full-page reads.

NyxHive has analogous primitives, but they are distributed:

- Graph memory nodes and edges store typed facts, decisions, observations, and relations.
- Knowledge search retrieves chunks with FTS/vector ranking, sibling expansion, graph expansion, and traces.
- Compiled knowledge stores source-level digests and procedural workflow digests.
- Procedural skill drafts capture reusable workflows from successful runs.

The next useful adaptation is not another store. It is a resolver and trace vocabulary that tells agents which memory lane they used, whether they searched local durable memory before external tools, and which source has authority when lanes disagree.

## Rejected Adaptations

### Rejected: Install GBrain As A Runtime Dependency

Reason: it would create a second long-term-memory system next to NyxHive's graph, knowledge, compiled knowledge, and procedural memory. The immediate risk is duplicate truth and ambiguous write ownership.

Better follow-up: optional GBrain MCP/client integration can be considered later as an external knowledge source behind NyxHive's tool permission model, but only after there is a lane contract that says when external brain content outranks or defers to local NyxHive memory.

### Rejected: Mandatory Every-Message Enrichment Writes

Reason: NyxHive already extracts memory and procedural skill drafts. Forcing every inbound message into write-oriented enrichment would increase cost, privacy exposure, and false-positive memory writes.

Better follow-up: shadow-mode signal detection that emits trace/audit candidates first, then promotes only high-confidence corrections, entities, and reusable procedures under existing extraction controls.

### Rejected: Hard-Code GBrain's Model Recommendations

Reason: the referenced GBrain docs suggest example model families for sub-agent categories. NyxHive already supports provider routing, tiers, CLI fallback, circuit breakers, and deployment-specific config. Hard-coding external model names would fight that architecture.

Better follow-up: map "cheap detector," "research executor," "top-tier synthesizer," and "long-context structured output" to NyxHive task types and configured model categories instead of fixed vendors.

## Follow-Up Proposals

### Proposal 1: Context Resolver For Brain-Like Procedures

Goal: add a resolver layer that decides which procedural guidance to inject, while keeping the base system prompt thin.

Files:

- `src/queue/system-prompt-builder.ts`
- `src/agents/procedural-skills.ts`
- `src/agents/skill-loader.ts`
- `src/memory/retrieval-trace.ts`
- Tests in `src/__tests__/system-prompt-builder.test.ts` and `src/__tests__/skill-loader.test.ts`

Plan:

1. Define a small resolver contract: inputs are agent key, task type, channel, file paths, keywords, entity hints, and delegation depth.
2. Return zero or more procedural snippets with labels such as `brain_first_lookup`, `source_precedence`, `delegation_decision_card`, and `signal_capture_shadow`.
3. Inject only resolver-selected snippets as `AssemblyPart` entries with token estimates.
4. Keep initial snippets documentation-only and non-behavioral: they tell agents how to reason, but do not add tools or automatic writes.
5. Add trace assertions showing which resolver snippets were injected and which were skipped.

Acceptance criteria:

- Existing prompts remain stable unless the resolver finds a matching task/channel.
- Prompt traces show resolver decisions, token cost, and source skill names.
- No new mandatory prompt block is added to every invocation.

### Proposal 2: Shadow Signal Detector For Memory Candidates

Goal: adapt GBrain's every-message signal detection without turning it into automatic memory writes.

Files:

- `src/queue/memory-extraction.ts`
- `src/queue/procedural-skill-extraction.ts`
- `src/memory/graph.ts`
- `src/memory/traces.ts`
- `src/providers/router.ts`
- Tests in `src/__tests__/memory-extraction-hook.test.ts`, `src/__tests__/procedural-skill-extraction.test.ts`, and `src/__tests__/traces-cost.test.ts`

Plan:

1. Add a shadow signal detector that classifies inbound messages into candidate signals: entity mention, user correction, explicit preference, decision, original idea, reusable workflow, or no signal.
2. Run it asynchronously after the main response path, using the cheapest configured model category that passes a detector capability check.
3. Emit a trace/audit event with the candidate type, confidence, source channel, and proposed memory lane.
4. Keep writes behind existing extraction gates in the first implementation.
5. Add metrics for detector cost, latency, precision proxy, and skipped trivial messages.

Acceptance criteria:

- The detector never blocks the user response.
- Trivial messages do not produce memory write candidates.
- Candidate output is auditable and can be reviewed before any new promotion behavior is enabled.
- Existing memory extraction tests still pass with detector disabled.

### Proposal 3: Brain-First Lookup Policy Before External Enrichment

Goal: make local durable memory the first stop for people, companies, projects, concepts, and prior user decisions before agents call external search or API tools.

Files:

- `src/queue/knowledge-search.ts`
- `src/queue/system-prompt-builder.ts`
- `src/memory/retrieval-trace.ts`
- `src/agents/tools.ts`
- Tests in `src/__tests__/knowledge-search.test.ts`, `src/__tests__/processor-trust.test.ts`, and `src/__tests__/tools.test.ts`

Plan:

1. Add a prompt-level policy block only when the task context or classifier suggests entity/world-knowledge lookup.
2. Add trace fields that distinguish `local_memory_checked`, `local_memory_hit`, and `external_lookup_after_local_miss`.
3. For tool calls, add audit-only warnings when external web/search/API tools are used without a local retrieval trace in the same turn.
4. Do not block external tools in the first pass; collect evidence of false positives first.
5. Later, consider enforcement only for agents whose tool permissions mark external enrichment as privileged.

Acceptance criteria:

- Audit logs can answer whether local knowledge was checked before external lookup.
- Agents still can use external tools when local memory is stale, absent, or insufficient.
- No behavior change to unrelated coding tasks.

### Proposal 4: Delegation Decision Cards

Goal: give subagents the decision scaffold that GBrain skills provide, without bloating every system prompt.

Files:

- `src/queue/delegation-executor.ts`
- `src/queue/delegation-synthesis.ts`
- `src/queue/delegation.ts`
- `src/memory/routing.ts`
- Tests in `src/__tests__/delegation-envelope.test.ts`, `src/__tests__/delegation-executor.test.ts`, and `src/__tests__/routing-store.test.ts`

Plan:

1. Extend delegation envelopes with an optional compact card:
   - classified task type and tier
   - selected agent/model role
   - already-checked context sources
   - forbidden duplicate work
   - expected output shape
   - verification or citation requirements
2. Emit the card only for orchestrator, research, analysis, expert, and code-review tasks.
3. Record whether the delegated result satisfied the card requirements in routing outcomes or review metadata.
4. Use that metadata to improve learned routing suggestions.

Acceptance criteria:

- Delegation envelopes stay under the existing token discipline caps.
- Subagents get task-specific requirements instead of generic "do the work" prompts.
- Routing outcomes gain a signal for "right agent, wrong scaffold" versus "wrong agent."

### Proposal 5: Source Precedence And Conflict Trace

Goal: make provenance and conflict handling explicit across injected knowledge, graph memory, compiled digests, and external enrichment.

Files:

- `src/memory/retrieval-trace.ts`
- `src/queue/knowledge-search.ts`
- `src/memory/compiled-knowledge.ts`
- `src/memory/graph.ts`
- Tests in `src/__tests__/knowledge-search.test.ts`, `src/__tests__/compiled-knowledge.test.ts`, and `src/__tests__/graph-memory.test.ts`

Plan:

1. Define source authority labels such as `user_direct`, `primary_artifact`, `compiled_digest`, `timeline_or_event`, `graph_inferred`, `external_api`, and `web`.
2. Populate labels in traces where the source is known.
3. Add prompt guidance only when conflicting sources are present.
4. Keep ranking unchanged in the first pass; this is telemetry and prompt guidance only.
5. Add a later benchmark that verifies user corrections and primary artifacts outrank external enrichment in synthesized answers.

Acceptance criteria:

- Trace output can explain source authority and conflicts.
- Prompt guidance tells agents to surface contradictions instead of silently resolving them.
- No existing retrieval ordering changes until benchmark coverage exists.

## Recommended Sequence

1. Land Proposal 1 as traceable prompt-resolver plumbing with one or two inert snippets.
2. Add Proposal 4 for delegation decision cards because NyxHive already has the delegation envelope and review/routing outcome loops.
3. Add Proposal 3 as audit-only local-before-external telemetry.
4. Add Proposal 5 source precedence telemetry and conflict prompt guidance.
5. Trial Proposal 2 in shadow mode once there is a cost budget and false-positive review surface.

This sequence adapts the useful agent-brain patterns without destabilizing the current memory stack or making every message more expensive by default.

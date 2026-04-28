# NyxHive Memory Stack Review

Date: 2026-04-11
Scope: review only. Do not change core memory behavior in this pass.

## Summary

NyxHive already has a practical working-memory and long-term-memory split, but the split is implicit in code rather than documented as an operating contract.

Working memory is the active conversation context assembled from recent messages, rolling summaries, context-pressure compaction, and prompt-time knowledge injection. Long-term memory is spread across graph memory, extracted conversation memories, vector/FTS knowledge chunks, compiled knowledge digests, procedural skill drafts, and outcome/pattern/routing stores.

The largest follow-up opportunity is not a new memory store. It is a calibration and measurement loop:

1. Make the memory-lane contract explicit.
2. Normalize retrieval/scoring telemetry across conversation, graph, knowledge, compiled-digest, and procedural-memory lanes.
3. Add replayable quality benchmarks that cover both working-memory retention and long-term-memory retrieval, not only unit-level ranking.

## Current Stack

### Working Memory

- `src/queue/conversation.ts` owns conversation persistence and live history loading.
- `src/context/budget.ts` builds the prompt-time context window from stored messages and rolling summaries, including `fresh_context`, `inject`, history ratio, recent-message, summary, and code-strip strategies.
- `src/context/compaction.ts` implements a pressure model with green/yellow/orange/red bands, summary-aware token estimates, importance-based eviction, red-band emergency trim, and optional summary-first context strategy overrides.
- `src/context/scoring.ts` scores individual messages for compaction retention using user constraints, delegation references, tool outcomes, decisions, error/fix context, file/action references, recency, explicit learn tags, and repeated-info penalties.
- `src/memory/store.ts` persists messages, summaries, importance-score cache, message FTS, context traces, and context artifact metadata.

Working-memory behavior is reasonably bounded and tested, but it is not formally described as a tier. This makes it easy for future work to over-inject durable memory or misclassify a summary as long-term truth.

### Long-Term Memory

- `src/memory/graph.ts` stores typed memory nodes and edges, including facts, decisions, patterns, errors, preferences, observations, update/supersede/contradiction edges, recurring patterns, task-aware briefings, FTS retrieval, importance decay, and cross-conversation search.
- `src/queue/memory-extraction.ts` extracts memories through heuristic, learning-trigger, and LLM phases. It deduplicates through semantic matching, cross-links memories across conversations, and bridges extracted memories into the knowledge store as `conversation://...` chunks.
- `src/memory/knowledge.ts` stores embedded knowledge chunks with SQLite FTS prefiltering, vector reranking, priority, smooth access recency, access count, confidence, task-context relevance, federation shareability, sibling expansion helpers, and pruning.
- `src/queue/knowledge-search.ts` performs live prompt retrieval with query enrichment, confidence floor, injection gate, optional remote federation, sibling/path-tree expansion, graph expansion, context-artifact overview injection, and retrieval traces.
- `src/memory/compiled-knowledge.ts` maintains source-level digests and procedural workflow digests with lexical/path-aware scoring, stale audits, and prompt/tool formatting.
- `src/memory/procedural-skills.ts`, `src/memory/procedural-skill-analytics.ts`, `src/memory/patterns.ts`, `src/memory/outcomes.ts`, and `src/memory/routing.ts` form a separate operational/procedural memory surface.

The durable lanes are rich enough that adding another store would likely increase ambiguity unless the retrieval contract is tightened first.

## Retrieval And Scoring Assessment

### What Is Strong

- Working-memory compaction has explicit scoring and emergency behavior.
- Knowledge retrieval already uses FTS prefiltering before vector reranking, with full-scan fallback for smaller corpora.
- Knowledge chunks use priority, access count, confidence, and smooth recency decay.
- Task context is threaded into both knowledge ranking and graph briefings.
- Prompt retrieval produces structured traces through `src/memory/retrieval-trace.ts`.
- Graph expansion can surface related, superseding, and contradicting memories after knowledge retrieval.
- Compiled digests provide a second durable lane above raw chunks.

### Gaps

- There is no single vocabulary for memory lanes. "Memory" can mean recent messages, extracted free-form memories, graph nodes, vector knowledge, compiled digests, procedural drafts, routing history, or context artifacts.
- Scoring is split by lane. Message scoring, graph relevance, knowledge ranking, and compiled digest ranking all use different formulas and telemetry shapes.
- Knowledge and graph task-relevance formulas are similar but duplicated, which raises drift risk.
- Compiled digests are ranked with lexical/path heuristics rather than the same trace/scoring model used by chunk retrieval.
- Retrieval feedback is a keyword-overlap proxy against agent responses. It is useful, but it does not distinguish "not referenced because irrelevant" from "not referenced because the agent silently used it."
- Graph expansion starts from exact content matches to retrieved chunks. This works for bridged memories and exact chunk copies, but it is fragile when the graph node and chunk content are semantically equivalent but textually different.
- There is no diversity/MMR layer in the final injected set. Sibling expansion helps document continuity, but the top results can still over-concentrate around one source.
- Context traces capture prompt assembly, but benchmark assertions do not yet treat traces as a first-class acceptance artifact.

## Benchmark Coverage

### Existing Coverage

- `src/__tests__/compaction.test.ts` covers message importance scoring, eviction preservation, pressure signals, summary hygiene, emergency recovery, and strategy overrides.
- `src/__tests__/context.test.ts` covers context window construction, summary injection, strategy caps, and budget metrics.
- `src/__tests__/knowledge-eval.test.ts` provides a deterministic recall/MRR harness across decision, implementation, and operational query intents.
- `src/__tests__/knowledge-task-relevance.test.ts` checks task-aware boosting for file paths, keywords, task types, and category boosts.
- `src/__tests__/knowledge-tiering.test.ts` covers access recency, access count, confidence, stale pruning, FTS prefilter stats, and chunk identity.
- `src/__tests__/knowledge-search.test.ts` covers retrieval traces, confidence gating, context artifacts, retrieval feedback, and path-tree/sibling expansion.
- `src/__tests__/knowledge-graph-traversal.test.ts` covers one-hop and two-hop graph expansion, contradictions, superseded nodes, deduplication, caps, and ordering.
- `src/__tests__/compiled-knowledge.test.ts` and route/tool tests cover compiled digest storage, stale audit, formatting, and tool access.
- `scripts/benchmark-knowledge-search.ts` benchmarks search latency, scanned/reranked counts, and strategy mix over synthetic and selected live knowledge databases.

### Missing Coverage

- No replay benchmark proves that a long conversation retains specific old constraints, decisions, and open items after compaction plus summary injection.
- No end-to-end retrieval benchmark asserts which memory lane supplied an injected fact through `RetrievalTrace` or `AssemblyTrace`.
- No quality benchmark compares raw knowledge chunks versus compiled digests for the same query.
- No retrieval diversity benchmark detects when all injected chunks come from one source while another relevant source is available.
- No benchmark covers stale or contradictory durable memories as an end-to-end scenario.
- `scripts/benchmark-knowledge-search.ts` is performance-oriented and environment-specific. It is not exposed as an npm script and writes to a hard-coded local output directory.

## Follow-Up Proposals

### Proposal 1: Memory Lane Contract And Trace Baseline

Goal: make the working-memory/long-term-memory boundary explicit without changing behavior.

Files:

- Add `docs/plans/2026-04-11-memory-lane-contract.md`
- Optionally add a small exported type-only map in `src/memory/retrieval-trace.ts` if implementation later needs standardized lane names

Acceptance criteria:

- Defines lanes: `conversation_recent`, `conversation_summary`, `graph_memory`, `knowledge_chunk`, `compiled_digest`, `procedural_memory`, `context_artifact`, `routing_history`, and `outcome_pattern`.
- States whether each lane is mutable, durable, prompt-injected, tool-searchable, and eligible for pruning.
- Describes which lane owns truth when summary, graph node, chunk, and digest disagree.
- Documents that working-memory compaction must not silently promote content into long-term memory without extraction or explicit bridge logic.

Verification:

- Documentation-only in first pass.
- Later implementation can add trace snapshot tests, but should not alter ranking or prompt injection yet.

### Proposal 2: Shadow Scoring Telemetry For Retrieval Candidates

Goal: compare scoring across durable memory lanes before changing retrieval behavior.

Files:

- `src/memory/retrieval-trace.ts`
- `src/queue/knowledge-search.ts`
- `src/memory/compiled-knowledge.ts`
- Tests in `src/__tests__/knowledge-search.test.ts` and `src/__tests__/compiled-knowledge.test.ts`

Plan:

1. Add optional trace fields for lane, raw similarity, lexical score, recency factor, access factor, confidence factor, task factor, source path, and final score.
2. Populate those fields for knowledge chunks and compiled digests.
3. Keep existing ordering and gates unchanged.
4. Add tests that assert trace shape and factors, not changed result order.
5. Use the trace output to decide whether a later unified scorer or MMR pass is justified.

Acceptance criteria:

- Search results do not change.
- Trace output can explain why a candidate was injected, gated, or cut.
- Compiled digest injection becomes observable with the same trace vocabulary as knowledge chunks.

### Proposal 3: Replayable Memory Quality Benchmarks

Goal: turn memory regressions into measurable failures.

Files:

- Add `scripts/memory-quality-benchmark.ts`
- Add `src/__tests__/memory-quality-benchmark.test.ts` if a deterministic unit version is preferred
- Add package script `benchmark:memory`

Plan:

1. Add a deterministic working-memory replay with a long conversation containing old user constraints, a design decision, a tool failure/fix, a large assistant code block, and a late follow-up question.
2. Assert that context assembly retains required anchors after compaction and summary injection.
3. Add a long-term-memory corpus with raw chunks, compiled digests, graph relations, stale chunks, and contradictions.
4. Assert recall@k, MRR, diversity by source path, and trace lane coverage.
5. Emit JSON into a configurable output directory, defaulting to a temp or `data/benchmarks` path inside the repo, not a user-specific absolute path.

Acceptance criteria:

- Benchmark runs offline with deterministic embeddings.
- Fails on missing old constraints, missing accepted decisions, unflagged contradictions, or one-source result collapse.
- Reports per-lane hit rates so improvements can target the right layer.

### Proposal 4: Retrieval Diversity And Graph Linking Experiment

Goal: reduce prompt over-concentration without weakening precision.

Files:

- `src/queue/knowledge-search.ts`
- `src/memory/knowledge.ts`
- `src/__tests__/knowledge-search.test.ts`
- `src/__tests__/knowledge-graph-traversal.test.ts`

Plan:

1. Start with a shadow-only MMR/diversity score in retrieval traces.
2. Add trace-only detection of same-source concentration.
3. Add an experiment flag for final result diversification after the existing relevance gate.
4. Add a graph seed fallback that can find graph nodes by knowledge metadata or semantic bridge, not only exact content, if the trace data proves exact matching misses useful graph expansions.

Acceptance criteria:

- First PR is trace-only.
- Behavior-changing PR stays behind a config flag until quality benchmarks show no recall regression.
- Tests cover both "sibling continuity is useful" and "same-source collapse hides another relevant source."

## Recommended Sequence

1. Land Proposal 1 as documentation.
2. Add Proposal 3's deterministic benchmark harness before changing scoring behavior.
3. Add Proposal 2's shadow telemetry.
4. Use benchmark and trace output to decide whether Proposal 4 should change default ranking or remain opt-in.

This order keeps memory behavior stable while making the next behavioral change measurable.

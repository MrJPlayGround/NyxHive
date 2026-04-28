# Conversational Improvement First Sprint

## Baseline From Live Code

NyxHive already has the core separation pieces in place:

- runtime modes live in `src/runtime/mode.ts`
- prompt profile assembly lives in `src/queue/system-prompt-builder.ts`
- summary insertion and transcript budgeting live in `src/context/budget.ts`
- memory lane semantics live in `src/memory/lanes.ts`
- prompt and memory traces are stored through `MemoryStore.saveContextTrace`
- conversational eval and reporting scaffolds live in `src/runtime/conversation-evals.ts`, `src/runtime/conversation-benchmark.ts`, and `src/runtime/conversation-quality.ts`

The remaining first-sprint problem was not absence of architecture. It was boundary precision: several message shapes still crossed into the wrong runtime mode.

## Prompt Component Map

Prompt assembly now has explicit trace parts for:

- `platform_context`
- `current_date`
- `sender`
- `soul`
- `channel_context`
- `knowledge`
- `patterns`
- `routing`
- `graph_memory`
- `work_log`
- `active_delegations`
- `agentic_mode`
- `execution_policy`
- `operating_model`
- `clarification`
- `wisdom`
- `depth_guard`
- `context_pressure`
- `response_contract`
- `voice_guard`

`conversation_light` intentionally excludes generated platform context, date/live-fact boilerplate, channel guidance, learned patterns, routing, generic graph briefing, work log, active delegations, strict agentic contract, clarification, wisdom, depth guard, and context pressure.

Conversation still keeps the soul, useful speaker identity, selected knowledge if explicitly retrieved, compact conversation policy, compact reply shape, and the voice guard.

## Memory Lane Inventory

Executable memory lane semantics are in `src/memory/lanes.ts`.

Precedence:

1. `conversation_recent`
2. `durable_user_preference`
3. `conversation_summary`
4. `graph_memory`
5. `compiled_digest`
6. `knowledge_chunk`
7. `procedural_memory`
8. `routing_history`
9. `outcome_pattern`
10. `context_artifact`

Conversation mode allows recent conversation, durable preferences, summaries, graph memory, compiled digests, knowledge chunks, and context artifacts. It blocks procedural memory, routing history, and outcome patterns from surfacing as personal continuity.

Hybrid mode additionally allows `outcome_pattern`, but still blocks procedural memory. Agentic mode may use all lanes.

## First Sprint Change

Runtime mode selection now handles four conversational edge cases:

- unclassified normal user messages default to `conversation` instead of falling into agentic posture
- file references without explicit action can resolve to `hybrid`, so reflective comments about code do not automatically become edit requests
- ambiguous action follow-ups like `do it`, `same for...`, and `ship it` only escalate when the previous runtime mode was agentic
- live/current factual questions and handoff artifact requests escalate to `agentic` because they need fresh evidence or structured workflow output

This keeps conversation as the default surface while preserving deliberate escalation for work.

## Verification Targets

The relevant regression tests are:

- `src/__tests__/runtime-mode.test.ts`
- `src/__tests__/conversation-evals.test.ts`
- `src/__tests__/conversation-benchmark.test.ts`
- `src/__tests__/system-prompt-builder.test.ts`
- `src/__tests__/memory-lanes.test.ts`


# Phase 2 Conversational Quality Pass

## What Changed

Phase 2 targeted the places where conversation could still feel over-architected after runtime mode selection was fixed.

### Prompt Assembly

`conversation_light` now keeps only one runtime boundary block after the soul:

- no `[Reply shape]`
- no `[Voice guard]`
- no duplicate style guidance about warmth, filler openings, or voice

The soul remains the conversational voice authority. Runtime policy only says when not to escalate into tools, routing, repo inspection, or state changes.

### Summary Injection

Transcript summaries are now labeled as:

`[CONVERSATION SUMMARY — neutral compressed state, not dialogue, not a prior user or assistant turn]`

Speaker-prefixed summary lines are normalized from dialogue-like labels into notes:

- `Assistant:` becomes `Prior assistant note:`
- `Nyx:` becomes `Prior assistant note:`
- `User:` becomes `Prior user note:`

This keeps summary blocks informational instead of letting them masquerade as lived turns.

### Memory Lane Filtering

Conversation retrieval now gates stale or weak selective chunks before they can reach the model:

- blocked lanes still stay blocked in conversation mode
- stale, superseded, or expired chunks are gated in conversation mode
- weak selective chunks below confidence `0.55` are gated in conversation mode
- explicit durable preferences remain allowed when current

`context_artifact` also now sorts before blocked procedural/routing/outcome lanes, matching its conversational use as selected context rather than process memory.

## Regression Coverage

Added or tightened tests in:

- `src/__tests__/system-prompt-builder.test.ts`
- `src/__tests__/conversation-benchmark.test.ts`
- `src/__tests__/context.test.ts`
- `src/__tests__/memory-lanes.test.ts`

Focused verification command:

`bun test src/__tests__/conversation-quality.test.ts src/__tests__/conversation-evals.test.ts src/__tests__/memory-routes.test.ts src/__tests__/knowledge-search.test.ts src/__tests__/compaction.test.ts src/__tests__/context.test.ts src/__tests__/memory-lanes.test.ts src/__tests__/system-prompt-builder.test.ts src/__tests__/conversation-benchmark.test.ts`

Result: `114 pass, 0 fail`.


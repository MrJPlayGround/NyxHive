# Live Conversation Calibration

This pass turns the conversation runtime overhaul into an inspectable live calibration loop.

## Live Sampling

Use:

```bash
bun run conversation:quality NyxAI --limit=100
```

The report reads recent context traces, joins nearby user/assistant messages, and summarizes:

- runtime mode distribution
- prompt profile distribution
- memory lane frequencies
- median policy-to-soul ratio by profile
- legacy traces that predate runtime-mode fields
- possible conversation/hybrid/agentic misroutes
- reply-shape diagnostics for sampled assistant replies

The same report is exposed at:

```text
GET /api/memory/context/quality?limit=100
```

## Durable Eval Set

`src/runtime/conversation-evals.ts` contains a 36-case human-rated calibration set. It stores expected qualities, not exact expected wording, so it can catch behavioral drift without freezing Nyx's voice.

## Workspace Waiting State

The primary chat surface should show one human waiting state:

- `Nyx is thinking...`
- `Nyx is working...`
- `Nyx is checking context...`
- `Nyx is checking sources...`

Raw command/tool chatter stays in the trace/debug surface. The main chat only shows meaningful final tool evidence, file changes, or failures.

## Operating Rule

If future conversational quality dips, inspect the live report, trace composition, memory lane mix, recent history assembly, and soul strength before adding more prompt scaffolding.


# Conversation Quality — Design Doc

**Date:** 2026-03-08
**Goal:** Fix conversation degradation in long sessions. Make NyxHive hold context as well as Claude Code CLI.

## Problems

### P1: Summary Injection Creates Fake Exchanges
Summary is injected as a synthetic `user` message + hardcoded `assistant` acknowledgment ("Understood, I have the context..."). This pollutes conversation history with fake exchanges that agents may treat as real user input.

**Fix:** Replace with a single `system`-role context block. When APIs don't support system mid-conversation, use a clearly-marked `user` message with `[CONTEXT — do not respond to this]` framing. Remove the fake assistant acknowledgment entirely.

### P2: Budget Starvation on Small Models
`historyBudget = contextWindow * ratio - systemPrompt - responseReserve` can go negative. The `Math.max(1000, ...)` floor doesn't prevent the system prompt + reserve from exceeding the available window.

**Fix:** Compute available space as `contextWindow - systemPromptTokens - responseReserve`, then apply `budgetRatio` to the remainder. Floor at 500 tokens. If even 500 tokens aren't available, log a warning.

### P3: Message Ordering Race
`ORDER BY created_at DESC` with no tie-breaker. Same-millisecond messages have undefined order.

**Fix:** Add `id` as secondary sort: `ORDER BY created_at DESC, id DESC`.

### P4: Memory Extraction Fire-and-Hope
Extraction fails silently. No retry. Entire batch of learning is lost.

**Fix:** Add 1 retry with 2s delay on failure. Log at `error` level on second failure (not `warn`).

### P5: System Prompt Token Estimation Uses Heuristic
`conversation.ts:169` uses `Math.ceil(systemPromptLength / 3.5)` despite tiktoken being available.

**Fix:** Use `estimateTokens()` from `context/tokens.ts` (which uses tiktoken when available).

### P6: Summarization Prompt Loses Decision Rationale
Progressive summarization compresses "Use SQLite over PostgreSQL for cost savings" into "Using SQLite" over multiple cycles. The "why" evaporates.

**Fix:** Add explicit instruction in summarization prompt: "For each decision, preserve both WHAT was decided AND WHY." Add a `**Rationale Log:**` section to the structured output format.

## Non-Goals (avoid over-engineering)
- Summary versioning — adds complexity, summaries are already stored per-conversation
- Per-conversation summarization policy — config exists, just not well-exposed
- Conversation ID collision — existing warning is sufficient; API callers should send sender_id
- Cost transparency for summarization — traces already track this

## Implementation Plan

### Task 1: Fix summary injection (budget.ts)
Replace fake user/assistant summary exchange with a single clearly-marked context message.

### Task 2: Fix budget calculation (conversation.ts)
Reorder budget math so ratio applies to available space, not raw context window.

### Task 3: Use tiktoken for system prompt tokens (conversation.ts)
Replace `Math.ceil(systemPromptLength / 3.5)` with `estimateTokens()`.

### Task 4: Fix message ordering (store.ts)
Add `id DESC` tie-breaker to all ORDER BY clauses on messages table.

### Task 5: Add memory extraction retry (conversation.ts)
Single retry with 2s delay on extraction failure.

### Task 6: Improve summarization prompt (summarize.ts)
Add rationale preservation instruction and Rationale Log section.

### Task 7: Tests
- Budget starvation test (small context window, large system prompt)
- Summary injection format test (no fake assistant ack)
- Message ordering determinism test
- Memory extraction retry test
- Summarization rationale preservation test

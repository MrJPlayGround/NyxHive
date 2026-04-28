# Phase 3 Post-Action Continuity

## What Changed

Phase 3 targets the remaining tone split between ordinary conversation and replies after tool use.

### Tool Result To Final Reply

SDK and native API tool loops now add a short post-tool guidance message after tool results are returned to the model.

For conversation and hybrid turns, the guidance says:

- stay the same assistant after using tools
- use tool output as background
- do not wrap light answers as completion reports
- mention evidence only when it changes the answer

For execution turns, the guidance keeps the existing closeout discipline but blocks tool-sequence retelling and operator-log prose.

### Hybrid Reflection

Hybrid mode now uses `[Reflection mode]` and `[Reflection shape]` instead of the old thinking/execution-ish wording.

Hybrid prompts no longer inject the Nyx operating model block or the implementation closeout contract. They preserve judgment, taste, and direct advice without pushing reflective conversations into workflow/report posture.

### Evaluation

Added a `post_action_continuity` evaluator family and diagnostics for:

- operator log leakage (`tool result`, `stdout`, `stderr`, raw output, exit code)
- report-shaped completions for lightweight post-tool answers

The benchmark harness can now mark scenarios as `hadToolUse` and route those replies through post-action continuity checks instead of normal conversational reply-shape or task closeout diagnostics.

### Emotional/Social Coverage

The conversational eval set now includes:

- post-tool follow-up continuity
- user frustration about report-shaped replies
- low-energy short-version requests

## Acceptance Evidence

Focused regression coverage:

- `src/__tests__/post-action-continuity.test.ts`
- `src/__tests__/evaluation-spine.test.ts`
- `src/__tests__/invoke-sdk.test.ts`
- `src/__tests__/system-prompt-builder.test.ts`
- `src/__tests__/conversation-benchmark.test.ts`
- `src/__tests__/conversation-evals.test.ts`

Expected outcome: tool-using replies keep the same identity and no longer default to operator-log/report shape unless the task is truly execution-heavy.


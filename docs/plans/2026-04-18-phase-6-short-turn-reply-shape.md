# Phase 6 Short-Turn Reply Shape

## Purpose

Phase 6 is a narrow reply-shape pass. Phase 5 identified the highest-confidence live problem: short turns still receive too much ceremony.

The fix is not "make everything shorter." It is:

- short conversational turns should start with the answer
- low-energy turns should compress aggressively
- ordinary chat should avoid headings, bullet stacks, and summary labels
- short reflective turns should lead with the call, then nuance
- short post-tool follow-ups should translate results into prose, not reports

## What Changed

`src/runtime/reply-shape.ts` now detects two short-turn ceremony signals:

- `summaryOpening`: `Summary:`, `Short version:`, `TL;DR:`, `Recap:`, and `Bottom line:` openings
- `setupOpening`: setup-first openings such as "there are a few things", "at a high level", "here are", and "it depends"

`src/runtime/transcript-review.ts` now flags:

- `summary_framed_short_turn`
- `bullet_stack_short_turn`
- `setup_before_short_answer`
- `post_tool_structure_for_short_followup`

Low-energy detection also treats summary labels and headings as ceremony, even when the reply is not long enough to cross the older broad overstructure threshold.

`src/queue/system-prompt-builder.ts` now gives conversation-light turns an explicit short-turn shape constraint:

- plain natural prose
- no headings
- no bullet stacks
- no summary labels
- no setup framing
- no mini-briefing shape unless User explicitly asks for structure

Hybrid reflection now explicitly says short reflective turns should give the call in one direct sentence or paragraph before caveats.

`src/runtime/conversation-evals.ts` now includes Phase 6 eval cases for:

- one-line asks
- low-energy no-bullet asks
- hybrid short call-first answers
- short post-tool follow-ups
- yes/no-ish questions with no summary framing

## Transcript Comparison

Phase 5 live baseline on the NyxAI corpus:

- 61 samples
- 79 findings
- `brevity_discipline`: 29, `fix_now`
- `overstructure`: 20, `fix_now`
- `directness`: 30, `watch`, 27 likely false-positive action-framing hits

Phase 6 live rerun on the same pre-fix corpus:

```bash
bun run conversation:transcript-review NyxAI --limit=100 --max-per-category=2
```

Result:

- 61 samples
- 98 findings
- `overstructure`: 39, `fix_now`
- `brevity_discipline`: 29, `fix_now`
- `directness`: 30, `watch`, 27 noisy/action-framing findings

That increase is expected. The old corpus was generated before the Phase 6 prompt guidance, and the detector now sees subtle two-bullet and summary-framed short-turn ceremony that Phase 5 missed. This is a stricter baseline for future live conversations, not proof that model output got worse.

The deterministic movement check is in `src/__tests__/transcript-review.test.ts`: the same short-turn prompts with summary/bullet ceremony produce overstructure findings; the rewritten proportional prose versions remove that cluster.

## Next Live Check

After new conversations are generated with this prompt guidance, rerun:

```bash
bun run conversation:transcript-review NyxAI --limit=100 --max-per-category=2
```

The target movement is:

- fewer `bullet_stack_short_turn` findings
- fewer `summary_framed_short_turn` findings
- fewer `overexplained_short_turn` findings
- no increase in real directness failures

If those do not move after fresh traces, the next target is not another evaluator pass. It is likely the model/output side ignoring the conversation-light boundary.

# Phase 4 Transcript Calibration

## What Changed

Phase 4 adds a repeatable transcript-led review loop. The point is to stop tuning conversational quality only from architecture and start reviewing the actual lived transcript surface.

## Transcript Review Workflow

Use `buildTranscriptReview()` in `src/runtime/transcript-review.ts` on rows shaped like context trace samples:

- `trace_json` with runtime mode, prompt profile, prompt parts, diagnostics, and memory lanes
- `user_message`
- `assistant_response`
- optional `had_tool_use`

The review produces:

- normalized samples
- transcript-level findings
- counts by rubric dimension
- counts by issue

This is designed for comparing good and bad turns side by side with exact runtime evidence.

## Rubric

The rubric dimensions are:

- voice continuity
- emotional fit
- directness
- overstructure
- memory usefulness
- reflection quality
- post-tool naturalness
- social intelligence
- brevity discipline

These are intentionally human-facing. They describe what User notices in the transcript, not just what the prompt architecture did.

## New Diagnostics

Reply-shape diagnostics now track:

- word count
- paragraph count
- heading count
- overstructured replies
- overexplained replies

Transcript review also detects:

- overstructured low-energy replies
- frustration met with structure
- memory-reliant turns with no useful continuity lanes
- reflection that sounds like analysis middleware
- post-tool operator-log leakage

## Memory Usefulness Calibration

The review loop explicitly flags memory-reliant turns such as “does that match what I usually prefer?” when no useful continuity lane is present.

This does not loosen memory gates blindly. It gives future tuning a concrete failure signal when Phase 2 cleanliness becomes memory anemia.

## Eval Expansion

The conversation eval set now includes Phase 4 cases for:

- subtle overstructure
- memory-too-generic replies
- hybrid conviction
- social boundary humor

## Acceptance Evidence

Focused tests:

- `src/__tests__/transcript-review.test.ts`
- `src/__tests__/reply-shape.test.ts`
- `src/__tests__/conversation-evals.test.ts`

The intended use from here is transcript-first: collect real rows, run the review, inspect findings, then tune the smallest component responsible.


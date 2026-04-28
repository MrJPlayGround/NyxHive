# Phase 5 Transcript-Driven Calibration

## Purpose

Phase 5 turns transcript review from instrumentation into an operating loop. The rule is simple: review real conversation traces, rank recurring failures, tune the smallest responsible component, then re-run the same sample.

## Live Baseline

Command run on April 18, 2026:

```bash
bun run conversation:transcript-review NyxAI --limit=100 --max-per-category=2
```

Baseline result:

- 61 reviewable samples
- 79 transcript findings
- 20 overstructure findings
- 29 brevity discipline findings
- 30 directness findings

Top clusters:

- `brevity_discipline`: 29 findings, `fix_now`, responsible component: conversation reply-shape guidance
- `overstructure`: 20 findings, `fix_now`, responsible component: conversation reply-shape guidance
- `directness`: 30 findings, `watch`, responsible component: runtime mode routing; 27 are likely evaluator-mismatch/action-framing false positives

The first two clusters are the cleanest Phase 5 targets. Directness is useful but noisier because the batch includes legacy or unknown-mode traces and action-framing findings that may include evaluator mismatch.

## What Changed

`buildTranscriptCalibrationReport()` now produces:

- a curated review set from production-like trace rows
- per-sample runtime mode, prompt profile, injected prompt parts, memory lanes, tool-use marker, findings, and optional reviewer note
- recurring failure clusters grouped by issue family
- severity, confidence, likely false-positive hints, triage bucket, likely responsible component, and next action
- tuning targets sorted into `fix_now`, `watch`, and `probably_noise`

The review system now treats `compiled_digest` and `graph_memory` as useful continuity lanes for preference or continuity questions. This keeps Phase 2 memory cleanup from turning into false "memory absent" findings when the useful continuity source is a compiled digest rather than a raw durable preference lane.

Hybrid reflection now has a narrower runtime instruction: lead with the call when User asks what Nyx would do, and do not open with "it depends" or generic pros-and-cons framing. That tunes conviction without reopening the broader prompt architecture.

## How To Run The Loop

1. Collect recent traces from the active instance:

```bash
bun run conversation:transcript-review NyxAI --limit=100 --max-per-category=2 > /tmp/nyxhive-transcript-review.json
```

2. Inspect `reviewSet` first. Confirm the sample categories and prompt evidence make sense.

3. Inspect `clusters`. Pick the top 3 to 5 recurring clusters by triage, count, reviewer reality, and user-facing annoyance.

4. Add reviewer notes for noisy findings before changing code. A noisy finding should not drive prompt or memory tuning.

5. Tune the smallest responsible component:

- memory usefulness: retrieval lane selection or memory gate thresholds
- hybrid conviction: reflection mode/shape wording
- overstructure and brevity: conversation reply-shape guidance
- low-energy or frustrated fit: emotional-fit guidance
- post-tool stiffness: post-action continuity contract
- mode mismatch: runtime routing

6. Re-run the same command and compare clusters, not just total finding count.

## API Surface

The same report is available from:

```text
GET /api/memory/context/transcript-review?limit=100&max_per_category=2
```

Use the API for workspace views and the script for local calibration runs.

## Next Fix Target

The current real batch points at reply shape, not memory, as the first concrete quality target:

- reduce over-explained replies to short turns
- reduce headings and bullet stacks in ordinary conversation
- keep directness findings under watch until reviewed against current non-legacy traces

That is the right next move. Broad prompt rewrites are not justified by this baseline.

# Self-Improving Personal Runtime Baseline

Captured on 2026-04-23 from the live NyxHive instance data in `/home/user/dev/nyxhive/.nyxhive/data` using the report scripts from this branch. Raw JSON snapshots for this run are preserved under `/home/user/dev/nyxhive/.nyxhive/data/scratchpads/d4dc502d-095d-4822-952b-0e3925f60148/`.

## Runtime Posture

- Sample size: 67 recent context traces.
- Legacy runtime mix: `conversation=29`, `hybrid=19`, `agentic=19`.
- Product runtime mix: `conversation=37`, `execution=19`, `reflection=3`, `handoff_report=7`, `investigation=1`.
- Prompt profile mix: `conversation_light=29`, `agentic_heavy=25`, `agentic_standard=13`.
- Memory lanes injected: `compiled_digest=55`, `knowledge_chunk=2`, `graph_memory=1`.
- Median policy-to-soul ratio: `conversation_light=0.422`, `agentic_heavy=2.255`, `agentic_standard=6.343`.
- Possible misroutes: `11`.

### Phase-0 Metrics

- Conversational over-structure rate: `0.553` across `38` low-action turns.
- Accidental execution-mode rate on low-action turns: `0.184`.
- Delegation-overuse rate on low-action turns: `0`.
- Investigation missing-evidence rate: `0` with only `1` investigation sample in the current window.
- Workspace mode mismatch rate: `0.725`.
- Low-action memory token pressure median: `408` tokens.

## Transcript Review

- Review set size: `67`.
- Findings: `83`.
- Dominant failure dimensions: `directness=34`, `overstructure=30`, `brevity_discipline=19`.
- Dominant issue counts:
  - `overstructured_low_action_reply=16`
  - `missing_outcome_first_opening=16`
  - `bullet_stack_short_turn=14`
  - `missing_completion_evidence=6`
- Top clusters:
  - `directness` (`34`, `fix_now`) — reduce process-first openings in the responsible runtime mode.
  - `overstructure` (`30`, `fix_now`) — tighten short-turn reply-shape guidance.
  - `brevity_discipline` (`19`, `fix_now`) — lower ceremony for short answers and status checks.

## Memory Eval

- Starter eval suite: `4/4` passing.
- Token range across the suite: `67` to `143`.
- Passing cases:
  - `live-reload-permission`
  - `casual-chat-mode`
  - `sdk-adoption-stance`
  - `memory-next-step`

## Scheduler Yield

- `evolution:hourly-self-improvement` current state: `last_status=deferred`, `run_count=48`.
- Latest result: `Repo preflight deferred: default repo /home/user/dev/nyxhive has dirty working tree changes (?? docs/superpowers/plans/2026-04-23-hermes-v2-workspace-upgrade.md).`
- `task_outcomes` currently has no persisted self-improvement outcome rows, so the scheduler self-improvement yield rate is operationally unavailable from outcomes in this baseline. The live task state is therefore the current baseline signal: the loop is configured and active, but presently blocked by repo cleanliness rather than producing a successful improvement/no-op result.

## Comparison Note

Use this file plus the raw JSON snapshots as the baseline reference for Phases 1-3. Re-run:

- `bun run scripts/conversation-quality-report.ts --limit=120`
- `bun run scripts/transcript-review-report.ts --limit=120 --max-per-category=2`
- `bun run scripts/memory-eval-report.ts --json`

Compare the same metrics first:

- conversational over-structure rate
- accidental execution-mode rate on low-action turns
- workspace mode mismatch rate
- low-action memory token pressure median
- transcript findings by directness / overstructure / brevity
- memory eval pass rate

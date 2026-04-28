---
tags: [architecture, scheduler]
aliases: [Scheduler, Task Scheduler]
created: 2026-03-02
updated: 2026-03-12
importance: high
status: active
---

# Scheduler

Persistent cron and one-shot task scheduler. It runs server-side maintenance directly and queues agent work through the processor.

## Core Loop

`src/scheduler/index.ts`:
- Tick interval: configurable via `scheduler.tick_interval_ms` (default `60000`)
- Each tick: select enabled tasks with `next_run_at <= now`
- System tasks run in-process via `executeSystemTask()`
- Agent tasks run through `processor.processImmediate()`
- Duplicate execution is blocked per task id with `runningTasks`

## Default Automation Tasks

Default tasks are registered in `src/scheduler/bootstrap.ts`. They depend on `scheduler.automations`, proposal store availability, and crawl config.

| Cron | Task ID | Type | Description |
|------|---------|------|-------------|
| `0 */2 * * *` | `heartbeat:health-check` | agent | Cheap health pulse on the background agent |
| `0 9 * * *` | `heartbeat:daily-review` | agent | Daily ops review and escalation |
| `0 */4 * * *` | `dev:execute-approved` | system | Execute approved proposals |
| `30 */2 * * *` | `proposals:sync-merged` | system | Sync merged PR state back to proposals |
| `*/15 * * * *` | `proposals:reset-stale-reviewing` | system | Unstick proposals left in `reviewing` |
| `0 8 * * *` | `briefing:auto-review` | system | Auto-review pending proposals |
| `0 9 * * *` | `briefing:daily` | agent | Morning briefing with pre-fetched context |
| `0 3 * * 0` | `memory:maintenance` | system | Weekly memory and knowledge pruning |
| `0 2 * * 1` | `learning:distill-patterns` | system | Weekly pattern distillation |
| `0 10 * * 1` | `maintenance:drift-detection` | agent | Vault-vs-code drift check |
| `0 2 * * *` | `evolution:codebase-review` | agent | Nightly proposal creation loop |
| `0 11 * * 3` | `maintenance:vault-sync` | agent | Weekly vault sync audit |

Optional crawl tasks are added when crawl is enabled:
- `crawl:run-sources`
- `crawl:cleanup-stale`

## Adaptive Scheduling

`src/scheduler/adaptive.ts` handles interval changes for cron-backed tasks using three persisted columns on `scheduled_tasks`:
- `original_cron`
- `adjusted_cron`
- `consecutive_empty`

Rules:
- No findings: increment `consecutive_empty`
- After 3 consecutive empty runs: double the current interval
- Doubled intervals cap at weekly cadence
- Findings reset the task back to `original_cron`
- High-priority findings halve the original interval
- Halved intervals floor at every 4 hours

The scheduler wires this in after successful cron task completion. Empty runs are determined from the task response plus proposal output:
- Empty/trivial response and no proposals created: treated as no findings
- Any substantive response: treated as findings
- Proposals created by the scan: treated as high-priority findings

## Heartbeat Suppression

Heartbeat and similar low-signal cron tasks do not spam channels when they have nothing useful to say.

`src/scheduler/index.ts` suppresses responses like:
- `ok`
- `HEARTBEAT_OK`
- `No drift detected`
- `Nothing to report`

When a task resolves to one of those trivial all-clear responses and produces no proposals:
- `last_result` is stored as `[suppressed — nothing to report]`
- outbound delivery is skipped
- the run still counts as completed
- adaptive scheduling treats it as an empty pass

This is response-based suppression, not queue-state suppression.

## Drain Queue

Graceful shutdown drains in-flight work before process exit.

`src/queue/processor.ts` exposes `drain(timeoutMs = 10000)`:
- stops accepting new work
- waits for active agent-chain and thread-pool work to settle
- returns early if nothing is in flight
- times out cleanly and reports remaining work instead of hanging forever

`src/index.ts` uses this during shutdown after stopping the scheduler and before closing channels, stores, and databases.

## Task Execution Flow

1. `tick()` loads due enabled tasks ordered by `next_run_at`
2. Scheduler skips tasks already running and tasks deferred by budget gating
3. System tasks execute locally through `executeSystemTask()`
4. Agent tasks run through `processor.processImmediate()`, with heartbeat or briefing context injected when needed
5. On success, scheduler records result state, recalculates `next_run_at`, and then recalculates cron frequency for scheduled tasks through adaptive scheduling
6. On failure, scheduler applies exponential backoff and auto-disables tasks after 10 consecutive failures

One-shot tasks are disabled after execution.

## Proposal Maintenance

Per tick, when the proposal store is available:
- expire stale proposals
- archive old completed or failed proposals
- nudge pending proposals that have been idle too long

## On-Demand Triggers

- `GET /api/scheduler/tasks` — list scheduled tasks
- `POST /api/scheduler/tasks/:id/trigger` — run a task immediately

## Key Files

| File | Purpose |
|------|---------|
| `src/scheduler/index.ts` | Scheduler core, execution loop, suppression, adaptive wiring |
| `src/scheduler/bootstrap.ts` | Default task registration and scheduler migrations |
| `src/scheduler/adaptive.ts` | Interval classification and frequency adjustment rules |
| `src/scheduler/context-providers.ts` | Pre-fetched heartbeat and briefing context |
| `src/queue/processor.ts` | Immediate execution path and graceful drain |
| `src/server/routes/scheduler.ts` | Scheduler API routes |

## See Also

- [[Proposal Pipeline]]
- [[NyxHive System]]
- [[Agent Team]]

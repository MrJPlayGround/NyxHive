# NyxHive Control Logging Handoff For Opus

Date: 2026-04-11
Owner: User / NyxHive
Audience: Opus 4.6

## Context

Morph was originally made from NyxHive, but the two projects now evolve in parallel. Treat Morph as a reference, not as an upstream source of truth.

Reference path:

- `/home/user/work/acme/morph`
- relevant Morph files:
  - `hive/engine/src/gateway/src/pages/ControlStation.tsx`
  - `hive/engine/src/gateway/src/stores/control.ts`
  - `hive/engine/src/server/ws/register-handlers.ts`
  - `docs/plans/2026-04-11-morph-control-station-plan.md`

NyxHive already has its own gateway style and does not need Morph's full control-room/tab model. The useful idea to borrow is the operator-friendly logging/audit surface: recent logs, recent audit trail, quick filters, and enough context to understand what the gateway just did.

## Product Direction

Build a NyxHive-native control/logging view, not a Morph clone.

The page should answer:

1. Is the gateway healthy right now?
2. What did the gateway just log?
3. What audit events just happened?
4. Are there obvious warnings/errors?
5. Are core scheduled tasks failing?

Do not add Morph's full set of review tabs:

- no Memory Review tab
- no Skill Review tab
- no broad Automation Control clone
- no operator curl/sql help panel unless User explicitly asks
- no page structure that feels copied from Morph

## Recommended UX Shape

Use NyxHive gateway's existing visual language:

- compact dark panels
- existing `Card`, `Badge`, `Button`, `Skeleton`
- existing CSS variables from `src/gateway/src/index.css`
- 8px-or-less radius inherited from local components
- no decorative gradients/orbs
- no marketing copy
- dense operator copy only

Recommended route:

- `/control`
- nav label: `Control`
- nav icon: `Shield` or `ScrollText`

Alternative:

- Fold this into the current Settings > System tab if a new nav item feels too prominent.

Keep the first screen practical:

- top strip: status, audit count, recent errors/warnings, queue depth or core task count
- main left: Audit Explorer
- side/right: Recent Runtime Logs
- optional bottom/right: Core Task Health

## Data Sources In NyxHive

Use existing NyxHive RPCs where possible:

- `system.health`
- `system.doctor`
- `logs.recent`
- `logs.subscribe` / `logs.unsubscribe`
- `audit.list`
- `scheduler.list`

Small backend additions are acceptable if they stay focused:

- `audit.summary`
- parsed audit detail fields for future `http.outbound` rows
- basic filter expansion on `audit.list`
- `scheduler.core` only if it is materially simpler than filtering `scheduler.list` in the frontend

Do not introduce Morph-only backend concepts unless NyxHive already has those stores:

- `review.inbox`
- `memory.candidates.*`
- `skills.drafts.*`
- `skills.usage.weak`

## Logging Surface

Recent Runtime Logs should use `logs.recent` first.

Show:

- relative time
- level
- module if present
- message

Interactions:

- refresh button
- auto-refresh every 15-25 seconds
- optional live subscription later via `logs.subscribe`
- optional filters: level, search text

Avoid:

- giant raw log blobs
- terminal styling that prevents scanning
- storing logs in browser local storage

## Audit Surface

Audit Explorer should use `audit.list`.

Filters:

- time window: 15m, 1h, 24h, 7d
- quick chips: All, Messages, Security, Scheduler, Failures
- search text

If backend supports `http.outbound` later, include an HTTP chip and display parsed fields:

- method
- host
- path/redactedPath
- status
- durationMs
- outcome
- redacted request/response preview in an expandable row

For current NyxHive, make HTTP rows optional. Do not make the UI look empty or broken if no HTTP audit events exist.

## Backend Notes

Current NyxHive audit log supports basic rows:

- `id`
- `timestamp`
- `event`
- `channel`
- `sender_id`
- `agent`
- `detail`

If adding `audit.summary`, return:

```ts
{
  total: number;
  byEvent: Record<string, number>;
  byChannel: Record<string, number>;
  http?: {
    total: number;
    errors: number;
    topHosts: Array<{ host: string; count: number }>;
    slowest: unknown[];
  };
  latestTimestamp: number | null;
}
```

Keep sensitive data redacted by default. Do not expose raw auth headers, cookies, tokens, or unredacted request/response bodies.

## Current Codex Prep

Codex started a scoped logging-control pass before this handoff request. If those changes are still in the working tree, inspect them and either refine or replace them:

- `src/server/ws/register-handlers.ts`
- `src/gateway/protocol/methods.ts`
- `src/gateway/src/stores/control.ts`
- `src/gateway/src/pages/ControlStation.tsx`
- `src/gateway/src/App.tsx`
- `src/gateway/src/components/Layout.tsx`
- `src/__tests__/register-handlers.test.ts`

The intended scope of that pass was:

- add `audit.summary`
- make `audit.list` able to return parsed/redacted detail for future `http.outbound` rows
- add `scheduler.core`
- add a NyxHive `/control` page with runtime strip, audit explorer, recent logs, and compact core task health

Verification already run during the Codex pass:

- `bunx tsc --noEmit`
- `cd src/gateway && bun run build`
- `bun test src/__tests__/register-handlers.test.ts`

Opus should still re-run verification after making its own edits.

## Acceptance Criteria

- The result feels like NyxHive, not Morph.
- No Morph-only tabs or empty review surfaces are added.
- Recent logs are visible without leaving the browser.
- Audit events are filterable and readable.
- Existing System page behavior is not regressed.
- `system.health` / `system.doctor` fallbacks stay graceful.
- Build and focused backend tests pass.

## Suggested Implementation Path

1. Decide whether `/control` should be a new nav item or whether the logging surface belongs inside Settings > System.
2. Keep the first version logging-focused.
3. Reuse `logs.recent`, `audit.list`, and `system.health`.
4. Add only the small RPCs needed to avoid awkward client-side parsing.
5. Verify with:

```bash
bunx tsc --noEmit
cd src/gateway && bun run build
bun test src/__tests__/register-handlers.test.ts
```

# Hermes v2 Workspace Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the worthwhile parts of Hermes Workspace `v2.0.0` into NyxHive without flattening NyxHive into a cloned Hermes control surface.

**Architecture:** Recompose existing NyxHive workspace primitives into a Nyx-native control plane instead of importing Hermes screens wholesale. Keep chat/session/runtime ownership in NyxHive, add a first-class mission-control surface on top of current jobs/tasks/run/session APIs, and add targeted resilience fixes only where Hermes exposed a real product gap.

**Tech Stack:** TanStack Router, React, React Query, Bun, TypeScript, Nyx workspace server routes, existing Nyx gateway/session/scheduler APIs

---

## Decision

We should port parts of Hermes `v2.0.0`, but only three slices:

1. **Mission control as a first-class workspace surface**
2. **Live operations / agent registry visibility**
3. **Targeted runtime hardening around interrupts, partial history, and mission launch**

We should **not** port the landing/marketing pass, Hermes-specific theme direction, or the zero-fork architecture story. NyxHive already has its own runtime contract, identity layer, and gateway capability model. Copying those parts would be churn without leverage.

## Evidence Base

Hermes `v2.0.0` adds:
- `/conductor` and `/operations` routes backed by mission spawn/pause/kill flows and an agent registry surface.
- A mission launch path via `/api/conductor-spawn` that schedules orchestrator work as a job.
- Interrupt/history fixes in chat streaming state.
- Model sourcing that prefers configured local model metadata before raw gateway `/v1/models`.

NyxHive already has adjacent building blocks:
- Active run persistence in `src/nyx-workspace/src/server/run-store.ts`
- Crew/profile monitoring in `src/nyx-workspace/src/screens/crew/crew-screen.tsx`
- Jobs UI and scheduler proxy in `src/nyx-workspace/src/screens/jobs/jobs-screen.tsx` and `src/nyx-workspace/src/routes/api/nyx-jobs.ts`
- Tasks UI in `src/nyx-workspace/src/screens/tasks/tasks-screen.tsx`
- Gateway capability degradation in `src/nyx-workspace/src/server/gateway-capabilities.ts`
- Streaming dedupe/tool-pill persistence in `src/nyx-workspace/src/stores/chat-store.ts`
- Interrupted partial-response preservation in `src/nyx-workspace/src/screens/chat/hooks/use-streaming-message.ts`

That means the right move is **composition**, not transplant.

## What To Port

### 1. Nyx Mission Control

Port the idea behind Hermes Conductor, not the UI verbatim.

**Why it is worth porting**
- NyxHive currently spreads operator actions across `Dashboard`, `Jobs`, `Tasks`, `Profiles`, and live chat.
- We already track enough runtime state to support a single “launch, observe, intervene” surface, but the operator has to mentally stitch it together.
- This is the highest-value upgrade in the release.

**Nyx-native shape**
- New route: `/operations`
- Tabs or segmented views:
  - `Missions`: launch and track orchestrated work
  - `Crew`: live profiles/agents with status, recent activity, assigned load
  - `Runs`: active/pending/handoff/error run ledger
- Launch surface should prefer Nyx semantics:
  - goal
  - conversation mode
  - assignee/profile
  - model override
  - autonomy level
  - optional task/project linkage

**Do not copy**
- Hermes’ “office theater” visuals or persona naming
- Cron-as-mission-launch abstraction as the primary model

### 2. Live Operations / Agent Registry

Port the separate agent-operations view, but collapse it into Nyx’s profile/crew model.

**Why it is worth porting**
- Hermes is right that “agent registry” and “mission history” are separate concerns.
- NyxHive’s current `/profiles` + crew monitoring is informative but not operational. It tells you what exists, not what you can do next.

**Nyx-native shape**
- Merge current crew data with:
  - active run status
  - queued tasks count
  - scheduled jobs count
  - last error / last handoff
  - channel presence state where relevant
- Add actions only where Nyx has safe backing APIs:
  - open chat with profile
  - filter tasks/jobs by assignee
  - inspect active run
  - trigger or pause scheduler jobs tied to that profile
- Treat “pause/kill/steer live agent” as phase-2 work unless the underlying Nyx runtime exposes a clean control API. Do not fake these controls in the UI first.

### 3. Mission Launch Workflow

Port the workflow behind Hermes `conductor-spawn`, but rebase it onto Nyx’s scheduler/task/runtime model.

**Why it is worth porting**
- Hermes is exploiting something real: a single launcher that can kick off orchestrated work without the operator hand-building prompts in chat.
- NyxHive already wants this; it just currently leaks too much runtime shape to the user.

**Nyx-native shape**
- Route-level launch API in workspace, backed by Nyx scheduler/runtime endpoints
- One launch creates:
  - a scheduler task or isolated run target
  - a traceable mission record in workspace state
  - a link to session/run/task artifacts
- Use existing Nyx orchestration patterns and skills; do not import Hermes’ dispatch skill loader or `cron.add` fallback chain directly.

### 4. Regression Audit For Interrupts And Streaming History

This is not a big port, but it is worth the audit.

**Why it is worth porting**
- Hermes fixed a real class of failures: duplicate assistant turns, vanished partial text, and stale streaming state after interrupt.
- NyxHive already has defenses, but this area is fragile and user-visible.

**Nyx-native scope**
- Build a targeted regression matrix around:
  - manual interrupt during streaming
  - interrupt followed by immediate resend
  - tool-call stream that completes before render catches up
  - history refresh after interrupted partial completion
  - portable mode / capability-degraded mode
- Only patch code if the test matrix exposes a gap.

### 5. Bootstrap / Install Path

Port the principle, not Hermes’ shell installer.

**Why it is worth porting**
- Hermes is right that setup friction matters.
- NyxHive has runtime bootstrap pieces, but not a clean “stand this up from scratch” workspace-first path.

**Nyx-native shape**
- `nyx workspace start|stop|status`
- optional `nyx workspace doctor`
- a documented one-command bootstrap path for a fresh machine/profile

**Priority**
- Lower than Mission Control and Operations
- Still worth doing once the control plane exists

## What To Skip

Skip these unless they fall out incidentally during the work:

- Hermes landing-page refresh and hero marketing sections
- Hermes-Nous theme direction
- “zero-fork” messaging and architecture framing
- direct reuse of Hermes agent registry schema or fallback registry heuristics
- any UI that implies live pause/kill/steer if Nyx runtime cannot actually honor it

## File Structure And Responsibilities

### New likely files

- `src/nyx-workspace/src/routes/operations.tsx`
  - top-level route for the new control plane
- `src/nyx-workspace/src/screens/operations/operations-screen.tsx`
  - main screen shell
- `src/nyx-workspace/src/screens/operations/components/mission-launcher.tsx`
  - launch form and quick actions
- `src/nyx-workspace/src/screens/operations/components/mission-list.tsx`
  - active/recent missions
- `src/nyx-workspace/src/screens/operations/components/run-ledger.tsx`
  - active run inspection list
- `src/nyx-workspace/src/screens/operations/components/crew-ops-panel.tsx`
  - operational crew/profile cards
- `src/nyx-workspace/src/routes/api/operations/launch.ts`
  - mission launch endpoint
- `src/nyx-workspace/src/routes/api/operations/missions.ts`
  - list mission state for the UI
- `src/nyx-workspace/src/server/operations-store.ts`
  - persisted mission metadata if not already representable in scheduler alone
- `src/nyx-workspace/src/server/operations-adapter.ts`
  - translates between mission UI state and scheduler/run/task/session APIs

### Existing files to modify

- `src/nyx-workspace/src/screens/chat/components/chat-sidebar.tsx`
  - add `Operations` nav entry, potentially demote or regroup `Jobs`/`Profiles`
- `src/nyx-workspace/src/routes/profiles.tsx`
  - narrow this route back to profile management, or turn monitoring into an entrypoint redirect into Operations
- `src/nyx-workspace/src/routes/api/crew-status.ts`
  - extend payload with run-centric operational fields
- `src/nyx-workspace/src/server/run-store.ts`
  - expose filtered summaries for operations UI
- `src/nyx-workspace/src/routes/api/sessions/$sessionKey.active-run.ts`
  - confirm it returns enough metadata for operations views; extend if needed
- `src/nyx-workspace/src/routes/api/nyx-jobs.ts`
  - support mission-linked job queries if necessary
- `src/nyx-workspace/src/routes/api/nyx-jobs.$jobId.ts`
  - support richer inspection of triggered jobs if necessary
- `src/nyx-workspace/src/stores/chat-store.ts`
  - only if interrupt regression tests expose a remaining dedupe/history edge
- `src/nyx-workspace/src/screens/chat/hooks/use-streaming-message.ts`
  - only if interrupt regression tests expose a remaining partial-preservation edge

### Test files to add or extend

- `src/nyx-workspace/src/server/run-store.test.ts`
- `src/nyx-workspace/src/screens/chat/workspace-ux-state.test.ts`
- `src/nyx-workspace/src/screens/chat/components/stream-activity.test.ts`
- `src/nyx-workspace/src/stores/chat-store.test.ts` or nearest existing coverage file
- `src/nyx-workspace/src/screens/operations/operations-screen.test.tsx`
- `src/nyx-workspace/src/routes/api/operations/launch.test.ts`
- `src/nyx-workspace/src/routes/api/crew-status.test.ts`

## Implementation Phases

### Phase 1: Establish the Nyx-native control plane

**Outcome**
- Workspace gets a first-class `/operations` route
- Sidebar and navigation reflect that this is the operational hub
- Existing `Jobs`, `Tasks`, `Profiles`, and run state stop feeling like disconnected islands

**Tasks**
- Add the new route and screen shell
- Decide final information architecture:
  - `Operations` as the main operator hub
  - `Profiles` reserved for profile/config concerns
  - `Jobs` and `Tasks` remain dedicated screens but are deep-linked from Operations
- Build the screen around existing APIs first; no new runtime semantics yet

**Primary files**
- `src/nyx-workspace/src/routes/operations.tsx`
- `src/nyx-workspace/src/screens/operations/operations-screen.tsx`
- `src/nyx-workspace/src/screens/chat/components/chat-sidebar.tsx`
- `src/nyx-workspace/src/routes/profiles.tsx`

**Verification**
- Route renders in desktop and mobile nav
- Existing screens still navigate correctly
- `bun test`
- `bun run typecheck`

### Phase 2: Build mission launch and mission history

**Outcome**
- User can launch structured work from Operations
- Mission list shows state transitions and links to the underlying session/run/job/task

**Tasks**
- Define a Nyx mission record shape:
  - `id`
  - `goal`
  - `mode`
  - `profile`
  - `model`
  - `createdAt`
  - `status`
  - `sessionKey`
  - `runId`
  - `jobId`
  - `taskIds`
- Implement `operations-adapter` to translate launch requests into scheduler/runtime actions
- Create list API and UI for active/recent missions
- Decide retention model:
  - persisted JSON alongside workspace state is enough for v1
  - no DB migration unless the state model clearly outgrows file storage

**Primary files**
- `src/nyx-workspace/src/routes/api/operations/launch.ts`
- `src/nyx-workspace/src/routes/api/operations/missions.ts`
- `src/nyx-workspace/src/server/operations-store.ts`
- `src/nyx-workspace/src/server/operations-adapter.ts`
- `src/nyx-workspace/src/screens/operations/components/mission-launcher.tsx`
- `src/nyx-workspace/src/screens/operations/components/mission-list.tsx`

**Verification**
- Launch creates a mission record and usable runtime target
- Mission list survives refresh
- Failure path surfaces actionable error text
- `bun test`
- `bun run typecheck`

### Phase 3: Upgrade crew monitoring into operations-grade visibility

**Outcome**
- Crew data becomes operational, not just descriptive
- Operator can answer “who is busy, on what, and what should I inspect next?” from one screen

**Tasks**
- Extend crew status payload with:
  - active run count
  - latest run summary/status
  - queued job count
  - last failure/handoff metadata
  - assigned task load
- Build ops cards/table optimized for triage
- Deep-link every row into:
  - active chat/session
  - filtered tasks
  - filtered jobs
  - run ledger

**Primary files**
- `src/nyx-workspace/src/routes/api/crew-status.ts`
- `src/nyx-workspace/src/screens/operations/components/crew-ops-panel.tsx`
- `src/nyx-workspace/src/server/run-store.ts`

**Verification**
- Crew screen shows accurate linked operational state
- Data degrades cleanly when jobs or sessions APIs are unavailable
- `bun test`
- `bun run typecheck`

### Phase 4: Add run ledger and intervention entry points

**Outcome**
- Workspace can inspect active and recent runs as first-class objects
- Operator gets a clean path into intervention without pretending we have controls we do not

**Tasks**
- Build run ledger from `run-store`
- Show:
  - lifecycle events
  - thinking/tool progress summaries
  - current status
  - stalled/error/handoff flags
- Add safe actions only:
  - open session
  - refresh status
  - copy identifiers
  - inspect logs/details
- Gate any real interrupt/steer controls on actual runtime support

**Primary files**
- `src/nyx-workspace/src/screens/operations/components/run-ledger.tsx`
- `src/nyx-workspace/src/server/run-store.ts`
- `src/nyx-workspace/src/routes/api/sessions/$sessionKey.active-run.ts`

**Verification**
- Long-running turns appear in ledger with live-ish refresh
- Error/handoff states are clearly distinguishable
- `bun test`
- `bun run typecheck`

### Phase 5: Interrupt and history hardening audit

**Outcome**
- We either prove NyxHive already covers Hermes’ fixes, or we close the remaining gap with tests first

**Tasks**
- Add regression coverage for:
  - interrupted partial response stays visible
  - no duplicate assistant message after interrupt + retry
  - tool pills survive history reload
  - final message replaces tagged/partial interim content cleanly
  - portable mode does not double-append user messages
- Patch only if a test fails

**Primary files**
- `src/nyx-workspace/src/screens/chat/hooks/use-streaming-message.ts`
- `src/nyx-workspace/src/stores/chat-store.ts`
- associated tests

**Verification**
- New regression suite passes
- No UX regression in normal streaming flow
- `bun test`
- `bun run typecheck`

### Phase 6: Bootstrap and operator ergonomics

**Outcome**
- Fresh-machine or fresh-profile setup stops being a bespoke ritual

**Tasks**
- Add CLI/runtime wrapper for:
  - `nyx workspace start`
  - `nyx workspace stop`
  - `nyx workspace status`
  - optional `nyx workspace doctor`
- Document bootstrap flow
- If needed, expose workspace health + capability summary in the command output

**Primary files**
- likely under `src/nyx/commands/` or current CLI entrypoints
- docs for workspace bootstrap and operations usage

**Verification**
- Commands work on a clean environment with clear failure modes
- `bun test`
- `bun run typecheck`

## Order Of Execution

Recommended order:

1. Phase 1: Operations route + IA
2. Phase 2: Mission launch/history
3. Phase 3: Crew ops upgrade
4. Phase 4: Run ledger
5. Phase 5: Interrupt/history audit
6. Phase 6: Bootstrap polish

That order matters. Without the Operations shell first, the rest becomes another pile of isolated features.

## Risks And Guardrails

### Risk: Copying Hermes UI shape too literally

**Guardrail**
- Reuse Nyx theme/tone/components
- Keep Nyx terminology
- Preserve current capability degradation patterns

### Risk: Faking runtime controls the backend cannot safely execute

**Guardrail**
- UI actions must map to real Nyx APIs
- If the backend cannot pause/kill/steer, show inspect/open actions only

### Risk: Over-coupling mission history to scheduler implementation

**Guardrail**
- Introduce a thin `operations-adapter`
- Treat scheduler/job/run/session as backing resources, not the UI contract itself

### Risk: Regressing chat history during interrupt work

**Guardrail**
- Test-first audit
- Do not “simplify” existing streaming state unless a failing case proves the current path is wrong

## Recommended Commit Boundaries

1. `feat: add operations workspace route`
2. `feat: add mission launch and history`
3. `feat: upgrade crew operations visibility`
4. `feat: add run ledger to operations`
5. `fix: harden interrupted streaming history`
6. `feat: add workspace bootstrap commands`

## Final Call

Hermes `v2.0.0` is worth mining for product shape, not for direct implementation. The right upgrade for NyxHive is a **Nyx-native Operations hub** built from our existing runtime/session/scheduler primitives, followed by a **mission launcher**, a **real run ledger**, and a **test-first interrupt audit**. Everything else is mostly release-note glitter.

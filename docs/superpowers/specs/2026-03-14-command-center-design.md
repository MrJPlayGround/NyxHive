# Command Center: Watchdog, Agent Roles & Home Redesign

**Date:** 2026-03-14
**Status:** Draft
**Scope:** Backend watchdog system, new agent roles, activity feed, Home page redesign

---

## 1. Watchdog System

### Problem
When an agent hangs or silently fails mid-task, nothing notices. The scheduler has per-task failure tracking (consecutive_failures, auto-disable at 10), but there's no mechanism to detect an agent that's *running but stuck* — no output, no heartbeat, just burning time.

### Design

**In-memory agent status tracking** (not SQLite — avoids unnecessary writes):

The agent registry currently has no `status` column. The gateway hardcodes `"idle"` for all agents. Instead of adding a DB column, track running agents in an in-memory map on `AgentRegistry`:

```typescript
// In-memory only — cleared on restart (which also kills any zombie processes)
private runningAgents = new Map<string, {
  startedAt: number;
  heartbeatAt: number;
  pid?: number;           // CLI subprocess PID for kill
  abortController?: AbortController;  // SDK request cancellation
  taskDescription?: string;
}>();
```

Methods: `markRunning(agent, opts)`, `markIdle(agent)`, `recordHeartbeat(agent)`, `getRunningAgents()`, `getStuckAgents(thresholdMs)`

**Heartbeat sources** by invocation method:
- **CLI** (`invoke-cli.ts`): Poll stdout pipe every 30s during subprocess wait. Any output = heartbeat. Also heartbeat on initial dispatch and on completion.
- **SDK** (`invoke-sdk.ts`): Heartbeat on dispatch, on each streaming chunk, and on completion.
- **Codex** (`invoke-codex.ts`): Same as CLI — poll stdout every 30s.

**Stuck detection** as a scheduler system task:
- New task: `watchdog:stuck-detection`, runs every 5 minutes, `agent = "system"`
- Calls `registry.getStuckAgents(threshold)` — returns agents where `Date.now() - heartbeatAt > threshold`
- Threshold per agent: `config.stuck_threshold_ms` or fallback to `timeout_ms` (which is task-type-aware for CLI — up to 2h for orchestrator tasks)
- When stuck detected:
  1. Kill the stuck process (PID for CLI, abort for SDK)
  2. Record failure in agent stats (`total_failures++`)
  3. Increment `consecutive_stuck` counter (in-memory on the map entry, persisted to a new DB column for cross-restart awareness)
  4. Emit `watchdog:stuck` WS event with agent name, duration, and action taken
  5. If the stuck agent was running a scheduler task, also increment that task's `consecutive_failures`
  6. Queue auto-retry with exponential backoff: `min(base_interval * 2^retry_count, 1h)`
  7. After 3 consecutive stuck detections for the same agent, disable the agent and emit `watchdog:disabled`

**Schema addition** (minimal — only for cross-restart persistence):
```sql
ALTER TABLE agents ADD COLUMN consecutive_stuck INTEGER DEFAULT 0;
```

**Config** (optional per-agent override):
```toml
[agents.researcher]
stuck_threshold_ms = 900000  # 15 minutes (default: timeout_ms)
max_stuck_retries = 3        # before auto-disable (default: 3)
```

### Files affected
- `src/agents/registry.ts` — add `runningAgents` map, `markRunning()`, `markIdle()`, `recordHeartbeat()`, `getStuckAgents()`, `consecutive_stuck` column migration
- `src/scheduler/bootstrap.ts` — register `watchdog:stuck-detection` task
- `src/scheduler/index.ts` — add `executeWatchdogCheck()` system task handler
- `src/queue/processor.ts` — call `markRunning()` on dispatch, `markIdle()` on completion
- `src/agents/invoke-cli.ts` — periodic heartbeat (30s interval) during subprocess wait
- `src/agents/invoke-sdk.ts` — heartbeat on streaming chunks
- `src/agents/invoke-codex.ts` — periodic heartbeat during subprocess wait
- `src/server/ws/register-handlers.ts` — update `agents.list` to return real status from `getRunningAgents()` instead of hardcoded "idle"

---

## 2. Activity Event Stream

### Problem
The Home page needs a live activity feed. Events already flow through the WS system (`system:health`, `proposals:*`, etc.) but there's no unified activity log that the frontend can subscribe to.

### Design

**Activity event type:**
```typescript
interface ActivityEvent {
  id: string;           // unique event ID
  type: "completion" | "proposal" | "delegation" | "watchdog" | "system" | "error";
  agent: string;        // agent name or "system"
  action: string;       // "completed" | "proposed" | "stuck" | "merged" | "reviewed" | etc.
  subject: string;      // human-readable subject (proposal title, PR name, etc.)
  detail?: string;      // optional secondary line (PR URL, test count, etc.)
  timestamp: number;
}
```

**Emission points** — add `emitActivity()` calls at existing event sites:
- `QueueProcessor.processMessage()` — on completion → `{type: "completion", action: "completed"}`
- `ProposalStore.approve/reject/markCompleted` — proposal lifecycle events
- `watchdog:stuck-detection` — on stuck/retry/disable
- `proposals:sync-merged` — on PR merge detection
- Scheduler task completion — for visible tasks (not system internals)

**WS broadcast:**
- New event: `activity:event` — broadcast to all connected clients
- Ring buffer: keep last 50 events in memory for initial load on connect
- New WS method: `activity.recent` — returns the ring buffer
- Event IDs: monotonically increasing counter (`activity-${++counter}`) for trivial frontend dedup
- Register `activity:event` in the WS event name types (extend the `EventName` union)

**No persistence.** Activity events are ephemeral — they exist in the WS stream and the in-memory ring buffer. The underlying data (proposals, agent stats, scheduler results) is already persisted elsewhere. The existing per-device replay buffer (`MAX_BUFFER_SIZE = 200`) in `ConnectionManager` will naturally capture `activity:event` broadcasts for reconnecting clients, so `activity.recent` only needs to cover cold-start scenarios.

### Files affected
- `src/server/ws/register-handlers.ts` — add `activity.recent` handler
- `src/queue/processor.ts` — emit activity on completion
- `src/proposals/store.ts` — emit activity on status changes
- `src/scheduler/index.ts` — emit activity on watchdog events
- New: `src/activity/ring-buffer.ts` — simple ring buffer (50 items, array-based)

---

## 3. New Agent Roles

### Problem
NyxHive currently has 3 agents (Nyx, Analyst, Tester). Adding more specialized roles is just config — no code changes needed. The agent registry, routing, and invocation already support arbitrary agent definitions.

### Design

Add to instance `config.toml` (canonical path, not legacy `config/nyxhive.toml`):

```toml
[agents.scout]
provider = "openrouter"
model = "google/gemini-2.0-flash-lite-001"
role = "worker"
capabilities = []
system_prompt = "You are a codebase scout. Analyze code for quality issues, test gaps, security concerns, and improvement opportunities. Emit [@propose: title | description] tags for each finding."

[agents.researcher]
provider = "openrouter"
model = "google/gemini-2.0-flash-001"
role = "worker"
capabilities = ["tool_use"]
system_prompt = "You are a deep research agent. Given a topic, crawl sources, synthesize findings, and produce structured knowledge summaries."
```

**Note:** Scout tasks already exist in the scheduler but run through the generic worker. Making Scout a named agent gives it its own stats, cost tracking, and visibility on the Home page. Same for Researcher — it's about surfacing the work, not changing the architecture.

**Bootstrap migration fix:** `src/scheduler/bootstrap.ts` has code that migrates tasks away from "dead" agents (including "scout" and "researcher"), reassigning them to the background agent. This migration must be updated to skip agents that are defined in config — otherwise it will immediately undo the new agent assignments on next boot.

### Files affected
- Instance `config.toml` — add agent definitions
- `src/scheduler/bootstrap.ts` — exclude config-defined agents from dead-agent migration

---

## 4. Home Page Redesign

### Current state
The Home page has: stat cards (uptime, queue, connections, memory, spent), pending proposals with approve/reject, active agents list, recently completed proposals, and an empty state.

### New layout

**Section 1: Instance Header**
- Instance avatar (first letter, violet gradient) + name (gradient text)
- Agent count + uptime subtitle
- Health badge (green/amber/red) + running agent count badge
- Replaces the plain "Home / System overview" heading

**Section 2: Agent Cards Grid**
- Responsive grid: `repeat(auto-fill, minmax(180px, 1fr))`
- Each card shows:
  - Avatar (colored initial, role-specific color)
  - Name + role label
  - Status dot (green=idle, amber=running, red=stuck)
  - Current task (truncated) + progress bar (for running agents — progress comes from `execution:event` WS events mapped by agent name)
  - Task count + cost (bottom footer)
- Running agents: colored border + top gradient line
- Stuck agents (watchdog): red border + warning icon + "Stuck Xm" text
- Data source: existing `useAgentsStore` (extended with status from `agents.list` WS method, which will now return real status instead of hardcoded "idle") + watchdog alerts from `watchdog:stuck` WS events

**Section 3: Stats Strip**
- Single row, segmented bar with 5 cells: Queue, Completed, Proposals, Spent Today, Memory
- Each cell: label (uppercase 8px), value (16px semibold), subtle background tint
- Replaces the current 5-card grid (same data, tighter layout)
- Data source: existing `Health` type + `useProposalsStore`

**Section 4: Two-Column Split**

Left: **Needs Attention** panel
- Unified list mixing pending proposals AND watchdog alerts
- Proposals: title, category badge, effort, age, inline Approve/Skip buttons
- Watchdog alerts: warning icon, stuck duration, auto-retry countdown, Retry Now/Kill buttons
- Red-tinted border, count badge in header
- Data source: `useProposalsStore` (pending) + new watchdog events from WS

Right: **Activity Feed**
- Live event stream with colored dots by event type
- Each entry: agent name (colored), action verb, subject, optional detail line, relative time
- "Live" indicator with pulsing green dot
- Auto-updates via `activity:event` WS subscription
- Shows last 8 events, "View all" links to Activity page
- Data source: new `activity.recent` WS method + `activity:event` subscription

### Component structure
```
HomePage
├── InstanceHeader          (new component)
├── AgentCardsGrid          (new component, replaces active agents section)
│   └── AgentCard           (new component)
├── StatsStrip              (new component, replaces stat cards grid)
├── NeedsAttentionPanel     (refactored from existing pending proposals)
│   ├── ProposalItem        (existing, restyled)
│   └── WatchdogAlertItem   (new component)
└── ActivityFeed            (new component)
    └── ActivityEvent       (new component)
```

### New Zustand store
```typescript
// src/gateway/src/stores/activity.ts
interface ActivityStore {
  events: ActivityEvent[];
  addEvent: (event: ActivityEvent) => void;
  setEvents: (events: ActivityEvent[]) => void;
}
```

### Files affected
- `src/gateway/src/pages/Home.tsx` — full rewrite
- New: `src/gateway/src/components/home/InstanceHeader.tsx`
- New: `src/gateway/src/components/home/AgentCard.tsx`
- New: `src/gateway/src/components/home/StatsStrip.tsx`
- New: `src/gateway/src/components/home/NeedsAttentionPanel.tsx`
- New: `src/gateway/src/components/home/WatchdogAlertItem.tsx`
- New: `src/gateway/src/components/home/ActivityFeed.tsx`
- New: `src/gateway/src/stores/activity.ts`
- `src/gateway/src/hooks/useWs.ts` — subscribe to `activity:event`

---

## 5. Implementation Order

1. **Activity ring buffer** — standalone module, no dependencies
2. **Watchdog system** — registry changes, scheduler task, heartbeat tracking
3. **Activity emission** — wire up `emitActivity()` at existing event sites
4. **Agent config** — add Scout + Researcher to config
5. **Home page** — new components, wired to existing stores + activity store
6. **Tests** — `ring-buffer.test.ts` (unit), `watchdog.test.ts` (stuck detection, auto-retry, auto-disable), `activity-emission.test.ts` (verify events emitted at each site)

---

## 6. What We're NOT Doing

- No persistent activity log (ring buffer is enough)
- No agent-to-agent direct messaging protocol (existing delegation tags work)
- No always-on agent processes (invocation-per-task model is correct)
- No complex health scoring (binary healthy/stuck is sufficient)
- No new pages — everything surfaces on the existing Home page

# Command Center Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add watchdog stuck-detection, activity feed, new agent roles, and redesign Home page as a command center.

**Architecture:** In-memory agent status tracking on `AgentRegistry` (no extra SQLite writes for heartbeats). Ring buffer for activity events broadcast over existing WS. Home page rebuilt as 4-section command center using existing Zustand stores + new activity store.

**Tech Stack:** TypeScript/Bun, Hono WS, React 19, Tailwind 4, Zustand, Lucide icons

**Spec:** `docs/superpowers/specs/2026-03-14-command-center-design.md`

---

## File Map

### New files
| File | Responsibility |
|------|---------------|
| `src/activity/ring-buffer.ts` | Generic ring buffer + ActivityEvent type + singleton with `emitActivity()` |
| `src/__tests__/ring-buffer.test.ts` | Ring buffer unit tests |
| `src/__tests__/watchdog.test.ts` | Watchdog stuck detection tests |
| `src/gateway/src/components/home/InstanceHeader.tsx` | Instance branding + health badge |
| `src/gateway/src/components/home/AgentCard.tsx` | Single agent card with status/progress |
| `src/gateway/src/components/home/StatsStrip.tsx` | 5-cell stats bar |
| `src/gateway/src/components/home/NeedsAttentionPanel.tsx` | Proposals + watchdog alerts |
| `src/gateway/src/components/home/WatchdogAlertItem.tsx` | Stuck agent alert with retry/kill actions |
| `src/gateway/src/components/home/ActivityFeed.tsx` | Live event stream |
| `src/gateway/src/stores/activity-feed.ts` | Activity feed event Zustand store (separate from existing audit-based `activity.ts`) |

### Modified files
| File | Change |
|------|--------|
| `src/agents/registry.ts` | Add `runningAgents` map, heartbeat methods, `consecutive_stuck` column |
| `src/scheduler/bootstrap.ts` | Register `watchdog:stuck-detection` task, fix dead-agent migration |
| `src/scheduler/index.ts` | Add watchdog system task handler |
| `src/queue/processor.ts` | Call `markRunning()`/`markIdle()`, emit activity events |
| `src/agents/invoke-cli.ts` | Heartbeat polling during subprocess wait |
| `src/agents/invoke-codex.ts` | Heartbeat polling during subprocess wait |
| `src/server/ws/register-handlers.ts` | Real agent status in `agents.list`, add `activity.recent` handler |
| `src/proposals/store.ts` | Emit activity on proposal lifecycle changes |
| `src/gateway/protocol/events.ts` | Add `activity:event` to `eventSchemas` |
| `src/gateway/src/pages/Home.tsx` | Full rewrite as command center |
| `src/agents/invoke-codex.ts` | Heartbeat polling during subprocess wait |
| `src/index.ts` | Initialize activity stream on server start |
| Instance `config.toml` | Add scout + researcher agent definitions |

---

## Chunk 1: Activity Ring Buffer

### Task 1: Ring Buffer Module

**Files:**
- Create: `src/activity/ring-buffer.ts`
- Create: `src/__tests__/ring-buffer.test.ts`

- [ ] **Step 1: Write failing tests for ring buffer**

```typescript
// src/__tests__/ring-buffer.test.ts
import { describe, it, expect } from "bun:test";
import { ActivityRingBuffer, type ActivityEvent } from "../activity/ring-buffer.js";

function makeEvent(id: string, agent = "nyx"): ActivityEvent {
  return { id, type: "completion", agent, action: "completed", subject: "test", timestamp: Date.now() };
}

describe("ActivityRingBuffer", () => {
  it("stores and retrieves events in order", () => {
    const buf = new ActivityRingBuffer(5);
    buf.push(makeEvent("1"));
    buf.push(makeEvent("2"));
    buf.push(makeEvent("3"));
    const items = buf.getAll();
    expect(items).toHaveLength(3);
    expect(items[0].id).toBe("1");
    expect(items[2].id).toBe("3");
  });

  it("evicts oldest when full", () => {
    const buf = new ActivityRingBuffer(3);
    buf.push(makeEvent("1"));
    buf.push(makeEvent("2"));
    buf.push(makeEvent("3"));
    buf.push(makeEvent("4"));
    const items = buf.getAll();
    expect(items).toHaveLength(3);
    expect(items[0].id).toBe("2");
    expect(items[2].id).toBe("4");
  });

  it("returns empty array when no events", () => {
    const buf = new ActivityRingBuffer(5);
    expect(buf.getAll()).toEqual([]);
  });

  it("handles single-capacity buffer", () => {
    const buf = new ActivityRingBuffer(1);
    buf.push(makeEvent("1"));
    buf.push(makeEvent("2"));
    expect(buf.getAll()).toHaveLength(1);
    expect(buf.getAll()[0].id).toBe("2");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/ring-buffer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ring buffer**

```typescript
// src/activity/ring-buffer.ts

export interface ActivityEvent {
  id: string;
  type: "completion" | "proposal" | "delegation" | "watchdog" | "system" | "error";
  agent: string;
  action: string;
  subject: string;
  detail?: string;
  timestamp: number;
}

export class ActivityRingBuffer {
  private items: ActivityEvent[] = [];
  private capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(event: ActivityEvent): void {
    if (this.items.length >= this.capacity) {
      this.items.shift();
    }
    this.items.push(event);
  }

  getAll(): ActivityEvent[] {
    return [...this.items];
  }
}

let counter = 0;

export function nextActivityId(): string {
  return `activity-${++counter}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/ring-buffer.test.ts`
Expected: 4 pass

- [ ] **Step 5: Type check**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/activity/ring-buffer.ts src/__tests__/ring-buffer.test.ts
git commit -m "feat: add activity ring buffer module"
```

---

## Chunk 2: Watchdog — Agent Status Tracking

### Task 2: In-Memory Running Agents Map on Registry

**Files:**
- Modify: `src/agents/registry.ts`
- Create: `src/__tests__/watchdog.test.ts`

- [ ] **Step 1: Write failing tests for agent status tracking**

```typescript
// src/__tests__/watchdog.test.ts
import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { AgentRegistry } from "../agents/registry.js";

function createRegistry(): AgentRegistry {
  const db = new Database(":memory:");
  return new AgentRegistry(db, {
    nyx: { provider: "anthropic", model: "sonnet", role: "lead" } as any,
    analyst: { provider: "openrouter", model: "flash", role: "worker" } as any,
  });
}

describe("Agent status tracking", () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = createRegistry();
  });

  it("agents start with no running state", () => {
    expect(registry.getRunningAgents()).toEqual(new Map());
  });

  it("markRunning tracks agent as running", () => {
    registry.markRunning("nyx", { taskDescription: "fixing bug" });
    const running = registry.getRunningAgents();
    expect(running.has("nyx")).toBe(true);
    expect(running.get("nyx")!.taskDescription).toBe("fixing bug");
  });

  it("markIdle removes agent from running", () => {
    registry.markRunning("nyx", {});
    registry.markIdle("nyx");
    expect(registry.getRunningAgents().has("nyx")).toBe(false);
  });

  it("recordHeartbeat updates heartbeatAt", () => {
    registry.markRunning("nyx", {});
    const before = registry.getRunningAgents().get("nyx")!.heartbeatAt;
    // Small delay to ensure timestamp differs
    registry.recordHeartbeat("nyx");
    const after = registry.getRunningAgents().get("nyx")!.heartbeatAt;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("getStuckAgents returns agents past threshold", () => {
    registry.markRunning("nyx", {});
    // Manually backdate the heartbeat
    const entry = registry.getRunningAgents().get("nyx")!;
    entry.heartbeatAt = Date.now() - 60_000; // 1 minute ago
    const stuck = registry.getStuckAgents(30_000); // 30s threshold
    expect(stuck).toHaveLength(1);
    expect(stuck[0][0]).toBe("nyx");
  });

  it("getStuckAgents excludes agents within threshold", () => {
    registry.markRunning("nyx", {});
    const stuck = registry.getStuckAgents(30_000);
    expect(stuck).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/watchdog.test.ts`
Expected: FAIL — methods don't exist

- [ ] **Step 3: Add running agents map and methods to AgentRegistry**

In `src/agents/registry.ts`, add after the class property declarations (around line 128):

```typescript
// In-memory only — cleared on restart (which also kills zombie processes)
private runningAgents = new Map<string, {
  startedAt: number;
  heartbeatAt: number;
  pid?: number;
  abortController?: AbortController;
  taskDescription?: string;
}>();
```

Add these methods to the class:

```typescript
markRunning(key: string, opts: { pid?: number; abortController?: AbortController; taskDescription?: string }): void {
  this.runningAgents.set(key, {
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
    ...opts,
  });
}

markIdle(key: string): void {
  this.runningAgents.delete(key);
}

recordHeartbeat(key: string): void {
  const entry = this.runningAgents.get(key);
  if (entry) entry.heartbeatAt = Date.now();
}

getRunningAgents(): Map<string, { startedAt: number; heartbeatAt: number; pid?: number; abortController?: AbortController; taskDescription?: string }> {
  return this.runningAgents;
}

getStuckAgents(thresholdMs: number): [string, { startedAt: number; heartbeatAt: number; pid?: number; abortController?: AbortController; taskDescription?: string }][] {
  const now = Date.now();
  const stuck: [string, typeof this.runningAgents extends Map<string, infer V> ? V : never][] = [];
  for (const [key, entry] of this.runningAgents) {
    if (now - entry.heartbeatAt > thresholdMs) {
      stuck.push([key, entry]);
    }
  }
  return stuck;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/watchdog.test.ts`
Expected: 6 pass

- [ ] **Step 5: Add `consecutive_stuck` DB column**

In `src/agents/registry.ts`:

1. Add `"consecutive_stuck"` to the `REQUIRED_COLUMNS` array
2. Add to `COLUMN_DEFS`: `consecutive_stuck: "INTEGER DEFAULT 0"`
3. The existing `ensureTableSchema` helper will handle the migration automatically

- [ ] **Step 6: Type check**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 7: Commit**

```bash
git add src/agents/registry.ts src/__tests__/watchdog.test.ts
git commit -m "feat: add in-memory agent status tracking with stuck detection"
```

---

### Task 3: Wire Status Tracking into Queue Processor

**Files:**
- Modify: `src/queue/processor.ts`

- [ ] **Step 1: Add markRunning call before agent invocation**

In `processForAgent()` (around line 956), before the `invokeAgent()` call, add:

```typescript
this.config.registry?.markRunning(agentKey, { taskDescription: message.content?.slice(0, 100) });
```

- [ ] **Step 2: Add markIdle call after agent invocation**

After the `invokeAgent()` call returns (in the same method), and also in the catch block:

```typescript
// In success path:
this.config.registry?.markIdle(agentKey);

// In catch block:
this.config.registry?.markIdle(agentKey);
```

- [ ] **Step 3: Broadcast agent:status events on state changes**

After `markRunning()`:
```typescript
this.emitEvent("agent:status", { agent: agentKey, status: "running", task: message.content?.slice(0, 100) ?? null });
```

After `markIdle()`:
```typescript
this.emitEvent("agent:status", { agent: agentKey, status: "idle", task: null });
```

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: All pass (no behavior change, just status tracking added)

- [ ] **Step 5: Commit**

```bash
git add src/queue/processor.ts
git commit -m "feat: wire agent status tracking into queue processor"
```

---

### Task 4: Heartbeat Polling in CLI Invocation

**Files:**
- Modify: `src/agents/invoke-cli.ts`

- [ ] **Step 1: Add heartbeat interval during subprocess wait**

In `invokeCLI()`, after the process is spawned (around line 520) and before stdout streaming begins, set up a heartbeat interval. The registry is not directly available in invoke-cli, so accept it via opts or use an `onHeartbeat` callback:

Add to the `InvokeOpts` type (in `src/agents/invoke.ts` or wherever defined):
```typescript
onHeartbeat?: () => void;
```

In `invokeCLI()`, after spawn:
```typescript
const heartbeatInterval = setInterval(() => {
  opts.onHeartbeat?.();
}, 30_000);
```

Before every return path (success and error), clear the interval:
```typescript
clearInterval(heartbeatInterval);
```

- [ ] **Step 2: Add same heartbeat interval in invoke-codex.ts**

In `src/agents/invoke-codex.ts`, apply the same pattern: `setInterval` calling `opts.onHeartbeat?.()` every 30s after process spawn, `clearInterval` before every return.

- [ ] **Step 3: Pass onHeartbeat from processor**

In `src/queue/processor.ts`, when building invocation opts, add:
```typescript
onHeartbeat: () => this.config.registry?.recordHeartbeat(agentKey),
```

- [ ] **Step 4: For SDK invocations, call recordHeartbeat on streaming chunks**

In `src/queue/processor.ts` (or wherever SDK streaming is handled), if using streaming, call `this.config.registry?.recordHeartbeat(agentKey)` on each chunk callback. For non-streaming SDK calls (which are short-lived), heartbeat is already covered by the `markRunning`/`markIdle` brackets — no separate heartbeat needed.

- [ ] **Step 5: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add src/agents/invoke-cli.ts src/agents/invoke-codex.ts src/agents/invoke.ts src/queue/processor.ts
git commit -m "feat: add heartbeat polling during agent invocation (CLI, Codex, SDK)"
```

---

### Task 5: Update agents.list to Return Real Status

**Files:**
- Modify: `src/server/ws/register-handlers.ts`

- [ ] **Step 1: Replace hardcoded "idle" with actual status**

At line 516 of `register-handlers.ts`, in the `agents.list` handler, replace:
```typescript
status: "idle" as const,
currentTask: null,
```

With:
```typescript
status: (() => {
  const running = deps.registry.getRunningAgents().get(key);
  return running ? "running" as const : "idle" as const;
})(),
currentTask: deps.registry.getRunningAgents().get(key)?.taskDescription ?? null,
```

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add src/server/ws/register-handlers.ts
git commit -m "feat: return real agent status in agents.list WS handler"
```

---

### Task 6: Watchdog Scheduler Task

**Files:**
- Modify: `src/scheduler/bootstrap.ts`
- Modify: `src/scheduler/index.ts`

- [ ] **Step 1: Register watchdog:stuck-detection in bootstrap**

In `src/scheduler/bootstrap.ts`, in the `loadDefaultHeartbeat()` function, add after the existing task registrations:

Follow the existing pattern in `loadDefaultHeartbeat()` — query for existing task first, then INSERT or UPDATE:

```typescript
const existingWatchdog = db.query("SELECT id FROM scheduled_tasks WHERE name = ?").get("watchdog:stuck-detection");
if (!existingWatchdog) {
  db.run(
    `INSERT INTO scheduled_tasks (name, agent, cron_expression, prompt, enabled, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["watchdog:stuck-detection", "system", "*/5 * * * *", "Check for stuck agents and auto-retry", 1, "system", new Date().toISOString(), new Date().toISOString()],
  );
}
```

Also add `"watchdog:stuck-detection"` to the `DEFAULT_SYSTEM_TASK_NAMES` constant (around line 32 in bootstrap.ts).

- [ ] **Step 2: Fix dead-agent migration to skip config-defined agents**

In the dead agent migration (lines 179-185), change:
```typescript
const deadAgents = ["heartbeat", "scout", "scribe", "forge", "researcher", "vigil"];
```
To:
```typescript
const configAgentKeys = Object.keys(config.agents ?? {});
const deadAgents = ["heartbeat", "scout", "scribe", "forge", "researcher", "vigil"]
  .filter(a => !configAgentKeys.includes(a));
```

The `config` object is available via `deps.config` (already destructured in `loadDefaultHeartbeat`).

- [ ] **Step 3: Add watchdog handler in scheduler index**

In `src/scheduler/index.ts`, in the `executeSystemTask()` switch statement (around line 632), add a new case:

```typescript
case "watchdog:stuck-detection": {
  const defaultThreshold = 30 * 60 * 1000; // 30 minutes
  const stuck = this.registry.getStuckAgents(defaultThreshold);
  if (stuck.length === 0) return "No stuck agents";

  const results: string[] = [];
  for (const [agentKey, entry] of stuck) {
    const duration = Math.round((Date.now() - entry.heartbeatAt) / 60_000);

    // Kill the process
    if (entry.pid) {
      try { process.kill(entry.pid, "SIGTERM"); } catch { /* already dead */ }
    }
    entry.abortController?.abort();

    // Record failure
    this.registry.markIdle(agentKey);
    this.registry.recordInvocation(agentKey, { tokensIn: 0, tokensOut: 0, success: false, costCents: 0 });

    // Update consecutive_stuck in DB
    this.db.run(
      "UPDATE agent_registry SET consecutive_stuck = consecutive_stuck + 1 WHERE key = ?",
      [agentKey],
    );

    const consecutiveStuck = (this.db.query("SELECT consecutive_stuck FROM agent_registry WHERE key = ?").get(agentKey) as any)?.consecutive_stuck ?? 0;

    // Broadcast event
    this.processor.emitEvent("agent:status", { agent: agentKey, status: "error", task: null });

    if (consecutiveStuck >= 3) {
      const disableResult = this.registry.disable(agentKey);
      if (!disableResult.success) {
        // Config-protected agents can't be disabled — just log
        results.push(`${agentKey}: stuck ${duration}m — config-protected, cannot disable (${consecutiveStuck} consecutive)`);
      } else {
        results.push(`${agentKey}: stuck ${duration}m — DISABLED (${consecutiveStuck} consecutive)`);
      }
    } else {
      results.push(`${agentKey}: stuck ${duration}m — killed, retry queued`);
    }
  }
  return results.join("\n");
}
```

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 5: Type check**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 6: Commit**

```bash
git add src/scheduler/bootstrap.ts src/scheduler/index.ts
git commit -m "feat: add watchdog stuck-detection scheduler task"
```

---

## Chunk 3: Activity Emission

### Task 7: Wire Activity Events to Existing Event Sites

**Files:**
- Modify: `src/queue/processor.ts`
- Modify: `src/proposals/store.ts`
- Modify: `src/scheduler/index.ts`
- Modify: `src/server/ws/register-handlers.ts`

- [ ] **Step 1: Create activity emitter helper**

Add to `src/activity/ring-buffer.ts`:

```typescript
import type { ConnectionManager } from "../server/ws/connection.js";

let globalBuffer: ActivityRingBuffer | null = null;
let globalBroadcast: ((event: string, payload: unknown) => void) | null = null;

export function initActivityStream(broadcast: (event: string, payload: unknown) => void, capacity = 50): ActivityRingBuffer {
  globalBuffer = new ActivityRingBuffer(capacity);
  globalBroadcast = broadcast;
  return globalBuffer;
}

export function emitActivity(event: Omit<ActivityEvent, "id" | "timestamp">): void {
  if (!globalBuffer) return;
  const full: ActivityEvent = {
    ...event,
    id: nextActivityId(),
    timestamp: Date.now(),
  };
  globalBuffer.push(full);
  globalBroadcast?.("activity:event", full);
}

export function getActivityBuffer(): ActivityRingBuffer | null {
  return globalBuffer;
}
```

- [ ] **Step 2: Register `activity:event` in WS event types**

In `src/gateway/protocol/events.ts`, add to the `eventSchemas` object:
```typescript
"activity:event": z.object({
  id: z.string(),
  type: z.enum(["completion", "proposal", "delegation", "watchdog", "system", "error"]),
  agent: z.string(),
  action: z.string(),
  subject: z.string(),
  detail: z.string().optional(),
  timestamp: z.number(),
}),
```

- [ ] **Step 3: Initialize activity stream on server start**

In `src/index.ts`, after ConnectionManager is created (look for where `connectionManager` is initialized), add:
```typescript
import { initActivityStream } from "./activity/ring-buffer.js";
// After connectionManager is created:
initActivityStream((event, payload) => connectionManager.broadcast(event as any, payload));
```

- [ ] **Step 3: Emit activity from queue processor**

In `src/queue/processor.ts`, after successful agent invocation (where `markIdle` is called):
```typescript
import { emitActivity } from "../activity/ring-buffer.js";

// After successful completion:
emitActivity({
  type: "completion",
  agent: agentKey,
  action: "completed",
  subject: message.content?.slice(0, 80) ?? "task",
});
```

- [ ] **Step 4: Emit activity from proposal store**

In `src/proposals/store.ts`, add emissions in `approve()`, `markCompleted()`, `reject()`. Each method does a DB update then returns `this.get(proposalId)`. Emit after the return value is confirmed non-null:

```typescript
import { emitActivity } from "../activity/ring-buffer.js";

// In approve(), after the DB update succeeds and before return:
const updated = this.get(proposalId);
if (updated) emitActivity({ type: "proposal", agent: approvedBy, action: "approved", subject: updated.title });

// In markCompleted(), after the DB update:
const updated = this.get(proposalId);
if (updated) emitActivity({ type: "proposal", agent: executedBy ?? "system", action: "completed", subject: updated.title, detail: prUrl ?? undefined });

// In reject(), after the DB update (reject has `reason` param, not `approvedBy`):
const updated = this.get(proposalId);
if (updated) emitActivity({ type: "proposal", agent: "system", action: "rejected", subject: updated.title });
```

- [ ] **Step 5: Emit activity from watchdog**

In the watchdog handler in `scheduler/index.ts` (Task 6), add after broadcasting agent:status:
```typescript
import { emitActivity } from "../activity/ring-buffer.js";

emitActivity({
  type: "watchdog",
  agent: agentKey,
  action: "stuck",
  subject: `${agentKey} stuck for ${duration}m`,
  detail: consecutiveStuck >= 3 ? "Auto-disabled" : "Killed, retry queued",
});
```

- [ ] **Step 6: Emit activity from proposals:sync-merged**

In `src/scheduler/index.ts`, in the `proposals:sync-merged` case of `executeSystemTask()`, after detecting a merged PR:
```typescript
emitActivity({ type: "system", agent: "system", action: "merged", subject: proposal.title, detail: proposal.pr_url ?? undefined });
```

- [ ] **Step 7: Add activity.recent WS handler**

In `src/server/ws/register-handlers.ts`, add:
```typescript
import { getActivityBuffer } from "../../activity/ring-buffer.js";

// In the registerHandlers function, add alongside existing router.register calls:
router.register("activity.recent", async () => {
  const buffer = getActivityBuffer();
  return buffer?.getAll() ?? [];
});
```

- [ ] **Step 8: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 9: Type check**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 10: Commit**

```bash
git add src/activity/ring-buffer.ts src/gateway/protocol/events.ts src/queue/processor.ts src/proposals/store.ts src/scheduler/index.ts src/server/ws/register-handlers.ts src/index.ts
git commit -m "feat: wire activity event emission across system"
```

---

## Chunk 4: Agent Config + Bootstrap Fix

### Task 8: Add Scout and Researcher Agent Definitions

**Files:**
- Modify: Instance config `~/.nyxhive/instances/NyxAI/config.toml`

- [ ] **Step 1: Add agent definitions**

Add after the existing `[agents.tester]` section:

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

- [ ] **Step 2: Verify bootstrap migration fix from Task 6 is in place**

Confirm the dead-agent migration in `src/scheduler/bootstrap.ts` filters out config-defined agents. If not done in Task 6, do it now.

- [ ] **Step 3: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/scheduler/bootstrap.ts
git commit -m "feat: add scout and researcher agent roles, fix bootstrap migration"
```

---

## Chunk 5: Home Page Command Center

### Task 9: Activity Store

**Files:**
- Create: `src/gateway/src/stores/activity-feed.ts`

- [ ] **Step 1: Create activity feed Zustand store**

Note: `src/gateway/src/stores/activity.ts` already exists with the audit log store (`useActivityStore`). This is a separate store for the live event feed.

```typescript
// src/gateway/src/stores/activity-feed.ts
import { create } from "zustand";

export interface ActivityEvent {
  id: string;
  type: "completion" | "proposal" | "delegation" | "watchdog" | "system" | "error";
  agent: string;
  action: string;
  subject: string;
  detail?: string;
  timestamp: number;
}

interface ActivityFeedStore {
  events: ActivityEvent[];
  addEvent: (event: ActivityEvent) => void;
  setEvents: (events: ActivityEvent[]) => void;
}

export const useActivityFeedStore = create<ActivityFeedStore>((set) => ({
  events: [],
  addEvent: (event) =>
    set((state) => {
      // Dedup by ID
      if (state.events.some((e) => e.id === event.id)) return state;
      const updated = [event, ...state.events].slice(0, 50);
      return { events: updated };
    }),
  setEvents: (events) => set({ events }),
}));
```

- [ ] **Step 2: Commit**

```bash
git add src/gateway/src/stores/activity-feed.ts
git commit -m "feat: add activity event Zustand store"
```

---

### Task 10: Home Page Components

**Files:**
- Create: `src/gateway/src/components/home/InstanceHeader.tsx`
- Create: `src/gateway/src/components/home/AgentCard.tsx`
- Create: `src/gateway/src/components/home/StatsStrip.tsx`
- Create: `src/gateway/src/components/home/NeedsAttentionPanel.tsx`
- Create: `src/gateway/src/components/home/ActivityFeed.tsx`

- [ ] **Step 1: Create InstanceHeader component**

```tsx
// src/gateway/src/components/home/InstanceHeader.tsx
import { cn } from "../../lib/utils";
import type { Health } from "../../lib/types";
import { formatUptime } from "../../lib/format";

interface InstanceHeaderProps {
  instanceName: string;
  agentCount: number;
  health: Health | null;
  runningCount: number;
}

export function InstanceHeader({ instanceName, agentCount, health, runningCount }: InstanceHeaderProps) {
  const initial = instanceName.charAt(0).toUpperCase();
  const isHealthy = health !== null;

  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-gradient-to-br from-violet-600 to-violet-400 text-base font-bold shadow-[0_0_20px_rgba(139,92,246,0.25)]">
          {initial}
        </div>
        <div>
          <h1 className="text-lg font-bold text-gradient">{instanceName}</h1>
          <p className="text-[10px] text-zinc-600">
            {agentCount} agents{health ? ` · uptime ${formatUptime(health.uptime)}` : ""}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <div className={cn(
          "flex items-center gap-1.5 rounded-md border px-2.5 py-1",
          isHealthy
            ? "border-emerald-500/15 bg-emerald-500/8"
            : "border-red-500/15 bg-red-500/8"
        )}>
          <div className={cn(
            "h-1.5 w-1.5 rounded-full",
            isHealthy ? "bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400)]" : "bg-red-400"
          )} />
          <span className={cn("text-[10px] font-medium", isHealthy ? "text-emerald-400" : "text-red-400")}>
            {isHealthy ? "Healthy" : "Offline"}
          </span>
        </div>
        {runningCount > 0 && (
          <div className="rounded-md border border-amber-500/12 bg-amber-500/8 px-2.5 py-1 text-[10px] font-medium text-amber-400">
            {runningCount} running
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create AgentCard component**

```tsx
// src/gateway/src/components/home/AgentCard.tsx
import { AlertTriangle } from "lucide-react";
import { cn } from "../../lib/utils";
import { formatCost } from "../../lib/format";
import type { Agent } from "../../stores/agents";

// Role → color mapping
const roleColors: Record<string, { bg: string; text: string; border: string; gradient: string }> = {
  lead:    { bg: "bg-violet-500/12", text: "text-violet-400", border: "border-violet-500/25", gradient: "from-violet-600 to-violet-400" },
  worker:  { bg: "bg-blue-500/12",   text: "text-blue-400",   border: "border-blue-500/20",  gradient: "" },
  coder:   { bg: "bg-emerald-500/12",text: "text-emerald-400",border: "border-emerald-500/20",gradient: "" },
  default: { bg: "bg-zinc-500/12",   text: "text-zinc-400",   border: "border-zinc-500/20",  gradient: "" },
};

const statusColors = {
  idle: "bg-emerald-400",
  running: "bg-amber-500 shadow-[0_0_6px_theme(colors.amber.500)]",
  error: "bg-red-500 shadow-[0_0_6px_theme(colors.red.500)]",
};

interface AgentCardProps {
  agent: Agent;
  stuckMinutes?: number;
}

export function AgentCard({ agent, stuckMinutes }: AgentCardProps) {
  const colors = roleColors[agent.role] ?? roleColors.default;
  const isRunning = agent.status === "running";
  const isStuck = agent.status === "error" || (stuckMinutes != null && stuckMinutes > 0);
  const initial = agent.name.charAt(0).toUpperCase();

  return (
    <div className={cn(
      "relative overflow-hidden rounded-[10px] border p-3",
      isStuck
        ? "border-red-500/25 bg-gradient-to-br from-red-500/4 to-transparent"
        : isRunning
        ? cn(colors.border, "bg-gradient-to-br from-violet-500/6 to-transparent")
        : "border-white/6 bg-white/[0.015]"
    )}>
      {/* Top gradient line for active agents */}
      {(isRunning || isStuck) && (
        <div className={cn(
          "absolute inset-x-0 top-0 h-0.5",
          isStuck ? "bg-red-500/50" : "bg-gradient-to-r from-transparent via-violet-400 to-transparent"
        )} />
      )}

      {/* Header: avatar + name + status dot */}
      <div className="mb-2 flex items-center gap-2">
        <div className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold",
          isStuck ? "bg-red-500/12 text-red-400"
          : colors.gradient ? `bg-gradient-to-br ${colors.gradient}` : cn(colors.bg, colors.text)
        )}>
          {initial}
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold">{agent.name}</div>
          <div className={cn("text-[9px]", isStuck ? "text-red-400" : colors.text)}>{agent.role}</div>
        </div>
        <div className={cn("ml-auto h-1.5 w-1.5 shrink-0 rounded-full", statusColors[agent.status])} />
      </div>

      {/* Task or status line */}
      {isStuck && stuckMinutes != null ? (
        <div className="flex items-center gap-1 text-[9px] text-red-400">
          <AlertTriangle className="h-2.5 w-2.5" />
          Stuck {stuckMinutes}m — auto-retry queued
        </div>
      ) : isRunning && agent.currentTask ? (
        <>
          <div className="mb-1.5 truncate text-[9px] text-zinc-400">{agent.currentTask}</div>
          <div className="h-[3px] rounded-full bg-white/5">
            <div className="h-full rounded-full bg-gradient-to-r from-violet-600 to-violet-400" style={{ width: "50%" }} />
          </div>
        </>
      ) : (
        <div className="text-[9px] text-zinc-600">
          Idle{agent.lastInvokedAt ? ` · ${formatRelativeShort(agent.lastInvokedAt)}` : ""}
        </div>
      )}

      {/* Footer stats */}
      <div className="mt-1.5 flex justify-between text-[8px] text-zinc-600">
        <span>{agent.totalInvocations} tasks</span>
        <span>{formatCost(agent.estimatedCostCents)}</span>
      </div>
    </div>
  );
}

function formatRelativeShort(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
```

- [ ] **Step 3: Create StatsStrip component**

```tsx
// src/gateway/src/components/home/StatsStrip.tsx
import { formatBytes, formatCost } from "../../lib/format";
import type { Health } from "../../lib/types";

interface StatsStripProps {
  health: Health | null;
  totalCost: number;
  proposalCount: number;
  completedCount: number;
}

const cells = [
  { key: "queue",     label: "Queue",      color: "text-violet-400", bg: "bg-violet-500/4" },
  { key: "completed", label: "Completed",  color: "text-emerald-400", bg: "bg-emerald-500/4" },
  { key: "proposals", label: "Proposals",  color: "text-blue-400",   bg: "bg-blue-500/4" },
  { key: "cost",      label: "Spent Today", color: "text-red-400",    bg: "bg-red-500/4" },
  { key: "memory",    label: "Memory",     color: "text-amber-400",  bg: "bg-amber-500/4" },
] as const;

export function StatsStrip({ health, totalCost, proposalCount, completedCount }: StatsStripProps) {
  const values: Record<string, string> = {
    queue: String(health?.queueDepth ?? 0),
    completed: String(completedCount),
    proposals: String(proposalCount),
    cost: formatCost(totalCost),
    memory: health ? formatBytes(health.memoryUsage) : "—",
  };

  return (
    <div className="flex overflow-hidden rounded-lg border border-white/5">
      {cells.map(({ key, label, color, bg }) => (
        <div key={key} className={`flex-1 px-3 py-2 text-center ${bg}`}>
          <div className="text-[8px] uppercase tracking-wider text-zinc-600">{label}</div>
          <div className={`text-base font-semibold ${color}`}>{values[key]}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Create NeedsAttentionPanel component**

```tsx
// src/gateway/src/components/home/NeedsAttentionPanel.tsx
import { AlertCircle, AlertTriangle } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../lib/format";
import { categoryTextColors } from "../../lib/colors";
import type { Proposal } from "../../stores/proposals";

interface NeedsAttentionPanelProps {
  proposals: Proposal[];
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
}

export function NeedsAttentionPanel({ proposals, onApprove, onReject }: NeedsAttentionPanelProps) {
  if (proposals.length === 0) return null;

  return (
    <div className="rounded-[10px] border border-red-500/12 p-3">
      <div className="mb-2.5 flex items-center gap-1.5">
        <AlertCircle className="h-3.5 w-3.5 text-red-400" />
        <span className="text-xs font-semibold">Needs Attention</span>
        <span className="rounded-full bg-red-500/15 px-1.5 py-px text-[9px] font-semibold text-red-400">
          {proposals.length}
        </span>
      </div>

      <div className="space-y-1.5">
        {proposals.slice(0, 5).map((p) => (
          <div key={p.id} className="rounded-lg border border-white/4 bg-white/[0.02] px-2.5 py-2">
            <div className="mb-1 text-[11px] font-medium">{p.title}</div>
            <div className="flex items-center gap-1.5">
              <span className={cn("text-[9px]", categoryTextColors[p.category])}>{p.category}</span>
              <span className="text-[9px] text-zinc-600">{p.effort}</span>
              <span className="text-[9px] text-zinc-700">{formatRelativeTime(p.createdAt)}</span>
              <div className="ml-auto flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-2 text-[9px] text-emerald-400 hover:bg-emerald-500/10"
                  onClick={() => onApprove(p.proposalId)}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 px-2 text-[9px] text-red-400 hover:bg-red-500/10"
                  onClick={() => onReject(p.proposalId)}
                >
                  Skip
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create ActivityFeed component**

```tsx
// src/gateway/src/components/home/ActivityFeed.tsx
import { Activity } from "lucide-react";
import { Link } from "react-router-dom";
import type { ActivityEvent } from "../../stores/activity-feed";

const dotColors: Record<ActivityEvent["type"], string> = {
  completion: "bg-emerald-400",
  proposal: "bg-blue-400",
  delegation: "bg-violet-400",
  watchdog: "bg-red-400",
  system: "bg-violet-400",
  error: "bg-red-400",
};

const agentColors: Record<string, string> = {
  nyx: "text-violet-400",
  scout: "text-amber-400",
  analyst: "text-blue-400",
  tester: "text-emerald-400",
  researcher: "text-cyan-400",
  system: "text-violet-400",
};

interface ActivityFeedProps {
  events: ActivityEvent[];
}

export function ActivityFeed({ events }: ActivityFeedProps) {
  return (
    <div className="rounded-[10px] border border-white/6 p-3">
      <div className="mb-2.5 flex items-center gap-1.5">
        <Activity className="h-3.5 w-3.5 text-violet-400" />
        <span className="text-xs font-semibold">Activity</span>
        <span className="ml-auto text-[9px] text-zinc-600">Live</span>
        <div className="h-[5px] w-[5px] rounded-full bg-emerald-400 shadow-[0_0_4px_theme(colors.emerald.400)]" />
      </div>

      {events.length === 0 ? (
        <p className="py-4 text-center text-[10px] text-zinc-600">No recent activity</p>
      ) : (
        <div className="text-[10px]">
          {events.slice(0, 8).map((e) => (
            <div key={e.id} className="flex items-start gap-2 border-b border-white/3 py-1.5 last:border-0">
              <div className={`mt-[5px] h-1 w-1 shrink-0 rounded-full ${dotColors[e.type]}`} />
              <div className="min-w-0 flex-1">
                <div>
                  <span className={`font-medium ${agentColors[e.agent] ?? "text-zinc-400"}`}>{e.agent}</span>
                  {" "}
                  <span className="text-zinc-500">{e.action}</span>
                  {" "}
                  <span className="text-zinc-300">{e.subject}</span>
                </div>
                {e.detail && <div className="mt-0.5 text-[9px] text-zinc-600">{e.detail}</div>}
              </div>
              <span className="shrink-0 text-[9px] text-zinc-700">{formatRelativeShort(e.timestamp)}</span>
            </div>
          ))}
        </div>
      )}

      <Link to="/activity" className="mt-2 block text-center text-[9px] text-zinc-500 hover:text-zinc-400">
        View all
      </Link>
    </div>
  );
}

function formatRelativeShort(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}
```

- [ ] **Step 6: Create WatchdogAlertItem component**

```tsx
// src/gateway/src/components/home/WatchdogAlertItem.tsx
import { AlertTriangle } from "lucide-react";
import { Button } from "../ui/button";

interface WatchdogAlertItemProps {
  agentName: string;
  stuckMinutes: number;
  retryInMinutes?: number;
  onRetry?: () => void;
  onKill?: () => void;
}

export function WatchdogAlertItem({ agentName, stuckMinutes, retryInMinutes, onRetry, onKill }: WatchdogAlertItemProps) {
  return (
    <div className="rounded-lg border border-red-500/12 bg-red-500/[0.03] px-2.5 py-2">
      <div className="mb-1 flex items-center gap-1">
        <AlertTriangle className="h-2.5 w-2.5 text-red-400" />
        <span className="text-[11px] font-medium text-red-300">{agentName} stuck for {stuckMinutes}m</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[9px] text-zinc-500">
          {retryInMinutes != null ? `Auto-retry in ${retryInMinutes}m` : "Auto-retry queued"}
        </span>
        <div className="ml-auto flex gap-1">
          {onRetry && (
            <Button size="sm" variant="ghost" className="h-5 px-2 text-[9px] text-violet-400 hover:bg-violet-500/10" onClick={onRetry}>
              Retry Now
            </Button>
          )}
          {onKill && (
            <Button size="sm" variant="ghost" className="h-5 px-2 text-[9px] text-red-400 hover:bg-red-500/10" onClick={onKill}>
              Kill
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Integrate WatchdogAlertItem into NeedsAttentionPanel**

Update the `NeedsAttentionPanel` to accept and render watchdog alerts alongside proposals:

Add to `NeedsAttentionPanelProps`:
```typescript
watchdogAlerts?: Array<{ agentName: string; stuckMinutes: number }>;
```

Render `WatchdogAlertItem` entries after the proposal items in the panel, updating the count badge to include both.

- [ ] **Step 8: Commit all components**

```bash
git add src/gateway/src/components/home/ src/gateway/src/stores/activity-feed.ts
git commit -m "feat: add command center home page components"
```

---

### Task 11: Rewrite Home Page

**Files:**
- Modify: `src/gateway/src/pages/Home.tsx`

- [ ] **Step 1: Rewrite Home.tsx**

Replace the entire file with the new command center layout using the components from Task 10. Wire up:
- `useAgentsStore` for agent cards
- `useProposalsStore` for needs attention panel
- `useWsRequest("system.health")` for health data
- `useWsRequest("activity.recent")` for initial activity load
- `useWsEvent("activity:event")` for live updates → `useActivityFeedStore.addEvent`
- `useWsEvent("agent:status")` for live agent status updates

The layout structure:
```
<div className="space-y-5">
  <InstanceHeader />
  <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }}>
    {agents.map(a => <AgentCard key={a.id} agent={a} />)}
  </div>
  <StatsStrip />
  <div className="grid gap-3 lg:grid-cols-2">
    <NeedsAttentionPanel />
    <ActivityFeed />
  </div>
</div>
```

- [ ] **Step 2: Fix duplicate Layers import in current Home.tsx**

The current file imports `Layers` twice (lines 9 and 13). This gets fixed by the rewrite.

- [ ] **Step 3: Type check**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 4: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/gateway/src/pages/Home.tsx
git commit -m "feat: rewrite Home page as command center"
```

---

## Chunk 6: Final Verification

### Task 12: Full Suite Verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All 3326+ tests pass

- [ ] **Step 2: Type check**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Manual verification**

Start the dev server (`bun run dev`) and verify:
- Home page shows agent cards with correct status
- Stats strip renders with real data
- Needs attention panel shows pending proposals
- Activity feed populates (send a test message to trigger activity)

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: command center polish and verification fixes"
```

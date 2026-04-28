# Notification Routing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route notifications to different Discord channels by type (proposals, alerts, reports, activity) instead of one single destination.

**Architecture:** Add a `[notifications]` config section mapping notification types to channel+recipient pairs. A single `resolveNotificationTarget()` function replaces all 5 hardcoded `owner_channel`/`owner_id` lookups. Falls back to `daemon.owner_channel`/`daemon.owner_id` when no type-specific target is configured.

**Tech Stack:** TypeScript, Bun, Zod (config validation)

---

### Task 1: Add notification routing resolver

**Files:**
- Create: `src/notifications/routing.ts`
- Test: `src/__tests__/notification-routing.test.ts`

**Step 1: Write the failing tests**

```typescript
// src/__tests__/notification-routing.test.ts
import { describe, test, expect } from "bun:test";
import { resolveNotificationTarget, type NotificationType } from "../notifications/routing.js";
import type { NyxHiveConfig } from "../types.js";

function makeConfig(overrides: Record<string, unknown> = {}): NyxHiveConfig {
  return {
    daemon: { name: "test", log_level: "info", data_dir: "/tmp" },
    server: { port: 3000, require_auth: false, request_timeout_ms: 120000 },
    agents: {},
    providers: {},
    routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
    context: { max_history: 200, summary_threshold: 20, history_budget_ratio: 0.5 },
    ...overrides,
  } as NyxHiveConfig;
}

describe("resolveNotificationTarget", () => {
  test("returns type-specific target when configured", () => {
    const config = makeConfig({
      notifications: {
        alerts: { channel: "discord", recipient: "alerts-channel-id" },
      },
    });
    const target = resolveNotificationTarget(config, "alerts");
    expect(target).toEqual({ channel: "discord", recipient: "alerts-channel-id" });
  });

  test("falls back to daemon.owner_channel/owner_id when type not configured", () => {
    const config = makeConfig({
      daemon: { name: "test", log_level: "info", data_dir: "/tmp", owner_channel: "telegram", owner_id: "jay" },
    });
    const target = resolveNotificationTarget(config, "alerts");
    expect(target).toEqual({ channel: "telegram", recipient: "jay" });
  });

  test("returns null when neither type-specific nor owner configured", () => {
    const config = makeConfig();
    const target = resolveNotificationTarget(config, "alerts");
    expect(target).toBeNull();
  });

  test("type-specific overrides owner fallback", () => {
    const config = makeConfig({
      daemon: { name: "test", log_level: "info", data_dir: "/tmp", owner_channel: "telegram", owner_id: "jay" },
      notifications: {
        proposals: { channel: "discord", recipient: "proposals-channel" },
      },
    });
    expect(resolveNotificationTarget(config, "proposals")).toEqual({ channel: "discord", recipient: "proposals-channel" });
    expect(resolveNotificationTarget(config, "alerts")).toEqual({ channel: "telegram", recipient: "jay" });
  });

  test("handles all four notification types", () => {
    const config = makeConfig({
      notifications: {
        proposals: { channel: "discord", recipient: "p" },
        alerts: { channel: "discord", recipient: "a" },
        reports: { channel: "discord", recipient: "r" },
        activity: { channel: "discord", recipient: "x" },
      },
    });
    expect(resolveNotificationTarget(config, "proposals")!.recipient).toBe("p");
    expect(resolveNotificationTarget(config, "alerts")!.recipient).toBe("a");
    expect(resolveNotificationTarget(config, "reports")!.recipient).toBe("r");
    expect(resolveNotificationTarget(config, "activity")!.recipient).toBe("x");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/notification-routing.test.ts`
Expected: FAIL — module not found

**Step 3: Write the resolver**

```typescript
// src/notifications/routing.ts
import type { NyxHiveConfig } from "../types.js";

export type NotificationType = "proposals" | "alerts" | "reports" | "activity";

export interface NotificationTarget {
  channel: string;
  recipient: string;
}

/**
 * Resolve where to send a notification of the given type.
 * Priority: type-specific config > daemon.owner_channel/owner_id > null.
 */
export function resolveNotificationTarget(
  config: NyxHiveConfig,
  type: NotificationType,
): NotificationTarget | null {
  const typed = config.notifications?.[type];
  if (typed?.channel && typed?.recipient) {
    return { channel: typed.channel, recipient: typed.recipient };
  }

  const ownerChannel = config.daemon?.owner_channel;
  const ownerId = config.daemon?.owner_id;
  if (ownerChannel && ownerId) {
    return { channel: ownerChannel, recipient: ownerId };
  }

  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/notification-routing.test.ts`
Expected: PASS (all 5 tests)

**Step 5: Commit**

```bash
git add src/notifications/routing.ts src/__tests__/notification-routing.test.ts
git commit -m "feat: add notification routing resolver"
```

---

### Task 2: Add config schema and types

**Files:**
- Modify: `src/config-schema.ts:177` (before `allowed_directories`)
- Modify: `src/types.ts:88-95` (inside `NyxHiveConfig`)

**Step 1: Add Zod schema for notifications**

In `src/config-schema.ts`, add before the `allowed_directories` line (line 177):

```typescript
  notifications: z.object({
    proposals: z.object({ channel: z.string(), recipient: z.string() }).optional(),
    alerts: z.object({ channel: z.string(), recipient: z.string() }).optional(),
    reports: z.object({ channel: z.string(), recipient: z.string() }).optional(),
    activity: z.object({ channel: z.string(), recipient: z.string() }).optional(),
  }).optional(),
```

**Step 2: Add TypeScript type to NyxHiveConfig**

In `src/types.ts`, add to the `NyxHiveConfig` interface after `owner_id`:

```typescript
    notifications?: {
      proposals?: { channel: string; recipient: string };
      alerts?: { channel: string; recipient: string };
      reports?: { channel: string; recipient: string };
      activity?: { channel: string; recipient: string };
    };
```

**Step 3: Verify types compile**

Run: `bunx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add src/config-schema.ts src/types.ts
git commit -m "feat: add notifications config schema and types"
```

---

### Task 3: Update alert call sites (management.ts + processor.ts)

**Files:**
- Modify: `src/queue/management.ts:201-202`
- Modify: `src/queue/processor.ts:1059-1060`
- Modify: `src/__tests__/management.test.ts` (update existing alert tests)

**Step 1: Update management.ts alert routing**

Replace lines 201-202 in `src/queue/management.ts`:

```typescript
// Before:
const alertChannel = action.params.channel || ctx.nyxhiveConfig?.daemon?.owner_channel;
const alertRecipient = action.params.recipient || ctx.nyxhiveConfig?.daemon?.owner_id;

// After:
import { resolveNotificationTarget } from "../notifications/routing.js";
// ...
const alertTarget = action.params.channel && action.params.recipient
  ? { channel: action.params.channel, recipient: action.params.recipient }
  : ctx.nyxhiveConfig ? resolveNotificationTarget(ctx.nyxhiveConfig, "alerts") : null;
const alertChannel = alertTarget?.channel;
const alertRecipient = alertTarget?.recipient;
```

Note: the import goes at the top of the file. The existing variables `alertChannel` and `alertRecipient` are used downstream so we keep the same names to minimize churn.

**Step 2: Update processor.ts circuit breaker routing**

Replace lines 1059-1060 in `src/queue/processor.ts`:

```typescript
// Before:
const ownerChannel = this.config.nyxhiveConfig?.daemon?.owner_channel;
const ownerRecipient = this.config.nyxhiveConfig?.daemon?.owner_id;

// After:
import { resolveNotificationTarget } from "../notifications/routing.js";
// ...
const alertTarget = this.config.nyxhiveConfig
  ? resolveNotificationTarget(this.config.nyxhiveConfig, "alerts")
  : null;
const ownerChannel = alertTarget?.channel;
const ownerRecipient = alertTarget?.recipient;
```

Again, keep `ownerChannel`/`ownerRecipient` variable names since they're used downstream.

**Step 3: Update management test to use notifications config**

In `src/__tests__/management.test.ts`, update the alert tests to also verify routing through `notifications.alerts`. Add a test:

```typescript
test("alert routes to notifications.alerts config", async () => {
  const registry = makeRegistry();
  const sent: string[] = [];
  const channels = [{ name: "discord", sendOutbound: async (_r: string, msg: string) => { sent.push(msg); } }];
  const ctx = makeCtx({
    registry: registry as any,
    channels: channels as any,
    nyxhiveConfig: {
      notifications: { alerts: { channel: "discord", recipient: "alerts-channel" } },
    } as any,
  });
  const results = await executor.execute(
    [action("alert", { message: "test alert" })],
    "nyx",
    ctx,
  );
  expect(results[0]).toContain("Alert sent");
  expect(sent).toContain("test alert");
});
```

**Step 4: Run tests**

Run: `bun test src/__tests__/management.test.ts src/__tests__/notification-routing.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/queue/management.ts src/queue/processor.ts src/__tests__/management.test.ts
git commit -m "feat: route alerts through notification resolver"
```

---

### Task 4: Update proposal call sites (scheduler/index.ts)

**Files:**
- Modify: `src/scheduler/index.ts:184-185` (nudges)
- Modify: `src/scheduler/index.ts:840-841` (proposal events)

**Step 1: Add import at top of scheduler/index.ts**

```typescript
import { resolveNotificationTarget } from "../notifications/routing.js";
```

**Step 2: Update nudge notification routing (lines 184-185)**

```typescript
// Before:
const ownerChannel = this.config.daemon?.owner_channel;
const ownerId = this.config.daemon?.owner_id;

// After:
const proposalTarget = resolveNotificationTarget(this.config, "proposals");
const ownerChannel = proposalTarget?.channel;
const ownerId = proposalTarget?.recipient;
```

**Step 3: Update proposal event routing (lines 840-841)**

```typescript
// Before:
const ownerChannel = this.config.daemon?.owner_channel;
const ownerId = this.config.daemon?.owner_id;

// After:
const proposalTarget = resolveNotificationTarget(this.config, "proposals");
const ownerChannel = proposalTarget?.channel;
const ownerId = proposalTarget?.recipient;
```

**Step 4: Run tests**

Run: `bun test`
Expected: PASS (all ~2853 tests)

**Step 5: Commit**

```bash
git add src/scheduler/index.ts
git commit -m "feat: route proposal notifications through resolver"
```

---

### Task 5: Update scheduler bootstrap notify_channels

**Files:**
- Modify: `src/scheduler/bootstrap.ts:672-686`

**Step 1: Update resolveNotifyChannels to use typed routing**

Replace the `resolveNotifyChannels` function and the notify_channels wiring at the bottom of `loadDefaultHeartbeat`:

```typescript
// Replace the resolveNotifyChannels function at top of file:
import { resolveNotificationTarget } from "../notifications/routing.js";

/** Resolve notify_channels for a given notification type. */
function resolveNotifyChannelsForType(config: NyxHiveConfig, type: "reports" | "activity"): string | null {
  // First check typed notification routing
  const target = resolveNotificationTarget(config, type);
  if (target) {
    return JSON.stringify([`${target.channel}:${target.recipient}`]);
  }
  // Fall back to legacy scheduler.notify_channels
  const targets = config.scheduler?.notify_channels;
  if (!targets || targets.length === 0) return null;
  return JSON.stringify(targets);
}
```

Then update the notify_channels wiring (lines 672-686):

```typescript
// Replace the existing block:
const reportsNotify = resolveNotifyChannelsForType(config, "reports");
if (reportsNotify) {
  const reportTasks = ["briefing:daily", "heartbeat:daily-review"];
  for (const name of reportTasks) {
    db.run(
      "UPDATE scheduled_tasks SET notify_channels = ?, updated_at = ? WHERE name = ? AND created_by = 'system'",
      [reportsNotify, Date.now(), name],
    );
  }
}

const activityNotify = resolveNotifyChannelsForType(config, "activity");
if (activityNotify) {
  db.run(
    "UPDATE scheduled_tasks SET notify_channels = ?, updated_at = ? WHERE name = ? AND created_by = 'system'",
    [activityNotify, Date.now(), "evolution:codebase-review"],
  );
}

const taskNames = [reportsNotify ? 2 : 0, activityNotify ? 1 : 0].reduce((a, b) => a + b, 0);
if (taskNames > 0) {
  logger.info(`[scheduler] Set typed notify_channels on ${taskNames} automation tasks`);
}
```

**Step 2: Run tests**

Run: `bun test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/scheduler/bootstrap.ts
git commit -m "feat: route scheduler notifications through typed resolver"
```

---

### Task 6: Add example config and run full verification

**Files:**
- Modify: `config/nyxhive.toml` (add commented example)

**Step 1: Add commented notification config example**

After the `[discord]` section in `config/nyxhive.toml`:

```toml
# [notifications]
# Route notifications to specific channels by type.
# Omitted types fall back to daemon.owner_channel / daemon.owner_id.
#
# [notifications.proposals]
# channel = "discord"
# recipient = "DISCORD_CHANNEL_ID"
#
# [notifications.alerts]
# channel = "discord"
# recipient = "DISCORD_CHANNEL_ID"
#
# [notifications.reports]
# channel = "discord"
# recipient = "DISCORD_CHANNEL_ID"
#
# [notifications.activity]
# channel = "discord"
# recipient = "DISCORD_CHANNEL_ID"
```

**Step 2: Run full test suite**

Run: `bun test`
Expected: PASS (~2853+ tests)

**Step 3: Run type checker**

Run: `bunx tsc --noEmit`
Expected: PASS

**Step 4: Commit**

```bash
git add config/nyxhive.toml
git commit -m "docs: add notification routing config example"
```

# Notification Routing Design

**Date:** 2026-03-08
**Status:** Approved

## Problem

All notifications (alerts, proposals, circuit breakers, daily briefings, health checks) route to a single destination via `daemon.owner_channel` + `daemon.owner_id`. As volume grows, important alerts get buried in noise.

## Solution

Add a `[notifications]` config section that maps notification **types** to specific channel+recipient destinations. A single `resolveNotificationTarget(config, type)` function replaces all hardcoded `owner_channel`/`owner_id` lookups.

## Config

```toml
[notifications.proposals]
channel = "discord"
recipient = "CHANNEL_ID"

[notifications.alerts]
channel = "discord"
recipient = "CHANNEL_ID"

[notifications.reports]
channel = "discord"
recipient = "CHANNEL_ID"

[notifications.activity]
channel = "discord"
recipient = "CHANNEL_ID"
```

All keys are optional. Missing keys fall back to `daemon.owner_channel` / `daemon.owner_id`.

## Notification Types

| Type | Content | Sources |
|------|---------|---------|
| `proposals` | New proposals, approve/reject, nudges, merged/failed/closed events | scheduler proposal events, nudges, `sendProposalNotification` |
| `alerts` | `[@alert:]` tags, circuit breaker trips, health check warnings | `management.ts`, `processor.ts` |
| `reports` | Daily briefing, daily review summaries | scheduler `notify_channels` on briefing/review tasks |
| `activity` | Task completion logs, delegation results | scheduler `notify_channels` on other tasks (future) |

## Changes

### 1. Config schema (`config-schema.ts`)

Add `notifications` section:

```typescript
notifications: z.object({
  proposals: z.object({ channel: z.string(), recipient: z.string() }).optional(),
  alerts: z.object({ channel: z.string(), recipient: z.string() }).optional(),
  reports: z.object({ channel: z.string(), recipient: z.string() }).optional(),
  activity: z.object({ channel: z.string(), recipient: z.string() }).optional(),
}).optional(),
```

### 2. Types (`types.ts`)

Add to `NyxHiveConfig`:

```typescript
notifications?: {
  proposals?: { channel: string; recipient: string };
  alerts?: { channel: string; recipient: string };
  reports?: { channel: string; recipient: string };
  activity?: { channel: string; recipient: string };
};
```

### 3. Resolver (`notifications/routing.ts` — new file)

```typescript
type NotificationType = "proposals" | "alerts" | "reports" | "activity";

function resolveNotificationTarget(
  config: NyxHiveConfig,
  type: NotificationType
): { channel: string; recipient: string } | null
```

Checks `config.notifications[type]` first, falls back to `config.daemon.owner_channel` + `config.daemon.owner_id`.

### 4. Call site updates (5 locations)

| File | Current | After |
|------|---------|-------|
| `management.ts:201-202` | `daemon.owner_channel/id` | `resolveNotificationTarget(config, "alerts")` |
| `processor.ts:1059-1060` | `daemon.owner_channel/id` | `resolveNotificationTarget(config, "alerts")` |
| `scheduler/index.ts:184-185` | `daemon.owner_channel/id` (nudges) | `resolveNotificationTarget(config, "proposals")` |
| `scheduler/index.ts:840-841` | `daemon.owner_channel/id` (events) | `resolveNotificationTarget(config, "proposals")` |
| `scheduler/bootstrap.ts:672-686` | `scheduler.notify_channels` | `resolveNotificationTarget(config, "reports")` for briefing/review tasks |

### 5. Tests

- Resolver unit tests: type-specific routing, fallback to owner, null when no config
- Integration: existing management/scheduler tests updated to verify routing

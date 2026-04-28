# Gateway Frontend Handoff for Opus 4.6

## Context

NyxHive Gateway backend now exposes a shared diagnostics contract inspired by OpenClaw-style control-plane operations: the gateway is not only a chat UI, it is the local control plane for sessions, queue health, providers, WebSocket clients, devices, scheduler tasks, and live activity.

Backend work is already implemented. Frontend should consume it and reshape the System/Home operations surfaces around it.

## New Backend Surfaces

### WebSocket `system.health`

Call:

```ts
gateway.request("system.health", {})
```

Important response fields:

```ts
{
  status: "ok" | "degraded" | "error";
  uptime: number;
  uptime_seconds: number;
  queueDepth: number;
  activeConnections: number;
  agents: number;
  memoryUsage: number;
  instanceName?: string;
  leadAgent?: string;
  warnings?: string[];
  errors?: string[];
  providers?: Record<string, string>;
  queue?: {
    stats: {
      pending: number;
      processing: number;
      suspended: number;
      completed: number;
      failed: number;
      dead_letter: number;
    };
    deadLetters: number;
    retryableDeadLetters: number;
    staleProcessing: number;
    stalePending: number;
    staleRunning: number;
  };
  connections?: {
    connected: number;
    bufferedDevices: number;
    bufferedMessages: number;
    subscriptions: number;
    seq: number;
  };
  checks?: Array<{
    id: string;
    label: string;
    status: "ok" | "warn" | "error";
    summary: string;
    details?: Record<string, unknown>;
  }>;
}
```

### WebSocket `system.doctor`

Call:

```ts
gateway.request("system.doctor", {})
```

Returns the full diagnostics report. Use this for a detailed System page or a command-palette "Doctor" action. It includes `checks`, `warnings`, `errors`, `providers`, `queue`, `agents`, `scheduler`, `connections`, `wsMethods`, and memory data.

### HTTP `/health`

Unauthenticated health now returns the same diagnostics contract and uses:

- `200` for `ok` or `degraded`
- `503` for `error`

This is for CLI/ops checks, not primary UI polling.

### HTTP `/api/status/doctor`

Authenticated route returning the same diagnostics contract. Use if the frontend is in HTTP mode; otherwise prefer WS `system.doctor`.

## Frontend Tasks

1. Update the gateway health type in `src/gateway/src/lib/types.ts` or the local System/Home store type to match the expanded contract above.

2. Update `src/gateway/src/stores/auth.ts` if it assumes `system.health` only returns `{ instanceName, leadAgent }`. Keep the current behavior, but allow the richer response without narrowing it away.

3. Add a `system` store or extend the existing System page data flow:

```ts
const health = await gateway.request<GatewayHealth>("system.health", {});
const doctor = await gateway.request<GatewayDoctor>("system.doctor", {});
```

4. Rework `src/gateway/src/pages/System.tsx` around three panels:

- Overview: instance name, global status, uptime, lead agent, active WS connections.
- Needs attention: render checks where `status !== "ok"` first, with terse summaries.
- Operations detail: providers, queue counts, scheduler failing count, WebSocket method failures, memory.

5. On `src/gateway/src/pages/Home.tsx`, use `system.health` for the top-level status badge:

- `ok`: normal
- `degraded`: warning color and show count of warnings
- `error`: error color and show count of errors

6. Add a manual "Run doctor" refresh action on System. Keep it a read-only action. Do not add mutation buttons unless they already exist elsewhere.

7. Keep polling modest. Suggested:

- `system.health`: on mount, on reconnect, and every 20-30 seconds while System/Home is visible.
- `system.doctor`: on System mount and manual refresh only, unless a warning/error appears.

8. Render `wsMethods.metrics` as an advanced collapsible table if there is room:

Columns: method, count, failures, avgMs, maxMs, lastError.

9. Device list caveat: WS `devices.list` now returns booleans and camelCase fields:

```ts
{ id, name, approved, lastSeen, createdAt }
```

Prefer that shape over the raw DB snake_case shape.

10. Avoid turning the UI into an OpenClaw clone. Borrow the operating principle only: the Gateway is a control plane. Keep NyxHive's existing navigation and component style.

## Design Constraints

- Do not make a landing page. The first screen should remain a usable control surface.
- Do not put the main operational UI inside nested decorative cards.
- Use stable dimensions for status tiles and tables so changing counts do not shift the page.
- Do not introduce a dominant purple, beige, dark blue/slate, or brown/orange palette.
- Copy should be operational, not promotional. Example: "Queue has stale work" is good. "Your gateway is now smarter" is not.

## Acceptance Criteria

- `cd src/gateway && bun run build` passes.
- System page can render `ok`, `degraded`, and `error` doctor states without layout shifts.
- Home top status uses `system.health.status` and gracefully handles missing optional fields.
- No frontend code assumes `system.health` only has the original five numeric fields.
- Warnings and errors are visible without opening devtools.

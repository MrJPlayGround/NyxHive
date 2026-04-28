# Device Approval Flow — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable device approval from CLI and gateway with real-time toast notifications for pending devices.

**Architecture:** Add REST API for device management (used by CLI). Broadcast `device:pending` event when new devices register. Connected gateway clients receive toast notification with inline Approve button. After approval, broadcast `device:approved` so the pending device's auto-reconnect picks it up.

**Tech Stack:** Hono (REST routes), Bun WebSocket (broadcast), React (toast component), Zustand (if needed)

---

### Task 1: Add device event schemas to protocol

**Files:**
- Modify: `src/gateway/protocol/events.ts`

**Step 1: Add device event schemas**

Add after `systemHealthEvent`:

```typescript
export const devicePendingEvent = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
});

export const deviceApprovedEvent = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
});

export const deviceRevokedEvent = z.object({
  deviceId: z.string(),
});
```

Add to `eventSchemas`:
```typescript
"device:pending": devicePendingEvent,
"device:approved": deviceApprovedEvent,
"device:revoked": deviceRevokedEvent,
```

**Step 2: Verify build**

Run: `cd /home/user/dev/nyxhive && bun run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/gateway/protocol/events.ts
git commit -m "feat: add device event schemas for real-time device notifications"
```

---

### Task 2: Broadcast device events from server

**Files:**
- Modify: `src/server/ws/handler.ts` (broadcast `device:pending` on new registration)
- Modify: `src/server/ws/register-handlers.ts` (broadcast on approve/revoke)

**Step 1: Broadcast `device:pending` on new device registration**

In `handler.ts`, the `createWebSocketHandler` function needs access to `connections` (already has it). After the `registerDevice()` call (line ~56-66), add broadcast:

```typescript
await devices.registerDevice(deviceId, deviceName, signature);
// Notify connected clients about pending device
connections.broadcast("device:pending", { deviceId, deviceName });
```

**Step 2: Broadcast on approve/revoke in register-handlers.ts**

Update the `devices.approve` handler (~line 219-222):

```typescript
router.register("devices.approve", async (payload: unknown) => {
  const { deviceId } = payload as { deviceId: string };
  const approved = deps.devices.approveDevice(deviceId);
  if (approved) {
    // Find device name for the broadcast
    const allDevices = deps.devices.listDevices();
    const device = allDevices.find(d => d.id === deviceId);
    deps.connections.broadcast("device:approved", {
      deviceId,
      deviceName: device?.name ?? "Unknown",
    });
  }
  return { approved };
});
```

Update the `devices.revoke` handler (~line 225-229):

```typescript
router.register("devices.revoke", async (payload: unknown) => {
  const { deviceId } = payload as { deviceId: string };
  const revoked = deps.devices.revokeDevice(deviceId);
  if (revoked) {
    deps.connections.broadcast("device:revoked", { deviceId });
  }
  return { revoked };
});
```

**Step 3: Verify build**

Run: `cd /home/user/dev/nyxhive && bun run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/server/ws/handler.ts src/server/ws/register-handlers.ts
git commit -m "feat: broadcast device events on register/approve/revoke"
```

---

### Task 3: Add REST API for device management

**Files:**
- Create: `src/server/routes/devices.ts`
- Modify: `src/server/index.ts` (mount route)

**Step 1: Create device REST routes**

```typescript
import { Hono } from "hono";
import type { DeviceStore } from "../ws/auth.js";
import type { ConnectionManager } from "../ws/connection.js";

export function devicesRoutes(devices: DeviceStore, connections: ConnectionManager): Hono {
  const app = new Hono();

  // GET /api/devices — list all devices
  app.get("/", (c) => {
    const raw = devices.listDevices();
    return c.json({
      devices: raw.map(d => ({
        id: d.id,
        name: d.name,
        approved: !!d.approved,
        lastSeen: d.last_seen,
        createdAt: d.created_at,
      })),
    });
  });

  // GET /api/devices/pending — list pending devices only
  app.get("/pending", (c) => {
    const pending = devices.pendingDevices();
    return c.json({
      devices: pending.map(d => ({
        id: d.id,
        name: d.name,
        createdAt: d.created_at,
      })),
    });
  });

  // POST /api/devices/:id/approve — approve a device
  app.post("/:id/approve", (c) => {
    const deviceId = c.req.param("id");
    const approved = devices.approveDevice(deviceId);
    if (approved) {
      const allDevices = devices.listDevices();
      const device = allDevices.find(d => d.id === deviceId);
      connections.broadcast("device:approved", {
        deviceId,
        deviceName: device?.name ?? "Unknown",
      });
    }
    return c.json({ approved });
  });

  // POST /api/devices/:id/revoke — revoke a device
  app.post("/:id/revoke", (c) => {
    const deviceId = c.req.param("id");
    const revoked = devices.revokeDevice(deviceId);
    if (revoked) {
      connections.broadcast("device:revoked", { deviceId });
    }
    return c.json({ revoked });
  });

  return app;
}
```

**Step 2: Mount in server/index.ts**

Near the other route mounts (~line 356), add:

```typescript
import { devicesRoutes } from "./routes/devices.js";
// ...
app.route("/api/devices", devicesRoutes(deviceStore, wsConnections));
```

**Step 3: Verify build**

Run: `cd /home/user/dev/nyxhive && bun run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/server/routes/devices.ts src/server/index.ts
git commit -m "feat: add REST API for device management (list, approve, revoke)"
```

---

### Task 4: Add CLI `devices` command

**Files:**
- Create: `src/cli/devices.ts`
- Modify: `src/cli/index.ts` (register command)

**Step 1: Create devices CLI command**

```typescript
import { resolveInstance, loadInstanceEnv } from "./resolve.js";
import { loadConfig } from "../config.js";
import { logger } from "../utils/logger.js";

function parseArgs() {
  const args = process.argv.slice(3);
  let subcommand = args[0]; // list | approve | revoke | pending
  let deviceId = args[1];
  let instanceName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--instance" && i + 1 < args.length) {
      instanceName = args[++i];
    }
  }

  return { subcommand, deviceId, instanceName };
}

async function main() {
  const { subcommand, deviceId, instanceName } = parseArgs();
  const { configPath, instanceDir } = resolveInstance(instanceName);
  loadInstanceEnv(instanceDir);
  const config = loadConfig(configPath);
  const port = config.server.port;
  const base = `http://localhost:${port}`;

  switch (subcommand) {
    case "list":
    case undefined: {
      const res = await fetch(`${base}/api/devices`);
      const data = await res.json() as { devices: Array<{ id: string; name: string; approved: boolean; lastSeen: number | null; createdAt: number }> };
      if (data.devices.length === 0) {
        logger.info("No devices registered.");
        return;
      }
      const pending = data.devices.filter(d => !d.approved);
      const approved = data.devices.filter(d => d.approved);
      if (pending.length > 0) {
        logger.info(`\n  Pending (${pending.length}):`);
        for (const d of pending) {
          logger.info(`    ${d.name}  ${d.id.slice(0, 12)}...  (${timeAgo(d.createdAt)})`);
        }
      }
      if (approved.length > 0) {
        logger.info(`\n  Approved (${approved.length}):`);
        for (const d of approved) {
          logger.info(`    ${d.name}  ${d.id.slice(0, 12)}...  last seen ${d.lastSeen ? timeAgo(d.lastSeen) : "never"}`);
        }
      }
      logger.info("");
      break;
    }
    case "approve": {
      if (!deviceId) {
        // No ID provided — show pending and let user pick
        const res = await fetch(`${base}/api/devices/pending`);
        const data = await res.json() as { devices: Array<{ id: string; name: string; createdAt: number }> };
        if (data.devices.length === 0) {
          logger.info("No pending devices.");
          return;
        }
        if (data.devices.length === 1) {
          deviceId = data.devices[0].id;
          logger.info(`Approving '${data.devices[0].name}' (${deviceId.slice(0, 12)}...)...`);
        } else {
          logger.info("Multiple pending devices. Specify ID:");
          for (const d of data.devices) {
            logger.info(`  nyxhive devices approve ${d.id.slice(0, 12)}   # ${d.name}`);
          }
          return;
        }
      }
      // Resolve partial ID
      const allRes = await fetch(`${base}/api/devices`);
      const allData = await allRes.json() as { devices: Array<{ id: string; name: string }> };
      const match = allData.devices.find(d => d.id.startsWith(deviceId!));
      if (!match) {
        logger.error(`No device matching '${deviceId}'`);
        process.exit(1);
      }
      const approveRes = await fetch(`${base}/api/devices/${match.id}/approve`, { method: "POST" });
      const result = await approveRes.json() as { approved: boolean };
      if (result.approved) {
        logger.info(`Approved '${match.name}'`);
      } else {
        logger.error(`Failed to approve device '${deviceId}'`);
      }
      break;
    }
    case "revoke": {
      if (!deviceId) {
        logger.error("Usage: nyxhive devices revoke <device-id>");
        process.exit(1);
      }
      const allRes = await fetch(`${base}/api/devices`);
      const allData = await allRes.json() as { devices: Array<{ id: string; name: string }> };
      const match = allData.devices.find(d => d.id.startsWith(deviceId!));
      if (!match) {
        logger.error(`No device matching '${deviceId}'`);
        process.exit(1);
      }
      const revokeRes = await fetch(`${base}/api/devices/${match.id}/revoke`, { method: "POST" });
      const result = await revokeRes.json() as { revoked: boolean };
      if (result.revoked) {
        logger.info(`Revoked '${match.name}'`);
      } else {
        logger.error(`Failed to revoke device '${deviceId}'`);
      }
      break;
    }
    default:
      logger.error(`Unknown subcommand: ${subcommand}`);
      logger.info("Usage: nyxhive devices [list|approve|revoke] [device-id]");
      process.exit(1);
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

main().catch(err => {
  logger.error(`Error: ${err}`);
  process.exit(1);
});
```

**Step 2: Register in CLI index**

In `src/cli/index.ts`, add case before `default`:

```typescript
case "devices":
  await import("./devices.js");
  break;
```

And add to help text:

```
    devices [list|approve|revoke]  Manage gateway devices
```

**Step 3: Verify build**

Run: `cd /home/user/dev/nyxhive && bun run build`
Expected: PASS

**Step 4: Manual test (if server running)**

Run: `cd /home/user/dev/nyxhive && bun run src/cli/index.ts devices`
Expected: Lists devices (or "No devices registered")

**Step 5: Commit**

```bash
git add src/cli/devices.ts src/cli/index.ts
git commit -m "feat: add CLI devices command (list, approve, revoke)"
```

---

### Task 5: Create Toast notification component for gateway

**Files:**
- Create: `src/gateway/src/components/ui/toast.tsx`

**Step 1: Create a minimal Toast component**

Build a simple toast system using React state + CSS animations. No dependencies.

```tsx
import { useState, useEffect, useCallback, createContext, useContext } from "react";

interface Toast {
  id: string;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
}

interface ToastContextValue {
  addToast: (toast: Omit<Toast, "id">) => void;
}

const ToastContext = createContext<ToastContextValue>({ addToast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((toast: Omit<Toast, "id">) => {
    const id = crypto.randomUUID();
    setToasts(prev => [...prev, { ...toast, id }]);
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map(toast => (
          <ToastItem key={toast.id} toast={toast} onDismiss={() => removeToast(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast.action) {
      const timer = setTimeout(onDismiss, toast.duration ?? 8000);
      return () => clearTimeout(timer);
    }
  }, [toast, onDismiss]);

  return (
    <div className="animate-in slide-in-from-right rounded-lg border border-zinc-700 bg-zinc-900 p-4 shadow-lg min-w-[320px] max-w-[420px]">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <p className="text-sm font-medium text-zinc-100">{toast.title}</p>
          {toast.description && (
            <p className="mt-1 text-xs text-zinc-400">{toast.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {toast.action && (
            <button
              onClick={() => { toast.action!.onClick(); onDismiss(); }}
              className="rounded-md bg-white px-3 py-1.5 text-xs font-medium text-black hover:bg-zinc-200 transition-colors"
            >
              {toast.action.label}
            </button>
          )}
          <button onClick={onDismiss} className="text-zinc-500 hover:text-zinc-300 text-lg leading-none">&times;</button>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Verify build**

Run: `cd /home/user/dev/nyxhive && bun run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/gateway/src/components/ui/toast.tsx
git commit -m "feat: add Toast notification component"
```

---

### Task 6: Wire up device event listener in gateway

**Files:**
- Modify: `src/gateway/src/App.tsx` (or top-level layout) — wrap with ToastProvider
- Create: `src/gateway/src/hooks/useDeviceNotifications.ts`
- Modify: `src/gateway/src/pages/Devices.tsx` — refresh on device events

**Step 1: Find App.tsx or layout root**

Need to read App.tsx to know where to wrap ToastProvider.

**Step 2: Create useDeviceNotifications hook**

```typescript
import { useEffect } from "react";
import { gateway } from "../lib/ws";
import { useToast } from "../components/ui/toast";

export function useDeviceNotifications() {
  const { addToast } = useToast();

  useEffect(() => {
    const unsubPending = gateway.on("device:pending", (frame) => {
      const { deviceId, deviceName } = frame.payload as { deviceId: string; deviceName: string };
      addToast({
        title: "New device requesting access",
        description: `"${deviceName}" (${deviceId.slice(0, 8)}...)`,
        action: {
          label: "Approve",
          onClick: async () => {
            try {
              await gateway.request("devices.approve", { deviceId });
            } catch {
              // Will show on devices page if it fails
            }
          },
        },
      });
    });

    const unsubApproved = gateway.on("device:approved", (frame) => {
      const { deviceName } = frame.payload as { deviceName: string };
      addToast({
        title: "Device approved",
        description: `"${deviceName}" can now connect`,
        duration: 5000,
      });
    });

    const unsubRevoked = gateway.on("device:revoked", () => {
      addToast({
        title: "Device revoked",
        duration: 5000,
      });
    });

    return () => {
      unsubPending();
      unsubApproved();
      unsubRevoked();
    };
  }, [addToast]);
}
```

**Step 3: Wrap app with ToastProvider and call useDeviceNotifications**

In App.tsx (or layout), add:
- Import `ToastProvider` and wrap around children
- Import `useDeviceNotifications` and call in a component inside the provider

**Step 4: Update Devices.tsx to listen for device events and auto-refresh**

Add to the DevicesPage component:

```typescript
useEffect(() => {
  const unsub1 = gateway.on("device:pending", () => load());
  const unsub2 = gateway.on("device:approved", () => load());
  const unsub3 = gateway.on("device:revoked", () => load());
  return () => { unsub1(); unsub2(); unsub3(); };
}, [load]);
```

**Step 5: Verify build**

Run: `cd /home/user/dev/nyxhive && bun run build`
Expected: PASS

**Step 6: Commit**

```bash
git add src/gateway/src/components/ui/toast.tsx src/gateway/src/hooks/useDeviceNotifications.ts src/gateway/src/App.tsx src/gateway/src/pages/Devices.tsx
git commit -m "feat: real-time device notifications with toast in gateway"
```

---

### Task 7: Verify end-to-end

**Step 1: Restart NyxHive server**

Run: `nyxhive restart`

**Step 2: Test CLI**

```bash
nyxhive devices list
nyxhive devices approve <partial-id>
```

**Step 3: Test gateway**

Open gateway in browser, trigger a new device connection, verify toast appears with Approve button.

**Step 4: Verify broadcast**

After approving from toast, verify Devices page auto-refreshes (no manual reload needed).

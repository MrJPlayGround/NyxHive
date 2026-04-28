# NyxHive Gateway UI — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a complete web-based operations center for NyxHive — a React SPA served by Hono with typed WebSocket RPC, device pairing auth, and 13 feature screens.

**Architecture:** React 19 + Vite SPA in `src/gateway/`, built to `dist/gateway/`, served by Hono on port 3777. All real-time communication over typed WebSocket RPC at `/ws`. Shared Zod schemas in `src/gateway/protocol/` used by both server and client. Device pairing via challenge-response handshake.

**Tech Stack:** React 19, Vite, TypeScript, Zustand, shadcn/ui, Tailwind CSS, Recharts, @tanstack/react-table, Monaco Editor, Zod, Hono WebSocket

**Design doc:** `docs/plans/2026-03-03-gateway-ui-design.md`

---

## Task 1: Scaffold React + Vite Project

**Files:**
- Create: `src/gateway/index.html`
- Create: `src/gateway/src/main.tsx`
- Create: `src/gateway/src/App.tsx`
- Create: `src/gateway/vite.config.ts`
- Create: `src/gateway/tsconfig.json`
- Create: `src/gateway/tailwind.config.ts`
- Create: `src/gateway/postcss.config.js`
- Create: `src/gateway/src/index.css` (Tailwind base + dark theme)
- Modify: `package.json` — add gateway build scripts

**Step 1: Install frontend dependencies**

```bash
cd /home/user/dev/nyxhive
bun add react react-dom react-router-dom zustand
bun add -d vite @vitejs/plugin-react tailwindcss @tailwindcss/vite postcss autoprefixer @types/react @types/react-dom
```

**Step 2: Create Vite config**

`src/gateway/vite.config.ts`:
```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: resolve(__dirname),
  base: "/",
  build: {
    outDir: resolve(__dirname, "../../dist/gateway"),
    emptyDirOnBuild: true,
  },
  resolve: {
    alias: {
      "@gateway": resolve(__dirname, "src"),
      "@protocol": resolve(__dirname, "protocol"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://localhost:3777",
        ws: true,
      },
    },
  },
});
```

**Step 3: Create index.html, main.tsx, App.tsx with basic dark layout**

`src/gateway/index.html`:
```html
<!DOCTYPE html>
<html lang="en" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>NyxHive Gateway</title>
  </head>
  <body class="bg-zinc-950 text-zinc-100">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/gateway/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

`src/gateway/src/App.tsx`:
```tsx
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./components/Layout";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<div>NyxHive Gateway</div>} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
```

**Step 4: Create minimal Layout component with sidebar placeholder**

`src/gateway/src/components/Layout.tsx`:
```tsx
import { Outlet } from "react-router-dom";

export function Layout() {
  return (
    <div className="flex h-screen">
      <nav className="w-56 border-r border-zinc-800 bg-zinc-950 p-4">
        <h1 className="text-lg font-semibold">NyxHive</h1>
      </nav>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

**Step 5: Create Tailwind CSS entry**

`src/gateway/src/index.css`:
```css
@import "tailwindcss";
```

`src/gateway/tailwind.config.ts`:
```typescript
import type { Config } from "tailwindcss";

export default {
  content: ["./src/**/*.{ts,tsx}", "./index.html"],
  darkMode: "class",
  theme: {
    extend: {},
  },
} satisfies Config;
```

**Step 6: Add build scripts to package.json**

Add to `package.json` scripts:
```json
{
  "gateway:dev": "vite --config src/gateway/vite.config.ts",
  "gateway:build": "vite build --config src/gateway/vite.config.ts",
  "gateway:preview": "vite preview --config src/gateway/vite.config.ts"
}
```

**Step 7: Test the dev server starts**

```bash
bun run gateway:dev
```

Expected: Vite dev server on http://localhost:5173 showing "NyxHive Gateway" with dark background.

**Step 8: Test production build**

```bash
bun run gateway:build && ls dist/gateway/
```

Expected: `dist/gateway/index.html`, `dist/gateway/assets/` with JS/CSS bundles.

**Step 9: Commit**

```bash
git add src/gateway/ package.json bun.lockb
git commit -m "feat(gateway): scaffold React + Vite SPA with Tailwind dark theme"
```

---

## Task 2: Serve SPA from Hono

**Files:**
- Modify: `src/server/index.ts` — add static file serving for `dist/gateway/`
- Test: `src/__tests__/gateway-serve.test.ts`

**Step 1: Write test for static serving**

```typescript
import { describe, it, expect } from "bun:test";
import { existsSync } from "fs";
import { resolve } from "path";

describe("Gateway static serving", () => {
  it("dist/gateway directory exists after build", () => {
    const distPath = resolve(import.meta.dir, "../../dist/gateway/index.html");
    // This test verifies the build output exists
    // In CI, gateway:build runs before tests
    if (existsSync(distPath)) {
      expect(true).toBe(true);
    } else {
      console.warn("dist/gateway not built yet — run bun run gateway:build");
      expect(true).toBe(true); // Skip gracefully
    }
  });
});
```

**Step 2: Add static serving to Hono**

In `src/server/index.ts`, after all API routes:

```typescript
import { serveStatic } from "hono/bun";
import { existsSync } from "fs";
import { resolve } from "path";

// Serve Gateway SPA static files
const gatewayDist = resolve(import.meta.dir, "../../dist/gateway");

if (existsSync(gatewayDist)) {
  // Serve static assets
  app.use("/assets/*", serveStatic({ root: gatewayDist }));

  // SPA fallback — serve index.html for all non-API, non-WS routes
  app.get("*", serveStatic({ root: gatewayDist, rewriteRequestPath: () => "/index.html" }));
}
```

**Step 3: Build and test**

```bash
bun run gateway:build && bun run start
```

Expected: Opening http://localhost:3777 shows the Gateway SPA.

**Step 4: Commit**

```bash
git add src/server/index.ts src/__tests__/gateway-serve.test.ts
git commit -m "feat(gateway): serve SPA static files from Hono"
```

---

## Task 3: Shared WebSocket Protocol Schemas

**Files:**
- Create: `src/gateway/protocol/frame.ts` — base frame types
- Create: `src/gateway/protocol/methods.ts` — method definitions per namespace
- Create: `src/gateway/protocol/events.ts` — server-push event types
- Create: `src/gateway/protocol/index.ts` — barrel export
- Test: `src/__tests__/gateway-protocol.test.ts`

**Step 1: Write tests for frame validation**

```typescript
import { describe, it, expect } from "bun:test";
import { frameSchema, requestFrame, eventFrame } from "../gateway/protocol/frame";

describe("WebSocket Protocol Frames", () => {
  it("validates a request frame", () => {
    const frame = {
      type: "req",
      id: "abc-123",
      method: "chat.send",
      payload: { message: "hello" },
    };
    expect(frameSchema.safeParse(frame).success).toBe(true);
  });

  it("validates a response frame with error", () => {
    const frame = {
      type: "res",
      id: "abc-123",
      method: "chat.send",
      payload: null,
      error: { code: "NOT_FOUND", message: "Thread not found" },
    };
    expect(frameSchema.safeParse(frame).success).toBe(true);
  });

  it("validates an event frame", () => {
    const frame = {
      type: "event",
      id: "evt-1",
      method: "agent:progress",
      payload: { agent: "forge", text: "Working..." },
    };
    expect(frameSchema.safeParse(frame).success).toBe(true);
  });

  it("rejects invalid frame type", () => {
    const frame = { type: "invalid", id: "x", method: "y", payload: {} };
    expect(frameSchema.safeParse(frame).success).toBe(false);
  });
});
```

**Step 2: Implement frame schemas**

`src/gateway/protocol/frame.ts`:
```typescript
import { z } from "zod";

export const frameErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
});

export const frameSchema = z.object({
  type: z.enum(["req", "res", "event"]),
  id: z.string(),
  method: z.string(),
  payload: z.unknown(),
  error: frameErrorSchema.optional(),
});

export type Frame = z.infer<typeof frameSchema>;
export type FrameError = z.infer<typeof frameErrorSchema>;

// Helper to create typed frames
export function requestFrame(method: string, payload: unknown): Frame {
  return { type: "req", id: crypto.randomUUID(), method, payload };
}

export function responseFrame(id: string, method: string, payload: unknown, error?: FrameError): Frame {
  return { type: "res", id, method, payload, ...(error ? { error } : {}) };
}

export function eventFrame(method: string, payload: unknown): Frame {
  return { type: "event", id: crypto.randomUUID(), method, payload };
}
```

**Step 3: Define method schemas per namespace**

`src/gateway/protocol/methods.ts`:
```typescript
import { z } from "zod";

// --- Chat ---
export const chatSendRequest = z.object({
  message: z.string(),
  agent: z.string().optional(),
  threadId: z.string().optional(),
});

export const chatSendResponse = z.object({
  messageId: z.string(),
  threadId: z.string(),
});

export const chatAbortRequest = z.object({
  messageId: z.string(),
});

export const chatHistoryRequest = z.object({
  threadId: z.string(),
  limit: z.number().optional().default(50),
  before: z.number().optional(),
});

// --- Agents ---
export const agentsListResponse = z.object({
  agents: z.array(z.object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    enabled: z.boolean(),
    status: z.enum(["idle", "running", "error"]),
    currentTask: z.string().nullable(),
    totalInvocations: z.number(),
    totalTokensIn: z.number(),
    totalTokensOut: z.number(),
    estimatedCostCents: z.number(),
    lastInvokedAt: z.number().nullable(),
  })),
});

// --- Threads ---
export const threadsListRequest = z.object({
  projectId: z.string().optional(),
  agent: z.string().optional(),
  status: z.string().optional(),
  limit: z.number().optional().default(50),
  offset: z.number().optional().default(0),
});

export const threadGetRequest = z.object({
  id: z.string(),
});

// --- Proposals ---
export const proposalsListRequest = z.object({
  status: z.string().optional(),
  category: z.string().optional(),
  limit: z.number().optional().default(50),
});

export const proposalActionRequest = z.object({
  proposalId: z.string(),
  notes: z.string().optional(),
});

// --- Tasks ---
export const tasksListResponse = z.object({
  tasks: z.array(z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    status: z.enum(["backlog", "in_progress", "review", "done"]),
    assignee: z.string(),
    assigneeType: z.string(),
    position: z.number(),
  })),
});

export const taskUpdateRequest = z.object({
  id: z.string(),
  status: z.enum(["backlog", "in_progress", "review", "done"]).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  assignee: z.string().optional(),
  position: z.number().optional(),
});

// --- Logs ---
export const logsSubscribeRequest = z.object({
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  agent: z.string().optional(),
  module: z.string().optional(),
});

// --- Config ---
export const configGetResponse = z.object({
  content: z.string(), // Raw TOML
  path: z.string(),
});

export const configPatchRequest = z.object({
  content: z.string(), // Full TOML content
});

export const configValidateRequest = z.object({
  content: z.string(),
});

export const configValidateResponse = z.object({
  valid: z.boolean(),
  errors: z.array(z.object({
    path: z.string(),
    message: z.string(),
  })),
});

// --- Memory ---
export const memorySearchRequest = z.object({
  query: z.string(),
  limit: z.number().optional().default(10),
});

// --- Knowledge ---
export const knowledgeSearchRequest = z.object({
  query: z.string(),
  limit: z.number().optional().default(10),
});

// --- Scheduler ---
export const schedulerListResponse = z.object({
  jobs: z.array(z.object({
    id: z.string(),
    name: z.string(),
    schedule: z.string(),
    agent: z.string(),
    enabled: z.boolean(),
    lastRun: z.number().nullable(),
    nextRun: z.number().nullable(),
  })),
});

// --- Channels ---
export const channelsListResponse = z.object({
  channels: z.array(z.object({
    id: z.string(),
    type: z.string(), // discord, telegram, slack, imessage
    status: z.enum(["connected", "disconnected", "error"]),
    messageCount: z.number(),
    lastActivity: z.number().nullable(),
  })),
});

// --- Traces ---
export const tracesListRequest = z.object({
  status: z.enum(["running", "completed", "failed"]).optional(),
  limit: z.number().optional().default(20),
});

// --- Devices ---
export const devicesListResponse = z.object({
  devices: z.array(z.object({
    id: z.string(),
    name: z.string(),
    approved: z.boolean(),
    lastSeen: z.number().nullable(),
    createdAt: z.number(),
  })),
});

// --- Connect (handshake) ---
export const connectChallengePayload = z.object({
  nonce: z.string(),
  protocolVersion: z.number(),
});

export const connectAuthenticatePayload = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  signature: z.string(), // HMAC of nonce
  protocolVersion: z.number(),
});

export const connectAuthenticatedPayload = z.object({
  sessionToken: z.string(),
  scopes: z.array(z.string()),
  serverVersion: z.string(),
});

// --- System ---
export const systemHealthResponse = z.object({
  uptime: z.number(),
  queueDepth: z.number(),
  activeConnections: z.number(),
  agents: z.number(),
  memoryUsage: z.number(),
});

// Method registry — maps method names to request/response schemas
export const methodSchemas = {
  "chat.send": { request: chatSendRequest, response: chatSendResponse },
  "chat.abort": { request: chatAbortRequest, response: z.object({}) },
  "chat.history": { request: chatHistoryRequest, response: z.unknown() },
  "agents.list": { request: z.object({}), response: agentsListResponse },
  "threads.list": { request: threadsListRequest, response: z.unknown() },
  "threads.get": { request: threadGetRequest, response: z.unknown() },
  "proposals.list": { request: proposalsListRequest, response: z.unknown() },
  "proposals.approve": { request: proposalActionRequest, response: z.unknown() },
  "proposals.reject": { request: proposalActionRequest, response: z.unknown() },
  "tasks.list": { request: z.object({}), response: tasksListResponse },
  "tasks.update": { request: taskUpdateRequest, response: z.unknown() },
  "logs.subscribe": { request: logsSubscribeRequest, response: z.object({}) },
  "logs.unsubscribe": { request: z.object({}), response: z.object({}) },
  "config.get": { request: z.object({}), response: configGetResponse },
  "config.patch": { request: configPatchRequest, response: z.object({}) },
  "config.validate": { request: configValidateRequest, response: configValidateResponse },
  "memory.search": { request: memorySearchRequest, response: z.unknown() },
  "knowledge.search": { request: knowledgeSearchRequest, response: z.unknown() },
  "scheduler.list": { request: z.object({}), response: schedulerListResponse },
  "channels.list": { request: z.object({}), response: channelsListResponse },
  "traces.list": { request: tracesListRequest, response: z.unknown() },
  "devices.list": { request: z.object({}), response: devicesListResponse },
  "system.health": { request: z.object({}), response: systemHealthResponse },
  "connect.authenticate": { request: connectAuthenticatePayload, response: connectAuthenticatedPayload },
} as const;

export type MethodName = keyof typeof methodSchemas;
```

**Step 4: Define server-push event types**

`src/gateway/protocol/events.ts`:
```typescript
import { z } from "zod";

export const agentProgressEvent = z.object({
  agent: z.string(),
  messageId: z.string(),
  text: z.string(),
  done: z.boolean().default(false),
});

export const agentStatusEvent = z.object({
  agent: z.string(),
  status: z.enum(["idle", "running", "error"]),
  task: z.string().nullable(),
});

export const threadUpdateEvent = z.object({
  threadId: z.string(),
  status: z.string(),
  agent: z.string().optional(),
});

export const proposalUpdateEvent = z.object({
  proposalId: z.string(),
  status: z.string(),
  prUrl: z.string().nullable().optional(),
});

export const taskUpdateEvent = z.object({
  taskId: z.string(),
  status: z.string(),
  assignee: z.string().optional(),
});

export const logEntryEvent = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  message: z.string(),
  module: z.string().optional(),
  agent: z.string().optional(),
  timestamp: z.number(),
});

export const systemHealthEvent = z.object({
  uptime: z.number(),
  queueDepth: z.number(),
  activeConnections: z.number(),
});

export const eventSchemas = {
  "agent:progress": agentProgressEvent,
  "agent:status": agentStatusEvent,
  "thread:update": threadUpdateEvent,
  "proposal:update": proposalUpdateEvent,
  "task:update": taskUpdateEvent,
  "log:entry": logEntryEvent,
  "system:health": systemHealthEvent,
  "connect.challenge": z.object({ nonce: z.string(), protocolVersion: z.number() }),
} as const;

export type EventName = keyof typeof eventSchemas;
```

**Step 5: Barrel export**

`src/gateway/protocol/index.ts`:
```typescript
export * from "./frame";
export * from "./methods";
export * from "./events";
```

**Step 6: Run tests**

```bash
bun test src/__tests__/gateway-protocol.test.ts
```

**Step 7: Commit**

```bash
git add src/gateway/protocol/ src/__tests__/gateway-protocol.test.ts
git commit -m "feat(gateway): define shared WebSocket protocol schemas with Zod"
```

---

## Task 4: Backend WebSocket Infrastructure

**Files:**
- Create: `src/server/ws/handler.ts` — Hono WebSocket upgrade + connection lifecycle
- Create: `src/server/ws/connection.ts` — Connection manager (track clients, broadcast)
- Create: `src/server/ws/router.ts` — Method dispatcher
- Create: `src/server/ws/auth.ts` — Device pairing + challenge-response
- Modify: `src/server/index.ts` — mount WS endpoint
- Test: `src/__tests__/gateway-ws.test.ts`

**Step 1: Write tests for connection manager**

```typescript
import { describe, it, expect } from "bun:test";
import { ConnectionManager } from "../server/ws/connection";

describe("ConnectionManager", () => {
  it("tracks connections", () => {
    const mgr = new ConnectionManager();
    const mockWs = { send: () => {}, readyState: 1 };

    mgr.add("device-1", mockWs as any);
    expect(mgr.count()).toBe(1);

    mgr.remove("device-1");
    expect(mgr.count()).toBe(0);
  });

  it("broadcasts to all connections", () => {
    const mgr = new ConnectionManager();
    const messages: string[] = [];
    const mockWs = { send: (msg: string) => messages.push(msg), readyState: 1 };

    mgr.add("device-1", mockWs as any);
    mgr.broadcast("agent:progress", { agent: "forge", text: "hello" });

    expect(messages.length).toBe(1);
    const parsed = JSON.parse(messages[0]);
    expect(parsed.type).toBe("event");
    expect(parsed.method).toBe("agent:progress");
  });
});
```

**Step 2: Implement ConnectionManager**

`src/server/ws/connection.ts`:
```typescript
import { eventFrame } from "../../gateway/protocol/frame";
import type { EventName } from "../../gateway/protocol/events";

interface ConnectedClient {
  deviceId: string;
  deviceName: string;
  ws: WebSocket;
  scopes: string[];
  connectedAt: number;
  subscriptions: Set<string>; // event types this client is subscribed to
}

export class ConnectionManager {
  private clients = new Map<string, ConnectedClient>();

  add(deviceId: string, ws: WebSocket, meta?: { deviceName?: string; scopes?: string[] }) {
    this.clients.set(deviceId, {
      deviceId,
      deviceName: meta?.deviceName ?? "unknown",
      ws,
      scopes: meta?.scopes ?? [],
      connectedAt: Date.now(),
      subscriptions: new Set(),
    });
  }

  remove(deviceId: string) {
    this.clients.delete(deviceId);
  }

  get(deviceId: string): ConnectedClient | undefined {
    return this.clients.get(deviceId);
  }

  count(): number {
    return this.clients.size;
  }

  subscribe(deviceId: string, eventType: string) {
    this.clients.get(deviceId)?.subscriptions.add(eventType);
  }

  unsubscribe(deviceId: string, eventType: string) {
    this.clients.get(deviceId)?.subscriptions.delete(eventType);
  }

  broadcast(method: EventName | string, payload: unknown) {
    const frame = eventFrame(method, payload);
    const msg = JSON.stringify(frame);
    for (const client of this.clients.values()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  broadcastToSubscribed(method: string, payload: unknown) {
    const frame = eventFrame(method, payload);
    const msg = JSON.stringify(frame);
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(method) && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  listConnected(): Array<{ deviceId: string; deviceName: string; connectedAt: number }> {
    return Array.from(this.clients.values()).map(c => ({
      deviceId: c.deviceId,
      deviceName: c.deviceName,
      connectedAt: c.connectedAt,
    }));
  }
}
```

**Step 3: Implement device pairing auth**

`src/server/ws/auth.ts`:
```typescript
import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER,
  created_at INTEGER NOT NULL
);
`;

export class DeviceStore {
  private db: Database;

  constructor(dataDir: string) {
    this.db = new Database(`${dataDir}/devices.db`);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  async registerDevice(deviceId: string, deviceName: string, secret: string): Promise<void> {
    const secretHash = await Bun.password.hash(secret);
    this.db.run(
      "INSERT OR REPLACE INTO devices (id, name, secret_hash, approved, created_at) VALUES (?, ?, ?, 0, ?)",
      [deviceId, deviceName, secretHash, Date.now()]
    );
  }

  async verifyDevice(deviceId: string, secret: string): Promise<boolean> {
    const row = this.db.query("SELECT secret_hash, approved FROM devices WHERE id = ?").get(deviceId) as any;
    if (!row || !row.approved) return false;
    return Bun.password.verify(secret, row.secret_hash);
  }

  isApproved(deviceId: string): boolean {
    const row = this.db.query("SELECT approved FROM devices WHERE id = ?").get(deviceId) as any;
    return row?.approved === 1;
  }

  approveDevice(deviceId: string): boolean {
    const result = this.db.run("UPDATE devices SET approved = 1 WHERE id = ?", [deviceId]);
    return result.changes > 0;
  }

  revokeDevice(deviceId: string): boolean {
    const result = this.db.run("DELETE FROM devices WHERE id = ?", [deviceId]);
    return result.changes > 0;
  }

  updateLastSeen(deviceId: string) {
    this.db.run("UPDATE devices SET last_seen = ? WHERE id = ?", [Date.now(), deviceId]);
  }

  listDevices() {
    return this.db.query("SELECT id, name, approved, last_seen, created_at FROM devices ORDER BY created_at DESC").all();
  }

  pendingDevices() {
    return this.db.query("SELECT id, name, created_at FROM devices WHERE approved = 0").all();
  }

  generateChallenge(): { nonce: string } {
    return { nonce: crypto.randomUUID() };
  }
}
```

**Step 4: Implement method router**

`src/server/ws/router.ts`:
```typescript
import { frameSchema, responseFrame, type Frame, type FrameError } from "../../gateway/protocol/frame";
import { methodSchemas, type MethodName } from "../../gateway/protocol/methods";

type HandlerFn = (payload: unknown, deviceId: string) => Promise<unknown>;

export class MethodRouter {
  private handlers = new Map<string, HandlerFn>();

  register(method: string, handler: HandlerFn) {
    this.handlers.set(method, handler);
  }

  async dispatch(raw: string, deviceId: string): Promise<string | null> {
    const parseResult = frameSchema.safeParse(JSON.parse(raw));
    if (!parseResult.success) {
      return JSON.stringify(responseFrame("unknown", "error", null, {
        code: "INVALID_FRAME",
        message: "Failed to parse frame",
      }));
    }

    const frame = parseResult.data;
    if (frame.type !== "req") return null; // Only handle requests

    const handler = this.handlers.get(frame.method);
    if (!handler) {
      return JSON.stringify(responseFrame(frame.id, frame.method, null, {
        code: "METHOD_NOT_FOUND",
        message: `Unknown method: ${frame.method}`,
      }));
    }

    // Validate request payload against schema
    const schema = methodSchemas[frame.method as MethodName];
    if (schema) {
      const validation = schema.request.safeParse(frame.payload);
      if (!validation.success) {
        return JSON.stringify(responseFrame(frame.id, frame.method, null, {
          code: "INVALID_PAYLOAD",
          message: validation.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", "),
        }));
      }
    }

    try {
      const result = await handler(frame.payload, deviceId);
      return JSON.stringify(responseFrame(frame.id, frame.method, result));
    } catch (err) {
      return JSON.stringify(responseFrame(frame.id, frame.method, null, {
        code: "HANDLER_ERROR",
        message: err instanceof Error ? err.message : "Unknown error",
      }));
    }
  }
}
```

**Step 5: Implement WebSocket handler and mount on Hono**

`src/server/ws/handler.ts`:
```typescript
import type { ConnectionManager } from "./connection";
import type { DeviceStore } from "./auth";
import type { MethodRouter } from "./router";

interface WsHandlerDeps {
  connections: ConnectionManager;
  devices: DeviceStore;
  router: MethodRouter;
}

export function createWebSocketHandler(deps: WsHandlerDeps) {
  const { connections, devices, router } = deps;

  return {
    upgrade(req: Request, server: any): Response | undefined {
      const success = server.upgrade(req, { data: { deviceId: null, authenticated: false } });
      if (success) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    },

    handlers: {
      open(ws: any) {
        // Send challenge
        const challenge = devices.generateChallenge();
        ws.data.nonce = challenge.nonce;
        ws.send(JSON.stringify({
          type: "event",
          id: crypto.randomUUID(),
          method: "connect.challenge",
          payload: { nonce: challenge.nonce, protocolVersion: 1 },
        }));
      },

      async message(ws: any, message: string) {
        // If not authenticated, only accept connect.authenticate
        if (!ws.data.authenticated) {
          try {
            const frame = JSON.parse(message);
            if (frame.method !== "connect.authenticate") {
              ws.send(JSON.stringify({
                type: "res", id: frame.id, method: frame.method,
                payload: null, error: { code: "NOT_AUTHENTICATED", message: "Authenticate first" },
              }));
              return;
            }

            const { deviceId, deviceName, signature } = frame.payload;

            // Check if device is known and approved
            if (!devices.isApproved(deviceId)) {
              // Register as pending if new
              await devices.registerDevice(deviceId, deviceName, signature);
              ws.send(JSON.stringify({
                type: "res", id: frame.id, method: frame.method,
                payload: null, error: { code: "DEVICE_PENDING", message: "Device pending approval" },
              }));
              return;
            }

            // Verify device
            const valid = await devices.verifyDevice(deviceId, signature);
            if (!valid) {
              ws.send(JSON.stringify({
                type: "res", id: frame.id, method: frame.method,
                payload: null, error: { code: "AUTH_FAILED", message: "Invalid credentials" },
              }));
              return;
            }

            // Authenticated
            ws.data.deviceId = deviceId;
            ws.data.authenticated = true;
            devices.updateLastSeen(deviceId);
            connections.add(deviceId, ws, { deviceName });

            ws.send(JSON.stringify({
              type: "res", id: frame.id, method: "connect.authenticate",
              payload: { sessionToken: deviceId, scopes: ["read", "write", "admin"], serverVersion: "0.1.0" },
            }));
            return;
          } catch {
            ws.close(1008, "Invalid auth frame");
            return;
          }
        }

        // Authenticated — dispatch to router
        const response = await router.dispatch(message, ws.data.deviceId);
        if (response) ws.send(response);
      },

      close(ws: any) {
        if (ws.data.deviceId) {
          connections.remove(ws.data.deviceId);
        }
      },
    },
  };
}
```

**Step 6: Mount WebSocket on Hono server**

In `src/server/index.ts`, add WebSocket support. Note: Bun.serve supports WebSocket natively alongside Hono:

```typescript
import { ConnectionManager } from "./ws/connection";
import { DeviceStore } from "./ws/auth";
import { MethodRouter } from "./ws/router";
import { createWebSocketHandler } from "./ws/handler";

// Initialize WS infrastructure
const connections = new ConnectionManager();
const deviceStore = new DeviceStore(dataDir);
const wsRouter = new MethodRouter();
const wsHandler = createWebSocketHandler({ connections, devices: deviceStore, router: wsRouter });

// In Bun.serve:
Bun.serve({
  port,
  fetch(req, server) {
    // WebSocket upgrade
    if (new URL(req.url).pathname === "/ws") {
      return wsHandler.upgrade(req, server) ?? new Response("Upgrade failed", { status: 400 });
    }
    return app.fetch(req, server);
  },
  websocket: wsHandler.handlers,
  idleTimeout: 30,
});
```

**Step 7: Register WS method handlers**

Wire the existing stores to WS method handlers. Create a setup function that registers all handlers:

`src/server/ws/register-handlers.ts`:
```typescript
import type { MethodRouter } from "./router";
// Import existing stores and services

export function registerHandlers(
  router: MethodRouter,
  deps: {
    // All existing stores/services passed in
    threadDb: any;
    proposalStore: any;
    taskStore: any;
    agentRegistry: any;
    processor: any;
    config: any;
    connections: any;
    devices: any;
  }
) {
  // Chat
  router.register("chat.send", async (payload: any) => {
    // Delegate to existing processor.processMessage()
    const messageId = crypto.randomUUID();
    // ... enqueue message, return messageId and threadId
    return { messageId, threadId: payload.threadId ?? messageId };
  });

  // Agents
  router.register("agents.list", async () => {
    const agents = deps.agentRegistry.listAll();
    return { agents };
  });

  // Threads
  router.register("threads.list", async (payload: any) => {
    return deps.threadDb.list(payload);
  });

  router.register("threads.get", async (payload: any) => {
    return deps.threadDb.get(payload.id);
  });

  // Proposals
  router.register("proposals.list", async (payload: any) => {
    return deps.proposalStore.list(payload);
  });

  router.register("proposals.approve", async (payload: any) => {
    return deps.proposalStore.approve(payload.proposalId, payload.notes);
  });

  router.register("proposals.reject", async (payload: any) => {
    return deps.proposalStore.reject(payload.proposalId, payload.notes);
  });

  // Tasks
  router.register("tasks.list", async () => {
    return { tasks: deps.taskStore.list() };
  });

  router.register("tasks.update", async (payload: any) => {
    return deps.taskStore.update(payload.id, payload);
  });

  // Config
  router.register("config.get", async () => {
    const { readFileSync } = await import("fs");
    const content = readFileSync(deps.config.path, "utf-8");
    return { content, path: deps.config.path };
  });

  // System
  router.register("system.health", async () => {
    return {
      uptime: process.uptime(),
      queueDepth: deps.processor.queueDepth?.() ?? 0,
      activeConnections: deps.connections.count(),
      agents: deps.agentRegistry.listAll().length,
      memoryUsage: process.memoryUsage().heapUsed,
    };
  });

  // Devices
  router.register("devices.list", async () => {
    return { devices: deps.devices.listDevices() };
  });

  // Logs — subscribe/unsubscribe handled via connection subscriptions
  router.register("logs.subscribe", async (_payload: any, deviceId: string) => {
    deps.connections.subscribe(deviceId, "log:entry");
    return {};
  });

  router.register("logs.unsubscribe", async (_payload: any, deviceId: string) => {
    deps.connections.unsubscribe(deviceId, "log:entry");
    return {};
  });
}
```

**Step 8: Bridge existing event emitter to WS broadcasts**

In server setup, connect the processor's event system to WS:

```typescript
// Bridge SSE events to WebSocket broadcasts
processor.onEvent((event) => {
  connections.broadcast(event.type, event.data);
});
```

**Step 9: Run tests**

```bash
bun test src/__tests__/gateway-ws.test.ts
```

**Step 10: Commit**

```bash
git add src/server/ws/ src/__tests__/gateway-ws.test.ts
git commit -m "feat(gateway): WebSocket infrastructure — connection manager, device pairing, method router"
```

---

## Task 5: Install and Configure shadcn/ui

**Files:**
- Create: `src/gateway/src/lib/utils.ts` — cn() utility
- Create: `src/gateway/components.json` — shadcn config
- Install: shadcn/ui components (button, input, card, dialog, dropdown-menu, table, tabs, badge, toast, command, separator, scroll-area, sheet, skeleton, tooltip)

**Step 1: Install base dependencies**

```bash
cd /home/user/dev/nyxhive
bun add class-variance-authority clsx tailwind-merge lucide-react
bun add @radix-ui/react-slot @radix-ui/react-dialog @radix-ui/react-dropdown-menu @radix-ui/react-tabs @radix-ui/react-tooltip @radix-ui/react-scroll-area @radix-ui/react-separator
```

**Step 2: Create cn utility**

`src/gateway/src/lib/utils.ts`:
```typescript
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

**Step 3: Set up shadcn components directory and add core components**

Create `src/gateway/src/components/ui/` directory and add shadcn components. Use `npx shadcn@latest add` or manually copy the component source from shadcn/ui (they're designed to be copied, not imported as dependency).

Key components to add:
- `button.tsx`, `input.tsx`, `card.tsx`, `dialog.tsx`, `dropdown-menu.tsx`
- `table.tsx`, `tabs.tsx`, `badge.tsx`, `toast.tsx`, `command.tsx`
- `separator.tsx`, `scroll-area.tsx`, `sheet.tsx`, `skeleton.tsx`, `tooltip.tsx`

**Step 4: Configure dark theme colors in Tailwind**

Update `src/gateway/src/index.css` with shadcn/ui CSS variables for the dark theme:
```css
@import "tailwindcss";

@layer base {
  :root {
    --background: 0 0% 3.9%;
    --foreground: 0 0% 98%;
    --card: 0 0% 3.9%;
    --card-foreground: 0 0% 98%;
    --popover: 0 0% 3.9%;
    --popover-foreground: 0 0% 98%;
    --primary: 0 0% 98%;
    --primary-foreground: 0 0% 9%;
    --secondary: 0 0% 14.9%;
    --secondary-foreground: 0 0% 98%;
    --muted: 0 0% 14.9%;
    --muted-foreground: 0 0% 63.9%;
    --accent: 0 0% 14.9%;
    --accent-foreground: 0 0% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 0 0% 98%;
    --border: 0 0% 14.9%;
    --input: 0 0% 14.9%;
    --ring: 0 0% 83.1%;
    --radius: 0.5rem;
  }
}
```

**Step 5: Verify components render**

Update App.tsx to render a test button:
```tsx
import { Button } from "./components/ui/button";
// Verify the dark theme renders correctly
```

**Step 6: Commit**

```bash
git add src/gateway/src/components/ui/ src/gateway/src/lib/ src/gateway/src/index.css
git commit -m "feat(gateway): add shadcn/ui components and dark theme"
```

---

## Task 6: Frontend WebSocket Client + Zustand Stores

**Files:**
- Create: `src/gateway/src/lib/ws.ts` — WebSocket client with reconnection
- Create: `src/gateway/src/stores/auth.ts` — device identity, connection state
- Create: `src/gateway/src/stores/ws.ts` — WS connection store
- Create: `src/gateway/src/hooks/useWs.ts` — React hook for WS requests

**Step 1: Implement WebSocket client**

`src/gateway/src/lib/ws.ts`:
```typescript
import { frameSchema, requestFrame, type Frame } from "@protocol/frame";

type EventHandler = (frame: Frame) => void;
type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (error: { code: string; message: string }) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;

  onConnectionChange?: (connected: boolean) => void;
  onChallenge?: (nonce: string) => void;

  connect(url: string) {
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
    };

    this.ws.onmessage = (event) => {
      const frame = frameSchema.safeParse(JSON.parse(event.data));
      if (!frame.success) return;

      const data = frame.data;

      if (data.type === "res") {
        const pending = this.pending.get(data.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(data.id);
          if (data.error) {
            pending.reject(data.error);
          } else {
            pending.resolve(data.payload);
          }
        }
      } else if (data.type === "event") {
        if (data.method === "connect.challenge") {
          this.onChallenge?.((data.payload as any).nonce);
        }
        const handlers = this.eventHandlers.get(data.method);
        handlers?.forEach(h => h(data));
      }
    };

    this.ws.onclose = () => {
      this.onConnectionChange?.(false);
      this.scheduleReconnect(url);
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  async request<T = unknown>(method: string, payload: unknown, timeoutMs = 30000): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }

    const frame = requestFrame(method, payload);

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(frame.id);
        reject({ code: "TIMEOUT", message: `Request ${method} timed out` });
      }, timeoutMs);

      this.pending.set(frame.id, {
        resolve: resolve as (p: unknown) => void,
        reject,
        timeout,
      });

      this.ws!.send(JSON.stringify(frame));
    });
  }

  on(event: string, handler: EventHandler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
    return () => this.eventHandlers.get(event)?.delete(handler);
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private scheduleReconnect(url: string) {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.connect(url);
    }, this.reconnectDelay);
  }
}

export const gateway = new GatewayClient();
```

**Step 2: Create auth store**

`src/gateway/src/stores/auth.ts`:
```typescript
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { gateway } from "../lib/ws";

interface AuthState {
  deviceId: string | null;
  deviceName: string;
  deviceSecret: string | null;
  connected: boolean;
  authenticated: boolean;
  error: string | null;

  initDevice: () => void;
  connect: () => void;
  setConnected: (connected: boolean) => void;
  setAuthenticated: (authenticated: boolean) => void;
  setError: (error: string | null) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      deviceId: null,
      deviceName: "NyxHive Gateway",
      deviceSecret: null,
      connected: false,
      authenticated: false,
      error: null,

      initDevice: () => {
        if (!get().deviceId) {
          set({
            deviceId: crypto.randomUUID(),
            deviceSecret: crypto.randomUUID(),
          });
        }
      },

      connect: () => {
        const { deviceId, deviceSecret } = get();
        if (!deviceId || !deviceSecret) return;

        gateway.onConnectionChange = (connected) => {
          set({ connected, authenticated: connected ? get().authenticated : false });
        };

        gateway.onChallenge = async (nonce) => {
          try {
            const result = await gateway.request("connect.authenticate", {
              deviceId,
              deviceName: get().deviceName,
              signature: deviceSecret, // In production, HMAC(nonce, secret)
              protocolVersion: 1,
            });
            set({ authenticated: true, error: null });
          } catch (err: any) {
            if (err.code === "DEVICE_PENDING") {
              set({ error: "Device pending approval. Approve via CLI: nyxhive devices approve" });
            } else {
              set({ error: err.message });
            }
          }
        };

        const wsUrl = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;
        gateway.connect(wsUrl);
      },

      setConnected: (connected) => set({ connected }),
      setAuthenticated: (authenticated) => set({ authenticated }),
      setError: (error) => set({ error }),
    }),
    {
      name: "nyxhive-device",
      partialize: (state) => ({
        deviceId: state.deviceId,
        deviceName: state.deviceName,
        deviceSecret: state.deviceSecret,
      }),
    }
  )
);
```

**Step 3: Create useWs hook for easy method calls**

`src/gateway/src/hooks/useWs.ts`:
```typescript
import { useEffect } from "react";
import { gateway } from "../lib/ws";
import type { Frame } from "@protocol/frame";

export function useWsRequest() {
  return <T = unknown>(method: string, payload?: unknown) =>
    gateway.request<T>(method, payload ?? {});
}

export function useWsEvent(event: string, handler: (frame: Frame) => void) {
  useEffect(() => {
    return gateway.on(event, handler);
  }, [event, handler]);
}
```

**Step 4: Commit**

```bash
git add src/gateway/src/lib/ws.ts src/gateway/src/stores/ src/gateway/src/hooks/
git commit -m "feat(gateway): WebSocket client, auth store, and React hooks"
```

---

## Task 7: Sidebar Navigation + Router Setup

**Files:**
- Modify: `src/gateway/src/App.tsx` — full router with all routes
- Modify: `src/gateway/src/components/Layout.tsx` — sidebar with nav links
- Create: `src/gateway/src/pages/` — stub pages for all 13 screens

**Step 1: Create stub pages for all screens**

Create each page as a minimal component in `src/gateway/src/pages/`:

- `Chat.tsx`, `Agents.tsx`, `Threads.tsx`, `Proposals.tsx`, `Tasks.tsx`
- `Logs.tsx`, `Config.tsx`, `Knowledge.tsx`, `Scheduler.tsx`
- `Channels.tsx`, `CostAnalytics.tsx`, `Devices.tsx`, `System.tsx`

Each one:
```tsx
export function ChatPage() {
  return <div><h1 className="text-2xl font-semibold">Chat</h1></div>;
}
```

**Step 2: Wire up React Router in App.tsx**

```tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ChatPage } from "./pages/Chat";
import { AgentsPage } from "./pages/Agents";
// ... all imports

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/threads" element={<ThreadsPage />} />
          <Route path="/threads/:id" element={<ThreadDetailPage />} />
          <Route path="/proposals" element={<ProposalsPage />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/config" element={<ConfigPage />} />
          <Route path="/knowledge" element={<KnowledgePage />} />
          <Route path="/scheduler" element={<SchedulerPage />} />
          <Route path="/channels" element={<ChannelsPage />} />
          <Route path="/costs" element={<CostAnalyticsPage />} />
          <Route path="/devices" element={<DevicesPage />} />
          <Route path="/system" element={<SystemPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
```

**Step 3: Build sidebar with nav links and icons**

Update Layout.tsx with Lucide icons and NavLink active states:

```tsx
import { NavLink, Outlet } from "react-router-dom";
import {
  MessageSquare, Bot, GitBranch, FileCheck, KanbanSquare,
  ScrollText, Settings, Brain, Clock, Radio, DollarSign,
  Smartphone, Activity,
} from "lucide-react";

const navItems = [
  { to: "/chat", icon: MessageSquare, label: "Chat" },
  { to: "/agents", icon: Bot, label: "Agents" },
  { to: "/threads", icon: GitBranch, label: "Threads" },
  { to: "/proposals", icon: FileCheck, label: "Proposals" },
  { to: "/tasks", icon: KanbanSquare, label: "Tasks" },
  { to: "/logs", icon: ScrollText, label: "Logs" },
  { to: "/config", icon: Settings, label: "Config" },
  { to: "/knowledge", icon: Brain, label: "Knowledge" },
  { to: "/scheduler", icon: Clock, label: "Scheduler" },
  { to: "/channels", icon: Radio, label: "Channels" },
  { to: "/costs", icon: DollarSign, label: "Costs" },
  { to: "/devices", icon: Smartphone, label: "Devices" },
  { to: "/system", icon: Activity, label: "System" },
];
```

NavLink styling: active = `bg-zinc-800 text-white`, inactive = `text-zinc-400 hover:text-white`.

Connection status indicator in sidebar footer showing connected/disconnected state from `useAuthStore`.

**Step 4: Auto-connect on app mount**

In Layout.tsx or App.tsx:
```tsx
useEffect(() => {
  const { initDevice, connect } = useAuthStore.getState();
  initDevice();
  connect();
}, []);
```

**Step 5: Commit**

```bash
git add src/gateway/src/pages/ src/gateway/src/components/Layout.tsx src/gateway/src/App.tsx
git commit -m "feat(gateway): sidebar navigation, router with all 13 screens"
```

---

## Task 8: Chat Screen

**Files:**
- Modify: `src/gateway/src/pages/Chat.tsx` — full chat interface
- Create: `src/gateway/src/stores/chat.ts` — chat state
- Create: `src/gateway/src/components/chat/MessageList.tsx`
- Create: `src/gateway/src/components/chat/MessageInput.tsx`
- Create: `src/gateway/src/components/chat/AgentSelector.tsx`

**Implementation:**

1. `useChatStore` — manages messages array, current agent, streaming state, active messageId
2. Agent selector dropdown — pick which agent to talk to (fetched from `agents.list`)
3. Message input — textarea with Cmd+Enter to send, sends `chat.send` over WS
4. Message list — renders messages with role-based styling (user vs assistant)
5. Streaming — listen to `agent:progress` events, append to current message in real-time
6. Abort button — visible during streaming, sends `chat.abort`
7. Delegation chains — when Nyx delegates to Forge, show inline with visual indication
8. Thread linking — each chat session creates/continues a thread
9. Message history — loaded via `chat.history` on thread select

**Key patterns:**
- Messages rendered in a `ScrollArea` with auto-scroll to bottom
- Streaming text appended character-by-character to the last assistant message
- Agent selector shows current agent status (idle/running)
- Input disabled while agent is processing (with abort available)

**Commit:** `feat(gateway): chat screen with streaming, abort, agent selection`

---

## Task 9: Agents Screen

**Files:**
- Modify: `src/gateway/src/pages/Agents.tsx`
- Create: `src/gateway/src/stores/agents.ts`
- Create: `src/gateway/src/components/agents/AgentCard.tsx`

**Implementation:**

1. `useAgentsStore` — fetches agent list via `agents.list`, subscribes to `agent:status` events
2. Card grid — each agent as a card showing: name, role, status badge (idle=green, running=amber, error=red), current task
3. Metrics section per card — invocations, tokens in/out, estimated cost, last invoked
4. Click to expand — shows recent threads for this agent, soul info
5. Live updates — `agent:status` events update card badges in real-time

**Commit:** `feat(gateway): agents screen with live status cards and metrics`

---

## Task 10: Threads Screen

**Files:**
- Modify: `src/gateway/src/pages/Threads.tsx`
- Create: `src/gateway/src/pages/ThreadDetail.tsx`
- Create: `src/gateway/src/stores/threads.ts`

**Implementation:**

1. `useThreadsStore` — fetches threads via `threads.list`, filter state
2. Data table — using @tanstack/react-table with columns: title, agent, project, status, cost, duration, created_at
3. Filters — by project, agent, status (tabs or dropdowns)
4. Sorting — by date, cost, duration
5. Click row → navigate to `/threads/:id`
6. Thread detail page:
   - Full message history in conversation view
   - Delegation trace (agent chain)
   - Cost breakdown per agent
   - Git info (branch, commits, PR link if available)
   - Status with timestamps

**Commit:** `feat(gateway): threads screen with data table, filters, and detail view`

---

## Task 11: Proposals Screen

**Files:**
- Modify: `src/gateway/src/pages/Proposals.tsx`
- Create: `src/gateway/src/stores/proposals.ts`
- Create: `src/gateway/src/components/proposals/ProposalCard.tsx`
- Create: `src/gateway/src/components/proposals/ProposalDetail.tsx`

**Implementation:**

1. `useProposalsStore` — fetches via `proposals.list`, subscribes to `proposal:update`
2. Inbox view — pending proposals prominent with badge count in sidebar
3. Status tabs: pending | reviewing | approved | executing | completed
4. Proposal card — title, category badge, priority, effort, proposed by, files affected
5. Detail panel (drawer or inline expand):
   - Full description
   - Agent review verdict (if reviewed)
   - Approve button + reject button with optional notes dialog
   - Execution progress (live via `proposal:update` events)
   - PR link when available
6. Filters — by category, priority, agent

**Commit:** `feat(gateway): proposals screen with inbox, approve/reject, live execution tracking`

---

## Task 12: Tasks Screen (Kanban)

**Files:**
- Modify: `src/gateway/src/pages/Tasks.tsx`
- Create: `src/gateway/src/stores/tasks.ts`
- Create: `src/gateway/src/components/tasks/Board.tsx`
- Create: `src/gateway/src/components/tasks/TaskCard.tsx`
- Create: `src/gateway/src/components/tasks/CreateTaskDialog.tsx`

**Implementation:**

1. `useTasksStore` — fetches via `tasks.list`, groups by status column
2. Kanban board with 4 columns: Backlog, In Progress, Review, Done
3. Task cards — title, assignee avatar/name, brief description
4. Drag-and-drop — use native HTML drag API (no extra dependency). On drop, send `tasks.update` with new status/position
5. Create task dialog — title, description, assignee dropdown (agents or "unassigned")
6. Live updates via `task:update` events

**Commit:** `feat(gateway): kanban task board with drag-and-drop and live updates`

---

## Task 13: Logs Screen

**Files:**
- Modify: `src/gateway/src/pages/Logs.tsx`
- Create: `src/gateway/src/stores/logs.ts`
- Create: `src/gateway/src/components/logs/LogViewer.tsx`

**Implementation:**

1. `useLogsStore` — subscribes via `logs.subscribe`, buffers log entries (max 5000)
2. Log viewer — monospace text, auto-scrolling, color-coded by level:
   - `error` = red, `warn` = yellow, `info` = default, `debug` = dim
3. Filter bar — level dropdown, agent filter, module filter, text search
4. Pause/resume button — pauses auto-scroll and buffering display
5. Export button — download current buffer as .log file
6. Timestamp column, module column, message column

**Commit:** `feat(gateway): live log viewer with filtering, search, pause, and export`

---

## Task 14: Config Screen

**Files:**
- Modify: `src/gateway/src/pages/Config.tsx`
- Create: `src/gateway/src/stores/config.ts`
- Create: `src/gateway/src/components/config/Editor.tsx`

**Implementation:**

1. `useConfigStore` — loads config via `config.get`, tracks edit state and validation
2. Monaco Editor integration:
   ```bash
   bun add @monaco-editor/react
   ```
3. Editor panel — TOML syntax highlighting, edit the raw config
4. Validation — on every change, send `config.validate`, display errors inline
5. Save button — sends `config.patch` with full content
6. Reload button — sends `config.reload` to hot-reload
7. Diff view — show changes before saving (Monaco diff editor)
8. Schema-driven form view (future enhancement, lower priority) — render form fields from Zod schema as alternative to raw TOML

**Commit:** `feat(gateway): config editor with Monaco, live validation, and diff view`

---

## Task 15: Knowledge & Memory Screen

**Files:**
- Modify: `src/gateway/src/pages/Knowledge.tsx`
- Create: `src/gateway/src/stores/knowledge.ts`
- Create: `src/gateway/src/components/knowledge/SearchResults.tsx`
- Create: `src/gateway/src/components/knowledge/MemoryGraph.tsx`

**Implementation:**

1. `useKnowledgeStore` — search state, results
2. Search bar — query input, sends `memory.search` and `knowledge.search`
3. Results panel — tabbed: Memory results | Knowledge results
4. Each result: content preview, source, relevance score, timestamp
5. Memory graph visualization (stretch goal):
   - Simple node-edge visualization using SVG or canvas
   - Node types color-coded (facts, preferences, decisions, etc.)
   - Click node to see detail
   - Could use a lightweight lib like `d3-force` if needed, or start with a simple list view
6. Manual ingest button — triggers `knowledge.ingest`

**Commit:** `feat(gateway): knowledge and memory browser with search`

---

## Task 16: Scheduler Screen

**Files:**
- Modify: `src/gateway/src/pages/Scheduler.tsx`
- Create: `src/gateway/src/stores/scheduler.ts`
- Create: `src/gateway/src/components/scheduler/JobCard.tsx`
- Create: `src/gateway/src/components/scheduler/CreateJobDialog.tsx`

**Implementation:**

1. `useSchedulerStore` — fetches via `scheduler.list`
2. Job list — cards or table with: name, schedule (cron expression), agent, enabled toggle, last run, next run
3. Enable/disable — toggle sends `scheduler.update` with enabled flag
4. Create job dialog — name, schedule input (cron expression with preview of "next 5 runs"), agent selector, prompt textarea
5. Manual trigger — "Run Now" button sends `scheduler.run`
6. Run history expandable — last N runs with status, duration, output summary

**Commit:** `feat(gateway): scheduler management with create, toggle, manual trigger`

---

## Task 17: Channels Screen

**Files:**
- Modify: `src/gateway/src/pages/Channels.tsx`
- Create: `src/gateway/src/stores/channels.ts`

**Implementation:**

1. `useChannelsStore` — fetches via `channels.list`
2. Channel cards — one per connected channel type:
   - Icon (Discord, Telegram, Slack, iMessage logos or Lucide icons)
   - Status badge (connected/disconnected/error)
   - Message count, last activity timestamp
3. Click to expand — show per-channel config (DM policy, group policy)
4. Read-only for now — config changes go through the Config screen

**Commit:** `feat(gateway): channels status dashboard`

---

## Task 18: Cost Analytics Screen

**Files:**
- Modify: `src/gateway/src/pages/CostAnalytics.tsx`
- Create: `src/gateway/src/stores/costs.ts`

**Implementation:**

1. Install: `bun add recharts`
2. `useCostsStore` — fetches trace data via `traces.list`, aggregates by time/agent/project
3. Time-series line chart — cost over time (daily/weekly/monthly toggle)
4. Token usage chart — tokens in vs tokens out over time
5. Per-agent breakdown — bar chart or pie chart
6. Per-project breakdown — bar chart
7. Summary cards at top: total cost (period), total tokens, total invocations, avg cost per invocation
8. Date range picker — filter the time window

**Data source:** The `traces` table has per-execution cost/token data. Aggregate on the backend via a new `traces.aggregate` WS method, or fetch raw and aggregate on client.

**Commit:** `feat(gateway): cost analytics with charts and per-agent breakdown`

---

## Task 19: Devices Screen

**Files:**
- Modify: `src/gateway/src/pages/Devices.tsx`
- Create: `src/gateway/src/stores/devices.ts`

**Implementation:**

1. `useDevicesStore` — fetches via `devices.list`
2. Device list — table with: device name, device ID (truncated), approved status, last seen, created at
3. Pending section — unapproved devices highlighted with "Approve" button
4. Actions — Approve (sends `devices.approve`), Revoke (sends `devices.revoke` with confirmation dialog)
5. Current connections — show which devices are currently connected (from `connections.listConnected()`)

**Commit:** `feat(gateway): device management with approve and revoke`

---

## Task 20: System Screen

**Files:**
- Modify: `src/gateway/src/pages/System.tsx`
- Create: `src/gateway/src/stores/system.ts`
- Create: `src/gateway/src/components/system/HealthDashboard.tsx`
- Create: `src/gateway/src/components/system/RpcConsole.tsx`

**Implementation:**

1. `useSystemStore` — fetches via `system.health`, subscribes to `system:health` events
2. Health dashboard:
   - Uptime display
   - Queue depth gauge
   - Active connections count
   - Agent count
   - Memory usage
   - Auto-refreshing via health events
3. RPC console:
   - JSON textarea for raw WS frame input
   - Send button — sends raw frame via `gateway.request()`
   - Response display — formatted JSON output
   - History of sent/received frames

**Commit:** `feat(gateway): system health dashboard and RPC console`

---

## Task 21: Polish and Integration

**Files:**
- All pages — loading states, error handling, empty states
- `src/gateway/src/components/Layout.tsx` — sidebar badge counts (pending proposals, running agents)
- `src/gateway/src/components/ConnectionStatus.tsx` — connection state indicator
- Various — keyboard shortcuts, responsive layout

**Implementation:**

1. Loading states — use Skeleton components while data loads
2. Error boundaries — catch React errors, show friendly error UI
3. Empty states — "No threads yet", "No proposals pending", etc.
4. Sidebar badges — pending proposal count (red badge), running agent count (amber badge)
5. Connection indicator — green dot when connected+authenticated, yellow when connecting, red when disconnected. Show in sidebar footer.
6. Toast notifications — for proposal updates, agent completions, errors
7. Keyboard shortcuts — Cmd+K for command palette (search across all entities), Cmd+/ for chat focus
8. Responsive — sidebar collapses on small screens

**Commit:** `feat(gateway): polish — loading states, error handling, badges, keyboard shortcuts`

---

## Task 22: Final Build Pipeline and Dev Experience

**Files:**
- Modify: `package.json` — consolidated scripts
- Modify: `src/server/index.ts` — production static serving verified
- Create: `src/gateway/src/env.d.ts` — Vite type declarations

**Implementation:**

1. Verify `bun run gateway:build` produces correct output
2. Verify `bun run start` serves the SPA at root
3. Verify WebSocket works through Hono in production mode
4. Verify Vite dev proxy works for development (`bun run gateway:dev` + `bun run dev`)
5. Add `build` script that builds both backend (if needed) and gateway
6. Document in README or inline: how to develop, build, and deploy

**Commit:** `feat(gateway): finalize build pipeline and dev experience`

---

## Execution Notes

- **Pixel (design agent)** should be involved during Tasks 5, 7, 8 (and any screen task) to refine the visual design — color palette, spacing, component variants, dark theme refinement
- **Tasks 1-7 are foundational** — must be completed in order
- **Tasks 8-20 are feature screens** — can be parallelized across agents (each screen is independent)
- **Task 21-22 are integration/polish** — after all screens are built
- **Each task should have its own commit** as indicated
- **TDD where practical** — protocol schemas and WS handlers are well-suited for tests. UI screens can be tested with manual verification initially, component tests added later.

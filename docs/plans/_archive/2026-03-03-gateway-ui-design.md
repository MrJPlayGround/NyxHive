# NyxHive Gateway UI — Design Document

**Date:** 2026-03-03
**Status:** Approved
**Author:** User + Claude

## Overview

The NyxHive Gateway is a web-based operations center for NyxHive — a React SPA served directly by the Hono server on port 3777. It provides full control over agents, threads, proposals, tasks, scheduling, configuration, and real-time monitoring through a typed WebSocket protocol.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | SPA served by Hono (same port) | Single process, no CORS, simplest deployment |
| Framework | React 19 + Vite | Best ecosystem for complex dashboards, strongest AI-assisted code generation |
| Realtime | WebSocket only (replace SSE) | Bidirectional, future-proof for exec approvals, pairing, RPC |
| Scope | Full feature set | Complete operations center, no phasing |
| Design | Dark, minimal, polished | Linear/Vercel energy — clean typography, good spacing, sharp data |
| Code location | `src/gateway/` | Inside NyxHive repo, built by Vite, served as static assets |
| Auth | Device pairing (cryptographic) | Challenge-response handshake, device approval, scoped access |
| WS Protocol | Typed RPC frames | Zod schemas shared between server and client |

## Architecture

```
Browser (React SPA)
    |
    WebSocket (ws://host:3777/ws)
    |
NyxHive Server (Hono)
    ├── /ws              → WebSocket handler (typed RPC)
    ├── /gateway/*       → Static SPA files (Vite build output)
    ├── src/gateway/     → React source code
    └── src/server/ws/   → WebSocket protocol, handlers, auth
         |
    Existing Backend
    ├── Queue/Processor  → Agent invocation
    ├── SQLite           → Threads, proposals, tasks, traces, auth
    ├── Memory/Knowledge → Graph memory, Obsidian vault
    └── Agents           → Nyx, Forge, Tester, Analyst, Pixel
```

- Hono serves the built SPA at root `/` (or `/gateway/`)
- WebSocket endpoint at `/ws` handles all real-time communication
- Existing REST endpoints remain during iOS migration, but all new features go through WS
- Vite builds `src/gateway/` → `dist/gateway/` which Hono serves as static assets

## WebSocket Protocol

### Frame Format

```typescript
type Frame = {
  type: "req" | "res" | "event"
  id: string           // correlation ID (uuid for req, echoed in res)
  method: string       // e.g., "chat.send", "agents.list"
  payload: unknown     // Zod-validated per method
  error?: {            // only in "res" frames on failure
    code: string
    message: string
  }
}
```

### Device Pairing Handshake

1. Client connects to `ws://host:3777/ws`
2. Server sends `event: connect.challenge` with nonce
3. Client responds with `req: connect.authenticate` — device ID, device name, HMAC signature of nonce using device secret, protocol version
4. New devices: server holds connection, user approves via CLI (`nyxhive devices approve`) or existing Gateway session
5. Server sends `res: connect.authenticated` — session token, scopes, server capabilities
6. Connection live — client sends requests, server pushes events

### Method Namespaces

| Namespace | Methods |
|-----------|---------|
| `chat` | `send`, `abort`, `history`, `stream` (event) |
| `agents` | `list`, `status`, `metrics` |
| `threads` | `list`, `get`, `create`, `subscribe` |
| `proposals` | `list`, `get`, `approve`, `reject`, `start-review` |
| `tasks` | `list`, `create`, `update`, `board` |
| `logs` | `subscribe`, `unsubscribe` |
| `config` | `get`, `patch`, `validate`, `reload` |
| `memory` | `search`, `graph` |
| `knowledge` | `search`, `ingest` |
| `scheduler` | `list`, `create`, `update`, `delete`, `run` |
| `channels` | `status`, `list` |
| `devices` | `list`, `approve`, `revoke` |
| `traces` | `list`, `get` |
| `system` | `health`, `rpc` |

### Server-Push Events

- `agent:progress` — streaming text chunks during agent execution
- `agent:status` — agent started/completed/failed
- `thread:update` — thread status changed
- `proposal:update` — proposal lifecycle events
- `task:update` — task board changes
- `log:entry` — live log stream
- `system:health` — periodic health snapshots

All schemas in Zod, shared via `src/gateway/protocol/`.

## UI Screens

### 1. Chat
- Primary interaction — send messages, stream responses in real-time
- Agent selector (Nyx, Forge, etc.)
- Streaming with abort button
- Message history with search
- Delegation chains visible inline
- File/media attachments
- Thread linking

### 2. Agents
- Card view: name, role, status (idle/running/error), current task
- Live metrics: tokens, cost, invocations, avg response time
- Agent detail: recent threads, soul info, capabilities

### 3. Threads
- Table view with filtering (project, agent, status)
- Thread detail: full message history, delegation trace, cost breakdown
- Git info: branch, commits, PR links
- Status lifecycle: created → running → completed/failed

### 4. Proposals
- Inbox-style: pending proposals need attention
- Detail: title, description, category, effort, files affected, review verdict
- Approve/reject with optional notes
- Live execution progress
- PR links on completion

### 5. Tasks
- Kanban board: backlog | in progress | review | done
- Drag-and-drop between columns
- Assignee (agent/human), linked threads

### 6. Logs
- Live log tail with auto-scroll
- Filter by level, agent, module
- Search, pause/resume, export

### 7. Config
- TOML editor with syntax highlighting (Monaco) and live Zod validation
- Schema-driven form view as alternative
- Diff view before applying
- Hot reload button

### 8. Knowledge & Memory
- Search across graph memory and Obsidian vault
- Memory graph visualization (nodes and relationships)
- Browse knowledge entries
- Manual ingest trigger

### 9. Scheduler
- Cron jobs and one-shot tasks
- Create/edit/delete with schedule preview ("next 5 runs")
- Enable/disable toggle, run history, manual trigger

### 10. Channels
- Status cards per channel (Discord, Telegram, Slack, iMessage)
- Connection health, message counts, last activity
- Per-channel config

### 11. Cost Analytics
- Time-series charts: cost and tokens over time
- Per-agent and per-project breakdown
- Daily/weekly/monthly views
- Provider cost comparison

### 12. Devices
- Paired devices with last-seen timestamps
- Approve pending requests, revoke access
- Active sessions view

### 13. System
- Health dashboard: uptime, queue depth, active connections
- RPC console: raw WS frame debugging
- Update check

## Tech Stack

### Frontend (`src/gateway/`)

| Dep | Purpose |
|-----|---------|
| React 19 | UI framework |
| Vite | Build tool, dev server |
| React Router | Client-side routing |
| Zustand | State management (WS-driven stores) |
| shadcn/ui | Component library (copied into codebase, not dependency) |
| Tailwind CSS | Styling, dark theme |
| Recharts | Cost analytics charts |
| @tanstack/react-table | Data tables (threads, proposals, logs) |
| Monaco Editor | TOML config editor |
| Zod | Shared WS schemas (already used by backend) |

### Shared (`src/gateway/protocol/`)

- Zod schemas for every WS method request/response
- TypeScript types generated from schemas
- Imported by both server handlers and React client

### Backend Additions (`src/server/ws/`)

- Hono WebSocket upgrade handler
- Device pairing + challenge-response auth
- Connection manager (track clients, broadcast events)
- Method router (dispatch frames to handlers)
- Per-namespace handlers

### Zustand Stores

- `useAuthStore` — device identity, session token, connection state
- `useChatStore` — messages, streaming state, active agent
- `useAgentsStore` — agent list, status, metrics
- `useThreadsStore` — thread list, detail, filters
- `useProposalsStore` — proposal list, pending count
- `useTasksStore` — kanban board state
- `useLogsStore` — log buffer, filters, subscription state
- `useConfigStore` — current config, validation state
- `useSchedulerStore` — jobs, run history
- `useSystemStore` — health, connected devices

### Build Pipeline

- **Dev:** Vite dev server with proxy to Hono for `/ws`
- **Production:** `vite build` → `dist/gateway/`, Hono serves static; single `bun run start`
- **Tests:** Vitest for frontend, bun:test for backend WS handlers

## Design Direction

- Dark theme default, minimal, polished
- Linear/Vercel aesthetic — clean typography, generous spacing, sharp data presentation
- Not terminal-inspired — professional tool, not hacker aesthetic
- shadcn/ui provides the base component system
- Pixel (design agent) to refine specifics: color palette, spacing system, component variants

## SSE Migration Plan

The Gateway replaces SSE with WebSocket. Migration path:

1. Build WS infrastructure alongside existing SSE
2. Gateway UI uses WS exclusively from day one
3. Add WS support to iOS app (nyx-ios)
4. Remove SSE endpoints once iOS is migrated
5. Clean up SSE-related code in `src/server/`

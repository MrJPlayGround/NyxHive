# Gateway "Make It Real" Sprint

**Date**: 2026-03-09
**Scope**: NyxHive Gateway (`src/gateway/`)
**Goal**: Take the gateway from functional to polished — fill UX gaps, add real-time updates everywhere, and make daily use feel effortless.

## Current State

18 pages, all functional. React 19, Vite 7, TailwindCSS 4, Zustand, WebSocket protocol. Builds clean. No critical bugs. 3129 engine tests passing.

### Existing Infrastructure (already built)

- **ChatSidebar** (`components/chat/ChatSidebar.tsx`): 455-line sidebar with thread grouping by category + time, rename/delete/archive via dropdown, category management, streaming indicators, new chat button. Integrated in Chat.tsx with local `useState` for collapse state (not persisted).
- **Toast system** (`components/ui/toast.tsx` + `hooks/useErrorToasts.ts`): Context-based toast with auto-dismiss (8s default), action buttons, slide-in animation. Currently only wired for WS request errors — no success/info toasts on user actions.
- **Thread store CRUD** (`stores/threads.ts`): `renameThread`, `deleteThread`, `archiveThread`, `setCategory`, `getCategories` — all wired to WS methods (`threads.rename`, `threads.delete`, `threads.archive`).
- **Dialog component** (`components/ui/dialog.tsx`): Radix UI wrapper with overlay, animations, close button.

### Audit Summary

| Rating | Pages |
|--------|-------|
| 9/10 | Home, Chat, Devices |
| 8/10 | Work, Agents, ThreadDetail, Logs, Scheduler, System |
| 7/10 | Threads, Knowledge, Traces, Models, Activity, Channels |
| 6/10 | Config |

### Actual Gaps

1. No pagination on any list page — hard limits (50/200) silently hide data
2. 6 pages fetch once on mount, no real-time updates (Threads, Traces, Knowledge, Models, Activity, Channels)
3. User actions (approve, reject, trigger, toggle) give no success/info feedback — only errors toast
4. ThreadDetail page is read-only — no rename, archive, delete, or reply (despite store methods existing)
5. Chat sidebar collapse state resets on reload (not persisted)

## Design

### 1. Success/Info Toasts on User Actions

**What**: Extend the existing toast system to fire on successful actions, not just errors.

**Changes to existing `useToast` hook**: Add `type` field to toast options — `"success" | "error" | "info"`. Success toasts auto-dismiss after 4s (shorter than current 8s default). Error toasts keep current 8s behavior.

**Integration points** — add `addToast({ title, type: "success" })` calls to:
- `stores/proposals.ts`: approve, reject, delete, startReview, clearTerminal
- `stores/threads.ts`: renameThread, deleteThread, archiveThread
- `stores/scheduler.ts`: toggleJob, triggerJob

Each store action wraps the existing WS call and toasts on success. On error, the existing `useErrorToasts` hook already handles it.

**Visual**: Success toasts get a green-left-border accent. Info gets blue. Error keeps current red styling.

**Files modified**:
- `components/ui/toast.tsx` — add `type` field, variant styling, 4s default for success
- `stores/proposals.ts` — toast on approve/reject/delete/review/clear
- `stores/threads.ts` — toast on rename/delete/archive
- `stores/scheduler.ts` — toast on toggle/trigger

### 2. Offset-Based Pagination

**What**: Shared pagination component + hook for all list pages.

**New components**:
- `components/ui/pagination.tsx` — Prev/Next buttons, "Showing X-Y of Z" text, page size selector (25/50/100). Uses existing `Button` component. Disabled state when at boundaries.
- `hooks/usePagination.ts` — Hook managing `offset`, `limit`, `total` state. Exposes `page`, `totalPages`, `nextPage()`, `prevPage()`, `setPageSize()`, `reset()`. Accepts a fetcher function `(offset, limit) => Promise<{ items, total }>`.

**Pages to wire up**:

| Page | Current | After |
|------|---------|-------|
| Threads | limit:50, no controls | Paginated, default 50 |
| Traces | limit:50, no controls | Paginated, default 50 |
| Activity | limit:200, no controls | Paginated, default 50 |
| Knowledge results | limit:10, no controls | Paginated, default 25 |
| Work/Done column | Loads all, shows all | Client-side cap at 20, "Show more" button |

**Server support**: All list endpoints already accept `limit` and `offset`. Several return a `total` count. For endpoints that don't return `total`, show "Showing X-Y" without "of Z" and disable Next when results < limit.

**Files created**:
- `components/ui/pagination.tsx`
- `hooks/usePagination.ts`

**Files modified**:
- `pages/Threads.tsx` — integrate pagination
- `pages/Traces.tsx` — integrate pagination
- `pages/ActivityFeed.tsx` — integrate pagination
- `pages/Knowledge.tsx` — integrate pagination for search results
- `pages/Work.tsx` — cap Done column, add "Show more"

### 3. Real-Time Updates on Stale Pages

**What**: Wire existing WS events into pages that currently only fetch once on mount.

| Page | Event | Effect |
|------|-------|--------|
| Threads | `thread:update` | Update status/title in list, optionally bump to top |
| Traces | `thread:update` | Show refresh indicator ("New traces available"), click to reload |
| Activity | `proposal:update`, `agent:status` | Prepend new audit entry to list |

For pages without matching server events (Knowledge, Models, Channels):
- **New hook**: `hooks/useVisibilityRefresh.ts` — fires callback when document becomes visible after being hidden for >30s. Lightweight alternative to polling.
- Knowledge: refetch stats on visibility restore
- Models: refetch routing data on visibility restore
- Channels: refetch channel list on visibility restore

**Implementation**: Use existing `useWsEvent` hook for event-driven pages. New `useVisibilityRefresh` for poll-on-focus.

**Files created**:
- `hooks/useVisibilityRefresh.ts`

**Files modified**:
- `pages/Threads.tsx` — add `useWsEvent("thread:update", ...)`
- `pages/Traces.tsx` — add refresh indicator on thread:update
- `pages/ActivityFeed.tsx` — add real-time prepend
- `pages/Knowledge.tsx` — add useVisibilityRefresh
- `pages/Models.tsx` — add useVisibilityRefresh
- `pages/Channels.tsx` — add useVisibilityRefresh

### 4. ThreadDetail Actions + Reply

**What**: Surface existing thread management on the ThreadDetail page, plus add reply capability.

**Thread actions in header**:
- **Rename**: Inline editable title. Click pencil icon -> input field, Enter to save, Escape to cancel. Calls existing `renameThread` from threads store.
- **Archive**: Icon button in header. Opens confirmation dialog (built with existing `Dialog` component). Calls existing `archiveThread`.
- **Delete**: Icon button in header. Opens confirmation dialog showing thread title. Calls existing `deleteThread`. Navigates back to Threads list after success.

**New: ConfirmDialog component**: Reusable wrapper around existing `Dialog`. Props: `title`, `description`, `confirmLabel`, `variant` ("danger" | "default"), `onConfirm`, `open`, `onOpenChange`. Confirm button uses red styling for danger variant.

**New: Reply input at bottom of ThreadDetail**:
- Text input + send button at page bottom, similar to Chat input but simpler (no file attachments, no agent selector).
- Sends via `chat.send` WS method with the thread's `id` as `threadId` parameter.
- Shows new messages appended to the message list.
- Streams response via existing `response:delta` / `chat:response` events filtered by threadId.
- Does NOT need full chat streaming state machine — simplified: send, show streaming indicator, append final response.

**Files created**:
- `components/ConfirmDialog.tsx`

**Files modified**:
- `pages/ThreadDetail.tsx` — add rename/archive/delete buttons, reply input, streaming response display

### 5. Persist Chat Sidebar State

**What**: Remember sidebar collapsed state across page reloads.

**Change**: Move `sidebarCollapsed` from Chat.tsx local `useState` to the chat Zustand store. Add it to the `partialize` function so it's included in `persist` middleware.

**Files modified**:
- `stores/chat.ts` — add `sidebarCollapsed` + `toggleSidebar()` to store, add to partialize
- `pages/Chat.tsx` — replace local useState with store selector

## What's NOT in Scope

- Chat streaming internals (complex but correct)
- Work/Kanban page (already 8/10)
- Scheduler CRUD (already has real-time + toggle/trigger)
- Auth/pairing flow (works)
- Config TOML parser (low priority)
- New npm dependencies (zero)
- Server-side / backend changes (all features use existing API)
- ChatSidebar rewrite (already solid at 455 lines)

## File Impact Summary

**New files** (4):
- `src/gateway/src/components/ui/pagination.tsx`
- `src/gateway/src/components/ConfirmDialog.tsx`
- `src/gateway/src/hooks/usePagination.ts`
- `src/gateway/src/hooks/useVisibilityRefresh.ts`

**Modified files** (14):
- `src/gateway/src/components/ui/toast.tsx` — type variants, shorter success dismiss
- `src/gateway/src/stores/proposals.ts` — success toasts on actions
- `src/gateway/src/stores/threads.ts` — success toasts on actions
- `src/gateway/src/stores/scheduler.ts` — success toasts on actions
- `src/gateway/src/stores/chat.ts` — persist sidebarCollapsed
- `src/gateway/src/pages/Chat.tsx` — use store for sidebar state
- `src/gateway/src/pages/Threads.tsx` — pagination + real-time
- `src/gateway/src/pages/ThreadDetail.tsx` — actions + reply
- `src/gateway/src/pages/Traces.tsx` — pagination + refresh indicator
- `src/gateway/src/pages/ActivityFeed.tsx` — pagination + real-time
- `src/gateway/src/pages/Knowledge.tsx` — pagination + visibility refresh
- `src/gateway/src/pages/Models.tsx` — visibility refresh
- `src/gateway/src/pages/Channels.tsx` — visibility refresh
- `src/gateway/src/pages/Work.tsx` — Done column cap

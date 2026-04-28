# Gateway Refinement — Full Polish

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the gateway from a 14-page developer dashboard into a focused 6-page product with clear information hierarchy.

**Architecture:** React SPA with Zustand stores, WebSocket RPC, Tailwind CSS. All changes are frontend-only — no backend modifications needed. Progressive migration: new pages created alongside old ones, then routes swapped atomically.

**Tech Stack:** React 19, react-router-dom 7, Zustand 5, Tailwind CSS 4, lucide-react, existing shadcn/ui components.

---

## Navigation Map (Before → After)

| Before (14 items) | After (6 items) | Notes |
|---|---|---|
| / → redirect to /chat | / → Home dashboard | New page |
| /chat | /chat | Unchanged |
| /proposals + /tasks | /work | Merged — proposals ARE the work items |
| /agents + /costs | /agents | Costs folded into agent cards (already there) |
| /threads, /threads/:id | /threads, /threads/:id | Unchanged |
| /logs, /config, /knowledge, /scheduler, /channels, /devices, /system | /settings/* | All absorbed into Settings with tab navigation |

---

## Phase 1: Home Dashboard (new page, non-breaking)

### Task 1.1: Create Home page component

**Files:**
- Create: `src/gateway/src/pages/Home.tsx`

**Step 1: Create the Home dashboard page**

The dashboard shows four sections stacked vertically:

1. **Status bar** — Uptime, queue depth, connections, memory (reuse system.health data)
2. **Pending work** — Proposals needing attention (status: proposed/reviewed), with inline approve/reject
3. **Active agents** — Cards for agents currently running, with current task shown
4. **Recent activity** — Last 10 completed proposals/threads, compact list

```tsx
import { useEffect, useCallback, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity, Bot, CheckCircle, Clock, ExternalLink,
  FileCheck, Layers, MemoryStick, Wifi,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { useWsRequest, useWsEvent } from "../hooks/useWs";
import { useProposalsStore } from "../stores/proposals";
import { useAgentsStore } from "../stores/agents";
import { cn } from "../lib/utils";
import type { Frame } from "../../protocol/frame";

interface Health {
  uptime: number;
  queueDepth: number;
  activeConnections: number;
  agents: number;
  memoryUsage: number;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function formatCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatRelativeTime(ts: number | null): string {
  if (!ts) return "Never";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const categoryColors: Record<string, string> = {
  feature: "text-blue-400",
  bugfix: "text-red-400",
  improvement: "text-emerald-400",
  maintenance: "text-zinc-400",
  new_instance: "text-purple-400",
};

export function HomePage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useWsRequest();

  const proposals = useProposalsStore((s) => s.proposals);
  const fetchProposals = useProposalsStore((s) => s.fetchProposals);
  const approve = useProposalsStore((s) => s.approve);
  const reject = useProposalsStore((s) => s.reject);

  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  const loadHealth = useCallback(async () => {
    try {
      const result = await request<Health>("system.health");
      setHealth(result);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    loadHealth();
    fetchProposals();
    fetchAgents();
  }, [loadHealth, fetchProposals, fetchAgents]);

  const handleHealthEvent = useCallback((frame: Frame) => {
    setHealth(frame.payload as Health);
  }, []);
  useWsEvent("system:health", handleHealthEvent);

  const pendingProposals = proposals.filter(
    (p) => p.status === "proposed" || p.status === "reviewed",
  );
  const activeAgents = agents.filter((a) => a.status === "running");
  const recentCompleted = proposals
    .filter((p) => p.status === "completed" || p.status === "merged")
    .slice(0, 8);

  const statCards = health
    ? [
        { label: "Uptime", value: formatUptime(health.uptime), icon: Clock },
        { label: "Queue", value: String(health.queueDepth), icon: Layers },
        { label: "Connections", value: String(health.activeConnections), icon: Wifi },
        { label: "Memory", value: formatBytes(health.memoryUsage), icon: MemoryStick },
      ]
    : [];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Home</h1>
        <p className="mt-1 text-sm text-zinc-400">System overview</p>
      </div>

      {/* Status bar */}
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-4">
          {statCards.map(({ label, value, icon: Icon }) => (
            <Card key={label}>
              <CardContent className="flex items-center gap-3 p-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
                  <Icon className="h-4 w-4 text-zinc-400" />
                </div>
                <div>
                  <p className="text-xs text-zinc-500">{label}</p>
                  <p className="text-lg font-semibold">{value}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Pending work */}
      {pendingProposals.length > 0 && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <FileCheck className="h-5 w-5 text-red-400" />
              Needs Attention
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500/20 px-1.5 text-xs font-medium text-red-400">
                {pendingProposals.length}
              </span>
            </h2>
            <Link to="/work" className="text-sm text-zinc-400 hover:text-white">
              View all
            </Link>
          </div>
          <div className="space-y-2">
            {pendingProposals.slice(0, 5).map((p) => (
              <Card key={p.id} className="transition-colors hover:border-zinc-700">
                <CardContent className="flex items-center justify-between p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{p.title}</p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className={cn("text-xs", categoryColors[p.category])}>
                        {p.category}
                      </span>
                      <span className="text-xs text-zinc-500">{p.effort}</span>
                      <span className="text-xs text-zinc-600">
                        {formatRelativeTime(p.createdAt)}
                      </span>
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-emerald-400 hover:bg-emerald-500/10"
                      onClick={() => approve(p.id)}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-400 hover:bg-red-500/10"
                      onClick={() => reject(p.id)}
                    >
                      Reject
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Active agents */}
      {activeAgents.length > 0 && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Bot className="h-5 w-5 text-amber-400" />
              Active Agents
            </h2>
            <Link to="/agents" className="text-sm text-zinc-400 hover:text-white">
              View all
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {activeAgents.map((a) => (
              <Card key={a.id}>
                <CardContent className="p-4">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full bg-amber-500" />
                    <p className="font-medium">{a.name}</p>
                    <Badge variant="secondary" className="ml-auto text-xs">
                      {formatCost(a.estimatedCostCents)}
                    </Badge>
                  </div>
                  {a.currentTask && (
                    <p className="mt-2 truncate text-sm text-zinc-400">{a.currentTask}</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Recent completions */}
      {recentCompleted.length > 0 && (
        <div>
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
            <CheckCircle className="h-5 w-5 text-emerald-400" />
            Recently Completed
          </h2>
          <div className="space-y-1">
            {recentCompleted.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-zinc-900/50"
              >
                <span className={cn("text-xs", categoryColors[p.category])}>
                  {p.category}
                </span>
                <span className="min-w-0 flex-1 truncate text-zinc-300">{p.title}</span>
                {p.prUrl && (
                  <a
                    href={p.prUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-blue-400 hover:text-blue-300"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                <span className="text-xs text-zinc-600">
                  {formatRelativeTime(p.updatedAt)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state — nothing pending, nothing active */}
      {pendingProposals.length === 0 && activeAgents.length === 0 && !loading && (
        <Card>
          <CardContent className="py-12 text-center">
            <Activity className="mx-auto h-8 w-8 text-zinc-600" />
            <p className="mt-3 text-sm text-zinc-400">All quiet. No pending work or active agents.</p>
            <Link to="/chat" className="mt-2 inline-block text-sm text-zinc-300 hover:text-white">
              Start a conversation →
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
```

**Step 2: Verify it builds**

Run: `cd /home/user/dev/nyxhive/src/gateway && npx vite build 2>&1 | tail -5`
Expected: Build succeeds (page not yet routed, just compiling)

**Step 3: Commit**

```bash
git add src/gateway/src/pages/Home.tsx
git commit -m "feat(gateway): add Home dashboard page"
```

---

## Phase 2: Settings Shell (new page, non-breaking)

### Task 2.1: Create Settings page with tab navigation

**Files:**
- Create: `src/gateway/src/pages/Settings.tsx`

The Settings page is a container with a horizontal tab bar at the top. Each tab renders the existing page component inline — no new logic needed, just re-composition.

**Step 1: Create the Settings page**

```tsx
import { useState } from "react";
import {
  ScrollText, Settings as SettingsIcon, Brain, Clock,
  Radio, Smartphone, Activity, Terminal,
} from "lucide-react";
import { cn } from "../lib/utils";

// Import existing page components — they become tabs
import { LogsPage } from "./Logs";
import { ConfigPage } from "./Config";
import { KnowledgePage } from "./Knowledge";
import { SchedulerPage } from "./Scheduler";
import { ChannelsPage } from "./Channels";
import { DevicesPage } from "./Devices";
import { SystemPage } from "./System";
import type { LucideIcon } from "lucide-react";

interface SettingsTab {
  id: string;
  label: string;
  icon: LucideIcon;
  component: React.ComponentType;
}

const tabs: SettingsTab[] = [
  { id: "system", label: "System", icon: Activity, component: SystemPage },
  { id: "logs", label: "Logs", icon: ScrollText, component: LogsPage },
  { id: "config", label: "Config", icon: SettingsIcon, component: ConfigPage },
  { id: "scheduler", label: "Automations", icon: Clock, component: SchedulerPage },
  { id: "channels", label: "Channels", icon: Radio, component: ChannelsPage },
  { id: "devices", label: "Devices", icon: Smartphone, component: DevicesPage },
  { id: "knowledge", label: "Knowledge", icon: Brain, component: KnowledgePage },
];

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState("system");
  const active = tabs.find((t) => t.id === activeTab) ?? tabs[0];
  const ActiveComponent = active.component;

  return (
    <div>
      <h1 className="text-2xl font-semibold">Settings</h1>
      <p className="mt-1 text-sm text-zinc-400">System configuration and monitoring</p>

      <div className="mt-4 flex gap-1 overflow-x-auto border-b border-zinc-800 pb-px">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-t-md px-3 py-2 text-sm font-medium transition-colors",
                activeTab === tab.id
                  ? "border-b-2 border-white text-white"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="mt-6">
        <ActiveComponent />
      </div>
    </div>
  );
}
```

**Step 2: Verify it builds**

Run: `cd /home/user/dev/nyxhive/src/gateway && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

**Step 3: Commit**

```bash
git add src/gateway/src/pages/Settings.tsx
git commit -m "feat(gateway): add Settings container page with tab navigation"
```

---

## Phase 3: Unified Work Page (replaces Tasks + Proposals)

### Task 3.1: Create Work page

**Files:**
- Create: `src/gateway/src/pages/Work.tsx`

The Work page is the Proposals page with better status grouping. No Kanban drag-drop — just the existing tab-filtered list, but with a more intuitive tab structure:

- **Inbox** (proposed + reviewed — needs action)
- **In Progress** (approved + executing + reviewing)
- **Done** (completed + merged)
- **Rejected** (rejected + failed + expired)
- **All**

```tsx
import { useEffect, useCallback } from "react";
import { useProposalsStore } from "../stores/proposals";
import { useWsEvent } from "../hooks/useWs";
import { ProposalCard } from "../components/proposals/ProposalCard";
import { Skeleton } from "../components/ui/skeleton";
import type { Frame } from "../../protocol/frame";

type WorkTab = "inbox" | "active" | "done" | "rejected" | "all";

const tabConfig: { id: WorkTab; label: string; filter: (status: string) => boolean }[] = [
  {
    id: "inbox",
    label: "Inbox",
    filter: (s) => s === "proposed" || s === "reviewed",
  },
  {
    id: "active",
    label: "In Progress",
    filter: (s) => s === "approved" || s === "executing" || s === "reviewing",
  },
  {
    id: "done",
    label: "Done",
    filter: (s) => s === "completed" || s === "merged",
  },
  {
    id: "rejected",
    label: "Rejected",
    filter: (s) => s === "rejected" || s === "failed" || s === "expired",
  },
  {
    id: "all",
    label: "All",
    filter: () => true,
  },
];

export function WorkPage() {
  const {
    proposals,
    loading,
    fetchProposals,
    approve,
    reject,
    updateProposal,
  } = useProposalsStore();

  // Use "all" filter at store level — we filter client-side per tab
  useEffect(() => {
    fetchProposals();
  }, [fetchProposals]);

  const handleUpdate = useCallback(
    (frame: Frame) => {
      const payload = frame.payload as {
        proposalId: string;
        status: string;
        prUrl?: string;
      };
      updateProposal(payload.proposalId, {
        status: payload.status,
        prUrl: payload.prUrl,
      });
    },
    [updateProposal],
  );
  useWsEvent("proposal:update", handleUpdate);

  // Default to inbox if there are pending items, otherwise all
  const inboxCount = proposals.filter(
    (p) => p.status === "proposed" || p.status === "reviewed",
  ).length;
  const activeCount = proposals.filter(
    (p) => p.status === "approved" || p.status === "executing" || p.status === "reviewing",
  ).length;

  const [activeTab, setActiveTab] = useState<WorkTab>(inboxCount > 0 ? "inbox" : "all");

  const currentFilter = tabConfig.find((t) => t.id === activeTab)!;
  const filtered = proposals.filter((p) => currentFilter.filter(p.status));

  return (
    <div>
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold">Work</h1>
        {inboxCount > 0 && (
          <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-red-500/20 px-2 text-xs font-medium text-red-400">
            {inboxCount}
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-zinc-400">Proposals and autonomous work items</p>

      <div className="mt-4 flex gap-1 border-b border-zinc-800 pb-px">
        {tabConfig.map((tab) => {
          const count =
            tab.id === "inbox" ? inboxCount
            : tab.id === "active" ? activeCount
            : 0;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors",
                activeTab === tab.id
                  ? "border-b-2 border-white text-white"
                  : "text-zinc-500 hover:text-zinc-300",
              )}
            >
              {tab.label}
              {count > 0 && (
                <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-zinc-800 px-1 text-xs">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
        {loading ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-500">
            {activeTab === "inbox"
              ? "Nothing needs your attention"
              : activeTab === "active"
                ? "No work in progress"
                : `No ${currentFilter.label.toLowerCase()} items`}
          </p>
        ) : (
          <div className="space-y-3">
            {filtered.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                onApprove={approve}
                onReject={reject}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

Note: This file needs `import { useState } from "react"` added to the existing import and `import { cn } from "../lib/utils"`.

**Step 2: Verify it builds**

Run: `cd /home/user/dev/nyxhive/src/gateway && npx vite build 2>&1 | tail -5`

**Step 3: Commit**

```bash
git add src/gateway/src/pages/Work.tsx
git commit -m "feat(gateway): add unified Work page replacing Tasks + Proposals"
```

---

## Phase 4: Route & Navigation Switch (the atomic swap)

### Task 4.1: Update App.tsx routes

**Files:**
- Modify: `src/gateway/src/App.tsx`

**Step 1: Update the router**

Replace the current route definitions with:

```tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Layout } from "./components/Layout";
import { HomePage } from "./pages/Home";
import { ChatPage } from "./pages/Chat";
import { AgentsPage } from "./pages/Agents";
import { ThreadsPage } from "./pages/Threads";
import { ThreadDetailPage } from "./pages/ThreadDetail";
import { WorkPage } from "./pages/Work";
import { SettingsPage } from "./pages/Settings";
import { ToastProvider } from "./components/ui/toast";
import { useDeviceNotifications } from "./hooks/useDeviceNotifications";

function DeviceNotificationListener() {
  useDeviceNotifications();
  return null;
}

export function App() {
  return (
    <ToastProvider>
      <DeviceNotificationListener />
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/threads" element={<ThreadsPage />} />
            <Route path="/threads/:id" element={<ThreadDetailPage />} />
            <Route path="/work" element={<WorkPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {/* Redirects for old bookmarks */}
            <Route path="/proposals" element={<Navigate to="/work" replace />} />
            <Route path="/tasks" element={<Navigate to="/work" replace />} />
            <Route path="/logs" element={<Navigate to="/settings" replace />} />
            <Route path="/config" element={<Navigate to="/settings" replace />} />
            <Route path="/knowledge" element={<Navigate to="/settings" replace />} />
            <Route path="/scheduler" element={<Navigate to="/settings" replace />} />
            <Route path="/channels" element={<Navigate to="/settings" replace />} />
            <Route path="/costs" element={<Navigate to="/agents" replace />} />
            <Route path="/devices" element={<Navigate to="/settings" replace />} />
            <Route path="/system" element={<Navigate to="/settings" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
```

**Step 2: Commit routes change**

```bash
git add src/gateway/src/App.tsx
git commit -m "feat(gateway): update routes — Home, Work, Settings + old URL redirects"
```

### Task 4.2: Update Layout.tsx navigation

**Files:**
- Modify: `src/gateway/src/components/Layout.tsx`

**Step 1: Replace navigation items**

Replace the three nav arrays (`mainNav`, `toolsNav`, `systemNav`) and their rendering with a single flat list:

```tsx
import {
  Home, MessageSquare, Bot, GitBranch, Briefcase, Settings,
} from "lucide-react";
```

Navigation items (single array, no grouping):
```tsx
const navItems: NavItem[] = [
  { to: "/", icon: Home, label: "Home" },
  { to: "/chat", icon: MessageSquare, label: "Chat" },
  {
    to: "/work",
    icon: Briefcase,
    label: "Work",
    badge: () => pendingProposals,
    badgeColor: "bg-red-500/20 text-red-400",
  },
  {
    to: "/agents",
    icon: Bot,
    label: "Agents",
    badge: () => runningAgents,
    badgeColor: "bg-amber-500/20 text-amber-400",
  },
  { to: "/threads", icon: GitBranch, label: "Threads" },
  { to: "/settings", icon: Settings, label: "Settings" },
];
```

Sidebar rendering — replace the 3 NavSections + 2 Separators with:
```tsx
<div className="flex flex-1 flex-col gap-1 overflow-auto p-3">
  <NavSection items={navItems} />
</div>
```

Remove unused imports: `FileCheck`, `KanbanSquare`, `ScrollText`, `Brain`, `Clock`, `Radio`, `DollarSign`, `Smartphone`, `Activity`. Remove the `Separator` import if only used in nav (keep if used in ConnectionIndicator section).

**Step 2: Verify build**

Run: `cd /home/user/dev/nyxhive/src/gateway && npx vite build 2>&1 | tail -5`

**Step 3: Commit**

```bash
git add src/gateway/src/components/Layout.tsx
git commit -m "feat(gateway): simplify navigation to 6 items"
```

---

## Phase 5: Cleanup

### Task 5.1: Remove dead pages and stores

**Files:**
- Delete: `src/gateway/src/pages/Tasks.tsx`
- Delete: `src/gateway/src/pages/CostAnalytics.tsx`
- Delete: `src/gateway/src/components/tasks/Board.tsx`
- Delete: `src/gateway/src/components/tasks/TaskCard.tsx`
- Delete: `src/gateway/src/stores/tasks.ts`

Do NOT delete the old pages that are now embedded in Settings (Logs, Config, Knowledge, Scheduler, Channels, Devices, System) — those components are still imported and rendered within `SettingsPage`.

**Step 1: Remove files**

```bash
rm src/gateway/src/pages/Tasks.tsx
rm src/gateway/src/pages/CostAnalytics.tsx
rm -rf src/gateway/src/components/tasks/
rm src/gateway/src/stores/tasks.ts
```

**Step 2: Verify build**

Run: `cd /home/user/dev/nyxhive/src/gateway && npx vite build 2>&1 | tail -5`
Expected: Build succeeds — no remaining imports of deleted files.

If build fails, check for any remaining imports of `TasksPage`, `CostAnalyticsPage`, `Board`, `TaskCard`, or `useTasksStore` and remove them.

**Step 3: Commit**

```bash
git add -A
git commit -m "chore(gateway): remove Tasks and CostAnalytics — merged into Work and Agents"
```

---

## Phase 6: Polish Pass

### Task 6.1: Page header consistency

All pages should follow the same header pattern:
```
<h1> — text-2xl font-semibold
<p>  — mt-1 text-sm text-zinc-400
```

Check each page and fix any that deviate. The existing pages already follow this pattern, so this is just verification.

### Task 6.2: Empty state consistency

Every page/tab that can be empty should show a centered message with an icon. Check:
- Work page inbox/active/done/rejected tabs
- Agents page (no agents)
- Threads page (no threads)
- Settings tabs (no logs, no jobs, etc.)

### Task 6.3: Loading state consistency

Every page should show Skeleton placeholders while loading. Verify all pages use the same pattern:
```tsx
{loading ? <Skeleton ... /> : <content />}
```

### Task 6.4: Final build + visual check

Run: `cd /home/user/dev/nyxhive/src/gateway && npx vite build 2>&1 | tail -10`
Expected: Clean build, no warnings.

Run dev server and check each page loads:
```bash
cd /home/user/dev/nyxhive/src/gateway && npx vite --open
```

**Step: Commit polish**

```bash
git add -A
git commit -m "feat(gateway): polish pass — consistent headers, empty states, loading states"
```

---

## Summary

| Phase | Tasks | Risk | Reversible |
|-------|-------|------|------------|
| 1. Home Dashboard | 1.1 | None — new file | Delete file |
| 2. Settings Shell | 2.1 | None — new file | Delete file |
| 3. Work Page | 3.1 | None — new file | Delete file |
| 4. Route Switch | 4.1, 4.2 | Medium — changes navigation | Git revert |
| 5. Cleanup | 5.1 | Low — removes dead code | Git revert |
| 6. Polish | 6.1-6.4 | None — cosmetic | Git revert |

Phases 1-3 can run in parallel (all create new files, no overlap). Phase 4 depends on all three. Phase 5 depends on 4. Phase 6 depends on 5.

# Gateway "Make It Real" Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the NyxHive gateway dashboard — add toast feedback on actions, pagination on all list pages, real-time updates on stale pages, thread management on ThreadDetail, and persist sidebar state.

**Architecture:** Enhance existing React 19 + Vite + TailwindCSS 4 + Zustand gateway. All changes are frontend-only — no backend modifications needed. Existing WS events and API endpoints already support everything.

**Tech Stack:** React 19, Zustand 5, TailwindCSS 4, Radix UI, lucide-react, WebSocket protocol

**Spec:** `docs/superpowers/specs/2026-03-09-gateway-make-it-real-design.md`

---

## Chunk 1: Toast Variants + Success Feedback

### Task 1: Add type variants to existing toast system

**Files:**
- Modify: `src/gateway/src/components/ui/toast.tsx`

- [ ] **Step 1: Add `type` field to Toast interface**

In `src/gateway/src/components/ui/toast.tsx`, update the `Toast` interface and `ToastItem` to support typed toasts:

```tsx
interface Toast {
	id: string;
	title: string;
	description?: string;
	type?: "success" | "error" | "info";
	action?: { label: string; onClick: () => void };
	duration?: number;
}
```

- [ ] **Step 2: Add visual variant styling to ToastItem**

Update `ToastItem` to show a colored left border based on type. Replace the outer `div` className:

```tsx
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
	const borderColor = toast.type === "success"
		? "border-l-emerald-500"
		: toast.type === "error"
			? "border-l-red-500"
			: toast.type === "info"
				? "border-l-blue-500"
				: "border-l-zinc-700";

	useEffect(() => {
		const defaultDuration = toast.type === "success" ? 4000 : 8000;
		if (!toast.action) {
			const timer = setTimeout(onDismiss, toast.duration ?? defaultDuration);
			return () => clearTimeout(timer);
		}
	}, [toast, onDismiss]);

	return (
		<div
			className={`rounded-lg border border-zinc-700 border-l-4 ${borderColor} bg-zinc-900 p-4 shadow-lg min-w-[320px] max-w-[420px]`}
			style={{
				animation: "toast-slide-in 0.25s ease-out",
			}}
		>
```

- [ ] **Step 3: Add max toast cap**

In `ToastProvider`, cap visible toasts at 5. Update the `addToast` callback:

```tsx
const addToast = useCallback((toast: Omit<Toast, "id">) => {
	const id = crypto.randomUUID();
	setToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
}, []);
```

- [ ] **Step 4: Verify build**

Run: `cd src/gateway && bun run build`
Expected: Build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/src/components/ui/toast.tsx
git commit -m "feat(gateway): add toast type variants with colored borders and auto-dismiss"
```

### Task 2: Wire success toasts into proposal store

**Files:**
- Modify: `src/gateway/src/stores/proposals.ts`

The challenge: stores don't have access to React context (`useToast`). We need a different approach — export a standalone `toaster` that stores can call.

- [ ] **Step 1: Add standalone toast function to toast.tsx**

Add a module-level toast queue that the provider reads. In `src/gateway/src/components/ui/toast.tsx`, add before the `ToastContext`:

```tsx
type ToastInput = Omit<Toast, "id">;

/** Standalone toast function — callable from anywhere (stores, utils) */
let _addToast: ((toast: ToastInput) => void) | null = null;

export function toast(input: ToastInput) {
	if (_addToast) _addToast(input);
	else console.warn("[toast] Provider not mounted yet");
}

export function toast_success(title: string, description?: string) {
	toast({ title, type: "success", description });
}

export function toast_error(title: string, description?: string) {
	toast({ title, type: "error", description });
}
```

Then in `ToastProvider`, register the function:

```tsx
export function ToastProvider({ children }: { children: React.ReactNode }) {
	const [toasts, setToasts] = useState<Toast[]>([]);

	const addToast = useCallback((toast: Omit<Toast, "id">) => {
		const id = crypto.randomUUID();
		setToasts((prev) => [...prev.slice(-4), { ...toast, id }]);
	}, []);

	// Register standalone toast function
	useEffect(() => {
		_addToast = addToast;
		return () => { _addToast = null; };
	}, [addToast]);
```

- [ ] **Step 2: Add success toasts to proposals store**

In `src/gateway/src/stores/proposals.ts`, import and use:

```tsx
import { toast_success } from "../components/ui/toast";
```

Update each action:

```tsx
approve: async (id, notes) => {
	await gateway.request("proposals.approve", { proposalId: id, notes });
	toast_success("Proposal approved");
	get().fetchProposals();
},

reject: async (id, notes) => {
	await gateway.request("proposals.reject", { proposalId: id, notes });
	toast_success("Proposal rejected");
	get().fetchProposals();
},

startReview: async (id) => {
	await gateway.request("proposals.startReview", { proposalId: id });
	toast_success("Review started");
	get().fetchProposals();
},

deleteProposal: async (id) => {
	await gateway.request("proposals.delete", { proposalId: id });
	toast_success("Proposal deleted");
	set((state) => ({
		proposals: state.proposals.filter((p) => p.id !== id),
	}));
},

clearTerminal: async () => {
	const result = await gateway.request<{ deleted: number }>(
		"proposals.deleteTerminal",
		{},
	);
	toast_success(`Cleared ${result.deleted} proposals`);
	get().fetchProposals();
	return result.deleted;
},
```

- [ ] **Step 3: Verify build**

Run: `cd src/gateway && bun run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/gateway/src/components/ui/toast.tsx src/gateway/src/stores/proposals.ts
git commit -m "feat(gateway): success toasts on proposal actions"
```

### Task 3: Wire success toasts into threads and scheduler stores

**Files:**
- Modify: `src/gateway/src/stores/threads.ts`
- Modify: `src/gateway/src/stores/scheduler.ts`

- [ ] **Step 1: Add toasts to threads store**

In `src/gateway/src/stores/threads.ts`, import and add:

```tsx
import { toast_success } from "../components/ui/toast";
```

Update methods:

```tsx
renameThread: async (id, title) => {
	await gateway.request("threads.rename", { id, title });
	toast_success("Thread renamed");
	set((state) => ({
		threads: state.threads.map((t) =>
			t.id === id ? { ...t, title } : t,
		),
	}));
},

deleteThread: async (id) => {
	await gateway.request("threads.delete", { id });
	toast_success("Thread deleted");
	set((state) => ({
		threads: state.threads.filter((t) => t.id !== id),
	}));
},

archiveThread: async (id) => {
	await gateway.request("threads.archive", { id });
	toast_success("Thread archived");
	set((state) => ({
		threads: state.threads.filter((t) => t.id !== id),
	}));
},
```

- [ ] **Step 2: Add toasts to scheduler store**

In `src/gateway/src/stores/scheduler.ts`, import and add:

```tsx
import { toast_success } from "../components/ui/toast";
```

Update methods:

```tsx
toggleJob: async (id, enabled) => {
	set((state) => ({
		jobs: state.jobs.map((j) => (j.id === id ? { ...j, enabled } : j)),
	}));
	try {
		await gateway.request("scheduler.update", { id, enabled });
		toast_success(enabled ? "Job enabled" : "Job disabled");
	} catch {
		get().fetchJobs();
	}
},

runJob: async (id) => {
	set((state) => {
		const next = new Set(state.runningJobs);
		next.add(id);
		return { runningJobs: next };
	});
	await gateway.request("scheduler.run", { id });
	toast_success("Job triggered");
},
```

- [ ] **Step 3: Verify build**

Run: `cd src/gateway && bun run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/gateway/src/stores/threads.ts src/gateway/src/stores/scheduler.ts
git commit -m "feat(gateway): success toasts on thread and scheduler actions"
```

---

## Chunk 2: Pagination

### Task 4: Create usePagination hook

**Files:**
- Create: `src/gateway/src/hooks/usePagination.ts`

- [ ] **Step 1: Create the hook**

```tsx
import { useState, useCallback } from "react";

interface PaginationState<T> {
	items: T[];
	page: number;
	pageSize: number;
	total: number | null;
	totalPages: number | null;
	loading: boolean;
	nextPage: () => void;
	prevPage: () => void;
	setPageSize: (size: number) => void;
	reset: () => void;
	/** Reset to page 1 and immediately refetch (avoids stale page race) */
	resetAndFetch: (pageSize?: number) => void;
	fetch: () => Promise<void>;
}

export function usePagination<T>(
	fetcher: (offset: number, limit: number) => Promise<{ items: T[]; total?: number }>,
	defaultPageSize = 50,
): PaginationState<T> {
	const [items, setItems] = useState<T[]>([]);
	const [page, setPage] = useState(1);
	const [pageSize, setPageSizeState] = useState(defaultPageSize);
	const [total, setTotal] = useState<number | null>(null);
	const [loading, setLoading] = useState(false);

	const totalPages = total !== null ? Math.ceil(total / pageSize) : null;

	const doFetch = useCallback(async (p: number, size: number) => {
		setLoading(true);
		try {
			const offset = (p - 1) * size;
			const result = await fetcher(offset, size);
			setItems(result.items);
			if (result.total !== undefined) setTotal(result.total);
		} finally {
			setLoading(false);
		}
	}, [fetcher]);

	const fetch = useCallback(() => doFetch(page, pageSize), [doFetch, page, pageSize]);

	const nextPage = useCallback(() => {
		const next = page + 1;
		if (totalPages !== null && next > totalPages) return;
		setPage(next);
		doFetch(next, pageSize);
	}, [page, totalPages, pageSize, doFetch]);

	const prevPage = useCallback(() => {
		if (page <= 1) return;
		const prev = page - 1;
		setPage(prev);
		doFetch(prev, pageSize);
	}, [page, pageSize, doFetch]);

	const setPageSize = useCallback((size: number) => {
		setPageSizeState(size);
		setPage(1);
		doFetch(1, size);
	}, [doFetch]);

	/** Reset to page 1 and immediately refetch */
	const resetAndFetch = useCallback((size?: number) => {
		const s = size ?? defaultPageSize;
		setPage(1);
		setTotal(null);
		setItems([]);
		setPageSizeState(s);
		doFetch(1, s);
	}, [doFetch, defaultPageSize]);

	const reset = useCallback(() => {
		setPage(1);
		setTotal(null);
		setItems([]);
	}, []);

	return { items, page, pageSize, total, totalPages, loading, nextPage, prevPage, setPageSize, reset, resetAndFetch, fetch };
}
```

- [ ] **Step 2: Verify build**

Run: `cd src/gateway && bun run build`
Expected: Build succeeds (unused export is fine).

- [ ] **Step 3: Commit**

```bash
git add src/gateway/src/hooks/usePagination.ts
git commit -m "feat(gateway): add usePagination hook"
```

### Task 5: Create Pagination component

**Files:**
- Create: `src/gateway/src/components/ui/pagination.tsx`

- [ ] **Step 1: Create the component**

```tsx
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./button";
import { cn } from "../../lib/utils";

interface PaginationProps {
	page: number;
	totalPages: number | null;
	total: number | null;
	pageSize: number;
	loading?: boolean;
	onNext: () => void;
	onPrev: () => void;
	onPageSizeChange?: (size: number) => void;
	className?: string;
}

const pageSizes = [25, 50, 100];

export function Pagination({
	page,
	totalPages,
	total,
	pageSize,
	loading,
	onNext,
	onPrev,
	onPageSizeChange,
	className,
}: PaginationProps) {
	const start = (page - 1) * pageSize + 1;
	const end = total !== null ? Math.min(page * pageSize, total) : page * pageSize;
	const atStart = page <= 1;
	const atEnd = totalPages !== null ? page >= totalPages : false;

	return (
		<div className={cn("flex items-center justify-between pt-4", className)}>
			<div className="text-xs text-zinc-500">
				{total !== null ? (
					<span>Showing {start}-{end} of {total}</span>
				) : (
					<span>Page {page}</span>
				)}
			</div>
			<div className="flex items-center gap-2">
				{onPageSizeChange && (
					<select
						value={pageSize}
						onChange={(e) => onPageSizeChange(Number(e.target.value))}
						className="h-8 rounded-md border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-400"
					>
						{pageSizes.map((s) => (
							<option key={s} value={s}>{s} / page</option>
						))}
					</select>
				)}
				<Button
					variant="outline"
					size="sm"
					onClick={onPrev}
					disabled={atStart || loading}
				>
					<ChevronLeft className="h-4 w-4" />
				</Button>
				<Button
					variant="outline"
					size="sm"
					onClick={onNext}
					disabled={atEnd || loading}
				>
					<ChevronRight className="h-4 w-4" />
				</Button>
			</div>
		</div>
	);
}
```

- [ ] **Step 2: Verify build**

Run: `cd src/gateway && bun run build`
Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/gateway/src/components/ui/pagination.tsx
git commit -m "feat(gateway): add Pagination component"
```

### Task 6: Add pagination to Threads page

**Files:**
- Modify: `src/gateway/src/stores/threads.ts`
- Modify: `src/gateway/src/pages/Threads.tsx`

- [ ] **Step 1: Update threads store to accept offset/limit and return total**

In `src/gateway/src/stores/threads.ts`, update the `fetchThreads` method to accept params:

```tsx
interface ThreadsState {
	threads: Thread[];
	total: number | null;
	loading: boolean;
	filters: {
		agent: string;
		project: string;
		status: string;
	};

	fetchThreads: (offset?: number, limit?: number) => Promise<{ items: Thread[]; total?: number }>;
	// ... rest unchanged
}
```

Update `fetchThreads`:

```tsx
fetchThreads: async (offset = 0, limit = 50) => {
	set({ loading: true });
	try {
		const { filters } = get();
		const result = await gateway.request<{ threads: Thread[]; total?: number }>(
			"threads.list",
			{
				agent: filters.agent || undefined,
				projectId: filters.project || undefined,
				status: filters.status || undefined,
				limit,
				offset,
			},
		);
		const threads = result.threads ?? [];
		set({ threads, total: result.total ?? null, loading: false });
		return { items: threads, total: result.total };
	} catch {
		set({ loading: false });
		return { items: [] };
	}
},
```

- [ ] **Step 2: Integrate pagination into Threads page**

Replace the Threads page to use `usePagination`:

```tsx
import { useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useThreadsStore } from "../stores/threads";
import { usePagination } from "../hooks/usePagination";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { Input } from "../components/ui/input";
import { Pagination } from "../components/ui/pagination";
import { formatDate, formatTokens, formatCost } from "../lib/format";
import { threadStatusColors } from "../lib/colors";

export function ThreadsPage() {
	const { filters, setFilter, fetchThreads } = useThreadsStore();
	const navigate = useNavigate();

	const fetcher = useCallback(
		(offset: number, limit: number) => fetchThreads(offset, limit),
		[fetchThreads],
	);

	const pag = usePagination(fetcher, 50);

	useEffect(() => {
		pag.fetch();
	}, [pag.fetch]);

	// Refetch on filter change — use resetAndFetch to avoid stale page race
	useEffect(() => {
		pag.resetAndFetch();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [filters.agent, filters.project, filters.status]);

	return (
		<div>
			<h1 className="text-2xl font-semibold">Threads</h1>
			<p className="mt-1 text-sm text-zinc-400">
				{pag.total !== null ? `${pag.total} conversation${pag.total !== 1 ? "s" : ""}` : "Conversations"}
			</p>

			<div className="mt-4 flex gap-2">
				<Input
					placeholder="Filter by agent..."
					value={filters.agent}
					onChange={(e) => setFilter("agent", e.target.value)}
					className="max-w-[200px]"
				/>
				<Input
					placeholder="Filter by project..."
					value={filters.project}
					onChange={(e) => setFilter("project", e.target.value)}
					className="max-w-[200px]"
				/>
			</div>

			<div className="mt-4">
				{pag.loading ? (
					<div className="space-y-2">
						{Array.from({ length: 5 }).map((_, i) => (
							<Skeleton key={i} className="h-14 rounded-lg" />
						))}
					</div>
				) : pag.items.length === 0 ? (
					<p className="py-8 text-center text-sm text-zinc-500">
						No threads found
					</p>
				) : (
					<div className="overflow-hidden rounded-lg border border-zinc-800">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-zinc-800 bg-zinc-900/50">
									<th className="px-4 py-3 text-left font-medium text-zinc-400">Title</th>
									<th className="px-4 py-3 text-left font-medium text-zinc-400">Agent</th>
									<th className="px-4 py-3 text-left font-medium text-zinc-400">Status</th>
									<th className="px-4 py-3 text-right font-medium text-zinc-400">Tokens</th>
									<th className="px-4 py-3 text-right font-medium text-zinc-400">Cost</th>
									<th className="px-4 py-3 text-right font-medium text-zinc-400">Created</th>
								</tr>
							</thead>
							<tbody>
								{pag.items.map((thread) => (
									<tr
										key={thread.id}
										onClick={() => navigate(`/threads/${thread.id}`)}
										className="cursor-pointer border-b border-zinc-800/50 transition-colors hover:bg-zinc-900/50 last:border-0"
									>
										<td className="max-w-[300px] truncate px-4 py-3 font-medium">
											{thread.title || thread.id.slice(0, 8)}
										</td>
										<td className="px-4 py-3 text-zinc-400">{thread.agent}</td>
										<td className="px-4 py-3">
											<Badge variant="outline" className={threadStatusColors[thread.status] ?? threadStatusColors.created}>
												{thread.status}
											</Badge>
										</td>
										<td className="px-4 py-3 text-right tabular-nums text-zinc-400">
											{formatTokens(thread.tokensIn + thread.tokensOut)}
										</td>
										<td className="px-4 py-3 text-right tabular-nums text-zinc-400">
											{formatCost(thread.costCents, false)}
										</td>
										<td className="px-4 py-3 text-right text-zinc-500">
											{formatDate(thread.createdAt)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}

				{pag.items.length > 0 && (
					<Pagination
						page={pag.page}
						totalPages={pag.totalPages}
						total={pag.total}
						pageSize={pag.pageSize}
						loading={pag.loading}
						onNext={pag.nextPage}
						onPrev={pag.prevPage}
						onPageSizeChange={pag.setPageSize}
					/>
				)}
			</div>
		</div>
	);
}
```

- [ ] **Step 3: Verify build**

Run: `cd src/gateway && bun run build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/gateway/src/stores/threads.ts src/gateway/src/pages/Threads.tsx
git commit -m "feat(gateway): paginate Threads page"
```

### Task 7: Add pagination to Traces page

**Files:**
- Modify: `src/gateway/src/stores/traces.ts`
- Modify: `src/gateway/src/pages/Traces.tsx`

- [ ] **Step 1: Update traces store to accept offset/limit**

In `src/gateway/src/stores/traces.ts`, update `fetchTraces`:

```tsx
interface TracesState {
	traces: Trace[];
	total: number | null;
	// ... rest unchanged

	fetchTraces: (offset?: number, limit?: number) => Promise<{ items: Trace[]; total?: number }>;
	// ... rest unchanged
}
```

```tsx
total: null,

fetchTraces: async (offset = 0, limit = 50) => {
	set({ loading: true });
	try {
		const { statusFilter } = get();
		const result = await gateway.request<{ traces: Trace[]; total?: number }>("traces.list", {
			status: statusFilter || undefined,
			limit,
			offset,
		});
		const traces = result.traces ?? [];
		set({ traces, total: result.total ?? null, loading: false });
		return { items: traces, total: result.total };
	} catch {
		set({ loading: false });
		return { items: [] };
	}
},
```

- [ ] **Step 2: Add pagination to Traces page**

In `src/gateway/src/pages/Traces.tsx`, add imports and rewrite the `TracesPage` function. Key changes:
- Import `usePagination`, `Pagination`, `useCallback`
- Replace store's `traces`/`loading` with `pag.items`/`pag.loading`
- Use `resetAndFetch` on filter change
- Add `<Pagination />` after trace list

Add to imports:

```tsx
import { useEffect, useMemo, memo, useCallback } from "react";
import { usePagination } from "../hooks/usePagination";
import { Pagination } from "../components/ui/pagination";
```

Replace the `TracesPage` function opening (before the `totals` useMemo):

```tsx
export function TracesPage() {
	const { statusFilter, expandedTrace, traceEvents, setStatusFilter, toggleTrace } =
		useTracesStore();
	const fetchTraces = useTracesStore((s) => s.fetchTraces);

	const fetcher = useCallback(
		(offset: number, limit: number) => fetchTraces(offset, limit),
		[fetchTraces],
	);
	const pag = usePagination(fetcher, 50);

	useEffect(() => {
		pag.fetch();
	}, [pag.fetch]);

	useEffect(() => {
		pag.resetAndFetch();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [statusFilter]);
```

Then replace all occurrences in the JSX:
- `traces` (the array) → `pag.items`
- `loading` → `pag.loading`
- `traces.length` → `pag.items.length`

After the closing `</div>` of the trace list (the `<div className="space-y-3">` block), add:

```tsx
{pag.items.length > 0 && (
	<Pagination
		page={pag.page}
		totalPages={pag.totalPages}
		total={pag.total}
		pageSize={pag.pageSize}
		loading={pag.loading}
		onNext={pag.nextPage}
		onPrev={pag.prevPage}
		onPageSizeChange={pag.setPageSize}
	/>
)}
```

- [ ] **Step 3: Verify build**

Run: `cd src/gateway && bun run build`

- [ ] **Step 4: Commit**

```bash
git add src/gateway/src/stores/traces.ts src/gateway/src/pages/Traces.tsx
git commit -m "feat(gateway): paginate Traces page"
```

### Task 8: Add pagination to Activity page

**Files:**
- Modify: `src/gateway/src/stores/activity.ts`
- Modify: `src/gateway/src/pages/ActivityFeed.tsx`

- [ ] **Step 1: Update activity store to accept offset/limit**

In `src/gateway/src/stores/activity.ts`, update `fetchEntries`:

```tsx
interface ActivityState {
	entries: AuditEntry[];
	total: number | null;
	// ... rest

	fetchEntries: (offset?: number, limit?: number) => Promise<{ items: AuditEntry[]; total?: number }>;
	// ... rest
}
```

```tsx
total: null,

fetchEntries: async (offset = 0, limit = 50) => {
	set({ loading: true });
	try {
		const { category, agentFilter } = get();
		const eventPrefixes: Record<EventCategory, string | undefined> = {
			all: undefined,
			message: "message.",
			security: "security.",
			scheduler: "scheduler.",
			pairing: "pairing.",
		};
		const result = await gateway.request<{ entries: AuditEntry[]; total?: number }>("audit.list", {
			limit,
			offset,
			eventPrefix: eventPrefixes[category],
			agent: agentFilter || undefined,
		});
		const entries = result.entries ?? [];
		set({ entries, total: result.total ?? null, loading: false });
		return { items: entries, total: result.total };
	} catch {
		set({ loading: false });
		return { items: [] };
	}
},
```

- [ ] **Step 2: Integrate pagination into Activity page**

In `src/gateway/src/pages/ActivityFeed.tsx`, add imports:

```tsx
import { useEffect, useMemo, memo, useCallback } from "react";
import { usePagination } from "../hooks/usePagination";
import { Pagination } from "../components/ui/pagination";
```

Replace the component opening:

```tsx
export function ActivityFeedPage() {
	const { category, setCategory } = useActivityStore();
	const fetchEntries = useActivityStore((s) => s.fetchEntries);

	const fetcher = useCallback(
		(offset: number, limit: number) => fetchEntries(offset, limit),
		[fetchEntries],
	);
	const pag = usePagination(fetcher, 50);

	useEffect(() => {
		pag.fetch();
	}, [pag.fetch]);

	useEffect(() => {
		pag.resetAndFetch();
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [category]);
```

Then replace all occurrences in the JSX:
- `entries` (the array) → `pag.items`
- `loading` → `pag.loading`
- `entries.length` → `pag.items.length`

After the entry list card, add:

```tsx
{pag.items.length > 0 && (
	<Pagination
		page={pag.page}
		totalPages={pag.totalPages}
		total={pag.total}
		pageSize={pag.pageSize}
		loading={pag.loading}
		onNext={pag.nextPage}
		onPrev={pag.prevPage}
		onPageSizeChange={pag.setPageSize}
	/>
)}
```

- [ ] **Step 3: Add real-time event prepend to Activity page**

Import `useWsEvent` and add event listeners to prepend new activity on `proposal:update` and `agent:status` events:

```tsx
import { useWsEvent } from "../hooks/useWs";
import type { Frame } from "../../protocol/frame";
```

```tsx
// Real-time: refetch on proposal/agent status changes
const handleRealTimeUpdate = useCallback(
	(_frame: Frame) => {
		pag.fetch(); // Refetch current page to pick up new entries
	},
	[pag],
);
useWsEvent("proposal:update", handleRealTimeUpdate);
useWsEvent("agent:status", handleRealTimeUpdate);
```

- [ ] **Step 4: Verify build and commit**

```bash
cd src/gateway && bun run build
git add src/gateway/src/stores/activity.ts src/gateway/src/pages/ActivityFeed.tsx
git commit -m "feat(gateway): paginate Activity page with real-time updates"
```

### Task 9: Add pagination to Knowledge search results

**Files:**
- Modify: `src/gateway/src/stores/knowledge.ts`
- Modify: `src/gateway/src/pages/Knowledge.tsx`

- [ ] **Step 1: Increase search result limit**

In `src/gateway/src/stores/knowledge.ts`, update the `KnowledgeState` interface and `search` method to accept `limit`:

Update the interface:
```tsx
search: (limit?: number) => Promise<void>;
```

Update the implementation:
```tsx
search: async (limit = 25) => {
	const { query } = get();
	if (!query.trim()) return;

	set({ searching: true });
	try {
		const [memoryRes, knowledgeRes] = await Promise.allSettled([
			gateway.request<{ results: SearchResult[] }>("memory.search", { query, limit }),
			gateway.request<{ results: SearchResult[] }>("knowledge.search", { query, limit }),
		]);
		// ... rest unchanged
```

- [ ] **Step 2: Add "Show more" to Knowledge page**

In `src/gateway/src/pages/Knowledge.tsx`, add state tracking for result limit:

```tsx
const [resultLimit, setResultLimit] = useState(25);
```

At the bottom of each tab's results, add:

```tsx
{memoryResults.length >= resultLimit && (
	<Button
		variant="outline"
		className="w-full"
		onClick={() => {
			const next = resultLimit + 25;
			setResultLimit(next);
			search(next);
		}}
	>
		Show more
	</Button>
)}
```

- [ ] **Step 3: Verify build and commit**

```bash
cd src/gateway && bun run build
git add src/gateway/src/stores/knowledge.ts src/gateway/src/pages/Knowledge.tsx
git commit -m "feat(gateway): paginated knowledge search results"
```

---

## Chunk 3: Real-Time Updates + Visibility Refresh

### Task 10: Create useVisibilityRefresh hook

**Files:**
- Create: `src/gateway/src/hooks/useVisibilityRefresh.ts`

- [ ] **Step 1: Create the hook**

```tsx
import { useEffect, useRef } from "react";

/**
 * Calls `callback` when the document becomes visible after being hidden for at least `minHiddenMs`.
 * Useful for refreshing stale data on pages without WebSocket events.
 */
export function useVisibilityRefresh(callback: () => void, minHiddenMs = 30_000) {
	const hiddenAtRef = useRef<number | null>(null);

	useEffect(() => {
		const handler = () => {
			if (document.hidden) {
				hiddenAtRef.current = Date.now();
			} else if (hiddenAtRef.current !== null) {
				const elapsed = Date.now() - hiddenAtRef.current;
				hiddenAtRef.current = null;
				if (elapsed >= minHiddenMs) {
					callback();
				}
			}
		};

		document.addEventListener("visibilitychange", handler);
		return () => document.removeEventListener("visibilitychange", handler);
	}, [callback, minHiddenMs]);
}
```

- [ ] **Step 2: Verify build and commit**

```bash
cd src/gateway && bun run build
git add src/gateway/src/hooks/useVisibilityRefresh.ts
git commit -m "feat(gateway): add useVisibilityRefresh hook"
```

### Task 11: Add real-time thread:update to Threads page

**Files:**
- Modify: `src/gateway/src/pages/Threads.tsx`

- [ ] **Step 1: Subscribe to thread:update events**

Import `useWsEvent` and add handler in `ThreadsPage`:

```tsx
import { useWsEvent } from "../hooks/useWs";
import type { Frame } from "../../protocol/frame";
```

```tsx
const handleThreadUpdate = useCallback(
	(frame: Frame) => {
		const payload = frame.payload as { threadId?: string; status?: string; title?: string };
		if (!payload.threadId) return;
		// Refetch to get updated data
		pag.fetch();
	},
	[pag],
);
useWsEvent("thread:update", handleThreadUpdate);
```

- [ ] **Step 2: Verify build and commit**

```bash
cd src/gateway && bun run build
git add src/gateway/src/pages/Threads.tsx
git commit -m "feat(gateway): real-time thread updates on Threads page"
```

### Task 12: Add refresh indicator to Traces page

**Files:**
- Modify: `src/gateway/src/pages/Traces.tsx`

- [ ] **Step 1: Add "new traces" refresh banner**

Add state and WS listener:

```tsx
const [hasNewTraces, setHasNewTraces] = useState(false);

const handleThreadUpdate = useCallback(
	(_frame: Frame) => {
		// Thread updates may correlate with new traces
		setHasNewTraces(true);
	},
	[],
);
useWsEvent("thread:update", handleThreadUpdate);
```

Add a banner before the trace list:

```tsx
{hasNewTraces && (
	<button
		type="button"
		onClick={() => {
			setHasNewTraces(false);
			pag.fetch();
		}}
		className="w-full rounded-lg border border-violet-500/20 bg-violet-500/5 px-4 py-2 text-sm text-violet-300 hover:bg-violet-500/10 transition-colors"
	>
		New traces available — click to refresh
	</button>
)}
```

- [ ] **Step 2: Verify build and commit**

```bash
cd src/gateway && bun run build
git add src/gateway/src/pages/Traces.tsx
git commit -m "feat(gateway): new traces indicator on Traces page"
```

### Task 13: Add visibility refresh to Knowledge, Models, Channels

**Files:**
- Modify: `src/gateway/src/pages/Knowledge.tsx`
- Modify: `src/gateway/src/pages/Models.tsx`
- Modify: `src/gateway/src/pages/Channels.tsx`

- [ ] **Step 1: Add to Knowledge page**

In `src/gateway/src/pages/Knowledge.tsx`:

```tsx
import { useVisibilityRefresh } from "../hooks/useVisibilityRefresh";
```

```tsx
// Refresh stats when returning to tab after 30s away
useVisibilityRefresh(useCallback(() => {
	loadInitial();
}, [loadInitial]));
```

Note: `loadInitial` has a `if (get().loaded) return;` guard. We need to reset `loaded` on visibility refresh. Add a `refreshStats` method or modify `loadInitial` to skip the guard when called explicitly. Simplest: just call the store's `reset()` before `loadInitial()`:

```tsx
const reset = useKnowledgeStore((s) => s.reset);

useVisibilityRefresh(useCallback(() => {
	reset();
	loadInitial();
}, [reset, loadInitial]));
```

- [ ] **Step 2: Add to Models page**

In `src/gateway/src/pages/Models.tsx`:

```tsx
import { useVisibilityRefresh } from "../hooks/useVisibilityRefresh";
```

```tsx
useVisibilityRefresh(useCallback(() => {
	setLoading(true);
	gateway
		.request<{ success_rates: SuccessRate[] }>("usage.routing", { hours })
		.then((res) => setData(res.success_rates))
		.finally(() => setLoading(false));
}, [hours]));
```

- [ ] **Step 3: Add to Channels page**

In `src/gateway/src/pages/Channels.tsx`:

```tsx
import { useVisibilityRefresh } from "../hooks/useVisibilityRefresh";
```

```tsx
useVisibilityRefresh(load);
```

- [ ] **Step 4: Verify build and commit**

```bash
cd src/gateway && bun run build
git add src/gateway/src/pages/Knowledge.tsx src/gateway/src/pages/Models.tsx src/gateway/src/pages/Channels.tsx
git commit -m "feat(gateway): visibility refresh on Knowledge, Models, Channels pages"
```

---

## Chunk 4: ThreadDetail Actions + Reply

### Task 14: Create ConfirmDialog component

**Files:**
- Create: `src/gateway/src/components/ConfirmDialog.tsx`

- [ ] **Step 1: Create the component**

```tsx
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogFooter,
	DialogTitle,
	DialogDescription,
} from "./ui/dialog";
import { Button } from "./ui/button";

interface ConfirmDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	description?: string;
	confirmLabel?: string;
	variant?: "danger" | "default";
	onConfirm: () => void;
	loading?: boolean;
}

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel = "Confirm",
	variant = "default",
	onConfirm,
	loading,
}: ConfirmDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					{description && <DialogDescription>{description}</DialogDescription>}
				</DialogHeader>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={loading}>
						Cancel
					</Button>
					<Button
						variant={variant === "danger" ? "destructive" : "default"}
						onClick={() => {
							onConfirm();
							onOpenChange(false);
						}}
						disabled={loading}
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
```

- [ ] **Step 2: Verify build and commit**

```bash
cd src/gateway && bun run build
git add src/gateway/src/components/ConfirmDialog.tsx
git commit -m "feat(gateway): add ConfirmDialog component"
```

### Task 15: Add actions and reply to ThreadDetail page

**Files:**
- Modify: `src/gateway/src/pages/ThreadDetail.tsx`

This is the largest single task. ThreadDetail needs: inline rename, archive button, delete button, and a reply input at the bottom.

- [ ] **Step 1: Add imports and state**

Add to the top of `ThreadDetail.tsx`:

```tsx
import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Pencil, Archive, Trash2, Send } from "lucide-react";
import { useThreadsStore, type ThreadDetail } from "../stores/threads";
import { useWsEvent } from "../hooks/useWs";
import { gateway } from "../lib/ws";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { ScrollArea } from "../components/ui/scroll-area";
import { Skeleton } from "../components/ui/skeleton";
import { Input } from "../components/ui/input";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { cn } from "../lib/utils";
import { formatDate, formatTokens } from "../lib/format";
import type { Frame } from "../../protocol/frame";
```

- [ ] **Step 2: Add inline rename, archive, delete state and handlers**

Inside `ThreadDetailPage`, add:

```tsx
const { getThread, renameThread, archiveThread, deleteThread } = useThreadsStore();

// Rename state
const [editing, setEditing] = useState(false);
const [editTitle, setEditTitle] = useState("");
const inputRef = useRef<HTMLInputElement>(null);

const startRename = () => {
	setEditTitle(thread?.title ?? "");
	setEditing(true);
	setTimeout(() => inputRef.current?.focus(), 0);
};

const commitRename = async () => {
	if (!thread || !editTitle.trim()) return;
	setEditing(false);
	await renameThread(thread.id, editTitle.trim());
	setThread((prev) => prev ? { ...prev, title: editTitle.trim() } : prev);
};

// Delete dialog
const [showDelete, setShowDelete] = useState(false);
const handleDelete = async () => {
	if (!thread) return;
	await deleteThread(thread.id);
	navigate("/threads");
};

// Archive dialog
const [showArchive, setShowArchive] = useState(false);
const handleArchive = async () => {
	if (!thread) return;
	await archiveThread(thread.id);
	navigate("/threads");
};

// Reply
const [replyText, setReplyText] = useState("");
const [replying, setReplying] = useState(false);
const [replyResponse, setReplyResponse] = useState("");
const replyResponseRef = useRef("");

const handleReply = async () => {
	if (!thread || !replyText.trim()) return;
	setReplying(true);
	setReplyResponse("");
	try {
		await gateway.request("chat.send", {
			message: replyText,
			agent: thread.agent,
			threadId: thread.id,
		});
		// Append user message locally
		setThread((prev) => prev ? {
			...prev,
			messages: [...(prev.messages ?? []), {
				role: "user",
				content: replyText,
				timestamp: Date.now(),
			}],
		} : prev);
		setReplyText("");
	} catch {
		setReplying(false);
	}
};
```

Note: `setThread` needs to become a state setter function. Change from:
```tsx
const [thread, setThread] = useState<ThreadDetail | null>(null);
```
This is already fine — `useState` gives us a setter that accepts either a value or a function.

- [ ] **Step 3: Listen for streaming response on reply**

```tsx
// Listen for response deltas for this thread
const handleDelta = useCallback(
	(frame: Frame) => {
		const payload = frame.payload as { data?: { text_delta?: string; sender_id?: string }; text_delta?: string; sender_id?: string };
		const threadId = payload.data?.sender_id ?? payload.sender_id;
		if (threadId !== id) return;
		const delta = payload.data?.text_delta ?? payload.text_delta ?? "";
		if (delta) {
			replyResponseRef.current += delta;
			setReplyResponse(replyResponseRef.current);
		}
	},
	[id],
);

const handleDone = useCallback(
	(frame: Frame) => {
		const payload = frame.payload as { text?: string; threadId?: string; done?: boolean };
		const threadId = payload.threadId;
		if (threadId !== id) return;
		if (payload.done) {
			setReplying(false);
			// Use ref to avoid stale closure — ref always has latest accumulated text
			const finalText = payload.text || replyResponseRef.current;
			if (finalText) {
				setThread((prev) => prev ? {
					...prev,
					messages: [...(prev.messages ?? []), {
						role: "assistant",
						content: finalText,
						agent: prev.agent,
						timestamp: Date.now(),
					}],
				} : prev);
				replyResponseRef.current = "";
				setReplyResponse("");
			}
		}
	},
	[id],
);

useWsEvent("response:delta", handleDelta);
useWsEvent("chat:response", handleDone);
```

- [ ] **Step 4: Update the JSX**

Replace the header section (the `<div className="flex items-center gap-3">` block) with:

```tsx
<div className="flex items-center gap-3">
	<Button variant="ghost" size="icon" onClick={() => navigate("/threads")}>
		<ArrowLeft className="h-4 w-4" />
	</Button>
	<div className="min-w-0 flex-1">
		{editing ? (
			<Input
				ref={inputRef}
				value={editTitle}
				onChange={(e) => setEditTitle(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") commitRename();
					if (e.key === "Escape") setEditing(false);
				}}
				onBlur={commitRename}
				className="text-xl font-semibold"
			/>
		) : (
			<h1
				className="text-xl font-semibold truncate cursor-pointer group"
				onClick={startRename}
			>
				{thread.title || thread.id.slice(0, 8)}
				<Pencil className="ml-2 inline h-3.5 w-3.5 text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity" />
			</h1>
		)}
		<div className="flex items-center gap-2 text-sm text-zinc-400">
			{thread.agent && <Badge variant="secondary" className="text-xs">{thread.agent}</Badge>}
			{thread.project && !isUuid(thread.project) && (
				<span>{thread.project}</span>
			)}
			<span>{formatDate(thread.createdAt, true)}</span>
		</div>
	</div>
	<div className="flex items-center gap-1">
		<Button variant="ghost" size="icon" onClick={() => setShowArchive(true)} title="Archive">
			<Archive className="h-4 w-4 text-zinc-400" />
		</Button>
		<Button variant="ghost" size="icon" onClick={() => setShowDelete(true)} title="Delete">
			<Trash2 className="h-4 w-4 text-red-400" />
		</Button>
		<Badge variant="outline" className="ml-2 shrink-0">
			{thread.status}
		</Badge>
	</div>
</div>
```

Add dialogs and reply input at the bottom of the component (before the closing `</div>`):

```tsx
{/* Reply input */}
<div className="mt-4 flex gap-2">
	<Input
		placeholder="Send a follow-up message..."
		value={replyText}
		onChange={(e) => setReplyText(e.target.value)}
		onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleReply(); } }}
		disabled={replying}
		className="flex-1"
	/>
	<Button onClick={handleReply} disabled={replying || !replyText.trim()}>
		<Send className="h-4 w-4" />
	</Button>
</div>

{/* Streaming reply */}
{replyResponse && (
	<div className="mt-2 rounded-lg bg-zinc-900 px-4 py-3">
		<div className="mb-1 flex items-center gap-2">
			<span className="text-xs font-medium text-zinc-400">{thread.agent ?? "Assistant"}</span>
			{replying && <span className="text-xs text-violet-400 animate-pulse">streaming...</span>}
		</div>
		<p className="whitespace-pre-wrap text-sm">{replyResponse}</p>
	</div>
)}

{/* Confirm dialogs */}
<ConfirmDialog
	open={showDelete}
	onOpenChange={setShowDelete}
	title="Delete thread"
	description={`Are you sure you want to delete "${thread.title || thread.id.slice(0, 8)}"? This cannot be undone.`}
	confirmLabel="Delete"
	variant="danger"
	onConfirm={handleDelete}
/>
<ConfirmDialog
	open={showArchive}
	onOpenChange={setShowArchive}
	title="Archive thread"
	description="This thread will be hidden from the default list. You can still find it with filters."
	confirmLabel="Archive"
	onConfirm={handleArchive}
/>
```

- [ ] **Step 5: Verify build**

Run: `cd src/gateway && bun run build`
Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/gateway/src/pages/ThreadDetail.tsx
git commit -m "feat(gateway): thread actions (rename, archive, delete) and reply on ThreadDetail"
```

---

## Chunk 5: Sidebar Persist + Done Column Cap

### Task 16: Persist chat sidebar collapsed state

**Files:**
- Modify: `src/gateway/src/stores/chat.ts`
- Modify: `src/gateway/src/pages/Chat.tsx`

- [ ] **Step 1: Add sidebarCollapsed to chat store**

In `src/gateway/src/stores/chat.ts`, add to `ChatState` interface:

```tsx
sidebarCollapsed: boolean;
toggleSidebar: () => void;
```

Add to the store implementation (inside the `persist` call):

```tsx
sidebarCollapsed: false,
toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
```

Update `partialize` to include it:

```tsx
partialize: (state) => ({
	threadId: state.threadId,
	activeAgent: state.activeAgent,
	sidebarCollapsed: state.sidebarCollapsed,
}),
```

- [ ] **Step 2: Update Chat.tsx to use store**

In `src/gateway/src/pages/Chat.tsx`, remove local state and use store:

Replace:
```tsx
const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
```

With:
```tsx
const sidebarCollapsed = useChatStore((s) => s.sidebarCollapsed);
const toggleSidebar = useChatStore((s) => s.toggleSidebar);
```

Update the JSX:
```tsx
<ChatSidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
```

- [ ] **Step 3: Verify build and commit**

```bash
cd src/gateway && bun run build
git add src/gateway/src/stores/chat.ts src/gateway/src/pages/Chat.tsx
git commit -m "feat(gateway): persist chat sidebar collapsed state"
```

### Task 17: Cap Done column in Work page

**Files:**
- Modify: `src/gateway/src/pages/Work.tsx`

- [ ] **Step 1: Add show-more state for Done column**

In `WorkPage`, add state:

```tsx
const [doneLimit, setDoneLimit] = useState(20);
```

In the Done column rendering (the `isDone` branch), cap the items shown per group:

Wrap the `doneGroups` mapping. For each group, show only first N items and a "Show more" button:

```tsx
) : isDone ? (
	<>
		{doneGroups
			.filter((g) => items.some((p) => p.status === g.status))
			.map((group) => {
				const groupItems = items.filter((p) => p.status === group.status);
				const collapsed = collapsedGroups.has(group.status);
				const shown = groupItems.slice(0, doneLimit);
				const hasMore = groupItems.length > doneLimit;
				return (
					<div key={group.status}>
						<button
							onClick={() => toggleGroup(group.status)}
							className="mb-1 flex w-full items-center gap-1 px-1 text-[10px] font-semibold uppercase tracking-wider"
						>
							{collapsed ? (
								<ChevronRight className={cn("h-3 w-3", group.color)} />
							) : (
								<ChevronDown className={cn("h-3 w-3", group.color)} />
							)}
							<span className={group.color}>{group.label}</span>
							<span className="text-zinc-600">({groupItems.length})</span>
						</button>
						{!collapsed && (
							<>
								{shown.map((p) => (
									<KanbanCard
										key={p.id}
										proposal={p}
										onApprove={approve}
										onReject={reject}
										onStartReview={startReview}
										onDelete={deleteProposal}
										onSelect={(id) => selectProposal(selectedProposalId === id ? null : id)}
										isSelected={p.id === selectedProposalId}
									/>
								))}
								{hasMore && (
									<button
										onClick={() => setDoneLimit((l) => l + 20)}
										className="w-full py-2 text-xs text-zinc-500 hover:text-zinc-300"
									>
										Show {groupItems.length - doneLimit} more
									</button>
								)}
							</>
						)}
					</div>
				);
			})}
	</>
```

- [ ] **Step 2: Verify build and commit**

```bash
cd src/gateway && bun run build
git add src/gateway/src/pages/Work.tsx
git commit -m "feat(gateway): cap Done column with show-more in Work page"
```

### Task 18: Final build verification

- [ ] **Step 1: Full build check**

Run: `cd src/gateway && bun run build`
Expected: Build succeeds with no errors. The chunk size warning for index.js is expected and acceptable.

- [ ] **Step 2: Run engine tests to make sure nothing broke**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All 3129 tests pass (no gateway changes affect engine tests, but verify anyway).

- [ ] **Step 3: Final commit if any uncommitted changes remain**

```bash
git status
# If clean, done. If not, stage and commit remaining changes.
```

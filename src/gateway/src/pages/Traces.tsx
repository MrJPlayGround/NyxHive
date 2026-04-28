import { useEffect, useMemo, memo, useCallback, useState } from "react";
import { useTracesStore, type Trace, type TraceEvent } from "../stores/traces";
import { usePagination } from "../hooks/usePagination";
import { Pagination } from "../components/ui/pagination";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { useWsEvent } from "../hooks/useWs";
import type { Frame } from "../../protocol/frame";
import { traceStatusColors } from "../lib/colors";
import { formatCost, formatTokens, formatDuration, formatRelativeTime } from "../lib/format";
import {
	Activity,
	ChevronRight,
	Clock,
	DollarSign,
	Cpu,
	Bot,
	AlertCircle,
	CheckCircle2,
	Loader2,
} from "lucide-react";

const statusIcon: Record<string, typeof CheckCircle2> = {
	completed: CheckCircle2,
	failed: AlertCircle,
	running: Loader2,
};

const statusIconColor: Record<string, string> = {
	completed: "text-emerald-400",
	failed: "text-red-400",
	running: "text-amber-400",
};

/** Single event row inside an expanded trace */
const EventRow = memo(function EventRow({ event, depth = 0 }: { event: TraceEvent; depth?: number }) {
	const Icon = statusIcon[event.status] ?? Activity;
	return (
		<div
			className="flex items-start gap-3 py-2 border-b border-zinc-800/40 last:border-0"
			style={{ paddingLeft: `${depth * 20 + 12}px` }}
		>
			<Icon
				className={cn(
					"mt-0.5 h-3.5 w-3.5 shrink-0",
					statusIconColor[event.status] ?? "text-zinc-500",
					event.status === "running" && "animate-spin",
				)}
			/>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-[var(--nyx-accent)]">{event.agent}</span>
					{event.model && (
						<span className="text-[10px] text-zinc-600">{event.model}</span>
					)}
					{event.task_type && (
						<span className="text-[10px] rounded bg-zinc-800/60 px-1.5 py-0.5 text-zinc-500">
							{event.task_type}
						</span>
					)}
				</div>
				<p className="mt-0.5 text-xs text-zinc-400 line-clamp-2">{event.task}</p>
				{event.error && (
					<p className="mt-1 text-xs text-red-400 line-clamp-2">{event.error}</p>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-3 text-[11px] text-zinc-500">
				{event.duration_ms > 0 && <span>{formatDuration(event.duration_ms)}</span>}
				{(event.tokens_in + event.tokens_out) > 0 && (
					<span>{formatTokens(event.tokens_in + event.tokens_out)} tok</span>
				)}
				{event.cost > 0 && <span>{formatCost(event.cost)}</span>}
			</div>
		</div>
	);
});

/** Build a tree from flat events based on parent_event_id */
function buildEventTree(events: TraceEvent[]): { event: TraceEvent; depth: number }[] {
	const result: { event: TraceEvent; depth: number }[] = [];
	const childMap = new Map<number | null, TraceEvent[]>();

	for (const e of events) {
		const parent = e.parent_event_id;
		if (!childMap.has(parent)) childMap.set(parent, []);
		childMap.get(parent)!.push(e);
	}

	function walk(parentId: number | null, depth: number) {
		const children = childMap.get(parentId) ?? [];
		for (const child of children) {
			result.push({ event: child, depth });
			walk(child.id, depth + 1);
		}
	}

	walk(null, 0);
	// If tree is empty (all events might have non-null parents with missing root), flatten
	if (result.length === 0) {
		for (const e of events) result.push({ event: e, depth: 0 });
	}
	return result;
}

/** A single trace card — click to expand and see events */
const TraceCard = memo(function TraceCard({
	trace,
	expanded,
	events,
	onToggle,
}: {
	trace: Trace;
	expanded: boolean;
	events: TraceEvent[] | undefined;
	onToggle: () => void;
}) {
	const Icon = statusIcon[trace.status] ?? Activity;
	const tree = useMemo(() => (events ? buildEventTree(events) : []), [events]);

	return (
		<Card className={cn(expanded && "border-[rgb(var(--nyx-accent-rgb)/0.15)]")}>
			<button
				type="button"
				onClick={onToggle}
				className="w-full text-left"
			>
				<CardContent className="p-4">
					<div className="flex items-start gap-3">
						<Icon
							className={cn(
								"mt-1 h-4 w-4 shrink-0",
								statusIconColor[trace.status],
								trace.status === "running" && "animate-spin",
							)}
						/>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<span className="text-xs font-medium text-zinc-300 capitalize">
									{trace.channel}
								</span>
								<span className="text-xs text-zinc-600">from</span>
								<span className="text-xs text-zinc-400">{trace.sender}</span>
								<Badge
									variant="outline"
									className={cn("ml-auto text-[10px]", traceStatusColors[trace.status])}
								>
									{trace.status}
								</Badge>
							</div>
							<p className="mt-1 text-sm text-zinc-200 line-clamp-2">
								{trace.input_message}
							</p>
							<div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-zinc-500">
								<span className="flex items-center gap-1">
									<Clock className="h-3 w-3" />
									{formatRelativeTime(trace.created_at)}
								</span>
								{trace.total_duration_ms > 0 && (
									<span className="flex items-center gap-1">
										<Activity className="h-3 w-3" />
										{formatDuration(trace.total_duration_ms)}
									</span>
								)}
								<span className="flex items-center gap-1">
									<Bot className="h-3 w-3" />
									{trace.agent_count} agent{trace.agent_count !== 1 ? "s" : ""}
								</span>
								<span className="flex items-center gap-1">
									<Cpu className="h-3 w-3" />
									{formatTokens(trace.total_tokens_in + trace.total_tokens_out)}
								</span>
								<span className="flex items-center gap-1">
									<DollarSign className="h-3 w-3" />
									{formatCost(trace.total_cost)}
								</span>
								<ChevronRight
									className={cn(
										"ml-auto h-4 w-4 text-zinc-600 transition-transform",
										expanded && "rotate-90",
									)}
								/>
							</div>
						</div>
					</div>
				</CardContent>
			</button>

			{expanded && (
				<div className="border-t border-zinc-800/60 bg-zinc-950/30 px-4 py-2">
					{!events ? (
						<div className="flex items-center gap-2 py-3 text-xs text-zinc-500">
							<Loader2 className="h-3 w-3 animate-spin" />
							Loading events...
						</div>
					) : tree.length === 0 ? (
						<p className="py-3 text-xs text-zinc-600">No events recorded</p>
					) : (
						tree.map(({ event, depth }) => (
							<EventRow key={event.id} event={event} depth={depth} />
						))
					)}

					{trace.final_response && (
						<div className="mt-2 border-t border-zinc-800/40 pt-2">
							<p className="text-[10px] font-medium uppercase text-zinc-600 mb-1">
								Response
							</p>
							<p className="text-xs text-zinc-400 line-clamp-4">
								{trace.final_response}
							</p>
						</div>
					)}
				</div>
			)}
		</Card>
	);
});

const statusFilters = [
	{ value: "", label: "All" },
	{ value: "running", label: "Running" },
	{ value: "completed", label: "Completed" },
	{ value: "failed", label: "Failed" },
];

export function TracesPage() {
	const { statusFilter, expandedTrace, traceEvents, setStatusFilter, toggleTrace } =
		useTracesStore();
	const fetchTraces = useTracesStore((s) => s.fetchTraces);
	const [hasNewTraces, setHasNewTraces] = useState(false);

	const handleThreadUpdate = useCallback(
		(_frame: Frame) => {
			setHasNewTraces(true);
		},
		[],
	);
	useWsEvent("thread:update", handleThreadUpdate);

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

	const totals = useMemo(() => {
		const cost = pag.items.reduce((s, t) => s + t.total_cost, 0);
		const tokens = pag.items.reduce((s, t) => s + t.total_tokens_in + t.total_tokens_out, 0);
		const avgDuration =
			pag.items.length > 0
				? pag.items.reduce((s, t) => s + t.total_duration_ms, 0) / pag.items.length
				: 0;
		const failed = pag.items.filter((t) => t.status === "failed").length;
		return { cost, tokens, avgDuration, failed };
	}, [pag.items]);

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Traces</h1>
				<p className="mt-1 text-sm text-zinc-400">
					Execution traces for agent workflows
				</p>
			</div>

			{/* Summary stats */}
			{!pag.loading && pag.items.length > 0 && (
				<div className="grid gap-3 sm:grid-cols-4">
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<Activity className="h-4 w-4 text-[var(--nyx-accent)]" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Traces</p>
								<p className="text-lg font-semibold">{pag.items.length}</p>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<Clock className="h-4 w-4 text-[var(--nyx-accent)]" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Avg Duration</p>
								<p className="text-lg font-semibold">{formatDuration(totals.avgDuration)}</p>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<Cpu className="h-4 w-4 text-emerald-400" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Total Tokens</p>
								<p className="text-lg font-semibold">{formatTokens(totals.tokens)}</p>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<DollarSign className="h-4 w-4 text-amber-400" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Total Cost</p>
								<p className="text-lg font-semibold">{formatCost(totals.cost)}</p>
							</div>
						</CardContent>
					</Card>
				</div>
			)}

			{/* Status filter tabs */}
			<div className="flex gap-1 rounded-lg bg-zinc-900/50 p-1 w-fit">
				{statusFilters.map((f) => (
					<button
						key={f.value}
						type="button"
						onClick={() => setStatusFilter(f.value)}
						className={cn(
							"rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
							statusFilter === f.value
								? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)]"
								: "text-zinc-500 hover:text-zinc-300",
						)}
					>
						{f.label}
					</button>
				))}
			</div>

			{/* New traces banner */}
			{hasNewTraces && (
				<button
					type="button"
					onClick={() => {
						setHasNewTraces(false);
						pag.fetch();
					}}
					className="w-full rounded-lg border border-[rgb(var(--nyx-accent-rgb)/0.15)] bg-[rgb(var(--nyx-accent-rgb)/0.05)] px-4 py-2 text-sm text-[var(--nyx-accent)] hover:bg-[rgb(var(--nyx-accent-rgb)/0.08)] transition-colors"
				>
					New traces available — click to refresh
				</button>
			)}

			{/* Trace list */}
			{pag.loading ? (
				<div className="space-y-3">
					{Array.from({ length: 5 }).map((_, i) => (
						<Skeleton key={i} className="h-28 rounded-xl" />
					))}
				</div>
			) : pag.items.length === 0 ? (
				<p className="py-12 text-center text-sm text-zinc-500">
					{statusFilter ? `No ${statusFilter} traces found` : "No traces yet. Traces appear when agents process messages."}
				</p>
			) : (
				<div className="space-y-3">
					{pag.items.map((trace) => (
						<TraceCard
							key={trace.id}
							trace={trace}
							expanded={expandedTrace === trace.id}
							events={traceEvents[trace.id]}
							onToggle={() => toggleTrace(trace.id)}
						/>
					))}
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
	);
}

import { useEffect, useMemo, memo, useCallback } from "react";
import { useActivityStore, categorize, type AuditEntry, type EventCategory } from "../stores/activity";
import { usePagination } from "../hooks/usePagination";
import { Pagination } from "../components/ui/pagination";
import { useWsEvent } from "../hooks/useWs";
import type { Frame } from "../../protocol/frame";
import { Card, CardContent } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { formatRelativeTime } from "../lib/format";
import {
	Shield,
	MessageSquare,
	Clock as ClockIcon,
	Bot,
	Calendar,
	Link2,
	AlertTriangle,
	CheckCircle2,
	XCircle,
	Zap,
} from "lucide-react";

const categoryFilters: { value: EventCategory; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "message", label: "Messages" },
	{ value: "security", label: "Security" },
	{ value: "scheduler", label: "Scheduler" },
	{ value: "pairing", label: "Pairing" },
];

const eventIcons: Record<string, typeof MessageSquare> = {
	"message.received": MessageSquare,
	"message.completed": CheckCircle2,
	"message.failed": XCircle,
	"pairing.approved": Link2,
	"pairing.revoked": XCircle,
	"model.override": Zap,
	"scheduler.executed": Calendar,
	"scheduler.failed": XCircle,
	"security.command_exec": Shield,
	"security.command_blocked": AlertTriangle,
	"security.credential_access": AlertTriangle,
	"security.delegation_blocked": AlertTriangle,
	"security.delegation_approved": Shield,
	"security.auto_execute": Zap,
	"security.network_blocked": AlertTriangle,
	"security.sensitive_task_detected": AlertTriangle,
};

const eventColors: Record<string, string> = {
	message: "text-[var(--nyx-accent)]",
	security: "text-red-400",
	scheduler: "text-amber-400",
	pairing: "text-cyan-400",
};

const badgeColors: Record<string, string> = {
	message: "bg-[var(--nyx-accent-dim)] text-[var(--nyx-accent-2)] border-[rgb(var(--nyx-accent-rgb)/0.20)]",
	security: "bg-red-500/15 text-red-300 border-red-500/20",
	scheduler: "bg-amber-500/15 text-amber-300 border-amber-500/20",
	pairing: "bg-cyan-500/15 text-cyan-300 border-cyan-500/20",
};

function parseDetail(detail: string | null): string {
	if (!detail) return "";
	// Try to extract a useful summary from JSON detail
	try {
		const parsed = JSON.parse(detail);
		if (parsed.message) return parsed.message;
		if (parsed.command) return parsed.command;
		if (parsed.reason) return parsed.reason;
		if (parsed.model) return `Model: ${parsed.model}`;
		if (parsed.task) return parsed.task;
		return detail.length > 120 ? detail.slice(0, 120) + "..." : detail;
	} catch {
		return detail.length > 120 ? detail.slice(0, 120) + "..." : detail;
	}
}

const EntryRow = memo(function EntryRow({ entry }: { entry: AuditEntry }) {
	const cat = categorize(entry.event);
	const Icon = eventIcons[entry.event] ?? MessageSquare;
	const color = eventColors[cat] ?? "text-zinc-400";
	const badge = badgeColors[cat] ?? "bg-zinc-500/15 text-zinc-300 border-zinc-500/20";
	const detail = parseDetail(entry.detail);
	const eventLabel = entry.event.split(".").pop() ?? entry.event;

	return (
		<div className="flex items-start gap-3 border-b border-zinc-800/40 px-4 py-3 last:border-0 hover:bg-zinc-900/30 transition-colors">
			<div className={cn("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zinc-900", color)}>
				<Icon className="h-3.5 w-3.5" />
			</div>
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<Badge variant="outline" className={cn("text-[10px] capitalize", badge)}>
						{eventLabel}
					</Badge>
					{entry.agent && (
						<span className="flex items-center gap-1 text-xs text-[var(--nyx-accent)]">
							<Bot className="h-3 w-3" />
							{entry.agent}
						</span>
					)}
					{entry.channel && (
						<span className="text-[10px] text-zinc-600">{entry.channel}</span>
					)}
				</div>
				{detail && (
					<p className="mt-1 text-xs text-zinc-400 line-clamp-2">{detail}</p>
				)}
			</div>
			<span className="flex shrink-0 items-center gap-1 text-[11px] text-zinc-600">
				<ClockIcon className="h-3 w-3" />
				{formatRelativeTime(entry.timestamp)}
			</span>
		</div>
	);
});

export function ActivityFeedPage() {
	const { category, setCategory } = useActivityStore();
	const agentFilter = useActivityStore((s) => s.agentFilter);
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
	}, [category, agentFilter]);

	// Real-time: refetch on proposal/agent status changes
	const handleRealTimeUpdate = useCallback(
		(_frame: Frame) => {
			pag.fetch();
		},
		[pag],
	);
	useWsEvent("proposal:update", handleRealTimeUpdate);
	useWsEvent("agent:status", handleRealTimeUpdate);

	const stats = useMemo(() => {
		const now = Date.now();
		const lastHour = pag.items.filter((e) => now - e.timestamp < 3600000).length;
		const security = pag.items.filter((e) => e.event.startsWith("security.")).length;
		const failed = pag.items.filter((e) => e.event.endsWith(".failed") || e.event.endsWith(".blocked")).length;
		return { total: pag.items.length, lastHour, security, failed };
	}, [pag.items]);

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold">Activity</h1>
				<p className="mt-1 text-sm text-zinc-400">
					System-wide audit trail
				</p>
			</div>

			{/* Stats */}
			{!pag.loading && pag.items.length > 0 && (
				<div className="grid gap-3 sm:grid-cols-4">
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<Zap className="h-4 w-4 text-[var(--nyx-accent)]" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Total Events</p>
								<p className="text-lg font-semibold">{stats.total}</p>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<ClockIcon className="h-4 w-4 text-[var(--nyx-accent)]" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Last Hour</p>
								<p className="text-lg font-semibold">{stats.lastHour}</p>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<Shield className="h-4 w-4 text-red-400" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Security Events</p>
								<p className="text-lg font-semibold">{stats.security}</p>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardContent className="flex items-center gap-3 p-4">
							<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
								<AlertTriangle className="h-4 w-4 text-amber-400" />
							</div>
							<div>
								<p className="text-xs text-zinc-500">Failures/Blocked</p>
								<p className="text-lg font-semibold">{stats.failed}</p>
							</div>
						</CardContent>
					</Card>
				</div>
			)}

			{/* Category tabs */}
			<div className="flex gap-1 rounded-lg bg-zinc-900/50 p-1 w-fit">
				{categoryFilters.map((f) => (
					<button
						key={f.value}
						type="button"
						onClick={() => setCategory(f.value)}
						className={cn(
							"rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
							category === f.value
								? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)]"
								: "text-zinc-500 hover:text-zinc-300",
						)}
					>
						{f.label}
					</button>
				))}
			</div>

			{/* Entry list */}
			{pag.loading ? (
				<div className="space-y-2">
					{Array.from({ length: 8 }).map((_, i) => (
						<Skeleton key={i} className="h-16 rounded-xl" />
					))}
				</div>
			) : pag.items.length === 0 ? (
				<p className="py-12 text-center text-sm text-zinc-500">
					{category !== "all"
						? `No ${category} events found`
						: "No audit events yet. Events appear as the system processes messages and tasks."}
				</p>
			) : (
				<Card>
					<div className="divide-y divide-zinc-800/40">
						{pag.items.map((entry) => (
							<EntryRow key={entry.id} entry={entry} />
						))}
					</div>
				</Card>
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

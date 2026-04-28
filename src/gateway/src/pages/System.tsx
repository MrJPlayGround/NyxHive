import { useEffect, useState, useCallback } from "react";
import { useSystemStore } from "../stores/system";
import { useAuthStore } from "../stores/auth";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { formatUptime, formatBytes, formatDuration } from "../lib/format";
import { cn } from "../lib/utils";
import type { DoctorReport, Health, HealthCheck, WsMethodMetric } from "../lib/types";

/* ------------------------------------------------------------------ */
/*  Status helpers                                                     */
/* ------------------------------------------------------------------ */

const statusColor = {
	ok: "text-emerald-400",
	warn: "text-[var(--nyx-warn)]",
	error: "text-[var(--nyx-danger)]",
	degraded: "text-[var(--nyx-warn)]",
} as const;

const statusDot = {
	ok: "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.6)]",
	warn: "bg-[var(--nyx-warn)] shadow-[0_0_6px_var(--nyx-warn)]",
	error: "bg-[var(--nyx-danger)] shadow-[0_0_6px_var(--nyx-danger)]",
	degraded: "bg-[var(--nyx-warn)] shadow-[0_0_6px_var(--nyx-warn)]",
} as const;

const statusLabel = {
	ok: "Healthy",
	degraded: "Degraded",
	error: "Error",
} as const;

function StatusBadge({ status }: { status: "ok" | "degraded" | "error" }) {
	return (
		<div className={cn(
			"flex items-center gap-1.5 rounded-lg border px-3 py-1.5",
			status === "ok"
				? "border-emerald-500/20 bg-emerald-500/8"
				: status === "degraded"
					? "border-[var(--nyx-warn-dim)] bg-[var(--nyx-warn-dim)]"
					: "border-[var(--nyx-danger-dim)] bg-[var(--nyx-danger-dim)]",
		)}>
			<div className={cn("h-2 w-2 rounded-full", statusDot[status])} />
			<span className={cn("text-sm font-medium", statusColor[status])}>
				{statusLabel[status]}
			</span>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Stat tile                                                          */
/* ------------------------------------------------------------------ */

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
	return (
		<div className="rounded-xl border border-[var(--nyx-line)] bg-[var(--nyx-panel)] px-4 py-3 min-w-0">
			<div className="text-[11px] uppercase tracking-wider text-[var(--nyx-muted)] font-medium">{label}</div>
			<div className="text-xl font-semibold text-[var(--nyx-text)] truncate">{value}</div>
			{sub && <div className="text-xs text-[var(--nyx-muted)] mt-0.5 truncate">{sub}</div>}
		</div>
	);
}

function getAgentCount(data: Health | DoctorReport): number {
	return typeof data.agents === "number" ? data.agents : data.agents.count;
}

function getUptimeSeconds(data: Health | DoctorReport): number {
	return data.uptime_seconds ?? data.uptime ?? 0;
}

function getConnectionCount(data: Health | DoctorReport): number {
	return data.connections?.connected ?? data.activeConnections ?? 0;
}

function getMemoryUsage(data: Health | DoctorReport): number {
	if (typeof data.memoryUsage === "number") return data.memoryUsage;
	if (data.memory?.heap_used_mb !== undefined) return data.memory.heap_used_mb * 1024 * 1024;
	return 0;
}

function providerTone(status: string): string {
	if (status === "error") return "text-[var(--nyx-danger)]";
	if (status === "degraded" || status === "recovering") return "text-[var(--nyx-warn)]";
	return "text-emerald-400";
}

/* ------------------------------------------------------------------ */
/*  Checks list                                                        */
/* ------------------------------------------------------------------ */

function CheckRow({ check }: { check: HealthCheck }) {
	return (
		<div className="flex items-start gap-2.5 py-2 first:pt-0 last:pb-0">
			<div className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", statusDot[check.status])} />
			<div className="min-w-0">
				<div className="flex items-center gap-2">
					<span className="text-sm font-medium text-[var(--nyx-text)]">{check.label}</span>
					<span className={cn("text-xs", statusColor[check.status])}>{check.status}</span>
				</div>
				<div className="text-xs text-[var(--nyx-muted)]">{check.summary}</div>
			</div>
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  WS Methods table                                                   */
/* ------------------------------------------------------------------ */

function WsMethodsTable({ metrics }: { metrics: WsMethodMetric[] }) {
	const [open, setOpen] = useState(false);
	if (!metrics.length) return null;

	return (
		<div>
			<button
				type="button"
				onClick={() => setOpen(!open)}
				className="flex items-center gap-1.5 text-sm font-medium text-[var(--nyx-muted)] hover:text-[var(--nyx-text)] transition-colors"
			>
				<span className={cn("transition-transform text-xs", open && "rotate-90")}>&#9654;</span>
				WS Methods ({metrics.length})
			</button>
			{open && (
				<div className="mt-2 overflow-x-auto rounded-lg border border-[var(--nyx-line)]">
					<table className="w-full text-xs">
						<thead>
							<tr className="border-b border-[var(--nyx-line)] bg-[var(--nyx-panel-2)]">
								<th className="px-3 py-2 text-left font-medium text-[var(--nyx-muted)]">Method</th>
								<th className="px-3 py-2 text-right font-medium text-[var(--nyx-muted)]">Calls</th>
								<th className="px-3 py-2 text-right font-medium text-[var(--nyx-muted)]">Fails</th>
								<th className="px-3 py-2 text-right font-medium text-[var(--nyx-muted)]">Avg</th>
								<th className="px-3 py-2 text-right font-medium text-[var(--nyx-muted)]">Max</th>
								<th className="px-3 py-2 text-left font-medium text-[var(--nyx-muted)]">Last Error</th>
							</tr>
						</thead>
						<tbody>
							{metrics.map((m) => (
								<tr key={m.method} className="border-b border-[var(--nyx-line)] last:border-0">
									<td className="px-3 py-1.5 font-mono text-[var(--nyx-text)]">{m.method}</td>
									<td className="px-3 py-1.5 text-right text-[var(--nyx-text-secondary)]">{m.count}</td>
									<td className={cn("px-3 py-1.5 text-right", m.failures > 0 ? "text-[var(--nyx-danger)]" : "text-[var(--nyx-text-secondary)]")}>
										{m.failures}
									</td>
									<td className="px-3 py-1.5 text-right text-[var(--nyx-text-secondary)]">{formatDuration(m.avgMs)}</td>
									<td className="px-3 py-1.5 text-right text-[var(--nyx-text-secondary)]">{formatDuration(m.maxMs)}</td>
									<td className="px-3 py-1.5 text-[var(--nyx-muted)] truncate max-w-48">{m.lastError ?? "—"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

/* ------------------------------------------------------------------ */
/*  Main page                                                          */
/* ------------------------------------------------------------------ */

export function SystemPage() {
	const health = useSystemStore((s) => s.health);
	const doctor = useSystemStore((s) => s.doctor);
	const healthLoading = useSystemStore((s) => s.healthLoading);
	const doctorLoading = useSystemStore((s) => s.doctorLoading);
	const fetchHealth = useSystemStore((s) => s.fetchHealth);
	const fetchDoctor = useSystemStore((s) => s.fetchDoctor);
	const instanceName = useAuthStore((s) => s.instanceName) ?? "NyxHive";

	// Source: prefer doctor when available, fall back to health
	const data = doctor ?? health;
	const loading = healthLoading && !data;

	// Fetch health on mount + poll every 25s
	useEffect(() => {
		fetchHealth();
		const interval = setInterval(fetchHealth, 25_000);
		return () => clearInterval(interval);
	}, [fetchHealth]);

	// Fetch doctor on mount
	useEffect(() => {
		fetchDoctor();
	}, [fetchDoctor]);

	const handleRunDoctor = useCallback(() => {
		fetchDoctor();
	}, [fetchDoctor]);

	if (loading) {
		return (
			<div className="mx-auto max-w-6xl space-y-5">
				<Skeleton className="h-10 w-48 rounded-lg" />
				<div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
					{Array.from({ length: 5 }).map((_, i) => (
						<Skeleton key={i} className="h-20 rounded-xl" />
					))}
				</div>
				<Skeleton className="h-40 rounded-xl" />
			</div>
		);
	}

	if (!data) {
		return (
			<div className="mx-auto max-w-6xl">
				<p className="py-8 text-center text-sm text-zinc-500">
					Failed to load system health. Check server connection.
				</p>
			</div>
		);
	}

	const status = data.status ?? "ok";
	const checks = data.checks ?? [];
	const attentionChecks = checks.filter((c) => c.status !== "ok");
	const okChecks = checks.filter((c) => c.status === "ok");
	const warnings = data.warnings ?? [];
	const errors = data.errors ?? [];
	const queue = data.queue;
	const connections = data.connections;
	const providers = data.providers;
	const wsMetrics = (doctor?.wsMethods?.metrics as WsMethodMetric[] | undefined) ?? [];
	const uptimeSeconds = getUptimeSeconds(data);
	const agentCount = getAgentCount(data);
	const connectionCount = getConnectionCount(data);
	const memoryUsage = getMemoryUsage(data);

	return (
		<div className="mx-auto max-w-6xl space-y-5">
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<h1 className="text-xl font-bold text-[var(--nyx-text)]">System</h1>
					<StatusBadge status={status} />
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={handleRunDoctor}
					disabled={doctorLoading}
				>
					{doctorLoading ? "Running..." : "Run Doctor"}
				</Button>
			</div>

			{/* Overview tiles */}
			<div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
				<StatTile label="Instance" value={instanceName} sub={data.leadAgent ? `Lead: ${data.leadAgent}` : undefined} />
				<StatTile label="Uptime" value={formatUptime(uptimeSeconds)} />
				<StatTile label="Agents" value={String(agentCount)} />
				<StatTile label="Connections" value={String(connectionCount)} sub={connections ? `${connections.subscriptions} subs` : undefined} />
				<StatTile label="Memory" value={formatBytes(memoryUsage)} />
			</div>

			{/* Needs Attention */}
			{(attentionChecks.length > 0 || warnings.length > 0 || errors.length > 0) && (
				<Card>
					<CardHeader className="pb-3">
						<CardTitle className="text-sm text-[var(--nyx-warn)]">
							Needs Attention
							<span className="ml-2 text-xs font-normal text-[var(--nyx-muted)]">
								{attentionChecks.length + warnings.length + errors.length} issues
							</span>
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-1">
						{errors.map((msg, i) => (
							<div key={`e-${i}`} className="flex items-start gap-2.5 py-1.5">
								<div className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", statusDot.error)} />
								<span className="text-sm text-[var(--nyx-danger)]">{msg}</span>
							</div>
						))}
						{warnings.map((msg, i) => (
							<div key={`w-${i}`} className="flex items-start gap-2.5 py-1.5">
								<div className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", statusDot.warn)} />
								<span className="text-sm text-[var(--nyx-warn)]">{msg}</span>
							</div>
						))}
						{attentionChecks.map((c) => (
							<CheckRow key={c.id} check={c} />
						))}
					</CardContent>
				</Card>
			)}

			{/* Operations Detail */}
			<div className="grid gap-4 grid-cols-1 lg:grid-cols-2">
				{/* Queue */}
				{queue && (
					<Card>
						<CardHeader className="pb-3">
							<CardTitle className="text-sm text-[var(--nyx-muted)]">Queue</CardTitle>
						</CardHeader>
						<CardContent>
							<div className="grid grid-cols-3 gap-3 text-center">
								{([
									["Pending", queue.stats.pending],
									["Processing", queue.stats.processing],
									["Suspended", queue.stats.suspended],
									["Completed", queue.stats.completed],
									["Failed", queue.stats.failed, queue.stats.failed > 0],
									["Dead Letter", queue.stats.dead_letter, queue.stats.dead_letter > 0],
								] as [string, number, boolean?][]).map(([label, val, warn]) => (
									<div key={label}>
										<div className="text-[11px] uppercase tracking-wider text-[var(--nyx-muted)]">{label}</div>
										<div className={cn("text-lg font-semibold", warn ? "text-[var(--nyx-danger)]" : "text-[var(--nyx-text)]")}>
											{val}
										</div>
									</div>
								))}
							</div>
							{(queue.staleProcessing > 0 || queue.stalePending > 0 || queue.staleRunning > 0) && (
								<div className="mt-3 pt-3 border-t border-[var(--nyx-line)] text-xs text-[var(--nyx-warn)]">
									Stale: {queue.staleProcessing} processing, {queue.stalePending} pending, {queue.staleRunning} running
								</div>
							)}
							{queue.retryableDeadLetters > 0 && (
								<div className="mt-1 text-xs text-[var(--nyx-muted)]">
									{queue.retryableDeadLetters} retryable dead letters
								</div>
							)}
						</CardContent>
					</Card>
				)}

				{/* Providers */}
				{providers && Object.keys(providers).length > 0 && (
					<Card>
						<CardHeader className="pb-3">
							<CardTitle className="text-sm text-[var(--nyx-muted)]">Providers</CardTitle>
						</CardHeader>
						<CardContent>
							<div className="space-y-2">
								{Object.entries(providers).map(([name, status]) => (
									<div key={name} className="flex items-center justify-between">
										<span className="text-sm text-[var(--nyx-text)]">{name}</span>
										<span className={cn(
											"text-xs font-medium",
											providerTone(status),
										)}>
											{status}
										</span>
									</div>
								))}
							</div>
						</CardContent>
					</Card>
				)}

				{/* Connections */}
				{connections && (
					<Card>
						<CardHeader className="pb-3">
							<CardTitle className="text-sm text-[var(--nyx-muted)]">WebSocket</CardTitle>
						</CardHeader>
						<CardContent>
							<div className="grid grid-cols-2 gap-3 text-sm">
								<div>
									<span className="text-[var(--nyx-muted)]">Connected</span>
									<span className="ml-2 text-[var(--nyx-text)] font-medium">{connections.connected}</span>
								</div>
								<div>
									<span className="text-[var(--nyx-muted)]">Subscriptions</span>
									<span className="ml-2 text-[var(--nyx-text)] font-medium">{connections.subscriptions}</span>
								</div>
								<div>
									<span className="text-[var(--nyx-muted)]">Buffered</span>
									<span className="ml-2 text-[var(--nyx-text)] font-medium">{connections.bufferedMessages}</span>
								</div>
								<div>
									<span className="text-[var(--nyx-muted)]">Seq</span>
									<span className="ml-2 text-[var(--nyx-text)] font-medium">{connections.seq}</span>
								</div>
							</div>
						</CardContent>
					</Card>
				)}

				{/* All Checks */}
				{okChecks.length > 0 && (
					<Card>
						<CardHeader className="pb-3">
							<CardTitle className="text-sm text-[var(--nyx-muted)]">
								Passing Checks
								<span className="ml-2 text-xs font-normal text-emerald-400">{okChecks.length}</span>
							</CardTitle>
						</CardHeader>
						<CardContent className="space-y-1">
							{okChecks.map((c) => (
								<CheckRow key={c.id} check={c} />
							))}
						</CardContent>
					</Card>
				)}
			</div>

			{/* WS Methods — advanced collapsible */}
			{wsMetrics.length > 0 && (
				<WsMethodsTable metrics={wsMetrics} />
			)}
		</div>
	);
}

import { memo, useCallback, useEffect, useMemo } from "react";
import {
	useControlStore,
	type AuditChip,
	type AuditEntry,
	type CoreTask,
	type LogEntry,
	type LogLevel,
	type ParsedHttpAudit,
	type ProviderUsageModelRow,
	type ProviderUsageProviderRow,
	type TimeWindow,
} from "../stores/control";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { formatLogEntry, meetsMinLevel } from "../lib/log-display";
import { formatBytes, formatCost, formatDuration, formatRelativeTime, formatUptime } from "../lib/format";
import {
	Activity,
	AlertTriangle,
	Calendar,
	ChevronDown,
	ChevronRight,
	Clock,
	DollarSign,
	Globe,
	Hash,
	RefreshCw,
	ScrollText,
	Server,
	Shield,
	Terminal,
	Zap,
} from "lucide-react";

const CHIPS: Array<{ value: AuditChip; label: string }> = [
	{ value: "all", label: "All" },
	{ value: "message", label: "Messages" },
	{ value: "security", label: "Security" },
	{ value: "scheduler", label: "Scheduler" },
	{ value: "failures", label: "Failures" },
	{ value: "http", label: "HTTP" },
];

const WINDOWS: TimeWindow[] = ["15m", "1h", "24h", "7d"];

const PROVIDER_LABELS: Record<string, string> = {
	anthropic: "Anthropic",
	deepseek: "DeepSeek",
	google: "Google",
	meta: "Meta",
	"meta-llama": "Meta Llama",
	minimax: "MiniMax",
	mistralai: "Mistral",
	ollama: "Ollama",
	openai: "OpenAI",
	openrouter: "OpenRouter",
	qwen: "Qwen",
	"x-ai": "xAI",
	unknown: "Unknown",
};

const PROVIDER_MARKS: Record<string, { text: string; bg: string; fg: string }> = {
	anthropic: { text: "A", bg: "#f59e0b", fg: "#111827" },
	deepseek: { text: "D", bg: "#38bdf8", fg: "#082f49" },
	google: { text: "G", bg: "#22c55e", fg: "#052e16" },
	meta: { text: "M", bg: "#60a5fa", fg: "#082f49" },
	"meta-llama": { text: "L", bg: "#60a5fa", fg: "#082f49" },
	minimax: { text: "M", bg: "#f472b6", fg: "#500724" },
	mistralai: { text: "M", bg: "#facc15", fg: "#422006" },
	ollama: { text: "O", bg: "#e5e7eb", fg: "#111827" },
	openai: { text: "O", bg: "#10b981", fg: "#022c22" },
	openrouter: { text: "OR", bg: "#a78bfa", fg: "#2e1065" },
	qwen: { text: "Q", bg: "#2dd4bf", fg: "#042f2e" },
	"x-ai": { text: "X", bg: "#f8fafc", fg: "#020617" },
	unknown: { text: "?", bg: "#71717a", fg: "#18181b" },
};

function statusTone(status?: string): string {
	if (status === "ok") return "text-emerald-400";
	if (status === "degraded" || status === "warn") return "text-[var(--nyx-warn)]";
	if (status === "error") return "text-[var(--nyx-danger)]";
	return "text-[var(--nyx-muted)]";
}

function eventBadgeClass(event: string): string {
	if (event === "http.outbound") return "bg-cyan-500/15 text-cyan-300 border-cyan-500/20";
	if (event.startsWith("security.")) return "bg-red-500/15 text-red-300 border-red-500/20";
	if (event.startsWith("scheduler.")) return "bg-amber-500/15 text-amber-300 border-amber-500/20";
	if (event.startsWith("message.")) return "bg-emerald-500/15 text-emerald-300 border-emerald-500/20";
	return "bg-zinc-500/15 text-zinc-300 border-zinc-500/20";
}

function httpStatusTone(status?: number | null): string {
	if (!status) return "text-zinc-500";
	if (status < 300) return "text-emerald-400";
	if (status < 400) return "text-[var(--nyx-warn)]";
	return "text-[var(--nyx-danger)]";
}

function providerLabel(provider: string): string {
	return PROVIDER_LABELS[provider] ?? provider;
}

function providerInitial(provider: string): string {
	return providerLabel(provider).slice(0, 1).toUpperCase();
}

function providerImage(provider: string): string {
	const mark = PROVIDER_MARKS[provider] ?? {
		text: providerInitial(provider),
		bg: "#71717a",
		fg: "#18181b",
	};
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img"><rect width="64" height="64" rx="14" fill="${mark.bg}"/><text x="32" y="39" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${mark.text.length > 1 ? 20 : 30}" font-weight="700" fill="${mark.fg}">${mark.text}</text></svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function shortProviderModel(model: string): string {
	if (model.length <= 42) return model;
	const [prefix, rest] = model.split("/");
	if (prefix && rest) return `${prefix}/${rest.slice(0, 32)}...`;
	return `${model.slice(0, 39)}...`;
}

function detailSummary(entry: AuditEntry): string {
	if (!entry.detail) return "";
	try {
		const parsed = JSON.parse(entry.detail) as Record<string, unknown>;
		const value = parsed.message ?? parsed.task ?? parsed.reason ?? parsed.command ?? parsed.model;
		if (typeof value === "string") return value;
		return JSON.stringify(parsed).slice(0, 140);
	} catch {
		return entry.detail.length > 140 ? `${entry.detail.slice(0, 140)}...` : entry.detail;
	}
}

function asHttpParsed(parsed: AuditEntry["parsed"]): ParsedHttpAudit | null {
	if (!parsed || typeof parsed !== "object") return null;
	return parsed as ParsedHttpAudit;
}

function RuntimeStrip() {
	const health = useControlStore((s) => s.health);
	const summary = useControlStore((s) => s.summary);
	const schedulerCore = useControlStore((s) => s.schedulerCore);
	const loading = useControlStore((s) => s.loading);

	if (loading && !health && !summary) {
		return (
			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
				{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-xl" />)}
			</div>
		);
	}

	return (
		<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
			<Card>
				<CardContent className="flex items-center gap-3 p-4">
					<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
						<Server className={cn("h-4 w-4", statusTone(health?.status))} />
					</div>
					<div className="min-w-0">
						<p className="text-xs text-zinc-500">Gateway</p>
						<p className={cn("text-sm font-semibold capitalize", statusTone(health?.status))}>
							{health?.status ?? "unknown"}
						</p>
						<p className="text-[10px] text-zinc-600">up {formatUptime(health?.uptime_seconds ?? health?.uptime ?? 0)}</p>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardContent className="flex items-center gap-3 p-4">
					<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
						<ScrollText className="h-4 w-4 text-[var(--nyx-accent)]" />
					</div>
					<div className="min-w-0">
						<p className="text-xs text-zinc-500">Audit Events</p>
						<p className="text-sm font-semibold">{summary?.total ?? 0} recent</p>
						{summary?.latestTimestamp ? (
							<p className="text-[10px] text-zinc-600">last {formatRelativeTime(summary.latestTimestamp)}</p>
						) : null}
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardContent className="flex items-center gap-3 p-4">
					<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
						<Activity className="h-4 w-4 text-emerald-400" />
					</div>
					<div className="min-w-0">
						<p className="text-xs text-zinc-500">Runtime</p>
						<p className="text-sm font-semibold">{health?.agents ?? 0} agents</p>
						<p className="text-[10px] text-zinc-600">{formatBytes(health?.memoryUsage ?? 0)} heap</p>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardContent className="flex items-center gap-3 p-4">
					<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
						<Calendar className="h-4 w-4 text-[var(--nyx-warn)]" />
					</div>
					<div className="min-w-0">
						<p className="text-xs text-zinc-500">Core Tasks</p>
						<p className="text-sm font-semibold">{schedulerCore?.enabled_count ?? 0} enabled</p>
						<p className="text-[10px] text-zinc-600">{health?.queueDepth ?? 0} queued</p>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}

function AuditFilters() {
	const filters = useControlStore((s) => s.filters);
	const setFilter = useControlStore((s) => s.setFilter);
	const fetchAudit = useControlStore((s) => s.fetchAudit);
	const fetchSummary = useControlStore((s) => s.fetchSummary);
	const fetchProviderUsage = useControlStore((s) => s.fetchProviderUsage);
	const summary = useControlStore((s) => s.summary);
	const hasHttp = (summary?.http?.total ?? 0) > 0;

	const refetch = useCallback(() => {
		setTimeout(() => {
			fetchAudit();
			fetchSummary();
			fetchProviderUsage();
		}, 0);
	}, [fetchAudit, fetchProviderUsage, fetchSummary]);

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap gap-1">
				{CHIPS.map((chip) => {
					const dimmed = chip.value === "http" && !hasHttp && filters.chip !== "http";
					return (
						<button
							key={chip.value}
							type="button"
							onClick={() => {
								setFilter("chip", chip.value);
								refetch();
							}}
							className={cn(
								"rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
								filters.chip === chip.value
									? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)]"
									: dimmed
										? "text-zinc-700 hover:text-zinc-500"
										: "text-zinc-500 hover:bg-zinc-900/50 hover:text-zinc-300",
							)}
						>
							{chip.label}
						</button>
					);
				})}
			</div>

			<div className="flex flex-wrap items-center gap-2">
				<div className="flex gap-1 rounded-lg bg-zinc-900/50 p-0.5">
					{WINDOWS.map((window) => (
						<button
							key={window}
							type="button"
							onClick={() => {
								setFilter("timeWindow", window);
								refetch();
							}}
							className={cn(
								"rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
								filters.timeWindow === window
									? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)]"
									: "text-zinc-500 hover:text-zinc-300",
							)}
						>
							{window}
						</button>
					))}
				</div>

				<div className="w-40">
					<FilterInput icon={Hash} label="Search" value={filters.query} onChange={(value) => setFilter("query", value)} onEnter={fetchAudit} />
				</div>

				{filters.chip === "http" ? (
					<>
						<div className="w-28"><FilterInput icon={Globe} label="Host" value={filters.host} onChange={(value) => setFilter("host", value)} onEnter={fetchAudit} /></div>
						<div className="w-20"><FilterInput icon={Zap} label="Method" value={filters.method} onChange={(value) => setFilter("method", value)} onEnter={fetchAudit} /></div>
						<div className="w-16"><FilterInput icon={Shield} label="Status" value={filters.status} onChange={(value) => setFilter("status", value)} onEnter={fetchAudit} /></div>
						<div className="w-20"><FilterInput icon={Clock} label="Min ms" value={filters.minDurationMs} onChange={(value) => setFilter("minDurationMs", value)} onEnter={fetchAudit} /></div>
					</>
				) : null}
			</div>
		</div>
	);
}

function FilterInput({
	icon: Icon,
	label,
	value,
	onChange,
	onEnter,
}: {
	icon: typeof Hash;
	label: string;
	value: string;
	onChange: (value: string) => void;
	onEnter: () => void;
}) {
	return (
		<div className="relative">
			<Icon className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-600" />
			<input
				type="text"
				placeholder={label}
				value={value}
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") onEnter();
				}}
				className="h-8 w-full rounded-md border border-[var(--nyx-line)] bg-[var(--nyx-panel)] pl-8 pr-2 text-xs text-[var(--nyx-text)] placeholder:text-zinc-600 focus:border-[var(--nyx-accent)] focus:outline-none"
			/>
		</div>
	);
}

const AuditRow = memo(function AuditRow({ entry }: { entry: AuditEntry }) {
	const expandedId = useControlStore((s) => s.expandedEntryId);
	const setExpanded = useControlStore((s) => s.setExpandedEntry);
	const isExpanded = expandedId === entry.id;
	const parsed = entry.event === "http.outbound" ? asHttpParsed(entry.parsed) : null;
	const eventLabel = entry.event.split(".").pop() ?? entry.event;

	return (
		<div className="border-b border-zinc-800/40 last:border-0">
			<button
				type="button"
				onClick={() => parsed && setExpanded(isExpanded ? null : entry.id)}
				className="flex w-full items-center gap-2 px-4 py-2.5 text-left transition-colors hover:bg-zinc-900/30"
			>
				<span className="w-4 shrink-0 text-zinc-600">
					{parsed ? (isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />) : null}
				</span>
				<span className="w-16 shrink-0 text-[11px] text-zinc-600 tabular-nums">{formatRelativeTime(entry.timestamp)}</span>
				<Badge variant="outline" className={cn("shrink-0 text-[10px]", eventBadgeClass(entry.event))}>
					{eventLabel}
				</Badge>
				{parsed ? (
					<div className="flex min-w-0 flex-1 items-center gap-2">
						<span className="shrink-0 font-mono text-xs font-medium text-cyan-300">{parsed.method ?? "HTTP"}</span>
						<span className="truncate font-mono text-xs text-zinc-400">{parsed.host}{parsed.redactedPath ?? parsed.path ?? ""}</span>
						<span className={cn("shrink-0 font-mono text-xs", httpStatusTone(parsed.status))}>{parsed.status ?? "-"}</span>
						{parsed.durationMs != null ? <span className="shrink-0 text-[10px] text-zinc-600">{formatDuration(parsed.durationMs)}</span> : null}
					</div>
				) : (
					<div className="min-w-0 flex-1">
						<span className="text-xs text-zinc-500 line-clamp-1">
							{entry.agent ? `${entry.agent}: ` : ""}{detailSummary(entry)}
						</span>
					</div>
				)}
			</button>
			{isExpanded && parsed ? <HttpDetail entry={entry} parsed={parsed} /> : null}
		</div>
	);
});

function HttpDetail({ entry, parsed }: { entry: AuditEntry; parsed: ParsedHttpAudit }) {
	return (
		<div className="space-y-3 border-t border-zinc-800/40 bg-zinc-950/40 px-4 py-3">
			<div className="grid gap-3 md:grid-cols-2">
				<PayloadPreview title="Request" headers={parsed.request?.redactedHeaders} body={parsed.request?.redactedBodyPreview} hash={parsed.request?.bodyHash} />
				<PayloadPreview title="Response" headers={parsed.response?.redactedHeaders} body={parsed.response?.redactedBodyPreview} hash={parsed.response?.bodyHash} />
			</div>
			<div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-zinc-600">
				{parsed.caller ? <span>caller: <code className="text-zinc-500">{parsed.caller}</code></span> : null}
				{parsed.outcome ? <span>outcome: <code className="text-zinc-500">{parsed.outcome}</code></span> : null}
				{entry.detail ? <span>raw detail kept redacted by gateway</span> : null}
			</div>
		</div>
	);
}

function PayloadPreview({
	title,
	headers,
	body,
	hash,
}: {
	title: string;
	headers?: Record<string, string>;
	body?: string | null;
	hash?: string | null;
}) {
	return (
		<div className="space-y-2">
			<p className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">{title}</p>
			{headers ? (
				<pre className="max-h-28 overflow-auto rounded-md bg-zinc-900 p-2 text-[11px] leading-relaxed text-zinc-400">
					{Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join("\n")}
				</pre>
			) : null}
			{body ? (
				<pre className="max-h-32 overflow-auto rounded-md bg-zinc-900 p-2 text-[11px] leading-relaxed text-zinc-400">{body}</pre>
			) : null}
			{hash ? <p className="text-[10px] text-zinc-600">hash: <code className="text-zinc-500">{hash}</code></p> : null}
			{!headers && !body && !hash ? <p className="text-xs text-zinc-600">No preview captured.</p> : null}
		</div>
	);
}

function AuditExplorer() {
	const entries = useControlStore((s) => s.entries);
	const auditLoading = useControlStore((s) => s.auditLoading);

	return (
		<section className="space-y-4">
			<div className="flex items-center gap-2">
				<Shield className="h-5 w-5 text-[var(--nyx-accent)]" />
				<h2 className="text-lg font-semibold">Audit Explorer</h2>
			</div>
			<AuditFilters />
			{auditLoading ? (
				<div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-xl" />)}</div>
			) : entries.length === 0 ? (
				<Card><CardContent className="py-10 text-center text-sm text-zinc-500">No audit entries found for these filters.</CardContent></Card>
			) : (
				<Card>
					{entries.map((entry) => <AuditRow key={entry.id} entry={entry} />)}
				</Card>
			)}
		</section>
	);
}

const LOG_LEVELS: LogLevel[] = ["all", "debug", "info", "warn", "error"];

function logToneClass(tone: ReturnType<typeof formatLogEntry>["tone"], level: LogEntry["level"]): string {
	if (tone === "error" || level === "error") return "text-[var(--nyx-danger)]";
	if (tone === "warn" || level === "warn") return "text-[var(--nyx-warn)]";
	if (tone === "success") return "text-emerald-300";
	if (tone === "muted" || level === "debug") return "text-zinc-500";
	return "text-zinc-300";
}

const CompactLogRow = memo(function CompactLogRow({ entry, index }: { entry: LogEntry; index: number }) {
	const display = formatLogEntry(entry);

	return (
		<div className="rounded-md px-2 py-1.5 hover:bg-zinc-900/40">
			<div className="flex min-w-0 items-center gap-2">
				<span className="w-[4.5rem] shrink-0 text-zinc-600">{formatRelativeTime(entry.timestamp)}</span>
				<span className={cn("w-9 shrink-0 uppercase", logToneClass(display.tone, display.level))}>{display.level}</span>
				{display.module ? <span className="shrink-0 text-zinc-600">[{display.module}]</span> : null}
				<span className={cn("min-w-0 flex-1 truncate", logToneClass(display.tone, display.level))}>{display.title}</span>
			</div>
			{display.detail ? <p className="ml-[9.5rem] truncate text-[10px] text-zinc-600">{display.detail}</p> : null}
		</div>
	);
});

function LogTail() {
	const logs = useControlStore((s) => s.logs);
	const logsLoading = useControlStore((s) => s.logsLoading);
	const logLevel = useControlStore((s) => s.logLevel);
	const setLogLevel = useControlStore((s) => s.setLogLevel);

	const filtered = useMemo(() => {
		const recent = logs.slice(-80).reverse();
		return recent.filter((entry) => meetsMinLevel(entry, logLevel));
	}, [logs, logLevel]);

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between pb-3">
				<CardTitle className="flex items-center gap-2 text-sm text-[var(--nyx-muted)]">
					<Terminal className="h-4 w-4" />
					Recent Logs
				</CardTitle>
				<div className="flex gap-0.5 rounded-md bg-zinc-900/50 p-0.5">
					{LOG_LEVELS.map((lvl) => (
						<button
							key={lvl}
							type="button"
							onClick={() => setLogLevel(lvl)}
							className={cn(
								"rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
								logLevel === lvl
									? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)]"
									: "text-zinc-600 hover:text-zinc-400",
							)}
						>
							{lvl}
						</button>
					))}
				</div>
			</CardHeader>
			<CardContent>
				{logsLoading ? (
					<div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-7 rounded-lg" />)}</div>
				) : filtered.length === 0 ? (
					<p className="py-6 text-center text-sm text-zinc-500">No recent runtime logs captured yet.</p>
				) : (
					<div className="max-h-96 space-y-0.5 overflow-auto font-mono text-[11px]">
						{filtered.slice(0, 50).map((entry, index) => (
							<CompactLogRow key={entry.id ?? `${entry.timestamp}-${index}`} entry={entry} index={index} />
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
}

function ProviderLogo({ provider, className }: { provider: string; className?: string }) {
	const src = providerImage(provider);
	return (
		<div className={cn("relative flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950", className)}>
			<span className="text-xs font-semibold text-zinc-500">{providerInitial(provider)}</span>
			<img
				src={src}
				alt=""
				loading="lazy"
				className="absolute inset-1 h-6 w-6 rounded object-contain"
				onError={(event) => {
					event.currentTarget.style.display = "none";
				}}
			/>
		</div>
	);
}

function ProviderRow({ provider }: { provider: ProviderUsageProviderRow }) {
	return (
		<div className="flex items-center gap-3 border-b border-zinc-800/40 px-4 py-3 last:border-0">
			<ProviderLogo provider={provider.provider} />
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium text-[var(--nyx-text)]">{providerLabel(provider.provider)}</p>
				<p className="text-xs text-zinc-600">
					{provider.calls.toLocaleString()} calls · {provider.models} models
				</p>
			</div>
			<div className="shrink-0 text-right">
				<p className="text-sm font-semibold text-emerald-300">{formatCost(provider.totalCostCents)}</p>
				<p className={cn("text-[10px]", provider.failures > 0 ? "text-[var(--nyx-danger)]" : "text-zinc-600")}>
					{provider.failures.toLocaleString()} errors
				</p>
			</div>
		</div>
	);
}

function ProviderModelRow({ row }: { row: ProviderUsageModelRow }) {
	return (
		<div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-zinc-900/40">
			<ProviderLogo provider={row.provider} className="h-7 w-7" />
			<div className="min-w-0 flex-1">
				<p className="truncate font-mono text-xs text-zinc-300">{shortProviderModel(row.model)}</p>
				<p className="truncate text-[10px] text-zinc-600">
					{row.taskTypes.slice(0, 3).join(", ") || "tasks"} · {formatDuration(row.avgDurationMs)} avg
				</p>
			</div>
			<div className="shrink-0 text-right">
				<p className="text-xs font-medium text-zinc-300">{row.calls.toLocaleString()}</p>
				<p className="text-[10px] text-zinc-600">{formatCost(row.totalCostCents)}</p>
			</div>
		</div>
	);
}

function ProviderUsage() {
	const providerUsage = useControlStore((s) => s.providerUsage);
	const loading = useControlStore((s) => s.providerUsageLoading);

	return (
		<Card>
			<CardHeader className="flex flex-row items-center justify-between pb-3">
				<CardTitle className="flex items-center gap-2 text-sm text-[var(--nyx-muted)]">
					<DollarSign className="h-4 w-4 text-emerald-400" />
					AI Provider Usage
				</CardTitle>
				<Badge variant="outline" className="text-[10px] text-zinc-500 border-zinc-700">
					{providerUsage?.periodHours ?? 1}h
				</Badge>
			</CardHeader>
			<CardContent className="space-y-4">
				{loading && !providerUsage ? (
					<div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
				) : !providerUsage || providerUsage.totalCalls === 0 ? (
					<p className="py-4 text-center text-sm text-zinc-500">No provider usage recorded for this window.</p>
				) : (
					<>
						<div className="grid grid-cols-3 gap-2">
							<div className="rounded-lg border border-[var(--nyx-line)] bg-zinc-950/30 p-3">
								<p className="text-[10px] uppercase text-zinc-600">Spend</p>
								<p className="mt-1 text-sm font-semibold text-emerald-300">{formatCost(providerUsage.totalCostCents)}</p>
							</div>
							<div className="rounded-lg border border-[var(--nyx-line)] bg-zinc-950/30 p-3">
								<p className="text-[10px] uppercase text-zinc-600">Calls</p>
								<p className="mt-1 text-sm font-semibold">{providerUsage.totalCalls.toLocaleString()}</p>
							</div>
							<div className="rounded-lg border border-[var(--nyx-line)] bg-zinc-950/30 p-3">
								<p className="text-[10px] uppercase text-zinc-600">Errors</p>
								<p className={cn("mt-1 text-sm font-semibold", providerUsage.totalFailures > 0 ? "text-[var(--nyx-danger)]" : "text-zinc-300")}>
									{providerUsage.totalFailures.toLocaleString()}
								</p>
							</div>
						</div>

						<div className="overflow-hidden rounded-lg border border-[var(--nyx-line)]">
							{providerUsage.providers.slice(0, 4).map((provider) => <ProviderRow key={provider.provider} provider={provider} />)}
						</div>

						<div className="space-y-1">
							<div className="flex items-center justify-between px-2 text-[10px] uppercase text-zinc-600">
								<span>Top models</span>
								<span>calls / spend</span>
							</div>
							{providerUsage.models.slice(0, 6).map((row) => <ProviderModelRow key={`${row.provider}:${row.model}`} row={row} />)}
						</div>
					</>
				)}
			</CardContent>
		</Card>
	);
}

function CoreTaskRow({ task }: { task: CoreTask }) {
	return (
		<div className="flex items-center gap-3 border-b border-zinc-800/40 px-4 py-3 last:border-0">
			<div className={cn("h-2 w-2 rounded-full", task.enabled ? "bg-emerald-400" : "bg-zinc-600")} />
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium text-[var(--nyx-text)]">{task.name}</p>
				<p className="truncate text-xs text-zinc-600">
					last {task.last_status ?? "never"} · runs {task.run_count ?? 0}
				</p>
			</div>
			{(task.consecutive_failures ?? 0) > 0 ? (
				<Badge variant="outline" className="text-[10px] text-[var(--nyx-danger)] border-[var(--nyx-danger-dim)]">
					{task.consecutive_failures} failures
				</Badge>
			) : null}
		</div>
	);
}

function CoreAutomation() {
	const schedulerCore = useControlStore((s) => s.schedulerCore);
	const tasks = schedulerCore?.core_tasks ?? [];
	const paused = schedulerCore?.paused_automation_families ?? [];

	return (
		<Card>
			<CardHeader className="pb-3">
				<CardTitle className="flex items-center gap-2 text-sm text-[var(--nyx-muted)]">
					<Calendar className="h-4 w-4" />
					Core Automation
				</CardTitle>
			</CardHeader>
			<CardContent className="space-y-3">
				{tasks.length > 0 ? (
					<div className="rounded-lg border border-[var(--nyx-line)]">
						{tasks.map((task) => <CoreTaskRow key={task.id ?? task.name} task={task} />)}
					</div>
				) : (
					<p className="py-4 text-center text-sm text-zinc-500">No core task summary available.</p>
				)}
				{paused.length > 0 ? (
					<div className="flex flex-wrap gap-2">
						{paused.map((family) => (
							<Badge key={family} variant="outline" className="text-[10px] text-zinc-500 border-zinc-700">
								{family}
							</Badge>
						))}
					</div>
				) : null}
			</CardContent>
		</Card>
	);
}

export function ControlStationPage() {
	const fetchAll = useControlStore((s) => s.fetchAll);
	const fetchAudit = useControlStore((s) => s.fetchAudit);
	const fetchSummary = useControlStore((s) => s.fetchSummary);
	const fetchLogs = useControlStore((s) => s.fetchLogs);
	const fetchProviderUsage = useControlStore((s) => s.fetchProviderUsage);
	const loading = useControlStore((s) => s.loading);
	const summary = useControlStore((s) => s.summary);
	const topEvents = useMemo(() => Object.entries(summary?.byEvent ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 6), [summary]);

	useEffect(() => {
		fetchAll();
		const interval = setInterval(() => {
			fetchAudit();
			fetchSummary();
			fetchLogs();
			fetchProviderUsage();
		}, 15_000);
		return () => clearInterval(interval);
	}, [fetchAll, fetchAudit, fetchLogs, fetchProviderUsage, fetchSummary]);

	return (
		<div className="mx-auto max-w-7xl space-y-5">
			<div className="flex items-center justify-between gap-3">
				<div>
					<h1 className="text-xl font-bold text-[var(--nyx-text)]">Control</h1>
					<p className="text-sm text-zinc-500">Runtime logs and audit trail for operator checks.</p>
				</div>
				<Button variant="outline" size="sm" onClick={fetchAll} disabled={loading}>
					<RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
					Refresh
				</Button>
			</div>

			<RuntimeStrip />

			{topEvents.length > 0 ? (
				<div className="flex flex-wrap gap-2">
					{topEvents.map(([event, count]) => (
						<Badge key={event} variant="outline" className={cn("text-[10px]", eventBadgeClass(event))}>
							{event}: {count}
						</Badge>
					))}
					{(summary?.http?.errors ?? 0) > 0 ? (
						<Badge variant="outline" className="text-[10px] text-[var(--nyx-danger)] border-[var(--nyx-danger-dim)]">
							<AlertTriangle className="mr-1 h-3 w-3" />
							HTTP errors: {summary?.http?.errors}
						</Badge>
					) : null}
				</div>
			) : null}

			<div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.8fr)]">
				<AuditExplorer />
				<div className="space-y-5">
					<LogTail />
					<ProviderUsage />
					<CoreAutomation />
				</div>
			</div>
		</div>
	);
}

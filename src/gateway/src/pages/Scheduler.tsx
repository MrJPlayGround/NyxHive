import { useEffect, useState, useRef, useCallback } from "react";
import {
	Play,
	Clock,
	Cog,
	Search,
	FileText,
	AlertTriangle,
	CheckCircle2,
	XCircle,
	ChevronDown,
	ChevronRight,
	Zap,
	Calendar,
	Timer,
	Pencil,
	Loader2,
	BrainCircuit,
} from "lucide-react";
import { useSchedulerStore, type Job } from "../stores/scheduler";
import { useWsEvent } from "../hooks/useWs";
import { Button } from "../components/ui/button";
import { Skeleton } from "../components/ui/skeleton";

// ── Category config ──────────────────────────────────────────────

const categoryConfig: Record<
	string,
	{ label: string; icon: typeof Cog; accent: string; bg: string; border: string; dot: string }
> = {
	heartbeat: {
		label: "Heartbeat",
		icon: Zap,
		accent: "text-rose-400",
		bg: "bg-rose-500/5",
		border: "border-rose-500/20",
		dot: "bg-rose-400",
	},
	ops: {
		label: "Operations",
		icon: Cog,
		accent: "text-[var(--nyx-accent)]",
		bg: "bg-[var(--nyx-accent-dim)]",
		border: "border-[rgb(var(--nyx-accent-rgb)/0.20)]",
		dot: "bg-[var(--nyx-accent)]",
	},
	discovery: {
		label: "Discovery",
		icon: Search,
		accent: "text-[var(--nyx-accent)]",
		bg: "bg-[rgb(var(--nyx-accent-rgb)/0.05)]",
		border: "border-[rgb(var(--nyx-accent-rgb)/0.15)]",
		dot: "bg-[var(--nyx-accent)]",
	},
	briefing: {
		label: "Briefing",
		icon: FileText,
		accent: "text-amber-400",
		bg: "bg-amber-500/5",
		border: "border-amber-500/20",
		dot: "bg-amber-400",
	},
	evolution: {
		label: "Evolution",
		icon: BrainCircuit,
		accent: "text-violet-400",
		bg: "bg-violet-500/5",
		border: "border-violet-500/20",
		dot: "bg-violet-400",
	},
};

function getCategoryConfig(category: string) {
	return categoryConfig[category] ?? categoryConfig.ops;
}

// ── Helpers ──────────────────────────────────────────────────────

function cronToHuman(cron: string): string {
	const parts = cron.split(" ");
	if (parts.length !== 5) return cron;
	const [min, hour, dom, _mon, dow] = parts;

	// Every N minutes
	if (min.startsWith("*/") && hour === "*" && dom === "*" && dow === "*") {
		return `Every ${min.slice(2)}m`;
	}
	// Every N hours
	if (hour.startsWith("*/") && dom === "*" && dow === "*") {
		return `Every ${hour.slice(2)}h`;
	}
	// Hourly at a fixed minute
	if (hour === "*" && dom === "*" && dow === "*" && !min.startsWith("*/")) {
		return min === "0" ? "Hourly" : `Hourly at :${min.padStart(2, "0")}`;
	}
	// Daily at time
	if (dom === "*" && dow === "*" && hour !== "*" && !hour.startsWith("*/") && !min.startsWith("*/")) {
		return `Daily at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
	}
	// Specific weekdays
	if (dom === "*" && dow !== "*") {
		const dayMap: Record<string, string> = {
			"0": "Sun",
			"1": "Mon",
			"2": "Tue",
			"3": "Wed",
			"4": "Thu",
			"5": "Fri",
			"6": "Sat",
		};
		const days = dow.split(",").map((d) => dayMap[d] ?? d).join(", ");
		return `${days} at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
	}
	return cron;
}

function formatRelative(ts: number | null): string {
	if (!ts) return "";
	const diff = ts - Date.now();
	const absDiff = Math.abs(diff);
	if (absDiff < 60_000) return "just now";
	if (absDiff < 3_600_000) return `${Math.round(absDiff / 60_000)}m ${diff > 0 ? "from now" : "ago"}`;
	if (absDiff < 86_400_000) return `${Math.round(absDiff / 3_600_000)}h ${diff > 0 ? "from now" : "ago"}`;
	return `${Math.round(absDiff / 86_400_000)}d ${diff > 0 ? "from now" : "ago"}`;
}

function shortName(name: string): string {
	const parts = name.split(":");
	return parts.length > 1 ? parts[1] : name;
}

function getFrequencyBadge(cron: string): { label: string; color: string } | null {
	const parts = cron.split(" ");
	if (parts.length !== 5) return null;
	const [min, hour, dom, _mon, dow] = parts;

	if (min.startsWith("*/") && hour === "*") return { label: "frequent", color: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" };
	if ((hour.startsWith("*/") || hour === "*") && dom === "*") return { label: "hourly", color: "text-sky-400 bg-sky-500/10 border-sky-500/20" };
	if (dom === "*" && dow === "*" && hour !== "*" && !hour.startsWith("*/")) return { label: "daily", color: "text-amber-400 bg-amber-500/10 border-amber-500/20" };
	if (dow !== "*" && dom === "*") return { label: "weekly", color: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20" };
	return null;
}

// ── Status indicator ─────────────────────────────────────────────

function StatusIndicator({ status, failures, running }: { status: string | null; failures: number; running?: boolean }) {
	if (running)
		return (
			<div className="flex items-center gap-1.5 text-xs text-[var(--nyx-accent)]">
				<Loader2 className="h-3.5 w-3.5 animate-spin" />
				<span>Running</span>
			</div>
		);
	if (failures > 0)
		return (
			<div className="flex items-center gap-1.5 text-xs text-red-400">
				<XCircle className="h-3.5 w-3.5" />
				<span>{failures} failures</span>
			</div>
		);
	if (status === "completed")
		return (
			<div className="flex items-center gap-1.5 text-xs text-emerald-400">
				<CheckCircle2 className="h-3.5 w-3.5" />
				<span>Healthy</span>
			</div>
		);
	if (status === "failed")
		return (
			<div className="flex items-center gap-1.5 text-xs text-red-400">
				<XCircle className="h-3.5 w-3.5" />
				<span>Failed</span>
			</div>
		);
	return (
		<div className="flex items-center gap-1.5 text-xs text-zinc-500">
			<Clock className="h-3.5 w-3.5" />
			<span>Pending</span>
		</div>
	);
}

// ── Job card ─────────────────────────────────────────────────────

function CronEditor({ job, accent }: { job: Job; accent: string }) {
	const { updateJob } = useSchedulerStore();
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(job.schedule);
	const inputRef = useRef<HTMLInputElement>(null);

	const save = () => {
		const trimmed = value.trim();
		if (trimmed && trimmed !== job.schedule) {
			updateJob(job.id, { schedule: trimmed });
		} else {
			setValue(job.schedule);
		}
		setEditing(false);
	};

	if (editing) {
		return (
			<input
				ref={inputRef}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onBlur={save}
				onKeyDown={(e) => {
					if (e.key === "Enter") save();
					if (e.key === "Escape") { setValue(job.schedule); setEditing(false); }
				}}
				className="text-[11px] font-mono bg-zinc-800 border border-zinc-600 rounded px-1.5 py-0.5 text-zinc-100 outline-none focus:border-[var(--nyx-accent)] w-32"
				autoFocus
			/>
		);
	}

	return (
		<button
			onClick={() => { setValue(job.schedule); setEditing(true); }}
			className={`text-[11px] font-mono ${accent} hover:underline cursor-pointer flex items-center gap-1 group/cron`}
			title={`Edit cron: ${job.schedule}`}
		>
			{cronToHuman(job.schedule)}
			<Pencil className="h-2.5 w-2.5 opacity-0 group-hover/cron:opacity-60 transition-opacity" />
		</button>
	);
}

function JobCard({ job }: { job: Job }) {
	const { toggleJob, runJob, runningJobs } = useSchedulerStore();
	const [showResult, setShowResult] = useState(false);
	const cat = getCategoryConfig(job.category);
	const freq = getFrequencyBadge(job.schedule);
	const isRunning = runningJobs.has(job.id);
	const hasResult = !!(job.lastResult || job.lastError);

	return (
		<div
			className={`group relative rounded-xl border transition-all ${
				isRunning
					? `border-[rgb(var(--nyx-accent-rgb)/0.30)] ${cat.bg} ring-1 ring-[rgb(var(--nyx-accent-rgb)/0.15)]`
					: job.enabled
						? `${cat.border} ${cat.bg} hover:border-opacity-50`
						: "border-zinc-800/40 bg-zinc-900/20 opacity-50"
			}`}
		>
			{/* Colored accent bar on the left */}
			<div className={`absolute left-0 top-3 bottom-3 w-0.5 rounded-full ${cat.dot} ${job.enabled ? "opacity-100" : "opacity-30"}`} />

			<div className="px-5 py-3.5">
				<div className="flex items-start justify-between gap-4">
					<div className="flex-1 min-w-0">
						{/* Header row */}
						<div className="flex items-center gap-2.5">
							<span className="font-medium text-sm text-zinc-100 truncate">
								{shortName(job.name)}
							</span>
							<span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${cat.accent} ${cat.bg} ${cat.border}`}>
								{job.agent}
							</span>
							{freq && (
								<span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${freq.color}`}>
									{freq.label}
								</span>
							)}
						</div>

						{/* Description */}
						<p className="text-xs text-zinc-400 mt-1 line-clamp-1">{job.description}</p>

						{/* Meta row */}
						<div className="flex items-center gap-4 mt-2">
							<CronEditor job={job} accent={cat.accent} />
							<StatusIndicator status={job.lastStatus} failures={job.consecutiveFailures} running={isRunning} />
							{job.lastRun && (
								<span className="text-[11px] text-zinc-500">
									<Timer className="h-3 w-3 inline mr-0.5 -mt-px" />
									{formatRelative(job.lastRun)}
								</span>
							)}
							{job.nextRun && job.enabled && (
								<span className="text-[11px] text-zinc-500">
									<Calendar className="h-3 w-3 inline mr-0.5 -mt-px" />
									{formatRelative(job.nextRun)}
								</span>
							)}
							{job.runCount > 0 && (
								<span className="text-[11px] text-zinc-600">{job.runCount} runs</span>
							)}
							{hasResult && (
								<button
									onClick={() => setShowResult(!showResult)}
									className="text-[11px] text-zinc-500 hover:text-zinc-300 flex items-center gap-0.5 transition-colors"
								>
									<FileText className="h-3 w-3" />
									{showResult ? "Hide" : "Result"}
								</button>
							)}
						</div>
					</div>

					{/* Actions */}
					<div className="flex items-center gap-2 shrink-0 pt-0.5">
						{isRunning ? (
							<div className="h-7 px-2 flex items-center gap-1.5 text-xs text-[var(--nyx-accent)]">
								<Loader2 className="h-3 w-3 animate-spin" />
								Running
							</div>
						) : (
							<Button
								size="sm"
								variant="ghost"
								className="h-7 px-2 text-xs text-zinc-500 hover:text-zinc-200 opacity-0 group-hover:opacity-100 transition-opacity"
								onClick={() => runJob(job.id)}
							>
								<Play className="h-3 w-3 mr-1" />
								Run
							</Button>
						)}
						<button
							onClick={() => toggleJob(job.id, !job.enabled)}
							aria-label={`${job.enabled ? "Disable" : "Enable"} ${shortName(job.name)}`}
							className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--nyx-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--nyx-bg)] ${
								job.enabled ? "bg-emerald-600" : "bg-zinc-700"
							}`}
						>
							<span
								className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
									job.enabled ? "translate-x-4" : "translate-x-1"
								}`}
							/>
						</button>
					</div>
				</div>

				{/* Expandable result panel */}
				{showResult && hasResult && (
					<div className="mt-3 pt-3 border-t border-zinc-800/50">
						{job.lastError && (
							<div className="mb-2 text-xs text-red-400 bg-red-500/5 border border-red-500/20 rounded-lg p-3">
								<span className="font-medium">Error:</span> {job.lastError}
							</div>
						)}
						{job.lastResult && (
							<pre className="text-xs text-zinc-300 bg-zinc-900/80 border border-zinc-800/50 rounded-lg p-3 whitespace-pre-wrap break-words max-h-80 overflow-y-auto leading-relaxed">
								{job.lastResult}
							</pre>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

// ── Category section ─────────────────────────────────────────────

function CategorySection({ category, jobs }: { category: string; jobs: Job[] }) {
	const [expanded, setExpanded] = useState(true);
	const config = getCategoryConfig(category);
	const Icon = config.icon;
	const activeCount = jobs.filter((j) => j.enabled).length;
	const failingCount = jobs.filter((j) => j.consecutiveFailures > 0).length;

	return (
		<div>
			<button
				onClick={() => setExpanded(!expanded)}
				className="flex items-center gap-2.5 mb-3 w-full text-left group/header"
			>
				{expanded ? (
					<ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
				) : (
					<ChevronRight className="h-3.5 w-3.5 text-zinc-500" />
				)}
				<div className={`flex items-center gap-1.5 ${config.accent}`}>
					<Icon className="h-4 w-4" />
					<span className="text-sm font-semibold">{config.label}</span>
				</div>
				<div className="flex items-center gap-2 ml-1">
					<span className="text-[11px] text-zinc-500">
						{activeCount}/{jobs.length} active
					</span>
					{failingCount > 0 && (
						<span className="text-[11px] text-red-400 flex items-center gap-1">
							<AlertTriangle className="h-3 w-3" />
							{failingCount}
						</span>
					)}
				</div>
			</button>

			{expanded && (
				<div className="space-y-2 ml-6">
					{jobs.map((job) => (
						<JobCard key={job.id} job={job} />
					))}
				</div>
			)}
		</div>
	);
}

// ── Main page ────────────────────────────────────────────────────

export function SchedulerPage() {
	const { jobs, loading, fetchJobs, runningJobs } = useSchedulerStore();

	useEffect(() => {
		fetchJobs();
	}, [fetchJobs]);

	const { markRunning, markStopped } = useSchedulerStore();

	// Track running state from WS events
	// SSE events arrive wrapped: payload = { type, data: {...}, timestamp }
	const unwrap = (frame: { payload?: Record<string, unknown> }) => {
		const p = frame.payload;
		return (p?.data ?? p) as Record<string, string | undefined>;
	};

	const handleStarted = useCallback((frame: { payload?: Record<string, unknown> }) => {
		const id = unwrap(frame).task_id;
		if (id) markRunning(id);
	}, [markRunning]);

	const handleCompleted = useCallback((frame: { payload?: Record<string, unknown> }) => {
		const id = unwrap(frame).task_id;
		if (id) markStopped(id);
		fetchJobs(); // Refresh stats (lastRun, status, etc.)
	}, [markStopped, fetchJobs]);

	useWsEvent("scan:started", handleStarted);
	useWsEvent("scan:completed", handleCompleted);

	if (loading) {
		return (
			<div className="space-y-3">
				{Array.from({ length: 4 }).map((_, i) => (
					<Skeleton key={i} className="h-20 rounded-xl" />
				))}
			</div>
		);
	}

	if (jobs.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-16 text-center">
				<Zap className="h-8 w-8 text-zinc-600 mb-3" />
				<p className="text-sm text-zinc-400">No scheduled automations</p>
				<p className="text-xs text-zinc-600 mt-1">Jobs defined in nyxhive.toml will appear here</p>
			</div>
		);
	}

	// Group by category
	const groups = new Map<string, Job[]>();
	for (const job of jobs) {
		const cat = job.category || "ops";
		if (!groups.has(cat)) groups.set(cat, []);
		groups.get(cat)!.push(job);
	}

	const order = ["heartbeat", "evolution", "ops", "discovery", "briefing"];
	const sortedCategories = [...groups.keys()].sort((a, b) => {
		const ai = order.indexOf(a);
		const bi = order.indexOf(b);
		return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
	});

	// Stats
	const enabled = jobs.filter((j) => j.enabled).length;
	const failing = jobs.filter((j) => j.consecutiveFailures > 0).length;
	const running = runningJobs.size;

	return (
		<div className="space-y-8">
			{/* Summary stats */}
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-4 py-3">
					<div className="text-2xl font-semibold text-zinc-100">{jobs.length}</div>
					<div className="text-xs text-zinc-500 mt-0.5">Total Jobs</div>
				</div>
				<div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
					<div className="text-2xl font-semibold text-emerald-400">{enabled}</div>
					<div className="text-xs text-zinc-500 mt-0.5">Active</div>
				</div>
				<div className={`rounded-lg border px-4 py-3 ${running > 0 ? "border-[rgb(var(--nyx-accent-rgb)/0.15)] bg-[rgb(var(--nyx-accent-rgb)/0.05)]" : "border-zinc-800 bg-zinc-900/50"}`}>
					<div className={`text-2xl font-semibold flex items-center gap-2 ${running > 0 ? "text-[var(--nyx-accent)]" : "text-zinc-400"}`}>
						{running}
						{running > 0 && <Loader2 className="h-4 w-4 animate-spin" />}
					</div>
					<div className="text-xs text-zinc-500 mt-0.5">Running</div>
				</div>
				<div className={`rounded-lg border px-4 py-3 ${failing > 0 ? "border-red-500/20 bg-red-500/5" : "border-zinc-800 bg-zinc-900/50"}`}>
					<div className={`text-2xl font-semibold ${failing > 0 ? "text-red-400" : "text-zinc-400"}`}>{failing}</div>
					<div className="text-xs text-zinc-500 mt-0.5">Failing</div>
				</div>
			</div>

			{/* Category sections */}
			{sortedCategories.map((cat) => (
				<CategorySection key={cat} category={cat} jobs={groups.get(cat)!} />
			))}
		</div>
	);
}

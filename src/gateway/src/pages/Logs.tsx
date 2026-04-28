import { useEffect, useCallback, useRef, memo } from "react";
import { Pause, Play, Trash2, Download } from "lucide-react";
import { useLogsStore, type LogEntry } from "../stores/logs";
import { useAuthStore } from "../stores/auth";
import { useWsEvent } from "../hooks/useWs";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { cn } from "../lib/utils";
import { formatLogEntry, logMatchesSearch } from "../lib/log-display";
import type { Frame } from "../../protocol/frame";

const LogLine = memo(function LogLine({ entry }: { entry: LogEntry }) {
	const time = new Date(entry.timestamp).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const display = formatLogEntry(entry);

	return (
		<div className="group rounded-md border border-transparent px-3 py-2 hover:border-[var(--nyx-line)] hover:bg-zinc-900/40">
			<div className="flex min-w-0 items-start gap-3">
				<span className="mt-0.5 w-20 shrink-0 font-mono text-[11px] text-zinc-600">{time}</span>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<span className={cn("rounded px-1.5 py-0.5 font-mono text-[10px] uppercase", levelPillClass(display.level, display.tone))}>
							{display.level}
						</span>
						{display.module ? <span className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">{display.module}</span> : null}
						<span className={cn("min-w-0 truncate text-sm", titleToneClass(display.tone))}>{display.title}</span>
						{display.chips.map((chip) => (
							<span key={chip} className="rounded border border-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
								{chip}
							</span>
						))}
					</div>
					{display.detail ? <p className="mt-1 truncate font-mono text-[11px] text-zinc-500">{display.detail}</p> : null}
					<details className="mt-1">
						<summary className="cursor-pointer text-[10px] text-zinc-700 hover:text-zinc-500">raw</summary>
						<pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed text-zinc-500">
							{display.raw}
						</pre>
					</details>
				</div>
			</div>
		</div>
	);
});

function levelPillClass(level: LogEntry["level"], tone: ReturnType<typeof formatLogEntry>["tone"]): string {
	if (level === "error" || tone === "error") return "bg-red-500/10 text-[var(--nyx-danger)]";
	if (level === "warn" || tone === "warn") return "bg-amber-500/10 text-[var(--nyx-warn)]";
	if (tone === "success") return "bg-emerald-500/10 text-emerald-300";
	if (level === "debug" || tone === "muted") return "bg-zinc-900 text-zinc-500";
	return "bg-[rgb(var(--nyx-accent-rgb)/0.10)] text-[var(--nyx-accent)]";
}

function titleToneClass(tone: ReturnType<typeof formatLogEntry>["tone"]): string {
	if (tone === "error") return "text-[var(--nyx-danger)]";
	if (tone === "warn") return "text-[var(--nyx-warn)]";
	if (tone === "success") return "text-emerald-300";
	if (tone === "muted") return "text-zinc-500";
	return "text-zinc-300";
}

export function LogsPage() {
	const {
		entries,
		subscribed,
		paused,
		filters,
		subscribe,
		unsubscribe,
		addEntry,
		togglePause,
		setFilter,
		clearLogs,
		exportLogs,
	} = useLogsStore();

	const authenticated = useAuthStore((s) => s.authenticated);
	const bottomRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!authenticated) return;
		subscribe();
		return () => {
			unsubscribe();
		};
	}, [authenticated, subscribe, unsubscribe]);

	const handleLogEntry = useCallback(
		(frame: Frame) => {
			addEntry(frame.payload as LogEntry);
		},
		[addEntry],
	);

	useWsEvent("log:entry", handleLogEntry);

	useEffect(() => {
		if (!paused) {
			bottomRef.current?.scrollIntoView({ behavior: "smooth" });
		}
	}, [entries.length, paused]);

	const filtered = entries.filter((e) => {
		const displayLevel = formatLogEntry(e).level;
		if (filters.level && displayLevel !== filters.level) return false;
		if (filters.agent && e.agent !== filters.agent) return false;
		if (filters.search && !logMatchesSearch(e, filters.search)) return false;
		return true;
	});

	return (
		<div className="flex h-full flex-col">
			<div className="flex items-center gap-2 border-b border-zinc-800 pb-3">
				<span className={`text-xs font-medium ${subscribed ? "text-emerald-400" : "text-zinc-500"}`}>
					{subscribed ? "Live" : "Disconnected"}
				</span>
				<div className="ml-auto flex items-center gap-2">
					<Input
						placeholder="Search..."
						value={filters.search}
						onChange={(e) => setFilter("search", e.target.value)}
						className="h-8 w-48"
					/>
					<select
						value={filters.level}
						onChange={(e) => setFilter("level", e.target.value)}
						className="h-8 rounded-md border border-zinc-800 bg-transparent px-2 text-xs text-zinc-300"
					>
						<option value="">All levels</option>
						<option value="error">Error</option>
						<option value="warn">Warn</option>
						<option value="info">Info</option>
						<option value="debug">Debug</option>
					</select>
					<Button
						size="icon"
						variant="ghost"
						onClick={togglePause}
						className="h-8 w-8"
					>
						{paused ? (
							<Play className="h-4 w-4" />
						) : (
							<Pause className="h-4 w-4" />
						)}
					</Button>
					<Button
						size="icon"
						variant="ghost"
						onClick={clearLogs}
						className="h-8 w-8"
					>
						<Trash2 className="h-4 w-4" />
					</Button>
					<Button
						size="icon"
						variant="ghost"
						onClick={exportLogs}
						className="h-8 w-8"
					>
						<Download className="h-4 w-4" />
					</Button>
				</div>
			</div>
			<ScrollArea className="flex-1 bg-zinc-950">
				<div className="space-y-1 p-4">
					{filtered.length === 0 ? (
						<p className="py-8 text-center text-xs text-zinc-600">
							{entries.length === 0
								? "Waiting for log entries..."
								: "No matching entries"}
						</p>
					) : (
						filtered.map((entry) => <LogLine key={entry.id} entry={entry} />)
					)}
					<div ref={bottomRef} />
				</div>
			</ScrollArea>
		</div>
	);
}

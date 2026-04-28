import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import {
	Home,
	MessageSquare,
	Bot,
	GitBranch,
	Briefcase,
	Brain,
	ScrollText,
	Activity,
	Settings,
	Search,
	Play,
	CheckCircle,
	XCircle,
	Command,
	Layers,
} from "lucide-react";
import { cn } from "../lib/utils";
import { useProposalsStore } from "../stores/proposals";
import { useAgentsStore } from "../stores/agents";
import { useSchedulerStore } from "../stores/scheduler";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { LucideIcon } from "lucide-react";

interface PaletteCommand {
	id: string;
	label: string;
	keywords: string[];
	icon: LucideIcon;
	group: "navigation" | "actions" | "proposals" | "automations";
	action: () => void;
	badge?: string;
}

function useCommands(): PaletteCommand[] {
	const navigate = useNavigate();
	const proposals = useProposalsStore((s) => s.proposals);
	const approve = useProposalsStore((s) => s.approve);
	const reject = useProposalsStore((s) => s.reject);
	const agents = useAgentsStore((s) => s.agents);
	const jobs = useSchedulerStore((s) => s.jobs);
	const runJob = useSchedulerStore((s) => s.runJob);
	const fetchJobs = useSchedulerStore((s) => s.fetchJobs);

	return useMemo(() => {
		const cmds: PaletteCommand[] = [];

		// Navigation
		const nav: [string, string, LucideIcon, string[]][] = [
			["/", "Home", Home, ["dashboard", "overview"]],
			["/chat", "Chat", MessageSquare, ["message", "talk", "conversation"]],
			["/work", "Work", Briefcase, ["proposals", "kanban", "tasks"]],
			["/transaction", "Transaction", Layers, ["v2", "operations", "control", "dashboard"]],
			["/agents", "Agents", Bot, ["bots", "costs", "tokens"]],
			["/threads", "Threads", GitBranch, ["conversations", "history"]],
			["/knowledge", "Knowledge", Brain, ["memory", "search", "embeddings"]],
			["/logs", "Logs", ScrollText, ["log", "debug", "output"]],
			["/traces", "Traces", Activity, ["execution", "performance"]],
			["/settings", "Settings", Settings, ["config", "system", "scheduler", "channels", "devices", "skills"]],
		];

		for (const [path, label, icon, keywords] of nav) {
			cmds.push({
				id: `nav:${path}`,
				label: `Go to ${label}`,
				keywords: [label.toLowerCase(), ...keywords],
				icon,
				group: "navigation",
				action: () => navigate(path),
			});
		}

		// Pending proposals — approve/reject
		const pending = proposals.filter((p) => p.status === "proposed" || p.status === "reviewed");
		for (const p of pending.slice(0, 5)) {
			cmds.push({
				id: `approve:${p.id}`,
				label: `Approve: ${p.title}`,
				keywords: ["approve", "accept", p.title.toLowerCase(), p.category],
				icon: CheckCircle,
				group: "proposals",
				action: () => approve(p.id),
				badge: p.priority,
			});
			cmds.push({
				id: `reject:${p.id}`,
				label: `Reject: ${p.title}`,
				keywords: ["reject", "decline", p.title.toLowerCase(), p.category],
				icon: XCircle,
				group: "proposals",
				action: () => reject(p.id),
				badge: p.priority,
			});
		}

		// Automation triggers
		const enabledJobs = jobs.filter((j) => j.enabled);
		if (enabledJobs.length === 0) {
			// Jobs haven't been fetched yet — lazy load
			cmds.push({
				id: "fetch-jobs",
				label: "Load automations...",
				keywords: ["automations", "scheduler", "cron", "scan"],
				icon: Play,
				group: "automations",
				action: () => fetchJobs(),
			});
		}
		for (const j of enabledJobs) {
			cmds.push({
				id: `run:${j.id}`,
				label: `Run: ${j.name}`,
				keywords: ["run", "trigger", "scan", j.name.toLowerCase(), j.category],
				icon: Play,
				group: "automations",
				action: () => runJob(j.id),
			});
		}

		return cmds;
	}, [navigate, proposals, approve, reject, agents, jobs, runJob, fetchJobs]);
}

const GROUP_LABELS: Record<string, string> = {
	navigation: "Navigate",
	actions: "Actions",
	proposals: "Proposals",
	automations: "Scheduler",
};

export function CommandPalette() {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [selectedIndex, setSelectedIndex] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const commands = useCommands();

	// Cmd+K / Ctrl+K
	useEffect(() => {
		function handleKeyDown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key === "k") {
				e.preventDefault();
				setOpen((prev) => !prev);
			}
		}
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, []);

	// Reset on open
	useEffect(() => {
		if (open) {
			setQuery("");
			setSelectedIndex(0);
			// Focus input after dialog animation
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}, [open]);

	// Filter
	const filtered = useMemo(() => {
		if (!query.trim()) return commands;
		const q = query.toLowerCase();
		return commands.filter(
			(c) =>
				c.label.toLowerCase().includes(q) ||
				c.keywords.some((k) => k.includes(q)),
		);
	}, [commands, query]);

	// Group results
	const grouped = useMemo(() => {
		const groups: { group: string; items: PaletteCommand[] }[] = [];
		const seen = new Set<string>();
		for (const cmd of filtered) {
			if (!seen.has(cmd.group)) {
				seen.add(cmd.group);
				groups.push({ group: cmd.group, items: [] });
			}
			groups.find((g) => g.group === cmd.group)!.items.push(cmd);
		}
		return groups;
	}, [filtered]);

	// Flat list for keyboard nav
	const flatItems = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);

	// Clamp selection
	useEffect(() => {
		setSelectedIndex((i) => Math.min(i, Math.max(0, flatItems.length - 1)));
	}, [flatItems.length]);

	const execute = useCallback(
		(cmd: PaletteCommand) => {
			setOpen(false);
			cmd.action();
		},
		[],
	);

	// Keyboard navigation
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setSelectedIndex((i) => (i + 1) % flatItems.length);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setSelectedIndex((i) => (i - 1 + flatItems.length) % flatItems.length);
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (flatItems[selectedIndex]) execute(flatItems[selectedIndex]);
			}
		},
		[flatItems, selectedIndex, execute],
	);

	// Scroll selected into view
	useEffect(() => {
		const el = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
		el?.scrollIntoView({ block: "nearest" });
	}, [selectedIndex]);

	return (
		<DialogPrimitive.Root open={open} onOpenChange={setOpen}>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
				<DialogPrimitive.Content
					className="fixed left-[50%] top-[20%] z-50 w-full max-w-lg translate-x-[-50%] rounded-xl border border-[rgb(var(--nyx-accent-rgb)/0.15)] bg-zinc-950/95 shadow-2xl shadow-[rgb(var(--nyx-accent-rgb)/0.05)] duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]"
					onKeyDown={handleKeyDown}
				>
					<DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
					{/* Search input */}
					<div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
						<Search className="h-4 w-4 shrink-0 text-zinc-500" />
						<input
							ref={inputRef}
							value={query}
							onChange={(e) => {
								setQuery(e.target.value);
								setSelectedIndex(0);
							}}
							placeholder="Type a command..."
							className="flex-1 bg-transparent text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
						/>
						<kbd className="hidden rounded border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 sm:inline">
							ESC
						</kbd>
					</div>

					{/* Results */}
					<div ref={listRef} className="max-h-72 overflow-y-auto p-2">
						{flatItems.length === 0 && (
							<div className="px-3 py-8 text-center text-sm text-zinc-500">
								No results for "{query}"
							</div>
						)}
						{grouped.map(({ group, items }) => (
							<div key={group}>
								<div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
									{GROUP_LABELS[group] ?? group}
								</div>
								{items.map((cmd) => {
									const idx = flatItems.indexOf(cmd);
									const Icon = cmd.icon;
									return (
										<button
											key={cmd.id}
											data-index={idx}
											onClick={() => execute(cmd)}
											onMouseEnter={() => setSelectedIndex(idx)}
											className={cn(
												"flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors",
												idx === selectedIndex
													? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)]"
													: "text-zinc-300 hover:bg-zinc-800/50",
											)}
										>
											<Icon className="h-4 w-4 shrink-0 text-zinc-500" />
											<span className="flex-1 truncate">{cmd.label}</span>
											{cmd.badge && (
												<span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
													{cmd.badge}
												</span>
											)}
										</button>
									);
								})}
							</div>
						))}
					</div>

					{/* Footer */}
					<div className="flex items-center justify-between border-t border-zinc-800 px-4 py-2 text-[11px] text-zinc-500">
						<div className="flex items-center gap-3">
							<span className="flex items-center gap-1">
								<kbd className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5">↑↓</kbd>
								navigate
							</span>
							<span className="flex items-center gap-1">
								<kbd className="rounded border border-zinc-700 bg-zinc-800 px-1 py-0.5">↵</kbd>
								select
							</span>
						</div>
						<span className="flex items-center gap-1">
							<Command className="h-3 w-3" />K to toggle
						</span>
					</div>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

import { useEffect, useState, useCallback } from "react";
import {
	Plus,
	MessageSquare,
	MoreHorizontal,
	Pencil,
	Trash2,
	Archive,
	PanelLeftClose,
	PanelLeft,
	FolderOpen,
	Tag,
	X,
	Check,
	FileCode2,
} from "lucide-react";
import { ScrollArea } from "../ui/scroll-area";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubTrigger,
	DropdownMenuSubContent,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useChatStore } from "../../stores/chat";
import { useThreadsStore, type Thread } from "../../stores/threads";
import { useAuthStore } from "../../stores/auth";
import { useWsEvent } from "../../hooks/useWs";
import { cn } from "../../lib/utils";
import type { RuntimeRequest } from "../../lib/chat-runtime";
import { toDisplayPath } from "../../lib/display-path";

/** Group uncategorized threads by time period */
function groupByTime(threads: Thread[]): { label: string; threads: Thread[] }[] {
	const now = Date.now();
	const day = 86400_000;
	const buckets: Record<string, Thread[]> = {
		Today: [],
		Yesterday: [],
		"This Week": [],
		"This Month": [],
		Older: [],
	};

	for (const t of threads) {
		const age = now - t.updatedAt;
		if (age < day) buckets.Today.push(t);
		else if (age < 2 * day) buckets.Yesterday.push(t);
		else if (age < 7 * day) buckets["This Week"].push(t);
		else if (age < 30 * day) buckets["This Month"].push(t);
		else buckets.Older.push(t);
	}

	return Object.entries(buckets)
		.filter(([, items]) => items.length > 0)
		.map(([label, items]) => ({ label, threads: items }));
}

/** Split threads into category groups + uncategorized time groups */
function groupThreads(threads: Thread[]): { label: string; isCategory: boolean; threads: Thread[] }[] {
	const categorized = new Map<string, Thread[]>();
	const uncategorized: Thread[] = [];

	for (const t of threads) {
		if (t.category) {
			const list = categorized.get(t.category) ?? [];
			list.push(t);
			categorized.set(t.category, list);
		} else {
			uncategorized.push(t);
		}
	}

	const groups: { label: string; isCategory: boolean; threads: Thread[] }[] = [];

	// Category groups first, sorted alphabetically
	for (const [cat, items] of Array.from(categorized.entries()).sort(([a], [b]) => a.localeCompare(b))) {
		groups.push({ label: cat, isCategory: true, threads: items });
	}

	// Then uncategorized grouped by time
	for (const g of groupByTime(uncategorized)) {
		groups.push({ label: g.label, isCategory: false, threads: g.threads });
	}

	return groups;
}

function ThreadItem({
	thread,
	active,
	isStreaming,
	categories,
	onSelect,
	onRename,
	onDelete,
	onArchive,
	onSetCategory,
}: {
	thread: Thread;
	active: boolean;
	isStreaming: boolean;
	categories: string[];
	onSelect: () => void;
	onRename: (id: string, title: string) => void;
	onDelete: (id: string) => void;
	onArchive: (id: string) => void;
	onSetCategory: (id: string, category: string | null) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [editTitle, setEditTitle] = useState(thread.title);
	const [newCat, setNewCat] = useState("");
	const [showNewCat, setShowNewCat] = useState(false);
	const [menuOpen, setMenuOpen] = useState(false);

	const commitRename = () => {
		const trimmed = editTitle.trim();
		if (trimmed && trimmed !== thread.title) onRename(thread.id, trimmed);
		setEditing(false);
	};

	const commitNewCategory = () => {
		const trimmed = newCat.trim();
		if (trimmed) {
			onSetCategory(thread.id, trimmed);
		}
		setNewCat("");
		setShowNewCat(false);
	};

	return (
		<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
			<div
				className={cn(
					"group relative flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors",
					active
						? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)]"
						: "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200",
				)}
				onClick={() => !editing && onSelect()}
				onContextMenu={(e) => {
					if (editing || showNewCat) return;
					e.preventDefault();
					e.stopPropagation();
					onSelect();
					setMenuOpen(true);
				}}
			>
				{isStreaming ? (
					<span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
						<span className="absolute h-2 w-2 rounded-full bg-[var(--nyx-accent)] animate-pulse" />
						<span className="h-1.5 w-1.5 rounded-full bg-[var(--nyx-accent)]" />
					</span>
				) : (
					<MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-50" />
				)}
				<div className="min-w-0 flex-1 overflow-hidden">
					{editing ? (
						<input
							className="w-full bg-transparent text-sm text-zinc-200 outline-none border-b border-[rgb(var(--nyx-accent-rgb)/0.25)]"
							value={editTitle}
							onChange={(e) => setEditTitle(e.target.value)}
							onBlur={commitRename}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitRename();
								if (e.key === "Escape") setEditing(false);
							}}
							autoFocus
							onClick={(e) => e.stopPropagation()}
						/>
					) : showNewCat ? (
						<input
							className="w-full bg-transparent text-sm text-zinc-200 outline-none border-b border-[rgb(var(--nyx-accent-rgb)/0.25)]"
							placeholder="Category name..."
							value={newCat}
							onChange={(e) => setNewCat(e.target.value)}
							onBlur={commitNewCategory}
							onKeyDown={(e) => {
								if (e.key === "Enter") commitNewCategory();
								if (e.key === "Escape") { setNewCat(""); setShowNewCat(false); }
							}}
							autoFocus
							onClick={(e) => e.stopPropagation()}
						/>
					) : (
						<span
							className="block truncate text-xs"
							onDoubleClick={(e) => {
								e.stopPropagation();
								setEditTitle(thread.title);
								setEditing(true);
							}}
						>
							{thread.title}
						</span>
					)}
				</div>
				{!editing && !showNewCat && (
					<>
					<DropdownMenuTrigger asChild>
						<button
							className={cn(
								"shrink-0 rounded p-0.5 hover:bg-zinc-700/50 hover:text-zinc-300 transition-opacity",
								active ? "text-zinc-400 opacity-80" : "text-zinc-600 opacity-50 group-hover:opacity-80",
							)}
							onClick={(e) => e.stopPropagation()}
						>
							<MoreHorizontal className="h-3.5 w-3.5" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="w-44">
						<DropdownMenuItem
							onClick={(e) => {
								e.stopPropagation();
								onSelect();
							}}
						>
							<MessageSquare className="h-3.5 w-3.5 mr-2" />
							Open
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={(e) => {
								e.stopPropagation();
								setEditTitle(thread.title);
								setEditing(true);
							}}
						>
							<Pencil className="h-3.5 w-3.5 mr-2" />
							Rename
						</DropdownMenuItem>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<Tag className="h-3.5 w-3.5 mr-2" />
								Category
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="w-40">
								{categories.map((cat) => (
									<DropdownMenuItem
										key={cat}
										onClick={(e) => {
											e.stopPropagation();
											onSetCategory(thread.id, cat);
										}}
										className={cn(thread.category === cat && "text-[var(--nyx-accent)]")}
									>
										<FolderOpen className="h-3.5 w-3.5 mr-2" />
										{cat}
									</DropdownMenuItem>
								))}
								{categories.length > 0 && <DropdownMenuSeparator />}
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										setShowNewCat(true);
									}}
								>
									<Plus className="h-3.5 w-3.5 mr-2" />
									New Category
								</DropdownMenuItem>
								{thread.category && (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={(e) => {
												e.stopPropagation();
												onSetCategory(thread.id, null);
											}}
											className="text-zinc-500"
										>
											<X className="h-3.5 w-3.5 mr-2" />
											Remove
										</DropdownMenuItem>
									</>
								)}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onClick={(e) => {
								e.stopPropagation();
								onArchive(thread.id);
							}}
						>
							<Archive className="h-3.5 w-3.5 mr-2" />
							Archive
						</DropdownMenuItem>
						<DropdownMenuItem
							className="text-red-400 focus:text-red-400"
							onClick={(e) => {
								e.stopPropagation();
								onDelete(thread.id);
							}}
						>
							<Trash2 className="h-3.5 w-3.5 mr-2" />
							Delete
						</DropdownMenuItem>
					</DropdownMenuContent>
					</>
				)}
			</div>
		</DropdownMenu>
	);
}

function RequestInbox({
	requests,
	activeThreadId,
	threadTitles,
	resolvingId,
	onResolve,
	onOpenThread,
}: {
	requests: RuntimeRequest[];
	activeThreadId: string | null;
	threadTitles: Map<string, string>;
	resolvingId?: string | null;
	onResolve: (requestId: string, action: "approve" | "reject") => void;
	onOpenThread: (threadId: string) => void;
}) {
	if (requests.length === 0) return null;

	return (
		<div className="mb-3 rounded-xl border border-amber-500/15 bg-amber-500/[0.05] px-2 py-2">
			<div className="mb-2 flex items-center justify-between gap-2 px-1">
				<div>
					<p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">Request Inbox</p>
					<p className="text-[11px] text-zinc-500">{requests.length} waiting for a response</p>
				</div>
			</div>
			<div className="space-y-2">
				{requests.slice(0, 4).map((request) => {
					const proposal = request.proposal;
					const isApproval = request.kind === "proposal_approval";
					const threadLabel = request.threadId
						? request.threadId === activeThreadId
							? "This thread"
							: threadTitles.get(request.threadId) ?? "Other thread"
						: "Global";
					return (
						<div
							key={request.requestId}
							className="rounded-lg border border-white/8 bg-zinc-950/50 px-2.5 py-2"
						>
							<div className="flex items-start gap-2">
								<div className="mt-0.5 rounded-full border border-white/10 bg-white/[0.04] p-1.5 text-amber-300">
									<FileCode2 className="h-3.5 w-3.5" />
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-1.5">
										<p className="truncate text-xs font-medium text-zinc-100" title={proposal?.title ?? request.title}>{proposal?.title ?? request.title}</p>
										<span className="rounded-full border border-white/8 px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-zinc-500">
											{threadLabel}
										</span>
									</div>
									{proposal?.filesAffected?.[0] ? (
										<p className="mt-1 truncate font-mono text-[11px] text-zinc-500" title={proposal.filesAffected.join(", ")}>
											{toDisplayPath(proposal.filesAffected[0])}
											{proposal.filesAffected.length > 1 ? ` +${proposal.filesAffected.length - 1}` : ""}
										</p>
									) : null}
									<div className="mt-2 flex flex-wrap gap-1.5">
										{request.threadId && request.threadId !== activeThreadId ? (
											<button
												type="button"
												onClick={() => onOpenThread(request.threadId!)}
												className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-zinc-400 transition-colors hover:border-white/20 hover:text-zinc-200"
											>
												Open thread
											</button>
										) : null}
										{isApproval ? (
											<>
												<button
													type="button"
													onClick={() => onResolve(request.requestId, "approve")}
													disabled={resolvingId === request.requestId}
													className="inline-flex items-center gap-1 rounded-full bg-emerald-600/90 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
												>
													<Check className="h-3 w-3" />
													Approve
												</button>
												<button
													type="button"
													onClick={() => onResolve(request.requestId, "reject")}
													disabled={resolvingId === request.requestId}
													className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-red-200 transition-colors hover:bg-red-500/20 disabled:opacity-50"
												>
													<X className="h-3 w-3" />
													Reject
												</button>
											</>
										) : (
											<span className="rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-zinc-500">
												Reply in thread
											</span>
										)}
									</div>
								</div>
							</div>
						</div>
					);
				})}
				{requests.length > 4 ? (
					<p className="px-1 text-[11px] text-zinc-500">+{requests.length - 4} more requests in the inbox</p>
				) : null}
			</div>
		</div>
	);
}

export function ChatSidebar({
	collapsed,
	onToggle,
	requests,
	resolvingId,
	onResolveRequest,
}: {
	collapsed: boolean;
	onToggle: () => void;
	requests: RuntimeRequest[];
	resolvingId?: string | null;
	onResolveRequest: (requestId: string, action: "approve" | "reject") => void;
}) {
	const { threadId, switchThread, newThread, getStreamingThreadIds } = useChatStore();
	const streamingThreadIds = getStreamingThreadIds();
	const { threads, fetchThreads, renameThread, deleteThread, archiveThread, setCategory, getCategories } =
		useThreadsStore();
	const authenticated = useAuthStore((s) => s.authenticated);

	useEffect(() => {
		if (authenticated) fetchThreads();
	}, [authenticated, fetchThreads]);

	// Refresh thread list when threadId changes (new thread created after first send)
	useEffect(() => {
		if (threadId && authenticated) {
			const timer = setTimeout(() => fetchThreads(), 500);
			return () => clearTimeout(timer);
		}
	}, [threadId, authenticated, fetchThreads]);

	// Refresh sidebar when a thread title is auto-generated
	useWsEvent("thread:update", useCallback(() => {
		if (authenticated) fetchThreads();
	}, [authenticated, fetchThreads]));

	const categories = getCategories();

	const handleRename = useCallback(
		async (id: string, title: string) => {
			try {
				await renameThread(id, title);
			} catch (err) {
				console.error("[threads.rename] failed:", err);
			}
		},
		[renameThread],
	);

	const handleDelete = useCallback(
		async (id: string) => {
			try {
				await deleteThread(id);
				if (useChatStore.getState().threadId === id) newThread();
			} catch (err) {
				console.error("[threads.delete] failed:", err);
			}
		},
		[deleteThread, newThread],
	);

	const handleArchive = useCallback(
		async (id: string) => {
			try {
				await archiveThread(id);
				if (useChatStore.getState().threadId === id) newThread();
			} catch (err) {
				console.error("[threads.archive] failed:", err);
			}
		},
		[archiveThread, newThread],
	);

	const handleSetCategory = useCallback(
		async (id: string, category: string | null) => {
			try {
				await setCategory(id, category);
			} catch (err) {
				console.error("[threads.setCategory] failed:", err);
			}
		},
		[setCategory],
	);

	const groups = groupThreads(threads);
	const threadTitles = new Map(threads.map((thread) => [thread.id, thread.title]));

	// Collapsed: just icons
	if (collapsed) {
		return (
			<div className="flex flex-col items-center gap-2 border-r border-zinc-800 py-3 px-1.5">
				<button
					onClick={onToggle}
					className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300 transition-colors"
					title="Expand threads"
				>
					<PanelLeft className="h-4 w-4" />
				</button>
				<button
					onClick={() => newThread()}
					className="rounded-md p-1.5 text-zinc-500 hover:bg-[var(--nyx-accent-dim)] hover:text-[var(--nyx-accent)] transition-colors"
					title="New chat"
				>
					<Plus className="h-4 w-4" />
				</button>
			</div>
		);
	}

	return (
		<div className="flex h-full w-56 shrink-0 flex-col border-r border-zinc-800">
			<div className="flex items-center justify-between px-3 py-2.5">
				<button
					onClick={() => newThread()}
					className={cn(
						"flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
						"text-zinc-300 hover:bg-[var(--nyx-accent-dim)] hover:text-[var(--nyx-accent)]",
					)}
				>
					<Plus className="h-4 w-4" />
					New Chat
				</button>
				<button
					onClick={onToggle}
					className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300 transition-colors"
					title="Collapse"
				>
					<PanelLeftClose className="h-4 w-4" />
				</button>
			</div>
			<ScrollArea className="flex-1">
				<div className="px-1.5 pb-2 max-w-full overflow-hidden">
					{/* New thread indicator */}
					{!threadId && (
						<div className="flex items-center gap-2 rounded-md bg-[rgb(var(--nyx-accent-rgb)/0.12)] px-2.5 py-2 text-sm text-[var(--nyx-accent)] mb-1">
							<Plus className="h-3.5 w-3.5 shrink-0 opacity-50" />
							<span className="truncate">New conversation</span>
						</div>
					)}
					<RequestInbox
						requests={requests}
						activeThreadId={threadId}
						threadTitles={threadTitles}
						resolvingId={resolvingId}
						onResolve={onResolveRequest}
						onOpenThread={(id) => {
							if (id !== threadId) switchThread(id);
						}}
					/>
					{groups.map((group) => (
						<div key={group.label} className="mb-2">
							<p className={cn(
								"px-2.5 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider",
								group.isCategory ? "text-[rgb(var(--nyx-accent-rgb)/0.55)]" : "text-zinc-600",
							)}>
								{group.isCategory && <FolderOpen className="inline h-2.5 w-2.5 mr-1 -mt-0.5" />}
								{group.label}
							</p>
							<div className="space-y-0.5">
								{group.threads.map((t) => (
									<ThreadItem
										key={t.id}
										thread={t}
										active={t.id === threadId}
										categories={categories}
										isStreaming={streamingThreadIds.has(t.id)}
								onSelect={() => {
											if (t.id !== threadId) switchThread(t.id);
										}}
										onRename={handleRename}
										onDelete={handleDelete}
										onArchive={handleArchive}
										onSetCategory={handleSetCategory}
									/>
								))}
							</div>
						</div>
					))}
					{threads.length === 0 && threadId === null && (
						<p className="px-2.5 py-4 text-center text-xs text-zinc-600">
							Start a conversation
						</p>
					)}
				</div>
			</ScrollArea>
		</div>
	);
}

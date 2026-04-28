import { useEffect, useCallback, useState } from "react";
import { useProposalsStore } from "../stores/proposals";
import { useWsEvent } from "../hooks/useWs";
import { KanbanCard } from "../components/proposals/KanbanCard";
import { ProposalDetail } from "../components/proposals/ProposalDetail";
import { Skeleton } from "../components/ui/skeleton";
import { Button } from "../components/ui/button";
import { ScrollArea } from "../components/ui/scroll-area";
import { cn } from "../lib/utils";
import { Trash2, ChevronDown, ChevronRight, Search, Play } from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import type { Frame } from "../../protocol/frame";
import { QUEUED_REVIEW_STATUS, type Proposal } from "../stores/proposals";

// Column definitions matching iOS app
interface Column {
	id: string;
	label: string;
	color: string;
	borderColor: string;
	filter: (status: string) => boolean;
	/** Statuses this column can accept via drag-drop */
	accepts: string[];
	/** Action to take when a proposal is dropped here */
	dropAction?: string;
}

const columns: Column[] = [
	{
		id: "todo",
		label: "Todo",
		color: "text-[var(--nyx-accent)]",
		borderColor: "border-[rgb(var(--nyx-accent-rgb)/0.30)]",
		filter: (s) => s === "proposed",
		accepts: [],
		dropAction: undefined,
	},
	{
		id: "review",
		label: "Review",
		color: "text-cyan-400",
		borderColor: "border-cyan-500/30",
		filter: (s) => s === QUEUED_REVIEW_STATUS || s === "reviewing" || s === "reviewed",
		accepts: ["proposed"],
		dropAction: "startReview",
	},
	{
		id: "approved",
		label: "Approved",
		color: "text-amber-400",
		borderColor: "border-amber-500/30",
		filter: (s) => s === "approved" || s === "executing",
		accepts: ["proposed", "reviewing", "reviewed"],
		dropAction: "approve",
	},
	{
		id: "done",
		label: "Done",
		color: "text-emerald-400",
		borderColor: "border-emerald-500/30",
		filter: (s) =>
			s === "completed" ||
			s === "merged" ||
			s === "rejected" ||
			s === "failed" ||
			s === "expired",
		accepts: [],
		dropAction: undefined,
	},
];

// Group done proposals by outcome
const doneGroups: { status: string; label: string; color: string }[] = [
	{ status: "completed", label: "Completed", color: "text-emerald-400" },
	{ status: "merged", label: "Merged", color: "text-green-400" },
	{ status: "failed", label: "Failed", color: "text-red-400" },
	{ status: "rejected", label: "Rejected", color: "text-red-400" },
	{ status: "expired", label: "Expired", color: "text-zinc-500" },
];

export function WorkPage() {
	const {
		proposals,
		loading,
		selectedProposalId,
		selectProposal,
		fetchProposals,
		approve,
		execute,
		executeAll,
		reject,
		startReview,
		reviewAll,
		createPr,
		mergePr,
		retryProposal,
		requeueProposal,
		deleteProposal,
		clearTerminal,
		updateProposal,
	} = useProposalsStore();

	const selectedProposal = selectedProposalId
		? proposals.find((p) => p.id === selectedProposalId)
		: null;

	const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
	const [doneLimit, setDoneLimit] = useState(20);

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
			// Refetch full data when review completes (review result, verdict, corrections)
			if (payload.status === "reviewed") {
				fetchProposals();
			}
		},
		[updateProposal, fetchProposals],
	);
	useWsEvent("proposal:update", handleUpdate);

	// Drag handlers
	const handleDragStart = (e: React.DragEvent, proposalId: string) => {
		const proposal = proposals.find((p) => p.id === proposalId);
		if (!proposal) return;
		e.dataTransfer.setData("proposalId", proposalId);
		e.dataTransfer.setData("status", proposal.status);
		e.dataTransfer.effectAllowed = "move";
	};

	const handleDragOver = (e: React.DragEvent, column: Column) => {
		// Can't read data during dragover — allow drop on any column that accepts items
		if (column.accepts.length === 0) return;
		e.preventDefault();
		setDragOverColumn(column.id);
	};

	const handleDragLeave = () => {
		setDragOverColumn(null);
	};

	const handleDrop = async (e: React.DragEvent, column: Column) => {
		e.preventDefault();
		setDragOverColumn(null);
		const proposalId = e.dataTransfer.getData("proposalId");
		const fromStatus = e.dataTransfer.getData("status");
		if (!proposalId || !column.accepts.includes(fromStatus)) return;

		if (column.dropAction === "startReview") {
			await startReview(proposalId);
		} else if (column.dropAction === "approve") {
			await approve(proposalId);
		}
	};

	const toggleGroup = (status: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(status)) next.delete(status);
			else next.add(status);
			return next;
		});
	};

	const inboxCount = proposals.filter((p) => p.status === "proposed").length;

	const getColumnProposals = (col: Column): Proposal[] =>
		proposals
			.filter((p) => col.filter(p.status))
			.sort((a, b) => {
				if (col.id !== "review") {
					return b.createdAt - a.createdAt;
				}
				const getReviewRank = (proposal: Proposal): number => {
					if (proposal.status === "reviewing") return 0;
					if (proposal.status === QUEUED_REVIEW_STATUS) return 1;
					return 2;
				};
				const rankDiff = getReviewRank(a) - getReviewRank(b);
				if (rankDiff !== 0) {
					return rankDiff;
				}
				if (
					a.status === QUEUED_REVIEW_STATUS &&
					b.status === QUEUED_REVIEW_STATUS &&
					a.reviewQueuePosition !== b.reviewQueuePosition
				) {
					return (a.reviewQueuePosition ?? Number.MAX_SAFE_INTEGER) -
						(b.reviewQueuePosition ?? Number.MAX_SAFE_INTEGER);
				}
				return b.createdAt - a.createdAt;
			});

	return (
		<div className="flex h-full">
			{/* Board */}
			<div className={cn("flex flex-1 flex-col overflow-hidden", selectedProposal && "max-w-[calc(100%-480px)]")}>
			{/* Header */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-3">
					<h1 className="text-2xl font-semibold">Work</h1>
					{inboxCount > 0 && (
						<span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-red-500/20 px-2 text-xs font-medium text-red-400">
							{inboxCount}
						</span>
					)}
				</div>
			</div>
			<p className="mt-1 text-sm text-zinc-400">
				Drag proposals between columns to advance them
			</p>

			{/* Board */}
			<div className="mt-4 flex flex-1 gap-4 overflow-x-auto pb-4 max-md:flex-col max-md:overflow-x-visible">
				{columns.map((col) => {
					const items = getColumnProposals(col);
					const isDone = col.id === "done";

					return (
						<div
							key={col.id}
							className={cn(
								"flex w-72 min-w-72 flex-col rounded-xl border bg-zinc-950/50 max-md:w-full max-md:min-w-0",
								dragOverColumn === col.id
									? cn(col.borderColor, "border-2 bg-zinc-900/30")
									: "border-zinc-800/50",
							)}
							onDragOver={(e) => handleDragOver(e, col)}
							onDragLeave={handleDragLeave}
							onDrop={(e) => handleDrop(e, col)}
						>
							{/* Column header */}
							<div
								className={cn(
									"flex items-center justify-between border-b px-3 py-2.5",
									col.borderColor,
								)}
							>
								<div className="flex items-center gap-2">
									<span className={cn("text-sm font-semibold", col.color)}>
										{col.label}
									</span>
									{items.length > 0 && (
										<span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-zinc-800 px-1.5 text-[10px] font-medium text-zinc-400">
											{items.length}
										</span>
									)}
								</div>
								{col.id === "todo" && items.length > 1 && (
									<Button
										variant="ghost"
										size="sm"
										className="h-6 px-2 text-[10px] text-zinc-500 hover:text-cyan-400"
										onClick={() => reviewAll()}
										title="Review all"
									>
										<Search className="mr-1 h-3 w-3" />
										Review All
									</Button>
								)}
								{col.id === "approved" && items.filter(p => p.status === "approved").length > 0 && (
									<DropdownMenu>
										<DropdownMenuTrigger asChild>
											<Button
												variant="ghost"
												size="sm"
												className="h-6 px-2 text-[10px] text-zinc-500 hover:text-amber-400"
												title="Trigger all approved"
											>
												<Play className="mr-1 h-3 w-3" />
												Trigger All
											</Button>
										</DropdownMenuTrigger>
										<DropdownMenuContent align="end" className="w-44">
											<DropdownMenuItem onClick={() => executeAll(false)}>
												Separate PRs
											</DropdownMenuItem>
											<DropdownMenuItem onClick={() => executeAll(true)}>
												Bundle into 1 PR
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
								)}
								{isDone && items.length > 0 && (
									<Button
										variant="ghost"
										size="sm"
										className="h-6 px-2 text-[10px] text-zinc-500 hover:text-red-400"
										onClick={() => clearTerminal()}
										title="Clear completed"
									>
										<Trash2 className="h-3 w-3" />
									</Button>
								)}
							</div>

							{/* Column content */}
							<ScrollArea className="flex-1">
								<div className="space-y-2 p-2">
									{loading ? (
										<>
											<Skeleton className="h-20 rounded-lg" />
											<Skeleton className="h-20 rounded-lg" />
										</>
									) : items.length === 0 ? (
										<p className="py-6 text-center text-xs text-zinc-600">
											{col.id === "todo"
												? "No pending proposals"
												: col.id === "review"
													? "Nothing queued or under review"
													: col.id === "approved"
														? "Nothing running"
														: "No completed work"}
										</p>
									) : isDone ? (
										// Done column: group by status
										doneGroups
											.filter((g) =>
												items.some((p) => p.status === g.status),
											)
											.map((group) => {
												const groupItems = items.filter(
													(p) => p.status === group.status,
												);
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
															<span className="text-zinc-600">
																({groupItems.length})
															</span>
														</button>
														{!collapsed && (
															<>
																{shown.map((p) => (
																	<KanbanCard
																		key={p.id}
																		proposal={p}
																		onApprove={approve}
																		onExecute={execute}
																		onReject={reject}
																		onStartReview={startReview}
																		onCreatePr={createPr}
																		onMergePr={mergePr}
																		onRetry={retryProposal}
																		onRequeue={requeueProposal}
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
											})
									) : (
										items.map((p) => (
											<KanbanCard
												key={p.id}
												proposal={p}
												onApprove={approve}
												onExecute={execute}
												onReject={reject}
												onStartReview={startReview}
												onCreatePr={createPr}
												onMergePr={mergePr}
												onRetry={retryProposal}
												onRequeue={requeueProposal}
												onDelete={deleteProposal}
												draggable={col.id !== "done"}
												onDragStart={handleDragStart}
												onSelect={(id) => selectProposal(selectedProposalId === id ? null : id)}
												isSelected={p.id === selectedProposalId}
											/>
										))
									)}
								</div>
							</ScrollArea>
						</div>
					);
				})}
			</div>
			</div>

			{/* Detail panel */}
			{selectedProposal && (
				<div className="h-full w-[480px] shrink-0">
					<ProposalDetail
						proposal={selectedProposal}
						onApprove={approve}
						onExecute={execute}
						onReject={reject}
						onStartReview={startReview}
						onCreatePr={createPr}
						onMergePr={mergePr}
						onRetry={retryProposal}
						onRequeue={requeueProposal}
						onDelete={(id) => {
							deleteProposal(id);
							selectProposal(null);
						}}
						onClose={() => selectProposal(null)}
					/>
				</div>
			)}
		</div>
	);
}

import {
	AlertTriangle,
	Check,
	Clock3,
	X,
	Search,
	Trash2,
	MoreHorizontal,
	ExternalLink,
	GitMerge,
	GitPullRequest,
	Loader2,
	Play,
	RotateCcw,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { cn } from "../../lib/utils";
import { categoryBadgeColors, priorityDotColors } from "../../lib/colors";
import { formatTimeAgo } from "../../lib/format";
import { QUEUED_REVIEW_STATUS, type Proposal } from "../../stores/proposals";

interface KanbanCardProps {
	proposal: Proposal;
	isSelected?: boolean;
	onSelect: (id: string) => void;
	onApprove: (id: string) => void;
	onExecute?: (id: string) => void;
	onReject: (id: string) => void;
	onStartReview: (id: string) => void;
	onCreatePr: (id: string) => void;
	onMergePr: (id: string) => void;
	onRetry?: (id: string) => void;
	onRequeue?: (id: string) => void;
	onDelete: (id: string) => void;
	draggable?: boolean;
	onDragStart?: (e: React.DragEvent, id: string) => void;
}

export function KanbanCard({
	proposal,
	isSelected,
	onSelect,
	onApprove,
	onExecute,
	onReject,
	onStartReview,
	onCreatePr,
	onMergePr,
	onRetry,
	onRequeue,
	onDelete,
	draggable,
	onDragStart,
}: KanbanCardProps) {
	const isPending = proposal.status === "proposed" || proposal.status === "reviewed";
	const isQueuedReview = proposal.status === QUEUED_REVIEW_STATUS;
	const isReviewing = proposal.status === "reviewing";
	const isExecuting = proposal.status === "executing";
	const isApproved = proposal.status === "approved";
	const canCreatePr = proposal.status === "completed" && !proposal.prUrl;
	const canMergePr = proposal.status === "completed" && Boolean(proposal.prUrl);
	const hasConflict = proposal.prMergeable === "CONFLICTING";
	const isTerminal = ["completed", "merged", "rejected", "failed", "expired"].includes(
		proposal.status,
	);

	return (
		<div
			className={cn(
				"group rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 transition-all",
				draggable && "cursor-grab active:cursor-grabbing",
				"hover:border-zinc-700",
				isSelected && "ring-1 ring-[rgb(var(--nyx-accent-rgb)/0.50)] border-[rgb(var(--nyx-accent-rgb)/0.30)]",
			)}
			draggable={draggable}
			onDragStart={(e) => onDragStart?.(e, proposal.id)}
			onClick={() => onSelect(proposal.id)}
		>
			{/* Header */}
			<div className="flex items-start justify-between gap-2">
				<h4 className="text-sm font-medium leading-snug line-clamp-2">
					{proposal.title}
				</h4>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="h-6 w-6 shrink-0 p-0 opacity-0 group-hover:opacity-100"
							onClick={(e) => e.stopPropagation()}
						>
							<MoreHorizontal className="h-3.5 w-3.5" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
						{isPending && (
							<>
								<DropdownMenuItem onClick={() => onStartReview(proposal.id)}>
									<Search className="mr-2 h-3.5 w-3.5" /> Send to Review
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => onApprove(proposal.id)}>
									<Check className="mr-2 h-3.5 w-3.5 text-emerald-400" /> Approve
								</DropdownMenuItem>
								<DropdownMenuItem onClick={() => onReject(proposal.id)}>
									<X className="mr-2 h-3.5 w-3.5 text-red-400" /> Reject
								</DropdownMenuItem>
							</>
						)}
						{isApproved && onExecute && (
							<DropdownMenuItem onClick={() => onExecute(proposal.id)}>
								<Play className="mr-2 h-3.5 w-3.5 text-amber-400" /> Start
							</DropdownMenuItem>
						)}
						{(isTerminal || isApproved) && (
							<DropdownMenuItem onClick={() => onDelete(proposal.id)}>
								<Trash2 className="mr-2 h-3.5 w-3.5 text-red-400" /> Delete
							</DropdownMenuItem>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>

			{/* Meta row */}
			<div className="mt-2 flex flex-wrap items-center gap-1.5">
				<Badge
					variant="outline"
					className={cn(
						"text-[10px] px-1.5 py-0",
						categoryBadgeColors[proposal.category] ?? categoryBadgeColors.maintenance,
					)}
				>
					{proposal.category}
				</Badge>
				<span
					className={cn("h-1.5 w-1.5 rounded-full", priorityDotColors[proposal.priority])}
					title={proposal.priority}
				/>
				<span className="text-[10px] text-zinc-500">{proposal.effort}</span>
				<span className="ml-auto text-[10px] text-zinc-600">
					{formatTimeAgo(proposal.createdAt)}
				</span>
			</div>

			{/* Status indicator for active states */}
			{(isQueuedReview || isReviewing || isExecuting) && (
				<div className="mt-2 flex items-center gap-1.5 text-xs">
					{isQueuedReview ? (
						<Clock3 className="h-3 w-3 text-sky-400" />
					) : (
						<Loader2
							className={cn(
								"h-3 w-3 animate-spin",
								isReviewing ? "text-cyan-400" : "text-amber-400",
							)}
						/>
					)}
					<span
						className={
							isQueuedReview
								? "text-sky-400"
								: isReviewing
									? "text-cyan-400"
									: "text-amber-400"
						}
					>
						{isQueuedReview ? "Queued for Review" : isReviewing ? "Reviewing" : "Executing"}
					</span>
				</div>
			)}

			{/* Verdict for reviewed proposals */}
			{proposal.reviewVerdict && !isReviewing && (
				<div className="mt-2">
					<span
						className={cn(
							"text-[10px] font-semibold uppercase",
							proposal.reviewVerdict.toLowerCase().includes("approve")
								? "text-emerald-400"
								: "text-red-400",
						)}
					>
						{proposal.reviewVerdict.toLowerCase().includes("approve")
							? "Recommended"
								: "Not Recommended"}
					</span>
				</div>
			)}

			{/* PR link for completed */}
			{proposal.prUrl && (
				<a
					href={proposal.prUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="mt-2 flex items-center gap-1 text-xs text-[var(--nyx-accent)] hover:underline"
					onClick={(e) => e.stopPropagation()}
				>
					<ExternalLink className="h-3 w-3" /> PR
				</a>
			)}

			{canCreatePr && (
				<div className="mt-2" onClick={(e) => e.stopPropagation()}>
					<Button
						size="sm"
						variant="outline"
						className="h-7 w-full border-zinc-700 text-xs text-[var(--nyx-accent-2)] hover:bg-[var(--nyx-accent-dim)]"
						onClick={() => onCreatePr(proposal.id)}
					>
						<GitPullRequest className="mr-1 h-3 w-3" />
						Create PR
					</Button>
				</div>
			)}

			{canMergePr && !hasConflict && (
				<div className="mt-2" onClick={(e) => e.stopPropagation()}>
					<Button
						size="sm"
						className="h-7 w-full bg-emerald-600 text-xs text-white hover:bg-emerald-500"
						onClick={() => onMergePr(proposal.id)}
					>
						<GitMerge className="mr-1 h-3 w-3" />
						Merge PR
					</Button>
				</div>
			)}

			{canMergePr && hasConflict && (
				<div className="mt-2 space-y-1.5" onClick={(e) => e.stopPropagation()}>
					<div className="flex items-center gap-1 text-[10px] text-amber-400">
						<AlertTriangle className="h-3 w-3" />
						<span>Merge conflicts</span>
					</div>
					<div className="flex gap-1">
						{onRetry && (
							<Button
								size="sm"
								variant="outline"
								className="h-7 flex-1 border-zinc-700 text-xs text-amber-300 hover:bg-amber-500/10"
								onClick={() => onRetry(proposal.id)}
							>
								<RotateCcw className="mr-1 h-3 w-3" />
								Retry
							</Button>
						)}
						{onRequeue && (
							<Button
								size="sm"
								variant="outline"
								className="h-7 flex-1 border-zinc-700 text-xs text-zinc-300 hover:bg-zinc-700/50"
								onClick={() => onRequeue(proposal.id)}
							>
								<Search className="mr-1 h-3 w-3" />
								Review
							</Button>
						)}
					</div>
				</div>
			)}

			{/* Start execution for approved */}
			{isApproved && onExecute && (
				<div className="mt-2" onClick={(e) => e.stopPropagation()}>
					<Button
						size="sm"
						variant="outline"
						className="h-7 w-full border-zinc-700 text-xs text-amber-300 hover:bg-amber-500/10"
						onClick={() => onExecute(proposal.id)}
					>
						<Play className="mr-1 h-3 w-3" />
						Start
					</Button>
				</div>
			)}

			{/* Quick actions for pending */}
			{isPending && (
				<div className="mt-2 flex gap-1" onClick={(e) => e.stopPropagation()}>
					<Button
						size="sm"
						variant="ghost"
						className="h-7 flex-1 text-xs text-emerald-400 hover:bg-emerald-500/10"
						onClick={() => onApprove(proposal.id)}
					>
						<Check className="mr-1 h-3 w-3" /> Approve
					</Button>
					<Button
						size="sm"
						variant="ghost"
						className="h-7 flex-1 text-xs text-red-400 hover:bg-red-500/10"
						onClick={() => onReject(proposal.id)}
					>
						<X className="mr-1 h-3 w-3" /> Reject
					</Button>
				</div>
			)}

		</div>
	);
}

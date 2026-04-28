import { useState } from "react";
import {
	AlertTriangle,
	Check,
	ChevronDown,
	Clock3,
	ExternalLink,
	FileCode2,
	GitMerge,
	GitPullRequest,
	Loader2,
	Play,
	RotateCcw,
	Search,
	Trash2,
	X,
	XIcon,
} from "lucide-react";
import { QUEUED_REVIEW_STATUS, type Proposal } from "../../stores/proposals";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Separator } from "../ui/separator";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { categoryBadgeColors, priorityDotColors } from "../../lib/colors";
import { formatTimeAgo } from "../../lib/format";
import { cn } from "../../lib/utils";
import { toDisplayPath } from "../../lib/display-path";

const REVIEW_MODELS = [
	{ id: "default", label: "Default (best for active brain)" },
	{ id: "claude-opus-4-6", label: "Opus 4.6" },
	{ id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
	{ id: "gpt-5.5", label: "Codex (GPT-5.5)" },
	{ id: "gpt-5.4", label: "Codex (GPT-5.4)" },
	{ id: "o3", label: "o3" },
] as const;

function canStartReview(proposal: Proposal): boolean {
	if (proposal.status === "proposed") return true;
	if (proposal.status !== "reviewed") return false;
	const reviewText = proposal.reviewResult?.trim().toLowerCase() ?? "";
	return !proposal.reviewVerdict
		|| proposal.reviewVerdict === "UNCLEAR"
		|| reviewText.startsWith("review failed:")
		|| reviewText.startsWith("auto-review failed:");
}

interface ProposalDetailProps {
	proposal: Proposal;
	onApprove: (id: string, notes?: string) => void | Promise<void>;
	onExecute?: (id: string) => void | Promise<void>;
	onReject: (id: string, notes?: string) => void | Promise<void>;
	onStartReview: (id: string, model?: string) => void | Promise<void>;
	onCreatePr: (id: string) => void | Promise<void>;
	onMergePr: (id: string) => void | Promise<void>;
	onRetry?: (id: string) => void | Promise<void>;
	onRequeue?: (id: string) => void | Promise<void>;
	onDelete: (id: string) => void | Promise<void>;
	onClose: () => void;
}

function DetailSection({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="space-y-2">
			<h3 className="text-xs font-semibold uppercase tracking-[0.16em] text-zinc-500">
				{title}
			</h3>
			{children}
		</section>
	);
}

export function ProposalDetail({
	proposal,
	onApprove,
	onExecute,
	onReject,
	onStartReview,
	onCreatePr,
	onMergePr,
	onRetry,
	onRequeue,
	onDelete,
	onClose,
}: ProposalDetailProps) {
	const [reviewModel, setReviewModel] = useState<string>("default");
	const selectedModelLabel = REVIEW_MODELS.find((m) => m.id === reviewModel)?.label ?? "Default";
	const reviewable = canStartReview(proposal);
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
	const statusLabel = isQueuedReview ? "queued for review" : proposal.status;

	return (
		<div className="flex h-full flex-col border-l border-zinc-800/80 bg-zinc-950/90">
			<div className="flex items-start justify-between gap-4 border-b border-zinc-800/80 px-5 py-4">
				<div className="space-y-2">
					<div className="flex flex-wrap items-center gap-2">
						<Badge
							variant="outline"
							className={cn(
								"text-[10px]",
								categoryBadgeColors[proposal.category] ?? categoryBadgeColors.maintenance,
							)}
						>
							{proposal.category}
						</Badge>
						<span
							className={cn("h-2 w-2 rounded-full", priorityDotColors[proposal.priority])}
							title={proposal.priority}
						/>
						<span className="text-xs text-zinc-500">{proposal.priority}</span>
						<span className="text-xs text-zinc-600">·</span>
						<span className="text-xs text-zinc-500">{proposal.effort}</span>
					</div>
					<div>
						<h2 className="text-lg font-semibold leading-tight text-zinc-100">
							{proposal.title}
						</h2>
						<div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
							<span className="rounded-full border border-zinc-800 px-2 py-0.5">
								{statusLabel}
							</span>
							<span className="flex items-center gap-1">
								<Clock3 className="h-3.5 w-3.5" />
								{formatTimeAgo(proposal.createdAt)}
							</span>
						</div>
					</div>
				</div>
				<Button variant="ghost" size="icon" onClick={onClose} aria-label="Close proposal detail">
					<XIcon className="h-4 w-4" />
				</Button>
			</div>

			<ScrollArea className="flex-1">
				<div className="space-y-6 px-5 py-5">
					{(isQueuedReview || isReviewing || isExecuting) && (
						<div
							className={cn(
								"flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
								isQueuedReview
									? "border-sky-500/20 bg-sky-500/5 text-sky-300"
									: isReviewing
										? "border-cyan-500/20 bg-cyan-500/5 text-cyan-300"
										: "border-amber-500/20 bg-amber-500/5 text-amber-300",
							)}
						>
							{isQueuedReview ? (
								<Clock3 className="h-4 w-4 shrink-0" />
							) : (
								<Loader2 className="h-4 w-4 shrink-0 animate-spin" />
							)}
							<span>
								{isQueuedReview
									? "Queued for review. Waiting for earlier reviews to finish."
									: isReviewing
										? "Review is running now."
										: "Execution is running now."}
							</span>
						</div>
					)}

					<DetailSection title="Summary">
						<p className="whitespace-pre-wrap text-sm leading-6 text-zinc-300">
							{proposal.description || "No description provided."}
						</p>
					</DetailSection>

					<DetailSection title="Files">
						{proposal.filesAffected.length > 0 ? (
							<div className="space-y-2">
								{proposal.filesAffected.map((file) => (
									<div
										key={file}
										className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-300"
									>
										<FileCode2 className="h-4 w-4 text-zinc-500" />
										<span className="truncate">{toDisplayPath(file)}</span>
									</div>
								))}
							</div>
						) : (
							<p className="text-sm text-zinc-500">No affected files recorded.</p>
						)}
					</DetailSection>

					{proposal.reviewResult && (
						<DetailSection title="Review Result">
							<p className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-3 text-sm leading-6 text-zinc-300">
								{proposal.reviewResult}
							</p>
						</DetailSection>
					)}

					{proposal.executionResult && (
						<DetailSection title="Execution Result">
							<p className="whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-3 text-sm leading-6 text-zinc-300">
								{proposal.executionResult}
							</p>
						</DetailSection>
					)}

					{proposal.rejectionReason && (
						<DetailSection title="Rejection Reason">
							<p className="whitespace-pre-wrap rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-3 text-sm leading-6 text-red-200">
								{proposal.rejectionReason}
							</p>
						</DetailSection>
					)}

					{proposal.prUrl && (
						<DetailSection title="Pull Request">
							<div className="flex flex-wrap items-center gap-3">
								<a
									href={proposal.prUrl}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-flex items-center gap-2 text-sm text-[var(--nyx-accent)] hover:underline"
								>
									<ExternalLink className="h-4 w-4" />
									Open PR
								</a>
								{canMergePr && !hasConflict && (
									<Button
										onClick={() => onMergePr(proposal.id)}
										className="bg-emerald-600 text-white hover:bg-emerald-500"
									>
										<GitMerge className="mr-2 h-4 w-4" />
										Merge PR
									</Button>
								)}
							</div>
							{hasConflict && (
								<div className="mt-2 space-y-2">
									<div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-sm text-amber-300">
										<AlertTriangle className="h-4 w-4 shrink-0" />
										This PR has merge conflicts.
									</div>
									<div className="flex gap-2">
										{onRetry && (
											<Button
												onClick={() => onRetry(proposal.id)}
												variant="outline"
												className="border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
											>
												<RotateCcw className="mr-2 h-4 w-4" />
												Retry Execution
											</Button>
										)}
										{onRequeue && (
											<Button
												onClick={() => onRequeue(proposal.id)}
												variant="outline"
												className="border-zinc-700 text-zinc-300 hover:bg-zinc-700/50"
											>
												<Search className="mr-2 h-4 w-4" />
												Back to Review
											</Button>
										)}
									</div>
								</div>
							)}
						</DetailSection>
					)}
				</div>
			</ScrollArea>

			<div className="border-t border-zinc-800/80 px-5 py-4">
				<div className="flex flex-wrap gap-2">
					{reviewable && (
						<>
							<div className="flex">
								<Button
									onClick={() => onStartReview(proposal.id, reviewModel === "default" ? undefined : reviewModel)}
									variant="outline"
									className="rounded-r-none border-r-0 border-zinc-700"
								>
									<Search className="mr-2 h-4 w-4" />
									Review{reviewModel !== "default" ? ` (${selectedModelLabel})` : ""}
								</Button>
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button variant="outline" className="rounded-l-none border-zinc-700 px-2">
											<ChevronDown className="h-3.5 w-3.5" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start">
										{REVIEW_MODELS.map((m) => (
											<DropdownMenuItem
												key={m.id}
												onClick={() => setReviewModel(m.id)}
												className={cn(reviewModel === m.id && "bg-zinc-800")}
											>
												{m.label}
											</DropdownMenuItem>
										))}
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
							<Button onClick={() => onApprove(proposal.id)} className="bg-emerald-600 text-white hover:bg-emerald-500">
								<Check className="mr-2 h-4 w-4" />
								Approve
							</Button>
							<Button onClick={() => onReject(proposal.id)} variant="destructive">
								<X className="mr-2 h-4 w-4" />
								Reject
							</Button>
						</>
					)}
					{isApproved && onExecute && (
						<Button onClick={() => onExecute(proposal.id)} className="bg-amber-600 text-white hover:bg-amber-500">
							<Play className="mr-2 h-4 w-4" />
							Start
						</Button>
					)}
					{(isReviewing || isExecuting) && (
						<p className="text-sm text-zinc-400">
							{isReviewing ? "Review in progress." : "Execution in progress."}
						</p>
					)}
					{canCreatePr && (
						<Button onClick={() => onCreatePr(proposal.id)} variant="outline" className="border-zinc-700">
							<GitPullRequest className="mr-2 h-4 w-4" />
							Create PR
						</Button>
					)}
					{isTerminal && (
						<Button onClick={() => onDelete(proposal.id)} variant="outline" className="border-red-500/30 text-red-300 hover:bg-red-500/10">
							<Trash2 className="mr-2 h-4 w-4" />
							Delete
						</Button>
					)}
				</div>
				<Separator className="my-4 bg-zinc-800/80" />
				<div className="grid grid-cols-2 gap-3 text-xs text-zinc-500">
					<div>
						<p className="uppercase tracking-[0.16em] text-zinc-600">Created</p>
						<p className="mt-1 text-zinc-300">{new Date(proposal.createdAt).toLocaleString()}</p>
					</div>
					<div>
						<p className="uppercase tracking-[0.16em] text-zinc-600">Updated</p>
						<p className="mt-1 text-zinc-300">{new Date(proposal.updatedAt).toLocaleString()}</p>
					</div>
				</div>
			</div>
		</div>
	);
}

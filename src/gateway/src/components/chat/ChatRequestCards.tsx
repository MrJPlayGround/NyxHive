import { Check, FileCode2, X } from "lucide-react";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import type { RuntimeRequest } from "../../lib/chat-runtime";
import { toDisplayPath } from "../../lib/display-path";
import { cn } from "../../lib/utils";

interface ChatRequestCardsProps {
	requests: RuntimeRequest[];
	resolvingId?: string | null;
	onResolve: (requestId: string, action: "approve" | "reject") => void;
	className?: string;
}

export function ChatRequestCards({ requests, resolvingId, onResolve, className }: ChatRequestCardsProps) {
	if (requests.length === 0) return null;

	return (
		<div className={cn("mx-auto mb-3 flex max-w-6xl flex-col gap-2", className)}>
			{requests.map((request) => {
				const proposal = request.proposal;
				const isApproval = request.kind === "proposal_approval";
				return (
					<div
						key={request.requestId}
						className="rounded-xl border border-[rgb(var(--nyx-accent-rgb)/0.16)] bg-[rgba(8,18,34,0.94)] px-4 py-3"
					>
						<div className="flex items-start gap-3">
							<div className="mt-0.5 rounded-full border border-[rgb(var(--nyx-accent-rgb)/0.18)] bg-[rgb(var(--nyx-accent-rgb)/0.08)] p-2 text-[var(--nyx-accent)]">
								<FileCode2 className="h-4 w-4" />
							</div>
							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-center gap-2">
									<span className="rounded-full border border-[rgb(var(--nyx-accent-rgb)/0.16)] bg-[rgb(var(--nyx-accent-rgb)/0.08)] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-[var(--nyx-accent)]">
										This thread
									</span>
									<p className="text-sm font-medium text-zinc-100">{proposal?.title ?? request.title}</p>
									{proposal?.category ? (
										<Badge variant="secondary" className="border-white/10 bg-white/[0.04] text-[10px] uppercase tracking-[0.14em] text-zinc-400">
											{proposal.category}
										</Badge>
									) : null}
									{proposal?.effort ? (
										<span className="text-[11px] uppercase tracking-[0.16em] text-zinc-500">{proposal.effort}</span>
									) : null}
								</div>
								{proposal?.description || request.description ? (
									<p className="mt-1 text-sm leading-6 text-zinc-400">
										{proposal?.description ?? request.description}
									</p>
								) : null}
								{proposal?.filesAffected && proposal.filesAffected.length > 0 ? (
									<div className="mt-2 flex flex-wrap gap-1.5">
										{proposal.filesAffected.slice(0, 5).map((file) => (
											<span
												key={file}
												className="rounded-full border border-white/8 bg-white/[0.03] px-2 py-0.5 font-mono text-[11px] text-zinc-400"
											>
												{toDisplayPath(file)}
											</span>
										))}
										{proposal.filesAffected.length > 5 ? (
											<span className="rounded-full border border-white/8 bg-white/[0.03] px-2 py-0.5 text-[11px] text-zinc-500">
												+{proposal.filesAffected.length - 5} more
											</span>
										) : null}
									</div>
								) : null}
							</div>
							{isApproval ? (
								<div className="flex shrink-0 gap-2">
									<Button
										size="sm"
										onClick={() => onResolve(request.requestId, "approve")}
										disabled={resolvingId === request.requestId}
										className="bg-emerald-600 text-white hover:bg-emerald-500"
									>
										<Check className="mr-1.5 h-3.5 w-3.5" />
										Approve
									</Button>
									<Button
										size="sm"
										variant="outline"
										onClick={() => onResolve(request.requestId, "reject")}
										disabled={resolvingId === request.requestId}
										className="border-red-500/30 bg-red-500/5 text-red-300 hover:bg-red-500/10 hover:text-red-200"
									>
										<X className="mr-1.5 h-3.5 w-3.5" />
										Reject
									</Button>
								</div>
							) : (
								<div className="shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] uppercase tracking-[0.16em] text-zinc-400">
									Reply Below
								</div>
							)}
						</div>
					</div>
				);
			})}
		</div>
	);
}

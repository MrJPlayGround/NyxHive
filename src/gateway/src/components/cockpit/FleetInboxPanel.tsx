import { useState } from "react";
import { Check, ExternalLink, FileCode2, MessageCircleReply, X } from "lucide-react";
import type { RuntimeRequest } from "../../lib/chat-runtime";
import type { FleetInstance } from "../../stores/fleet-config";
import { cn } from "../../lib/utils";

interface FleetInboxItem {
	instance: FleetInstance;
	request: RuntimeRequest;
	active: boolean;
}

interface FleetInboxPanelProps {
	items: FleetInboxItem[];
	resolvingKey?: string | null;
	onOpen: (instanceId: string, threadId?: string) => void;
	onResolve: (
		instanceId: string,
		requestId: string,
		action: "approve" | "reject" | "respond",
		response?: string,
	) => void;
}

export function FleetInboxPanel({ items, resolvingKey, onOpen, onResolve }: FleetInboxPanelProps) {
	const [replyingKey, setReplyingKey] = useState<string | null>(null);
	const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});

	if (items.length === 0) return null;

	return (
		<div className="border-b border-[var(--nyx-line)] bg-[var(--nyx-panel-2)] px-5 py-3">
			<div className="mb-3 flex items-center justify-between">
				<div>
					<p className="text-[13px] font-semibold text-[var(--nyx-text)]">Fleet Inbox</p>
					<p className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">
						{items.length} open request{items.length === 1 ? "" : "s"}
					</p>
				</div>
			</div>
			<div className="grid gap-2 xl:grid-cols-2">
				{items.map(({ instance, request, active }) => {
					const isApproval = request.kind === "proposal_approval";
					const resolveKeyBase = `${instance.id}:${request.requestId}`;
					const replyKey = `${instance.id}:${request.requestId}`;
					const replyDraft = replyDrafts[replyKey] ?? "";
					return (
						<div
							key={`${instance.id}:${request.requestId}`}
							className={cn(
								"rounded-xl border px-4 py-3 transition-colors",
								active
									? "border-[rgb(var(--nyx-accent-rgb)/0.18)] bg-[rgb(var(--nyx-accent-rgb)/0.08)]"
									: "border-white/8 bg-white/[0.03]",
							)}
						>
							<div className="flex items-start gap-3">
								<div
									className="mt-0.5 h-8 w-1.5 shrink-0 rounded-full"
									style={{ backgroundColor: instance.color }}
								/>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-zinc-400">
											{instance.label}
										</span>
										<p className="truncate text-sm font-medium text-zinc-100">
											{request.proposal?.title ?? request.title}
										</p>
									</div>
									{request.description ? (
										<p className="mt-1 text-sm leading-6 text-zinc-400">
											{request.description}
										</p>
									) : null}
									<div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
										<span>{request.kind === "proposal_approval" ? "Approval" : "Reply needed"}</span>
										{request.threadId ? (
											<>
												<span>·</span>
												<span className="font-mono">{request.threadId.slice(0, 8)}</span>
											</>
										) : null}
									</div>
								</div>
								<FileCode2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--nyx-accent)]" />
							</div>
							<div className="mt-3 flex flex-wrap items-center gap-2">
								<button
									type="button"
									onClick={() => onOpen(instance.id, request.threadId)}
									className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] text-zinc-300 transition-colors hover:border-[rgb(var(--nyx-accent-rgb)/0.18)] hover:text-zinc-100"
								>
									<ExternalLink className="h-3.5 w-3.5" />
									Open
								</button>
								{isApproval ? (
									<>
										<button
											type="button"
											onClick={() => onResolve(instance.id, request.requestId, "approve")}
											disabled={resolvingKey === `${resolveKeyBase}:approve`}
											className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-white transition-colors hover:bg-emerald-500 disabled:opacity-60"
										>
											<Check className="h-3.5 w-3.5" />
											Approve
										</button>
										<button
											type="button"
											onClick={() => onResolve(instance.id, request.requestId, "reject")}
											disabled={resolvingKey === `${resolveKeyBase}:reject`}
											className="inline-flex items-center gap-1.5 rounded-full border border-red-500/30 bg-red-500/5 px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-red-300 transition-colors hover:bg-red-500/10 hover:text-red-200 disabled:opacity-60"
										>
											<X className="h-3.5 w-3.5" />
											Reject
										</button>
									</>
								) : (
									<button
										type="button"
										onClick={() => setReplyingKey((current) => current === replyKey ? null : replyKey)}
										className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] text-zinc-300 transition-colors hover:border-[rgb(var(--nyx-accent-rgb)/0.18)] hover:text-zinc-100"
									>
										<MessageCircleReply className="h-3.5 w-3.5" />
										Quick reply
									</button>
								)}
							</div>
							{!isApproval && replyingKey === replyKey ? (
								<div className="mt-3 rounded-xl border border-white/8 bg-black/20 p-3">
									<textarea
										value={replyDraft}
										onChange={(event) => {
											const nextValue = event.target.value;
											setReplyDrafts((current) => ({ ...current, [replyKey]: nextValue }));
										}}
										rows={3}
										placeholder="Reply without leaving the inbox..."
										className="min-h-[5.5rem] w-full resize-y rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-[rgb(var(--nyx-accent-rgb)/0.18)]"
									/>
									<div className="mt-3 flex items-center justify-between gap-3">
										<p className="text-[11px] text-zinc-500">
											This resolves the request and posts your reply back to the thread.
										</p>
										<div className="flex items-center gap-2">
											<button
												type="button"
												onClick={() => setReplyingKey(null)}
												className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] uppercase tracking-[0.14em] text-zinc-400 transition-colors hover:text-zinc-200"
											>
												Cancel
											</button>
											<button
												type="button"
												disabled={!replyDraft.trim() || resolvingKey === `${resolveKeyBase}:respond`}
												onClick={() => {
													onResolve(instance.id, request.requestId, "respond", replyDraft.trim());
													setReplyingKey(null);
													setReplyDrafts((current) => ({ ...current, [replyKey]: "" }));
												}}
												className="rounded-full bg-[var(--nyx-accent)] px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--nyx-bg)] transition-colors hover:bg-[var(--nyx-accent-2)] disabled:cursor-not-allowed disabled:opacity-50"
											>
												Send reply
											</button>
										</div>
									</div>
								</div>
							) : null}
						</div>
					);
				})}
			</div>
		</div>
	);
}

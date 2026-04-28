import {
	AlertTriangle,
	CheckCircle2,
	Clock3,
	FileCode2,
	Loader2,
	MessageSquareText,
	Paperclip,
	Radio,
	Settings2,
	SquareTerminal,
	Trash2,
	X,
} from "lucide-react";
import { useMemo } from "react";
import { ScrollArea } from "../ui/scroll-area";
import { ExecutionPanel } from "../chat/ExecutionPanel";
import { ThreadChangesPanel } from "../chat/ThreadChangesPanel";
import { cn } from "../../lib/utils";
import { toDisplayPath } from "../../lib/display-path";
import type {
	RuntimeRequest,
	TerminalSnippet,
	ThreadChange,
} from "../../lib/chat-runtime";
import type { ChatModelInfo, ExecutionEvent } from "../../stores/chat";
import type { FleetRuntimeState } from "../../stores/fleet-chat";

export type CockpitInspectorTab =
	| "activity"
	| "files"
	| "approvals"
	| "artifacts"
	| "status";

interface CockpitInspectorPanelProps {
	activeTab: CockpitInspectorTab;
	onTabChange: (tab: CockpitInspectorTab) => void;
	onClose: () => void;
	executionEvents: ExecutionEvent[];
	threadChanges: ThreadChange[];
	selectedPath: string | null;
	pendingRequests: RuntimeRequest[];
	resolvingRequestId: string | null;
	terminalSnippets: TerminalSnippet[];
	streaming: boolean;
	contextPct: number | null;
	modelInfo: ChatModelInfo | null;
	modelLoading: boolean;
	activeAgent: string;
	threadId: string | null;
	queuedCount: number;
	runtime: FleetRuntimeState;
	connectionReady: boolean;
	onOpenChange: (path: string) => void;
	onAttachSnippet: (itemId: string, label: string, content: string) => void;
	onResolveRequest: (requestId: string, action: "approve" | "reject") => void;
	onRemoveSnippet: (snippetId: string) => void;
}

interface InspectorTabConfig {
	id: CockpitInspectorTab;
	label: string;
	icon: typeof SquareTerminal;
	count?: number;
	live?: boolean;
}

function formatClock(timestamp: number | null): string {
	if (!timestamp) return "none";
	return new Intl.DateTimeFormat([], {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	}).format(timestamp);
}

function formatContextPct(pct: number | null): string {
	if (pct === null || !Number.isFinite(pct)) return "unknown";
	if (pct > 100) return "100%+";
	if (pct < 0) return "0%";
	return `${pct}%`;
}

function SnippetPreview({ content }: { content: string }) {
	const lines = content.split("\n");
	const preview = lines.slice(0, 5).join("\n");
	return (
		<pre className="max-h-32 overflow-hidden whitespace-pre-wrap rounded-md border border-[var(--nyx-line)] bg-black/20 px-3 py-2 font-mono text-[10px] leading-5 text-zinc-400">
			{preview}
			{lines.length > 5 ? `\n... ${lines.length - 5} more lines` : ""}
		</pre>
	);
}

function EmptyState({
	icon: Icon,
	title,
	body,
}: {
	icon: typeof SquareTerminal;
	title: string;
	body: string;
}) {
	return (
		<div className="flex h-full items-center justify-center px-6 text-center">
			<div className="flex max-w-xs flex-col items-center gap-2">
				<Icon className="h-5 w-5 text-zinc-600" />
				<p className="text-sm font-medium text-zinc-300">{title}</p>
				<p className="text-xs leading-5 text-zinc-500">{body}</p>
			</div>
		</div>
	);
}

function ApprovalsTab({
	requests,
	resolvingRequestId,
	onResolveRequest,
}: {
	requests: RuntimeRequest[];
	resolvingRequestId: string | null;
	onResolveRequest: (requestId: string, action: "approve" | "reject") => void;
}) {
	if (requests.length === 0) {
		return (
			<EmptyState
				icon={MessageSquareText}
				title="No pending approvals"
				body="Runtime requests will land here without opening a separate backend surface."
			/>
		);
	}

	return (
		<ScrollArea className="h-full">
			<div className="space-y-3 p-3">
				{requests.map((request) => {
					const proposal = request.proposal;
					const isApproval = request.kind === "proposal_approval";
					const busy = resolvingRequestId === request.requestId;
					return (
						<div
							key={request.requestId}
							className="rounded-lg border border-[rgb(var(--nyx-accent-rgb)/0.14)] bg-white/[0.03] p-3"
						>
							<div className="flex items-start gap-3">
								<div className="rounded-md border border-[rgb(var(--nyx-accent-rgb)/0.16)] bg-[rgb(var(--nyx-accent-rgb)/0.08)] p-2 text-[var(--nyx-accent)]">
									<MessageSquareText className="h-4 w-4" />
								</div>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="rounded-full border border-white/10 bg-white/[0.03] px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-zinc-500">
											{request.kind === "proposal_approval" ? "Approval" : "Input"}
										</span>
										{request.threadId ? (
											<span className="font-mono text-[10px] text-zinc-600">
												{request.threadId.slice(0, 8)}
											</span>
										) : null}
									</div>
									<p className="mt-2 text-sm font-medium leading-5 text-zinc-100">
										{proposal?.title ?? request.title}
									</p>
									{proposal?.description || request.description ? (
										<p className="mt-1 text-xs leading-5 text-zinc-500">
											{proposal?.description ?? request.description}
										</p>
									) : null}
									{proposal?.filesAffected && proposal.filesAffected.length > 0 ? (
										<div className="mt-2 flex flex-wrap gap-1.5">
											{proposal.filesAffected.slice(0, 4).map((file) => (
												<span
													key={file}
													className="rounded border border-white/8 bg-black/20 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500"
												>
													{toDisplayPath(file)}
												</span>
											))}
											{proposal.filesAffected.length > 4 ? (
												<span className="rounded border border-white/8 bg-black/20 px-1.5 py-0.5 text-[10px] text-zinc-600">
													+{proposal.filesAffected.length - 4}
												</span>
											) : null}
										</div>
									) : null}
								</div>
							</div>
							{isApproval ? (
								<div className="mt-3 flex gap-2">
									<button
										type="button"
										onClick={() => onResolveRequest(request.requestId, "approve")}
										disabled={busy}
										className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/15 disabled:cursor-not-allowed disabled:opacity-50"
									>
										<CheckCircle2 className="h-3.5 w-3.5" />
										Approve
									</button>
									<button
										type="button"
										onClick={() => onResolveRequest(request.requestId, "reject")}
										disabled={busy}
										className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-red-500/25 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/15 disabled:cursor-not-allowed disabled:opacity-50"
									>
										<X className="h-3.5 w-3.5" />
										Reject
									</button>
								</div>
							) : (
								<p className="mt-3 rounded-md border border-white/8 bg-black/20 px-3 py-2 text-xs text-zinc-500">
									Reply in the composer to satisfy this request.
								</p>
							)}
						</div>
					);
				})}
			</div>
		</ScrollArea>
	);
}

function ArtifactsTab({
	snippets,
	onRemoveSnippet,
}: {
	snippets: TerminalSnippet[];
	onRemoveSnippet: (snippetId: string) => void;
}) {
	if (snippets.length === 0) {
		return (
			<EmptyState
				icon={Paperclip}
				title="No snippets queued"
				body="Trace output and diff summaries attached to the composer will appear here."
			/>
		);
	}

	return (
		<ScrollArea className="h-full">
			<div className="space-y-3 p-3">
				{snippets.map((snippet) => (
					<div
						key={snippet.id}
						className="rounded-lg border border-white/8 bg-white/[0.03] p-3"
					>
						<div className="mb-2 flex items-start gap-2">
							<Paperclip className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--nyx-accent)]" />
							<div className="min-w-0 flex-1">
								<p className="truncate text-xs font-medium text-zinc-200">
									{snippet.label}
								</p>
								<p className="mt-1 font-mono text-[10px] text-zinc-600">
									{snippet.lineEnd - snippet.lineStart + 1} line
									{snippet.lineEnd === snippet.lineStart ? "" : "s"} ·{" "}
									{formatClock(snippet.createdAt)}
								</p>
							</div>
							<button
								type="button"
								onClick={() => onRemoveSnippet(snippet.id)}
								className="rounded-md border border-transparent p-1 text-zinc-600 transition-colors hover:border-white/10 hover:bg-white/[0.04] hover:text-zinc-300"
								title="Remove snippet"
							>
								<Trash2 className="h-3.5 w-3.5" />
							</button>
						</div>
						<SnippetPreview content={snippet.content} />
					</div>
				))}
			</div>
		</ScrollArea>
	);
}

function StatusRow({
	label,
	value,
	tone = "default",
}: {
	label: string;
	value: string;
	tone?: "default" | "accent" | "warn" | "danger";
}) {
	return (
		<div className="flex items-center justify-between gap-3 border-b border-white/6 py-2 last:border-b-0">
			<span className="text-xs text-zinc-500">{label}</span>
			<span
				className={cn(
					"min-w-0 truncate text-right text-xs font-medium",
					tone === "accent" && "text-[var(--nyx-accent)]",
					tone === "warn" && "text-[var(--nyx-warn)]",
					tone === "danger" && "text-[var(--nyx-danger)]",
					tone === "default" && "text-zinc-300",
				)}
			>
				{value}
			</span>
		</div>
	);
}

function StatusTab({
	streaming,
	contextPct,
	modelInfo,
	modelLoading,
	activeAgent,
	threadId,
	queuedCount,
	runtime,
	connectionReady,
}: {
	streaming: boolean;
	contextPct: number | null;
	modelInfo: ChatModelInfo | null;
	modelLoading: boolean;
	activeAgent: string;
	threadId: string | null;
	queuedCount: number;
	runtime: FleetRuntimeState;
	connectionReady: boolean;
}) {
	const contextTone =
		contextPct !== null && contextPct > 80
			? "danger"
			: contextPct !== null && contextPct > 50
				? "warn"
				: "accent";

	return (
		<ScrollArea className="h-full">
			<div className="space-y-3 p-3">
				<div className="rounded-lg border border-white/8 bg-white/[0.03] p-3">
					<div className="mb-2 flex items-center gap-2">
						{streaming ? (
							<Loader2 className="h-4 w-4 animate-spin text-[var(--nyx-accent)]" />
						) : connectionReady ? (
							<Radio className="h-4 w-4 text-[var(--nyx-accent)]" />
						) : (
							<AlertTriangle className="h-4 w-4 text-[var(--nyx-danger)]" />
						)}
						<p className="text-sm font-semibold text-zinc-200">Runtime</p>
					</div>
					<StatusRow
						label="Connection"
						value={connectionReady ? "ready" : "blocked"}
						tone={connectionReady ? "accent" : "danger"}
					/>
					<StatusRow
						label="Stream"
						value={streaming ? "live" : "idle"}
						tone={streaming ? "accent" : "default"}
					/>
					<StatusRow label="Runtime presence" value={runtime.presence} />
					<StatusRow label="Queued follow-ups" value={String(queuedCount)} />
				</div>

				<div className="rounded-lg border border-white/8 bg-white/[0.03] p-3">
					<div className="mb-2 flex items-center gap-2">
						<Settings2 className="h-4 w-4 text-[var(--nyx-accent)]" />
						<p className="text-sm font-semibold text-zinc-200">Model</p>
					</div>
					<StatusRow label="Agent" value={activeAgent} />
					<StatusRow
						label="Provider"
						value={modelLoading ? "loading" : (modelInfo?.provider ?? "unknown")}
						tone={modelLoading ? "warn" : "default"}
					/>
					<StatusRow label="Model" value={modelInfo?.model ?? "unknown"} />
					<StatusRow
						label="Override"
						value={modelInfo?.overridden ? "active" : "agent default"}
						tone={modelInfo?.overridden ? "accent" : "default"}
					/>
					{modelInfo?.warning ? (
						<StatusRow label="Warning" value={modelInfo.warning} tone="warn" />
					) : null}
				</div>

				<div className="rounded-lg border border-white/8 bg-white/[0.03] p-3">
					<div className="mb-2 flex items-center gap-2">
						<Clock3 className="h-4 w-4 text-[var(--nyx-accent)]" />
						<p className="text-sm font-semibold text-zinc-200">Thread</p>
					</div>
					<StatusRow
						label="Thread"
						value={threadId ? threadId.slice(0, 12) : "new"}
					/>
					<StatusRow label="Active run" value={runtime.activeRunId ?? "none"} />
					<StatusRow
						label="Last event"
						value={formatClock(runtime.lastEventAt)}
					/>
					<StatusRow
						label="Last completed"
						value={formatClock(runtime.lastCompletedAt)}
					/>
					<StatusRow
						label="Context"
						value={formatContextPct(contextPct)}
						tone={contextTone}
					/>
					{contextPct !== null ? (
						<div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
							<div
								className={cn(
									"h-full rounded-full",
									contextPct > 80
										? "bg-[var(--nyx-danger)]"
										: contextPct > 50
											? "bg-[var(--nyx-warn)]"
											: "bg-[var(--nyx-accent)]",
								)}
								style={{ width: `${Math.min(Math.max(contextPct, 0), 100)}%` }}
							/>
						</div>
					) : null}
				</div>
			</div>
		</ScrollArea>
	);
}

export function CockpitInspectorPanel({
	activeTab,
	onTabChange,
	onClose,
	executionEvents,
	threadChanges,
	selectedPath,
	pendingRequests,
	resolvingRequestId,
	terminalSnippets,
	streaming,
	contextPct,
	modelInfo,
	modelLoading,
	activeAgent,
	threadId,
	queuedCount,
	runtime,
	connectionReady,
	onOpenChange,
	onAttachSnippet,
	onResolveRequest,
	onRemoveSnippet,
}: CockpitInspectorPanelProps) {
	const tabs = useMemo<InspectorTabConfig[]>(
		() => [
			{
				id: "activity",
				label: "Activity",
				icon: SquareTerminal,
				count: executionEvents.length,
				live: streaming,
			},
			{
				id: "files",
				label: "Files",
				icon: FileCode2,
				count: threadChanges.length,
			},
			{
				id: "approvals",
				label: "Approvals",
				icon: MessageSquareText,
				count: pendingRequests.length,
			},
			{
				id: "artifacts",
				label: "Artifacts",
				icon: Paperclip,
				count: terminalSnippets.length,
			},
			{
				id: "status",
				label: "Status",
				icon: Radio,
				live: streaming,
			},
		],
		[
			executionEvents.length,
			pendingRequests.length,
			streaming,
			terminalSnippets.length,
			threadChanges.length,
		],
	);

	return (
		<div className="flex h-full min-h-0 flex-col bg-[var(--nyx-panel-2)]">
			<div className="flex items-center justify-between border-b border-[var(--nyx-line)] px-4 py-3">
				<div>
					<p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-zinc-400">
						Workspace Inspector
					</p>
					<p className="mt-1 text-[11px] text-zinc-500">
						Runtime state from this cockpit thread
					</p>
				</div>
				<button
					type="button"
					onClick={onClose}
					className="rounded-md border border-transparent p-1.5 text-zinc-500 transition-colors hover:border-white/10 hover:bg-white/[0.03] hover:text-zinc-300"
					title="Close inspector"
				>
					<X className="h-4 w-4" />
				</button>
			</div>

			<div className="flex shrink-0 overflow-x-auto border-b border-[var(--nyx-line)] px-2">
				{tabs.map((tab) => {
					const Icon = tab.icon;
					const active = activeTab === tab.id;
					return (
						<button
							key={tab.id}
							type="button"
							onClick={() => onTabChange(tab.id)}
							className={cn(
								"relative flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-xs font-medium transition-colors",
								active
									? "border-[var(--nyx-accent)] text-[var(--nyx-accent)]"
									: "border-transparent text-zinc-500 hover:text-zinc-300",
							)}
						>
							<Icon className="h-3.5 w-3.5" />
							<span>{tab.label}</span>
							{tab.count ? (
								<span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[9px] text-zinc-400">
									{tab.count}
								</span>
							) : null}
							{tab.live ? (
								<span className="h-1.5 w-1.5 rounded-full bg-[var(--nyx-accent)] shadow-[0_0_6px_var(--nyx-accent-glow)]" />
							) : null}
						</button>
					);
				})}
			</div>

			<div className="min-h-0 flex-1 overflow-hidden">
				{activeTab === "activity" ? (
					<ExecutionPanel
						events={executionEvents}
						streaming={streaming}
						onOpenChange={onOpenChange}
						onAttachSnippet={onAttachSnippet}
						className="h-full border-0"
					/>
				) : null}
				{activeTab === "files" ? (
					<ThreadChangesPanel
						changes={threadChanges}
						selectedPath={selectedPath}
						onSelectPath={onOpenChange}
						onAttachSnippet={(label, content) => {
							onAttachSnippet(`diff:${label}`, label, content);
						}}
						className="h-full border-0"
					/>
				) : null}
				{activeTab === "approvals" ? (
					<ApprovalsTab
						requests={pendingRequests}
						resolvingRequestId={resolvingRequestId}
						onResolveRequest={onResolveRequest}
					/>
				) : null}
				{activeTab === "artifacts" ? (
					<ArtifactsTab
						snippets={terminalSnippets}
						onRemoveSnippet={onRemoveSnippet}
					/>
				) : null}
				{activeTab === "status" ? (
					<StatusTab
						streaming={streaming}
						contextPct={contextPct}
						modelInfo={modelInfo}
						modelLoading={modelLoading}
						activeAgent={activeAgent}
						threadId={threadId}
						queuedCount={queuedCount}
						runtime={runtime}
						connectionReady={connectionReady}
					/>
				) : null}
			</div>
		</div>
	);
}

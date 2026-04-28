import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "../stores/chat";
import { useAuthStore } from "../stores/auth";
import { useWsEvent } from "../hooks/useWs";
import { gateway } from "../lib/ws";
import { uuid } from "../lib/utils";
import { MessageList } from "../components/chat/MessageList";
import { MessageInput } from "../components/chat/MessageInput";
import { AgentSelector } from "../components/chat/AgentSelector";
import { ChatSidebar } from "../components/chat/ChatSidebar";
import { ExecutionPanel } from "../components/chat/ExecutionPanel";
import { ThreadChangesPanel } from "../components/chat/ThreadChangesPanel";
import { ChatRequestCards } from "../components/chat/ChatRequestCards";
import { Activity, Brain, FileCode2, Maximize, Minimize, PanelRightClose, PanelRight, Wrench } from "lucide-react";
import { useUiPrefs } from "../stores/ui-prefs";
import type { Frame } from "../../protocol/frame";
import type { ChatAttachment, ChatMessage, ExecutionEvent } from "../stores/chat";
import { formatElapsed } from "../lib/format";
import { resolveRuntimeEvents } from "../lib/chat-runtime";
import { handleLocalSlashCommand, SLASH_COMMANDS } from "../lib/chat-commands";
import { shouldSyncGatewayLeadAgent } from "../lib/lead-selection";
import { describeChatActivity } from "../components/chat/message-execution";

/** Filter events to only handle gateway channel (ignore telegram, discord, etc.) */
function isGatewayEvent(frame: Frame): boolean {
	const payload = frame.payload as { data?: { channel?: string }; channel?: string };
	const channel = payload.data?.channel ?? payload.channel;
	return !channel || channel === "gateway";
}

function formatContextPct(pct: number): string {
	if (!Number.isFinite(pct)) return "0%";
	if (pct > 100) return "100%+";
	if (pct < 0) return "0%";
	return `${pct}%`;
}

const EXEC_RAIL_AUTO_COLLAPSE_MAX_WIDTH = 1680;
const EMPTY_CHAT_SUGGESTIONS = [
	"Check system health",
	"Summarize recent activity",
	"List pending approvals",
	"What are you working on?",
];

function StreamingBar({
	message,
	latestEvent,
	eventCount,
	queuedCount,
	hasTrace,
	traceOpen,
	onToggleTrace,
}: {
	message: ChatMessage | null;
	latestEvent?: ExecutionEvent;
	eventCount: number;
	queuedCount: number;
	hasTrace: boolean;
	traceOpen: boolean;
	onToggleTrace: () => void;
}) {
	const [now, setNow] = useState(() => Date.now());
	const [expanded, setExpanded] = useState(false);

	useEffect(() => {
		if (!message) return;
		const interval = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(interval);
	}, [message]);

	if (!message) return null;

	const elapsed = Math.max(0, Math.floor((now - message.timestamp) / 1000));
	const totalTokens = (message.tokensIn ?? 0) + (message.tokensOut ?? 0);
	const activity = describeChatActivity(message.activity, latestEvent);
	const detailLines = [
		latestEvent ? `Current detail: ${latestEvent.title}` : null,
		eventCount > 0 ? `${eventCount} trace event${eventCount === 1 ? "" : "s"} captured` : null,
		queuedCount > 0 ? `${queuedCount} queued follow-up${queuedCount === 1 ? "" : "s"}` : null,
		totalTokens > 0 ? `${totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens} tokens so far` : null,
	].filter(Boolean);

	return (
		<div className="border-b border-[rgb(var(--nyx-accent-rgb)/0.12)] bg-[rgb(var(--nyx-accent-rgb)/0.03)] px-4 py-2">
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={() => setExpanded((value) => !value)}
					className="flex min-w-0 flex-1 items-center gap-2 text-left"
					aria-expanded={expanded}
				>
					<div className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--nyx-accent)] shadow-[0_0_6px_var(--nyx-accent-glow)]" />
					<span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--nyx-accent)]">
						Live
					</span>
					<span className="min-w-0 truncate text-xs text-zinc-300">
						{activity}
					</span>
				</button>
				<div className="hidden shrink-0 items-center gap-2 text-[11px] text-zinc-500 sm:flex">
					<span className="tabular-nums">{formatElapsed(elapsed)}</span>
					{queuedCount > 0 ? <span>{queuedCount} queued</span> : null}
				</div>
				<button
					type="button"
					onClick={hasTrace ? onToggleTrace : () => setExpanded((value) => !value)}
					className="hidden shrink-0 items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-zinc-400 transition-colors hover:border-[rgb(var(--nyx-accent-rgb)/0.24)] hover:text-zinc-100 lg:flex"
					title={hasTrace ? (traceOpen ? "Collapse trace rail" : "Open trace rail") : (expanded ? "Hide details" : "Show details")}
				>
					<Activity className="h-3.5 w-3.5 text-[var(--nyx-accent)]" />
					<span>{hasTrace ? "Trace" : "Details"}</span>
					<span className="font-mono text-zinc-500">{eventCount}</span>
				</button>
			</div>
			{expanded && detailLines.length > 0 ? (
				<div className="mt-2 rounded-md border border-white/8 bg-black/15 px-3 py-2 text-[11px] leading-5 text-zinc-400">
					{detailLines.map((line) => (
						<div key={line}>{line}</div>
					))}
				</div>
			) : null}
		</div>
	);
}

export function ChatPage() {
	const sidebarCollapsed = useChatStore((s) => s.sidebarCollapsed);
	const toggleSidebar = useChatStore((s) => s.toggleSidebar);
	const threadId = useChatStore((s) => s.threadId);
	const {
		messages,
		activeAgent,
		streaming,
		sendMessage,
		abortStream,
		setActiveAgent,
		loadModelInfo,
		setModelOverride,
		clearMessages,
		contextPct,
		executionEvents,
		threadChanges,
		selectedChangePath,
		diffOpen,
		modelInfo,
		modelLoading,
		queuedMessages,
		pendingRequests,
		loadRequests,
		resolveRequest,
		selectChangePath,
		setDiffOpen,
		addTerminalSnippet,
		removeTerminalSnippet,
		terminalSnippets,
		applyRuntimeEvent,
	} = useChatStore();
	const queuedCount = queuedMessages.length;
	const { authenticated, reconnecting, leadAgent } = useAuthStore();
	const { showReasoning, showToolCalls, focusMode, toggleReasoning, toggleToolCalls, toggleFocusMode } = useUiPrefs();
	const activeThreadRequests = pendingRequests.filter((request) => request.threadId && request.threadId === threadId);
	const inboxRequests = pendingRequests.filter((request) => !request.threadId || request.threadId !== threadId);

	useEffect(() => {
		if (!shouldSyncGatewayLeadAgent({ authenticated, leadAgent, threadId, activeAgent })) return;
		setActiveAgent(leadAgent);
	}, [authenticated, leadAgent, threadId, activeAgent, setActiveAgent]);

	// Restore chat history once authenticated and store hydrated
	useEffect(() => {
		if (!authenticated) return;

		let cancelled = false;
		const doRestore = async () => {
			// Wait for store hydration if not done yet
			if (!useChatStore.persist.hasHydrated()) {
				await new Promise<void>((resolve) => {
					const unsub = useChatStore.persist.onFinishHydration(() => {
						unsub();
						resolve();
					});
				});
			}
			if (cancelled) return;

			const { threadId, messages } = useChatStore.getState();
			if (!threadId) return;
			// Skip reload if we already have messages (e.g. reconnection after brief WS drop)
			if (messages.length > 0) {
				console.log(`[chat] restore: skipping — already have ${messages.length} msgs`);
				return;
			}

			console.log(`[chat] restore: loading history for ${threadId}`);
			await useChatStore.getState().loadHistory(threadId);
			console.log(`[chat] restore: done, ${useChatStore.getState().messages.length} msgs`);
		};

		doRestore();
		return () => { cancelled = true; };
	}, [authenticated]);

	useEffect(() => {
		if (!authenticated) return;
		loadModelInfo().catch((err) => console.error("[chat.model] load failed:", err));
		loadRequests().catch((err) => console.error("[chat.requests] load failed:", err));
	}, [authenticated, activeAgent, threadId, loadModelInfo, loadRequests]);

	// Safety timeout per thread: if streaming but no delta/progress/heartbeat for 5min, force-end
	const streamTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
	const STREAM_TIMEOUT_MS = 300_000; // 5 minutes
	const resetStreamTimeout = useCallback((threadId?: string) => {
		const tid = threadId ?? useChatStore.getState().threadId;
		if (!tid) return;
		const existing = streamTimeoutsRef.current.get(tid);
		if (existing) clearTimeout(existing);
		streamTimeoutsRef.current.set(tid, setTimeout(() => {
			streamTimeoutsRef.current.delete(tid);
			const state = useChatStore.getState();
			const isStreaming = state._streamingThreads.has(tid);
			if (isStreaming) {
				console.warn(`[chat] Stream timeout for thread ${tid.slice(0, 8)} — no events for 5min, force-ending`);
				state.appendStream("\n\n[Stream timed out]", true, tid);
			}
		}, STREAM_TIMEOUT_MS));
	}, []);

	// Auto-finalize per thread — polls server when no deltas arrive
	const autoFinalizeRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
	const lastProgressRef = useRef<Map<string, number>>(new Map());
	const AUTO_FINALIZE_MS = 10_000;
	const AUTO_FINALIZE_ACTIVE_MS = 30_000; // re-poll interval when agent is still active
	const scheduleAutoFinalize = useCallback((threadId?: string, delayMs?: number) => {
		const tid = threadId ?? useChatStore.getState().threadId;
		if (!tid) return;
		const existing = autoFinalizeRef.current.get(tid);
		if (existing) clearTimeout(existing);
		// If we've seen tool activity recently, use a longer initial delay
		const lastProgress = lastProgressRef.current.get(tid) ?? 0;
		const recentToolActivity = Date.now() - lastProgress < 5_000;
		const delay = delayMs ?? (recentToolActivity ? AUTO_FINALIZE_ACTIVE_MS : AUTO_FINALIZE_MS);
		autoFinalizeRef.current.set(tid, setTimeout(async () => {
			autoFinalizeRef.current.delete(tid);
			const state = useChatStore.getState();
			const isStreaming = state._streamingThreads.has(tid);
			if (!isStreaming) return;
			try {
				const status = await gateway.request<{ active: boolean }>("chat.status", { threadId: tid });
				if (!status.active) {
					console.warn(`[chat] Auto-finalize: server reports agent idle for thread ${tid.slice(0, 8)}, closing stream`);
					state.appendStream("", true, tid);
				} else {
					// Agent still active — re-poll after a longer interval
					scheduleAutoFinalize(tid, AUTO_FINALIZE_ACTIVE_MS);
				}
			} catch {
				// Server unreachable — the 5min timeout will handle it
			}
		}, delay));
	}, []);

	// Ephemeral BTW answer state
	const [ephemeralBtw, setEphemeralBtw] = useState<string | null>(null);

	// Execution rail collapse state
	const [execRailCollapsed, setExecRailCollapsed] = useState(true);
	const execRailAutoCollapseAppliedRef = useRef(false);
	const [resolvingRequestId, setResolvingRequestId] = useState<string | null>(null);

	const handleResolveRequest = useCallback(async (requestId: string, action: "approve" | "reject") => {
		setResolvingRequestId(requestId);
		try {
			await resolveRequest(requestId, action);
		} catch (err) {
			console.error("[chat.request.resolve] failed:", err);
		} finally {
			setResolvingRequestId(null);
		}
	}, [resolveRequest]);

	// Handle slash commands locally, route btw/steer during streaming
	const { newThread } = useChatStore();
	const handleSend = useCallback(
		(content: string, attachments?: ChatAttachment[]) => {
			const trimmed = content.trim();
			const lower = trimmed.toLowerCase();

			if (handleLocalSlashCommand({
				content,
				attachments,
				state: useChatStore.getState(),
				contextPct,
				gateway,
				sendMessage: (nextContent, nextAttachments) => {
					sendMessage(nextContent, nextAttachments);
					resetStreamTimeout();
				},
				clearMessages,
				abortStream,
				setModelOverride: (model) => { void setModelOverride(model); },
				setActiveAgent,
				newThread,
				setEphemeralBtw,
				appendUserMessage: (message) => {
					useChatStore.setState((s) => ({
						messages: [...s.messages, {
							id: uuid(),
							role: "user" as const,
							content: message,
							timestamp: Date.now(),
						}],
					}));
				},
			})) {
				return;
			}

			// During streaming: implicit "btw" routing, otherwise queue as normal message
			const state = useChatStore.getState();
			if (state.streaming) {
				const isBtw = lower.startsWith("btw ");

				if (isBtw) {
					const question = trimmed.slice(4).trim();
					if (!question) return;
					gateway.request<{ answer: string }>("chat.btw", {
						agent: state.activeAgent,
						question,
						threadId: state.threadId,
					}).then((res) => {
						setEphemeralBtw(res.answer);
					}).catch((err) => {
						console.error("[chat.btw] failed:", err);
						setEphemeralBtw(`Failed: ${err instanceof Error ? err.message : "Unknown error"}`);
					});
					return;
				}
				// Fall through — send as normal queued message
			}

			sendMessage(content, attachments);
			resetStreamTimeout();
		},
		[sendMessage, clearMessages, resetStreamTimeout, abortStream, setModelOverride, setActiveAgent, newThread],
	);

	const clearThreadTimers = useCallback((threadId?: string) => {
		if (threadId) {
			const streamTimer = streamTimeoutsRef.current.get(threadId);
			if (streamTimer) {
				clearTimeout(streamTimer);
				streamTimeoutsRef.current.delete(threadId);
			}
			const autoFinalizeTimer = autoFinalizeRef.current.get(threadId);
			if (autoFinalizeTimer) {
				clearTimeout(autoFinalizeTimer);
				autoFinalizeRef.current.delete(threadId);
			}
			lastProgressRef.current.delete(threadId);
			return;
		}
		for (const timer of streamTimeoutsRef.current.values()) clearTimeout(timer);
		streamTimeoutsRef.current.clear();
		for (const timer of autoFinalizeRef.current.values()) clearTimeout(timer);
		autoFinalizeRef.current.clear();
		lastProgressRef.current.clear();
	}, []);

	const handleRuntimeFrame = useCallback(
		(frame: Frame) => {
			if (!isGatewayEvent(frame)) return;
			const events = resolveRuntimeEvents(frame);
			for (const event of events) {
				if (
					event.type === "response.delta"
					|| event.type === "activity.updated"
					|| event.type === "heartbeat"
					|| event.type === "chat.active"
					|| event.type === "thread.started"
					|| event.type === "turn.started"
					|| event.type === "item.started"
					|| event.type === "item.updated"
				) {
					const threadId = "threadId" in event ? event.threadId : undefined;
					resetStreamTimeout(threadId);
					if (event.type === "response.delta" || event.type === "thread.started" || event.type === "turn.started" || event.type === "chat.active") {
						scheduleAutoFinalize(threadId);
					}
					if (event.type === "activity.updated" || event.type === "item.started" || event.type === "item.updated") {
						const activeThreadId = threadId ?? useChatStore.getState().threadId;
						if (activeThreadId) lastProgressRef.current.set(activeThreadId, Date.now());
					}
				}
				if (event.type === "turn.completed") {
					clearThreadTimers(event.threadId);
				}
				applyRuntimeEvent(event);
			}
		},
		[applyRuntimeEvent, clearThreadTimers, resetStreamTimeout, scheduleAutoFinalize],
	);

	// Clear timeouts on unmount
	useEffect(() => {
		return () => {
			for (const t of streamTimeoutsRef.current.values()) clearTimeout(t);
			for (const t of autoFinalizeRef.current.values()) clearTimeout(t);
			if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
		};
	}, []);

	// Clear streaming state on disconnect — but only after a grace period
	// to allow brief WS reconnects without killing an active stream
	const disconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const DISCONNECT_GRACE_MS = 15_000; // 15 seconds before killing stream

	useEffect(() => {
		if (reconnecting || !authenticated) {
			const state = useChatStore.getState();
			if (state._streamingThreads.size > 0 && !disconnectTimerRef.current) {
				console.warn("[chat] Connection lost while streaming — starting grace period");
				disconnectTimerRef.current = setTimeout(() => {
					disconnectTimerRef.current = null;
					const current = useChatStore.getState();
					// End all active streams
					for (const tid of current._streamingThreads.keys()) {
						current.appendStream("\n\n[Connection lost]", true, tid);
					}
				}, DISCONNECT_GRACE_MS);
			}
		} else if (authenticated && !reconnecting) {
			// Reconnected successfully — cancel the kill timer
			if (disconnectTimerRef.current) {
				console.log("[chat] Reconnected — cancelling disconnect timer");
				clearTimeout(disconnectTimerRef.current);
				disconnectTimerRef.current = null;
			}
		}
	}, [reconnecting, authenticated]);

	useWsEvent("thread.started", handleRuntimeFrame);
	useWsEvent("turn.started", handleRuntimeFrame);
	useWsEvent("turn.completed", handleRuntimeFrame);
	useWsEvent("item.started", handleRuntimeFrame);
	useWsEvent("item.updated", handleRuntimeFrame);
	useWsEvent("item.completed", handleRuntimeFrame);
	useWsEvent("context.updated", handleRuntimeFrame);
	useWsEvent("diff.updated", handleRuntimeFrame);
	useWsEvent("request.opened", handleRuntimeFrame);
	useWsEvent("request.resolved", handleRuntimeFrame);
	useWsEvent("chat:active", handleRuntimeFrame);
	useWsEvent("run.heartbeat", handleRuntimeFrame);
	useWsEvent("chat:heartbeat", handleRuntimeFrame);
	useWsEvent("chat:execution", handleRuntimeFrame);
	useWsEvent("context:metrics", handleRuntimeFrame);
	useWsEvent("response:delta", handleRuntimeFrame);
	useWsEvent("agent:progress", handleRuntimeFrame);
	useWsEvent("chat:response", handleRuntimeFrame);
	useWsEvent("response:complete", handleRuntimeFrame);

	const streamingMessage = streaming ? messages.find((m) => m.streaming) : null;
	const hasDiffPanel = diffOpen && threadChanges.length > 0;
	const hasExecRailContent = executionEvents.length > 0 || hasDiffPanel;
	const showExecRail = hasExecRailContent && !execRailCollapsed;
	const latestExecutionEvent = executionEvents[executionEvents.length - 1];
	const handleOpenChange = useCallback((path: string) => {
		selectChangePath(path);
		setDiffOpen(true);
		setExecRailCollapsed(false);
	}, [selectChangePath, setDiffOpen]);

	useEffect(() => {
		if (!hasExecRailContent) {
			execRailAutoCollapseAppliedRef.current = false;
			return;
		}
		if (execRailAutoCollapseAppliedRef.current || typeof window === "undefined") return;
		execRailAutoCollapseAppliedRef.current = true;
		if (window.innerWidth <= EXEC_RAIL_AUTO_COLLAPSE_MAX_WIDTH) {
			setExecRailCollapsed(true);
		}
	}, [hasExecRailContent]);

	useEffect(() => {
		if (latestExecutionEvent?.phase === "failed") {
			setExecRailCollapsed(false);
		}
	}, [latestExecutionEvent?.id, latestExecutionEvent?.phase]);

	return (
		<div className="flex min-h-0 flex-1 overflow-hidden">
			{!focusMode && (
				<ChatSidebar
					collapsed={sidebarCollapsed}
					onToggle={toggleSidebar}
					requests={inboxRequests}
					resolvingId={resolvingRequestId}
					onResolveRequest={handleResolveRequest}
				/>
			)}
			<div className="flex min-h-0 flex-1 min-w-0 overflow-hidden">
				<div className="flex min-h-0 flex-1 min-w-0 flex-col overflow-hidden">
					<div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-2.5">
						<AgentSelector
							activeAgent={activeAgent}
							onSelect={setActiveAgent}
						/>
						{modelInfo ? (
							<div className="hidden items-center gap-3 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1 text-xs md:flex">
								<div className="flex items-center gap-2">
									<span className="uppercase tracking-[0.18em] text-zinc-500">Provider</span>
									<span className="text-zinc-200">{modelInfo.provider}</span>
								</div>
								<div className="h-4 w-px bg-white/8" />
								<div className="flex items-center gap-2">
									<span className="uppercase tracking-[0.18em] text-zinc-500">Model</span>
									<span className="text-zinc-200">{modelInfo.model}</span>
								</div>
								{modelInfo.overridden ? (
									<span className="rounded-full bg-[rgb(var(--nyx-accent-rgb)/0.12)] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-[var(--nyx-accent)]">
										Override
									</span>
								) : null}
							</div>
						) : null}
						<div className="ml-auto flex items-center gap-2">
							<div className="hidden items-center gap-1 md:flex">
								<button
									onClick={toggleReasoning}
									className={`rounded-md p-1.5 transition-colors ${showReasoning ? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)] border border-[rgb(var(--nyx-accent-rgb)/0.24)]" : "text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300 border border-transparent"}`}
									title="Toggle reasoning/thinking"
								>
									<Brain className="h-4 w-4" />
								</button>
								<button
									onClick={toggleToolCalls}
									className={`rounded-md p-1.5 transition-colors ${showToolCalls ? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)] border border-[rgb(var(--nyx-accent-rgb)/0.24)]" : "text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300 border border-transparent"}`}
									title="Toggle tool calls"
								>
									<Wrench className="h-4 w-4" />
								</button>
								<button
									onClick={toggleFocusMode}
									className={`rounded-md p-1.5 transition-colors ${focusMode ? "bg-[rgb(var(--nyx-accent-rgb)/0.12)] text-[var(--nyx-accent)] border border-[rgb(var(--nyx-accent-rgb)/0.24)]" : "text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300 border border-transparent"}`}
									title="Toggle focus mode"
								>
									{focusMode ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
								</button>
								<div className="mx-1 h-4 w-px bg-white/10" />
							</div>
							{contextPct !== null && (
								<div
									className="flex items-center gap-2 rounded-full border border-white/8 bg-white/[0.03] px-3 py-1"
									title={`Conversation context pressure: ${formatContextPct(contextPct)}`}
								>
									<span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">Context</span>
									<div className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-800">
										<div
											className={`h-full rounded-full transition-all ${
												contextPct > 80 ? "bg-red-500" : contextPct > 50 ? "bg-yellow-500" : "bg-[var(--nyx-accent)]"
											}`}
											style={{ width: `${Math.min(contextPct, 100)}%` }}
										/>
									</div>
									<span className={`text-xs tabular-nums ${
										contextPct > 80 ? "text-red-400" : "text-zinc-500"
									}`}>
										{formatContextPct(contextPct)}
									</span>
								</div>
							)}
							{hasExecRailContent && (
								<button
									onClick={() => setExecRailCollapsed(!execRailCollapsed)}
									className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800/50 hover:text-zinc-300 transition-colors hidden lg:flex"
									title={execRailCollapsed ? "Expand trace rail" : "Collapse trace rail"}
								>
									{execRailCollapsed ? <PanelRight className="h-4 w-4" /> : <PanelRightClose className="h-4 w-4" />}
								</button>
							)}
							{reconnecting && (
								<span className="text-xs text-yellow-400 animate-pulse">
									Reconnecting...
								</span>
							)}
							{!authenticated && !reconnecting && (
								<span className="text-xs text-red-400">Not connected</span>
							)}
						</div>
					</div>
					<StreamingBar
						message={streamingMessage}
						latestEvent={latestExecutionEvent}
						eventCount={executionEvents.length}
						queuedCount={queuedCount}
						hasTrace={hasExecRailContent}
						traceOpen={showExecRail}
						onToggleTrace={() => setExecRailCollapsed((value) => !value)}
					/>
					<MessageList
						messages={messages}
						executionEvents={executionEvents}
						onOpenChange={handleOpenChange}
						onSendSuggestion={handleSend}
						showReasoning={showReasoning}
						showToolCalls={showToolCalls}
						emptySubtitle="Start a gateway conversation or pick a quick check."
						emptyActions={EMPTY_CHAT_SUGGESTIONS}
					/>
					<ChatRequestCards
						requests={activeThreadRequests}
						resolvingId={resolvingRequestId}
						onResolve={handleResolveRequest}
						className="shrink-0"
					/>
					<MessageInput
						onSend={handleSend}
						onAbort={abortStream}
						onModelChange={setModelOverride}
						streaming={streaming}
						disabled={!authenticated}
						modelInfo={modelInfo}
						modelLoading={modelLoading}
						ephemeralBtw={ephemeralBtw}
						onDismissBtw={() => setEphemeralBtw(null)}
						slashCommands={SLASH_COMMANDS}
						queuedCount={queuedCount}
						terminalSnippets={terminalSnippets}
						onRemoveSnippet={removeTerminalSnippet}
					/>
				</div>
				{hasExecRailContent && (
					<div className={`hidden shrink-0 border-l border-[var(--nyx-line)] transition-[width] duration-200 lg:flex lg:flex-col ${showExecRail ? "w-[22rem] 2xl:w-[24rem]" : "w-14 bg-[var(--nyx-panel-2)]"}`}>
						{showExecRail ? (
							<>
								{executionEvents.length > 0 ? (
									<ExecutionPanel
										events={executionEvents}
										streaming={streaming}
										onOpenChange={handleOpenChange}
										onAttachSnippet={(itemId, label, content) => addTerminalSnippet({ itemId, label, content })}
										className={hasDiffPanel ? "min-h-0 flex-1 border-b border-[var(--nyx-line)]" : "min-h-0 flex-1"}
									/>
								) : null}
								{hasDiffPanel ? (
									<ThreadChangesPanel
										changes={threadChanges}
										selectedPath={selectedChangePath}
										onSelectPath={handleOpenChange}
										onAttachSnippet={(label, content) => addTerminalSnippet({ itemId: `diff:${label}`, label, content })}
										className="min-h-0 flex-1"
									/>
								) : null}
							</>
						) : (
							<div className="flex h-full flex-col items-center gap-3 px-2 py-3">
								<button
									type="button"
									onClick={() => setExecRailCollapsed(false)}
									className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-zinc-400 transition-colors hover:border-[rgb(var(--nyx-accent-rgb)/0.24)] hover:text-zinc-100"
									title="Expand trace rail"
								>
									<PanelRight className="h-4 w-4" />
								</button>
								<div className="flex flex-1 flex-col items-center gap-3 text-[9px] uppercase tracking-[0.22em] text-zinc-500">
									<span
										className="font-medium text-zinc-400"
										style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
									>
										Trace
									</span>
									{hasDiffPanel ? (
										<span
											style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
										>
											Diff
										</span>
									) : null}
								</div>
								<div className="flex flex-col items-center gap-2">
									{executionEvents.length > 0 ? (
										<div className="flex w-10 flex-col items-center gap-1 rounded-xl border border-white/8 bg-black/20 py-2 text-[10px] text-zinc-300">
											<Activity className="h-3.5 w-3.5 text-[var(--nyx-accent)]" />
											<span className="font-mono">{executionEvents.length}</span>
										</div>
									) : null}
									{hasDiffPanel ? (
										<div className="flex w-10 flex-col items-center gap-1 rounded-xl border border-white/8 bg-black/20 py-2 text-[10px] text-zinc-300">
											<FileCode2 className="h-3.5 w-3.5 text-amber-300" />
											<span className="font-mono">{threadChanges.length}</span>
										</div>
									) : null}
								</div>
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}

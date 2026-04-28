import { create } from "zustand";
import { persist } from "zustand/middleware";
import { gateway } from "../lib/ws";
import { uuid } from "../lib/utils";
import {
	buildTerminalContextBlock,
	countSnippetLines,
	type ChatRuntimeEvent,
	type RuntimeRequest,
	type TerminalSnippet,
	type ThreadChange,
} from "../lib/chat-runtime";
import { createLifecycleExecutionEvent } from "../lib/execution-lifecycle";
import { toDisplayPath } from "../lib/display-path";
import { mergeHistoryMessages } from "./history-merge";

export interface ChatAttachment {
	id: string;
	name: string;
	mimeType: string;
	base64: string;
	previewUrl: string;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	reasoning?: string | null;
	agent?: string;
	timestamp: number;
	streaming?: boolean;
	activity?: string;
	tokensIn?: number;
	tokensOut?: number;
	cost?: number;
	durationMs?: number;
	attachments?: { name: string; mimeType: string; previewUrl: string }[];
}

export interface ExecutionEvent {
	id: string;
	kind: "command" | "file_change" | "mcp_tool" | "web_search" | "status";
	phase: "started" | "updated" | "completed" | "failed";
	messageId?: string;
	turn?: number;
	title: string;
	subtitle?: string;
	details?: string;
	command?: string;
	outputPreview?: string;
	exitCode?: number | null;
	changes?: Array<{ path: string; kind: "add" | "delete" | "update" }>;
	timestamp: number;
}

export interface ChatModelInfo {
	agent: string;
	model: string;
	provider: string;
	cliFallback?: string;
	overridden: boolean;
	warning?: string | null;
}

/** Per-thread streaming state */
interface ThreadStreamState {
	streamingMessageId: string;
	messages: ChatMessage[];
	contextPct: number | null;
	runId?: string | null;
}

interface ThreadExecutionState {
	events: ExecutionEvent[];
	updatedAt: number;
}

interface ChatState {
	/** Messages for the currently viewed thread */
	messages: ChatMessage[];
	activeAgent: string;
	/** True if the currently viewed thread is streaming */
	streaming: boolean;
	streamingMessageId: string | null;
	threadId: string | null;
	contextPct: number | null;
	executionEvents: ExecutionEvent[];
	threadChanges: ThreadChange[];
	selectedChangePath: string | null;
	diffOpen: boolean;
	modelInfo: ChatModelInfo | null;
	modelLoading: boolean;
	pendingRequests: RuntimeRequest[];
	requestsLoading: boolean;
	terminalSnippets: TerminalSnippet[];

	/** Threads that are actively streaming (including non-viewed ones) */
	_streamingThreads: Map<string, ThreadStreamState>;
	_executionThreads: Map<string, ThreadExecutionState>;
	/** Set of threadIds that are currently streaming */
	getStreamingThreadIds: () => Set<string>;

	sendMessage: (
		content: string,
		attachments?: ChatAttachment[],
		opts?: { skipUserBubble?: boolean; forceThreadId?: string | null },
	) => Promise<void>;
	appendStream: (text: string, done: boolean, threadId?: string) => void;
	finalizeStream: (finalText: string, cost?: number, durationMs?: number, threadId?: string) => void;
	setActivity: (activity: string, threadId?: string) => void;
	setTokens: (tokensIn: number, tokensOut: number, threadId?: string) => void;
	abortStream: (threadId?: string) => void;
	setActiveAgent: (agent: string) => void;
	loadHistory: (threadId: string) => Promise<void>;
	restoreSession: () => Promise<void>;
	clearMessages: () => void;
	setContextPct: (pct: number, threadId?: string) => void;
	addExecutionEvent: (event: ExecutionEvent, threadId?: string) => void;
	clearExecutionEvents: (threadId?: string) => void;
	loadThreadChanges: (threadId: string) => Promise<void>;
	setThreadChanges: (changes: ThreadChange[], threadId?: string) => void;
	selectChangePath: (path: string | null) => void;
	setDiffOpen: (open: boolean) => void;
	loadRequests: () => Promise<void>;
	resolveRequest: (requestId: string, action: "approve" | "reject") => Promise<void>;
	addTerminalSnippet: (snippet: Omit<TerminalSnippet, "id" | "createdAt" | "lineStart" | "lineEnd"> & { lineStart?: number; lineEnd?: number }) => void;
	removeTerminalSnippet: (snippetId: string) => void;
	clearTerminalSnippets: () => void;
	applyRuntimeEvent: (event: ChatRuntimeEvent) => void;
	loadModelInfo: () => Promise<void>;
	setModelOverride: (model?: string | null) => Promise<void>;
	ensureStreamingMessage: (agent?: string, threadId?: string, startedAt?: number, runId?: string) => void;
	switchThread: (threadId: string) => Promise<void>;
	newThread: () => void;
	/** Messages waiting to be sent (queued while agent is busy) */
	queuedMessages: Array<{ id: string; threadId: string | null; content: string; attachments?: ChatAttachment[] }>;
	drainQueue: (threadId?: string) => void;
	sidebarCollapsed: boolean;
	toggleSidebar: () => void;
}

export const useChatStore = create<ChatState>()(persist((set, get) => ({
	messages: [],
	activeAgent: "nyx",
	streaming: false,
	streamingMessageId: null,
	threadId: null,
	contextPct: null,
	executionEvents: [],
	threadChanges: [],
	selectedChangePath: null,
	diffOpen: false,
	modelInfo: null,
	modelLoading: false,
	pendingRequests: [],
	requestsLoading: false,
	terminalSnippets: [],
	_streamingThreads: new Map(),
	_executionThreads: new Map(),
	queuedMessages: [],

	getStreamingThreadIds: () => new Set(get()._streamingThreads.keys()),

	sendMessage: async (
		content: string,
		attachments?: ChatAttachment[],
		opts?: { skipUserBubble?: boolean; forceThreadId?: string | null },
	) => {
		const terminalContext = buildTerminalContextBlock(get().terminalSnippets);
		const outboundContent = terminalContext ? `${terminalContext}\n\n[User Message]\n${content}` : content;
		const targetThreadId = opts?.forceThreadId ?? get().threadId;
		const isViewingTarget = targetThreadId === get().threadId;
		const targetIsStreaming = targetThreadId ? get()._streamingThreads.has(targetThreadId) : get().streaming;

		// If already streaming, queue the message — don't fire a second processImmediate
		if (targetIsStreaming) {
			set((state) => ({
				queuedMessages: [...state.queuedMessages, { id: uuid(), threadId: targetThreadId, content, attachments }],
				messages: isViewingTarget ? [...state.messages, {
					id: uuid(),
					role: "user" as const,
					content,
					timestamp: Date.now(),
					attachments: attachments?.map((a) => ({
						name: a.name,
						mimeType: a.mimeType,
						previewUrl: a.previewUrl,
					})),
				}] : state.messages,
				_streamingThreads: targetThreadId
					? new Map(state._streamingThreads).set(targetThreadId, {
						...(state._streamingThreads.get(targetThreadId) ?? {
							streamingMessageId: uuid(),
							messages: [],
							contextPct: null,
						}),
						messages: [
							...(state._streamingThreads.get(targetThreadId)?.messages ?? (isViewingTarget ? state.messages : [])),
							{
								id: uuid(),
								role: "user" as const,
								content,
								timestamp: Date.now(),
								attachments: attachments?.map((a) => ({
									name: a.name,
									mimeType: a.mimeType,
									previewUrl: a.previewUrl,
								})),
							},
						],
					})
					: state._streamingThreads,
			}));
			return;
		}

		const userMessage: ChatMessage | null = opts?.skipUserBubble ? null : {
			id: uuid(),
			role: "user",
			content,
			timestamp: Date.now(),
			attachments: attachments?.map((a) => ({
				name: a.name,
				mimeType: a.mimeType,
				previewUrl: a.previewUrl,
			})),
		};

		const assistantMessage: ChatMessage = {
			id: uuid(),
			role: "assistant",
			content: "",
			agent: get().activeAgent,
			timestamp: Date.now(),
			streaming: true,
		};

		set((state) => {
			const currentThreadMessages = targetThreadId
				? state._streamingThreads.get(targetThreadId)?.messages
				: undefined;
			const baseMessages = isViewingTarget
				? state.messages
				: (currentThreadMessages ?? []);
			const newMessages = userMessage
				? [...baseMessages, userMessage, assistantMessage]
				: [...baseMessages, assistantMessage];
			const tid = targetThreadId;
			const newStreaming = new Map(state._streamingThreads);
			const newExecution = new Map(state._executionThreads);
			if (tid) {
				const existingEvents = newExecution.get(tid)?.events ?? (isViewingTarget ? state.executionEvents : []);
				newStreaming.set(tid, {
					streamingMessageId: assistantMessage.id,
					messages: newMessages,
					contextPct: isViewingTarget ? state.contextPct : (state._streamingThreads.get(tid)?.contextPct ?? null),
				});
				newExecution.set(tid, { events: existingEvents, updatedAt: Date.now() });
			}
			return {
				messages: isViewingTarget ? newMessages : state.messages,
				streaming: isViewingTarget ? true : state.streaming,
				streamingMessageId: isViewingTarget ? assistantMessage.id : state.streamingMessageId,
				_streamingThreads: newStreaming,
				_executionThreads: newExecution,
				executionEvents: isViewingTarget && tid ? (newExecution.get(tid)?.events ?? state.executionEvents) : state.executionEvents,
			};
		});

		try {
			const payload: {
				message: string;
				agent: string;
				threadId?: string;
				idempotencyKey: string;
				files?: { name: string; type: string; data: string }[];
			} = {
				message: outboundContent,
				agent: get().activeAgent,
				idempotencyKey: uuid(),
			};
			const tid = targetThreadId;
			if (tid) payload.threadId = tid;

			if (attachments?.length) {
				payload.files = attachments.map((a) => ({
					name: a.name,
					type: a.mimeType,
					data: a.base64,
				}));
			}

			const result = await gateway.request<{ messageId: string; threadId: string; runId: string; status: "started" | "in_flight" | "ok" | "queued"; queued?: boolean }>(
				"chat.send",
				payload,
			);

			// Message was queued (agent busy) — remove the streaming bubble, keep user message
			if (result.queued) {
				set((state) => {
					const newStreaming = new Map(state._streamingThreads);
					if (tid) newStreaming.delete(tid);
					return {
						messages: isViewingTarget
							? state.messages.filter((m) => m.id !== state.streamingMessageId)
							: state.messages,
						streaming: isViewingTarget ? newStreaming.size > 0 : state.streaming,
						streamingMessageId: isViewingTarget ? null : state.streamingMessageId,
						threadId: isViewingTarget ? (result.threadId ?? state.threadId) : state.threadId,
						_streamingThreads: newStreaming,
					};
				});
				return;
			}

			// Update threadId and migrate streaming state if thread was just created
			set((state) => {
				const newStreaming = new Map(state._streamingThreads);
				const newExecution = new Map(state._executionThreads);
				const oldTid = targetThreadId;
				if (oldTid && oldTid !== result.threadId && newStreaming.has(oldTid)) {
					const ts = newStreaming.get(oldTid)!;
					newStreaming.delete(oldTid);
					newStreaming.set(result.threadId, { ...ts, runId: result.runId });
					if (newExecution.has(oldTid)) {
						const execution = newExecution.get(oldTid)!;
						newExecution.delete(oldTid);
						newExecution.set(result.threadId, execution);
					}
					return {
						threadId: isViewingTarget ? result.threadId : state.threadId,
						_streamingThreads: newStreaming,
						_executionThreads: newExecution,
					};
				}
				if (!oldTid && isViewingTarget && state.streamingMessageId) {
					// New thread — register streaming state
					newStreaming.set(result.threadId, {
						streamingMessageId: state.streamingMessageId,
						messages: state.messages,
						contextPct: state.contextPct,
						runId: result.runId,
					});
					newExecution.set(result.threadId, { events: [], updatedAt: Date.now() });
					return { threadId: result.threadId, _streamingThreads: newStreaming, _executionThreads: newExecution, executionEvents: [] };
				}
				if (oldTid === result.threadId && newStreaming.has(result.threadId)) {
					const ts = newStreaming.get(result.threadId)!;
					newStreaming.set(result.threadId, { ...ts, runId: result.runId });
				}
				return {
					threadId: isViewingTarget ? result.threadId : state.threadId,
					_streamingThreads: newStreaming,
					_executionThreads: newExecution,
				};
			});
			set({ terminalSnippets: [] });
		} catch (err) {
			console.error("[chat.send] failed:", err);
			set((state) => {
				const newStreaming = new Map(state._streamingThreads);
				if (targetThreadId) newStreaming.delete(targetThreadId);
				return {
					messages: isViewingTarget ? state.messages.map((m) =>
						m.id === state.streamingMessageId
							? { ...m, content: "Failed to send message.", streaming: false }
							: m,
					) : state.messages,
					streaming: isViewingTarget ? false : state.streaming,
					streamingMessageId: isViewingTarget ? null : state.streamingMessageId,
					_streamingThreads: newStreaming,
				};
			});
		}
	},

	appendStream: (text: string, done: boolean, threadId?: string) => {
		const targetThread = threadId ?? get().threadId;
		set((state) => {
			const isViewingTarget = targetThread === state.threadId;

			// Get streaming state for target thread
			const ts = targetThread ? state._streamingThreads.get(targetThread) : null;
			const msgId = isViewingTarget ? state.streamingMessageId : ts?.streamingMessageId ?? null;

			// If no streaming message exists (e.g. after reconnect/refresh), create one
			if (!msgId && !done) {
				const newMsg: ChatMessage = {
					id: uuid(),
					role: "assistant",
					content: text,
					agent: state.activeAgent,
					timestamp: Date.now(),
					streaming: true,
				};
				const newStreaming = new Map(state._streamingThreads);
				if (targetThread) {
					newStreaming.set(targetThread, {
						streamingMessageId: newMsg.id,
						messages: isViewingTarget ? [...state.messages, newMsg] : (ts?.messages ? [...ts.messages, newMsg] : [newMsg]),
						contextPct: ts?.contextPct ?? null,
					});
				}
				if (isViewingTarget) {
					return {
						messages: [...state.messages, newMsg],
						streaming: true,
						streamingMessageId: newMsg.id,
						_streamingThreads: newStreaming,
					};
				}
				return { _streamingThreads: newStreaming };
			}

			// Done signal with no streaming message — just clear streaming state
			if (!msgId) {
				if (done && targetThread) {
					const newStreaming = new Map(state._streamingThreads);
					newStreaming.delete(targetThread);
					if (isViewingTarget) {
						return { streaming: false, streamingMessageId: null, _streamingThreads: newStreaming };
					}
					return { _streamingThreads: newStreaming };
				}
				if (isViewingTarget) return { streaming: false, streamingMessageId: null };
				return {};
			}

			const updateMessages = (msgs: ChatMessage[]) =>
				msgs.map((m) =>
					m.id === msgId
						? { ...m, content: m.content + text, streaming: !done, activity: done ? undefined : m.activity }
						: m,
				);

			const newStreaming = new Map(state._streamingThreads);
			if (done && targetThread) {
				newStreaming.delete(targetThread);
			} else if (targetThread && ts) {
				newStreaming.set(targetThread, {
					...ts,
					streamingMessageId: ts.streamingMessageId,
					messages: updateMessages(ts.messages),
				});
			}

			if (isViewingTarget) {
				return {
					messages: updateMessages(state.messages),
					streaming: !done,
					streamingMessageId: done ? null : msgId,
					_streamingThreads: newStreaming,
				};
			}
			return { _streamingThreads: newStreaming };
		});
		if (done && targetThread) get().drainQueue(targetThread);
	},

	finalizeStream: (finalText: string, cost?: number, durationMs?: number, threadId?: string) => {
		const targetThread = threadId ?? get().threadId;
		set((state) => {
			const isViewingTarget = targetThread === state.threadId;
			const ts = targetThread ? state._streamingThreads.get(targetThread) : null;
			const msgId = isViewingTarget ? state.streamingMessageId : ts?.streamingMessageId ?? null;
			if (!msgId) {
				if (isViewingTarget && finalText.trim()) {
					const lastMessage = state.messages[state.messages.length - 1];
					if (
						lastMessage?.role === "assistant"
						&& !lastMessage.streaming
						&& lastMessage.content === finalText
					) {
						return { streaming: false, streamingMessageId: null };
					}
					const recoveredMessage: ChatMessage = {
						id: uuid(),
						role: "assistant",
						content: finalText,
						agent: state.activeAgent,
						timestamp: Date.now(),
						streaming: false,
						...(cost !== undefined && { cost }),
						...(durationMs !== undefined && { durationMs }),
					};
					return {
						messages: [...state.messages, recoveredMessage],
						streaming: false,
						streamingMessageId: null,
					};
				}
				if (isViewingTarget) return { streaming: false, streamingMessageId: null };
				return {};
			}

			const finalizeMessages = (msgs: ChatMessage[]) =>
				msgs.map((m) => {
					if (m.id !== msgId) return m;
					const content = finalText.length >= m.content.length ? finalText : m.content;
					return { ...m, content, streaming: false, activity: undefined, ...(cost !== undefined && { cost }), ...(durationMs !== undefined && { durationMs }) };
				});

			const newStreaming = new Map(state._streamingThreads);
			if (targetThread) newStreaming.delete(targetThread);

			if (isViewingTarget) {
				return {
					messages: finalizeMessages(state.messages),
					streaming: false,
					streamingMessageId: null,
					_streamingThreads: newStreaming,
				};
			}
			// Non-viewed thread — update in background (messages will load when user switches)
			return { _streamingThreads: newStreaming };
		});
		// Drain queued messages now that streaming is done
		if (targetThread) get().drainQueue(targetThread);
	},

	setActivity: (activity: string, threadId?: string) => {
		set((state) => {
			const targetThread = threadId ?? state.threadId;
			const isViewingTarget = targetThread === state.threadId;
			const ts = targetThread ? state._streamingThreads.get(targetThread) : null;
			const msgId = isViewingTarget ? state.streamingMessageId : ts?.streamingMessageId ?? null;

			// If no streaming message exists (e.g. after reconnect), create one
			if (!msgId) {
				const newMsg: ChatMessage = {
					id: uuid(),
					role: "assistant",
					content: "",
					agent: state.activeAgent,
					timestamp: Date.now(),
					streaming: true,
					activity,
				};
				const newStreaming = new Map(state._streamingThreads);
				if (targetThread) {
					newStreaming.set(targetThread, {
						streamingMessageId: newMsg.id,
						messages: isViewingTarget ? [...state.messages, newMsg] : [newMsg],
						contextPct: ts?.contextPct ?? null,
					});
				}
				if (isViewingTarget) {
					return {
						messages: [...state.messages, newMsg],
						streaming: true,
						streamingMessageId: newMsg.id,
						_streamingThreads: newStreaming,
					};
				}
				return { _streamingThreads: newStreaming };
			}

			if (isViewingTarget) {
				return {
					messages: state.messages.map((m) =>
						m.id === msgId ? { ...m, activity } : m,
					),
				};
			}
			// Background thread — update stored messages
			if (targetThread && ts) {
				const newStreaming = new Map(state._streamingThreads);
				newStreaming.set(targetThread, {
					...ts,
					messages: ts.messages.map((m) => m.id === msgId ? { ...m, activity } : m),
				});
				return { _streamingThreads: newStreaming };
			}
			return {};
		});
	},

	setTokens: (tokensIn: number, tokensOut: number, threadId?: string) => {
		set((state) => {
			const targetThread = threadId ?? state.threadId;
			const isViewingTarget = targetThread === state.threadId;
			const ts = targetThread ? state._streamingThreads.get(targetThread) : null;
			const msgId = isViewingTarget ? state.streamingMessageId : ts?.streamingMessageId ?? null;
			if (!msgId) return {};

			if (isViewingTarget) {
				return {
					messages: state.messages.map((m) =>
						m.id === msgId ? { ...m, tokensIn, tokensOut } : m,
					),
				};
			}
			return {};
		});
	},

	setContextPct: (pct: number, threadId?: string) => {
		const state = get();
		const targetThread = threadId ?? state.threadId;
		const isViewingTarget = targetThread === state.threadId;
		if (isViewingTarget) {
			set({ contextPct: pct });
		}
		// Also update in streaming thread state
		if (targetThread) {
			const ts = state._streamingThreads.get(targetThread);
			if (ts) {
				const newStreaming = new Map(state._streamingThreads);
				newStreaming.set(targetThread, { ...ts, contextPct: pct });
				set({ _streamingThreads: newStreaming });
			}
		}
	},

	addExecutionEvent: (event: ExecutionEvent, threadId?: string) => {
		set((state) => {
			const targetThread = threadId ?? state.threadId;
			if (!targetThread) return {};
			const targetStreaming = targetThread ? state._streamingThreads.get(targetThread) : null;
			const targetMessageId = targetThread === state.threadId
				? state.streamingMessageId ?? undefined
				: targetStreaming?.streamingMessageId;
			const current = state._executionThreads.get(targetThread)?.events ?? [];
			const nextEvents = [...current];
			const existingIndex = nextEvents.findIndex((entry) => entry.id === event.id);
			if (existingIndex >= 0) {
				nextEvents[existingIndex] = {
					...nextEvents[existingIndex],
					...event,
					messageId: nextEvents[existingIndex].messageId ?? event.messageId ?? targetMessageId,
					timestamp: nextEvents[existingIndex].timestamp ?? event.timestamp,
				};
			} else {
				nextEvents.push({
					...event,
					messageId: event.messageId ?? targetMessageId,
				});
			}
			const newExecution = new Map(state._executionThreads);
			newExecution.set(targetThread, {
				events: nextEvents,
				updatedAt: Date.now(),
			});
			if (targetThread === state.threadId) {
				return { _executionThreads: newExecution, executionEvents: nextEvents };
			}
			return { _executionThreads: newExecution };
		});
	},

	clearExecutionEvents: (threadId?: string) => {
		set((state) => {
			const targetThread = threadId ?? state.threadId;
			if (!targetThread) return { executionEvents: [] };
			const newExecution = new Map(state._executionThreads);
			newExecution.delete(targetThread);
			if (targetThread === state.threadId) {
				return { _executionThreads: newExecution, executionEvents: [] };
			}
			return { _executionThreads: newExecution };
		});
	},

	loadThreadChanges: async (threadId: string) => {
		try {
			const result = await gateway.request<{ changes: ThreadChange[] }>("threads.changes", { id: threadId });
			get().setThreadChanges(result.changes ?? [], threadId);
		} catch (err) {
			console.error("[threads.changes] failed:", err);
		}
	},

	setThreadChanges: (changes: ThreadChange[], threadId?: string) => {
		const targetThread = threadId ?? get().threadId;
		if (!targetThread) return;
		const uniqueChanges = [...changes].sort((a, b) => a.timestamp - b.timestamp);
		const currentSelectedPath = get().selectedChangePath;
		const selectedDisplayPath = currentSelectedPath ? toDisplayPath(currentSelectedPath) : null;
		const nextSelected = selectedDisplayPath
			? uniqueChanges.find((change) => toDisplayPath(change.filePath) === selectedDisplayPath)?.filePath ?? uniqueChanges[0]?.filePath ?? null
			: uniqueChanges[0]?.filePath ?? null;
		if (targetThread === get().threadId) {
			set({
				threadChanges: uniqueChanges,
				selectedChangePath: nextSelected,
				diffOpen: uniqueChanges.length > 0 ? get().diffOpen || uniqueChanges.length > 0 : false,
			});
		}
	},

	selectChangePath: (path) => set({ selectedChangePath: path, diffOpen: path ? true : get().diffOpen }),

	setDiffOpen: (open) => set({ diffOpen: open }),

	loadRequests: async () => {
		set({ requestsLoading: true });
		try {
			const result = await gateway.request<{ requests: RuntimeRequest[] }>("chat.requests.list", {});
			set({ pendingRequests: result.requests ?? [], requestsLoading: false });
		} catch (err) {
			console.error("[chat.requests.list] failed:", err);
			set({ requestsLoading: false });
		}
	},

	resolveRequest: async (requestId, action) => {
		await gateway.request("chat.request.resolve", { requestId, action });
		set((state) => ({
			pendingRequests: state.pendingRequests.filter((request) => request.requestId !== requestId),
		}));
	},

	addTerminalSnippet: (snippet) => {
		const lineCount = countSnippetLines(snippet.content);
		const lineStart = snippet.lineStart ?? 1;
		const lineEnd = snippet.lineEnd ?? Math.max(lineStart, lineCount);
		const nextSnippet: TerminalSnippet = {
			id: uuid(),
			itemId: snippet.itemId,
			label: snippet.label,
			content: snippet.content,
			lineStart,
			lineEnd,
			createdAt: Date.now(),
		};
		set((state) => ({
			terminalSnippets: [
				...state.terminalSnippets.filter((entry) => entry.itemId !== snippet.itemId || entry.content !== snippet.content),
				nextSnippet,
			],
		}));
	},

	removeTerminalSnippet: (snippetId) => set((state) => ({
		terminalSnippets: state.terminalSnippets.filter((snippet) => snippet.id !== snippetId),
	})),

	clearTerminalSnippets: () => set({ terminalSnippets: [] }),

	applyRuntimeEvent: (event) => {
		switch (event.type) {
			case "turn.started":
				get().ensureStreamingMessage(event.agent, event.threadId, event.startedAt, event.runId);
				{
					const lifecycleEvent = createLifecycleExecutionEvent(event);
					if (lifecycleEvent) get().addExecutionEvent(lifecycleEvent, event.threadId);
				}
				return;
			case "thread.started":
				get().ensureStreamingMessage(event.agent, event.threadId, event.startedAt);
				return;
			case "chat.active":
				get().ensureStreamingMessage(event.agent, event.threadId, event.startedAt, event.runId);
				{
					const lifecycleEvent = createLifecycleExecutionEvent(event);
					if (lifecycleEvent) get().addExecutionEvent(lifecycleEvent, event.threadId);
				}
				return;
			case "response.delta":
				if (event.delta) {
					get().ensureStreamingMessage(event.agent, event.threadId);
					get().appendStream(event.delta, false, event.threadId);
				}
				return;
			case "activity.updated":
				if (event.activity) get().setActivity(event.activity, event.threadId);
				if (event.tokensIn !== undefined && event.tokensOut !== undefined) {
					get().setTokens(event.tokensIn, event.tokensOut, event.threadId);
				}
				return;
			case "turn.completed":
				{
					const lifecycleEvent = createLifecycleExecutionEvent(event);
					if (lifecycleEvent) get().addExecutionEvent(lifecycleEvent, event.threadId);
				}
				if (event.tokensIn !== undefined && event.tokensOut !== undefined) {
					get().setTokens(event.tokensIn, event.tokensOut, event.threadId);
				}
				if (event.text) {
					get().finalizeStream(event.text, event.cost, event.durationMs, event.threadId);
				} else {
					get().appendStream("", true, event.threadId);
				}
				return;
			case "item.started":
			case "item.updated":
			case "item.completed":
				get().addExecutionEvent({
					id: event.item.id,
					kind: event.item.type === "agent_message" ? "status" : event.item.type,
					phase: event.item.status,
					turn: event.turn,
					title: event.item.title,
					subtitle: event.item.subtitle,
					details: event.item.details,
					command: event.item.command,
					outputPreview: event.item.outputPreview,
					exitCode: event.item.exitCode,
					changes: event.item.changes,
					timestamp: event.item.timestamp,
				}, event.threadId);
				return;
			case "context.updated":
				if (!event.estimated && event.utilizationPct !== undefined) {
					get().setContextPct(Math.round(event.utilizationPct), event.threadId);
				}
				return;
			case "diff.updated":
				get().setThreadChanges(event.changes, event.threadId);
				return;
			case "request.opened":
				set((state) => ({
					pendingRequests: [
						...state.pendingRequests.filter((request) => request.requestId !== event.request.requestId),
						event.request,
					].sort((a, b) => a.createdAt - b.createdAt),
				}));
				return;
			case "request.resolved":
				set((state) => ({
					pendingRequests: state.pendingRequests.filter((request) => request.requestId !== event.requestId),
				}));
				return;
			default:
				return;
		}
	},

	loadModelInfo: async () => {
		set({ modelLoading: true });
		try {
			const result = await gateway.request<ChatModelInfo>("chat.model.get", {
				threadId: get().threadId,
				agent: get().activeAgent,
			});
			set({ modelInfo: result, modelLoading: false });
		} catch (err) {
			console.error("[chat.model.get] failed:", err);
			set({ modelLoading: false });
		}
	},

	setModelOverride: async (model?: string | null) => {
		set({ modelLoading: true });
		try {
			const result = await gateway.request<ChatModelInfo>("chat.model.set", {
				threadId: get().threadId,
				agent: get().activeAgent,
				model: model ?? null,
			});
			set({ modelInfo: result, modelLoading: false });
		} catch (err) {
			console.error("[chat.model.set] failed:", err);
			set({ modelLoading: false });
		}
	},

	abortStream: (threadId?: string) => {
		const state = get();
		const targetThread = threadId ?? state.threadId;
		const isViewingTarget = targetThread === state.threadId;
		const ts = targetThread ? state._streamingThreads.get(targetThread) : null;
		const msgId = isViewingTarget ? state.streamingMessageId : ts?.streamingMessageId ?? null;

		// Send abort to server — try threadId first, fall back to no threadId so server uses deviceId
		if (msgId || state.streaming) {
			gateway.request("chat.abort", { threadId: targetThread, runId: ts?.runId ?? undefined }).catch((err) => {
				console.warn("[chat.abort] request failed:", err);
			});
		}

		const newStreaming = new Map(state._streamingThreads);
		if (targetThread) newStreaming.delete(targetThread);

		if (isViewingTarget) {
			set({
				messages: state.messages.map((m) =>
					m.id === msgId
						? { ...m, streaming: false, content: `${m.content}\n\n[Aborted]` }
						: m,
				),
				streaming: false,
				streamingMessageId: null,
				_streamingThreads: newStreaming,
			});
		} else {
			set({ _streamingThreads: newStreaming });
		}
	},

	setActiveAgent: (agent: string) => set({ activeAgent: agent }),

	loadHistory: async (threadId: string) => {
		try {
			await gateway.waitForOpen(10000);
		} catch {
			console.error("[chat] loadHistory: WS never opened, skipping");
			return;
		}
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				const result = await gateway.request<{ messages: ChatMessage[]; executionEvents?: ExecutionEvent[] }>(
					"chat.history",
					{ threadId, limit: 50 },
				);
				const msgs = result.messages ?? [];
				const executionEvents = result.executionEvents ?? [];
				console.log(`[chat] loadHistory: ${msgs.length} msgs for thread ${threadId.slice(0, 8)}`);
				set((state) => {
					const newExecution = new Map(state._executionThreads);
					newExecution.set(threadId, {
						events: executionEvents,
						updatedAt: Date.now(),
					});
					return {
						messages: mergeHistoryMessages(msgs, state.messages, state.streamingMessageId),
						threadId,
						executionEvents: state.threadId === threadId ? executionEvents : state.executionEvents,
						_executionThreads: newExecution,
					};
				});
				await get().loadThreadChanges(threadId);
				return;
			} catch (err) {
				console.warn(`[chat] loadHistory attempt ${attempt + 1} failed:`, err);
				if (attempt < 4) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
			}
		}
		console.error("[chat] loadHistory: all 5 attempts failed");
	},

	restoreSession: async () => {
		const tid = get().threadId;
		if (!tid) return;
		await get().loadHistory(tid);
	},

	clearMessages: () => set((state) => {
		const newStreaming = new Map(state._streamingThreads);
		const newExecution = new Map(state._executionThreads);
		if (state.threadId) newStreaming.delete(state.threadId);
		if (state.threadId) newExecution.delete(state.threadId);
		return {
			messages: [],
			streaming: false,
			streamingMessageId: null,
			contextPct: null,
			executionEvents: [],
			threadChanges: [],
			selectedChangePath: null,
			diffOpen: false,
			terminalSnippets: [],
			threadId: state.threadId,
			_streamingThreads: newStreaming,
			_executionThreads: newExecution,
		};
	}),

	ensureStreamingMessage: (agent?: string, threadId?: string, startedAt?: number, runId?: string) => {
		const state = get();
		const targetThread = threadId ?? state.threadId;
		const isViewingTarget = targetThread === state.threadId;

		// Check if this thread already has a streaming message
		const ts = targetThread ? state._streamingThreads.get(targetThread) : null;
		if (targetThread && runId && ts) {
			const newStreaming = new Map(state._streamingThreads);
			newStreaming.set(targetThread, { ...ts, runId });
			set({ _streamingThreads: newStreaming });
			return;
		}
		if (isViewingTarget && state.streamingMessageId) return;
		if (!isViewingTarget && ts) return;

		const newMsg: ChatMessage = {
			id: uuid(),
			role: "assistant",
			content: "",
			agent: agent ?? state.activeAgent,
			timestamp: startedAt ?? Date.now(),
			streaming: true,
		};

		const newStreaming = new Map(state._streamingThreads);
		if (targetThread) {
			newStreaming.set(targetThread, {
				streamingMessageId: newMsg.id,
				messages: isViewingTarget ? [...state.messages, newMsg] : [newMsg],
				contextPct: null,
				runId: runId ?? null,
			});
		}

		if (isViewingTarget) {
			set({
				messages: [...state.messages, newMsg],
				streaming: true,
				streamingMessageId: newMsg.id,
				_streamingThreads: newStreaming,
			});
		} else {
			set({ _streamingThreads: newStreaming });
		}
	},

	switchThread: async (threadId: string) => {
		const state = get();

		// Check if the target thread is currently streaming
		const targetTs = state._streamingThreads.get(threadId);
		const targetExecution = state._executionThreads.get(threadId)?.events ?? [];

		if (targetTs) {
			// Switching to a streaming thread — restore its messages and streaming state
			set({
				messages: targetTs.messages,
				streaming: true,
				streamingMessageId: targetTs.streamingMessageId,
				threadId,
				contextPct: targetTs.contextPct,
				executionEvents: targetExecution,
				threadChanges: [],
				selectedChangePath: null,
				diffOpen: false,
				terminalSnippets: [],
			});
			// Also load history to merge any DB-persisted messages
			await get().loadHistory(threadId);
		} else {
			// Non-streaming thread — clear and load
			set({
				messages: [],
				streaming: false,
				streamingMessageId: null,
				threadId,
				contextPct: null,
				executionEvents: targetExecution,
				threadChanges: [],
				selectedChangePath: null,
				diffOpen: false,
				terminalSnippets: [],
			});
			await get().loadHistory(threadId);
		}
	},

	newThread: () => {
		set({
			messages: [],
			streaming: false,
			streamingMessageId: null,
			threadId: null,
			contextPct: null,
			executionEvents: [],
			threadChanges: [],
			selectedChangePath: null,
			diffOpen: false,
			modelInfo: null,
			terminalSnippets: [],
		});
	},

	drainQueue: (threadId?: string) => {
		const state = get();
		const targetThreadId = threadId ?? state.threadId ?? null;
		if (!targetThreadId) return;
		const targetIsStreaming = state._streamingThreads.has(targetThreadId);
		if (targetIsStreaming) return;
		const queued = state.queuedMessages.filter((m) => m.threadId === targetThreadId);
		if (queued.length === 0) return;
		// Merge all queued messages into one turn
		const content = queued.map((m) => m.content).join("\n\n");
		const attachments = queued.flatMap((m) => m.attachments ?? []);
		set((current) => ({
			queuedMessages: current.queuedMessages.filter((m) => m.threadId !== targetThreadId),
		}));
		// User bubbles already shown when queued — skip adding them again
		get().sendMessage(content, attachments.length > 0 ? attachments : undefined, {
			skipUserBubble: true,
			forceThreadId: targetThreadId,
		});
	},

	sidebarCollapsed: false,
	toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
}), {
	name: "nyxhive-chat",
	partialize: (state) => ({
		threadId: state.threadId,
		activeAgent: state.activeAgent,
		sidebarCollapsed: state.sidebarCollapsed,
	}),
}));

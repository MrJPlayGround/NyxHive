import { create } from "zustand";
import { gateway } from "../lib/ws";
import { fleetGateway } from "../lib/fleet-gateway";
import { uuid } from "../lib/utils";
import { toDisplayPath } from "../lib/display-path";
import { toast_error, toast_success } from "../components/ui/toast";
import {
	buildTerminalContextBlock,
	countSnippetLines,
	type ChatRuntimeEvent,
	type RuntimeRequest,
	type TerminalSnippet,
	type ThreadChange,
} from "../lib/chat-runtime";
import { createLifecycleExecutionEvent } from "../lib/execution-lifecycle";
import type {
	ChatAttachment,
	ChatMessage,
	ChatModelInfo,
	ExecutionEvent,
} from "./chat";
import { mergeHistoryMessages } from "./history-merge";
import type { Thread } from "./threads";

interface FleetQueuedMessage {
	id: string;
	content: string;
	attachments?: ChatAttachment[];
	threadId: string | null;
}

export type FleetThreadSearchResult = Thread & {
	snippet: string;
	lastActivity: number;
};

export interface FleetRuntimeState {
	presence: "idle" | "active";
	activeRunId: string | null;
	activeThreadId: string | null;
	lastEventAt: number | null;
	lastStartedAt: number | null;
	lastCompletedAt: number | null;
}

export interface FleetChatInstanceState {
	messages: ChatMessage[];
	threads: Thread[];
	threadSearchResults: FleetThreadSearchResult[];
	threadsLoading: boolean;
	threadsSearching: boolean;
	activeAgent: string;
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
	queuedMessages: FleetQueuedMessage[];
	ephemeralBtw: string | null;
	runtime: FleetRuntimeState;
}

function createFleetRuntimeState(): FleetRuntimeState {
	return {
		presence: "idle",
		activeRunId: null,
		activeThreadId: null,
		lastEventAt: null,
		lastStartedAt: null,
		lastCompletedAt: null,
	};
}

function createFleetChatInstance(activeAgent = "nyx"): FleetChatInstanceState {
	return {
		messages: [],
		threads: [],
		threadSearchResults: [],
		threadsLoading: false,
		threadsSearching: false,
		activeAgent,
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
		queuedMessages: [],
		ephemeralBtw: null,
		runtime: createFleetRuntimeState(),
	};
}

const historyRequestSeq = new Map<string, number>();
const modelRequestSeq = new Map<string, number>();
const threadSearchRequestSeq = new Map<string, number>();
const historyInflight = new Map<string, Promise<void>>();
const requestsInflight = new Map<string, Promise<void>>();
const threadsInflight = new Map<string, Promise<void>>();
const modelInflight = new Map<string, Promise<void>>();

function nextRequestSeq(seqMap: Map<string, number>, instanceId: string): number {
	const next = (seqMap.get(instanceId) ?? 0) + 1;
	seqMap.set(instanceId, next);
	return next;
}

function isCurrentRequest(seqMap: Map<string, number>, instanceId: string, requestSeq: number): boolean {
	return seqMap.get(instanceId) === requestSeq;
}

function runDeduped(map: Map<string, Promise<void>>, key: string, task: () => Promise<void>): Promise<void> {
	const existing = map.get(key);
	if (existing) return existing;

	let promise!: Promise<void>;
	promise = (async () => {
		try {
			await task();
		} finally {
			if (map.get(key) === promise) {
				map.delete(key);
			}
		}
	})();

	map.set(key, promise);
	return promise;
}

function requestInstance<T = unknown>(instanceId: string, method: string, payload: unknown, timeoutMs?: number): Promise<T> {
	if (instanceId === "nyxai") {
		return gateway.request<T>(method, payload, timeoutMs);
	}
	return fleetGateway.request<T>(instanceId, method, payload, timeoutMs);
}

function waitForInstanceOpen(instanceId: string, timeoutMs = 10000): Promise<void> {
	if (instanceId === "nyxai") {
		return gateway.waitForOpen(timeoutMs);
	}
	return fleetGateway.getClient(instanceId).waitForOpen(timeoutMs);
}

function matchesCurrentThread(instance: FleetChatInstanceState, threadId?: string): boolean {
	if (!threadId) return true;
	if (!instance.threadId) return true;
	return instance.threadId === threadId;
}

function isEmptyAssistantPlaceholder(message: ChatMessage): boolean {
	return message.role === "assistant"
		&& !message.content.trim()
		&& !(message.reasoning?.trim())
		&& !(message.activity?.trim())
		&& !message.attachments?.length;
}

function pruneEmptyAssistantPlaceholders(
	messages: ChatMessage[],
	keepStreamingMessageId?: string | null,
): ChatMessage[] {
	return messages.filter((message) => {
		if (!isEmptyAssistantPlaceholder(message)) return true;
		return Boolean(keepStreamingMessageId && message.id === keepStreamingMessageId && message.streaming);
	});
}

function upsertExecutionEvent(
	events: ExecutionEvent[],
	event: ExecutionEvent,
	messageId?: string | null,
): ExecutionEvent[] {
	const nextEvent = {
		...event,
		messageId: event.messageId ?? messageId ?? undefined,
	};
	const existingIndex = events.findIndex((entry) => entry.id === nextEvent.id);
	if (existingIndex < 0) return [...events, nextEvent];
	return events.map((entry, index) =>
		index === existingIndex
			? {
				...entry,
				...nextEvent,
				messageId: entry.messageId ?? nextEvent.messageId,
				timestamp: entry.timestamp ?? nextEvent.timestamp,
			}
			: entry,
	);
}

function findLastMessageIndex(
	messages: ChatMessage[],
	predicate: (message: ChatMessage, index: number) => boolean,
): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (predicate(messages[index], index)) return index;
	}
	return -1;
}

function findFinalAssistantTargetIndex(
	messages: ChatMessage[],
	streamingMessageId: string | null,
	finalText: string,
): number {
	if (streamingMessageId) {
		const streamingIndex = messages.findIndex((message) => message.id === streamingMessageId);
		if (streamingIndex >= 0) return streamingIndex;
	}

	const activeStreamingIndex = findLastMessageIndex(
		messages,
		(message) => message.role === "assistant" && message.streaming === true,
	);
	if (activeStreamingIndex >= 0) return activeStreamingIndex;

	const emptyAssistantIndex = findLastMessageIndex(messages, isEmptyAssistantPlaceholder);
	if (emptyAssistantIndex >= 0) return emptyAssistantIndex;

	const lastAssistantIndex = findLastMessageIndex(messages, (message) => message.role === "assistant");
	const lastUserIndex = findLastMessageIndex(messages, (message) => message.role === "user");
	if (lastAssistantIndex > lastUserIndex) {
		const existingText = messages[lastAssistantIndex].content.trim();
		const normalizedFinalText = finalText.trim();
		if (
			!existingText
			|| existingText === normalizedFinalText
			|| Boolean(normalizedFinalText && normalizedFinalText.startsWith(existingText))
		) {
			return lastAssistantIndex;
		}
	}

	return -1;
}

function shouldKeepLocalHistoryMessage(
	message: ChatMessage,
	streamingMessageId?: string | null,
): boolean {
	if (message.role === "user") return true;
	if (message.id !== streamingMessageId) return false;
	return !isEmptyAssistantPlaceholder(message);
}

function resolveRuntimeTimestamp(event: ChatRuntimeEvent): number {
	switch (event.type) {
		case "thread.started":
		case "turn.started":
		case "chat.active":
			return event.startedAt ?? Date.now();
		case "turn.completed":
			return event.finishedAt;
		case "item.started":
		case "item.updated":
		case "item.completed":
			return event.item.timestamp;
		default:
			return Date.now();
	}
}

function advanceRuntimeState(runtime: FleetRuntimeState, event: ChatRuntimeEvent): FleetRuntimeState {
	const timestamp = resolveRuntimeTimestamp(event);
	switch (event.type) {
		case "turn.started":
		case "chat.active":
			return {
				...runtime,
				presence: "active",
				activeRunId: event.runId ?? runtime.activeRunId,
				activeThreadId: event.threadId,
				lastEventAt: timestamp,
				lastStartedAt: timestamp,
			};
		case "turn.completed":
			return {
				...runtime,
				presence: "idle",
				activeRunId: runtime.activeRunId === null || !event.runId || runtime.activeRunId === event.runId
					? null
					: runtime.activeRunId,
				activeThreadId: runtime.activeThreadId === null || runtime.activeThreadId === event.threadId
					? null
					: runtime.activeThreadId,
				lastEventAt: timestamp,
				lastCompletedAt: timestamp,
			};
		default:
			return {
				...runtime,
				lastEventAt: timestamp,
			};
	}
}

interface SendMessageOptions {
	skipUserBubble?: boolean;
	forceThreadId?: string | null;
}

interface FleetChatState {
	instances: Record<string, FleetChatInstanceState>;
	ensureInstance: (instanceId: string, activeAgent?: string | null) => void;
	resetInstance: (instanceId: string) => void;
	setActiveAgent: (instanceId: string, agent: string) => void;
	sendMessage: (
		instanceId: string,
		content: string,
		attachments?: ChatAttachment[],
		options?: SendMessageOptions,
	) => Promise<void>;
	appendStream: (instanceId: string, text: string, done: boolean) => void;
	finalizeStream: (
		instanceId: string,
		finalText: string,
		cost?: number,
		durationMs?: number,
	) => void;
	setActivity: (instanceId: string, activity: string) => void;
	setTokens: (instanceId: string, tokensIn: number, tokensOut: number) => void;
	abortStream: (instanceId: string) => void;
	applyRuntimeEvent: (instanceId: string, event: ChatRuntimeEvent) => void;
	loadHistory: (instanceId: string, threadId: string) => Promise<void>;
	loadRequests: (instanceId: string) => Promise<void>;
	fetchThreads: (instanceId: string) => Promise<void>;
	searchThreads: (instanceId: string, query: string) => Promise<void>;
	switchThread: (instanceId: string, threadId: string) => Promise<void>;
	renameThread: (instanceId: string, threadId: string, title: string) => Promise<void>;
	deleteThread: (instanceId: string, threadId: string) => Promise<void>;
	archiveThread: (instanceId: string, threadId: string) => Promise<void>;
	resolveRequest: (
		instanceId: string,
		requestId: string,
		action: "approve" | "reject" | "respond",
		response?: string,
	) => Promise<void>;
	loadModelInfo: (instanceId: string) => Promise<void>;
	setModelOverride: (instanceId: string, model?: string | null) => Promise<void>;
	selectChangePath: (instanceId: string, path: string | null) => void;
	setDiffOpen: (instanceId: string, open: boolean) => void;
	addTerminalSnippet: (
		instanceId: string,
		snippet: Omit<TerminalSnippet, "id" | "createdAt" | "lineStart" | "lineEnd">
			& { lineStart?: number; lineEnd?: number },
	) => void;
	removeTerminalSnippet: (instanceId: string, snippetId: string) => void;
	dismissEphemeralBtw: (instanceId: string) => void;
	askBtw: (instanceId: string, question: string) => Promise<void>;
	drainQueue: (instanceId: string, threadId?: string | null) => void;
}

export const useFleetChatStore = create<FleetChatState>()((set, get) => ({
	instances: {},

	ensureInstance: (instanceId, activeAgent) =>
		set((state) => {
			const existing = state.instances[instanceId];
			if (existing) {
				if (!activeAgent || existing.activeAgent === activeAgent) return {};
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...existing,
							activeAgent,
							modelInfo: null,
							modelLoading: false,
						},
					},
				};
			}
			return {
				instances: {
					...state.instances,
					[instanceId]: createFleetChatInstance(activeAgent ?? "nyx"),
				},
			};
		}),

	resetInstance: (instanceId) =>
		set((state) => {
			const current = state.instances[instanceId] ?? createFleetChatInstance();
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...createFleetChatInstance(current.activeAgent),
						activeAgent: current.activeAgent,
						pendingRequests: current.pendingRequests,
						threads: current.threads,
					},
				},
			};
		}),

	setActiveAgent: (instanceId, agent) =>
		set((state) => ({
			instances: {
				...state.instances,
				[instanceId]: {
					...(state.instances[instanceId] ?? createFleetChatInstance(agent)),
					activeAgent: agent,
					modelInfo: null,
					modelLoading: false,
				},
			},
		})),

	sendMessage: async (instanceId, content, attachments, options) => {
		const state = get();
		const instance = state.instances[instanceId] ?? createFleetChatInstance();
		const trimmedContent = content.trim();
		if (!trimmedContent && (!attachments || attachments.length === 0)) return;

		const terminalContext = buildTerminalContextBlock(instance.terminalSnippets);
		const outboundContent = terminalContext
			? `${terminalContext}\n\n[User Message]\n${trimmedContent}`
			: trimmedContent;

		if (instance.streaming) {
			set((current) => {
				const target = current.instances[instanceId] ?? createFleetChatInstance(instance.activeAgent);
				return {
					instances: {
						...current.instances,
						[instanceId]: {
							...target,
							messages: options?.skipUserBubble
								? target.messages
								: [
									...target.messages,
									{
										id: uuid(),
										role: "user",
										content: trimmedContent,
										timestamp: Date.now(),
										attachments: attachments?.map((attachment) => ({
											name: attachment.name,
											mimeType: attachment.mimeType,
											previewUrl: attachment.previewUrl,
										})),
									},
								],
							queuedMessages: [
								...target.queuedMessages,
								{
									id: uuid(),
									content: trimmedContent,
									attachments,
									threadId: options?.forceThreadId ?? target.threadId ?? null,
								},
							],
						},
					},
				};
			});
			return;
		}

		const userMessage: ChatMessage | null = options?.skipUserBubble
			? null
			: {
				id: uuid(),
				role: "user",
				content: trimmedContent,
				timestamp: Date.now(),
				attachments: attachments?.map((attachment) => ({
					name: attachment.name,
					mimeType: attachment.mimeType,
					previewUrl: attachment.previewUrl,
				})),
			};

		const assistantMessage: ChatMessage = {
			id: uuid(),
			role: "assistant",
			content: "",
			agent: instance.activeAgent,
			timestamp: Date.now(),
			streaming: true,
		};

		set((current) => {
			const target = current.instances[instanceId] ?? createFleetChatInstance(instance.activeAgent);
			return {
				instances: {
					...current.instances,
					[instanceId]: {
						...target,
						messages: userMessage
							? [...target.messages, userMessage, assistantMessage]
							: [...target.messages, assistantMessage],
						streaming: true,
						streamingMessageId: assistantMessage.id,
					},
				},
			};
		});

		try {
			const payload: {
				message: string;
				agent: string;
				threadId?: string | null;
				idempotencyKey: string;
				files?: Array<{ name: string; type: string; data: string }>;
			} = {
				message: outboundContent,
				agent: instance.activeAgent,
				idempotencyKey: uuid(),
			};
			const targetThreadId = options?.forceThreadId ?? instance.threadId;
			if (targetThreadId) payload.threadId = targetThreadId;
			if (attachments?.length) {
				payload.files = attachments.map((attachment) => ({
					name: attachment.name,
					type: attachment.mimeType,
					data: attachment.base64,
				}));
			}

			const result = await requestInstance<{ messageId: string; threadId: string; runId: string; status: "started" | "in_flight" | "ok" | "queued"; queued?: boolean }>(
				instanceId,
				"chat.send",
				payload,
			);

			set((current) => {
				const target = current.instances[instanceId] ?? createFleetChatInstance(instance.activeAgent);
				const nextState: FleetChatInstanceState = {
					...target,
					threadId: result.threadId ?? target.threadId,
					terminalSnippets: [],
					runtime: result.queued
						? target.runtime
						: {
							...target.runtime,
							presence: "active",
							activeRunId: result.runId,
							activeThreadId: result.threadId,
							lastEventAt: Date.now(),
							lastStartedAt: Date.now(),
						},
				};

				if (result.queued) {
					nextState.messages = target.messages.filter((message) => message.id !== assistantMessage.id);
					nextState.streaming = false;
					nextState.streamingMessageId = null;
					nextState.queuedMessages = [
						...target.queuedMessages,
						{
							id: uuid(),
							content: trimmedContent,
							attachments,
							threadId: targetThreadId ?? null,
						},
					];
				}

				return {
					instances: {
						...current.instances,
						[instanceId]: nextState,
					},
				};
			});
		} catch (error) {
			console.error(`[fleet-chat.send:${instanceId}] failed:`, error);
			set((current) => {
				const target = current.instances[instanceId] ?? createFleetChatInstance(instance.activeAgent);
				return {
					instances: {
						...current.instances,
						[instanceId]: {
							...target,
							messages: target.messages.map((message) =>
								message.id === assistantMessage.id
									? { ...message, content: "Failed to send message.", streaming: false }
									: message,
							),
							streaming: false,
							streamingMessageId: null,
						},
					},
				};
			});
		}
	},

	appendStream: (instanceId, text, done) =>
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
			const streamingMessageId = instance.streamingMessageId;

			if (!streamingMessageId && done) {
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...instance,
							streaming: false,
							streamingMessageId: null,
						},
					},
				};
			}

			if (!streamingMessageId) {
				if (!text.trim() && !done) return {};
				const nextMessage: ChatMessage = {
					id: uuid(),
					role: "assistant",
					content: text,
					agent: instance.activeAgent,
					timestamp: Date.now(),
					streaming: true,
				};
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...instance,
							messages: [...instance.messages, nextMessage],
							streaming: true,
							streamingMessageId: nextMessage.id,
						},
					},
				};
			}

			const messages = instance.messages.map((message) =>
				message.id === streamingMessageId
					? {
						...message,
						content: `${message.content}${text}`,
						streaming: !done,
						activity: done ? undefined : message.activity,
					}
					: message,
			);

			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						messages: done
							? pruneEmptyAssistantPlaceholders(messages)
							: messages,
						streaming: !done,
						streamingMessageId: done ? null : streamingMessageId,
					},
				},
			};
		}),

	finalizeStream: (instanceId, finalText, cost, durationMs) =>
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
			const targetIndex = findFinalAssistantTargetIndex(instance.messages, instance.streamingMessageId, finalText);
			const messages = targetIndex >= 0
				? instance.messages.map((message, index) =>
					index === targetIndex
						? {
							...message,
							content: finalText || message.content,
							streaming: false,
							cost,
							durationMs,
							activity: undefined,
						}
						: message,
				)
				: finalText.trim()
					? [
						...instance.messages,
						{
							id: uuid(),
							role: "assistant",
							content: finalText,
							agent: instance.activeAgent,
							timestamp: Date.now(),
							streaming: false,
							cost,
							durationMs,
						},
					]
					: instance.messages;
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						messages: pruneEmptyAssistantPlaceholders(messages),
						streaming: false,
						streamingMessageId: null,
					},
				},
			};
		}),

	setActivity: (instanceId, activity) =>
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
			if (!instance.streamingMessageId) return {};
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						messages: instance.messages.map((message) =>
							message.id === instance.streamingMessageId
								? { ...message, activity }
								: message,
						),
					},
				},
			};
		}),

	setTokens: (instanceId, tokensIn, tokensOut) =>
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
			const targetMessageId = instance.streamingMessageId
				?? [...instance.messages].reverse().find((message) => message.role === "assistant")?.id;
			if (!targetMessageId) return {};
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						messages: instance.messages.map((message) =>
							message.id === targetMessageId
								? { ...message, tokensIn, tokensOut }
								: message,
						),
					},
				},
			};
		}),

	abortStream: (instanceId) => {
		const instance = get().instances[instanceId] ?? createFleetChatInstance();
		if (instance.threadId) {
			requestInstance(instanceId, "chat.abort", { threadId: instance.threadId, runId: instance.runtime.activeRunId ?? undefined }).catch((error) => {
				console.warn(`[fleet-chat.abort:${instanceId}] request failed:`, error);
			});
		}
		set((state) => {
			const target = state.instances[instanceId] ?? createFleetChatInstance();
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...target,
						messages: target.messages.map((message) =>
							message.id === target.streamingMessageId
								? {
									...message,
									streaming: false,
									content: `${message.content}\n\n[Aborted]`.trim(),
								}
								: message,
						),
						streaming: false,
						streamingMessageId: null,
						runtime: {
							...target.runtime,
							presence: "idle",
							activeRunId: null,
							activeThreadId: null,
							lastEventAt: Date.now(),
							lastCompletedAt: Date.now(),
						},
					},
				},
			};
		});
	},

	applyRuntimeEvent: (instanceId, event) => {
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						runtime: advanceRuntimeState(instance.runtime, event),
					},
				},
			};
		});

		const current = get().instances[instanceId] ?? createFleetChatInstance();
		if ("threadId" in event && event.threadId && !matchesCurrentThread(current, event.threadId)) {
			if (event.type === "turn.completed") {
				get().drainQueue(instanceId, event.threadId);
			}
			if (event.type !== "thread.started" && event.type !== "chat.active") return;
		}

		switch (event.type) {
			case "turn.started":
			case "chat.active":
				set((state) => {
					const instance = state.instances[instanceId] ?? createFleetChatInstance();
					const threadId = "threadId" in event ? event.threadId : instance.threadId;
					const messages = pruneEmptyAssistantPlaceholders(instance.messages, instance.streamingMessageId);
					const streamingMessageId = messages.some((message) => message.id === instance.streamingMessageId && message.streaming)
						? instance.streamingMessageId
						: messages.find((message) => message.streaming)?.id ?? null;
					const lifecycleEvent = createLifecycleExecutionEvent(event);
					const alreadyStreaming = Boolean(streamingMessageId);
					if (alreadyStreaming) {
						return {
							instances: {
								...state.instances,
								[instanceId]: {
									...instance,
									threadId: threadId ?? instance.threadId,
									messages,
									streaming: Boolean(streamingMessageId),
									streamingMessageId,
									executionEvents: lifecycleEvent
										? upsertExecutionEvent(instance.executionEvents, lifecycleEvent, streamingMessageId)
										: instance.executionEvents,
								},
							},
						};
					}
					const nextMessage: ChatMessage = {
						id: uuid(),
						role: "assistant",
						content: "",
						agent: event.agent ?? instance.activeAgent,
						timestamp: event.startedAt ?? Date.now(),
						streaming: true,
					};
					return {
						instances: {
							...state.instances,
							[instanceId]: {
								...instance,
								threadId: threadId ?? instance.threadId,
								messages: [...messages, nextMessage],
								streaming: true,
								streamingMessageId: nextMessage.id,
								executionEvents: lifecycleEvent
									? upsertExecutionEvent(instance.executionEvents, lifecycleEvent, nextMessage.id)
									: instance.executionEvents,
							},
						},
					};
				});
				return;
			case "thread.started":
				set((state) => {
					const instance = state.instances[instanceId] ?? createFleetChatInstance();
					const messages = pruneEmptyAssistantPlaceholders(instance.messages, instance.streamingMessageId);
					const streamingMessageId = messages.some((message) => message.id === instance.streamingMessageId && message.streaming)
						? instance.streamingMessageId
						: messages.find((message) => message.streaming)?.id ?? null;
					if (streamingMessageId) {
						return {
							instances: {
								...state.instances,
								[instanceId]: {
									...instance,
									threadId: event.threadId,
									messages,
									streaming: true,
									streamingMessageId,
								},
							},
						};
					}
					const nextMessage: ChatMessage = {
						id: uuid(),
						role: "assistant",
						content: "",
						agent: event.agent,
						timestamp: event.startedAt,
						streaming: true,
					};
					return {
						instances: {
							...state.instances,
							[instanceId]: {
								...instance,
								threadId: event.threadId,
								messages: [...messages, nextMessage],
								streaming: true,
								streamingMessageId: nextMessage.id,
							},
						},
					};
				});
				return;
			case "response.delta":
				if (event.delta) {
					get().appendStream(instanceId, event.delta, false);
				}
				return;
			case "activity.updated":
				if (event.activity) get().setActivity(instanceId, event.activity);
				if (event.tokensIn !== undefined && event.tokensOut !== undefined) {
					get().setTokens(instanceId, event.tokensIn, event.tokensOut);
				}
				return;
			case "turn.completed":
				{
					const lifecycleEvent = createLifecycleExecutionEvent(event);
					if (lifecycleEvent) {
						set((state) => {
							const instance = state.instances[instanceId] ?? createFleetChatInstance();
							const targetMessageId = instance.streamingMessageId
								?? [...instance.messages].reverse().find((message) => message.role === "assistant")?.id;
							return {
								instances: {
									...state.instances,
									[instanceId]: {
										...instance,
										executionEvents: upsertExecutionEvent(instance.executionEvents, lifecycleEvent, targetMessageId),
									},
								},
							};
						});
					}
				}
				if (event.tokensIn !== undefined && event.tokensOut !== undefined) {
					get().setTokens(instanceId, event.tokensIn, event.tokensOut);
				}
				if (event.text) {
					get().finalizeStream(instanceId, event.text, event.cost, event.durationMs);
				} else {
					get().appendStream(instanceId, "", true);
				}
				get().drainQueue(instanceId);
				return;
			case "item.started":
			case "item.updated":
			case "item.completed":
				set((state) => {
					const instance = state.instances[instanceId] ?? createFleetChatInstance();
					const targetMessageId = instance.streamingMessageId
						?? [...instance.messages].reverse().find((message) => message.role === "assistant")?.id;
					const nextEvent: ExecutionEvent = {
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
						messageId: targetMessageId,
					};
					return {
						instances: {
							...state.instances,
							[instanceId]: {
								...instance,
								executionEvents: upsertExecutionEvent(instance.executionEvents, nextEvent, targetMessageId),
							},
						},
					};
				});
				return;
			case "context.updated":
				if (!event.estimated && event.utilizationPct !== undefined) {
					set((state) => {
						const instance = state.instances[instanceId] ?? createFleetChatInstance();
						return {
							instances: {
								...state.instances,
								[instanceId]: {
									...instance,
									contextPct: Math.round(event.utilizationPct),
								},
							},
						};
					});
				}
				return;
			case "diff.updated":
				set((state) => {
					const instance = state.instances[instanceId] ?? createFleetChatInstance();
					const changes = [...event.changes].sort((left, right) => left.timestamp - right.timestamp);
					const selectedDisplayPath = instance.selectedChangePath
						? toDisplayPath(instance.selectedChangePath)
						: null;
					const selectedChangePath = selectedDisplayPath
						? changes.find((change) => toDisplayPath(change.filePath) === selectedDisplayPath)?.filePath ?? changes[0]?.filePath ?? null
						: changes[0]?.filePath ?? null;
					return {
						instances: {
							...state.instances,
							[instanceId]: {
								...instance,
								threadChanges: changes,
								selectedChangePath,
								diffOpen: changes.length > 0,
							},
						},
					};
				});
				return;
			case "request.opened":
				set((state) => {
					const instance = state.instances[instanceId] ?? createFleetChatInstance();
					return {
						instances: {
							...state.instances,
							[instanceId]: {
								...instance,
								pendingRequests: [
									...instance.pendingRequests.filter((request) => request.requestId !== event.request.requestId),
									event.request,
								].sort((left, right) => left.createdAt - right.createdAt),
							},
						},
					};
				});
				return;
			case "request.resolved":
				set((state) => {
					const instance = state.instances[instanceId] ?? createFleetChatInstance();
					return {
						instances: {
							...state.instances,
							[instanceId]: {
								...instance,
								pendingRequests: instance.pendingRequests.filter((request) => request.requestId !== event.requestId),
							},
						},
					};
				});
				return;
			default:
				return;
		}
	},

	loadHistory: async (instanceId, threadId) => {
		return runDeduped(historyInflight, `${instanceId}|${threadId}`, async () => {
			const requestSeq = nextRequestSeq(historyRequestSeq, instanceId);
			try {
				await waitForInstanceOpen(instanceId, 10000);
			} catch {
				console.error(`[fleet-chat.history:${instanceId}] WS never opened, skipping`);
				return;
			}

			try {
				const result = await requestInstance<{ messages: ChatMessage[]; executionEvents?: ExecutionEvent[] }>(
					instanceId,
					"chat.history",
					{ threadId, limit: 50 },
				);
				const messages = result.messages ?? [];
				const executionEvents = result.executionEvents ?? [];
				set((state) => {
					if (!isCurrentRequest(historyRequestSeq, instanceId, requestSeq)) return state;
					const instance = state.instances[instanceId] ?? createFleetChatInstance();
					if (instance.threadId !== threadId) return state;
					return {
						instances: {
							...state.instances,
							[instanceId]: {
								...instance,
								messages: mergeHistoryMessages(
									messages,
									instance.messages,
									instance.streamingMessageId,
									shouldKeepLocalHistoryMessage,
								),
								threadId,
								executionEvents,
							},
						},
					};
				});
				const resultChanges = await requestInstance<{ changes: ThreadChange[] }>(
					instanceId,
					"threads.changes",
					{ id: threadId },
				);
				if (!isCurrentRequest(historyRequestSeq, instanceId, requestSeq)) return;
				if ((get().instances[instanceId] ?? createFleetChatInstance()).threadId !== threadId) return;
				get().applyRuntimeEvent(instanceId, {
					type: "diff.updated",
					threadId,
					changes: resultChanges.changes ?? [],
				});
			} catch (error) {
				console.error(`[fleet-chat.history:${instanceId}] failed:`, error);
			}
		});
	},

	loadRequests: async (instanceId) => {
		return runDeduped(requestsInflight, instanceId, async () => {
			set((state) => {
				const instance = state.instances[instanceId] ?? createFleetChatInstance();
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...instance,
							requestsLoading: true,
						},
					},
				};
			});
			try {
				const result = await requestInstance<{ requests: RuntimeRequest[] }>(
					instanceId,
					"chat.requests.list",
					{},
				);
				set((state) => {
					const instance = state.instances[instanceId] ?? createFleetChatInstance();
					return {
						instances: {
							...state.instances,
							[instanceId]: {
								...instance,
								pendingRequests: result.requests ?? [],
								requestsLoading: false,
							},
						},
					};
				});
			} catch (error) {
				console.error(`[fleet-chat.requests:${instanceId}] failed:`, error);
				set((state) => {
					const instance = state.instances[instanceId] ?? createFleetChatInstance();
					return {
						instances: {
							...state.instances,
							[instanceId]: {
								...instance,
								requestsLoading: false,
							},
						},
					};
				});
			}
		});
	},

	fetchThreads: async (instanceId) => {
		return runDeduped(threadsInflight, instanceId, async () => {
			set((state) => {
				const instance = state.instances[instanceId] ?? createFleetChatInstance();
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...instance,
							threadsLoading: true,
						},
					},
				};
			});
			try {
				const result = await requestInstance<{ threads: Thread[] }>(instanceId, "threads.list", {
					limit: 24,
					offset: 0,
				});
				set((state) => {
					const instance = state.instances[instanceId] ?? createFleetChatInstance();
					return {
						instances: {
							...state.instances,
							[instanceId]: {
								...instance,
								threads: result.threads ?? [],
								threadsLoading: false,
							},
						},
					};
				});
			} catch (error) {
				console.error(`[fleet-chat.threads:${instanceId}] failed:`, error);
				set((state) => {
					const instance = state.instances[instanceId] ?? createFleetChatInstance();
					return {
						instances: {
							...state.instances,
							[instanceId]: {
								...instance,
								threadsLoading: false,
							},
						},
					};
				});
			}
		});
	},

	searchThreads: async (instanceId, query) => {
		const trimmed = query.trim();
		const requestSeq = nextRequestSeq(threadSearchRequestSeq, instanceId);
		if (trimmed.length < 2) {
			set((state) => {
				const instance = state.instances[instanceId] ?? createFleetChatInstance();
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...instance,
							threadSearchResults: [],
							threadsSearching: false,
						},
					},
				};
			});
			return;
		}
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						threadsSearching: true,
					},
				},
			};
		});
		try {
			const result = await requestInstance<{ threads: FleetThreadSearchResult[] }>(instanceId, "threads.search", {
				query: trimmed,
				limit: 20,
			});
			if (!isCurrentRequest(threadSearchRequestSeq, instanceId, requestSeq)) return;
			set((state) => {
				const instance = state.instances[instanceId] ?? createFleetChatInstance();
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...instance,
							threadSearchResults: result.threads ?? [],
							threadsSearching: false,
						},
					},
				};
			});
		} catch (error) {
			if (!isCurrentRequest(threadSearchRequestSeq, instanceId, requestSeq)) return;
			console.error(`[fleet-chat.thread-search:${instanceId}] failed:`, error);
			set((state) => {
				const instance = state.instances[instanceId] ?? createFleetChatInstance();
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...instance,
							threadSearchResults: [],
							threadsSearching: false,
						},
					},
				};
			});
		}
	},

	switchThread: async (instanceId, threadId) => {
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						threadId,
						messages: [],
						streaming: false,
						streamingMessageId: null,
						contextPct: null,
						executionEvents: [],
						threadChanges: [],
						selectedChangePath: null,
						diffOpen: false,
						terminalSnippets: [],
						ephemeralBtw: null,
						modelInfo: null,
						modelLoading: false,
					},
				},
			};
		});
		await get().loadHistory(instanceId, threadId);
		void get().loadModelInfo(instanceId);
	},

	renameThread: async (instanceId, threadId, title) => {
		try {
			await requestInstance(instanceId, "threads.rename", { id: threadId, title });
			set((state) => {
				const instance = state.instances[instanceId] ?? createFleetChatInstance();
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...instance,
							threads: instance.threads.map((thread) =>
								thread.id === threadId ? { ...thread, title } : thread,
							),
						},
					},
				};
			});
			toast_success("Thread renamed");
		} catch (error) {
			toast_error("Failed to rename thread");
			throw error;
		}
	},

	deleteThread: async (instanceId, threadId) => {
		try {
			await requestInstance(instanceId, "threads.delete", { id: threadId });
			set((state) => {
				const instance = state.instances[instanceId] ?? createFleetChatInstance();
				const deletingActive = instance.threadId === threadId;
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...instance,
							threads: instance.threads.filter((thread) => thread.id !== threadId),
							pendingRequests: instance.pendingRequests.filter((request) => request.threadId !== threadId),
							...(deletingActive ? {
								threadId: null,
								messages: [],
								streaming: false,
								streamingMessageId: null,
								contextPct: null,
								executionEvents: [],
								threadChanges: [],
								selectedChangePath: null,
								diffOpen: false,
								terminalSnippets: [],
								queuedMessages: [],
								ephemeralBtw: null,
								modelInfo: null,
								modelLoading: false,
							} : {}),
						},
					},
				};
			});
			toast_success("Thread deleted");
		} catch (error) {
			toast_error("Failed to delete thread");
			throw error;
		}
	},

	archiveThread: async (instanceId, threadId) => {
		try {
			await requestInstance(instanceId, "threads.archive", { id: threadId });
			set((state) => {
				const instance = state.instances[instanceId] ?? createFleetChatInstance();
				const archivingActive = instance.threadId === threadId;
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...instance,
							threads: instance.threads.filter((thread) => thread.id !== threadId),
							pendingRequests: instance.pendingRequests.filter((request) => request.threadId !== threadId),
							...(archivingActive ? {
								threadId: null,
								messages: [],
								streaming: false,
								streamingMessageId: null,
								contextPct: null,
								executionEvents: [],
								threadChanges: [],
								selectedChangePath: null,
								diffOpen: false,
								terminalSnippets: [],
								queuedMessages: [],
								ephemeralBtw: null,
								modelInfo: null,
								modelLoading: false,
							} : {}),
						},
					},
				};
			});
			toast_success("Thread archived");
		} catch (error) {
			toast_error("Failed to archive thread");
			throw error;
		}
	},

	resolveRequest: async (instanceId, requestId, action, response) => {
		await requestInstance(instanceId, "chat.request.resolve", { requestId, action, response });
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						pendingRequests: instance.pendingRequests.filter((request) => request.requestId !== requestId),
					},
				},
			};
		});
	},

	loadModelInfo: async (instanceId) => {
		const instance = get().instances[instanceId] ?? createFleetChatInstance();
		const requestedThreadId = instance.threadId;
		const requestedAgent = instance.activeAgent;
		return runDeduped(modelInflight, `${instanceId}|${requestedThreadId ?? "none"}|${requestedAgent}`, async () => {
			const requestSeq = nextRequestSeq(modelRequestSeq, instanceId);
			set((state) => {
				const instance = state.instances[instanceId] ?? createFleetChatInstance();
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...instance,
							modelLoading: true,
						},
					},
				};
			});
			try {
				const result = await requestInstance<ChatModelInfo>(
					instanceId,
					"chat.model.get",
					{
						threadId: requestedThreadId,
						agent: requestedAgent,
					},
				);
				set((state) => {
					if (!isCurrentRequest(modelRequestSeq, instanceId, requestSeq)) return state;
					const target = state.instances[instanceId] ?? createFleetChatInstance();
					if (target.threadId !== requestedThreadId || target.activeAgent !== requestedAgent) return state;
					return {
						instances: {
							...state.instances,
							[instanceId]: {
								...target,
								modelInfo: result,
								modelLoading: false,
							},
						},
					};
				});
			} catch (error) {
				console.error(`[fleet-chat.model.get:${instanceId}] failed:`, error);
				set((state) => {
					if (!isCurrentRequest(modelRequestSeq, instanceId, requestSeq)) return state;
					const instance = state.instances[instanceId] ?? createFleetChatInstance();
					return {
						instances: {
							...state.instances,
							[instanceId]: {
								...instance,
								modelLoading: false,
							},
						},
					};
				});
			}
		});
	},

	setModelOverride: async (instanceId, model) => {
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						modelLoading: true,
					},
				},
			};
		});
		try {
			const instance = get().instances[instanceId] ?? createFleetChatInstance();
			const result = await requestInstance<ChatModelInfo>(
				instanceId,
				"chat.model.set",
				{
					threadId: instance.threadId,
					agent: instance.activeAgent,
					model: model ?? null,
				},
			);
			set((state) => {
				const target = state.instances[instanceId] ?? createFleetChatInstance();
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...target,
							modelInfo: result,
							modelLoading: false,
						},
					},
				};
			});
		} catch (error) {
			console.error(`[fleet-chat.model.set:${instanceId}] failed:`, error);
			set((state) => {
				const instance = state.instances[instanceId] ?? createFleetChatInstance();
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...instance,
							modelLoading: false,
						},
					},
				};
			});
		}
	},

	selectChangePath: (instanceId, path) =>
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						selectedChangePath: path,
						diffOpen: path ? true : instance.diffOpen,
					},
				},
			};
		}),

	setDiffOpen: (instanceId, open) =>
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						diffOpen: open,
					},
				},
			};
		}),

	addTerminalSnippet: (instanceId, snippet) =>
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
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
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						terminalSnippets: [
							...instance.terminalSnippets.filter((entry) =>
								entry.itemId !== snippet.itemId || entry.content !== snippet.content,
							),
							nextSnippet,
						],
					},
				},
			};
		}),

	removeTerminalSnippet: (instanceId, snippetId) =>
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						terminalSnippets: instance.terminalSnippets.filter((snippet) => snippet.id !== snippetId),
					},
				},
			};
		}),

	dismissEphemeralBtw: (instanceId) =>
		set((state) => {
			const instance = state.instances[instanceId] ?? createFleetChatInstance();
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...instance,
						ephemeralBtw: null,
					},
				},
			};
		}),

	askBtw: async (instanceId, question) => {
		const instance = get().instances[instanceId] ?? createFleetChatInstance();
		try {
			const result = await requestInstance<{ answer: string }>(instanceId, "chat.btw", {
				agent: instance.activeAgent,
				question,
				threadId: instance.threadId ?? undefined,
			});
			set((state) => {
				const target = state.instances[instanceId] ?? createFleetChatInstance();
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...target,
							ephemeralBtw: result.answer,
						},
					},
				};
			});
		} catch (error) {
			console.error(`[fleet-chat.btw:${instanceId}] failed:`, error);
			set((state) => {
				const target = state.instances[instanceId] ?? createFleetChatInstance();
				return {
					instances: {
						...state.instances,
						[instanceId]: {
							...target,
							ephemeralBtw: `Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
						},
					},
				};
			});
		}
	},

	drainQueue: (instanceId, threadId) => {
		const instance = get().instances[instanceId] ?? createFleetChatInstance();
		if (instance.streaming) return;
		const nextIndex = threadId
			? instance.queuedMessages.findIndex((entry) => entry.threadId === threadId)
			: 0;
		if (nextIndex < 0) return;
		const next = instance.queuedMessages[nextIndex];
		if (!next) return;
		set((state) => {
			const target = state.instances[instanceId] ?? createFleetChatInstance();
			return {
				instances: {
					...state.instances,
					[instanceId]: {
						...target,
						queuedMessages: target.queuedMessages.filter((_, index) => index !== nextIndex),
					},
				},
			};
		});
		void get().sendMessage(instanceId, next.content, next.attachments, {
			skipUserBubble: true,
			forceThreadId: next.threadId,
		});
	},
}));

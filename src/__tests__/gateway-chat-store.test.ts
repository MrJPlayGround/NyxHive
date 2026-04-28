import { beforeEach, describe, expect, it, mock } from "bun:test";
import { useChatStore } from "../gateway/src/stores/chat";
import { gateway } from "../gateway/src/lib/ws";

function resetChatStore() {
	useChatStore.setState({
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
		sidebarCollapsed: false,
	});
}

describe("gateway chat store", () => {
	beforeEach(() => {
		resetChatStore();
		gateway.request = mock(async (method: string, payload: unknown) => {
			if (method === "chat.send") {
				const threadId = (payload as { threadId?: string }).threadId ?? "thread-new";
				return { messageId: "msg-1", threadId, runId: `chat:${threadId}:1`, status: "started" };
			}
			return {};
		}) as typeof gateway.request;
	});

	it("drains queued messages back into the thread that created them", async () => {
		useChatStore.setState({
			threadId: "thread-a",
			streaming: true,
			streamingMessageId: "assistant-a",
			messages: [
				{
					id: "assistant-a",
					role: "assistant",
					content: "working",
					timestamp: 1,
					streaming: true,
				},
			],
			_streamingThreads: new Map([
				["thread-a", {
					streamingMessageId: "assistant-a",
					messages: [{
						id: "assistant-a",
						role: "assistant",
						content: "working",
						timestamp: 1,
						streaming: true,
					}],
					contextPct: null,
				}],
			]),
		});

		await useChatStore.getState().sendMessage("queued follow-up");
		expect(useChatStore.getState().queuedMessages).toHaveLength(1);
		expect(useChatStore.getState().queuedMessages[0]?.threadId).toBe("thread-a");

		useChatStore.setState({
			threadId: "thread-b",
			streaming: false,
			streamingMessageId: null,
			messages: [],
			_streamingThreads: new Map(),
		});

		useChatStore.getState().drainQueue("thread-a");
		await Promise.resolve();

		expect(gateway.request).toHaveBeenCalledWith(
			"chat.send",
			expect.objectContaining({
				message: "queued follow-up",
				threadId: "thread-a",
				idempotencyKey: expect.any(String),
			}),
		);
		expect(useChatStore.getState().threadId).toBe("thread-b");
		expect(useChatStore.getState().queuedMessages).toHaveLength(0);
	});

	it("adds a lifecycle trace event while a turn is active before tool events arrive", () => {
		useChatStore.setState({ threadId: "thread-a" });

		useChatStore.getState().applyRuntimeEvent({
			type: "turn.started",
			threadId: "thread-a",
			turn: 1,
			runId: "chat:thread-a:1",
			agent: "nyx",
			startedAt: 100,
		});

		expect(useChatStore.getState().streaming).toBe(true);
		expect(useChatStore.getState().executionEvents).toHaveLength(1);
		expect(useChatStore.getState().executionEvents[0]).toMatchObject({
			id: "runtime:chat:thread-a:1:lifecycle",
			kind: "status",
			phase: "started",
			title: "Run started",
			messageId: useChatStore.getState().streamingMessageId ?? undefined,
		});

		useChatStore.getState().applyRuntimeEvent({
			type: "turn.completed",
			threadId: "thread-a",
			turn: 1,
			runId: "chat:thread-a:1",
			status: "completed",
			finishedAt: 200,
			text: "done",
		});

		expect(useChatStore.getState().executionEvents).toHaveLength(1);
		expect(useChatStore.getState().executionEvents[0]).toMatchObject({
			id: "runtime:chat:thread-a:1:lifecycle",
			phase: "completed",
			title: "Run completed",
		});
	});
});

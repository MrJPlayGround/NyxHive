import {
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
  type Mock,
} from "bun:test";
import { gateway } from "../lib/ws";
import { fleetGateway } from "../lib/fleet-gateway";
import * as toastModule from "../components/ui/toast";
import { useFleetChatStore } from "./fleet-chat";

let gatewayRequest: Mock<any>;
let gatewayWaitForOpen: Mock<any>;
let fleetRequest: Mock<any>;
let fleetWaitForOpen: Mock<any>;
let toastError: Mock<any>;
let toastSuccess: Mock<any>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function resetFleetChatStore() {
  useFleetChatStore.setState((state) => ({
    ...state,
    instances: {},
  }));
}

function setInstanceState(
  instanceId: string,
  updates: Record<string, unknown>,
) {
  useFleetChatStore.setState((state) => {
    const existing = state.instances[instanceId];
    if (!existing) return state;
    return {
      ...state,
      instances: {
        ...state.instances,
        [instanceId]: {
          ...existing,
          ...updates,
        },
      },
    };
  });
}

describe("useFleetChatStore queue ownership", () => {
  beforeEach(() => {
    resetFleetChatStore();
    gatewayRequest?.mockRestore();
    gatewayWaitForOpen?.mockRestore();
    fleetRequest?.mockRestore();
    fleetWaitForOpen?.mockRestore();
    toastError?.mockRestore();
    toastSuccess?.mockRestore();

    gatewayRequest = spyOn(gateway, "request").mockResolvedValue({});
    gatewayWaitForOpen = spyOn(gateway, "waitForOpen").mockResolvedValue(
      undefined,
    );
    fleetRequest = spyOn(fleetGateway, "request").mockImplementation(
      async (_instanceId: string, method: string, payload: any) => {
        if (method === "chat.send") {
          return {
            messageId: `message-${Math.random().toString(16).slice(2)}`,
            threadId: payload.threadId ?? "thread-created",
            runId: `chat:${payload.threadId ?? "thread-created"}:1`,
            status: "started",
          };
        }
        return {};
      },
    );
    fleetWaitForOpen = spyOn(fleetGateway, "getClient").mockReturnValue({
      waitForOpen: async () => {},
    } as ReturnType<typeof fleetGateway.getClient>);
    toastError = spyOn(toastModule, "toast_error").mockImplementation(() => {});
    toastSuccess = spyOn(toastModule, "toast_success").mockImplementation(
      () => {},
    );
    useFleetChatStore.getState().ensureInstance("nyxlabs", "nyx");
  });

  test("queued follow-ups keep their originating thread id while streaming", async () => {
    setInstanceState("nyxlabs", {
      threadId: "thread-a",
      streaming: true,
      messages: [],
      queuedMessages: [],
    });

    await useFleetChatStore
      .getState()
      .sendMessage("nyxlabs", "follow up after this");

    const queued =
      useFleetChatStore.getState().instances.nyxlabs?.queuedMessages ?? [];
    expect(queued).toHaveLength(1);
    expect(queued[0]?.content).toBe("follow up after this");
    expect(queued[0]?.threadId).toBe("thread-a");
    expect(fleetRequest).not.toHaveBeenCalled();
  });

  test("turn completion drains a queued follow-up for its original thread even after switching threads", async () => {
    setInstanceState("nyxlabs", {
      threadId: "thread-a",
      streaming: true,
      messages: [],
      queuedMessages: [],
    });

    await useFleetChatStore
      .getState()
      .sendMessage("nyxlabs", "follow up after this");

    setInstanceState("nyxlabs", {
      threadId: "thread-b",
      streaming: false,
      streamingMessageId: null,
      messages: [],
    });

    useFleetChatStore.getState().applyRuntimeEvent("nyxlabs", {
      type: "turn.completed",
      threadId: "thread-a",
      status: "completed",
      finishedAt: Date.now(),
      text: "done",
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fleetRequest).toHaveBeenCalledTimes(1);
    expect(fleetRequest).toHaveBeenCalledWith(
      "nyxlabs",
      "chat.send",
      expect.objectContaining({
        message: "follow up after this",
        threadId: "thread-a",
        agent: "nyx",
        idempotencyKey: expect.any(String),
      }),
      undefined,
    );
    expect(
      useFleetChatStore.getState().instances.nyxlabs?.queuedMessages,
    ).toHaveLength(0);
  });

  test("ignores stale history results after a newer thread switch wins", async () => {
    const historyA = deferred<{
      messages: Array<{
        id: string;
        role: "assistant";
        content: string;
        timestamp: number;
      }>;
      executionEvents: [];
    }>();
    const changesA = deferred<{ changes: [] }>();

    fleetRequest.mockImplementation(
      async (_instanceId: string, method: string, payload: any) => {
        if (method === "chat.history" && payload.threadId === "thread-a")
          return historyA.promise;
        if (method === "threads.changes" && payload.id === "thread-a")
          return changesA.promise;
        if (method === "chat.history" && payload.threadId === "thread-b") {
          return {
            messages: [
              {
                id: "b-msg",
                role: "assistant",
                content: "thread b",
                timestamp: 2,
              },
            ],
            executionEvents: [],
          };
        }
        if (method === "threads.changes" && payload.id === "thread-b")
          return { changes: [] };
        if (method === "chat.model.get")
          return { model: "gpt-5.4", provider: "openai", overridden: false };
        return {};
      },
    );

    const firstSwitch = useFleetChatStore
      .getState()
      .switchThread("nyxlabs", "thread-a");
    await Promise.resolve();
    const secondSwitch = useFleetChatStore
      .getState()
      .switchThread("nyxlabs", "thread-b");
    await secondSwitch;

    historyA.resolve({
      messages: [
        { id: "a-msg", role: "assistant", content: "thread a", timestamp: 1 },
      ],
      executionEvents: [],
    });
    changesA.resolve({ changes: [] });
    await firstSwitch;

    const state = useFleetChatStore.getState().instances.nyxlabs;
    expect(state?.threadId).toBe("thread-b");
    expect(state?.messages.map((message) => message.id)).toEqual(["b-msg"]);
  });

  test("ignores stale model info responses after a newer thread selection", async () => {
    const modelA = deferred<{
      model: string;
      provider: string;
      overridden: boolean;
    }>();

    fleetRequest.mockImplementation(
      async (_instanceId: string, method: string, payload: any) => {
        if (method === "chat.model.get" && payload.threadId === "thread-a")
          return modelA.promise;
        if (method === "chat.model.get" && payload.threadId === "thread-b") {
          return { model: "gpt-5.4-pro", provider: "openai", overridden: true };
        }
        return {};
      },
    );

    setInstanceState("nyxlabs", {
      threadId: "thread-a",
      activeAgent: "nyx",
      modelInfo: null,
      modelLoading: false,
    });

    const firstLoad = useFleetChatStore.getState().loadModelInfo("nyxlabs");
    await Promise.resolve();

    setInstanceState("nyxlabs", {
      threadId: "thread-b",
      activeAgent: "nyx",
    });
    await useFleetChatStore.getState().loadModelInfo("nyxlabs");

    modelA.resolve({ model: "gpt-5.4", provider: "openai", overridden: false });
    await firstLoad;

    const state = useFleetChatStore.getState().instances.nyxlabs;
    expect(state?.threadId).toBe("thread-b");
    expect(state?.modelInfo).toEqual({
      model: "gpt-5.4-pro",
      provider: "openai",
      overridden: true,
    });
    expect(state?.modelLoading).toBe(false);
  });

  test("clears stale model info immediately when switching threads", async () => {
    const history = deferred<{ messages: []; executionEvents: [] }>();

    setInstanceState("nyxlabs", {
      threadId: "thread-a",
      modelInfo: {
        model: "claude-opus-4-6",
        provider: "anthropic",
        overridden: false,
      },
      modelLoading: false,
    });

    fleetRequest.mockImplementation(
      async (_instanceId: string, method: string, payload: any) => {
        if (method === "chat.history" && payload.threadId === "thread-b") {
          return history.promise;
        }
        if (method === "threads.changes" && payload.id === "thread-b") {
          return { changes: [] };
        }
        if (method === "chat.model.get") {
          return { model: "gpt-5.4", provider: "openai", overridden: false };
        }
        return {};
      },
    );

    const switchPromise = useFleetChatStore
      .getState()
      .switchThread("nyxlabs", "thread-b");
    await Promise.resolve();

    expect(useFleetChatStore.getState().instances.nyxlabs?.modelInfo).toBeNull();

    history.resolve({ messages: [], executionEvents: [] });
    await switchPromise;
    await Promise.resolve();

    expect(useFleetChatStore.getState().instances.nyxlabs?.modelInfo).toEqual({
      model: "gpt-5.4",
      provider: "openai",
      overridden: false,
    });
  });

  test("dedupes concurrent history loads for the same instance and thread", async () => {
    const history = deferred<{
      messages: Array<{
        id: string;
        role: "assistant";
        content: string;
        timestamp: number;
      }>;
      executionEvents: [];
    }>();
    const changes = deferred<{ changes: [] }>();

    setInstanceState("nyxlabs", {
      threadId: "thread-a",
      messages: [],
    });

    fleetRequest.mockImplementation(
      async (_instanceId: string, method: string, payload: any) => {
        if (method === "chat.history" && payload.threadId === "thread-a")
          return history.promise;
        if (method === "threads.changes" && payload.id === "thread-a")
          return changes.promise;
        return {};
      },
    );

    const firstLoad = useFleetChatStore
      .getState()
      .loadHistory("nyxlabs", "thread-a");
    const secondLoad = useFleetChatStore
      .getState()
      .loadHistory("nyxlabs", "thread-a");
    await Promise.resolve();

    expect(fleetRequest).toHaveBeenCalledTimes(1);
    expect(fleetRequest).toHaveBeenCalledWith(
      "nyxlabs",
      "chat.history",
      { threadId: "thread-a", limit: 50 },
      undefined,
    );

    history.resolve({
      messages: [
        {
          id: "history-msg",
          role: "assistant",
          content: "hello",
          timestamp: 1,
        },
      ],
      executionEvents: [],
    });
    changes.resolve({ changes: [] });
    await Promise.all([firstLoad, secondLoad]);

    expect(fleetRequest).toHaveBeenCalledTimes(2);
    expect(fleetRequest).toHaveBeenLastCalledWith(
      "nyxlabs",
      "threads.changes",
      { id: "thread-a" },
      undefined,
    );
  });

  test("dedupes concurrent request list loads for the same instance", async () => {
    const requests = deferred<{ requests: [] }>();

    fleetRequest.mockImplementation(
      async (_instanceId: string, method: string) => {
        if (method === "chat.requests.list") return requests.promise;
        return {};
      },
    );

    const firstLoad = useFleetChatStore.getState().loadRequests("nyxlabs");
    const secondLoad = useFleetChatStore.getState().loadRequests("nyxlabs");
    await Promise.resolve();

    expect(fleetRequest).toHaveBeenCalledTimes(1);
    expect(
      useFleetChatStore.getState().instances.nyxlabs?.requestsLoading,
    ).toBe(true);

    requests.resolve({ requests: [] });
    await Promise.all([firstLoad, secondLoad]);

    expect(
      useFleetChatStore.getState().instances.nyxlabs?.requestsLoading,
    ).toBe(false);
  });

  test("dedupes concurrent thread list loads for the same instance", async () => {
    const threads = deferred<{ threads: [] }>();

    fleetRequest.mockImplementation(
      async (_instanceId: string, method: string) => {
        if (method === "threads.list") return threads.promise;
        return {};
      },
    );

    const firstLoad = useFleetChatStore.getState().fetchThreads("nyxlabs");
    const secondLoad = useFleetChatStore.getState().fetchThreads("nyxlabs");
    await Promise.resolve();

    expect(fleetRequest).toHaveBeenCalledTimes(1);
    expect(useFleetChatStore.getState().instances.nyxlabs?.threadsLoading).toBe(
      true,
    );

    threads.resolve({ threads: [] });
    await Promise.all([firstLoad, secondLoad]);

    expect(useFleetChatStore.getState().instances.nyxlabs?.threadsLoading).toBe(
      false,
    );
  });

  test("ignores stale saved-thread search results", async () => {
    const firstSearch = deferred<{ threads: any[] }>();
    const secondSearch = deferred<{ threads: any[] }>();

    fleetRequest.mockImplementation(
      async (_instanceId: string, method: string, payload: any) => {
        if (method === "threads.search" && payload.query === "alpha") {
          return firstSearch.promise;
        }
        if (method === "threads.search" && payload.query === "beta") {
          return secondSearch.promise;
        }
        return {};
      },
    );

    const firstLoad = useFleetChatStore
      .getState()
      .searchThreads("nyxlabs", "alpha");
    await Promise.resolve();
    const secondLoad = useFleetChatStore
      .getState()
      .searchThreads("nyxlabs", "beta");
    await Promise.resolve();

    expect(useFleetChatStore.getState().instances.nyxlabs?.threadsSearching).toBe(
      true,
    );

    secondSearch.resolve({
      threads: [
        {
          id: "thread-beta",
          title: "Beta reconnect work",
          agent: "nyx",
          project: "",
          status: "completed",
          category: null,
          messageCount: 1,
          tokensIn: 0,
          tokensOut: 0,
          costCents: 0,
          createdAt: 1,
          updatedAt: 2,
          snippet: "fresh beta result",
          lastActivity: 2,
        },
      ],
    });
    await secondLoad;

    firstSearch.resolve({
      threads: [
        {
          id: "thread-alpha",
          title: "Alpha stale work",
          agent: "nyx",
          project: "",
          status: "completed",
          category: null,
          messageCount: 1,
          tokensIn: 0,
          tokensOut: 0,
          costCents: 0,
          createdAt: 1,
          updatedAt: 1,
          snippet: "stale alpha result",
          lastActivity: 1,
        },
      ],
    });
    await firstLoad;

    expect(
      useFleetChatStore.getState().instances.nyxlabs?.threadSearchResults,
    ).toEqual([
      expect.objectContaining({
        id: "thread-beta",
        snippet: "fresh beta result",
      }),
    ]);
    expect(useFleetChatStore.getState().instances.nyxlabs?.threadsSearching).toBe(
      false,
    );
  });

  test("dedupes concurrent model info loads for the same thread and agent", async () => {
    const model = deferred<{
      model: string;
      provider: string;
      overridden: boolean;
    }>();

    setInstanceState("nyxlabs", {
      threadId: "thread-a",
      activeAgent: "nyx",
      modelInfo: null,
      modelLoading: false,
    });

    fleetRequest.mockImplementation(
      async (_instanceId: string, method: string, payload: any) => {
        if (
          method === "chat.model.get" &&
          payload.threadId === "thread-a" &&
          payload.agent === "nyx"
        ) {
          return model.promise;
        }
        return {};
      },
    );

    const firstLoad = useFleetChatStore.getState().loadModelInfo("nyxlabs");
    const secondLoad = useFleetChatStore.getState().loadModelInfo("nyxlabs");
    await Promise.resolve();

    expect(fleetRequest).toHaveBeenCalledTimes(1);
    expect(useFleetChatStore.getState().instances.nyxlabs?.modelLoading).toBe(
      true,
    );

    model.resolve({ model: "gpt-5.4", provider: "openai", overridden: false });
    await Promise.all([firstLoad, secondLoad]);

    expect(useFleetChatStore.getState().instances.nyxlabs?.modelInfo).toEqual({
      model: "gpt-5.4",
      provider: "openai",
      overridden: false,
    });
    expect(useFleetChatStore.getState().instances.nyxlabs?.modelLoading).toBe(
      false,
    );
  });

  test("turn lifecycle events keep the cockpit trace live before item events arrive", () => {
    const startedAt = Date.now();
    useFleetChatStore.getState().applyRuntimeEvent("nyxlabs", {
      type: "turn.started",
      threadId: "thread-a",
      turn: 1,
      runId: "chat:thread-a:1",
      agent: "nyx",
      startedAt,
    });

    const state = useFleetChatStore.getState().instances.nyxlabs;
    expect(state?.streaming).toBe(true);
    expect(state?.streamingMessageId).toBeTruthy();
    expect(state?.executionEvents).toHaveLength(1);
    expect(state?.executionEvents[0]).toMatchObject({
      id: "runtime:chat:thread-a:1:lifecycle",
      kind: "status",
      phase: "started",
      title: "Run started",
      messageId: state?.streamingMessageId ?? undefined,
    });
  });

  test("item runtime events attach to the active streaming assistant message", () => {
    const startedAt = Date.now();
    useFleetChatStore.getState().applyRuntimeEvent("nyxlabs", {
      type: "turn.started",
      threadId: "thread-a",
      turn: 1,
      agent: "nyx",
      startedAt,
    });

    useFleetChatStore.getState().applyRuntimeEvent("nyxlabs", {
      type: "item.started",
      threadId: "thread-a",
      turn: 1,
      item: {
        id: "evt-1",
        type: "command",
        status: "started",
        title: "Command run",
        command: "bun test",
        timestamp: startedAt + 50,
      },
    });

    const state = useFleetChatStore.getState().instances.nyxlabs;
    expect(state?.streaming).toBe(true);
    expect(state?.streamingMessageId).toBeTruthy();
    expect(state?.executionEvents).toHaveLength(2);
    expect(state?.executionEvents[1]).toMatchObject({
      id: "evt-1",
      kind: "command",
      phase: "started",
      messageId: state?.streamingMessageId ?? undefined,
    });
    expect(state?.runtime).toMatchObject({
      presence: "active",
      activeThreadId: "thread-a",
      lastStartedAt: startedAt,
    });
  });

  test("tracks run ids and returns an instance to idle on turn completion", () => {
    useFleetChatStore.getState().applyRuntimeEvent("nyxlabs", {
      type: "turn.started",
      threadId: "thread-a",
      turn: 3,
      runId: "chat:thread-a:3",
      agent: "nyx",
      startedAt: 100,
    });

    useFleetChatStore.getState().applyRuntimeEvent("nyxlabs", {
      type: "turn.completed",
      threadId: "thread-a",
      turn: 3,
      runId: "chat:thread-a:3",
      status: "completed",
      finishedAt: 160,
      text: "done",
    });

    const state = useFleetChatStore.getState().instances.nyxlabs;
    expect(state?.runtime).toMatchObject({
      presence: "idle",
      activeRunId: null,
      activeThreadId: null,
      lastStartedAt: 100,
      lastCompletedAt: 160,
      lastEventAt: 160,
    });
  });

  test("turn completion renders the final answer when the stream placeholder is missing", () => {
    setInstanceState("nyxlabs", {
      threadId: "thread-a",
      streaming: true,
      streamingMessageId: null,
      messages: [
        { id: "user-1", role: "user", content: "do the thing", timestamp: 1 },
      ],
    });

    useFleetChatStore.getState().applyRuntimeEvent("nyxlabs", {
      type: "turn.completed",
      threadId: "thread-a",
      turn: 1,
      runId: "chat:thread-a:1",
      status: "completed",
      finishedAt: 200,
      text: "done",
    });

    const state = useFleetChatStore.getState().instances.nyxlabs;
    expect(state?.streaming).toBe(false);
    expect(state?.streamingMessageId).toBeNull();
    expect(state?.messages.map((message) => message.content)).toEqual([
      "do the thing",
      "done",
    ]);
    expect(state?.messages.at(-1)?.role).toBe("assistant");
  });

  test("duplicate completion events do not duplicate a finalized cockpit answer", () => {
    useFleetChatStore.getState().applyRuntimeEvent("nyxlabs", {
      type: "turn.started",
      threadId: "thread-a",
      turn: 1,
      runId: "chat:thread-a:1",
      agent: "nyx",
      startedAt: 100,
    });

    for (const finishedAt of [200, 210]) {
      useFleetChatStore.getState().applyRuntimeEvent("nyxlabs", {
        type: "turn.completed",
        threadId: "thread-a",
        turn: 1,
        runId: "chat:thread-a:1",
        status: "completed",
        finishedAt,
        text: "same answer",
      });
    }

    const state = useFleetChatStore.getState().instances.nyxlabs;
    expect(state?.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    expect(state?.messages.at(-1)?.content).toBe("same answer");
  });

  test("turn completion repairs a partial assistant answer after a history refresh", () => {
    setInstanceState("nyxlabs", {
      threadId: "thread-a",
      streaming: false,
      streamingMessageId: null,
      messages: [
        { id: "user-1", role: "user", content: "summarize", timestamp: 1 },
        { id: "partial", role: "assistant", content: "partial", timestamp: 2 },
      ],
    });

    useFleetChatStore.getState().applyRuntimeEvent("nyxlabs", {
      type: "turn.completed",
      threadId: "thread-a",
      turn: 1,
      runId: "chat:thread-a:1",
      status: "completed",
      finishedAt: 300,
      text: "partial and complete",
    });

    const state = useFleetChatStore.getState().instances.nyxlabs;
    expect(state?.messages.map((message) => message.id)).toEqual(["user-1", "partial"]);
    expect(state?.messages.at(-1)?.content).toBe("partial and complete");
    expect(state?.messages.at(-1)?.streaming).toBe(false);
  });

  test("updates runtime presence for non-selected threads without repainting their history", () => {
    setInstanceState("nyxlabs", {
      threadId: "thread-b",
      messages: [
        { id: "b-msg", role: "assistant", content: "thread b", timestamp: 1 },
      ],
    });

    useFleetChatStore.getState().applyRuntimeEvent("nyxlabs", {
      type: "turn.started",
      threadId: "thread-a",
      turn: 1,
      runId: "chat:thread-a:1",
      agent: "nyx",
      startedAt: 100,
    });

    const state = useFleetChatStore.getState().instances.nyxlabs;
    expect(state?.threadId).toBe("thread-b");
    expect(state?.messages.map((message) => message.id)).toEqual(["b-msg"]);
    expect(state?.runtime).toMatchObject({
      presence: "active",
      activeRunId: "chat:thread-a:1",
      activeThreadId: "thread-a",
    });
  });

  test("diff updates open the diff rail and keep the newest selected path in sync", () => {
    useFleetChatStore.getState().applyRuntimeEvent("nyxlabs", {
      type: "diff.updated",
      threadId: "thread-a",
      changes: [
        {
          id: "chg-1",
          threadId: "thread-a",
          filePath: "/repo/src/alpha.ts",
          operation: "edit",
          linesAdded: 5,
          linesRemoved: 1,
          timestamp: 10,
        },
        {
          id: "chg-2",
          threadId: "thread-a",
          filePath: "/repo/src/beta.ts",
          operation: "create",
          linesAdded: 12,
          linesRemoved: 0,
          timestamp: 11,
        },
      ],
    });

    const state = useFleetChatStore.getState().instances.nyxlabs;
    expect(state?.diffOpen).toBe(true);
    expect(state?.threadChanges).toHaveLength(2);
    expect(state?.selectedChangePath).toBe("/repo/src/alpha.ts");
  });

  test("prunes stale empty assistant placeholders before starting a refreshed run", () => {
    setInstanceState("nyxlabs", {
      threadId: "thread-a",
      streaming: false,
      streamingMessageId: null,
      messages: [
        { id: "old-empty-1", role: "assistant", content: "", timestamp: 1 },
        { id: "history", role: "assistant", content: "real answer", timestamp: 2 },
        { id: "old-empty-2", role: "assistant", content: "", timestamp: 3 },
      ],
    });

    useFleetChatStore.getState().applyRuntimeEvent("nyxlabs", {
      type: "turn.started",
      threadId: "thread-a",
      turn: 2,
      runId: "chat:thread-a:2",
      agent: "nyx",
      startedAt: 4,
    });

    const state = useFleetChatStore.getState().instances.nyxlabs;
    expect(state?.messages.map((message) => message.id)).toEqual([
      "history",
      state?.streamingMessageId,
    ]);
    expect(state?.messages.filter((message) => message.content === "")).toHaveLength(1);
  });

  test("history refresh does not append blank local-only assistant placeholders", async () => {
    setInstanceState("nyxlabs", {
      threadId: "thread-a",
      streaming: true,
      streamingMessageId: "local-empty",
      messages: [
        { id: "local-empty", role: "assistant", content: "", timestamp: 1, streaming: true },
      ],
    });

    fleetRequest.mockImplementation(
      async (_instanceId: string, method: string, payload: any) => {
        if (method === "chat.history" && payload.threadId === "thread-a") {
          return {
            messages: [
              {
                id: "server-msg",
                role: "assistant",
                content: "server history",
                timestamp: 2,
              },
            ],
            executionEvents: [],
          };
        }
        if (method === "threads.changes" && payload.id === "thread-a")
          return { changes: [] };
        return {};
      },
    );

    await useFleetChatStore.getState().loadHistory("nyxlabs", "thread-a");

    const state = useFleetChatStore.getState().instances.nyxlabs;
    expect(state?.messages.map((message) => message.id)).toEqual(["server-msg"]);
  });
});

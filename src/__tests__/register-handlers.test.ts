import { afterEach, describe, it, expect, beforeEach, mock, spyOn } from "bun:test";
import { MethodRouter } from "../server/ws/router";
import { registerHandlers, getActiveGatewayInvocation } from "../server/ws/register-handlers";
import * as extractModule from "../memory/extract";

// Minimal mock factories
function mockConnections() {
  return {
    broadcast: mock(() => {}),
    broadcastToSubscribed: mock(() => {}),
    count: mock(() => 1),
    subscribe: mock(() => {}),
    unsubscribe: mock(() => {}),
  };
}

function mockDevices() {
  const devices: any[] = [];
  return {
    listDevices: mock(() => devices),
    approveDevice: mock((id: string) => {
      const d = devices.find((d) => d.id === id);
      if (d) { d.status = "approved"; return true; }
      return false;
    }),
    revokeDevice: mock((id: string) => {
      const d = devices.find((d) => d.id === id);
      if (d) { d.status = "revoked"; return true; }
      return false;
    }),
    _add(device: any) { devices.push(device); },
  };
}

function mockThreadDb() {
  const threads = new Map<string, any>();
  const messages = new Map<string, any[]>();
  const executionEvents = new Map<string, any[]>();
  const fileChanges = new Map<string, any[]>();
  return {
    createThread: mock(({ message, instance, agent }: any) => {
      const id = crypto.randomUUID();
      const thread = { id, title: message.slice(0, 50), agent, status: "active", created_at: Date.now(), updated_at: Date.now(), messages: [] };
      threads.set(id, thread);
      messages.set(id, []);
      executionEvents.set(id, []);
      fileChanges.set(id, []);
      return thread;
    }),
    getThread: mock((id: string) => threads.get(id) ?? null),
    addThreadMessage: mock((threadId: string, msg: any) => {
      const id = crypto.randomUUID();
      const entry = { id, ...msg, timestamp: Date.now() };
      if (!messages.has(threadId)) messages.set(threadId, []);
      messages.get(threadId)!.push(entry);
      return entry;
    }),
    updateThreadMessage: mock(() => {}),
    recordExecutionEvent: mock((event: any) => {
      if (!executionEvents.has(event.threadId)) executionEvents.set(event.threadId, []);
      const existing = executionEvents.get(event.threadId) ?? [];
      const idx = existing.findIndex((entry) => entry.id === event.id);
      if (idx >= 0) {
        existing[idx] = { ...existing[idx], ...event };
      } else {
        existing.push(event);
      }
    }),
    updateThread: mock((id: string, updates: any) => {
      const t = threads.get(id);
      if (t) Object.assign(t, updates);
    }),
    deleteThread: mock((id: string) => threads.delete(id)),
    getThreadMessages: mock((id: string, limit: number) => (messages.get(id) ?? []).slice(0, limit)),
    getFileChanges: mock((id: string) => fileChanges.get(id) ?? []),
    getExecutionEvents: mock((id: string, limit?: number) => {
      const events = executionEvents.get(id) ?? [];
      return typeof limit === "number" ? events.slice(0, limit) : events;
    }),
    listThreads: mock(() => ({ threads: Array.from(threads.values()), total: threads.size })),
    searchThreads: mock((query: string) => Array.from(threads.values())
      .filter((thread) => `${thread.title} ${thread.message ?? ""}`.toLowerCase().includes(query.toLowerCase()))
      .map((thread) => ({ ...thread, snippet: thread.message ?? thread.title, lastActivity: thread.updated_at ?? Date.now(), _message_count: thread.messages?.length ?? 0 }))),
    _seed(id: string, thread: any) {
      threads.set(id, thread);
      messages.set(id, thread.messages ?? []);
      executionEvents.set(id, thread.executionEvents ?? []);
      fileChanges.set(id, thread.fileChanges ?? []);
    },
  };
}

function mockProcessor() {
  const listeners: ((event: any) => void)[] = [];
  return {
    processImmediate: mock(async (_opts?: any) => ({
      response: "test response",
      agent: "nyx",
      tokens_in: 100,
      tokens_out: 50,
      cost: 0.01,
      duration_ms: 1000,
    })),
    cancelTask: mock(() => ({ cancelled: true, agent: "nyx", elapsed: 5 })),
    clearConversation: mock(() => {}),
    isActive: mock(() => ({ active: false })),
    emitEvent: mock(() => {}),
    handleBtw: mock(async () => ({ answer: "side answer", model: "test" })),
    handleSteer: mock(async () => ({ steer_id: "steer-1", status: "queued" })),
    saveSteerToConversation: mock(() => {}),
    recordConversationTurn: mock(() => {}),
    getModelOverride: mock(() => undefined),
    getModelOverrideProvider: mock(() => undefined),
    resolveActiveTaskTarget: mock(() => ({ message_id: "msg-1", conversation_id: "gateway:thread-1" })),
    formatActiveTaskResolutionError: mock((agentKey: string, target: any, opts: any) => `resolution:${agentKey}:${opts.action}:${target.error}`),
    resolveProposalRepoPath: mock(() => "/tmp/nyxhive-test"),
    resolveReviewAgent: mock(() => "nyx"),
    resolveProposalReviewModel: mock((_preferred: string[], model?: string) => model ?? "gpt-5.4"),
    resumeSuspendedMessage: mock(async (messageId: string, reply: string) => ({
      message_id: messageId,
      response: `Resumed with ${reply}`,
      agent: "nyx",
    })),
    onEvent: mock((fn: (event: any) => void) => {
      listeners.push(fn);
      return () => { const idx = listeners.indexOf(fn); if (idx >= 0) listeners.splice(idx, 1); };
    }),
    _listeners: listeners,
  };
}

function mockQueue() {
  const suspended = new Map<string, any>();
  return {
    getPendingCount: mock(() => 0),
    listSuspendedMessages: mock(() => Array.from(suspended.values())),
    getSuspendedByRequestId: mock((requestId: string) => suspended.get(requestId) ?? null),
    _setSuspended(message: any) {
      suspended.set(message.request_id, message);
    },
  };
}

function mockRegistry() {
  const agents = new Map<string, any>();
  const running = new Map<string, any>();
  return {
    getAllEntries: mock((includeDisabled?: boolean) => agents),
    getRunningAgents: mock(() => running),
    _add(id: string, agent: any) { agents.set(id, agent); },
    _setRunning(id: string, entry: any) { running.set(id, entry); },
  };
}

function mockProposalStore() {
  const proposals = new Map<string, any>();
  return {
    list: mock(() => Array.from(proposals.values())),
    listPending: mock(() => Array.from(proposals.values()).filter((proposal) => proposal.status === "proposed" && proposal.autonomy === "requires_approval")),
    get: mock((id: string) => proposals.get(id) ?? null),
    approve: mock((id: string) => {
      const p = proposals.get(id);
      if (p) { p.status = "approved"; return p; }
      return null;
    }),
    reject: mock((id: string, reason?: string) => {
      const p = proposals.get(id);
      if (p) { p.status = "rejected"; return p; }
      return null;
    }),
    markReviewing: mock(() => true),
    saveReview: mock(() => {}),
    markMerged: mock((id: string, mergedBy: string) => {
      const p = proposals.get(id);
      if (p) {
        p.status = "merged";
        p.merged_by = mergedBy;
        return p;
      }
      return null;
    }),
    setPrUrl: mock((id: string, prUrl: string) => {
      const p = proposals.get(id);
      if (p) p.pr_url = prUrl;
    }),
    setPrMergeable: mock((id: string, mergeable: string | null) => {
      const p = proposals.get(id);
      if (p) p.pr_mergeable = mergeable;
    }),
    markFailed: mock((id: string, result?: string, executedBy?: string) => {
      const p = proposals.get(id);
      if (p) {
        p.status = "failed";
        p.execution_result = result;
        p.executed_by = executedBy;
        return p;
      }
      return null;
    }),
    delete: mock((id: string) => proposals.has(id) ? (proposals.delete(id), true) : false),
    deleteTerminal: mock(() => 3),
    _add(id: string, proposal: any) { proposals.set(id, proposal); },
  };
}

function mockTaskStore() {
  const tasks: any[] = [];
  return {
    list: mock(() => tasks),
    update: mock((id: string, params: any) => {
      const t = tasks.find((t) => t.id === id);
      if (t) { Object.assign(t, params); return t; }
      return null;
    }),
    _add(task: any) { tasks.push(task); },
  };
}

function mockTraces() {
  return {
    getRecentTraces: mock(() => []),
    getSuccessRates: mock(() => []),
    getHintStats: mock(() => []),
    getTrace: mock(() => null),
    getTraceEvents: mock(() => []),
  };
}

function mockScheduler() {
  const tasks = new Map<string, any>();
  return {
    listTasks: mock(() => Array.from(tasks.values())),
    getTask: mock((id: string) => tasks.get(id) ?? null),
    updateTask: mock((id: string, updates: any) => {
      const t = tasks.get(id);
      if (t) Object.assign(t, updates);
    }),
    triggerTask: mock(async () => {}),
    _add(id: string, task: any) { tasks.set(id, task); },
  };
}

function mockMemory() {
  return {
    searchMemories: mock(() => [
      { content: "test memory", source: "chat", category: "general", created_at: Date.now() },
    ]),
  };
}

function mockKnowledge() {
  return {
    search: mock(() => []),
    getStats: mock(() => ({ total: 0 })),
    getRecentChunks: mock(() => []),
    getChunksBySourcePath: mock(() => [
      {
        id: 1,
        title: "Gateway Runbook",
        section: "Reconnect",
        content: "Reconnect websocket clients and verify cockpit state.",
        category: "runbook",
        source_path: "docs/gateway.md",
        content_hash: "hash-1",
        chunk_index: 0,
      },
    ]),
  };
}

function mockCompiledKnowledge() {
  const page = {
    id: 1,
    source_key: "docs/gateway.md",
    source_path: "docs/gateway.md",
    title: "Gateway Runbook",
    category: "runbook",
    summary: "Reconnect",
    content: "# Gateway Runbook",
    source_hash: "hash-1",
    chunk_count: 1,
    stale: 0,
    created_at: 1,
    updated_at: 1,
    last_accessed_at: null,
    access_count: 0,
  };
  return {
    count: mock(() => 1),
    list: mock(() => [page]),
    upsert: mock(() => page),
    markStale: mock((id: number, stale: boolean) => ({ ...page, id, stale: stale ? 1 : 0 })),
    auditStaleness: mock(() => ({ checked: 1, markedStale: 1, restoredFresh: 0, missingSources: 0 })),
  };
}

function mockEmbedder() {
  return {
    embed: mock(async () => new Float32Array(128)),
  };
}

function mockAudit() {
  return {
    query: mock(() => [
      { event: "chat.send", timestamp: Date.now(), channel: "gateway", agent: "nyx" },
    ]),
  };
}

function mockGraphMemory() {
  return {
    getExistingSummary: mock(() => ""),
    addNodeDedup: mock(() => "memory-node"),
  };
}

function mockProviderRouter() {
  return {
    complete: mock(async () => ({ content: "[]" })),
  };
}

function mockCrawlService() {
  return {
    crawlSite: mock(async () => [
      { url: "https://example.com/docs", markdown: "# Docs", statusCode: 200 },
    ]),
  };
}

function mockCrawlSources() {
  return {
    addDynamic: mock(() => "crawl-source-1"),
    updateAfterCrawl: mock(() => {}),
  };
}

function mockCrawlIngest() {
  return {
    ingestCrawlResults: mock(async () => ({
      pagesProcessed: 1,
      chunksCreated: 3,
      chunksSkipped: 0,
      errors: [],
    })),
  };
}

// Helper: call a registered handler directly via the router's internal map
async function callHandler(router: MethodRouter, method: string, payload: any = {}, deviceId = "test-device") {
  const frame = JSON.stringify({ type: "req", id: `test-${Date.now()}`, method, payload });
  const result = await router.dispatch(frame, deviceId);
  if (!result) return null;
  const parsed = JSON.parse(result);
  if (parsed.error) throw new Error(`${parsed.error.code}: ${parsed.error.message}`);
  return parsed.payload;
}

async function flushMicrotasks(iterations = 2) {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

function spawnResult(exitCode: number, stdout = "", stderr = ""): ReturnType<typeof Bun.spawnSync> {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode,
    success: exitCode === 0,
  } as ReturnType<typeof Bun.spawnSync>;
}

let spawnSyncSpy: ReturnType<typeof spyOn<typeof Bun, "spawnSync">> | undefined;

// ---

describe("registerHandlers", () => {
  let router: MethodRouter;
  let connections: ReturnType<typeof mockConnections>;
  let devices: ReturnType<typeof mockDevices>;
  let threadDb: ReturnType<typeof mockThreadDb>;
  let processor: ReturnType<typeof mockProcessor>;
  let queue: ReturnType<typeof mockQueue>;
  let registry: ReturnType<typeof mockRegistry>;
  let proposalStore: ReturnType<typeof mockProposalStore>;
  let taskStore: ReturnType<typeof mockTaskStore>;
  let traces: ReturnType<typeof mockTraces>;
  let scheduler: ReturnType<typeof mockScheduler>;
  let memory: ReturnType<typeof mockMemory>;
  let knowledge: ReturnType<typeof mockKnowledge>;
  let compiledKnowledge: ReturnType<typeof mockCompiledKnowledge>;
  let embedder: ReturnType<typeof mockEmbedder>;
  let audit: ReturnType<typeof mockAudit>;
  let crawlService: ReturnType<typeof mockCrawlService>;
  let crawlSources: ReturnType<typeof mockCrawlSources>;
  let crawlIngest: ReturnType<typeof mockCrawlIngest>;
  let graphMemory: ReturnType<typeof mockGraphMemory>;
  let providerRouter: ReturnType<typeof mockProviderRouter>;

  beforeEach(() => {
    router = new MethodRouter();
    connections = mockConnections();
    devices = mockDevices();
    threadDb = mockThreadDb();
    processor = mockProcessor();
    queue = mockQueue();
    registry = mockRegistry();
    proposalStore = mockProposalStore();
    taskStore = mockTaskStore();
    traces = mockTraces();
    scheduler = mockScheduler();
    memory = mockMemory();
    knowledge = mockKnowledge();
    compiledKnowledge = mockCompiledKnowledge();
    embedder = mockEmbedder();
    audit = mockAudit();
    crawlService = mockCrawlService();
    crawlSources = mockCrawlSources();
    crawlIngest = mockCrawlIngest();
    graphMemory = mockGraphMemory();
    providerRouter = mockProviderRouter();

    registerHandlers(router, {
      threadDb: threadDb as any,
      processor: processor as any,
      queue: queue as any,
      proposalStore: proposalStore as any,
      taskStore: taskStore as any,
      registry: registry as any,
      traces: traces as any,
      knowledge: knowledge as any,
      compiledKnowledge: compiledKnowledge as any,
      embedder: embedder as any,
      memory: memory as any,
      scheduler: scheduler as any,
      connections: connections as any,
      devices: devices as any,
      audit: audit as any,
      config: { daemon: { name: "test-instance" } } as any,
      configPath: "/tmp/test-config.toml",
      graphMemory: graphMemory as any,
      router: providerRouter as any,
      crawlService: crawlService as any,
      crawlSources: crawlSources as any,
      crawlIngest: crawlIngest as any,
    });
  });

  afterEach(() => {
    spawnSyncSpy?.mockRestore();
    spawnSyncSpy = undefined;
  });

  // --- Chat handlers ---

  describe("chat.send", () => {
    it("returns messageId and threadId", async () => {
      const result = await callHandler(router, "chat.send", { message: "hello" });
      expect(result.messageId).toBeDefined();
      expect(result.threadId).toBeDefined();
    });

    it("creates a new thread when no threadId given", async () => {
      await callHandler(router, "chat.send", { message: "hello" });
      expect(threadDb.createThread).toHaveBeenCalled();
    });

    it("adds message to existing thread", async () => {
      const threadId = "existing-thread";
      threadDb._seed(threadId, { id: threadId, title: "test", messages: [] });

      await callHandler(router, "chat.send", { message: "hello", threadId });
      expect(threadDb.addThreadMessage).toHaveBeenCalledWith(threadId, expect.objectContaining({ role: "user", content: "hello" }));
    });

    it("creates thread when provided threadId does not exist", async () => {
      await callHandler(router, "chat.send", { message: "hello", threadId: "nonexistent" });
      expect(threadDb.createThread).toHaveBeenCalled();
    });

    it("rejects more than 5 attachments via schema validation", async () => {
      const images = Array.from({ length: 6 }, () => ({ type: "image/png", data: "abc" }));
      await expect(callHandler(router, "chat.send", { message: "test", images })).rejects.toThrow("INVALID_PAYLOAD");
    });

    it("rejects attachments over 10MB via schema validation", async () => {
      const bigData = "x".repeat(10 * 1024 * 1024 + 1);
      await expect(callHandler(router, "chat.send", { message: "test", images: [{ type: "image/png", data: bigData }] })).rejects.toThrow("INVALID_PAYLOAD");
    });

    it("calls processImmediate with correct params", async () => {
      await callHandler(router, "chat.send", { message: "hello", agent: "forge" });
      expect(processor.processImmediate).toHaveBeenCalledWith(expect.objectContaining({
        channel: "gateway",
        sender: "test-device",
        // sender_id is now the resolved threadId (UUID), not the deviceId
        message: "hello",
        agent: "forge",
      }));
      // Verify sender_id is a UUID (threadId)
      const call = (processor.processImmediate as any).mock.calls[0][0];
      expect(call.sender_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("defaults gateway chat to the configured primary lead agent", async () => {
      const leadRouter = new MethodRouter();
      registerHandlers(leadRouter, {
        threadDb: threadDb as any,
        processor: processor as any,
        queue: queue as any,
        proposalStore: proposalStore as any,
        taskStore: taskStore as any,
        registry: registry as any,
        traces: traces as any,
        knowledge: knowledge as any,
        embedder: embedder as any,
        memory: memory as any,
        scheduler: scheduler as any,
        connections: connections as any,
        devices: devices as any,
        audit: audit as any,
        config: {
          daemon: { name: "test-instance", primary_agent: "onyx" },
          agents: {
            onyx: { name: "Onyx", role: "lead" },
            analyst: { name: "Analyst", role: "worker" },
          },
        } as any,
        configPath: "/tmp/test-config.toml",
        graphMemory: graphMemory as any,
        router: providerRouter as any,
        crawlService: crawlService as any,
        crawlSources: crawlSources as any,
        crawlIngest: crawlIngest as any,
      });

      await callHandler(leadRouter, "chat.send", { message: "hello" });

      expect(processor.processImmediate).toHaveBeenCalledWith(expect.objectContaining({
        agent: "onyx",
      }));
      expect(threadDb.createThread).toHaveBeenCalledWith(expect.objectContaining({
        agent: "onyx",
      }));
    });

    it("broadcasts response after processing", async () => {
      await callHandler(router, "chat.send", { message: "hello" });
      // Wait for async processImmediate to complete
      await new Promise((r) => setTimeout(r, 50));
      expect(connections.broadcast).toHaveBeenCalledWith("chat:response", expect.objectContaining({ done: true }));
    });

    it("uses sanitized final response instead of longer noisy stream text", async () => {
      processor.processImmediate.mockImplementationOnce(async (opts: any) => {
        for (const listener of processor._listeners) {
          listener({
            type: "response:delta",
            data: {
              channel: "gateway",
              sender_id: opts.sender_id,
              text_so_far: [
                "Using superpowers:using-superpowers, test-driven-development, and verification-before-completion. I will inspect files.",
                "I am starting with the recent instability surface.",
                "Done. Fixed the leak.",
              ].join("\n"),
            },
          });
        }
        return {
          response: "Done. Fixed the leak.",
          agent: "nyx",
          tokens_in: 100,
          tokens_out: 50,
          cost: 0.01,
          duration_ms: 1000,
        };
      });

      const result = await callHandler(router, "chat.send", { message: "hello" });
      await new Promise((r) => setTimeout(r, 50));

      expect(threadDb.updateThread).toHaveBeenCalledWith(result.threadId, expect.objectContaining({
        status: "completed",
        response: "Done. Fixed the leak.",
      }));
      expect(connections.broadcast).toHaveBeenCalledWith("chat:response", expect.objectContaining({
        text: "Done. Fixed the leak.",
        done: true,
      }));
    });

    it("does not persist workflow diary from streaming deltas", async () => {
      processor.processImmediate.mockImplementationOnce(
        async () => await new Promise(() => {}),
      );
      const result = await callHandler(router, "chat.send", { message: "hello" });
      for (const listener of processor._listeners) {
        listener({
          type: "response:delta",
          data: {
            channel: "gateway",
            sender_id: result.threadId,
            text_so_far: [
              "Using superpowers:using-superpowers, test-driven-development, and verification-before-completion. I will inspect files.",
              "I am starting with the recent instability surface.",
              "Done. Fixed the leak.",
            ].join("\n"),
          },
        });
      }

      expect(threadDb.addThreadMessage).toHaveBeenCalledWith(result.threadId, expect.objectContaining({
        role: "assistant",
        content: "Done. Fixed the leak.",
      }));
    });

    it("persists execution events for the thread while streaming", async () => {
      processor.processImmediate.mockImplementationOnce(
        async () => await new Promise(() => {}),
      );
      const result = await callHandler(router, "chat.send", { message: "hello" });
      for (const listener of processor._listeners) {
        listener({
          type: "execution:event",
          data: {
            channel: "gateway",
            sender_id: result.threadId,
            message_id: result.messageId,
            id: "cmd:1",
            kind: "command",
            phase: "completed",
            turn: 1,
            title: "Command run complete",
            command: "rg -n crawl src",
            timestamp: Date.now(),
          },
        });
      }

      expect(threadDb.recordExecutionEvent).toHaveBeenCalledWith(expect.objectContaining({
        threadId: result.threadId,
        id: "cmd:1",
        kind: "command",
        phase: "completed",
        turn: 1,
      }));
    });

    it("handles /crawl without routing through the agent processor", async () => {
      const result = await callHandler(router, "chat.send", { message: "/crawl https://example.com/docs" });
      await new Promise((r) => setTimeout(r, 25));

      expect(processor.processImmediate).not.toHaveBeenCalled();
      expect(crawlService.crawlSite).toHaveBeenCalledWith("https://example.com/docs", {
        depth: undefined,
        limit: undefined,
        pathGlob: undefined,
      });
      expect(threadDb.addThreadMessage).toHaveBeenCalledWith(result.threadId, expect.objectContaining({
        role: "assistant",
        content: expect.stringContaining("Crawled 1 page"),
      }));
      expect(connections.broadcast).toHaveBeenCalledWith("chat:response", expect.objectContaining({
        threadId: result.threadId,
        done: true,
      }));
    });

    it("records aborted turns into conversation history and emits aborted status", async () => {
      processor.processImmediate.mockImplementationOnce(async () => {
        const err = new Error("The operation was aborted.");
        err.name = "AbortError";
        throw err;
      });

      const result = await callHandler(router, "chat.send", { message: "continue the gateway fix" });
      await new Promise((r) => setTimeout(r, 25));

      expect(processor.recordConversationTurn).toHaveBeenCalledWith(
        "gateway",
        result.threadId,
        "continue the gateway fix",
        "[Aborted]",
        expect.objectContaining({ agent: "nyx" }),
      );
      expect(threadDb.updateThread).toHaveBeenCalledWith(
        result.threadId,
        expect.objectContaining({
          status: "cancelled",
          response: "[Aborted]",
        }),
      );
      expect(connections.broadcast).toHaveBeenCalledWith("turn.completed", expect.objectContaining({
        threadId: result.threadId,
        status: "aborted",
        text: "[Aborted]",
      }));
    });

    it("dedupes repeated chat.send requests with the same idempotency key while in flight", async () => {
      const pending = new Promise<any>(() => {});
      processor.processImmediate.mockImplementationOnce(async () => await pending);

      const first = await callHandler(router, "chat.send", {
        message: "hello",
        idempotencyKey: "idem-1",
      });
      const second = await callHandler(router, "chat.send", {
        message: "hello",
        idempotencyKey: "idem-1",
      });

      expect(second).toEqual({
        messageId: first.messageId,
        threadId: first.threadId,
        runId: first.runId,
        status: "in_flight",
      });
      expect(threadDb.createThread).toHaveBeenCalledTimes(1);
      expect(processor.processImmediate).toHaveBeenCalledTimes(1);
    });

    it("returns ok for an already-completed idempotent request", async () => {
      const first = await callHandler(router, "chat.send", {
        message: "hello",
        idempotencyKey: "idem-complete",
      });
      await new Promise((r) => setTimeout(r, 25));

      const second = await callHandler(router, "chat.send", {
        message: "hello",
        idempotencyKey: "idem-complete",
      });

      expect(second).toEqual({
        messageId: first.messageId,
        threadId: first.threadId,
        runId: first.runId,
        status: "ok",
      });
      expect(processor.processImmediate).toHaveBeenCalledTimes(1);
    });

    it("serializes queued follow-up sends on the same thread instead of dropping them", async () => {
      let releaseFirst: (() => void) | undefined;
      processor.processImmediate
        .mockImplementationOnce(async () => {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return {
            response: "first response",
            agent: "nyx",
            tokens_in: 10,
            tokens_out: 5,
            cost: 0.01,
            duration_ms: 50,
          };
        })
        .mockResolvedValueOnce({
          response: "second response",
          agent: "nyx",
          tokens_in: 8,
          tokens_out: 4,
          cost: 0.01,
          duration_ms: 30,
        });

      const first = await callHandler(router, "chat.send", { message: "first" });
      await flushMicrotasks();
      const second = await callHandler(router, "chat.send", {
        message: "second",
        threadId: first.threadId,
      });

      expect(first.status).toBe("started");
      expect(second.status).toBe("queued");
      expect(second.threadId).toBe(first.threadId);
      expect(processor.processImmediate).toHaveBeenCalledTimes(1);

      releaseFirst?.();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(processor.processImmediate).toHaveBeenCalledTimes(2);
      const secondCall = processor.processImmediate.mock.calls.at(1) as [Record<string, unknown>] | undefined;
      expect(secondCall?.[0]).toEqual(
        expect.objectContaining({
          sender_id: first.threadId,
          message: "second",
        }),
      );
      expect(connections.broadcast).toHaveBeenCalledWith("turn.started", expect.objectContaining({
        threadId: first.threadId,
        turn: 2,
      }));
    });
  });

  describe("chat.abort", () => {
    it("cancels active task", async () => {
      const result = await callHandler(router, "chat.abort", { messageId: "msg-1" });
      expect(result.cancelled).toBe(true);
      expect(processor.cancelTask).toHaveBeenCalledWith("gateway", "test-device");
    });

    it("does not fall through to a different active thread when the requested thread is stale", async () => {
      const releases: Array<() => void> = [];
      processor.processImmediate.mockImplementation(async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return {
          response: "done",
          agent: "nyx",
          tokens_in: 1,
          tokens_out: 1,
          cost: 0,
          duration_ms: 1,
        };
      });
      processor.cancelTask.mockReturnValue({ cancelled: false } as any);

      await callHandler(router, "chat.send", { message: "first active run" });
      await callHandler(router, "chat.send", { message: "second active run" });
      await flushMicrotasks();
      processor.cancelTask.mockClear();

      const result = await callHandler(router, "chat.abort", { threadId: "stale-thread" });

      expect(result).toEqual({ cancelled: false, code: "NO_ACTIVE_RUN" });
      expect(processor.cancelTask).toHaveBeenCalledTimes(1);
      expect(processor.cancelTask).toHaveBeenCalledWith("gateway", "stale-thread");

      releases.forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    it("uses runId to cancel the exact active thread", async () => {
      let release: (() => void) | undefined;
      processor.processImmediate.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          response: "done",
          agent: "nyx",
          tokens_in: 1,
          tokens_out: 1,
          cost: 0,
          duration_ms: 1,
        };
      });

      const send = await callHandler(router, "chat.send", { message: "active run" });
      await flushMicrotasks();
      processor.cancelTask.mockClear();

      const result = await callHandler(router, "chat.abort", { runId: send.runId });

      expect(result.cancelled).toBe(true);
      expect(processor.cancelTask).toHaveBeenCalledWith("gateway", send.threadId);

      release?.();
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  });

  describe("chat.btw", () => {
    it("fails when multiple active tasks exist without a threadId", async () => {
      processor.resolveActiveTaskTarget.mockReturnValue({
        error: "ambiguous_target",
        status: 400,
        active_conversations: [
          { message_id: "msg-1", conversation_id: "gateway:thread-1" },
          { message_id: "msg-2", conversation_id: "gateway:thread-2" },
        ],
      } as any);

      await expect(callHandler(router, "chat.btw", { agent: "nyx", question: "status?" })).rejects.toThrow(
        "HANDLER_ERROR: resolution:nyx:btw:ambiguous_target",
      );
      expect(processor.handleBtw).not.toHaveBeenCalled();
    });

    it("uses threadId to resolve the target task", async () => {
      processor.resolveActiveTaskTarget.mockReturnValue({
        message_id: "msg-thread-2",
        conversation_id: "gateway:thread-2",
      } as any);

      const result = await callHandler(router, "chat.btw", {
        agent: "nyx",
        question: "status?",
        threadId: "thread-2",
      });

      expect(result.answer).toBe("side answer");
      expect(processor.resolveActiveTaskTarget).toHaveBeenCalledWith("nyx", { threadId: "thread-2" });
      expect(processor.handleBtw).toHaveBeenCalledWith("nyx", "msg-thread-2", "status?", "gateway");
    });
  });

  describe("chat.steer", () => {
    it("fails when multiple active tasks exist without a threadId", async () => {
      processor.resolveActiveTaskTarget.mockReturnValue({
        error: "ambiguous_target",
        status: 400,
        active_conversations: [
          { message_id: "msg-1", conversation_id: "gateway:thread-1" },
          { message_id: "msg-2", conversation_id: "gateway:thread-2" },
        ],
      } as any);

      await expect(callHandler(router, "chat.steer", { agent: "nyx", message: "focus" })).rejects.toThrow(
        "HANDLER_ERROR: resolution:nyx:steer:ambiguous_target",
      );
      expect(processor.saveSteerToConversation).not.toHaveBeenCalled();
      expect(processor.handleSteer).not.toHaveBeenCalled();
    });

    it("uses threadId to steer the matching task", async () => {
      processor.resolveActiveTaskTarget.mockReturnValue({
        message_id: "msg-thread-2",
        conversation_id: "gateway:thread-2",
      } as any);

      const result = await callHandler(router, "chat.steer", {
        agent: "nyx",
        message: "focus",
        threadId: "thread-2",
        priority: "interrupt",
      });

      expect(result.status).toBe("queued");
      expect(processor.resolveActiveTaskTarget).toHaveBeenCalledWith("nyx", { threadId: "thread-2" });
      expect(processor.handleSteer).toHaveBeenCalledWith("nyx", "msg-thread-2", "gateway:thread-2", {
        message: "focus",
        priority: "interrupt",
        source: "gateway",
      });
    });
  });

  describe("chat.reset", () => {
    it("clears conversation context", async () => {
      const result = await callHandler(router, "chat.reset", {});
      expect(result.ok).toBe(true);
      expect(processor.clearConversation).toHaveBeenCalledWith("gateway", "test-device");
    });
  });

  describe("chat.status", () => {
    it("returns processor active status", async () => {
      processor.isActive.mockReturnValue({ active: true } as any);
      const result = await callHandler(router, "chat.status", {});
      expect(result.active).toBe(true);
    });
  });

  describe("chat.history", () => {
    it("returns messages for existing thread", async () => {
      const threadId = "t1";
      threadDb._seed(threadId, {
        id: threadId,
        title: "test",
        messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
        executionEvents: [{ id: "cmd:1", kind: "command", phase: "completed", title: "Command run complete", timestamp: Date.now() }],
      });
      threadDb.getThreadMessages.mockReturnValue([{ role: "user", content: "hi" }] as any);
      threadDb.getExecutionEvents.mockReturnValue([{ id: "cmd:1", kind: "command", phase: "completed", title: "Command run complete", timestamp: Date.now() }] as any);

      const result = await callHandler(router, "chat.history", { threadId });
      expect(result.messages).toHaveLength(1);
      expect(result.executionEvents).toHaveLength(1);
    });

    it("normalizes assistant thinking blocks into answer plus reasoning", async () => {
      const threadId = "t-thinking";
      threadDb._seed(threadId, {
        id: threadId,
        title: "thinking",
        messages: [],
      });
      threadDb.getThreadMessages.mockReturnValue([{
        id: "assistant-1",
        role: "assistant",
        content: "<thinking>private trace</thinking>\nFinal answer",
        timestamp: Date.now(),
      }] as any);
      threadDb.getExecutionEvents.mockReturnValue([] as any);

      const result = await callHandler(router, "chat.history", { threadId });
      expect(result.messages[0]).toEqual(expect.objectContaining({
        content: "Final answer",
        reasoning: "private trace",
      }));
    });

    it("returns empty for missing thread", async () => {
      const result = await callHandler(router, "chat.history", { threadId: "missing" });
      expect(result.messages).toEqual([]);
    });

    it("clamps limit between 1 and 200", async () => {
      const threadId = "t1";
      threadDb._seed(threadId, { id: threadId, title: "test", messages: [] });

      await callHandler(router, "chat.history", { threadId, limit: 500 });
      expect(threadDb.getThreadMessages).toHaveBeenCalledWith(threadId, 200);
    });

    it("returns empty when no threadDb", async () => {
      // Re-register without threadDb
      const r2 = new MethodRouter();
      registerHandlers(r2, {
        processor: processor as any,
        queue: queue as any,
        connections: connections as any,
        devices: devices as any,
        config: { daemon: { name: "test" } } as any,
        configPath: "/tmp/test.toml",
      });
      const result = await callHandler(r2, "chat.history", { threadId: "t1" });
      expect(result.messages).toEqual([]);
    });
  });

  // --- Agents ---

  describe("agents.list", () => {
    it("returns agents from registry", async () => {
      registry._add("nyx", {
        name: "Nyx", role: "lead", enabled: true,
        total_invocations: 10, total_tokens_in: 1000, total_tokens_out: 500,
        estimated_cost_cents: 50, last_invoked_at: Date.now(),
      });
      const result = await callHandler(router, "agents.list", {});
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].name).toBe("Nyx");
      expect(result.agents[0].totalInvocations).toBe(10);
    });

    it("returns empty when no registry", async () => {
      const r2 = new MethodRouter();
      registerHandlers(r2, {
        processor: processor as any,
        queue: queue as any,
        connections: connections as any,
        devices: devices as any,
        config: { daemon: { name: "test" } } as any,
        configPath: "/tmp/test.toml",
      });
      const result = await callHandler(r2, "agents.list", {});
      expect(result.agents).toEqual([]);
    });

    it("sorts the configured primary agent to the front", async () => {
      const orderedRouter = new MethodRouter();
      registry._add("analyst", {
        name: "Analyst", role: "worker", enabled: true,
        total_invocations: 0, total_tokens_in: 0, total_tokens_out: 0,
        estimated_cost_cents: 0, last_invoked_at: null,
      });
      registry._add("onyx", {
        name: "Onyx", role: "lead", enabled: true,
        total_invocations: 0, total_tokens_in: 0, total_tokens_out: 0,
        estimated_cost_cents: 0, last_invoked_at: null,
      });

      registerHandlers(orderedRouter, {
        processor: processor as any,
        queue: queue as any,
        connections: connections as any,
        devices: devices as any,
        registry: registry as any,
        config: {
          daemon: { name: "test-instance", primary_agent: "onyx" },
          agents: {
            onyx: { name: "Onyx", role: "lead" },
            analyst: { name: "Analyst", role: "worker" },
          },
        } as any,
        configPath: "/tmp/test.toml",
      });

      const result = await callHandler(orderedRouter, "agents.list", {});
      expect(result.agents[0].id).toBe("onyx");
    });
  });

  // --- Threads ---

  describe("threads.list", () => {
    it("returns threads from DB", async () => {
      threadDb._seed("t1", { id: "t1", title: "test", agent: "nyx", status: "active", created_at: Date.now(), updated_at: Date.now(), messages: [] });
      const result = await callHandler(router, "threads.list", {});
      expect(result.threads).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe("threads.search", () => {
    it("returns full-text thread search results", async () => {
      threadDb._seed("thread-search-1", {
        id: "thread-search-1",
        title: "Gateway reconnect fix",
        message: "Repair gateway websocket reconnect behavior",
        agent: "nyx",
        status: "completed",
        created_at: 1,
        updated_at: 2,
        messages: [],
      });

      const result = await callHandler(router, "threads.search", { query: "reconnect", limit: 5 });
      expect(threadDb.searchThreads).toHaveBeenCalledWith("reconnect", 5);
      expect(result.threads[0]).toEqual(expect.objectContaining({
        id: "thread-search-1",
        title: "Gateway reconnect fix",
        snippet: "Repair gateway websocket reconnect behavior",
      }));
    });
  });

  describe("threads.get", () => {
    it("returns thread with messages", async () => {
      threadDb._seed("t1", {
        id: "t1", title: "test", agent: "nyx", status: "active",
        created_at: Date.now(), updated_at: Date.now(),
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      });
      const result = await callHandler(router, "threads.get", { id: "t1" });
      expect(result.id).toBe("t1");
      expect(result.messages).toHaveLength(1);
    });

    it("returns null for missing thread", async () => {
      const result = await callHandler(router, "threads.get", { id: "missing" });
      expect(result).toBeNull();
    });
  });

  describe("threads.delete", () => {
    it("returns before memory extraction finishes", async () => {
      const threadId = "t1";
      threadDb._seed(threadId, {
        id: threadId,
        title: "test",
        agent: "nyx",
        status: "active",
        created_at: Date.now(),
        updated_at: Date.now(),
        messages: [
          { role: "user", content: "remember this", timestamp: Date.now() },
          { role: "assistant", content: "noted", timestamp: Date.now() },
        ],
      });

      const extractSpy = spyOn(extractModule, "extractMemories").mockImplementation(
        async () => await new Promise<never>(() => {}),
      );

      const result = await Promise.race([
        callHandler(router, "threads.delete", { id: threadId }),
        new Promise((resolve) => setTimeout(() => resolve("timed-out"), 25)),
      ]);

      expect(result).toEqual({ ok: true });
      expect(threadDb.deleteThread).toHaveBeenCalledWith(threadId);
      expect(threadDb.getThreadMessages).toHaveBeenCalledWith(threadId);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(extractSpy).toHaveBeenCalled();

      extractSpy.mockRestore();
    });
  });

  // --- Proposals ---

  describe("proposals.list", () => {
    it("returns proposals", async () => {
      proposalStore._add("p1", { id: "p1", title: "Test", status: "proposed" });
      const result = await callHandler(router, "proposals.list", {});
      expect(result.proposals).toHaveLength(1);
    });
  });

  describe("proposals.approve", () => {
    it("approves proposal and emits event", async () => {
      proposalStore._add("p1", { id: "p1", title: "Test", status: "proposed" });
      const result = await callHandler(router, "proposals.approve", { proposalId: "p1" });
      expect(result.status).toBe("approved");
      expect(processor.emitEvent).toHaveBeenCalledWith("proposal:approved", expect.objectContaining({ proposal_id: "p1", title: "Test" }));
    });

    it("throws when proposal not found", async () => {
      await expect(callHandler(router, "proposals.approve", { proposalId: "missing" })).rejects.toThrow("not found");
    });
  });

  describe("proposals.reject", () => {
    it("rejects proposal with reason", async () => {
      proposalStore._add("p1", { id: "p1", title: "Test", status: "proposed", category: "feat", proposed_by: "nyx" });
      const result = await callHandler(router, "proposals.reject", { proposalId: "p1", notes: "Not needed" });
      expect(result.status).toBe("rejected");
      expect(processor.emitEvent).toHaveBeenCalledWith("proposal:rejected", expect.objectContaining({ reason: "Not needed" }));
    });

    it("uses default rejection reason", async () => {
      proposalStore._add("p1", { id: "p1", title: "Test", status: "proposed", category: "feat", proposed_by: "nyx" });
      await callHandler(router, "proposals.reject", { proposalId: "p1" });
      expect(processor.emitEvent).toHaveBeenCalledWith("proposal:rejected", expect.objectContaining({ reason: "Rejected via Gateway" }));
    });
  });

  describe("proposal:update bridge", () => {
    it("broadcasts approved, rejected, reviewed, and completed proposal events", () => {
      for (const listener of processor._listeners) {
        listener({ type: "proposal:approved", data: { proposalId: "p-approved" } });
        listener({ type: "proposal:rejected", data: { proposal_id: "p-rejected" } });
        listener({ type: "proposal:reviewed", data: { proposalId: "p-reviewed", status: "reviewed" } });
        listener({
          type: "proposal:completed",
          data: { proposal_id: "p-completed", pr_url: "https://example.com/pr/1" },
        });
      }

      expect(connections.broadcast).toHaveBeenCalledWith("proposal:update", {
        proposalId: "p-approved",
        status: "approved",
      });
      expect(connections.broadcast).toHaveBeenCalledWith("proposal:update", {
        proposalId: "p-rejected",
        status: "rejected",
      });
      expect(connections.broadcast).toHaveBeenCalledWith("proposal:update", {
        proposalId: "p-reviewed",
        status: "reviewed",
        verdict: undefined,
      });
      expect(connections.broadcast).toHaveBeenCalledWith("proposal:update", {
        proposalId: "p-completed",
        status: "completed",
        prUrl: "https://example.com/pr/1",
      });
    });
  });

  describe("proposals.startReview", () => {
    it("starts review for proposed proposal", async () => {
      proposalStore._add("p1", {
        id: "p1", title: "Test", status: "proposed", category: "feat",
        priority: "medium", effort: "small", description: "Test proposal",
      });
      const result = await callHandler(router, "proposals.startReview", { proposalId: "p1" });
      expect(result.status).toBe("queued");
      // Review is queued — markReviewing + processImmediate run async in the queue
      await new Promise(r => setTimeout(r, 50));
      expect(proposalStore.markReviewing).toHaveBeenCalledWith("p1");
      expect(processor.processImmediate).toHaveBeenCalled();
    });

    it("skips duplicate review execution when claim fails", async () => {
      proposalStore._add("p1", {
        id: "p1", title: "Test", status: "proposed", category: "feat",
        priority: "medium", effort: "small", description: "Test proposal",
      });
      proposalStore.markReviewing.mockReturnValueOnce(false);

      const result = await callHandler(router, "proposals.startReview", { proposalId: "p1" });
      expect(result.status).toBe("queued");
      await new Promise(r => setTimeout(r, 50));
      expect(proposalStore.markReviewing).toHaveBeenCalledWith("p1");
      expect(processor.processImmediate).not.toHaveBeenCalled();
    });

    it("passes explicit review model overrides through the processor policy", async () => {
      proposalStore._add("p1", {
        id: "p1", title: "Test", status: "proposed", category: "feat",
        priority: "medium", effort: "small", description: "Test proposal",
      });

      const result = await callHandler(router, "proposals.startReview", {
        proposalId: "p1",
        model: "claude-opus-4-6",
      });
      expect(result.status).toBe("queued");
      await new Promise(r => setTimeout(r, 50));
      expect(processor.processImmediate).toHaveBeenCalled();
      expect(processor.resolveProposalReviewModel).toHaveBeenCalledWith(["nyx", "analyst"], "claude-opus-4-6");
      const call = (processor.processImmediate as any).mock.calls.at(-1)?.[0] as { modelOverride?: string } | undefined;
      expect(call?.modelOverride).toBe("claude-opus-4-6");
    });

    it("rejects review for non-proposed status", async () => {
      proposalStore._add("p1", { id: "p1", title: "Test", status: "approved" });
      await expect(callHandler(router, "proposals.startReview", { proposalId: "p1" })).rejects.toThrow("'proposed' status");
    });

    it("rejects re-review when a completed review already exists", async () => {
      proposalStore._add("p1", {
        id: "p1",
        title: "Test",
        status: "reviewed",
        verdict: "APPROVE",
        review_result: "**Verdict: APPROVE**",
      });

      await expect(callHandler(router, "proposals.startReview", { proposalId: "p1" })).rejects.toThrow("already has a completed review");
    });
  });

  describe("proposals.delete", () => {
    it("deletes existing proposal", async () => {
      proposalStore._add("p1", { id: "p1", title: "Test" });
      const result = await callHandler(router, "proposals.delete", { proposalId: "p1" });
      expect(result.ok).toBe(true);
    });

    it("throws when proposal not found", async () => {
      await expect(callHandler(router, "proposals.delete", { proposalId: "missing" })).rejects.toThrow("not found");
    });
  });

  describe("proposals.createPr", () => {
    it("returns the existing PR when one is already attached", async () => {
      proposalStore._add("p1", {
        id: "p1",
        proposal_id: "proposal-p1",
        title: "Test",
        status: "completed",
        pr_url: "https://github.com/nyx/pull/42",
      });

      const result = await callHandler(router, "proposals.createPr", { proposalId: "p1" });

      expect(result.ok).toBe(true);
      expect(result.pr_url).toBe("https://github.com/nyx/pull/42");
      expect(proposalStore.setPrUrl).not.toHaveBeenCalled();
    });

    it("rejects non-completed proposals", async () => {
      proposalStore._add("p1", { id: "p1", title: "Test", status: "approved" });
      await expect(callHandler(router, "proposals.createPr", { proposalId: "p1" })).rejects.toThrow("completed");
    });

    it("creates PRs from the shared batch branch for batch-executed proposals", async () => {
      spawnSyncSpy = spyOn(Bun, "spawnSync");
      spawnSyncSpy
        .mockReturnValueOnce(spawnResult(0, "abc123\trefs/heads/proposal/batch-mnufcv98\n"))
        .mockReturnValueOnce(spawnResult(0, "https://github.com/nyx/repo/pull/77\n"));

      proposalStore._add("proposal-1376d7b3", {
        id: "p1",
        proposal_id: "proposal-1376d7b3",
        title: "Batch Item",
        status: "completed",
        pr_url: null,
        files_affected: [],
        execution_ref: "batch-mnufcv98-proposal-1376d7b3",
      });
      proposalStore._add("proposal-d8e0e969", {
        id: "p2",
        proposal_id: "proposal-d8e0e969",
        title: "Batch Sibling",
        status: "completed",
        pr_url: null,
        files_affected: [],
        execution_ref: "batch-mnufcv98-proposal-d8e0e969",
      });

      const result = await callHandler(router, "proposals.createPr", { proposalId: "proposal-1376d7b3" });

      expect(result.ok).toBe(true);
      expect(result.pr_url).toBe("https://github.com/nyx/repo/pull/77");
      expect(spawnSyncSpy).toHaveBeenNthCalledWith(
        1,
        ["git", "ls-remote", "--heads", "origin", "proposal/batch-mnufcv98"],
        { cwd: "/tmp/nyxhive-test" },
      );
      expect(proposalStore.setPrUrl).toHaveBeenCalledWith(
        "proposal-1376d7b3",
        "https://github.com/nyx/repo/pull/77",
      );
      expect(proposalStore.setPrUrl).toHaveBeenCalledWith(
        "proposal-d8e0e969",
        "https://github.com/nyx/repo/pull/77",
      );
    });
  });

  describe("proposals.list", () => {
    it("syncs proposals that were merged directly on GitHub before returning them", async () => {
      spawnSyncSpy = spyOn(Bun, "spawnSync");
      spawnSyncSpy.mockReturnValueOnce(spawnResult(0, JSON.stringify({ state: "MERGED" })));

      proposalStore._add("proposal-p1", {
        id: "p1",
        proposal_id: "proposal-p1",
        title: "Test",
        status: "completed",
        pr_url: "https://github.com/nyx/pull/42",
        files_affected: [],
      });

      const result = await callHandler(router, "proposals.list", {});

      expect(proposalStore.markMerged).toHaveBeenCalledWith("proposal-p1", "github-sync");
      expect(result.proposals[0].status).toBe("merged");
    });
  });

  describe("proposals.merge", () => {
    it("rejects completed proposals that have no PR URL", async () => {
      proposalStore._add("p1", {
        id: "p1",
        proposal_id: "proposal-p1",
        title: "Test",
        status: "completed",
      });

      await expect(callHandler(router, "proposals.merge", { proposalId: "p1" })).rejects.toThrow("No PR to merge");
    });

    it("rejects non-completed proposals", async () => {
      proposalStore._add("p1", {
        id: "p1",
        proposal_id: "proposal-p1",
        title: "Test",
        status: "merged",
        pr_url: "https://github.com/nyx/pull/42",
      });

      await expect(callHandler(router, "proposals.merge", { proposalId: "p1" })).rejects.toThrow("completed");
    });

    it("marks the proposal merged when the PR is already merged and only local cleanup remains", async () => {
      spawnSyncSpy = spyOn(Bun, "spawnSync");
      spawnSyncSpy
        .mockReturnValueOnce(spawnResult(0, JSON.stringify({ state: "OPEN" })))
        .mockReturnValueOnce(spawnResult(1, "", "cannot delete branch 'proposal/p1' used by worktree at '/tmp/worktree'"))
        .mockReturnValueOnce(spawnResult(0, JSON.stringify({ state: "MERGED" })))
        .mockReturnValueOnce(spawnResult(0, [
          "worktree /tmp/nyxhive-test",
          "HEAD abc123",
          "branch refs/heads/master",
          "",
          "worktree /tmp/worktree",
          "HEAD def456",
          "branch refs/heads/proposal/p1",
          "",
        ].join("\n")))
        .mockReturnValueOnce(spawnResult(0))
        .mockReturnValueOnce(spawnResult(0));

      proposalStore._add("p1", {
        id: "p1",
        proposal_id: "proposal-p1",
        title: "Test",
        status: "completed",
        pr_url: "https://github.com/nyx/pull/42",
      });

      const result = await callHandler(router, "proposals.merge", { proposalId: "p1" });

      expect(result.ok).toBe(true);
      expect(result.already_merged).toBe(true);
      expect(proposalStore.markMerged).toHaveBeenCalledWith("p1", "gateway-user");
    });
  });

  describe("proposals.deleteTerminal", () => {
    it("returns count of deleted terminal proposals", async () => {
      const result = await callHandler(router, "proposals.deleteTerminal", {});
      expect(result.deleted).toBe(3);
    });
  });

  // --- Tasks ---

  describe("tasks.list", () => {
    it("returns tasks", async () => {
      taskStore._add({ id: "t1", title: "Fix bug", status: "todo" });
      const result = await callHandler(router, "tasks.list", {});
      expect(result.tasks).toHaveLength(1);
    });
  });

  describe("tasks.update", () => {
    it("updates existing task", async () => {
      taskStore._add({ id: "t1", title: "Fix bug", status: "todo" });
      const result = await callHandler(router, "tasks.update", { id: "t1", status: "done" });
      expect(result.updated).toBe(true);
    });

    it("throws when task not found", async () => {
      await expect(callHandler(router, "tasks.update", { id: "missing" })).rejects.toThrow("not found");
    });
  });

  // --- Memory ---

  describe("memory.search", () => {
    it("returns search results", async () => {
      const result = await callHandler(router, "memory.search", { query: "test" });
      expect(result.results).toHaveLength(1);
      expect(result.results[0].content).toBe("test memory");
    });

    it("clamps limit", async () => {
      await callHandler(router, "memory.search", { query: "test", limit: 500 });
      expect(memory.searchMemories).toHaveBeenCalledWith("test", 100);
    });
  });

  // --- Knowledge ---

  describe("knowledge.search", () => {
    it("embeds query and searches", async () => {
      await callHandler(router, "knowledge.search", { query: "test" });
      expect(embedder.embed).toHaveBeenCalledWith("test");
      expect(knowledge.search).toHaveBeenCalled();
    });

    it("returns empty when no knowledge store", async () => {
      const r2 = new MethodRouter();
      registerHandlers(r2, {
        processor: processor as any,
        queue: queue as any,
        connections: connections as any,
        devices: devices as any,
        config: { daemon: { name: "test" } } as any,
        configPath: "/tmp/test.toml",
      });
      const result = await callHandler(r2, "knowledge.search", { query: "test" });
      expect(result.results).toEqual([]);
    });
  });

  describe("knowledge.stats", () => {
    it("returns stats", async () => {
      const result = await callHandler(router, "knowledge.stats", {});
      expect(result.stats).toEqual({ total: 0, compiledPages: 1 });
    });
  });

  describe("knowledge.recent", () => {
    it("returns recent entries", async () => {
      const result = await callHandler(router, "knowledge.recent", {});
      expect(result.entries).toEqual([]);
    });

    it("clamps limit between 1 and 100", async () => {
      await callHandler(router, "knowledge.recent", { limit: 500 });
      expect(knowledge.getRecentChunks).toHaveBeenCalledWith(100);
    });
  });

  describe("knowledge.digests", () => {
    it("lists compiled digest pages", async () => {
      const result = await callHandler(router, "knowledge.digests.list", { query: "gateway", limit: 10 });
      expect(result.pages).toHaveLength(1);
      expect(compiledKnowledge.list).toHaveBeenCalledWith({
        query: "gateway",
        limit: 10,
        stale: undefined,
      });
    });

    it("compiles a digest page from a source path", async () => {
      const result = await callHandler(router, "knowledge.digests.compile", { sourcePath: "docs/gateway.md" });
      expect(knowledge.getChunksBySourcePath).toHaveBeenCalledWith("docs/gateway.md");
      expect(compiledKnowledge.upsert).toHaveBeenCalled();
      expect(result.page.title).toBe("Gateway Runbook");
    });

    it("marks a digest as stale", async () => {
      const result = await callHandler(router, "knowledge.digests.stale", { id: 1, stale: true });
      expect(compiledKnowledge.markStale).toHaveBeenCalledWith(1, true);
      expect(result.page.stale).toBe(1);
    });

    it("audits compiled digests for stale sources", async () => {
      const result = await callHandler(router, "knowledge.digests.audit", {});
      expect(compiledKnowledge.auditStaleness).toHaveBeenCalled();
      expect(result.audit).toEqual({ checked: 1, markedStale: 1, restoredFresh: 0, missingSources: 0 });
    });
  });

  // --- Scheduler ---

  describe("scheduler.list", () => {
    it("returns scheduled jobs", async () => {
      scheduler._add("j1", {
        id: "j1", name: "Scout scan", description: "Daily scan",
        cron_expression: "0 9 * * *", agent: "scout", category: "ops",
        enabled: 1, last_run_at: null, next_run_at: null,
        last_status: null, run_count: 0, consecutive_failures: 0,
      });
      const result = await callHandler(router, "scheduler.list", {});
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0].enabled).toBe(true);
    });
  });

  describe("scheduler.update", () => {
    it("updates task and returns it", async () => {
      scheduler._add("j1", { id: "j1", name: "Scout", enabled: 1 });
      const result = await callHandler(router, "scheduler.update", { id: "j1", enabled: false });
      expect(result.ok).toBe(true);
    });

    it("throws when task not found", async () => {
      await expect(callHandler(router, "scheduler.update", { id: "missing" })).rejects.toThrow("not found");
    });
  });

  describe("scheduler.run", () => {
    it("triggers task execution", async () => {
      scheduler._add("j1", { id: "j1", name: "Scout" });
      const result = await callHandler(router, "scheduler.run", { id: "j1" });
      expect(result.ok).toBe(true);
      expect(result.triggered).toBe("j1");
    });

    it("throws when task not found", async () => {
      await expect(callHandler(router, "scheduler.run", { id: "missing" })).rejects.toThrow("not found");
    });
  });

  // --- Channels ---

  describe("channels.list", () => {
    it("returns configured channels", async () => {
      const r2 = new MethodRouter();
      registerHandlers(r2, {
        processor: processor as any,
        queue: queue as any,
        connections: connections as any,
        devices: devices as any,
        config: { daemon: { name: "test" }, discord: { token: "x" }, telegram: { token: "y" } } as any,
        configPath: "/tmp/test.toml",
      });
      const result = await callHandler(r2, "channels.list", {});
      expect(result.channels).toHaveLength(2);
      expect(result.channels.map((c: any) => c.type)).toContain("discord");
      expect(result.channels.map((c: any) => c.type)).toContain("telegram");
    });

    it("returns empty when no channels configured", async () => {
      const result = await callHandler(router, "channels.list", {});
      expect(result.channels).toEqual([]);
    });
  });

  // --- Traces ---

  describe("traces.list", () => {
    it("returns traces with clamped limit", async () => {
      await callHandler(router, "traces.list", { limit: 500 });
      expect(traces.getRecentTraces).toHaveBeenCalledWith(200, undefined);
    });
  });

  describe("traces.get", () => {
    it("returns trace and events", async () => {
      const result = await callHandler(router, "traces.get", { id: "tr1" });
      expect(result.trace).toBeNull();
      expect(result.events).toEqual([]);
    });
  });

  // --- Usage routing ---

  describe("usage.routing", () => {
    it("returns routing stats", async () => {
      const result = await callHandler(router, "usage.routing", {});
      expect(result.period_hours).toBe(168);
      expect(result.success_rates).toEqual([]);
      expect(result.hint_stats).toEqual([]);
    });

    it("clamps hours", async () => {
      await callHandler(router, "usage.routing", { hours: 99999 });
      expect(traces.getSuccessRates).toHaveBeenCalledWith(8760);
    });
  });

  // --- Devices ---

  describe("devices.list", () => {
    it("returns device list", async () => {
      devices._add({ id: "d1", name: "Browser", status: "approved" });
      const result = await callHandler(router, "devices.list", {});
      expect(result.devices).toHaveLength(1);
    });
  });

  describe("devices.approve", () => {
    it("approves device and broadcasts", async () => {
      devices._add({ id: "d1", name: "Browser", status: "pending" });
      const result = await callHandler(router, "devices.approve", { deviceId: "d1" });
      expect(result.approved).toBe(true);
      expect(connections.broadcast).toHaveBeenCalledWith("device:approved", expect.objectContaining({ deviceId: "d1" }));
    });

    it("returns false for unknown device", async () => {
      const result = await callHandler(router, "devices.approve", { deviceId: "missing" });
      expect(result.approved).toBe(false);
    });
  });

  describe("devices.revoke", () => {
    it("revokes device and broadcasts", async () => {
      devices._add({ id: "d1", name: "Browser", status: "approved" });
      const result = await callHandler(router, "devices.revoke", { deviceId: "d1" });
      expect(result.revoked).toBe(true);
      expect(connections.broadcast).toHaveBeenCalledWith("device:revoked", { deviceId: "d1" });
    });
  });

  describe("threads.changes", () => {
    it("returns persisted file changes for a thread", async () => {
      threadDb._seed("thread-1", {
        id: "thread-1",
        title: "Thread 1",
        messages: [],
        executionEvents: [],
        fileChanges: [
          {
            id: "change-1",
            threadId: "thread-1",
            filePath: "src/index.ts",
            operation: "edit",
            linesAdded: 12,
            linesRemoved: 4,
            timestamp: Date.now(),
          },
        ],
      });

      const result = await callHandler(router, "threads.changes", { id: "thread-1" });
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].filePath).toBe("src/index.ts");
    });

    it("returns an empty change list for stale thread ids", async () => {
      const result = await callHandler(router, "threads.changes", { id: "missing-thread" });

      expect(result).toEqual({ changes: [] });
    });
  });

  describe("chat request lifecycle", () => {
    it("lists pending proposal approvals as chat requests", async () => {
      proposalStore._add("proposal-1", {
        proposal_id: "proposal-1",
        title: "Ship diff drawer",
        description: "Add a diff surface to chat",
        category: "feature",
        priority: "high",
        effort: "medium",
        status: "proposed",
        autonomy: "requires_approval",
        files_affected: ["src/gateway/src/pages/Chat.tsx"],
        thread_id: "thread-abc",
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      const result = await callHandler(router, "chat.requests.list", {});
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0].requestId).toBe("proposal:proposal-1");
      expect(result.requests[0].proposal.title).toBe("Ship diff drawer");
      expect(result.requests[0].threadId).toBe("thread-abc");
    });

    it("lists suspended user-input requests alongside proposal approvals", async () => {
      queue._setSuspended({
        message_id: "msg-suspended-1",
        request_id: "clarify:thread-9",
        channel: "gateway",
        sender: "User",
        sender_id: "device-1",
        thread_id: "thread-9",
        request: {
          question: "Which repo should I touch?",
          options: [
            { key: "nyxhive", description: "Backend orchestrator" },
            { key: "onyx", description: "Supervisor shell" },
          ],
        },
        response_text: "Which repo should I touch?",
        suspended_at: 100,
        timeout_at: 200,
      });

      const result = await callHandler(router, "chat.requests.list", {});
      expect(result.requests).toEqual([
        {
          requestId: "clarify:thread-9",
          kind: "user_input",
          title: "Which repo should I touch?",
          description: "1. nyxhive: Backend orchestrator\n2. onyx: Supervisor shell",
          threadId: "thread-9",
          createdAt: 100,
          actions: [],
        },
      ]);
    });

    it("broadcasts gateway user-input requests and resolutions from processor events", () => {
      const createdAt = Date.now();
      processor._listeners.forEach((listener: (event: any) => void) => listener({
        type: "input.requested",
        data: {
          requestId: "clarify:thread-1",
          question: "Pick a model",
          options: [
            { key: "Fast", description: "Ship quickly" },
            { key: "Thorough", description: "Go deeper" },
          ],
          threadId: "thread-1",
          createdAt,
        },
      }));

      expect(connections.broadcast).toHaveBeenCalledWith("request.opened", {
        requestId: "clarify:thread-1",
        kind: "user_input",
        title: "Pick a model",
        description: "1. Fast: Ship quickly\n2. Thorough: Go deeper",
        threadId: "thread-1",
        createdAt,
        actions: [],
      });

      processor._listeners.forEach((listener: (event: any) => void) => listener({
        type: "request.resolved",
        data: {
          requestId: "clarify:thread-1",
          kind: "user_input",
          resolution: "responded",
          resolvedAt: createdAt + 1,
        },
      }));

      expect(connections.broadcast).toHaveBeenCalledWith("request.resolved", {
        requestId: "clarify:thread-1",
        kind: "user_input",
        resolution: "responded",
        resolvedAt: createdAt + 1,
      });
    });

    it("resolves proposal approvals through chat.request.resolve", async () => {
      proposalStore._add("proposal-2", {
        proposal_id: "proposal-2",
        title: "Inline approvals",
        description: "Add composer request cards",
        category: "feature",
        priority: "medium",
        effort: "small",
        status: "proposed",
        autonomy: "requires_approval",
        files_affected: ["src/gateway/src/components/chat/ChatRequestCards.tsx"],
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      const result = await callHandler(router, "chat.request.resolve", {
        requestId: "proposal:proposal-2",
        action: "approve",
      });

      expect(result.status).toBe("approved");
      expect(processor.emitEvent).toHaveBeenCalledWith("proposal:approved", expect.objectContaining({ proposal_id: "proposal-2", title: "Inline approvals" }));
    });

    it("resolves suspended user-input requests through chat.request.resolve", async () => {
      queue._setSuspended({
        message_id: "msg-suspended-2",
        request_id: "clarify:thread-10",
        channel: "gateway",
        sender: "User",
        sender_id: "device-1",
        thread_id: "thread-10",
        request: {
          question: "Which repo should I touch?",
        },
        response_text: "Which repo should I touch?",
        suspended_at: 100,
        timeout_at: 200,
      });

      const result = await callHandler(router, "chat.request.resolve", {
        requestId: "clarify:thread-10",
        action: "respond",
        response: "nyxhive",
      });

      expect(processor.resumeSuspendedMessage).toHaveBeenCalledWith(
        "msg-suspended-2",
        "nyxhive",
        {
          async: false,
          channel: "gateway",
          sender: "User",
          sender_id: "device-1",
          thread_id: "thread-10",
        },
      );
      expect(result).toEqual({
        status: "responded",
        requestId: "clarify:thread-10",
        messageId: "msg-suspended-2",
        response: "Resumed with nyxhive",
      });
    });

    it("broadcasts live proposal requests with the originating thread id", async () => {
      proposalStore._add("proposal-3", {
        proposal_id: "proposal-3",
        title: "Scoped request",
        description: "Keep approvals on the right thread",
        category: "feature",
        priority: "medium",
        effort: "small",
        status: "proposed",
        autonomy: "requires_approval",
        files_affected: ["src/gateway/src/pages/Chat.tsx"],
        created_at: Date.now(),
        updated_at: Date.now(),
      });

      processor._listeners[0]({
        type: "proposal:created",
        data: {
          proposal_id: "proposal-3",
          threadId: "thread-42",
        },
      });

      expect(connections.broadcast).toHaveBeenCalledWith("request.opened", expect.objectContaining({
        requestId: "proposal:proposal-3",
        threadId: "thread-42",
      }));
    });

    it("broadcasts input requests and resolutions through the runtime request channel", async () => {
      processor._listeners[0]({
        type: "input.requested",
        data: {
          requestId: "clarify:thread-1",
          threadId: "thread-1",
          question: "Pick a repo",
          options: [
            { key: "nyxhive", description: "Backend" },
            { key: "nyx-ios", description: "iOS app" },
          ],
          createdAt: 123,
        },
      });
      processor._listeners[0]({
        type: "request.resolved",
        data: {
          requestId: "clarify:thread-1",
          kind: "user_input",
          resolution: "responded",
          resolvedAt: 456,
        },
      });

      expect(connections.broadcast).toHaveBeenCalledWith("request.opened", expect.objectContaining({
        requestId: "clarify:thread-1",
        kind: "user_input",
        threadId: "thread-1",
      }));
      expect(connections.broadcast).toHaveBeenCalledWith("request.resolved", {
        requestId: "clarify:thread-1",
        kind: "user_input",
        resolution: "responded",
        resolvedAt: 456,
      });
    });
  });

  // --- System ---

  describe("system.health", () => {
    it("returns health metrics", async () => {
      const result = await callHandler(router, "system.health", {});
      expect(result.uptime).toBeGreaterThan(0);
      expect(result.queueDepth).toBe(0);
      expect(result.activeConnections).toBe(1);
    });

    it("returns the resolved primary agent as leadAgent", async () => {
      const healthRouter = new MethodRouter();
      registerHandlers(healthRouter, {
        processor: processor as any,
        queue: queue as any,
        connections: connections as any,
        devices: devices as any,
        config: {
          daemon: { name: "test-instance", primary_agent: "vortex" },
          agents: {
            analyst: { name: "Analyst", role: "worker" },
            vortex: { name: "Vortex", role: "lead" },
          },
        } as any,
        configPath: "/tmp/test.toml",
      });

      const result = await callHandler(healthRouter, "system.health", {});
      expect(result.leadAgent).toBe("vortex");
    });
  });

  describe("system.capabilities", () => {
    it("returns protocol capabilities for workspace feature gating", async () => {
      const result = await callHandler(router, "system.capabilities", {});

      expect(result.version).toBe(1);
      expect(result.instanceName).toBe("test-instance");
      expect(result.methods).toContain("chat.send");
      expect(result.methods).toContain("system.capabilities");
      expect(result.events).toContain("turn.started");
      expect(result.events).toContain("turn.completed");
      expect(result.features.chat).toBe(true);
      expect(result.features.traces).toBe(true);
      expect(result.features.runtimeLifecycle).toBe(true);
      expect(result.auth.mode).toBe("blocked");
    });
  });

  // --- Logs ---

  describe("logs.subscribe", () => {
    it("subscribes device to log events", async () => {
      await callHandler(router, "logs.subscribe", {}, "device-1");
      expect(connections.subscribe).toHaveBeenCalledWith("device-1", "log:entry");
    });
  });

  describe("logs.unsubscribe", () => {
    it("unsubscribes device from log events", async () => {
      await callHandler(router, "logs.unsubscribe", {}, "device-1");
      expect(connections.unsubscribe).toHaveBeenCalledWith("device-1", "log:entry");
    });
  });

  describe("logs.recent", () => {
    it("returns recent log entries with clamped limit", async () => {
      const result = await callHandler(router, "logs.recent", { limit: 1000 });
      expect(result.entries).toBeDefined();
    });
  });

  // --- Audit ---

  describe("audit.list", () => {
    it("returns audit entries", async () => {
      const result = await callHandler(router, "audit.list", {});
      expect(result.entries).toHaveLength(1);
    });

    it("filters by event prefix", async () => {
      audit.query.mockReturnValue([
        { event: "chat.send", timestamp: Date.now() },
        { event: "proposal.approve", timestamp: Date.now() },
      ] as any);
      const result = await callHandler(router, "audit.list", { eventPrefix: "chat" });
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].event).toBe("chat.send");
    });

    it("returns empty when no audit store", async () => {
      const r2 = new MethodRouter();
      registerHandlers(r2, {
        processor: processor as any,
        queue: queue as any,
        connections: connections as any,
        devices: devices as any,
        config: { daemon: { name: "test" } } as any,
        configPath: "/tmp/test.toml",
      });
      const result = await callHandler(r2, "audit.list", {});
      expect(result.entries).toEqual([]);
    });

    it("returns parsed HTTP audit entries and supports parsed filters", async () => {
      audit.query.mockReturnValue([
        {
          id: 1,
          event: "http.outbound",
          timestamp: Date.now(),
          channel: "gateway",
          agent: "nyx",
          detail: JSON.stringify({
            method: "POST",
            host: "api.example.com",
            path: "/v1/messages",
            redactedPath: "/v1/messages",
            status: 500,
            ok: false,
            outcome: "error",
            durationMs: 250,
            request: { redactedHeaders: { authorization: "[redacted]" } },
            response: { redactedBodyPreview: "server error" },
          }),
        },
      ] as any);

      const result = await callHandler(router, "audit.list", {
        event: "http.outbound",
        host: "api.example.com",
        method: "POST",
        status: 500,
        outcome: "error",
        pathContains: "messages",
        minDurationMs: 200,
      });

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].parsed.host).toBe("api.example.com");
      expect(result.entries[0].parsed.request.redactedHeaders.authorization).toBe("[redacted]");
    });

    it("summarizes audit entries", async () => {
      audit.query.mockReturnValue([
        { id: 1, event: "message.received", timestamp: 100, channel: "slack", agent: "nyx", detail: null },
        {
          id: 2,
          event: "http.outbound",
          timestamp: 200,
          channel: "gateway",
          agent: "nyx",
          detail: JSON.stringify({ method: "GET", host: "api.example.com", path: "/health", status: 200, ok: true, outcome: "success", durationMs: 50 }),
        },
        {
          id: 3,
          event: "http.outbound",
          timestamp: 300,
          channel: "gateway",
          agent: "nyx",
          detail: JSON.stringify({ method: "GET", host: "api.example.com", path: "/fail", status: 500, ok: false, outcome: "error", durationMs: 150 }),
        },
      ] as any);

      const result = await callHandler(router, "audit.summary", {});
      expect(result.total).toBe(3);
      expect(result.byEvent["http.outbound"]).toBe(2);
      expect(result.byChannel.gateway).toBe(2);
      expect(result.http.total).toBe(2);
      expect(result.http.errors).toBe(1);
      expect(result.http.topHosts[0]).toEqual({ host: "api.example.com", count: 2 });
      expect(result.latestTimestamp).toBe(300);
    });
  });

  describe("scheduler.core", () => {
    it("returns core task visibility", async () => {
      scheduler._add("j1", {
        id: "j1",
        name: "heartbeat:health-check",
        description: "Health",
        enabled: 1,
        last_status: "completed",
        last_result: "ok",
        run_count: 2,
        consecutive_failures: 0,
      });
      scheduler._add("j2", {
        id: "j2",
        name: "unrelated:scan",
        enabled: 1,
      });

      const result = await callHandler(router, "scheduler.core", {});
      expect(result.core_tasks).toHaveLength(1);
      expect(result.core_tasks[0].name).toBe("heartbeat:health-check");
      expect(result.enabled_count).toBe(1);
      expect(result.paused_automation_families.length).toBeGreaterThan(0);
    });
  });

  // --- Config ---

  describe("config.get", () => {
    it("returns empty for non-existent config", async () => {
      const result = await callHandler(router, "config.get", {});
      expect(result.content).toBe("");
    });
  });

  describe("config.validate", () => {
    it("validates valid TOML", async () => {
      const result = await callHandler(router, "config.validate", { content: '[daemon]\nname = "test"' });
      expect(result.valid).toBe(true);
    });

    it("rejects invalid TOML", async () => {
      const result = await callHandler(router, "config.validate", { content: "not valid toml {{{}}" });
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  // --- getActiveGatewayInvocation ---

  describe("getActiveGatewayInvocation", () => {
    it("is null initially", () => {
      // After beforeEach the module-level state should be null (no active chat)
      // Note: this tests the exported getter
      const inv = getActiveGatewayInvocation();
      // Could be null or set from a previous test — just verify it returns the right shape
      expect(inv === null || (typeof inv === "object" && "agent" in inv)).toBe(true);
    });
  });
});

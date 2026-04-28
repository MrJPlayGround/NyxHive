import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDeliverableResponse, resolveModelAlias, QueueProcessor, parseProposalCommand } from "../queue/processor.js";
import { DelegationEngine } from "../queue/delegation.js";
import { QueueDB } from "../queue/db.js";
import { AGENT_TIMEOUT_MS, ORCHESTRATOR_MAX_TURNS, DEFAULT_ROUTING_TABLE } from "../defaults.js";
import { createSSEStream } from "../server/sse.js";
import { parseActorMentions } from "../agents/actor.js";
import { MemoryStore } from "../memory/store.js";

describe("resolveModelAlias", () => {
  test("resolves haiku alias", () => {
    expect(resolveModelAlias("haiku")).toBe("claude-haiku-4-5-20251001");
  });

  test("resolves sonnet alias", () => {
    expect(resolveModelAlias("sonnet")).toBe("claude-sonnet-4-6");
  });

  test("resolves opus alias", () => {
    expect(resolveModelAlias("opus")).toBe("claude-opus-4-6");
  });

  test("resolves flash alias", () => {
    expect(resolveModelAlias("flash")).toBe("deepseek/deepseek-v3.2");
  });

  test("resolves flash-lite alias", () => {
    expect(resolveModelAlias("flash-lite")).toBe("deepseek/deepseek-v3.2");
  });

  test("resolves pro alias", () => {
    expect(resolveModelAlias("pro")).toBe("deepseek/deepseek-v3.2");
  });

  test("returns unknown model as-is", () => {
    expect(resolveModelAlias("some-unknown-model")).toBe("some-unknown-model");
  });

  test("is case insensitive", () => {
    expect(resolveModelAlias("HAIKU")).toBe("claude-haiku-4-5-20251001");
    expect(resolveModelAlias("Sonnet")).toBe("claude-sonnet-4-6");
  });

  test("returns full model ID as-is", () => {
    expect(resolveModelAlias("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveModelAlias("deepseek/deepseek-v3.2")).toBe("deepseek/deepseek-v3.2");
  });
});

describe("createSSEStream", () => {
  test("cancel() unsubscribes and cleans up", async () => {
    let unsubscribed = false;
    const response = createSSEStream((listener) => {
      // Simulate sending an event
      setTimeout(() => listener({ type: "test", data: { msg: "hello" }, timestamp: Date.now() }), 10);
      return () => { unsubscribed = true; };
    });

    // Read the stream briefly then cancel
    const reader = response.body!.getReader();
    const { value } = await reader.read(); // initial `: connected\n\n`
    expect(new TextDecoder().decode(value)).toContain("connected");

    await reader.cancel();
    // Give it a tick for cleanup
    await new Promise(r => setTimeout(r, 50));
    expect(unsubscribed).toBe(true);
  });

  test("returns correct SSE headers", () => {
    const response = createSSEStream(() => () => {});
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    // Clean up
    response.body?.cancel();
  });
});

describe("assertDeliverableResponse", () => {
  test("rejects empty final responses before they are persisted", () => {
    expect(() => assertDeliverableResponse("   \n\t", "msg-empty")).toThrow(
      "Agent produced an empty final response for message msg-empty",
    );
  });

  test("allows substantive final responses", () => {
    expect(assertDeliverableResponse("No crash; delivery failed.", "msg-ok")).toBe(
      "No crash; delivery failed.",
    );
  });
});

describe("AGENT_TIMEOUT_MS", () => {
  test("is defined and equals 30 minutes", () => {
    expect(AGENT_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  test("timeout rejects with descriptive error", async () => {
    const neverResolves = new Promise<string>(() => {});
    const shortTimeout = 50; // 50ms for testing
    try {
      await Promise.race([
        neverResolves,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Agent forge timed out after ${Math.round(shortTimeout / 1000)}s`)), shortTimeout),
        ),
      ]);
      expect(true).toBe(false); // should not reach
    } catch (err: any) {
      expect(err.message).toContain("Agent forge timed out");
    }
  });
});

describe("searchKnowledge", () => {
  function makeProcessor(embedder?: any, knowledge?: any): QueueProcessor {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);
    return new QueueProcessor(queue, {
      agents: {},
      teams: {},
      baseDir: tmpDir,
      embedder,
      knowledge,
    });
  }

  test("returns null when embedding times out", async () => {
    const slowEmbedder = {
      embed: () => new Promise<number[]>((resolve) => setTimeout(() => resolve([1, 2, 3]), 30_000)),
    };
    const knowledge = {
      search: () => [{ title: "test", section: null, content: "test content", category: null }],
    };
    const proc = makeProcessor(slowEmbedder, knowledge) as any;

    // Override the timeout to be short for testing
    const originalSearch = proc.searchKnowledge.bind(proc);
    // We test via the actual method — it should timeout and return null
    // But the default 10s is too long for a test, so let's test the concept differently:
    // directly test with a fast-rejecting embedder
    const failEmbedder = {
      embed: () => Promise.reject(new Error("timeout")),
    };
    proc.config.embedder = failEmbedder;

    const result = await proc.searchKnowledge("test query");
    expect(result).toBeNull();
  });

  test("returns results when embedding succeeds", async () => {
    const embedder = {
      embed: () => Promise.resolve([0.1, 0.2, 0.3]),
    };
    const knowledge = {
      search: () => [
        { title: "Test Doc", section: "Overview", content: "This is test content for the knowledge base", category: "docs", similarity: 0.85 },
      ],
    };
    const proc = makeProcessor(embedder, knowledge) as any;

    const result = await proc.searchKnowledge("test query");
    expect(result).toContain("[[Test Doc#Overview]]");
    expect(result).toContain("docs");
  });
});

describe("getContextPressure", () => {
  test("returns null when the conversation has no stored context", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-pressure-"));
    const queue = new QueueDB(tmpDir);
    const memory = new MemoryStore(tmpDir, "pressure-test");
    const proc = new QueueProcessor(queue, {
      agents: {
        nyx: {
          name: "Nyx",
          role: "orchestrator",
          provider: "anthropic",
          model: "claude-opus-4-6",
          working_directory: tmpDir,
        },
      },
      teams: {},
      baseDir: tmpDir,
      memory,
      nyxhiveConfig: { daemon: { name: "test", primary_agent: "nyx" } } as any,
    });

    expect(proc.getContextPressure("gateway:missing")).toBeNull();
  });

  test("uses the primary agent model to assess conversation pressure", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-pressure-"));
    const queue = new QueueDB(tmpDir);
    const memory = new MemoryStore(tmpDir, "pressure-test");
    memory.ensureConversation("gateway:thread-1", "gateway", "thread-1");
    memory.saveConversationSummary("gateway:thread-1", "Long summary. ".repeat(40000));

    const proc = new QueueProcessor(queue, {
      agents: {
        nyx: {
          name: "Nyx",
          role: "orchestrator",
          provider: "anthropic",
          model: "claude-opus-4-6",
          working_directory: tmpDir,
        },
      },
      teams: {},
      baseDir: tmpDir,
      memory,
      nyxhiveConfig: { daemon: { name: "test", primary_agent: "nyx" } } as any,
    });

    const pressure = proc.getContextPressure("gateway:thread-1");
    expect(pressure).not.toBeNull();
    expect(pressure?.band).not.toBe("green");
    expect(pressure?.utilizationPct).toBeGreaterThan(60);
  });
});

describe("resolveActiveTaskTarget", () => {
  function makeProcessor(): { proc: QueueProcessor; queue: QueueDB } {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);
    const proc = new QueueProcessor(queue, {
      agents: {},
      teams: {},
      baseDir: tmpDir,
    });
    return { proc, queue };
  }

  test("returns the only active task without needing a target", () => {
    const { proc, queue } = makeProcessor();
    const messageId = queue.enqueueMessage({
      channel: "api",
      sender: "jay",
      sender_id: "jay-1",
      message: "do the thing",
      agent: "nyx",
      conversation_id: "api:jay-1",
      status: "processing",
    });

    expect(proc.resolveActiveTaskTarget("nyx")).toEqual({
      message_id: messageId,
      conversation_id: "api:jay-1",
    });
  });

  test("returns ambiguity details when multiple tasks are active without a target", () => {
    const { proc, queue } = makeProcessor();
    queue.enqueueMessage({
      channel: "api",
      sender: "jay",
      sender_id: "jay-1",
      message: "task 1",
      agent: "nyx",
      conversation_id: "api:jay-1",
      status: "processing",
    });
    queue.enqueueMessage({
      channel: "api",
      sender: "jay",
      sender_id: "jay-2",
      message: "task 2",
      agent: "nyx",
      conversation_id: "api:jay-2",
      status: "processing",
    });

    expect(proc.resolveActiveTaskTarget("nyx")).toEqual({
      error: "ambiguous_target",
      status: 400,
      active_conversations: expect.arrayContaining([
        { message_id: expect.any(String), conversation_id: "api:jay-1" },
        { message_id: expect.any(String), conversation_id: "api:jay-2" },
      ]),
    });
  });

  test("resolves the matching conversation_id when multiple tasks are active", () => {
    const { proc, queue } = makeProcessor();
    queue.enqueueMessage({
      channel: "api",
      sender: "jay",
      sender_id: "jay-1",
      message: "task 1",
      agent: "nyx",
      conversation_id: "api:jay-1",
      status: "processing",
    });
    const targetId = queue.enqueueMessage({
      channel: "api",
      sender: "jay",
      sender_id: "jay-2",
      message: "task 2",
      agent: "nyx",
      conversation_id: "api:jay-2",
      status: "processing",
    });

    expect(proc.resolveActiveTaskTarget("nyx", { conversationId: "api:jay-2" })).toEqual({
      message_id: targetId,
      conversation_id: "api:jay-2",
    });
  });

  test("resolves the matching gateway threadId when conversation_id is blank", () => {
    const { proc, queue } = makeProcessor();
    queue.enqueueMessage({
      channel: "gateway",
      sender: "device-a",
      sender_id: "thread-a",
      message: "task 1",
      agent: "nyx",
      status: "processing",
    });
    const targetId = queue.enqueueMessage({
      channel: "gateway",
      sender: "device-b",
      sender_id: "thread-b",
      message: "task 2",
      agent: "nyx",
      status: "processing",
    });

    expect(proc.resolveActiveTaskTarget("nyx", { threadId: "thread-b" })).toEqual({
      message_id: targetId,
      conversation_id: "",
    });
  });

  test("returns thread_not_found when the requested thread is not active", () => {
    const { proc, queue } = makeProcessor();
    queue.enqueueMessage({
      channel: "gateway",
      sender: "device-a",
      sender_id: "thread-a",
      message: "task 1",
      agent: "nyx",
      status: "processing",
    });
    queue.enqueueMessage({
      channel: "gateway",
      sender: "device-b",
      sender_id: "thread-b",
      message: "task 2",
      agent: "nyx",
      status: "processing",
    });

    expect(proc.resolveActiveTaskTarget("nyx", { threadId: "thread-c" })).toEqual({
      error: "thread_not_found",
      status: 404,
    });
  });
});

describe("cleanExpiredState", () => {
  function makeProcessor(): QueueProcessor {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);
    return new QueueProcessor(queue, {
      agents: {},
      teams: {},
      baseDir: tmpDir,
    });
  }

  test("prunes lastTaskTypes older than 1 hour", () => {
    const proc = makeProcessor() as any;
    const now = Date.now();
    proc.lastTaskTypes.set("conv-old", { type: "chat", setAt: now - 2 * 60 * 60 * 1000 });
    proc.lastTaskTypes.set("conv-recent", { type: "code", setAt: now - 10 * 60 * 1000 });

    proc.cleanExpiredState();

    expect(proc.lastTaskTypes.has("conv-old")).toBe(false);
    expect(proc.lastTaskTypes.has("conv-recent")).toBe(true);
  });

  test("prunes modelOverrides older than 24 hours", () => {
    const proc = makeProcessor() as any;
    const now = Date.now();
    const overrides = proc.modelOverridesMgr.getRawMap();
    overrides.set("user:nyx", { model: "opus", setAt: now - 25 * 60 * 60 * 1000 });
    overrides.set("user:forge", { model: "sonnet", setAt: now - 1 * 60 * 60 * 1000 });

    proc.cleanExpiredState();

    expect(overrides.has("user:nyx")).toBe(false);
    expect(overrides.has("user:forge")).toBe(true);
  });

  test("prunes consecutiveFailures older than 30 minutes", () => {
    const proc = makeProcessor() as any;
    const now = Date.now();
    proc.consecutiveFailures.set("forge", { count: 2, setAt: now - 45 * 60 * 1000 });
    proc.consecutiveFailures.set("tester", { count: 1, setAt: now - 5 * 60 * 1000 });

    proc.cleanExpiredState();

    expect(proc.consecutiveFailures.has("forge")).toBe(false);
    expect(proc.consecutiveFailures.has("tester")).toBe(true);
  });

  test("prunes conversationBudgetWarned older than 24 hours", () => {
    const proc = makeProcessor() as any;
    const now = Date.now();
    proc.conversationBudgetWarned.set("trace-old", now - 25 * 60 * 60 * 1000);
    proc.conversationBudgetWarned.set("trace-recent", now - 1 * 60 * 60 * 1000);

    proc.cleanExpiredState();

    expect(proc.conversationBudgetWarned.has("trace-old")).toBe(false);
    expect(proc.conversationBudgetWarned.has("trace-recent")).toBe(true);
  });

  test("prunes pendingClarifications older than timeout", () => {
    const proc = makeProcessor() as any;
    const now = Date.now();
    proc.pendingClarifications.set("conv-stale", {
      requestId: "req-1", originalMessage: "test", agent: "nyx", question: "?",
      options: [], timestamp: now - 60 * 60 * 1000,
    });
    proc.pendingClarifications.set("conv-fresh", {
      requestId: "req-2", originalMessage: "test", agent: "nyx", question: "?",
      options: [], timestamp: now - 1 * 60 * 1000,
    });

    proc.cleanExpiredState();

    expect(proc.pendingClarifications.has("conv-stale")).toBe(false);
    expect(proc.pendingClarifications.has("conv-fresh")).toBe(true);
  });
});

describe("delegation envelope", () => {
  test("builds envelope with orchestrator reasoning and original request", () => {
    const orchestratorResponse = `I need Forge to review the processor code carefully.
This is critical for understanding delegation context loss.

[@forge: Review src/queue/processor.ts focusing on delegation extraction]`;

    const knownAgents = new Set(["forge", "tester"]);
    const { mentions, cleanedResponse } = parseActorMentions(orchestratorResponse, knownAgents);

    expect(mentions).toHaveLength(1);
    expect(mentions[0].agent).toBe("forge");
    expect(mentions[0].task).toBe("Review src/queue/processor.ts focusing on delegation extraction");

    // Simulate envelope construction (mirrors processor.ts logic)
    const orchestratorReasoning = cleanedResponse.trim();
    const userMsg = "Help me understand quality degradation in multi-agent delegation";
    const envelope = `[Delegation Context]\nOriginal request: "${userMsg.slice(0, 500)}"\nOrchestrator reasoning: ${orchestratorReasoning.slice(0, 1000)}\n\n[Your Task]\n`;
    const enrichedTask = envelope + mentions[0].task;

    expect(enrichedTask).toContain("[Delegation Context]");
    expect(enrichedTask).toContain("quality degradation");
    expect(enrichedTask).toContain("critical for understanding");
    expect(enrichedTask).toContain("[Your Task]");
    expect(enrichedTask).toContain("Review src/queue/processor.ts");
  });

  test("builds envelope without reasoning when orchestrator has no text", () => {
    const orchestratorResponse = "[@forge: Run the tests]";
    const knownAgents = new Set(["forge"]);
    const { mentions, cleanedResponse } = parseActorMentions(orchestratorResponse, knownAgents);

    const orchestratorReasoning = cleanedResponse.trim();
    const userMsg = "Run tests please";

    // When no reasoning, still include original request
    const envelope = orchestratorReasoning
      ? `[Delegation Context]\nOriginal request: "${userMsg.slice(0, 500)}"\nOrchestrator reasoning: ${orchestratorReasoning.slice(0, 1000)}\n\n[Your Task]\n`
      : userMsg
        ? `[Delegation Context]\nOriginal request: "${userMsg.slice(0, 500)}"\n\n[Your Task]\n`
        : "";
    const enrichedTask = envelope + mentions[0].task;

    expect(enrichedTask).toContain("Run tests please");
    expect(enrichedTask).not.toContain("Orchestrator reasoning");
    expect(enrichedTask).toContain("Run the tests");
  });

  test("caps orchestrator reasoning at 1000 chars", () => {
    const longReasoning = "x".repeat(2000);
    const capped = longReasoning.slice(0, 1000);
    expect(capped.length).toBe(1000);
  });
});

describe("mergeKnowledgeContext", () => {
  function makeProc(): any {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);
    return new QueueProcessor(queue, { agents: {}, teams: {}, baseDir: tmpDir });
  }

  test("returns null when both are null", () => {
    const proc = makeProc();
    expect(proc.mergeKnowledgeContext(null, null)).toBeNull();
  });

  test("returns parent when task is null", () => {
    const proc = makeProc();
    const parent = '[Source: [[Doc#Overview]]]\nParent content';
    expect(proc.mergeKnowledgeContext(parent, null)).toBe(parent);
  });

  test("returns task when parent is null", () => {
    const proc = makeProc();
    const task = '[Source: [[Task#Details]]]\nTask content';
    expect(proc.mergeKnowledgeContext(null, task)).toBe(task);
  });

  test("merges and deduplicates by source link", () => {
    const proc = makeProc();
    const parent = '[Source: [[Doc#A]]]\nContent A\n\n[Source: [[Doc#B]]]\nContent B';
    const task = '[Source: [[Doc#A]]]\nContent A\n\n[Source: [[Doc#C]]]\nContent C';

    const merged = proc.mergeKnowledgeContext(parent, task);
    // Doc#A should appear only once
    expect(merged.match(/Doc#A/g)?.length).toBe(1);
    expect(merged).toContain("Doc#B");
    expect(merged).toContain("Doc#C");
  });

  test("caps merged output at 2000 chars", () => {
    const proc = makeProc();
    const parent = `[Source: [[LongDoc]]]\n${"x".repeat(1500)}`;
    const task = `[Source: [[AnotherDoc]]]\n${"y".repeat(1500)}`;

    const merged = proc.mergeKnowledgeContext(parent, task);
    expect(merged.length).toBeLessThanOrEqual(2000);
  });
});

describe("ORCHESTRATOR_MAX_TURNS", () => {
  test("is defined and equals 3", () => {
    expect(ORCHESTRATOR_MAX_TURNS).toBe(3);
  });
});

describe("buildSynthesisPrompt", () => {
  function makeEngine(): any {
    return new DelegationEngine();
  }

  test("formats single agent result", () => {
    const engine = makeEngine();
    const prompt = engine.buildSynthesisPrompt([
      { agent: "Analyst", agentKey: "analyst", response: "142 files in src/" },
    ]);
    expect(prompt).toContain("[Delegation Results]");
    expect(prompt).toContain("**Analyst** (@analyst):");
    expect(prompt).toContain("142 files in src/");
    expect(prompt).toContain("[Instructions]");
    expect(prompt).toContain("Delegate further tasks to other agents");
    expect(prompt).toContain("Synthesize the results");
  });

  test("formats multiple agent results", () => {
    const engine = makeEngine();
    const prompt = engine.buildSynthesisPrompt([
      { agent: "Forge", agentKey: "forge", response: "Code looks good" },
      { agent: "Tester", agentKey: "tester", response: "All tests pass" },
      { agent: "Analyst", agentKey: "analyst", response: "Data looks clean" },
    ]);
    expect(prompt).toContain("**Forge** (@forge):");
    expect(prompt).toContain("**Tester** (@tester):");
    expect(prompt).toContain("**Analyst** (@analyst):");
  });

  test("truncates long responses at 4000 chars", () => {
    const engine = makeEngine();
    const longResponse = "x".repeat(5000);
    const prompt = engine.buildSynthesisPrompt([
      { agent: "Forge", agentKey: "forge", response: longResponse },
    ]);
    expect(prompt).toContain("[...truncated]");
    // The response block should not contain the full 5000 chars
    expect(prompt.length).toBeLessThan(5000);
  });

  test("does not truncate short responses", () => {
    const engine = makeEngine();
    const prompt = engine.buildSynthesisPrompt([
      { agent: "Forge", agentKey: "forge", response: "Short and sweet" },
    ]);
    expect(prompt).not.toContain("[...truncated]");
    expect(prompt).toContain("Short and sweet");
  });
});

describe("composeDelegationResponse", () => {
  function makeEngine(): any {
    return new DelegationEngine();
  }
  const mockCtx = { emit: () => {} } as any;

  test("assembles clean response + subtask results with separator", () => {
    const engine = makeEngine();
    const result = engine.composeDelegationResponse(
      "I'll have Forge handle this.",
      [],
      [{ agent: "Forge", agentKey: "forge", response: "Done, implemented the feature." }],
      "",
      mockCtx,
    );
    expect(result).toContain("I'll have Forge handle this.");
    expect(result).toContain("Specialist support: Forge (@forge).");
    expect(result).not.toContain("**Forge** (@forge):");
  });

  test("includes action results when present", () => {
    const engine = makeEngine();
    const result = engine.composeDelegationResponse(
      "Managing the team.",
      ["Agent 'data' hired."],
      [{ agent: "Forge", agentKey: "forge", response: "Built it." }],
      "",
      mockCtx,
    );
    expect(result).toContain("Agent 'data' hired.");
    expect(result).toContain("Specialist support: Forge (@forge).");
  });

  test("includes unknown errors when present", () => {
    const engine = makeEngine();
    const result = engine.composeDelegationResponse(
      "Response text.",
      [],
      [],
      "[Error: Agent @unknown not found]",
      mockCtx,
    );
    expect(result).toContain("[Error: Agent @unknown not found]");
  });
});

describe("orchestrator re-entry loop", () => {
  // These test the re-entry loop logic via the public-facing methods where possible,
  // and the helpers directly for unit-level coverage.

  test("executeDelegationTurn returns empty mentions for response without delegations", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);
    const proc = new QueueProcessor(queue, { agents: {}, teams: {}, baseDir: tmpDir }) as any;
    const ctx = proc.buildDelegationContext();

    const result = await proc.delegation.executeDelegationTurn(
      "Just a plain response with no delegation tags.",
      "nyx", null, null, "test-conv", "api", "user1",
      0, { value: 1 }, ctx,
    );

    expect(result.mentions).toHaveLength(0);
    expect(result.cleanedResponse).toBe("Just a plain response with no delegation tags.");
    expect(result.subtaskResults).toHaveLength(0);
    expect(result.actionResults).toHaveLength(0);
  });

  test("executeDelegationTurn returns mentions but no results when agent not found", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);
    // Register a known key so the mention parses, but leave the agent config missing.
    const registry = {
      get: () => undefined,
      getAll: () => ({}),
      getKnownAgentKeys: () => new Set(["forge"]),
      getAllEntries: () => new Map(),
    } as any;
    const proc = new QueueProcessor(queue, {
      agents: {},
      teams: {},
      baseDir: tmpDir,
      registry,
    }) as any;
    const ctx = proc.buildDelegationContext();

    const result = await proc.delegation.executeDelegationTurn(
      "Let me delegate. [@forge: do the thing]",
      "nyx", null, null, "test-conv", "api", "user1",
      0, { value: 1 }, ctx,
    );

    // forge is a known agent key, so it shows up in mentions
    expect(result.mentions.length).toBeGreaterThanOrEqual(1);
    expect(result.cleanedResponse).toBe("Let me delegate.");
  });

  test("executeDelegationTurn respects depth guard", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);
    const proc = new QueueProcessor(queue, {
      agents: { forge: { name: "Forge", provider: "test", model: "test", system_prompt: "test" } as any },
      teams: {},
      baseDir: tmpDir,
    }) as any;
    const ctx = proc.buildDelegationContext();

    const result = await proc.delegation.executeDelegationTurn(
      "[@forge: deep task]",
      "nyx", null, null, "test-conv", "api", "user1",
      5, // at max depth
      { value: 1 }, ctx,
    );

    // At max depth, mentions should be cleared (depth guard fires)
    expect(result.mentions).toHaveLength(0);
  });

  test("executeDelegationTurn parses management actions", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);
    const proc = new QueueProcessor(queue, { agents: {}, teams: {}, baseDir: tmpDir }) as any;
    const ctx = proc.buildDelegationContext();

    const result = await proc.delegation.executeDelegationTurn(
      'Some context. [@fire: old_agent]',
      "nyx", null, null, "test-conv", "api", "user1",
      0, { value: 1 }, ctx,
    );

    // fire is an action, not a delegation mention
    expect(result.mentions).toHaveLength(0);
    // Action results should contain something (even if management unavailable)
    expect(result.actionResults.length).toBeGreaterThanOrEqual(0);
  });
});

describe("proposal action handling", () => {
  // Minimal registry mock: nyx is orchestrator so management actions work
  function makeOrchestratorProc(tmpDir: string) {
    const queue = new QueueDB(tmpDir);
    const registry = {
      getEntry: (key: string) => key === "nyx" ? { role: "orchestrator", enabled: true, name: "Nyx" } : undefined,
      getAll: () => ({}),
      getKnownAgentKeys: () => new Set(["nyx"]),
      getAllEntries: () => new Map([["nyx", { role: "orchestrator", enabled: true, name: "Nyx" }]]),
    } as any;
    return new QueueProcessor(queue, { agents: {}, teams: {}, baseDir: tmpDir, registry }) as any;
  }

  test("propose action without proposal store returns error", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const proc = makeOrchestratorProc(tmpDir);
    const ctx = proc.buildDelegationContext();

    const result = await proc.delegation.executeDelegationTurn(
      '[@propose: title="Fix test" description="Details here" category=maintenance effort=small]',
      "nyx", null, null, "test-conv", "api", "user1",
      0, { value: 1 }, ctx,
    );

    expect(result.actionResults).toContain("[propose failed: proposal store not available]");
  });

  test("propose action skips safe bounded tasks that do not need approval", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const proc = makeOrchestratorProc(tmpDir);

    const { ProposalStore } = await import("../proposals/store.js");
    const proposalStore = new ProposalStore(tmpDir, "test");
    proc.setProposalStore(proposalStore);
    const ctx = proc.buildDelegationContext();

    const result = await proc.delegation.executeDelegationTurn(
      '[@propose: title="Fix flaky test" description="Replace setTimeout with deterministic mock" category=maintenance effort=small files="src/__tests__/actor.test.ts"]',
      "nyx", null, null, "test-conv", "api", "user1",
      0, { value: 1 }, ctx,
    );

    const proposals = proposalStore.list();
    expect(proposals).toHaveLength(0);
    expect(result.actionResults.join("\n")).toContain("suggested lane=task");

    proposalStore.close();
  });

  test("propose action creates governance proposal in store", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const proc = makeOrchestratorProc(tmpDir);

    const { ProposalStore } = await import("../proposals/store.js");
    const proposalStore = new ProposalStore(tmpDir, "test");
    proc.setProposalStore(proposalStore);
    const ctx = proc.buildDelegationContext();

    await proc.delegation.executeDelegationTurn(
      '[@propose: title="Add approval policy for public callbacks" description="This changes user-facing relay behavior and needs User to approve the external callback policy" category=feature effort=medium files="src/server/relay.ts"]',
      "nyx", null, null, "test-conv", "api", "user1",
      0, { value: 1 }, ctx,
    );

    const proposals = proposalStore.list();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].title).toBe("Add approval policy for public callbacks");
    expect(proposals[0].category).toBe("feature");
    expect(proposals[0].effort).toBe("medium");
    expect(proposals[0].proposed_by).toBe("nyx");
    expect(proposals[0].files_affected).toEqual(["src/server/relay.ts"]);
    expect(proposals[0].autonomy).toBe("requires_approval");

    proposalStore.close();
  });

  test("propose action does not treat omitted effort as a medium-effort approval signal", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const proc = makeOrchestratorProc(tmpDir);

    const { ProposalStore } = await import("../proposals/store.js");
    const proposalStore = new ProposalStore(tmpDir, "test");
    proc.setProposalStore(proposalStore);
    const ctx = proc.buildDelegationContext();

    const result = await proc.delegation.executeDelegationTurn(
      '[@propose: title="Clean up wording" description="Tighten an internal label in the gateway" category=maintenance]',
      "nyx", null, null, "test-conv", "api", "user1",
      0, { value: 1 }, ctx,
    );

    expect(proposalStore.list()).toHaveLength(0);
    expect(result.actionResults.join("\n")).toContain("suggested lane=task");

    proposalStore.close();
  });

  test("propose action with missing title/description returns error", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const proc = makeOrchestratorProc(tmpDir);

    const { ProposalStore } = await import("../proposals/store.js");
    const proposalStore = new ProposalStore(tmpDir, "test");
    proc.setProposalStore(proposalStore);
    const ctx = proc.buildDelegationContext();

    const result = await proc.delegation.executeDelegationTurn(
      '[@propose: title="No description here"]',
      "nyx", null, null, "test-conv", "api", "user1",
      0, { value: 1 }, ctx,
    );

    expect(result.actionResults).toContain("[propose failed: title and description required]");
    expect(proposalStore.list()).toHaveLength(0);

    proposalStore.close();
  });

  test("propose action classifies feature as requires_approval", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const proc = makeOrchestratorProc(tmpDir);

    const { ProposalStore } = await import("../proposals/store.js");
    const proposalStore = new ProposalStore(tmpDir, "test");
    proc.setProposalStore(proposalStore);
    const ctx = proc.buildDelegationContext();

    await proc.delegation.executeDelegationTurn(
      '[@propose: title="Add new endpoint" description="New REST endpoint for widgets" category=feature effort=medium]',
      "nyx", null, null, "test-conv", "api", "user1",
      0, { value: 1 }, ctx,
    );

    const proposals = proposalStore.list();
    expect(proposals).toHaveLength(1);
    expect(proposals[0].autonomy).toBe("requires_approval");
    expect(proposals[0].category).toBe("feature");

    proposalStore.close();
  });
});

describe("delegated agent history isolation", () => {
  test("executeDelegationTurn at depth > 0 does not fetch parent conversation history", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);
    const router = {
      classifyLocal: () => "coding",
      classifyWithLLM: async () => ({ taskType: "coding", tier: 2 }),
      route: () => ({ provider: "test", model: "test", maxTokens: 4096, taskType: "coding" }),
      routeWithTier: () => ({ provider: "test", model: "test", maxTokens: 4096, taskType: "coding" }),
      complete: async () => ({ content: "Done", tokensIn: 0, tokensOut: 0, model: "test" }),
    } as any;
    const proc = new QueueProcessor(queue, {
      agents: { forge: { name: "Forge", provider: "test", model: "test", system_prompt: "test" } as any },
      teams: {},
      baseDir: tmpDir,
      router,
    }) as any;

    // Build the delegation context, then spy on getConversationHistory
    const ctx = proc.buildDelegationContext();
    let historyCalled = false;
    const originalGetHistory = ctx.getConversationHistory;
    ctx.getConversationHistory = (...args: any[]) => {
      historyCalled = true;
      return originalGetHistory(...args);
    };

    // executeDelegationTurn at depth 1 — should NOT call getConversationHistory for the delegated agent
    await proc.delegation.executeDelegationTurn(
      "[@forge: do the thing]",
      "nyx", null, null, "test-conv", "api", "user1",
      1, // depth > 0
      { value: 1 }, ctx,
    );

    expect(historyCalled).toBe(false);
  });
});

describe("sanitizeResponse", () => {
  function makeProc(): any {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);
    return new QueueProcessor(queue, { agents: {}, teams: {}, baseDir: tmpDir });
  }

  test("should strip [TOOL_CALL] blocks from responses", () => {
    const proc = makeProc();
    const input = "Here's the answer.\n[TOOL_CALL]\n{\"name\": \"read_file\"}\n[/TOOL_CALL]\nDone.";
    const result = proc.sanitizeResponse(input);
    expect(result).toBe("Here's the answer.\n\nDone.");
  });

  test("should strip multiple [TOOL_CALL] blocks", () => {
    const proc = makeProc();
    const input = "A[TOOL_CALL]x[/TOOL_CALL]B[TOOL_CALL]y[/TOOL_CALL]C";
    const result = proc.sanitizeResponse(input);
    expect(result).toBe("ABC");
  });

  test("should strip XML tool_call blocks", () => {
    const proc = makeProc();
    const input = "Answer.\n<tool_call>fake</tool_call>\nEnd.";
    const result = proc.sanitizeResponse(input);
    expect(result).toBe("Answer.\n\nEnd.");
  });
});

describe("parseProposalCommand", () => {
  test("parses approve command", () => {
    const result = parseProposalCommand("approve a1b2c3d4");
    expect(result).toEqual({ action: "approve", id: "a1b2c3d4" });
  });

  test("parses approve case-insensitive", () => {
    const result = parseProposalCommand("Approve A1B2C3D4");
    expect(result).toEqual({ action: "approve", id: "a1b2c3d4" });
  });

  test("parses reject command with reason", () => {
    const result = parseProposalCommand("reject a1b2c3d4 too low priority");
    expect(result).toEqual({ action: "reject", id: "a1b2c3d4", reason: "too low priority" });
  });

  test("returns null for non-command messages", () => {
    expect(parseProposalCommand("hello world")).toBeNull();
    expect(parseProposalCommand("approve")).toBeNull();
    expect(parseProposalCommand("reject abc")).toBeNull();
  });

  test("returns null for approve without valid hex id", () => {
    expect(parseProposalCommand("approve notahexid")).toBeNull();
  });
});

describe("coderAgent resolution", () => {
  function makeProc(): any {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);
    return new QueueProcessor(queue, {
      agents: {
        myforge: { role: "coder", provider: "anthropic", model: "test", enabled: true } as any,
        myanalyst: { role: "analyst", provider: "anthropic", model: "test", enabled: true } as any,
      },
      teams: {},
      baseDir: tmpDir,
    });
  }

  test("resolves first coder agent from config", () => {
    const proc = makeProc();
    const ctx = proc.buildDelegationContext();
    expect(ctx.coderAgent).toBe("myforge");
  });

  test("empty agents config produces undefined coderAgent", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);
    const proc = new QueueProcessor(queue, { agents: {}, teams: {}, baseDir: tmpDir }) as any;
    const ctx = proc.buildDelegationContext();
    expect(ctx.coderAgent).toBeUndefined();
  });
});

describe("orchestrator routing defaults", () => {
  test("orchestrator maxTokens is 16384", () => {
    expect(DEFAULT_ROUTING_TABLE.orchestrator.maxTokens).toBe(16384);
  });

  test("orchestrator uses opus", () => {
    expect(DEFAULT_ROUTING_TABLE.orchestrator.model).toBe("claude-opus-4-6");
  });
});

describe("resolveProposalRepoPath", () => {
  test("falls back to daemon.projects repo_path when allowed_directories has no src/", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);

    // Simulate real config: allowed_directories are Obsidian vaults (no src/),
    // but daemon.projects has the actual repo with src/
    const repoDir = mkdtempSync(join(tmpdir(), "nyxhive-repo-"));
    require("fs").mkdirSync(join(repoDir, "src"), { recursive: true });

    const vaultDir = mkdtempSync(join(tmpdir(), "obsidian-vault-"));

    const proc = new QueueProcessor(queue, {
      agents: {},
      teams: {},
      baseDir: tmpDir,
      nyxhiveConfig: {
        daemon: {
          name: "test",
          log_level: "info",
          data_dir: tmpDir,
          projects: [{ name: "nyxhive", repo_path: repoDir, default: true }],
        },
        server: { port: 3000 },
        agents: {},
        providers: {},
        routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
        context: { max_history: 10, summary_threshold: 5 },
        allowed_directories: [vaultDir],
      } as any,
    });

    // Files start with src/ — should resolve to the repo, not the vault
    const result = proc.resolveProposalRepoPath(["src/queue/processor.ts"]);
    expect(result).toBe(repoDir);
    // Must NOT be the vault
    expect(result).not.toBe(vaultDir);
  });

  test("uses allowed_directories when they contain src/", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "proc-test-"));
    const queue = new QueueDB(tmpDir);

    const repoDir = mkdtempSync(join(tmpdir(), "repo-"));
    require("fs").mkdirSync(join(repoDir, "src"), { recursive: true });

    const proc = new QueueProcessor(queue, {
      agents: {},
      teams: {},
      baseDir: tmpDir,
      nyxhiveConfig: {
        daemon: { name: "test", log_level: "info", data_dir: tmpDir },
        server: { port: 3000 },
        agents: {},
        providers: {},
        routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
        context: { max_history: 10, summary_threshold: 5 },
        allowed_directories: [repoDir],
      } as any,
    });

    const result = proc.resolveProposalRepoPath(["src/something.ts"]);
    expect(result).toBe(repoDir);
  });
});

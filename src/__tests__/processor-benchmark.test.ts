import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProposalStore } from "../proposals/store.js";
import { QueueProcessor } from "../queue/processor.js";
import { QueueDB } from "../queue/db.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("processImmediate benchmark mode", () => {
  let tmpDir: string;
  let queue: QueueDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "processor-benchmark-test-"));
    queue = new QueueDB(tmpDir);
  });

  afterEach(() => {
    queue.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRouter(response = "benchmark reply") {
    return {
      classifyLocal: () => "conversation",
      route: () => ({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        taskType: "conversation",
        maxTokens: 256,
      }),
      routeWithTier: () => ({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        taskType: "conversation",
        maxTokens: 256,
      }),
      complete: mock(async () => ({
        content: response,
        model: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        tokensIn: 12,
        tokensOut: 8,
      })),
    } as any;
  }

  test("avoids queue, trace, and global activity side effects", async () => {
    const gate = deferred<void>();
    const router = {
      ...createRouter(),
      complete: mock(async () => {
        await gate.promise;
        return {
          content: "benchmark reply",
          model: "claude-haiku-4-5-20251001",
          provider: "anthropic",
          tokensIn: 12,
          tokensOut: 8,
        };
      }),
    } as any;
    const traces = {
      startTrace: mock(() => "trace-1"),
      startEvent: mock(() => 42),
      completeEvent: mock(() => {}),
      completeTrace: mock(() => {}),
      failTrace: mock(() => {}),
    };
    const processor = new QueueProcessor(queue, {
      agents: {
        nyx: {
          name: "nyx",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: tmpDir,
        },
      },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router,
      traces: traces as any,
    });

    const globalEvents: string[] = [];
    const directEvents: string[] = [];
    const unsubscribe = processor.getPublicAPI().onEvent((type) => globalEvents.push(type));

    const run = processor.processImmediate({
      channel: "api",
      sender: "benchmark",
      sender_id: "bench-user",
      message: "benchmark run",
      benchmark: true,
      onEvent: (event) => directEvents.push(event.type),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(processor.getPublicAPI().getStatus().activeProcesses).toBe(0);
    expect(queue.getQueueStats()).toEqual({
      pending: 0,
      processing: 0,
      suspended: 0,
      completed: 0,
      failed: 0,
      dead_letter: 0,
    });
    expect(globalEvents).toEqual([]);
    expect(traces.startTrace).not.toHaveBeenCalled();
    expect(traces.startEvent).not.toHaveBeenCalled();

    gate.resolve();
    const result = await run;
    unsubscribe();

    expect(result.response).toBe("benchmark reply");
    expect(result.trace_id).toBeUndefined();
    expect(queue.getMessageByMessageId(result.message_id)).toBeNull();
    expect(queue.getResponseByMessageId(result.message_id)).toBeNull();
    expect(globalEvents).toEqual([]);
    expect(directEvents).toEqual([
      "context:metrics",
      "routing",
      "response:start",
      "agent:progress",
      "agent:progress",
      "response:complete",
    ]);
    expect(traces.completeTrace).not.toHaveBeenCalled();
    expect((processor as any).activeProcesses.size).toBe(0);
  });

  test("skips live command handlers in benchmark mode", async () => {
    let handled = 0;
    const processor = new QueueProcessor(queue, {
      agents: {
        nyx: {
          name: "nyx",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: tmpDir,
        },
      },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router: createRouter(),
      commands: [
        {
          name: "mutating-command",
          pattern: "mutate state",
          description: "Mutates state when run",
          handler: async () => {
            handled += 1;
            return { handled: true, response: "command handled" };
          },
        },
      ],
    });

    const result = await processor.processImmediate({
      channel: "api",
      sender: "benchmark",
      sender_id: "bench-user",
      message: "mutate state",
      benchmark: true,
    });

    expect(handled).toBe(0);
    expect(result.response).toBe("benchmark reply");
    expect(result.agent).toBe("nyx");
  });

  test("enqueues a visible error response when immediate processing fails", async () => {
    const processor = new QueueProcessor(queue, {
      agents: {
        nyx: {
          name: "nyx",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: tmpDir,
        },
      },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router: createRouter("Using superpowers:using-superpowers. I’ll inspect first, then answer."),
    });

    const result = await processor.processImmediate({
      channel: "session:test-thread",
      sender: "User",
      sender_id: "jay",
      message: "hello?",
    });

    expect(result.response).toContain("I wasn't able to process your request.");

    const responses = queue.getPendingResponses();
    expect(responses).toHaveLength(1);
    expect(responses[0].message).toContain("I wasn't able to process your request.");
    expect(responses[0].original_message).toBe("hello?");
  });

  test("skips proposal approval side effects in benchmark mode", async () => {
    const proposalStore = new ProposalStore(tmpDir, "test");
    const executor = { onApproved: mock(async () => {}) };
    const processor = new QueueProcessor(queue, {
      agents: {
        nyx: {
          name: "nyx",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: tmpDir,
        },
      },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router: createRouter(),
    });
    processor.setProposalStore(proposalStore);
    processor.setProposalExecutor(executor as any);

    const proposal = proposalStore.create({
      title: "Benchmark safety",
      description: "Keep benchmark mode read-only",
      category: "bugfix",
      proposed_by: "nyx",
    });

    const result = await processor.processImmediate({
      channel: "system",
      sender: "proposal-system",
      message: `approve ${proposal.proposal_id.slice("proposal-".length)}`,
      benchmark: true,
      trust: "system",
    });

    expect(result.response).toBe("benchmark reply");
    expect(result.agent).toBe("nyx");
    expect(proposalStore.get(proposal.proposal_id)?.status).toBe("proposed");
    expect(executor.onApproved).not.toHaveBeenCalled();

    proposalStore.close();
  });

  test("forces public Discord viewer turns into conversation classification", async () => {
    let routedTaskType = "";
    let systemPrompt = "";
    const router = {
      classifyLocal: mock(() => "expert"),
      classifyWithLLM: mock(async () => ({ taskType: "coding", tier: 4 })),
      route: mock((taskType: string) => ({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        taskType,
        maxTokens: 256,
      })),
      routeWithTier: mock((classification: { taskType: string; tier: number }) => {
        routedTaskType = classification.taskType;
        return {
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          taskType: classification.taskType,
          maxTokens: 256,
        };
      }),
      complete: mock(async (params: { system?: string }) => {
        systemPrompt = params.system ?? "";
        return {
          content: "public chat reply",
          model: "claude-haiku-4-5-20251001",
          provider: "anthropic",
          tokensIn: 12,
          tokensOut: 8,
        };
      }),
    } as any;
    const processor = new QueueProcessor(queue, {
      agents: {
        vortex: {
          name: "Vortex",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: tmpDir,
          system_prompt: "Base Vortex prompt.",
          capabilities: ["tool_use"],
        },
      },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "vortex",
      router,
    });

    const result = await processor.processImmediate({
      channel: "discord",
      channel_name: "gen-chat",
      sender: "Trapshot",
      sender_id: "channel:guild:1458234292457963622",
      sender_role: "viewer",
      message: "make it secure but funny",
      benchmark: true,
    });

    expect(result.response).toBe("public chat reply");
    expect(result.agent).toBe("vortex");
    expect(routedTaskType).toBe("conversation");
    expect(router.classifyLocal).not.toHaveBeenCalled();
    expect(router.classifyWithLLM).not.toHaveBeenCalled();
    expect(systemPrompt).toContain("[Public Discord mode]");
    expect(systemPrompt).toContain("overrides normal execution, closeout, and tool-use rules");
    expect(systemPrompt.indexOf("[Public Discord mode]")).toBeGreaterThan(systemPrompt.indexOf("Base Vortex prompt."));
  });
});

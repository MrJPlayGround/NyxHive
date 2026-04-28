import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueDB } from "../queue/db.js";
import { QueueProcessor } from "../queue/processor.js";
import type { AgentKernelRuntime, KernelEvent, KernelRequest } from "../kernel/index.js";
import type { AgentConfig, NyxHiveConfig } from "../types.js";

class FakeKernelRuntime implements AgentKernelRuntime {
  readonly requests: KernelRequest[] = [];

  constructor(private readonly events: KernelEvent[]) {}

  async *stream(request: KernelRequest): AsyncIterable<KernelEvent> {
    this.requests.push(request);
    for (const event of this.events) {
      yield event;
    }
  }
}

function agent(name: string): AgentConfig {
  return {
    name,
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    working_directory: "/tmp/workspace",
  };
}

function router(response = "legacy reply") {
  return {
    classifyLocal: mock(() => "conversation"),
    classifyWithLLM: mock(async () => ({ taskType: "conversation", tier: 2 })),
    route: mock((taskType: string) => ({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      taskType,
      maxTokens: 256,
    })),
    routeWithTier: mock((classification: { taskType: string }) => ({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      taskType: classification.taskType,
      maxTokens: 256,
    })),
    complete: mock(async () => ({
      content: response,
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      tokensIn: 3,
      tokensOut: 4,
    })),
  } as any;
}

function config(mode?: "legacy" | "kernel"): NyxHiveConfig {
  return {
    daemon: { name: "test", log_level: "info", data_dir: "/tmp/test", primary_agent: "nyx" },
    server: { port: 3777 },
    agents: {},
    providers: {},
    routing: { classifier_model: "test", classifier_provider: "anthropic", cli_escalation_tasks: [] },
    context: { max_history: 20, summary_threshold: 20 },
    ...(mode ? { runtime: { mode } } : {}),
  } as NyxHiveConfig;
}

describe("QueueProcessor kernel runtime mode", () => {
  let tmpDir: string;
  let queue: QueueDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "processor-kernel-test-"));
    queue = new QueueDB(tmpDir);
  });

  afterEach(() => {
    queue.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("preserves legacy invocation by default", async () => {
    const kernel = new FakeKernelRuntime([
      { type: "kernel:response", response: "kernel reply", agent: "nyx", timestamp: 1 },
    ]);
    const proc = new QueueProcessor(queue, {
      agents: { nyx: agent("Nyx") },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router: router("legacy reply"),
      nyxhiveConfig: config(),
      kernelRuntime: kernel,
    } as any);

    const result = await proc.processImmediate({
      channel: "api",
      sender: "jay",
      sender_id: "jay",
      message: "hello",
      benchmark: true,
    });

    expect(result.response).toBe("legacy reply");
    expect(kernel.requests).toHaveLength(0);
  });

  test("routes unmentioned primary-agent turns through kernel when enabled", async () => {
    const kernel = new FakeKernelRuntime([
      { type: "kernel:token", text: "ker", agent: "nyx", timestamp: 1 },
      { type: "kernel:usage", model: "gpt-5.4", input_tokens: 11, output_tokens: 7, cost_cents: 3, timestamp: 2 },
      { type: "kernel:response", response: "kernel reply", agent: "nyx", message_id: "from-kernel", timestamp: 3 },
    ]);
    const events: string[] = [];
    const proc = new QueueProcessor(queue, {
      agents: { nyx: agent("Nyx"), tester: agent("Tester") },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router: router("legacy reply"),
      nyxhiveConfig: config("kernel"),
      kernelRuntime: kernel,
    } as any);

    const result = await proc.processImmediate({
      channel: "api",
      sender: "jay",
      sender_id: "jay",
      message: "hello",
      benchmark: true,
      onEvent: (event) => events.push(event.type),
    });

    expect(result.response).toBe("kernel reply");
    expect(result.agent).toBe("nyx");
    expect(result.tokens_in).toBe(11);
    expect(result.tokens_out).toBe(7);
    expect(result.cost).toBe(0.03);
    expect(kernel.requests).toHaveLength(1);
    expect(kernel.requests[0]).toMatchObject({ message: "hello", agentKey: "nyx", channel: "api", sender: "jay" });
    expect(events).toContain("token");
    expect(events).toContain("response");
  });

  test("keeps explicit agent mentions on the legacy path when kernel mode is enabled", async () => {
    const kernel = new FakeKernelRuntime([
      { type: "kernel:response", response: "kernel reply", agent: "nyx", timestamp: 1 },
    ]);
    const proc = new QueueProcessor(queue, {
      agents: { nyx: agent("Nyx"), tester: agent("Tester") },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router: router("tester legacy reply"),
      nyxhiveConfig: config("kernel"),
      kernelRuntime: kernel,
    } as any);

    const result = await proc.processImmediate({
      channel: "api",
      sender: "jay",
      sender_id: "jay",
      message: "@tester run checks",
      benchmark: true,
    });

    expect(result.response).toBe("tester legacy reply");
    expect(result.agent).toBe("tester");
    expect(kernel.requests).toHaveLength(0);
  });
});

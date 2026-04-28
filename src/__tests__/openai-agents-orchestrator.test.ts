import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { AgentConfig, InvocationResult } from "../types.js";
import type { InvokeOpts } from "../agents/invoke.js";

const createdAgents: MockAgent[] = [];
const createdTools: Array<Record<string, unknown>> = [];
const runCalls: Array<{ agent: MockAgent; input: string; options: Record<string, unknown> | undefined }> = [];

class MockAgent {
  config: Record<string, unknown>;
  name: string;

  constructor(config: Record<string, unknown>) {
    this.config = config;
    this.name = String(config.name);
    createdAgents.push(this);
  }
}

mock.module("@openai/agents", () => ({
  Agent: MockAgent,
  tool: (config: Record<string, unknown>) => {
    createdTools.push(config);
    return config;
  },
  run: async (agent: MockAgent, input: string, options?: Record<string, unknown>) => {
    runCalls.push({ agent, input, options });
    return { finalOutput: "orchestrated response", lastResponseId: "resp_123" };
  },
}));

const {
  buildCodexExecutionTool,
  createOpenAIAgentsOrchestrator,
  isAgentsSdkOrchestrationEnabled,
} = await import("../agents/orchestration/openai-agents.js");

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Nyx",
    provider: "openai",
    model: "gpt-5.4",
    working_directory: "",
    role: "lead",
    always_cli: true,
    cli_fallback: "codex",
    agentic_mode: "strict",
    capabilities: ["tool_use"],
    ...overrides,
  };
}

function makeOpts(overrides: Partial<InvokeOpts> = {}): InvokeOpts {
  return {
    baseDir: "/tmp/nyxhive-test",
    agentKey: "nyx",
    senderName: "User",
    systemPrompt: "You are Nyx.",
    ...overrides,
  };
}

function makeInvocationResult(overrides: Partial<InvocationResult> = {}): InvocationResult {
  return {
    response: "codex did the work",
    agent: "Nyx",
    method: "cli",
    task_type: "coding",
    duration_ms: 42,
    toolsUsed: ["command_execution"],
    session_id: "codex-thread-1",
    session_runtime: "codex_app_server",
    ...overrides,
  };
}

describe("OpenAI Agents SDK orchestration adapter", () => {
  beforeEach(() => {
    createdAgents.length = 0;
    createdTools.length = 0;
    runCalls.length = 0;
  });

  it("keeps Agents SDK behind an internal orchestrator boundary", async () => {
    const orchestrator = createOpenAIAgentsOrchestrator({
      specialists: [
        {
          name: "Scribe",
          instructions: "Turn runtime notes into concise documentation.",
          handoffDescription: "Use for documentation and synthesis work.",
        },
      ],
      codexExecutor: async () => makeInvocationResult(),
    });

    const result = await orchestrator.run({
      agent: makeAgent(),
      message: "coordinate this change",
      opts: makeOpts(),
      startTime: 100,
      taskType: "orchestrator",
    });

    expect(result.response).toBe("orchestrated response");
    expect(result.method).toBe("api");
    expect(runCalls).toHaveLength(1);
    expect(runCalls[0]!.input).toBe("coordinate this change");
    expect(runCalls[0]!.options?.maxTurns).toBe(6);
    expect(runCalls[0]!.options?.signal).toBeUndefined();

    const manager = runCalls[0]!.agent;
    expect(manager.config.name).toBe("NyxHive Orchestrator");
    expect((manager.config.tools as Array<Record<string, unknown>>).map((toolConfig) => toolConfig.name)).toContain("codex_execute");
    expect((manager.config.handoffs as MockAgent[]).map((agent) => agent.name)).toEqual(["Scribe"]);
  });

  it("blocks locally before model or Codex execution when a guardrail trips", async () => {
    let codexCalls = 0;
    const orchestrator = createOpenAIAgentsOrchestrator({
      inputGuardrails: [
        (request) => request.message.includes("protected")
          ? { allowed: false, reason: "protected file change requires approval" }
          : { allowed: true },
      ],
      codexExecutor: async () => {
        codexCalls += 1;
        return makeInvocationResult();
      },
    });

    const result = await orchestrator.run({
      agent: makeAgent(),
      message: "change protected auth config",
      opts: makeOpts(),
      startTime: 100,
      taskType: "orchestrator",
    });

    expect(result.response).toBe("Blocked by orchestration guardrail: protected file change requires approval");
    expect(result.method).toBe("api");
    expect(runCalls).toHaveLength(0);
    expect(codexCalls).toBe(0);
  });

  it("wraps Codex SDK as a callable execution tool", async () => {
    const calls: Array<{ message: string; taskType?: string }> = [];
    const toolConfig = buildCodexExecutionTool({
      agent: makeAgent(),
      opts: makeOpts(),
      startTime: 100,
      defaultTaskType: "orchestrator",
      codexExecutor: async (_agent, message, _opts, _startTime, taskType) => {
        calls.push({ message, taskType });
        return makeInvocationResult({ response: "patched through codex", task_type: taskType as InvocationResult["task_type"] });
      },
    }) as unknown as Record<string, (input: Record<string, unknown>) => Promise<string>>;

    const output = await toolConfig.execute({
      prompt: "edit the repo",
      taskType: "coding",
    });

    expect(calls).toEqual([{ message: "edit the repo", taskType: "coding" }]);
    expect(output).toContain("patched through codex");
    expect(output).toContain("codex_app_server");
  });

  it("defaults Agents SDK orchestration off behind config", () => {
    expect(isAgentsSdkOrchestrationEnabled(undefined)).toBe(false);
    expect(isAgentsSdkOrchestrationEnabled({ orchestration: { agents_sdk: { enabled: false } } })).toBe(false);
    expect(isAgentsSdkOrchestrationEnabled({ orchestration: { agents_sdk: { enabled: true } } })).toBe(true);
  });
});

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../types.js";
import type { InvokeOpts } from "../agents/invoke.js";

const capturedPrompts: string[] = [];
const capturedThreadOptions: Array<Record<string, unknown>> = [];
let mockFinalText = "done";

class MockThread {
  id = "codex-thread-1";

  async runStreamed(input: string): Promise<{ events: AsyncGenerator<unknown> }> {
    capturedPrompts.push(input);

    async function* events() {
      yield { type: "turn.started" };
      yield {
        type: "item.completed",
        item: { type: "agent_message", text: mockFinalText },
      };
      yield {
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 3 },
      };
    }

    return { events: events() };
  }
}

mock.module("@openai/codex-sdk", () => ({
  Codex: class MockCodex {
    startThread(options: Record<string, unknown>) {
      capturedThreadOptions.push(options);
      return new MockThread();
    }

    resumeThread(_id: string, options: Record<string, unknown>) {
      capturedThreadOptions.push(options);
      return new MockThread();
    }
  },
}));

const { invokeCodexSdk } = await import("../agents/invoke-codex-sdk.js");

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Vortex",
    provider: "openai",
    model: "gpt-5.4",
    working_directory: "",
    always_cli: true,
    cli_fallback: "codex",
    agentic_mode: "strict",
    capabilities: ["tool_use"],
    system_prompt: "You are Vortex.",
    ...overrides,
  };
}

function makeOpts(baseDir: string, overrides: Partial<InvokeOpts> = {}): InvokeOpts {
  return {
    baseDir,
    agentKey: "test-agent",
    senderName: "User",
    systemPrompt: "[Assembled System Prompt]\nVortex owns NyxLabs product judgment.",
    ...overrides,
  };
}

describe("invokeCodexSdk", () => {
  let baseDir: string;

  beforeEach(() => {
    capturedPrompts.length = 0;
    capturedThreadOptions.length = 0;
    mockFinalText = "done";
    baseDir = mkdtempSync(join(tmpdir(), "nyxhive-codex-sdk-test-"));
  });

  afterEach(() => {
    capturedPrompts.length = 0;
    capturedThreadOptions.length = 0;
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("injects the assembled system prompt into Codex SDK turns", async () => {
    await invokeCodexSdk(
      makeAgent(),
      "status check",
      makeOpts(baseDir, {
        conversationHistory: [
          { role: "user", content: "previous request" },
          { role: "assistant", content: "previous response" },
        ],
        knowledgeContext: "Remember: keep Vortex distinct from Nyx.",
      }),
      Date.now(),
      "conversation",
    );

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0]!;
    expect(prompt).toContain("[Assembled System Prompt]");
    expect(prompt).toContain("Vortex owns NyxLabs product judgment.");
    expect(prompt).toContain("[Relevant Knowledge]");
    expect(prompt).toContain("[Conversation History]");
    expect(prompt).toContain("[Current speaker]");
    expect(prompt).not.toContain("Respond as Nyx first");
  });

  it("tells Codex SDK turns not to expose skill or workflow scaffolding", async () => {
    await invokeCodexSdk(
      makeAgent(),
      "fix this and restart",
      makeOpts(baseDir),
      Date.now(),
      "coding",
    );

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0]!;
    expect(prompt).toContain("Do not announce skill/workflow activation");
    expect(prompt).toContain("Do not include progress-log dumps");
  });

  it("does not duplicate dynamic context already present in the assembled prompt", async () => {
    await invokeCodexSdk(
      makeAgent(),
      "status check",
      makeOpts(baseDir, {
        systemPrompt: [
          "[Assembled System Prompt]",
          "[Current speaker]",
          "You are speaking to User. Address them as User.",
          "[Relevant knowledge]",
          "Remember: keep Vortex distinct from Nyx.",
        ].join("\n"),
        knowledgeContext: "Remember: keep Vortex distinct from Nyx.",
      }),
      Date.now(),
      "conversation",
    );

    expect(capturedPrompts).toHaveLength(1);
    const prompt = capturedPrompts[0]!;
    expect(prompt.match(/^\[Current speaker\]/gim)).toHaveLength(1);
    expect(prompt.match(/^\[Relevant knowledge\]/gim)).toHaveLength(1);
  });

  it("defaults Codex reasoning effort from the agent role when none is set explicitly", async () => {
    await invokeCodexSdk(
      makeAgent({ role: "lead", effort: undefined }),
      "ship it",
      makeOpts(baseDir),
      Date.now(),
      "coding",
    );

    expect(capturedThreadOptions).toHaveLength(1);
    expect(capturedThreadOptions[0]?.modelReasoningEffort).toBe("high");
  });

  it("uses a workspace-write sandbox for ordinary authorized coding work", async () => {
    const result = await invokeCodexSdk(
      makeAgent({ capabilities: ["tool_use"] }),
      "fix the bug",
      makeOpts(baseDir),
      Date.now(),
      "coding",
    );

    expect(capturedThreadOptions).toHaveLength(1);
    expect(capturedThreadOptions[0]?.sandboxMode).toBe("workspace-write");
    expect(capturedThreadOptions[0]?.approvalPolicy).toBe("never");
    expect(result.runtime_events?.[0]).toMatchObject({
      kind: "authority.resolved",
      runtime: "codex_app_server",
      provider: "openai",
      payload: {
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        authority: {
          hasExecutableAuthority: true,
          selectedReason: "mutating workspace task",
        },
      },
    });
  });

  it("rejects non-authorized agents before starting a Codex thread", async () => {
    await expect(invokeCodexSdk(
      makeAgent({ capabilities: [] }),
      "fix the bug",
      makeOpts(baseDir),
      Date.now(),
      "coding",
    )).rejects.toThrow("Codex SDK execution requires tool_use capability");

    expect(capturedThreadOptions).toHaveLength(0);
  });

  it("filters broad additional directories from Codex authority", async () => {
    const projectDir = join(baseDir, "project");
    await invokeCodexSdk(
      makeAgent({
        capabilities: ["tool_use"],
        allowed_directories: ["/home/user", "/Volumes", projectDir],
      }),
      "fix the bug",
      makeOpts(baseDir),
      Date.now(),
      "coding",
    );

    expect(capturedThreadOptions).toHaveLength(1);
    expect(capturedThreadOptions[0]?.additionalDirectories).toEqual([projectDir]);
  });

  it("fails loudly when Codex completes without an assistant message", async () => {
    mockFinalText = "";

    await expect(invokeCodexSdk(
      makeAgent({ capabilities: ["tool_use"] }),
      "fix the bug",
      makeOpts(baseDir),
      Date.now(),
      "coding",
    )).rejects.toThrow("Codex SDK completed without an assistant response");
  });
});

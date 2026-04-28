import { describe, expect, it, mock } from "bun:test";
import { classifyInvocationTask, stripRunContextNote } from "../agents/invoke.js";
import { resolveBrainForTask, type DualBrainConfig } from "../agents/primary.js";
import type { ProviderRouter } from "../providers/router.js";
import type { TaskType } from "../providers/types.js";

const dualBrain: DualBrainConfig = {
  primary: "anthropic",
  coding: { provider: "anthropic", model: "claude-sonnet-4-6", cli_fallback: "claude" },
  conversation: { provider: "anthropic", model: "claude-opus-4-6", cli_fallback: "claude" },
};

describe("resolveBrainForTask", () => {
  it("routes coding tasks to coding brain", () => {
    const brain = resolveBrainForTask("coding", dualBrain);
    expect(brain.provider).toBe("anthropic");
    expect(brain.cli_fallback).toBe("claude");
  });

  it("routes code_review to coding brain", () => {
    const brain = resolveBrainForTask("code_review", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes conversation to conversation brain", () => {
    const brain = resolveBrainForTask("conversation", dualBrain);
    expect(brain.provider).toBe("anthropic");
    expect(brain.cli_fallback).toBe("claude");
  });

  it("routes analysis to conversation brain", () => {
    const brain = resolveBrainForTask("analysis", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes expert to conversation brain", () => {
    const brain = resolveBrainForTask("expert", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes orchestrator to conversation brain", () => {
    const brain = resolveBrainForTask("orchestrator", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes trivial to primary brain (anthropic when primary=anthropic)", () => {
    const brain = resolveBrainForTask("trivial", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes simple_qa to primary brain", () => {
    const brain = resolveBrainForTask("simple_qa", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes research to conversation brain (reasoning task)", () => {
    const brain = resolveBrainForTask("research", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes summarization to conversation brain", () => {
    const brain = resolveBrainForTask("summarization", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes long_context to conversation brain", () => {
    const brain = resolveBrainForTask("long_context", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  it("routes worker_subtask to primary brain", () => {
    const brain = resolveBrainForTask("worker_subtask", dualBrain);
    expect(brain.provider).toBe("anthropic");
  });

  // Tier-aware routing tests
  it("routes orchestrator T4 to Opus (complex orchestration)", () => {
    const brain = resolveBrainForTask("orchestrator", dualBrain, 4);
    expect(brain.model).toBe("claude-opus-4-6");
  });

  it("routes orchestrator T1-T3 to Sonnet (simple messages)", () => {
    for (const tier of [1, 2, 3]) {
      const brain = resolveBrainForTask("orchestrator", dualBrain, tier);
      expect(brain.model).toBe("claude-sonnet-4-6");
    }
  });

  it("routes conversation T2 to Sonnet", () => {
    const brain = resolveBrainForTask("conversation", dualBrain, 2);
    expect(brain.model).toBe("claude-sonnet-4-6");
  });

  it("routes expert T4 to Opus", () => {
    const brain = resolveBrainForTask("expert", dualBrain, 4);
    expect(brain.model).toBe("claude-opus-4-6");
  });

  it("without tier (undefined), defaults to Opus for conversation tasks", () => {
    const brain = resolveBrainForTask("orchestrator", dualBrain);
    expect(brain.model).toBe("claude-opus-4-6");
  });
});

function makeRouter(localTaskType: TaskType, llmTaskType?: TaskType) {
  return {
    classifyLocal: mock(() => localTaskType),
    classifyWithLLM: mock(async () => ({ taskType: llmTaskType ?? localTaskType, tier: 3 })),
    route: mock((taskType: string) => ({ provider: "openrouter", model: "deepseek/deepseek-v3.2", maxTokens: 2048, taskType })),
  } as unknown as ProviderRouter;
}

describe("classifyInvocationTask", () => {
  it("strips the injected run context note before local classification", async () => {
    const router = makeRouter("conversation");
    const message = [
      "[Run Context]",
      "Run ID: 123",
      "Scratchpad: /tmp/run-123",
      "Use the scratchpad for temporary notes, intermediate artifacts, and machine-readable outputs you want preserved with this run.",
      "",
      "something is very wrong here",
    ].join("\n");

    await classifyInvocationTask(message, { router });

    expect(stripRunContextNote(message)).toBe("something is very wrong here");
    expect(router.classifyLocal).toHaveBeenCalledWith("something is very wrong here");
  });

  it("keeps lead agents on their classified task type", async () => {
    const router = makeRouter("coding");

    const result = await classifyInvocationTask("why did this route to codex?", {
      router,
      agentKey: "onyx",
      registry: {
        getEntry: (key: string) => key === "onyx" ? ({ role: "lead" } as any) : undefined,
      } as any,
    });

    expect(result.taskType).toBe("coding");
    expect(result.classifyMethod).toBe("local");
    expect(router.classifyWithLLM).not.toHaveBeenCalled();
  });

  it("keeps short coding follow-ups on the coding path", async () => {
    const router = makeRouter("simple_qa");

    const result = await classifyInvocationTask("do it", {
      router,
      lastTaskType: "coding",
    });

    expect(result.taskType).toBe("coding");
    expect(result.runtimeMode).toBe("agentic");
    expect(result.promptProfile).toBe("agentic_heavy");
    expect(result.classifyMethod).toBe("follow-up");
    expect(router.classifyWithLLM).not.toHaveBeenCalled();
  });

  it("keeps casual conversational turns out of context-aware escalation", async () => {
    const router = makeRouter("conversation", "analysis");

    const result = await classifyInvocationTask("I keep thinking the system feels too brittle when we're just talking.", {
      router,
    });

    expect(result.taskType).toBe("conversation");
    expect(result.runtimeMode).toBe("conversation");
    expect(result.promptProfile).toBe("conversation_light");
    expect(result.classifyMethod).toBe("local");
    expect(router.classifyWithLLM).not.toHaveBeenCalled();
  });

  it("keeps short code review follow-ups on the code_review path", async () => {
    const router = makeRouter("conversation");

    const result = await classifyInvocationTask("same for the other diff", {
      router,
      lastTaskType: "code_review",
    });

    expect(result.taskType).toBe("code_review");
    expect(result.classifyMethod).toBe("follow-up");
    expect(router.classifyWithLLM).not.toHaveBeenCalled();
  });

  it("does not turn reflective follow-ups into execution carry-forward", async () => {
    const router = makeRouter("simple_qa");

    const result = await classifyInvocationTask("what do you think?", {
      router,
      lastTaskType: "coding",
    });

    expect(result.taskType).toBe("simple_qa");
    expect(result.runtimeMode).toBe("conversation");
    expect(result.promptProfile).toBe("conversation_light");
    expect(result.classifyMethod).toBe("local");
    expect(router.classifyWithLLM).not.toHaveBeenCalled();
  });

  it("uses assistant context to upgrade short ambiguous follow-ups", async () => {
    const router = makeRouter("simple_qa", "coding");

    const result = await classifyInvocationTask("same for the webhook path", {
      router,
      conversationHistory: [
        { role: "assistant", content: "I just fixed the auth handler and test coverage for the API route." },
      ],
    });

    expect(result.taskType).toBe("coding");
    expect(result.classifyMethod).toBe("llm_context");
    expect(router.classifyWithLLM).toHaveBeenCalledTimes(1);
  });
});

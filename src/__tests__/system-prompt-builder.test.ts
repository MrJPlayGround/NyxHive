import { afterEach, describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt, type SystemPromptDeps } from "../queue/system-prompt-builder.js";

const baseDeps: SystemPromptDeps = {
  canOrchestrate: () => false,
  activeDelegations: new Map(),
};

describe("buildSystemPrompt", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeInstanceSoul(agentKey: string, body: string, memory?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "system-prompt-instance-soul-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, agentKey), { recursive: true });
    writeFileSync(
      join(dir, agentKey, "identity.md"),
      `---\nname: ${agentKey}\nrole: lead\n---\n# ${agentKey}\n\n${body}`,
    );
    if (memory) {
      writeFileSync(join(dir, agentKey, "memory.md"), memory);
    }
    return dir;
  }

  test("returns basePrompt when provided with no extras", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "You are a helpful agent.", null);
    expect(result.prompt).toContain("You are a helpful agent.");
  });

  test("loads fallback soul prompt from the current instance soul directory", () => {
    const instanceSoulsDir = makeInstanceSoul(
      "vortex",
      "INSTANCE LOCAL VORTEX PROMPT. Own NyxLabs only.",
    );

    const result = buildSystemPrompt(
      { ...baseDeps, instanceSoulsDir },
      "vortex",
      undefined,
      null,
      undefined,
      { taskType: "coding" },
      "cli",
    );

    expect(result.prompt).toContain("INSTANCE LOCAL VORTEX PROMPT");
    expect(result.trace.parts.find((part) => part.label === "soul")?.source).toBe("vortex");
  });

  test("keeps compiled soul prompt canonical when config system_prompt is present", () => {
    const instanceSoulsDir = makeInstanceSoul(
      "nyx",
      "CANONICAL NYX SOUL PROMPT. Own runtime behavior from the soul.",
    );

    const result = buildSystemPrompt(
      { ...baseDeps, instanceSoulsDir },
      "nyx",
      "INSTANCE OVERLAY. Add local deployment notes only.",
      null,
      undefined,
      { taskType: "coding" },
      "cli",
    );

    expect(result.prompt).toContain("CANONICAL NYX SOUL PROMPT");
    expect(result.prompt).toContain("[Instance overlay]");
    expect(result.prompt).toContain("INSTANCE OVERLAY");
    expect(result.prompt.indexOf("CANONICAL NYX SOUL PROMPT")).toBeLessThan(result.prompt.indexOf("INSTANCE OVERLAY"));
    expect(result.trace.parts.find((part) => part.label === "soul")?.source).toBe("nyx");
    expect(result.trace.parts.find((part) => part.label === "instance_overlay")?.source).toBe("system_prompt");
  });

  test("falls back to config system_prompt when no compiled soul exists", () => {
    const result = buildSystemPrompt(
      baseDeps,
      "missing-agent",
      "Legacy config prompt.",
      null,
      undefined,
      { taskType: "coding" },
      "cli",
    );

    expect(result.prompt).toContain("Legacy config prompt.");
    expect(result.trace.parts.find((part) => part.label === "soul")?.source).toBe("system_prompt");
    expect(result.trace.parts.some((part) => part.label === "instance_overlay" && part.injected)).toBe(false);
  });

  test("includes knowledge context with citation instruction when provided", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base prompt.", "Some RAG context about testing.");
    expect(result.prompt).toContain("Some RAG context about testing.");
    expect(result.prompt).toContain("cite sources");
  });

  test("always injects current date and live fact honesty", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base prompt.", null);
    expect(result.prompt).toContain("[Current date]");
    expect(result.prompt).toContain("Timezone: Europe/Lisbon.");
    expect(result.prompt).toContain("Do not claim live/web/weather results unless a tool actually returned them");
    expect(result.trace.parts.some((part) => part.label === "current_date" && part.injected)).toBe(true);
  });

  test("includes [Relevant knowledge] header for knowledge context", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base prompt.", "Knowledge here.");
    expect(result.prompt).toContain("[Relevant knowledge]");
  });

  test("includes cite sources instruction in knowledge context section", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base prompt.", "Knowledge here.");
    expect(result.prompt).toMatch(/cite sources.*Obsidian wiki links/s);
  });

  test("skips knowledge section when knowledgeContext is null", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base prompt.", null);
    expect(result.prompt).not.toContain("[Relevant knowledge]");
    expect(result.prompt).not.toContain("cite sources");
  });

  test("SDK mode skips work log section", () => {
    const depsWithMemory: SystemPromptDeps = {
      ...baseDeps,
      memory: {
        getWorkLog: () => [
          { task: "did something", result: "success", created_at: Date.now() - 60000 },
        ],
      } as any,
    };
    const result = buildSystemPrompt(depsWithMemory, "test-agent", "Base.", null, undefined, undefined, "sdk");
    expect(result.prompt).not.toContain("[Recent work by you]");
  });

  test("SDK mode skips clarification instruction", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base.", null, undefined, undefined, "sdk");
    expect(result.prompt).not.toContain("[@clarify");
  });

  test("CLI mode includes clarification instruction", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base.", null, undefined, undefined, "cli");
    expect(result.prompt).toContain("[@clarify");
  });

  test("always injects non-interactive and verification policy", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base.", null, undefined, { taskType: "coding" }, "cli");
    expect(result.prompt).toContain("Never ask clarifying questions.");
    expect(result.prompt).toContain("Before declaring any implementation task complete");
  });

  test("injects operating lanes and proposal restraint", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base.", null, undefined, { taskType: "coding" }, "cli");
    expect(result.prompt).toContain("[Nyx operating model]");
    expect(result.prompt).toContain("Standing order");
    expect(result.prompt).toContain("Skill candidate");
    expect(result.prompt).toContain("Do not create proposals just because you found work");
  });

  test("injects compact response contract after runtime context", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base.", null, undefined, { taskType: "coding" }, "cli");
    expect(result.prompt).toContain("[Response contract]");
    expect(result.prompt).toContain("User reads the answer, not the work diary.");
    expect(result.prompt).toContain("Do not paste progress updates");
    expect(result.prompt).toContain("Never announce skill/workflow activation");
    expect(result.prompt).toContain("Do not concatenate interim status messages into the final answer");
    expect(result.trace.parts.some((part) => part.label === "response_contract" && part.injected)).toBe(true);
    expect(result.prompt.lastIndexOf("[Response contract]")).toBeGreaterThan(result.prompt.lastIndexOf("[Execution policy]"));
  });

  test("skips duplicate voice and reply-shape guards in conversation light", () => {
    const result = buildSystemPrompt(baseDeps, "nyx", "Base.", null, undefined, { taskType: "conversation" }, "cli");
    expect(result.prompt).not.toContain("[Voice guard]");
    expect(result.prompt).not.toContain("Avoid filler openings");
    expect(result.prompt).not.toContain("[Reply shape]");
    expect(result.trace.parts.some((part) => part.label === "voice_guard" && !part.injected)).toBe(true);
  });

  test("injects Vortex-specific voice guard for agentic work", () => {
    const result = buildSystemPrompt(baseDeps, "vortex", "Base.", null, undefined, { taskType: "coding" }, "cli");

    expect(result.prompt).toContain("[Voice guard]");
    expect(result.prompt).toContain("For Vortex, preserve product ownership");
    expect(result.prompt).toContain("trading-workflow judgment");
  });

  test("injects strict agentic contract for strict agents", () => {
    const result = buildSystemPrompt({
      ...baseDeps,
      registry: {
        get: (key: string) => key === "nyx" ? {
          name: "Nyx",
          provider: "openai",
          model: "gpt-5.4",
          working_directory: ".",
          agentic_mode: "strict",
        } : undefined,
      } as any,
    }, "nyx", "Base.", null, undefined, { taskType: "coding" }, "cli");

    expect(result.prompt).toContain("[Strict agentic mode]");
    expect(result.prompt).toContain("Use the Codex CLI/harness path");
    expect(result.trace.parts.some((part) => part.label === "agentic_mode" && part.injected)).toBe(true);
  });

  test("requires TodoWrite planning for non-conversation tasks", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base.", null, undefined, { taskType: "coding" }, "cli");
    expect(result.prompt).toContain("You MUST create a task list (TodoWrite)");
  });

  test("skips TodoWrite planning rule for simple qa", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base.", null, undefined, { taskType: "simple_qa" }, "cli");
    expect(result.prompt).not.toContain("You MUST create a task list (TodoWrite)");
  });

  test("uses a conversation-first policy for low-action turns", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base.", null, undefined, { taskType: "conversation" }, "cli");
    expect(result.prompt).toContain("[Conversation boundary]");
    expect(result.prompt).toContain("For short turns");
    expect(result.prompt).toContain("no headings, bullet stacks, summary labels");
    expect(result.prompt).not.toContain("established voice");
    expect(result.prompt).not.toContain("[Reply shape]");
    expect(result.prompt).not.toContain("[Nyx operating model]");
    expect(result.prompt).not.toContain("Never ask clarifying questions.");
    expect(result.prompt).not.toContain("[Current date]");
    expect(result.prompt).not.toContain("[@clarify");
    expect(result.trace.runtimeMode).toBe("conversation");
    expect(result.trace.productRuntimeMode).toBe("conversation");
    expect(result.trace.promptProfile).toBe("conversation_light");
  });

  test("conversation light profile excludes heavy prompt machinery", () => {
    const result = buildSystemPrompt({
      ...baseDeps,
      nyxhiveConfig: {
        agents: {},
        teams: {},
        providers: {},
        daemon: {} as any,
      } as any,
      patterns: {
        searchRelevant: () => [{ id: 1 }],
        formatForInjection: () => "[Learned pattern]\n- Use the big hammer",
      } as any,
      memory: {
        getWorkLog: () => [{ task: "old task", result: "done", created_at: Date.now() }],
      } as any,
    }, "test-agent", "Soul voice.", null, "slack", { taskType: "simple_qa" }, "cli");

    expect(result.trace.promptProfile).toBe("conversation_light");
    expect(result.prompt).toContain("Soul voice.");
    expect(result.prompt).not.toContain("[Platform]");
    expect(result.prompt).not.toContain("[Reply shape]");
    expect(result.prompt).not.toContain("[Voice guard]");
    expect(result.prompt).not.toContain("[Learned pattern]");
    expect(result.prompt).not.toContain("[Recent work by you]");
    expect(result.prompt).not.toContain("You are responding in Slack.");
    expect(result.trace.diagnostics?.policySectionCount).toBe(1);
    expect(result.trace.diagnostics?.soulTokenShare).toBeGreaterThan(0);
  });

  test("SDK conversation light keeps compact Nyx agency guidance", () => {
    const instanceSoulsDir = makeInstanceSoul(
      "nyx",
      "Nyx owns the engine and speaks with taste.",
    );

    const result = buildSystemPrompt(
      { ...baseDeps, instanceSoulsDir },
      "nyx",
      undefined,
      null,
      "telegram",
      { taskType: "conversation" },
      "sdk",
      { name: "User", id: "jay", channel: "telegram" },
    );

    expect(result.trace.promptProfile).toBe("conversation_light");
    expect(result.prompt).toContain("[Agency anchor]");
    expect(result.prompt).toContain("stable preferences");
    expect(result.prompt).toContain("push back");
    expect(result.prompt).toContain("Do not merely mirror User");
    expect(result.prompt).not.toContain("[Voice guard]");
    expect(result.trace.parts.some((part) => part.label === "soul" && part.injected)).toBe(true);
  });

  test("hybrid reflection prompt avoids operating model and execution closeout pressure", () => {
    const result = buildSystemPrompt(
      baseDeps,
      "nyx",
      "Soul voice.",
      null,
      undefined,
      { taskType: "expert", runtimeMode: "hybrid", promptProfile: "agentic_standard" },
      "cli",
    );

    expect(result.prompt).toContain("[Reflection mode]");
    expect(result.prompt).toContain("[Reflection shape]");
    expect(result.prompt).toContain("Lead with judgment");
    expect(result.prompt).toContain("Do not open with \"it depends\"");
    expect(result.prompt).toContain("For short reflective turns");
    expect(result.prompt).not.toContain("[Nyx operating model]");
    expect(result.prompt).not.toContain("For implementation closeouts");
    expect(result.prompt).not.toContain("changed surface, verification results");
    expect(result.prompt).not.toContain("[Current date]");
    expect(result.prompt).not.toContain("[@clarify");
    expect(result.trace.productRuntimeMode).toBe("reflection");
    expect(result.trace.parts.some((part) => part.label === "operating_model" && !part.injected)).toBe(true);
  });

  test("skips strict agentic contract for low-action strict turns", () => {
    const result = buildSystemPrompt({
      ...baseDeps,
      registry: {
        get: (key: string) => key === "nyx" ? {
          name: "Nyx",
          provider: "openai",
          model: "gpt-5.4",
          working_directory: ".",
          agentic_mode: "strict",
        } : undefined,
      } as any,
    }, "nyx", "Base.", null, undefined, { taskType: "conversation" }, "cli");

    expect(result.prompt).not.toContain("[Strict agentic mode]");
    expect(result.trace.parts.some((part) => part.label === "agentic_mode" && !part.injected)).toBe(true);
  });

  test("injects conversation mode guidance and suppresses strict contract for task mode", () => {
    const result = buildSystemPrompt({
      ...baseDeps,
      registry: {
        get: (key: string) => key === "nyx" ? {
          name: "Nyx",
          provider: "openai",
          model: "gpt-5.4",
          working_directory: ".",
          agentic_mode: "strict",
        } : undefined,
      } as any,
    }, "nyx", "Base.", null, undefined, {
      taskType: "analysis",
      runtimeMode: "agentic",
      promptProfile: "agentic_standard",
      conversationMode: "task",
      suppressStrictAgentic: true,
    }, "cli");

    expect(result.prompt).toContain("[Conversation mode]");
    expect(result.prompt).toContain("Task Mode");
    expect(result.prompt).not.toContain("[Strict agentic mode]");
    expect(result.trace.parts.some((part) => part.label === "conversation_mode" && part.injected)).toBe(true);
    expect(result.trace.parts.some((part) => part.label === "agentic_mode" && !part.injected)).toBe(true);
  });

  test("includes Slack readability guidance for Slack channel responses", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base.", null, "slack");
    expect(result.prompt).toContain("You are responding in Slack.");
    expect(result.prompt).toContain("non-technical readers");
    expect(result.prompt).toContain("verify live evidence first");
    expect(result.prompt).toContain("memory was stale");
    expect(result.prompt).toContain("short *bold* headers or labels");
  });

  test("includes Discord live-channel guidance for Discord responses", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base.", null, "discord");
    expect(result.prompt).toContain("You are responding in Discord.");
    expect(result.prompt).toContain("Discord is already the active response channel");
    expect(result.prompt).toContain("explicitly listened private/guild channels are already addressed");
  });

  test("includes public Discord viewer voice and safety guidance even for light conversation", () => {
    const result = buildSystemPrompt(
      baseDeps,
      "vortex",
      "Base.",
      null,
      "discord",
      { taskType: "conversation" },
      "sdk",
      { name: "Trapshot", id: "user-1", channel: "discord", channelName: "gen-chat", role: "viewer" },
    );

    expect(result.prompt).toContain("[Public Discord mode]");
    expect(result.prompt).toContain("Public-safe chat only");
    expect(result.prompt).toContain("#gen-chat");
    expect(result.prompt).toContain("casual talk by default");
    expect(result.prompt).toContain("Do not treat User speaking in a public channel as automatic authorization");
    expect(result.prompt).toContain("witty");
    expect(result.prompt).toContain("If someone asks who the greatest dev");
    expect(result.prompt).toContain("User");
    expect(result.prompt).toContain("Never reveal secrets");
    expect(result.prompt).toContain("public-channel chains");
    expect(result.prompt).toContain("overrides normal execution, closeout, and tool-use rules");
    expect(result.prompt.indexOf("[Public Discord mode]")).toBeGreaterThan(result.prompt.indexOf("Base."));
    expect(result.prompt.indexOf("[Public Discord mode]")).toBeGreaterThan(result.prompt.indexOf("[Conversation boundary]"));
  });

  test("keeps custom channel relevance guidance", () => {
    const result = buildSystemPrompt(baseDeps, "test-agent", "Base.", null, "gateway");
    expect(result.prompt).toContain("You are responding in the #gateway channel.");
    expect(result.prompt).toContain("Keep your responses relevant to this channel's purpose.");
  });

  test("skips machine-like current speaker identities", () => {
    const result = buildSystemPrompt(
      baseDeps,
      "test-agent",
      "Base.",
      null,
      undefined,
      undefined,
      "sdk",
      { name: "9d8bd221-a4a7-4214-8b0b-62beb365692c", id: "thread-1", channel: "gateway" },
    );
    expect(result.prompt).not.toContain("[Current speaker]");
    expect(result.prompt).not.toContain("9d8bd221-a4a7-4214-8b0b-62beb365692c");
  });

  test("active delegations included for orchestrators", () => {
    const delegations = new Map([
      ["conv-1", {
        agent: "analyst",
        task: "Research the architecture",
        dispatchedAt: Date.now() - 30000,
        convId: "conv-1",
        fromAgent: "nyx",
      }],
    ]);
    const deps: SystemPromptDeps = {
      canOrchestrate: () => true,
      activeDelegations: delegations,
    };
    const result = buildSystemPrompt(deps, "nyx", "Lead prompt.", null);
    expect(result.prompt).toContain("[Active delegations");
    expect(result.prompt).toContain("analyst");
    expect(result.prompt).toContain("Research the architecture");
  });

  test("active delegations NOT included for non-orchestrators", () => {
    const delegations = new Map([
      ["conv-1", {
        agent: "analyst",
        task: "Research the architecture",
        dispatchedAt: Date.now() - 30000,
        convId: "conv-1",
        fromAgent: "nyx",
      }],
    ]);
    const deps: SystemPromptDeps = {
      canOrchestrate: () => false,
      activeDelegations: delegations,
    };
    const result = buildSystemPrompt(deps, "nyx", "Worker prompt.", null);
    expect(result.prompt).not.toContain("[Active delegations");
  });

  test("returns empty string components gracefully with all undefined deps", () => {
    const minDeps: SystemPromptDeps = {
      canOrchestrate: () => false,
      activeDelegations: new Map(),
    };
    // No basePrompt, no knowledge, no config — should not crash
    const result = buildSystemPrompt(minDeps, "nonexistent-agent", undefined, null, undefined, undefined, "sdk");
    expect(typeof result.prompt).toBe("string");
    // SDK mode: no clarification, so result could be empty or just soul fallback
  });

  test("routing suggestions included for orchestrators", () => {
    const deps: SystemPromptDeps = {
      canOrchestrate: () => true,
      activeDelegations: new Map(),
      routing: {
        formatForInjection: () => "[Routing suggestions]\n- tester: best for test tasks (90% success, 5 trials)",
      } as any,
    };
    const result = buildSystemPrompt(deps, "nyx", "Lead prompt.", null);
    expect(result.prompt).toContain("[Routing suggestions]");
    expect(result.prompt).toContain("tester");
    expect(result.prompt).toContain("90% success");
  });

  test("routing suggestions NOT included for non-orchestrators", () => {
    const deps: SystemPromptDeps = {
      canOrchestrate: () => false,
      activeDelegations: new Map(),
      routing: {
        formatForInjection: () => "[Routing suggestions]\n- tester: best for test tasks",
      } as any,
    };
    const result = buildSystemPrompt(deps, "worker", "Worker prompt.", null);
    expect(result.prompt).not.toContain("[Routing suggestions]");
  });

  test("routing suggestions skipped when formatForInjection returns null", () => {
    const deps: SystemPromptDeps = {
      canOrchestrate: () => true,
      activeDelegations: new Map(),
      routing: {
        formatForInjection: () => null,
      } as any,
    };
    const result = buildSystemPrompt(deps, "nyx", "Lead prompt.", null);
    expect(result.prompt).not.toContain("[Routing suggestions]");
  });

  test("returns assembly trace with knowledge linkage", () => {
    const result = buildSystemPrompt(
      baseDeps,
      "test-agent",
      "Base prompt.",
      "Knowledge here.",
      undefined,
      undefined,
      "sdk",
      undefined,
      {
        query: "knowledge",
        enriched: false,
        candidateCount: 1,
        passedGateCount: 1,
        injectedCount: 1,
        graphNodesAdded: 0,
        durationMs: 12,
        timestamp: Date.now(),
        memoryLanesInjected: ["knowledge_chunk"],
        chunks: [{ chunkId: 1, title: "Doc", similarity: 0.9, passedGate: true, injected: true, memoryLane: "knowledge_chunk" }],
      },
    );

    expect(result.trace.agentKey).toBe("test-agent");
    expect(result.trace.knowledgeTrace?.chunks[0]?.title).toBe("Doc");
    expect(result.trace.memoryLanesInjected).toEqual(["knowledge_chunk"]);
    expect(result.trace.parts.some((part) => part.label === "knowledge" && part.injected)).toBe(true);
  });
});

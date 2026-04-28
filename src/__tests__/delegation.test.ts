import { describe, test, expect, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDelegationEnvelope, buildContinuationPrompt, sanitizeAbsolutePaths, DelegationEngine } from "../queue/delegation.js";
import { QueueProcessor } from "../queue/processor.js";
import { QueueDB } from "../queue/db.js";
import type { ActorMention, DelegationContract } from "../types.js";
import { RELAY_PRESENTING_INSTANCE_HEADER } from "../federation/relay.js";

// --- buildDelegationEnvelope ---

describe("buildDelegationEnvelope", () => {
  test("includes original request and orchestrator reasoning", () => {
    const envelope = buildDelegationEnvelope(
      "Help me fix the login page",
      "The login page has a CSS issue. Forge should handle it.",
      { agent: "forge", task: "Fix the CSS on the login page", filePaths: [], verifyHints: [] } as any,
    );
    expect(envelope).toContain("[Delegation Context]");
    expect(envelope).toContain('Original request: "Help me fix the login page"');
    expect(envelope).toContain("The login page has a CSS issue");
    expect(envelope).toContain("[Your Task]");
    // Note: the task text is appended by the caller, not included in the envelope
  });

  test("omits reasoning when null", () => {
    const envelope = buildDelegationEnvelope(
      "Run tests",
      null,
      { agent: "forge", task: "Run the test suite", filePaths: [], verifyHints: [] } as any,
    );
    expect(envelope).toContain('Original request: "Run tests"');
    expect(envelope).not.toContain("Orchestrator reasoning:");
    expect(envelope).toContain("[Your Task]");
  });

  test("includes file paths when present", () => {
    const envelope = buildDelegationEnvelope(
      "Fix the bug",
      "Found it in processor.ts",
      {
        agent: "forge",
        task: "Fix the bug",
        filePaths: ["src/queue/processor.ts", "src/queue/delegation.ts"],
        verifyHints: [],
      } as any,
    );
    expect(envelope).toContain("src/queue/processor.ts");
    expect(envelope).toContain("src/queue/delegation.ts");
  });

  test("includes verify hints when present", () => {
    const envelope = buildDelegationEnvelope(
      "Add a feature",
      null,
      {
        agent: "forge",
        task: "Add the feature",
        filePaths: [],
        verifyHints: ["Run bun test", "Check for type errors"],
      } as any,
    );
    expect(envelope).toContain("Run bun test");
    expect(envelope).toContain("Check for type errors");
  });

  test("truncates long user messages at 500 chars", () => {
    const longMsg = "x".repeat(1000);
    const envelope = buildDelegationEnvelope(
      longMsg,
      null,
      { agent: "forge", task: "Do it", filePaths: [], verifyHints: [] } as any,
    );
    // The original request should be truncated
    const match = envelope.match(/Original request: "([^"]+)"/);
    expect(match).toBeTruthy();
    expect(match![1].length).toBeLessThanOrEqual(500);
  });

  test("truncates long reasoning at 1000 chars", () => {
    const longReasoning = "y".repeat(2000);
    const envelope = buildDelegationEnvelope(
      "Fix it",
      longReasoning,
      { agent: "forge", task: "Fix it", filePaths: [], verifyHints: [] } as any,
    );
    // Reasoning should be capped
    const reasoningSection = envelope.split("Orchestrator reasoning:")[1]?.split("\n\n")[0];
    expect(reasoningSection).toBeTruthy();
    expect(reasoningSection!.length).toBeLessThanOrEqual(1010); // 1000 + whitespace
  });

  test("uses contract fields when contract is present", () => {
    const contract: DelegationContract = {
      task: "Fix the auth bug",
      agent: "forge",
      inputFiles: ["src/auth/login.ts"],
      outputFiles: [],
      excludeFiles: ["src/auth/logout.ts"],
      constraints: ["don't add new deps"],
      verification: ["bun test", "bun run typecheck"],
      successCriteria: ["session token refreshes on expiry"],
      outputType: "code-change",
      shouldCommit: true,
      priority: "blocking",
      dependsOn: [],
      extractionMethod: "heuristic",
    };

    const mention: ActorMention = {
      agent: "forge",
      task: "Fix the auth bug",
      filePaths: ["src/auth/login.ts"],
      verifyHints: ["tests pass"],
      contract,
    };

    const envelope = buildDelegationEnvelope("fix the login issue", "This is a coding task", mention);

    // Contract fields should be present (files shown as relative paths, not inlined since they don't exist)
    expect(envelope).toContain("src/auth/login.ts");
    expect(envelope).toContain("Do NOT modify: src/auth/logout.ts");
    expect(envelope).toContain("Constraints: don't add new deps");
    expect(envelope).toContain("Verification: bun test; bun run typecheck");
    expect(envelope).toContain("Success criteria: session token refreshes on expiry");
    expect(envelope).toContain("Expected output: code-change (commit)");
    expect(envelope).toContain("Priority: blocking");

    // Absolute paths should never appear
    expect(envelope).not.toMatch(/\/Users\//);
    // Legacy "Key files:" format should NOT be present (contract takes precedence)
    expect(envelope).not.toContain("Key files:");
  });

  test("falls back to legacy fields when no contract", () => {
    const mention: ActorMention = {
      agent: "forge",
      task: "Fix it",
      filePaths: ["src/app.ts"],
      verifyHints: ["tests pass"],
    };

    const envelope = buildDelegationEnvelope("fix it", null, mention);

    // Legacy fields — files referenced by relative path (not inlined since they don't exist)
    expect(envelope).toContain("src/app.ts");
    expect(envelope).toContain("Verification: tests pass");

    // Should not contain absolute paths
    expect(envelope).not.toMatch(/\/Users\//);
    // Contract-specific fields should not be present
    expect(envelope).not.toContain("Expected output:");
  });

  test("omits empty contract fields", () => {
    const contract: DelegationContract = {
      task: "Fix bug",
      agent: "forge",
      inputFiles: ["src/app.ts"],
      outputFiles: [],
      excludeFiles: [],
      constraints: [],
      verification: [],
      successCriteria: [],
      outputType: "code-change",
      shouldCommit: true,
      priority: "normal",
      dependsOn: [],
      extractionMethod: "heuristic",
    };

    const mention: ActorMention = { agent: "forge", task: "Fix bug", contract };
    const envelope = buildDelegationEnvelope("fix bug", null, mention);

    // Input file referenced (not inlined since it doesn't exist on disk)
    expect(envelope).toContain("src/app.ts");
    expect(envelope).toContain("Expected output: code-change (commit)");
    // Empty arrays should not produce lines
    expect(envelope).not.toContain("Output files:");
    expect(envelope).not.toContain("Do NOT modify:");
    expect(envelope).not.toContain("Constraints:");
    expect(envelope).not.toContain("Success criteria:");
    // Normal priority should be omitted
    expect(envelope).not.toContain("Priority:");
    // No depends
    expect(envelope).not.toContain("Depends on:");
  });

  test("shows (commit) only when shouldCommit is true", () => {
    const commitContract: DelegationContract = {
      task: "Fix", agent: "forge",
      inputFiles: [], outputFiles: [], excludeFiles: [], constraints: [],
      verification: [], successCriteria: [],
      outputType: "code-change", shouldCommit: true,
      priority: "normal", dependsOn: [], extractionMethod: "heuristic",
    };
    const noCommitContract: DelegationContract = {
      ...commitContract, outputType: "analysis", shouldCommit: false,
    };

    const e1 = buildDelegationEnvelope("", null, { agent: "forge", task: "Fix", contract: commitContract });
    const e2 = buildDelegationEnvelope("", null, { agent: "analyst", task: "Research", contract: noCommitContract });

    expect(e1).toContain("(commit)");
    expect(e2).not.toContain("(commit)");
  });

  test("adds reverse-relay instructions for remote delegations", () => {
    const envelope = buildDelegationEnvelope(
      "Coordinate with NyxAI",
      "Ask the origin instance if you need extra context.",
      {
        agent: "nyx",
        task: "Check back with origin",
        instance: "nyxlabs",
      } as any,
      null,
      undefined,
      "NyxAI",
    );

    expect(envelope).toContain("[Relay Return Path] Origin instance: NyxAI");
    expect(envelope).toContain("[@origin.<agent>: task]");
    expect(envelope).toContain("[@NyxAI.<agent>: task]");
  });
});

// --- sanitizeAbsolutePaths ---

describe("sanitizeAbsolutePaths", () => {
  test("strips absolute user paths to relative", () => {
    const input = "Fix the bug in /home/user/dev/nyxhive/src/queue/processor.ts";
    const result = sanitizeAbsolutePaths(input);
    expect(result).toBe("Fix the bug in src/queue/processor.ts");
    expect(result).not.toContain("/Users/");
  });

  test("handles multiple absolute paths", () => {
    const input = "Read /home/user/dev/nyxhive/src/a.ts and /home/user/work/acme/src/b.ts";
    const result = sanitizeAbsolutePaths(input);
    expect(result).toContain("src/a.ts");
    expect(result).toContain("src/b.ts");
    expect(result).not.toContain("/Users/");
  });

  test("leaves relative paths unchanged", () => {
    const input = "Fix src/queue/processor.ts";
    expect(sanitizeAbsolutePaths(input)).toBe(input);
  });

  test("handles /home/ paths (Linux)", () => {
    const input = "Check /home/deploy/dev/app/src/main.ts";
    const result = sanitizeAbsolutePaths(input);
    expect(result).toBe("Check src/main.ts");
  });
});

// --- buildContinuationPrompt ---

describe("buildContinuationPrompt", () => {
  test("includes original task and previous progress", () => {
    const prompt = buildContinuationPrompt("Build the login page", "Created LoginView.swift with form fields");
    expect(prompt).toContain("Build the login page");
    expect(prompt).toContain("Created LoginView.swift with form fields");
    expect(prompt).toContain("Continue from the progress summary above.");
  });

  test("caps Last Working State at 1500 chars", () => {
    const longResponse = "x".repeat(5000);
    const prompt = buildContinuationPrompt("task", longResponse);
    // Should contain the truncated tail with ... prefix
    expect(prompt).toContain("...");
    // Extract the Last Working State section
    const stateStart = prompt.indexOf("## Last Working State");
    const stateEnd = prompt.indexOf("[Instructions]");
    const stateSection = prompt.slice(stateStart, stateEnd);
    // 1500 chars + "..." prefix + header + newlines
    expect(stateSection.length).toBeLessThan(1700);
  });

  test("truncates original task at 1000 chars", () => {
    const longTask = "y".repeat(2000);
    const prompt = buildContinuationPrompt(longTask, "progress");
    // Task should be capped
    expect(prompt).not.toContain("y".repeat(2000));
    expect(prompt).toContain("y".repeat(1000));
  });

  test("includes continuation instructions", () => {
    const prompt = buildContinuationPrompt("task", "progress");
    expect(prompt).toContain("Previous Session Hit Turn Limit");
    expect(prompt).toContain("do not redo what was already done");
  });

  test("includes progress summary and do-not-retry instruction", () => {
    const prompt = buildContinuationPrompt("task", "progress");
    expect(prompt).toContain("## Progress Summary");
    expect(prompt).toContain("Do NOT retry approaches that resulted in errors listed above.");
  });
});

// --- DelegationEngine unit tests ---

describe("DelegationEngine", () => {
  function makeEngine(): DelegationEngine {
    return new DelegationEngine();
  }

  function makeProcessor(opts?: { registry?: any; instanceName?: string }): any {
    const tmpDir = mkdtempSync(join(tmpdir(), "del-test-"));
    const queue = new QueueDB(tmpDir);
    return new QueueProcessor(queue, {
      agents: {},
      teams: {},
      baseDir: tmpDir,
      registry: opts?.registry,
      nyxhiveConfig: opts?.instanceName ? { daemon: { name: opts.instanceName } } as any : undefined,
    });
  }

  describe("validateOrchestratorDelegation", () => {
    test("returns result unchanged when no delegation is needed", () => {
      const engine = makeEngine();
      const result = {
        response: "Here's the answer to your question about history.",
        task_type: "conversation",
        tokens_in: 100,
        tokens_out: 50,
        method: "sdk",
      } as any;

      const ctx = {
        config: {},
        coderAgent: "forge",
        getKnownAgentKeys: () => new Set(["forge", "analyst"]),
        isOrchestratorAgent: () => true,
        getAgent: () => undefined,
        emit: () => {},
      } as any;

      const validated = engine.validateOrchestratorDelegation(result, "nyx", "What year was Python created?", ctx);
      expect(validated.response).toBe(result.response);
    });

    test("auto-injects delegation tag when orchestrator fails to delegate non-trivial message", () => {
      const engine = makeEngine();
      const result = {
        response: "I can write that code for you. Here's the implementation...",
        task_type: "coding",
        tokens_in: 100,
        tokens_out: 200,
        method: "sdk",
      } as any;

      const ctx = {
        config: {
          router: {
            classifyLocal: () => "coding",
          },
          registry: {
            getEntry: (key: string) => key === "nyx" ? { role: "orchestrator" } : undefined,
            recordExpectedDelegation: () => {},
            recordDelegationExpected: () => {},
          },
        },
        coderAgent: "forge",
        getKnownAgentKeys: () => new Set(["forge"]),
        isOrchestratorAgent: () => true,
        getAgent: () => ({ name: "Forge" }),
        emit: () => {},
      } as any;

      const validated = engine.validateOrchestratorDelegation(result, "nyx", "Write a Python function to sort a list", ctx);
      // Response should have delegation tag injected
      expect(validated.response).toContain("[@forge:");
    });

    test("does not inject tag when delegation already present", () => {
      const engine = makeEngine();
      const result = {
        response: "[@forge: Write a Python sort function]",
        task_type: "coding",
        tokens_in: 100,
        tokens_out: 50,
        method: "sdk",
      } as any;

      const ctx = {
        config: {
          router: {
            classifyLocal: () => "coding",
          },
          registry: {
            getEntry: (key: string) => key === "nyx" ? { role: "orchestrator" } : undefined,
            recordExpectedDelegation: () => {},
            recordDelegationExpected: () => {},
          },
        },
        coderAgent: "forge",
        getKnownAgentKeys: () => new Set(["forge"]),
        isOrchestratorAgent: () => true,
        getAgent: () => undefined,
        emit: () => {},
      } as any;

      const validated = engine.validateOrchestratorDelegation(result, "nyx", "Write a sort function", ctx);
      // Should not double-inject
      const matches = validated.response.match(/\[@forge:/g);
      expect(matches?.length).toBe(1);
    });

    test("does not inject tag for trivial messages", () => {
      const engine = makeEngine();
      const result = {
        response: "You're welcome!",
        task_type: "trivial",
        tokens_in: 10,
        tokens_out: 10,
        method: "sdk",
      } as any;

      const ctx = {
        config: {
          registry: {
            getEntry: (key: string) => key === "nyx" ? { role: "orchestrator" } : undefined,
          },
        },
        coderAgent: "forge",
      } as any;

      const validated = engine.validateOrchestratorDelegation(result, "nyx", "thanks", ctx);
      expect(validated.response).not.toContain("[@forge:");
    });
  });

  describe("buildSynthesisPrompt", () => {
    test("includes delegation results header", () => {
      const engine = makeEngine() as any;
      const prompt = engine.buildSynthesisPrompt([
        { agent: "Forge", agentKey: "forge", response: "Code is clean." },
      ]);
      expect(prompt).toContain("[Delegation Results]");
      expect(prompt).toContain("[Instructions]");
    });

    test("formats agent responses with name and key", () => {
      const engine = makeEngine() as any;
      const prompt = engine.buildSynthesisPrompt([
        { agent: "Forge", agentKey: "forge", response: "Built the feature." },
        { agent: "Tester", agentKey: "tester", response: "All 42 tests pass." },
      ]);
      expect(prompt).toContain("**Forge** (@forge):");
      expect(prompt).toContain("**Tester** (@tester):");
      expect(prompt).toContain("Built the feature.");
      expect(prompt).toContain("All 42 tests pass.");
    });

    test("truncates responses over 4000 chars", () => {
      const engine = makeEngine() as any;
      const longResponse = "z".repeat(5000);
      const prompt = engine.buildSynthesisPrompt([
        { agent: "Forge", agentKey: "forge", response: longResponse },
      ]);
      expect(prompt).toContain("[...truncated]");
      expect(prompt.length).toBeLessThan(5500);
    });

    test("handles empty results array", () => {
      const engine = makeEngine() as any;
      const prompt = engine.buildSynthesisPrompt([]);
      expect(prompt).toContain("[Delegation Results]");
      expect(prompt).toContain("[Instructions]");
    });
  });

  describe("composeDelegationResponse", () => {
    const mockCtx = { emit: () => {} } as any;

    test("assembles clean response with subtask results", () => {
      const engine = makeEngine() as any;
      const result = engine.composeDelegationResponse(
        "Here is my analysis.",
        [],
        [{ agent: "Analyst", agentKey: "analyst", response: "Data shows 15% growth." }],
        "",
        mockCtx,
      );
      expect(result).toContain("Here is my analysis.");
      expect(result).toContain("Specialist support: Analyst (@analyst).");
      expect(result).not.toContain("**Analyst** (@analyst):");
    });

    test("includes action results before subtask results", () => {
      const engine = makeEngine() as any;
      const result = engine.composeDelegationResponse(
        "Managing the team.",
        ["Agent 'data' hired.", "Schedule 'daily-check' created."],
        [{ agent: "Forge", agentKey: "forge", response: "Done." }],
        "",
        mockCtx,
      );
      expect(result).toContain("Agent 'data' hired.");
      expect(result).toContain("Schedule 'daily-check' created.");
      expect(result).toContain("Specialist support: Forge (@forge).");
    });

    test("includes unknown errors when present", () => {
      const engine = makeEngine() as any;
      const result = engine.composeDelegationResponse(
        "Trying to delegate.",
        [],
        [],
        "[Error: Agent @unknown not found]",
        mockCtx,
      );
      expect(result).toContain("[Error: Agent @unknown not found]");
    });

    test("returns just the clean response when no subtasks or errors", () => {
      const engine = makeEngine() as any;
      const result = engine.composeDelegationResponse(
        "Simple answer with no delegations.",
        [],
        [],
        "",
        mockCtx,
      );
      expect(result).toContain("Simple answer with no delegations.");
    });
  });

  describe("executeDelegationTurn", () => {
    test("returns empty mentions for plain response", async () => {
      const proc = makeProcessor();
      const ctx = proc.buildDelegationContext();
      const engine = proc.delegation;

      const result = await engine.executeDelegationTurn(
        "Just a plain response.",
        "nyx", null, null, "test-conv", "api", "user1",
        0, { value: 1 }, ctx,
      );

      expect(result.mentions).toHaveLength(0);
      expect(result.cleanedResponse).toBe("Just a plain response.");
      expect(result.subtaskResults).toHaveLength(0);
      expect(result.actionResults).toHaveLength(0);
    });

    test("respects max depth guard", async () => {
      const proc = makeProcessor();
      const agents = { forge: { name: "Forge", provider: "test", model: "test", system_prompt: "test" } };
      (proc as any).config.agents = agents;
      const ctx = proc.buildDelegationContext();

      const result = await proc.delegation.executeDelegationTurn(
        "[@forge: deep task]",
        "nyx", null, null, "test-conv", "api", "user1",
        5, // at max depth
        { value: 1 }, ctx,
      );

      expect(result.mentions).toHaveLength(0);
    });

    test("parses management actions separately from delegation mentions", async () => {
      const proc = makeProcessor();
      const ctx = proc.buildDelegationContext();

      const result = await proc.delegation.executeDelegationTurn(
        'Some text. [@fire: old_agent]',
        "nyx", null, null, "test-conv", "api", "user1",
        0, { value: 1 }, ctx,
      );

      // fire is a management action, not a delegation mention
      expect(result.mentions).toHaveLength(0);
    });

    test("reports unknown agents in errors", async () => {
      const proc = makeProcessor();
      const ctx = proc.buildDelegationContext();

      const result = await proc.delegation.executeDelegationTurn(
        "[@nonexistent_agent: do something]",
        "nyx", null, null, "test-conv", "api", "user1",
        0, { value: 1 }, ctx,
      );

      // nonexistent_agent is not a known agent key, should be reported
      expect(result.mentions).toHaveLength(0);
    });

    test("preserves origin sender identity on reverse relay callbacks", async () => {
      const proc = makeProcessor({ instanceName: "remote" });
      const ctx = proc.buildDelegationContext({
        originInstance: "NyxAI",
        callbackUrl: "https://nyx.example.com/api/relay/callback",
        callbackToken: "relay-token",
        callbackSender: "NyxAI",
        callbackSenderId: "NyxAI",
      });
      const originalFetch = globalThis.fetch;
      const fetchMock = mock(async (_url: string | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        const headers = new Headers(init?.headers);
        expect(body.sender).toBe("NyxAI");
        expect(body.sender_id).toBe("NyxAI");
        expect(headers.get(RELAY_PRESENTING_INSTANCE_HEADER)).toBe("remote");
        return new Response(JSON.stringify({
          response: "origin reply",
          agent: "nyx",
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      try {
        const result = await proc.delegation.executeDelegationTurn(
          "[@origin.nyx: Check back with origin]",
          "nyx", null, null, "test-conv", "dispatch", "NyxAI",
          0, { value: 1 }, ctx,
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(result.subtaskResults).toHaveLength(1);
        expect(result.subtaskResults[0]?.response).toContain("origin reply");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("processWithActorModel routing", () => {
    test("returns original response when no mentions present", async () => {
      const proc = makeProcessor();
      const ctx = proc.buildDelegationContext();

      const result = await proc.delegation.processWithActorModel(
        {
          response: "No delegations here.",
          agent: "Nyx",
          task_type: "conversation",
          tokens_in: 100,
          tokens_out: 50,
          method: "sdk",
        } as any,
        null, null, "test-conv", "api", "user1",
        0, { value: 1 }, ctx,
      );

      expect(result).toBe("No delegations here.");
    });
  });
});

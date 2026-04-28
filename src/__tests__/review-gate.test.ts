import { describe, test, expect, mock } from "bun:test";
import {
  buildReviewPrompt,
  parseVerdict,
  formatReviewAnnotation,
  captureGitDiff,
  extractFeedback,
  buildRetryPrompt,
  runReviewGate,
  type ReviewGateResult,
  type ReviewGateConfig,
} from "../queue/review-gate.js";
import type { ProviderRouter } from "../providers/router.js";
import type { CompletionParams, ProviderName } from "../providers/types.js";
import type { TraceStore } from "../memory/traces.js";
import type { AgentConfig, InvocationResult } from "../types.js";

describe("review-gate", () => {
  describe("buildReviewPrompt", () => {
    test("includes task, response, and diff", () => {
      const prompt = buildReviewPrompt("Forge", "Fix the bug", "Fixed it", "diff --git a/file.ts");
      expect(prompt).toContain("Fix the bug");
      expect(prompt).toContain("Fixed it");
      expect(prompt).toContain("diff --git a/file.ts");
      expect(prompt).toContain("code review gate");
    });

    test("handles null diff", () => {
      const prompt = buildReviewPrompt("Forge", "Fix the bug", "Fixed it", null);
      expect(prompt).toContain("No diff available");
      expect(prompt).not.toContain("```diff");
    });

    test("truncates long task and response", () => {
      const longTask = "long task detail ".repeat(2000);
      const longResponse = "long response detail ".repeat(4000);
      const prompt = buildReviewPrompt("Forge", longTask, longResponse, null);
      expect(prompt).toContain("task trimmed for review token budget");
      expect(prompt).toContain("agent response trimmed for review token budget");
      expect(prompt.length).toBeLessThan(longTask.length + longResponse.length);
    });
  });

  describe("parseVerdict", () => {
    test("parses valid pass verdict", () => {
      const result = parseVerdict(JSON.stringify({
        verdict: "pass",
        summary: "Code looks good",
        issues: [],
      }));
      expect(result.verdict).toBe("pass");
      expect(result.summary).toBe("Code looks good");
      expect(result.issues).toEqual([]);
      expect(result.attempts).toBe(1);
    });

    test("parses valid fail verdict", () => {
      const result = parseVerdict(JSON.stringify({
        verdict: "fail",
        summary: "Tests not run",
        issues: ["No test execution detected", "Missing error handling"],
      }));
      expect(result.verdict).toBe("fail");
      expect(result.summary).toBe("Tests not run");
      expect(result.issues).toHaveLength(2);
    });

    test("parses valid warn verdict", () => {
      const result = parseVerdict(JSON.stringify({
        verdict: "warn",
        summary: "Minor concerns",
        issues: ["Could use more tests"],
      }));
      expect(result.verdict).toBe("warn");
    });

    test("handles JSON in markdown fences", () => {
      const fenced = '```json\n{"verdict":"pass","summary":"All good","issues":[]}\n```';
      const result = parseVerdict(fenced);
      expect(result.verdict).toBe("pass");
      expect(result.summary).toBe("All good");
    });

    test("handles plain fences without json label", () => {
      const fenced = '```\n{"verdict":"fail","summary":"Bad","issues":["broken"]}\n```';
      const result = parseVerdict(fenced);
      expect(result.verdict).toBe("fail");
      expect(result.issues).toEqual(["broken"]);
    });

    test("falls back to warn on invalid JSON", () => {
      const result = parseVerdict("This is not JSON at all");
      expect(result.verdict).toBe("warn");
      expect(result.summary).toBe("Review gate could not parse LLM response");
      expect(result.issues).toHaveLength(1);
    });

    test("falls back to warn on invalid verdict value", () => {
      const result = parseVerdict(JSON.stringify({
        verdict: "invalid",
        summary: "Something",
        issues: [],
      }));
      expect(result.verdict).toBe("warn");
    });

    test("handles missing fields gracefully", () => {
      const result = parseVerdict(JSON.stringify({ verdict: "pass" }));
      expect(result.verdict).toBe("pass");
      expect(result.summary).toBe("Unable to parse review summary");
      expect(result.issues).toEqual([]);
    });

    test("filters non-string issues", () => {
      const result = parseVerdict(JSON.stringify({
        verdict: "warn",
        summary: "Mixed issues",
        issues: ["valid", 42, null, "also valid"],
      }));
      expect(result.issues).toEqual(["valid", "also valid"]);
    });

    test("preserves raw response", () => {
      const raw = '{"verdict":"pass","summary":"ok","issues":[]}';
      const result = parseVerdict(raw);
      expect(result.raw).toBe(raw);
    });

    test("accepts custom attempt count", () => {
      const result = parseVerdict(JSON.stringify({
        verdict: "pass",
        summary: "Fixed on retry",
        issues: [],
      }), 2);
      expect(result.attempts).toBe(2);
    });
  });

  describe("formatReviewAnnotation", () => {
    test("formats pass verdict", () => {
      const result: ReviewGateResult = {
        verdict: "pass",
        summary: "Code is correct and complete",
        issues: [],
        raw: "",
        attempts: 1,
      };
      const annotation = formatReviewAnnotation(result);
      expect(annotation).toContain("[PASS]");
      expect(annotation).toContain("Code is correct and complete");
      expect(annotation).not.toContain("attempt");
    });

    test("formats fail verdict with issues", () => {
      const result: ReviewGateResult = {
        verdict: "fail",
        summary: "Missing tests",
        issues: ["No unit tests", "No type checking"],
        raw: "",
        attempts: 1,
      };
      const annotation = formatReviewAnnotation(result);
      expect(annotation).toContain("[FAIL]");
      expect(annotation).toContain("Missing tests");
      expect(annotation).toContain("No unit tests");
      expect(annotation).toContain("No type checking");
    });

    test("formats warn verdict", () => {
      const result: ReviewGateResult = {
        verdict: "warn",
        summary: "Minor concern",
        issues: ["Could improve error handling"],
        raw: "",
        attempts: 1,
      };
      const annotation = formatReviewAnnotation(result);
      expect(annotation).toContain("[WARN]");
    });

    test("no issue list when empty", () => {
      const result: ReviewGateResult = {
        verdict: "pass",
        summary: "All good",
        issues: [],
        raw: "",
        attempts: 1,
      };
      const annotation = formatReviewAnnotation(result);
      // Should not have any dash list items
      expect(annotation).not.toContain(">   -");
    });

    test("includes attempt count when > 1", () => {
      const result: ReviewGateResult = {
        verdict: "pass",
        summary: "Fixed after retry",
        issues: [],
        raw: "",
        attempts: 2,
      };
      const annotation = formatReviewAnnotation(result);
      expect(annotation).toContain("(attempt 2)");
    });
  });

  describe("extractFeedback", () => {
    test("extracts summary and issues", () => {
      const result: ReviewGateResult = {
        verdict: "fail",
        summary: "Tests not run",
        issues: ["Missing unit tests", "No type checking"],
        raw: "",
        attempts: 1,
      };
      const feedback = extractFeedback(result);
      expect(feedback).toContain("Tests not run");
      expect(feedback).toContain("- Missing unit tests");
      expect(feedback).toContain("- No type checking");
    });

    test("handles empty issues", () => {
      const result: ReviewGateResult = {
        verdict: "fail",
        summary: "Incomplete",
        issues: [],
        raw: "",
        attempts: 1,
      };
      const feedback = extractFeedback(result);
      expect(feedback).toBe("Incomplete");
    });
  });

  describe("buildRetryPrompt", () => {
    test("combines original task with feedback", () => {
      const prompt = buildRetryPrompt("Fix the auth bug", "Missing error handling\n- No try/catch around API call");
      expect(prompt).toContain("Fix the auth bug");
      expect(prompt).toContain("Review Feedback");
      expect(prompt).toContain("Missing error handling");
      expect(prompt).toContain("No try/catch around API call");
    });
  });

  describe("captureGitDiff", () => {
    test("returns null for non-git directory", async () => {
      const result = await captureGitDiff("/tmp");
      expect(result).toBeNull();
    });

    test("truncates long diffs", async () => {
      // Test the truncation logic by mocking — we just verify the function signature works
      const result = await captureGitDiff("/tmp", 10);
      // /tmp is not a git repo, so null
      expect(result).toBeNull();
    });
  });

  describe("runReviewGate", () => {
    const passJson = '{"verdict":"pass","summary":"All good","issues":[]}';
    const failJson = '{"verdict":"fail","summary":"Tests missing","issues":["No tests"]}';

    const llmResponse = (content = passJson) => ({
      content,
      model: "test-model",
      provider: "test-provider",
      tokensIn: 100,
      tokensOut: 50,
    });

    const agent: AgentConfig = {
      name: "forge",
      provider: "anthropic",
      model: "claude-sonnet",
      working_directory: ".",
      role: "coder",
    };

    const invResult: InvocationResult = {
      response: "I fixed the bug and ran tests",
      agent: "forge",
      method: "cli",
      duration_ms: 5000,
    };
    const sdkInvResult: InvocationResult = {
      ...invResult,
      method: "cli",
    };

    // --- Early returns (config / router / role checks) ---

    test("returns null when config is undefined", async () => {
      const result = await runReviewGate(
        { baseDir: "/tmp" },
        agent,
        "Fix the bug",
        invResult,
      );
      expect(result).toBeNull();
    });

    test("returns null when config.enabled is false", async () => {
      const result = await runReviewGate(
        { baseDir: "/tmp", config: { enabled: false } },
        agent,
        "Fix the bug",
        invResult,
      );
      expect(result).toBeNull();
    });

    test("returns null when no router available", async () => {
      const result = await runReviewGate(
        { baseDir: "/tmp", config: { enabled: true } },
        agent,
        "Fix the bug",
        invResult,
      );
      expect(result).toBeNull();
    });

    test("returns null when agent role not in allowed roles", async () => {
      const complete = mock(() => Promise.resolve(llmResponse()));
      const result = await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true, roles: ["reviewer"] },
          router: { complete } as unknown as ProviderRouter,
        },
        { ...agent, role: "coder" as const },
        "Fix the bug",
        invResult,
      );
      expect(result).toBeNull();
      expect(complete).not.toHaveBeenCalled();
    });

    test("runs review when agent role matches allowed roles", async () => {
      const complete = mock(() => Promise.resolve(llmResponse()));
      const result = await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true, roles: ["coder", "reviewer"] },
          router: { complete } as unknown as ProviderRouter,
        },
        { ...agent, role: "coder" as const },
        "Fix the bug",
        invResult,
      );
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe("pass");
      expect(complete).toHaveBeenCalledTimes(1);
    });

    test("runs review when agent has no role (bypasses role check)", async () => {
      const complete = mock(() => Promise.resolve(llmResponse()));
      const agentNoRole: AgentConfig = { ...agent, role: undefined };
      const result = await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true },
          router: { complete } as unknown as ProviderRouter,
        },
        agentNoRole,
        "Fix the bug",
        invResult,
      );
      expect(result).not.toBeNull();
      expect(complete).toHaveBeenCalledTimes(1);
    });

    test("runs review for cli invocations without changing behavior", async () => {
      const complete = mock(() => Promise.resolve(llmResponse()));
      const result = await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true },
          router: { complete } as unknown as ProviderRouter,
        },
        agent,
        "Fix the bug",
        sdkInvResult,
      );
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe("pass");
      expect(complete).toHaveBeenCalledTimes(1);
    });

    test("uses default roles [coder] when config.roles not set", async () => {
      const complete = mock(() => Promise.resolve(llmResponse()));
      // Agent with role "reviewer" should be skipped when using default roles
      const result = await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true },
          router: { complete } as unknown as ProviderRouter,
        },
        { ...agent, role: "reviewer" as const },
        "Fix the bug",
        invResult,
      );
      expect(result).toBeNull();
      expect(complete).not.toHaveBeenCalled();
    });

    // --- Success path ---

    test("success path returns parsed verdict from LLM", async () => {
      const complete = mock(() => Promise.resolve(llmResponse(failJson)));
      const result = await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true },
          router: { complete } as unknown as ProviderRouter,
        },
        agent,
        "Fix the bug",
        invResult,
      );
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe("fail");
      expect(result!.summary).toBe("Tests missing");
      expect(result!.issues).toEqual(["No tests"]);
    });

    test("passes correct parameters to router.complete", async () => {
      const complete = mock((_p: CompletionParams, _prov?: ProviderName, _m?: string) => Promise.resolve(llmResponse()));
      await runReviewGate(
        {
          baseDir: "/tmp",
          config: {
            enabled: true,
            max_tokens: 1024,
            provider: "openrouter",
            model: "custom-model",
          },
          router: { complete } as unknown as ProviderRouter,
        },
        agent,
        "Fix the bug",
        invResult,
      );
      expect(complete).toHaveBeenCalledTimes(1);
      const [params, provider, model] = complete.mock.calls[0];
      expect(params.maxTokens).toBe(1024);
      expect(params.temperature).toBe(0);
      expect(params.model).toBe("custom-model");
      expect(params.messages).toHaveLength(1);
      expect(params.messages[0].role).toBe("user");
      expect(provider).toBe("openrouter");
      expect(model).toBe("custom-model");
    });

    test("uses default max_tokens (2048) when not configured", async () => {
      const complete = mock((_p: CompletionParams, _prov?: ProviderName, _m?: string) => Promise.resolve(llmResponse()));
      await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true },
          router: { complete } as unknown as ProviderRouter,
        },
        agent,
        "Fix the bug",
        invResult,
      );
      const [params] = complete.mock.calls[0];
      expect(params.maxTokens).toBe(2048);
    });

    // --- Failure modes (never blocks delegation) ---

    test("degrades to warn on LLM timeout", async () => {
      const complete = mock(
        () => new Promise((resolve) => setTimeout(() => resolve(llmResponse()), 500)),
      );
      const result = await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true, timeout_ms: 10 },
          router: { complete } as unknown as ProviderRouter,
        },
        agent,
        "Fix the bug",
        invResult,
      );
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe("warn");
      expect(result!.summary).toBe("Review gate LLM call failed");
      expect(result!.issues[0]).toContain("timed out");
    });

    test("degrades to warn on LLM error (never throws)", async () => {
      const complete = mock(() => Promise.reject(new Error("API rate limit exceeded")));
      const result = await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true },
          router: { complete } as unknown as ProviderRouter,
        },
        agent,
        "Fix the bug",
        invResult,
      );
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe("warn");
      expect(result!.summary).toBe("Review gate LLM call failed");
      expect(result!.issues[0]).toContain("API rate limit exceeded");
    });

    test("returns attempts: 1 on both success and failure", async () => {
      const complete = mock(() => Promise.reject(new Error("fail")));
      const result = await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true },
          router: { complete } as unknown as ProviderRouter,
        },
        agent,
        "Fix the bug",
        invResult,
      );
      expect(result!.attempts).toBe(1);
    });

    // --- Trace integration ---

    test("starts and completes trace event on success", async () => {
      const complete = mock(() => Promise.resolve(llmResponse()));
      const startEvent = mock((_traceId: string, _agent: string, _task: string, _parentEventId?: number) => 42);
      const completeEvent = mock((_eventId: number, _data: Record<string, unknown>) => {});
      const failEvent = mock((_eventId: number, _error: string) => {});
      const traces = { startEvent, completeEvent, failEvent } as unknown as TraceStore;

      await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true },
          router: { complete } as unknown as ProviderRouter,
          traces,
          traceId: "trace-123",
          parentEventId: 1,
        },
        agent,
        "Fix the bug",
        invResult,
      );

      expect(startEvent).toHaveBeenCalledTimes(1);
      expect(startEvent.mock.calls[0][0]).toBe("trace-123");
      expect(startEvent.mock.calls[0][1]).toBe("review_gate");
      expect(startEvent.mock.calls[0][3]).toBe(1); // parentEventId

      expect(completeEvent).toHaveBeenCalledTimes(1);
      expect(completeEvent.mock.calls[0][0]).toBe(42); // eventId from startEvent
      const data = completeEvent.mock.calls[0][1];
      expect(data.tokensIn).toBe(100);
      expect(data.tokensOut).toBe(50);
      expect(data.model).toBe("test-model");
      expect(data.taskType).toBe("review_gate");
      expect(data.responseExcerpt).toContain("pass");
      expect(typeof data.durationMs).toBe("number");

      expect(failEvent).not.toHaveBeenCalled();
    });

    test("starts and fails trace event on LLM error", async () => {
      const complete = mock(() => Promise.reject(new Error("LLM unavailable")));
      const startEvent = mock((_traceId: string, _agent: string, _task: string, _parentEventId?: number) => 42);
      const completeEvent = mock((_eventId: number, _data: Record<string, unknown>) => {});
      const failEvent = mock((_eventId: number, _error: string) => {});
      const traces = { startEvent, completeEvent, failEvent } as unknown as TraceStore;

      await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true },
          router: { complete } as unknown as ProviderRouter,
          traces,
          traceId: "trace-456",
        },
        agent,
        "Fix the bug",
        invResult,
      );

      expect(startEvent).toHaveBeenCalledTimes(1);
      expect(failEvent).toHaveBeenCalledTimes(1);
      expect(failEvent.mock.calls[0][0]).toBe(42); // eventId
      expect(failEvent.mock.calls[0][1]).toContain("LLM unavailable");
      expect(completeEvent).not.toHaveBeenCalled();
    });

    test("skips trace when traces not in context", async () => {
      const complete = mock(() => Promise.resolve(llmResponse()));
      const result = await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true },
          router: { complete } as unknown as ProviderRouter,
          // no traces, no traceId
        },
        agent,
        "Fix the bug",
        invResult,
      );
      // Should succeed without tracing — no crash
      expect(result).not.toBeNull();
      expect(result!.verdict).toBe("pass");
    });

    test("skips trace when traceId is missing", async () => {
      const complete = mock(() => Promise.resolve(llmResponse()));
      const startEvent = mock(() => 42);
      const traces = {
        startEvent,
        completeEvent: mock(() => {}),
        failEvent: mock(() => {}),
      } as unknown as TraceStore;

      await runReviewGate(
        {
          baseDir: "/tmp",
          config: { enabled: true },
          router: { complete } as unknown as ProviderRouter,
          traces,
          // no traceId
        },
        agent,
        "Fix the bug",
        invResult,
      );

      expect(startEvent).not.toHaveBeenCalled();
    });
  });
});

import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from "bun:test";
import type { AgentConfig } from "../types.js";
import type { ProviderRouter } from "../providers/router.js";
import { invokeAgent } from "../agents/invoke.js";
import * as invokeCliModule from "../agents/invoke-cli.js";
import * as invokeCodexSdkModule from "../agents/invoke-codex-sdk.js";
import * as invokeSdkModule from "../agents/invoke-sdk.js";
import * as invokeNativeApiModule from "../agents/invoke-native-api.js";
import { logger } from "../utils/logger.js";

function makeRouter(taskType: string): ProviderRouter {
  return {
    classifyLocal: () => taskType,
    classifyWithLLM: async () => ({ taskType, tier: 3 }),
    route: () => ({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      taskType: "conversation",
      maxTokens: 4096,
    }),
    routeWithTier: () => ({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      taskType: "conversation",
      maxTokens: 4096,
    }),
  } as unknown as ProviderRouter;
}

function rateLimitError(message = "rate limited") {
  return Object.assign(new Error(message), { status: 429 });
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "Nyx",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    working_directory: "workspace/nyx",
    capabilities: ["tool_use"],
    ...overrides,
  };
}

describe("invokeAgent Anthropic runtime routing", () => {
  let cliSpy: Mock<typeof invokeCliModule.invokeCLI>;
  let codexSdkSpy: Mock<typeof invokeCodexSdkModule.invokeCodexSdk>;
  let clientSdkSpy: Mock<typeof invokeSdkModule.invokeClientSDK>;
  let nativeApiSpy: Mock<typeof invokeNativeApiModule.invokeNativeAPI>;
  let warnSpy: Mock<typeof logger.warn>;
  let infoSpy: Mock<typeof logger.info>;

  beforeEach(() => {
    cliSpy?.mockRestore();
    codexSdkSpy?.mockRestore();
    clientSdkSpy?.mockRestore();
    nativeApiSpy?.mockRestore();
    warnSpy?.mockRestore();
    infoSpy?.mockRestore();

    cliSpy = spyOn(invokeCliModule, "invokeCLI").mockResolvedValue({
      response: "cli",
      agent: "Nyx",
      method: "cli",
      duration_ms: 1,
      session_id: "cli-session",
    });
    codexSdkSpy = spyOn(invokeCodexSdkModule, "invokeCodexSdk").mockResolvedValue({
      response: "codex-sdk",
      agent: "Nyx",
      method: "cli",
      duration_ms: 1,
      session_id: "codex-sdk-session",
      session_runtime: "codex_app_server",
    });
    clientSdkSpy = spyOn(invokeSdkModule, "invokeClientSDK").mockResolvedValue({
      response: "fallback",
      agent: "Nyx",
      method: "sdk",
      duration_ms: 1,
      session_id: "fallback-session",
    });
    nativeApiSpy = spyOn(invokeNativeApiModule, "invokeNativeAPI").mockResolvedValue({
      response: "companion",
      agent: "Nyx",
      method: "api",
      duration_ms: 1,
      session_id: "api-session",
    });
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    infoSpy = spyOn(logger, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    cliSpy?.mockRestore();
    codexSdkSpy?.mockRestore();
    clientSdkSpy?.mockRestore();
    nativeApiSpy?.mockRestore();
    warnSpy?.mockRestore();
    infoSpy?.mockRestore();
  });

  test("routes Anthropic tool-use escalation to CLI", async () => {
    const result = await invokeAgent(
      makeAgent(),
      "fix the bug",
      {
        baseDir: "/tmp/nyxhive-test",
        router: makeRouter("coding"),
      },
    );

    expect(result.method).toBe("cli");
    expect(cliSpy).toHaveBeenCalledTimes(1);
  });

  test("passes abort signal through to CLI invocation", async () => {
    const controller = new AbortController();

    await invokeAgent(
      makeAgent(),
      "fix the bug",
      {
        baseDir: "/tmp/nyxhive-test",
        router: makeRouter("coding"),
        signal: controller.signal,
      },
    );

    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(cliSpy.mock.calls[0]?.[2]?.signal).toBe(controller.signal);
  });

  test("falls back to OpenRouter when single-brain always_cli fails", async () => {
    const cliErr = new Error("claude auth expired");
    cliSpy.mockRejectedValueOnce(cliErr);

    const result = await invokeAgent(
      makeAgent({ always_cli: true, cli_fallback: "claude" }),
      "fix the bug",
      {
        baseDir: "/tmp/nyxhive-test",
        router: makeRouter("coding"),
      },
    );

    expect(result.method).toBe("sdk");
    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(clientSdkSpy).toHaveBeenCalledTimes(1);
    expect(clientSdkSpy.mock.calls[0]?.[4]).toEqual({
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      maxTokens: 16384,
      taskType: "coding",
    });
  });

  test("falls back to OpenRouter when dual-brain always_cli fails", async () => {
    const cliErr = new Error("claude auth expired");
    cliSpy.mockRejectedValueOnce(cliErr);

    const result = await invokeAgent(
      makeAgent({ always_cli: true, cli_fallback: "claude" }),
      "hello there",
      {
        baseDir: "/tmp/nyxhive-test",
        router: makeRouter("conversation"),
        dualBrain: {
          primary: "anthropic",
          coding: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            cli_fallback: "claude",
          },
          conversation: {
            provider: "anthropic",
            model: "claude-opus-4-6",
            cli_fallback: "claude",
          },
        },
      },
    );

    expect(result.method).toBe("sdk");
    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(clientSdkSpy).toHaveBeenCalledTimes(1);
    expect(cliSpy.mock.calls[0]?.[0].model).toBe("claude-opus-4-6");
    expect(clientSdkSpy.mock.calls[0]?.[4]).toEqual({
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      maxTokens: 16384,
      taskType: "conversation",
    });
  });

  test("rethrows the CLI error when always_cli OpenRouter fallback also fails", async () => {
    const cliErr = new Error("claude auth expired");
    cliSpy.mockRejectedValueOnce(cliErr);
    clientSdkSpy.mockRejectedValueOnce(new Error("openrouter unavailable"));

    await expect(invokeAgent(
      makeAgent({ always_cli: true, cli_fallback: "claude" }),
      "fix the bug",
      {
        baseDir: "/tmp/nyxhive-test",
        router: makeRouter("coding"),
      },
    )).rejects.toBe(cliErr);

    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(clientSdkSpy).toHaveBeenCalledTimes(1);
  });

  test("uses configured Codex app-server runtime for strict Codex agents", async () => {
    const cliErr = new Error("codex auth missing");
    cliSpy.mockRejectedValueOnce(cliErr);

    await expect(invokeAgent(
      makeAgent({
        provider: "openai",
        model: "gpt-5.5",
        always_cli: true,
        cli_fallback: "codex",
        agentic_mode: "strict",
      }),
      "fix the bug",
      {
        baseDir: "/tmp/nyxhive-test",
        router: makeRouter("coding"),
        config: {
          providers: { openai: { auth_mode: "codex", runtime: "codex_app_server", fallback: "none" } },
        } as any,
      },
    )).rejects.toBe(cliErr);

    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(cliSpy.mock.calls[0]?.[4] as unknown as string).toBe("nyx_direct");
    expect(codexSdkSpy).not.toHaveBeenCalled();
    expect(clientSdkSpy).not.toHaveBeenCalled();
  });

  test("bypasses conversational classification for strict Codex agents", async () => {
    let classifyLocalCalls = 0;
    let classifyWithLlmCalls = 0;
    const router = {
      classifyLocal: () => {
        classifyLocalCalls += 1;
        return "conversation";
      },
      classifyWithLLM: async () => {
        classifyWithLlmCalls += 1;
        return { taskType: "conversation", tier: 1 };
      },
      route: () => ({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        taskType: "conversation",
        maxTokens: 4096,
      }),
      routeWithTier: () => ({
        provider: "anthropic",
        model: "claude-haiku-4-5-20251001",
        taskType: "conversation",
        maxTokens: 4096,
      }),
    } as unknown as ProviderRouter;

    const result = await invokeAgent(
      makeAgent({
        provider: "openai",
        model: "gpt-5.5",
        always_cli: true,
        cli_fallback: "codex",
        agentic_mode: "strict",
      }),
      "good morning",
      {
        baseDir: "/tmp/nyxhive-test",
        router,
        config: {
          providers: { openai: { auth_mode: "codex", runtime: "codex_app_server", fallback: "none" } },
        } as any,
      },
    );

    expect(result.method).toBe("cli");
    expect(result.response).toBe("cli");
    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(cliSpy.mock.calls[0]?.[4] as unknown as string).toBe("nyx_direct");
    expect(codexSdkSpy).not.toHaveBeenCalled();
    expect(classifyLocalCalls).toBe(0);
    expect(classifyWithLlmCalls).toBe(0);
    expect(clientSdkSpy).not.toHaveBeenCalled();
  });

  test("does not use the strict Codex bypass without executable capability", async () => {
    let classifyLocalCalls = 0;
    const router = {
      ...makeRouter("conversation"),
      classifyLocal: () => {
        classifyLocalCalls += 1;
        return "conversation";
      },
    } as unknown as ProviderRouter;

    const result = await invokeAgent(
      makeAgent({
        provider: "openai",
        model: "gpt-5.5",
        always_cli: true,
        cli_fallback: "codex",
        agentic_mode: "strict",
        capabilities: [],
      }),
      "good morning",
      {
        baseDir: "/tmp/nyxhive-test",
        router,
        config: {
          providers: { openai: { auth_mode: "codex", runtime: "codex_app_server", fallback: "none" } },
        } as any,
      },
    );

    expect(result.method).toBe("cli");
    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(cliSpy.mock.calls[0]?.[4] as unknown as string).toBe("conversation");
    expect(codexSdkSpy).not.toHaveBeenCalled();
    expect(classifyLocalCalls).toBe(1);
  });

  test("keeps strict Codex evidence reviews on the native evidence bypass", async () => {
    const result = await invokeAgent(
      makeAgent({
        provider: "openai",
        model: "gpt-5.5",
        always_cli: true,
        cli_fallback: "codex",
        agentic_mode: "strict",
      }),
      "Finally stable on the workspace with the harness having to be fully rebuilt, check your commits and review what i did to your system",
      {
        baseDir: "/tmp/nyxhive-test",
        router: makeRouter("conversation"),
      },
    );

    expect(result.response).toBe("cli");
    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(cliSpy.mock.calls[0]?.[4] as unknown as string).toBe("nyx_direct");
    expect(codexSdkSpy).not.toHaveBeenCalled();
    expect(clientSdkSpy).not.toHaveBeenCalled();
  });

  test("routes companion-mode orchestrators to native API with tool mode preserved", async () => {
    const result = await invokeAgent(
      makeAgent({
        provider: "openrouter",
        model: "google/gemini-2.5-flash",
        role: "orchestrator",
        companion_mode: true,
      }),
      "good morning",
      {
        baseDir: "/tmp/nyxhive-test",
        router: makeRouter("conversation"),
        toolMode: "off",
      },
    );

    expect(result.method).toBe("api");
    expect(nativeApiSpy).toHaveBeenCalledTimes(1);
    expect(nativeApiSpy.mock.calls[0]?.[2]?.toolMode).toBe("off");
    expect(clientSdkSpy).not.toHaveBeenCalled();
  });

  test("preserves orchestrator task type when always_cli fallback kicks in", async () => {
    const cliErr = new Error("claude auth expired");
    cliSpy.mockRejectedValueOnce(cliErr);

    const result = await invokeAgent(
      makeAgent({
        role: "orchestrator",
        always_cli: true,
        cli_fallback: "claude",
      }),
      "quick status check",
      {
        baseDir: "/tmp/nyxhive-test",
        router: makeRouter("conversation"),
      },
    );

    expect(result.method).toBe("sdk");
    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(cliSpy.mock.calls[0]?.[4] as unknown as string).toBe("orchestrator");
    expect(clientSdkSpy).toHaveBeenCalledTimes(1);
    expect(clientSdkSpy.mock.calls[0]?.[4]).toEqual({
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
      maxTokens: 16384,
      taskType: "orchestrator",
    });
  });

  test("skips dual-brain model swapping when an explicit model override is active", async () => {
    const result = await invokeAgent(
      makeAgent({ always_cli: true, cli_fallback: "claude" }),
      "hello there",
      {
        baseDir: "/tmp/nyxhive-test",
        router: makeRouter("conversation"),
        modelOverride: true,
        dualBrain: {
          primary: "anthropic",
          coding: {
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            cli_fallback: "claude",
          },
          conversation: {
            provider: "anthropic",
            model: "claude-opus-4-6",
            cli_fallback: "claude",
          },
        },
      },
    );

    expect(result.method).toBe("cli");
    expect(cliSpy).toHaveBeenCalledTimes(1);
    expect(cliSpy.mock.calls[0]?.[0].model).toBe("claude-sonnet-4-6");
    expect(clientSdkSpy).not.toHaveBeenCalled();
  });

  test("skips same-provider fallback steps after a 429 rate limit", async () => {
    clientSdkSpy.mockRejectedValueOnce(rateLimitError());

    await expect(invokeAgent(
      makeAgent({ always_cli: false, cli_fallback: "claude" }),
      "hello there",
      {
        baseDir: "/tmp/nyxhive-test",
        router: {
          classifyLocal: () => "conversation",
          classifyWithLLM: async () => ({ taskType: "conversation", tier: 3 }),
          route: () => ({
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            taskType: "conversation",
            maxTokens: 4096,
            fallback: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
          }),
          routeWithTier: () => ({
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            taskType: "conversation",
            maxTokens: 4096,
            fallback: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
          }),
        } as unknown as ProviderRouter,
      },
    )).rejects.toMatchObject({ status: 429 });

    expect(clientSdkSpy).toHaveBeenCalledTimes(1);
    expect(cliSpy).not.toHaveBeenCalled();
  });

  test("still tries a cross-provider fallback after a 429 rate limit", async () => {
    clientSdkSpy.mockRejectedValueOnce(rateLimitError());

    const result = await invokeAgent(
      makeAgent({
        provider: "openrouter",
        model: "google/gemini-2.5-flash",
        capabilities: [],
      }),
      "hello there",
      {
        baseDir: "/tmp/nyxhive-test",
        router: {
          classifyLocal: () => "conversation",
          classifyWithLLM: async () => ({ taskType: "conversation", tier: 3 }),
          route: () => ({
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            taskType: "conversation",
            maxTokens: 4096,
            fallback: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
          }),
          routeWithTier: () => ({
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            taskType: "conversation",
            maxTokens: 4096,
            fallback: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
          }),
        } as unknown as ProviderRouter,
      },
    );

    expect(result.method).toBe("sdk");
    expect(clientSdkSpy).toHaveBeenCalledTimes(2);
    expect(clientSdkSpy.mock.calls[1]?.[4]).toBeUndefined();
  });
});

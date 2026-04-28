import { describe, it, expect } from "bun:test";
import { ProviderRouter } from "../providers/router.js";
import type { Provider, ProviderName } from "../providers/types.js";

// --- Helpers ---

function stubProvider(response = "ok"): Provider {
  return {
    complete: async () => ({ content: response, tokens_in: 10, tokens_out: 5, model: "test-model" }),
  } as any;
}

function failingProvider(error = "provider error", status = 400): Provider {
  return {
    complete: async () => {
      const err = new Error(error) as any;
      err.status = status;
      throw err;
    },
  } as any;
}

const defaultConfig = {
  orchestrator_model: "claude-sonnet-4-6",
  orchestrator_provider: "anthropic" as ProviderName,
  classifier_model: "deepseek/deepseek-v3.2",
  classifier_provider: "openrouter" as ProviderName,
  coding_model: "claude-sonnet-4-6",
  coding_provider: "anthropic" as ProviderName,
};

function makeRouter(config: Record<string, unknown> = defaultConfig) {
  return new ProviderRouter(config as any);
}

const baseParams = {
  messages: [{ role: "user" as const, content: "hello" }],
  maxTokens: 100,
};

// --- classifyLocal ---

describe("classifyLocal", () => {
  const router = makeRouter();

  it("trivial messages -> trivial", () => {
    expect(router.classifyLocal("ok")).toBe("trivial");
    expect(router.classifyLocal("thanks")).toBe("trivial");
    expect(router.classifyLocal("yes")).toBe("trivial");
    expect(router.classifyLocal("nope")).toBe("trivial");
  });

  it("short messages without coding keywords -> simple_qa", () => {
    expect(router.classifyLocal("hello there")).toBe("simple_qa");
    expect(router.classifyLocal("what time is it")).toBe("simple_qa");
  });

  it("short execution cues do not get flattened into simple qa", () => {
    expect(router.classifyLocal("set it up")).toBe("orchestrator");
    expect(router.classifyLocal("add tests")).toBe("coding");
    expect(router.classifyLocal("make it secure")).toBe("expert");
  });

  it("coding patterns -> coding", () => {
    expect(router.classifyLocal("implement a new auth module with database schema")).toBe("coding");
    expect(router.classifyLocal("debug the login function and refactor the handler")).toBe("coding");
  });

  it("does not treat scheduler log lines as coding just because they say Executing", () => {
    expect(router.classifyLocal("2026-04-01T18:45:14.241Z [INFO ] [scheduler] Executing: heartbeat:health-check (agent: sentinel)"))
      .not.toBe("coding");
  });

  it("long messages (>500 chars) -> analysis", () => {
    const longMsg = "Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(15);
    expect(longMsg.length).toBeGreaterThan(500);
    expect(router.classifyLocal(longMsg)).toBe("analysis");
  });

  it("no pattern match -> conversation", () => {
    expect(router.classifyLocal("I was thinking about our approach to the problem")).toBe("conversation");
  });
});

// --- route ---

describe("route", () => {
  it("returns routing table entry for a task type", () => {
    const router = makeRouter();
    const decision = router.route("coding");
    expect(decision.taskType).toBe("coding");
    expect(decision.provider).toBe("anthropic");
    expect(decision.model).toBe("claude-sonnet-4-6");
    expect(decision.maxTokens).toBe(8192);
  });

  it("orchestrator model uses config override", () => {
    const router = makeRouter({
      ...defaultConfig,
      orchestrator_model: "claude-opus-4-6",
    });
    const decision = router.route("orchestrator");
    expect(decision.model).toBe("claude-opus-4-6");
  });
});

// --- routeWithTier ---

describe("routeWithTier", () => {
  const router = makeRouter();

  it("keeps default model when tier matches", () => {
    // coding default is claude-sonnet-4-6 (tier 3)
    const decision = router.routeWithTier({ taskType: "coding", tier: 3 });
    expect(decision.model).toBe("claude-sonnet-4-6");
    expect(decision.provider).toBe("anthropic");
  });

  it("upgrades model when classified tier is higher", () => {
    // coding default tier 3, request tier 4 -> opus
    const decision = router.routeWithTier({ taskType: "coding", tier: 4 });
    expect(decision.model).toBe("claude-opus-4-6");
  });

  it("downgrades model when classified tier is lower", () => {
    // coding default tier 3, request tier 1 -> cheap OpenRouter default
    const decision = router.routeWithTier({ taskType: "coding", tier: 1 });
    expect(decision.model).toBe("deepseek/deepseek-v3.2");
  });

  it("enforces minModel guardrail as floor", () => {
    const decision = router.routeWithTier(
      { taskType: "coding", tier: 1 },
      { minModel: "claude-sonnet-4-6" },
    );
    expect(decision.model).toBe("claude-sonnet-4-6");
  });

  it("enforces maxModel guardrail as ceiling", () => {
    const decision = router.routeWithTier(
      { taskType: "coding", tier: 4 },
      { maxModel: "claude-sonnet-4-6" },
    );
    expect(decision.model).toBe("claude-sonnet-4-6");
  });

  it("keeps the agent provider when a guardrail model cannot be resolved from live providers", () => {
    const decision = router.routeWithTier(
      { taskType: "analysis", tier: 3 },
      { maxModel: "llama3.2:3b", preferredProvider: "ollama" },
    );
    expect(decision.model).toBe("llama3.2:3b");
    expect(decision.provider).toBe("ollama");
  });
});

describe("classifyWithLLM", () => {
  it("accepts classifier output wrapped around JSON", async () => {
    const router = makeRouter();
    router.registerProvider("openrouter", stubProvider("```json\n{\"task_type\":\"coding\",\"tier\":3}\n```"));

    const result = await router.classifyWithLLM("fix the gateway auth bug");
    expect(result.taskType).toBe("coding");
    expect(result.tier).toBe(3);
  });

  it("falls back to local classification when classifier returns no JSON", async () => {
    const router = makeRouter();
    router.registerProvider("openrouter", stubProvider("definitely coding, trust me"));

    const result = await router.classifyWithLLM("implement the retry logic");
    expect(result.taskType).toBe("coding");
    expect(result.tier).toBe(2);
  });
});

// --- complete ---

describe("complete", () => {
  it("calls preferred provider successfully", async () => {
    const router = makeRouter();
    router.registerProvider("anthropic", stubProvider("result-a"));
    const result = await router.complete(baseParams, "anthropic", "claude-sonnet-4-6");
    expect(result.content).toBe("result-a");
  });

  it("falls back when primary fails", async () => {
    const router = makeRouter();
    router.registerProvider("anthropic", failingProvider("primary down", 400));
    router.registerProvider("openai", stubProvider("fallback-result"));
    const result = await router.complete(baseParams, "anthropic", "claude-sonnet-4-6");
    expect(result.content).toBe("fallback-result");
  });

  it("throws when all providers fail", async () => {
    const router = makeRouter();
    router.registerProvider("anthropic", failingProvider("down-a", 400));
    router.registerProvider("openrouter", failingProvider("down-b", 400));
    await expect(router.complete(baseParams, "anthropic")).rejects.toThrow("All providers failed");
  });

  it("tries route-specific fallback with model before generic chain", async () => {
    const router = makeRouter();
    router.registerProvider("anthropic", failingProvider("primary down", 400));

    let receivedModel = "";
    router.registerProvider("openrouter", {
      complete: async (params: any) => {
        receivedModel = params.model ?? "";
        return { content: "fallback-ok", tokens_in: 1, tokens_out: 1, model: params.model ?? "m", provider: "openrouter" };
      },
    } as any);

    const result = await router.complete(
      baseParams,
      "anthropic",
      "claude-sonnet-4-6",
      { provider: "openrouter", model: "mistralai/mistral-medium-3" },
    );

    expect(result.content).toBe("fallback-ok");
    expect(receivedModel).toBe("mistralai/mistral-medium-3");
  });

  it("falls back to generic chain when route fallback also fails", async () => {
    const router = makeRouter();
    router.registerProvider("anthropic", failingProvider("primary down", 400));
    router.registerProvider("openrouter", failingProvider("route fallback down", 400));

    // Register a second provider that will catch the generic fallback
    router.registerProvider("openai" as any, stubProvider("generic-fallback-ok"));

    // This should fail primary (anthropic), fail route fallback (openrouter),
    // then succeed on generic chain (openai)
    const result = await router.complete(
      baseParams,
      "anthropic",
      "claude-sonnet-4-6",
      { provider: "openrouter", model: "mistralai/mistral-medium-3" },
    );

    expect(result.content).toBe("generic-fallback-ok");
  });

  it("includes tried providers in error message when all fail", async () => {
    const router = makeRouter();
    router.registerProvider("anthropic", failingProvider("down-a", 400));
    router.registerProvider("openrouter", failingProvider("down-b", 400));
    await expect(router.complete(baseParams, "anthropic")).rejects.toThrow("tried:");
  });

  it("skips circuit-broken providers in fallback chain", async () => {
    const router = makeRouter({
      ...defaultConfig,
      fallback_order: ["anthropic", "openrouter"],
    });
    router.registerProvider("anthropic", failingProvider("down", 400));
    router.registerProvider("openrouter", stubProvider("or-result"));

    // Trip anthropic's circuit breaker (3 failures)
    for (let i = 0; i < 3; i++) {
      try { await router.complete(baseParams, "anthropic"); } catch {}
    }
    expect(router.getHealthStatus().anthropic).toBe("error");

    // Replace openrouter with a tracking stub
    let orCalled = false;
    router.registerProvider("openrouter", {
      complete: async () => {
        orCalled = true;
        return { content: "or-ok", tokens_in: 1, tokens_out: 1, model: "m" };
      },
    } as any);

    const result = await router.complete(baseParams, "anthropic");
    expect(result.content).toBe("or-ok");
    expect(orCalled).toBe(true);
  });
});

// --- Circuit breaker ---

describe("circuit breaker", () => {
  it("trips after 3 failures within the window", async () => {
    const router = makeRouter();
    router.registerProvider("anthropic", failingProvider("fail", 400));
    router.registerProvider("openrouter", stubProvider("fallback"));

    for (let i = 0; i < 3; i++) {
      await router.complete(baseParams, "anthropic").catch(() => {});
    }
    expect(router.getHealthStatus().anthropic).toBe("error");
  });

  it("decay: success resets failure counter so new failures don't trip breaker", async () => {
    // Tests the decay fix indirectly: fail 2x, succeed (resets counter), fail 1x -> should NOT trip
    const router = makeRouter();
    let callCount = 0;
    router.registerProvider("anthropic", {
      complete: async () => {
        callCount++;
        if (callCount <= 2 || callCount >= 4) {
          const err = new Error("fail") as any;
          err.status = 400;
          throw err;
        }
        // callCount === 3: success
        return { content: "ok", tokens_in: 1, tokens_out: 1, model: "m" };
      },
    } as any);
    router.registerProvider("openrouter", stubProvider("fb"));

    // 2 failures
    await router.complete(baseParams, "anthropic").catch(() => {});
    await router.complete(baseParams, "anthropic").catch(() => {});

    // 1 success -> resets counter to 0
    await router.complete(baseParams, "anthropic");
    expect(router.getHealthStatus().anthropic).toBe("idle");

    // 1 more failure -> counter should be 1, NOT 3
    await router.complete(baseParams, "anthropic").catch(() => {});
    expect(router.getHealthStatus().anthropic).not.toBe("error");
  });

  it("cooldown expiry moves to recovering", async () => {
    const router = makeRouter();
    router.registerProvider("anthropic", failingProvider("fail", 400));
    router.registerProvider("openrouter", stubProvider("fb"));

    // Trip the breaker
    for (let i = 0; i < 3; i++) {
      await router.complete(baseParams, "anthropic").catch(() => {});
    }
    expect(router.getHealthStatus().anthropic).toBe("error");

    // Simulate cooldown expiry by manipulating internal state
    const circuitState = (router as any).circuitState.get("anthropic");
    circuitState.lastStateChange = Date.now() - 61_000;

    expect(router.getHealthStatus().anthropic).toBe("recovering");
  });

  it("successful probe resets recovering to idle", async () => {
    const router = makeRouter();
    let shouldFail = true;
    router.registerProvider("anthropic", {
      complete: async () => {
        if (shouldFail) {
          const err = new Error("fail") as any;
          err.status = 400;
          throw err;
        }
        return { content: "recovered", tokens_in: 1, tokens_out: 1, model: "m" };
      },
    } as any);
    router.registerProvider("openrouter", stubProvider("fb"));

    // Trip breaker
    for (let i = 0; i < 3; i++) {
      await router.complete(baseParams, "anthropic").catch(() => {});
    }
    expect(router.getHealthStatus().anthropic).toBe("error");

    // Simulate cooldown expiry
    const circuitState = (router as any).circuitState.get("anthropic");
    circuitState.lastStateChange = Date.now() - 61_000;

    // Succeed on probe
    shouldFail = false;
    const result = await router.complete(baseParams, "anthropic");
    expect(result.content).toBe("recovered");
    expect(router.getHealthStatus().anthropic).toBe("idle");
  });
});

// --- Other ---

describe("isAvailable / hasProvider / getHealthStatus", () => {
  it("isAvailable returns false with no providers, true after registration", () => {
    const router = makeRouter();
    expect(router.isAvailable()).toBe(false);
    router.registerProvider("anthropic", stubProvider());
    expect(router.isAvailable()).toBe(true);
  });

  it("hasProvider checks registration", () => {
    const router = makeRouter();
    expect(router.hasProvider("anthropic")).toBe(false);
    router.registerProvider("anthropic", stubProvider());
    expect(router.hasProvider("anthropic")).toBe(true);
    expect(router.hasProvider("openrouter")).toBe(false);
  });

  it("getHealthStatus returns per-provider state", () => {
    const router = makeRouter();
    router.registerProvider("anthropic", stubProvider());
    router.registerProvider("openrouter", stubProvider());
    const health = router.getHealthStatus();
    expect(health.anthropic).toBe("idle");
    expect(health.openrouter).toBe("idle");
  });
});

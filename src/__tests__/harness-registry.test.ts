import { afterEach, describe, expect, test } from "bun:test";
import type { AgentHarness } from "../harness/types.js";
import {
  clearHarnesses,
  listHarnesses,
  listHarnessIds,
  registerHarness,
  restoreHarnesses,
  selectHarnessForRuntime,
} from "../harness/registry.js";
import { selectAgentHarness, shouldUseHarnessRuntime } from "../harness/selection.js";

const originalHarnesses = listHarnesses();

afterEach(() => {
  restoreHarnesses(originalHarnesses);
});

function makeHarness(id: string, priority: number): AgentHarness {
  return {
    id,
    runtime: "codex_app_server",
    provider: "openai",
    supports: (ctx) => ctx.runtime === "codex_app_server"
      ? { supported: true, priority }
      : { supported: false, reason: "unsupported" },
    discover: async () => ({
      runtime: "codex_app_server",
      provider: "openai",
      authenticated: true,
      accountType: "chatgpt",
      models: [],
    }),
    runTurn: async () => ({
      runtime: "codex_app_server",
      providerThreadId: "thread-test",
      response: "ok",
      events: [],
    }),
  };
}

describe("harness registry", () => {
  test("registers the shared Codex app-server harness without Claude assumptions", () => {
    expect(listHarnessIds()).toContain("codex_app_server");
    const selected = selectHarnessForRuntime("codex_app_server");
    expect(selected?.id).toBe("codex_app_server");
    expect(selected?.provider).toBe("openai");
  });

  test("selects the highest-priority compatible harness", () => {
    clearHarnesses();
    registerHarness(makeHarness("low", 1));
    registerHarness(makeHarness("high", 10));

    expect(selectHarnessForRuntime("codex_app_server")?.id).toBe("high");
  });

  test("keeps app-server selection explicitly gated by env and invocation override", () => {
    const agent = {
      name: "Nyx",
      provider: "openai",
      model: "gpt-5.4",
      cli_fallback: "codex",
      working_directory: "/tmp",
    };

    expect(shouldUseHarnessRuntime({ agent, env: { NYXHIVE_CODEX_APP_SERVER: "1" } })).toBe(false);
    expect(shouldUseHarnessRuntime({
      agent,
      config: { providers: { openai: { runtime: "codex_app_server" } } } as any,
      env: {},
    })).toBe(true);
    expect(shouldUseHarnessRuntime({ agent, env: {}, override: "app_server" })).toBe(false);
    expect(shouldUseHarnessRuntime({ agent, env: { NYXHIVE_CODEX_APP_SERVER: "1" }, override: "app_server" })).toBe(true);
    expect(selectAgentHarness({ agent, env: { NYXHIVE_CODEX_APP_SERVER: "1" }, override: "app_server" })?.id).toBe("codex_app_server");
  });
});

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { dispatchToInstance } from "../agents/dispatch.js";
import type { NyxHiveConfig } from "../types.js";
import { RelayCallbackManager } from "../federation/relay.js";

// Minimal config with one remote
function makeConfig(overrides?: Partial<NyxHiveConfig["remotes"]>): NyxHiveConfig {
  return {
    daemon: {
      name: "NyxAI",
    },
    server: {
      port: 3777,
      public_url: "https://nyx.example.com/core",
    },
    remotes: {
      trading: {
        url: "https://trading.example.com",
        api_key_env: "TRADING_API_KEY",
        description: "Trading journal instance",
        agents: ["forge", "analyst"],
      },
      ...overrides,
    },
  } as unknown as NyxHiveConfig;
}

describe("dispatchToInstance", () => {
  let originalEnv: string | undefined;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalEnv = process.env.TRADING_API_KEY;
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TRADING_API_KEY = originalEnv;
    } else {
      delete process.env.TRADING_API_KEY;
    }
    globalThis.fetch = originalFetch;
  });

  test("throws on unknown instance", async () => {
    const config = makeConfig();
    await expect(
      dispatchToInstance("nonexistent", "forge", "task", config),
    ).rejects.toThrow('Unknown remote "nonexistent". Known remotes: trading');
  });

  test("throws when no remotes configured", async () => {
    const config = { remotes: undefined } as unknown as NyxHiveConfig;
    await expect(
      dispatchToInstance("anything", "forge", "task", config),
    ).rejects.toThrow("Known remotes: none");
  });

  test("throws on missing API key", async () => {
    delete process.env.TRADING_API_KEY;
    const config = makeConfig();
    await expect(
      dispatchToInstance("trading", "forge", "task", config),
    ).rejects.toThrow('Missing API key for instance "trading" (env: TRADING_API_KEY)');
  });

  test("lists known remotes in error message", async () => {
    const config = makeConfig({
      other: {
        url: "https://other.example.com",
        api_key_env: "OTHER_KEY",
      },
    });
    await expect(
      dispatchToInstance("bad", "forge", "task", config),
    ).rejects.toThrow("trading, other");
  });

  test("includes relay callback metadata when available", async () => {
    process.env.TRADING_API_KEY = "secret";
    const config = makeConfig();
    let callCount = 0;
    const fetchMock = mock(async (url: string | URL, init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        const body = JSON.parse(String(init?.body));
        expect(String(url)).toBe("https://trading.example.com/api/message");
        expect(body.sender).toBe("NyxAI");
        expect(body.async).toBe(true);
        expect(body.relay).toEqual({
          origin_instance: "NyxAI",
          callback_url: "https://nyx.example.com/core/api/relay/callback",
          callback_token: expect.any(String),
        });
        return new Response(JSON.stringify({ message_id: "remote-1", status: "enqueued" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      expect(String(url)).toBe("https://trading.example.com/api/message/remote-1");
      return new Response(JSON.stringify({ status: "completed", response: "done", agent: "forge" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const relayCallbacks = new RelayCallbackManager(config);
    const result = await dispatchToInstance("trading", "forge", "task", config, undefined, relayCallbacks);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.response).toBe("done");
    expect(result.agent).toBe("forge");
  });
});

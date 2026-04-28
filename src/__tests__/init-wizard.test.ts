import { afterEach, describe, expect, mock, test } from "bun:test";
import { buildSimpleConfigToml, validateChannelInput, validateProviderInput } from "../cli/init-wizard.js";

describe("init wizard", () => {
  afterEach(() => {
    mock.restore();
  });

  test("buildSimpleConfigToml emits the minimal simple config shape", () => {
    const toml = buildSimpleConfigToml({
      name: "Companion",
      port: 3788,
      preset: "preset:companion",
      provider: {
        name: "anthropic",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        model: "claude-sonnet-4-6",
      },
      channels: {
        telegram: {
          bot_token_env: "TELEGRAM_BOT_TOKEN",
          __value: "secret",
        },
      },
    });

    expect(toml).toContain("name = \"Companion\"");
    expect(toml).toContain("preset = \"companion\"");
    expect(toml).toContain("[provider]");
    expect(toml).toContain("api_key_env = \"ANTHROPIC_API_KEY\"");
    expect(toml).toContain("[telegram]");
    expect(toml).not.toContain("__value");
    expect(toml).not.toContain("secret");
  });

  test("validateProviderInput accepts a healthy Ollama endpoint", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({ models: [] }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await validateProviderInput("ollama", "http://localhost:11434");

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("http://localhost:11434/api/tags");
  });

  test("validateChannelInput validates telegram bot tokens", async () => {
    const fetchMock = mock(async () => new Response(JSON.stringify({
      ok: true,
      result: { username: "nyxhive_bot" },
    }), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await validateChannelInput("telegram", { bot_token: "token" });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("@nyxhive_bot");
  });
});

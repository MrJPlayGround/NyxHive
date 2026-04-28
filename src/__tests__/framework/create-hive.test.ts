import { describe, expect, test } from "bun:test";
import { resolveOpenAIRestProviderMissingAuthLog } from "../../framework/create-hive.js";

describe("createHive provider startup logging", () => {
  test("does not warn when OpenAI is configured for Codex CLI auth", () => {
    expect(resolveOpenAIRestProviderMissingAuthLog({ auth_mode: "codex" })).toEqual({
      level: "info",
      message: "OpenAI REST provider skipped (auth_mode=codex; Codex CLI handles OpenAI runtime)",
    });
  });

  test("warns with the configured API key env for native OpenAI auth", () => {
    expect(resolveOpenAIRestProviderMissingAuthLog({ api_key_env: "CUSTOM_OPENAI_KEY" })).toEqual({
      level: "warn",
      message: "OpenAI not available: set CUSTOM_OPENAI_KEY.",
    });
  });
});

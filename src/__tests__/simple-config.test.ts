import { describe, expect, test } from "bun:test";
import { synthesizeSimpleConfig } from "../config.js";

describe("synthesizeSimpleConfig", () => {
  test("defaults Codex-auth OpenAI setups to gpt-5.5", () => {
    const config = synthesizeSimpleConfig({
      name: "Nyx",
      port: 3777,
      preset: "coder",
      provider: {
        name: "openai",
        auth_mode: "codex",
      },
    } as any);

    expect(config.providers.openai?.model).toBe("gpt-5.5");
    expect(config.agents.assistant.model).toBe("gpt-5.5");
    expect(config.routing.classifier_model).toBe("gpt-5.5");
    expect(config.agents.assistant.cli_fallback).toBe("codex");
  });

  test("keeps OpenAI API-key setups on gpt-5-mini until the API catches up", () => {
    const config = synthesizeSimpleConfig({
      name: "Nyx",
      port: 3777,
      preset: "coder",
      provider: {
        name: "openai",
        auth_mode: "api_key",
      },
    } as any);

    expect(config.providers.openai?.model).toBe("gpt-5-mini");
    expect(config.agents.assistant.model).toBe("gpt-5-mini");
    expect(config.routing.classifier_model).toBe("gpt-5-mini");
  });
});

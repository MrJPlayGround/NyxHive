import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import TOML from "@iarna/toml";
import { DEFAULT_COST_RATES, getContextWindow, getModelTier } from "../defaults.js";

describe("runtime hardening config", () => {
  test("public template uses GPT-5.5 without broad Codex directory grants", () => {
    const raw = readFileSync(resolve(import.meta.dir, "../../config/nyxhive.toml"), "utf-8");
    const config = JSON.parse(JSON.stringify(TOML.parse(raw))) as {
      allowed_directories?: string[];
      agents?: { nyx?: { model?: string } };
    };

    expect(config.agents?.nyx?.model).toBe("gpt-5.5");
    expect(config.allowed_directories ?? []).toEqual(["."]);
    expect(config.allowed_directories ?? []).not.toContain("/home/user");
    expect(config.allowed_directories ?? []).not.toContain("/Volumes");
  });

  test("GPT-5.5 has cost, tier, and context metadata", () => {
    expect(DEFAULT_COST_RATES["gpt-5.5"]).toMatchObject({
      input: expect.any(Number),
      output: expect.any(Number),
    });
    expect(getModelTier("gpt-5.5")).toBeGreaterThanOrEqual(4);
    expect(getContextWindow("gpt-5.5")).toBeGreaterThanOrEqual(1_000_000);
  });
});

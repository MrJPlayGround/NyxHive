import { describe, test, expect } from "bun:test";
import { CATEGORY_MODEL_MAP } from "../defaults.js";
import type { ModelCategory } from "../types.js";

describe("Category-Based Model Routing", () => {
  test("frontier maps to opus", () => {
    expect(CATEGORY_MODEL_MAP.frontier.model).toBe("claude-opus-4-6");
    expect(CATEGORY_MODEL_MAP.frontier.provider).toBe("anthropic");
  });

  test("deep maps to sonnet", () => {
    expect(CATEGORY_MODEL_MAP.deep.model).toBe("claude-sonnet-4-6");
    expect(CATEGORY_MODEL_MAP.deep.provider).toBe("anthropic");
  });

  test("quick maps to flash lite", () => {
    expect(CATEGORY_MODEL_MAP.quick.model).toBe("deepseek/deepseek-v3.2");
    expect(CATEGORY_MODEL_MAP.quick.provider).toBe("openrouter");
  });

  test("visual maps to sonnet", () => {
    expect(CATEGORY_MODEL_MAP.visual.model).toBe("claude-sonnet-4-6");
    expect(CATEGORY_MODEL_MAP.visual.provider).toBe("anthropic");
  });

  test("all categories are defined", () => {
    const categories: ModelCategory[] = ["frontier", "deep", "quick", "visual"];
    for (const cat of categories) {
      expect(CATEGORY_MODEL_MAP[cat]).toBeDefined();
      expect(CATEGORY_MODEL_MAP[cat].model).toBeTruthy();
      expect(CATEGORY_MODEL_MAP[cat].provider).toBeTruthy();
    }
  });
});

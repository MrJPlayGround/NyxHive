import { describe, test, expect } from "bun:test";
import { resolve } from "path";
import { loadSoulV2Directory } from "../soul/loader-v2.js";
import { compileSoulV2 } from "../soul/compiler-v2.js";
import { composeSystemPrompt } from "../soul/compiler.js";

const soulsDir = resolve(import.meta.dir, "../../souls");

describe("soul v2 token budget", () => {
  const agents = [
    "nyx",
    "analyst",
    "tester",
  ];

  // Lead agents have richer souls (personality, philosophy, voice, etc.) — allow higher budget
  const budgets: Record<string, number> = { nyx: 15500 };
  const defaultBudget = 4000;

  for (const agent of agents) {
    const limit = budgets[agent] ?? defaultBudget;
    test(`${agent} system prompt < ${limit} chars`, () => {
      const loaded = loadSoulV2Directory(soulsDir, agent);
      const soul = compileSoulV2(loaded);
      const prompt = composeSystemPrompt(soul);
      expect(prompt.length).toBeLessThan(limit);
    });
  }

  test("all agents produce non-empty system prompts", () => {
    for (const agent of agents) {
      const loaded = loadSoulV2Directory(soulsDir, agent);
      const soul = compileSoulV2(loaded);
      const prompt = composeSystemPrompt(soul);
      expect(prompt.length).toBeGreaterThan(100);
    }
  });
});

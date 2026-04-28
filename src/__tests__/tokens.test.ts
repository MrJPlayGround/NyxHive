import { describe, test, expect } from "bun:test";
import { estimateTokens, messageTokens } from "../context/tokens.js";
import { buildTokenDisciplineReport, trimTextToTokenBudget } from "../context/token-discipline.js";

describe("estimateTokens", () => {
  test("short string returns reasonable count", () => {
    const tokens = estimateTokens("Hello, world!");
    expect(tokens).toBeGreaterThanOrEqual(3);
    expect(tokens).toBeLessThanOrEqual(5);
  });

  test("empty string returns 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("code block tokens counted accurately", () => {
    const code = `function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}`;
    const tokens = estimateTokens(code);
    expect(tokens).toBeGreaterThan(25);
    expect(tokens).toBeLessThan(45);
  });

  test("long text within 5% of reference", () => {
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(22);
    const tokens = estimateTokens(prose);
    expect(tokens).toBeLessThan(280);
  });

  test("fast mode uses heuristic for very large text", () => {
    const large = "a".repeat(10_000);
    expect(estimateTokens(large, { mode: "fast" })).toBe(Math.ceil(large.length / 3.5));
  });

  test("fast mode keeps exact counts for normal-sized text", () => {
    const medium = "The quick brown fox jumps over the lazy dog. ".repeat(20);
    expect(estimateTokens(medium, { mode: "fast" })).toBe(estimateTokens(medium));
  });
});

describe("messageTokens", () => {
  test("extracts content and estimates", () => {
    const msg = {
      id: 1, conversation_id: "test", role: "user" as const,
      content: "Hello, world!", model: null, provider: null,
      tokens_in: 0, tokens_out: 0, cost_usd: 0, created_at: Date.now(),
    };
    const tokens = messageTokens(msg);
    expect(tokens).toBeGreaterThan(0);
  });

  test("supports fast mode for budget-path estimates", () => {
    const msg = {
      id: 2, conversation_id: "test", role: "assistant" as const,
      content: "b".repeat(10_000), model: null, provider: null,
      tokens_in: 0, tokens_out: 0, cost_usd: 0, created_at: Date.now(),
    };
    expect(messageTokens(msg, { mode: "fast" })).toBe(Math.ceil(msg.content.length / 3.5));
  });
});

describe("token discipline", () => {
  test("trims oversized envelopes while preserving head and tail", () => {
    const text = `start ${"middle ".repeat(2000)} end`;
    const result = trimTextToTokenBudget(text, 300, {
      marker: "[trimmed]",
      mode: "fast",
    });

    expect(result.trimmed).toBe(true);
    expect(result.originalTokenEstimate).toBeGreaterThan(result.tokenEstimate);
    expect(result.text).toContain("start");
    expect(result.text).toContain("[trimmed]");
    expect(result.text).toContain("end");
  });

  test("reports context pressure and large contributors", () => {
    const report = buildTokenDisciplineReport({
      scope: "test run",
      contextWindow: 1000,
      contributors: [
        { label: "system_prompt", charCount: 100, tokenEstimate: 200 },
        { label: "history", charCount: 1000, tokenEstimate: 650 },
      ],
    });

    expect(report.totalTokens).toBe(850);
    expect(report.utilizationPct).toBe(85);
    expect(report.warnings.some((warning) => warning.includes("85%"))).toBe(true);
    expect(report.warnings.some((warning) => warning.includes("\"history\""))).toBe(true);
  });
});

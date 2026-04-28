import { describe, test, expect } from "bun:test";
import { buildContextWindow } from "../context/budget.js";
import { estimateTokens } from "../context/tokens.js";
import type { StoredMessage } from "../memory/store.js";
import type { ContextBudget } from "../context/types.js";

function makeMsg(role: "user" | "assistant", content: string, id = 1): StoredMessage {
  return { id, conversation_id: "test", role, content, model: null, provider: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, created_at: Date.now() };
}

const DEFAULT_BUDGET: ContextBudget = {
  contextWindow: 200_000,
  budgetRatio: 0.5,
  systemPromptTokens: 500,
  responseReserve: 4096,
  historyBudget: 90_000,
};

describe("buildContextWindow", () => {
  test("returns empty for no messages", () => {
    const result = buildContextWindow([], null, DEFAULT_BUDGET);
    expect(result.messages).toHaveLength(0);
    expect(result.metrics.messageCount).toBe(0);
  });

  test("includes messages within budget", () => {
    const messages = [
      makeMsg("user", "Hello", 1),
      makeMsg("assistant", "Hi there", 2),
    ];
    const result = buildContextWindow(messages, null, DEFAULT_BUDGET);
    expect(result.messages).toHaveLength(2);
  });

  test("fresh_context strategy returns empty messages", () => {
    const messages = [
      makeMsg("user", "Hello", 1),
      makeMsg("assistant", "Hi there", 2),
    ];
    const result = buildContextWindow(messages, null, DEFAULT_BUDGET, {
      fresh_context: true,
    });
    expect(result.messages).toHaveLength(0);
  });

  test("includes summary prefix when present", () => {
    const messages = [makeMsg("user", "New question", 1)];
    const result = buildContextWindow(messages, "Previous summary", DEFAULT_BUDGET);
    // Summary is injected as a single context block (no fake assistant ack)
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    expect(result.messages[0].content).toContain("CONVERSATION SUMMARY");
    expect(result.messages[0].content).toContain("not dialogue");
    expect(result.messages[0].content).toContain("Previous summary");
  });

  test("respects include_summary=false", () => {
    const messages = [makeMsg("user", "Hello", 1)];
    const result = buildContextWindow(messages, "Some summary", DEFAULT_BUDGET, {
      include_summary: false,
    });
    expect(result.messages.every(m => !m.content.includes("CONVERSATION SUMMARY"))).toBe(true);
  });

  test("always includes most recent message", () => {
    const messages = [makeMsg("user", "My question", 1)];
    const tightBudget = { ...DEFAULT_BUDGET, historyBudget: 100 };
    const result = buildContextWindow(messages, null, tightBudget);
    expect(result.messages.some(m => m.content === "My question")).toBe(true);
  }, 10_000);

  test("max_messages cap limits history", () => {
    const messages = Array.from({ length: 20 }, (_, i) =>
      makeMsg(i % 2 === 0 ? "user" : "assistant", `Message ${i}`, i)
    );
    const result = buildContextWindow(messages, null, DEFAULT_BUDGET, { max_messages: 4 });
    expect(result.metrics.messageCount).toBeLessThanOrEqual(4);
  });

  test("returns metrics with correct message count", () => {
    const messages = [
      makeMsg("user", "Hello", 1),
      makeMsg("assistant", "Hi", 2),
      makeMsg("user", "Bye", 3),
    ];
    const result = buildContextWindow(messages, null, DEFAULT_BUDGET);
    expect(result.metrics.messageCount).toBe(3);
  });

  test("no summary injected when summary is null", () => {
    const messages = [makeMsg("user", "Hello", 1)];
    const result = buildContextWindow(messages, null, DEFAULT_BUDGET);
    expect(result.messages.every(m => !m.content.includes("CONVERSATION SUMMARY"))).toBe(true);
  });

  test("fresh_context with summary still returns empty messages", () => {
    const messages = [makeMsg("user", "Hello", 1)];
    const result = buildContextWindow(messages, "Some summary", DEFAULT_BUDGET, {
      fresh_context: true,
    });
    expect(result.messages).toHaveLength(0);
    expect(result.metrics.messageCount).toBe(0);
  });
});

describe("estimateTokens", () => {
  test("estimates tokens for text", () => {
    const tokens = estimateTokens("Hello world");
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  test("longer text has more tokens", () => {
    const short = estimateTokens("Hi");
    const long = estimateTokens("Hello, how are you doing today? I hope everything is well.");
    expect(long).toBeGreaterThan(short);
  });

  test("empty string returns 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("counts tokens accurately", () => {
    const tokens = estimateTokens("a".repeat(35));
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(35);
  });
});

describe("budget metering", () => {
  test("metrics include system prompt tokens", () => {
    const messages = [
      makeMsg("user", "Hello", 1),
      makeMsg("assistant", "Hi there", 2),
    ];
    const budgetWithSystemPrompt = { ...DEFAULT_BUDGET, systemPromptTokens: 5000 };
    const result = buildContextWindow(messages, null, budgetWithSystemPrompt);
    expect(result.metrics.systemPromptTokens).toBe(5000);
    expect(result.metrics.totalTokens).toBe(5000 + result.metrics.tokenCount);
  });

  test("fresh_context still reports system prompt tokens", () => {
    const result = buildContextWindow([], null, { ...DEFAULT_BUDGET, systemPromptTokens: 3000 }, { fresh_context: true });
    expect(result.metrics.systemPromptTokens).toBe(3000);
    expect(result.metrics.totalTokens).toBe(3000);
  });

  test("inject mode includes system prompt in totalTokens", () => {
    const messages = [makeMsg("user", "Hello", 1)];
    const result = buildContextWindow(messages, null, { ...DEFAULT_BUDGET, systemPromptTokens: 2000 }, { context_mode: "inject" as any });
    expect(result.metrics.systemPromptTokens).toBe(2000);
    expect(result.metrics.totalTokens).toBeGreaterThan(2000);
  });
});

describe("conversation quality fixes", () => {
  test("summary injection has no fake assistant acknowledgment", () => {
    const messages = [makeMsg("user", "Hello", 1)];
    const result = buildContextWindow(messages, "Some summary text", DEFAULT_BUDGET);
    // Should have context block + user message, but NO fake assistant ack
    const assistantMsgs = result.messages.filter(m => m.role === "assistant");
    const fakeAck = assistantMsgs.find(m => m.content.includes("Understood, I have the context"));
    expect(fakeAck).toBeUndefined();
  });

  test("summary is injected as clearly-marked context block", () => {
    const messages = [makeMsg("user", "Hello", 1)];
    const result = buildContextWindow(messages, "Important decision log", DEFAULT_BUDGET);
    const contextMsg = result.messages.find(m => m.content.includes("CONVERSATION SUMMARY"));
    expect(contextMsg).toBeDefined();
    expect(contextMsg!.content).toContain("Important decision log");
    expect(contextMsg!.content).toContain("neutral compressed state");
    expect(contextMsg!.content).toContain("not a prior user or assistant turn");
  });

  test("summary injection labels speaker-prefixed lines as non-dialogic notes", () => {
    const messages = [makeMsg("user", "Hello", 1)];
    const result = buildContextWindow(messages, "Assistant: I told User the fix was done.\nUser: User asked about tone.", DEFAULT_BUDGET);
    const contextMsg = result.messages[0].content;
    expect(contextMsg).toContain("Prior assistant note: I told User the fix was done.");
    expect(contextMsg).toContain("Prior user note: User asked about tone.");
    expect(contextMsg).not.toContain("Assistant:");
    expect(contextMsg).not.toContain("User:");
  });

  test("inject mode summary also has no fake assistant ack", () => {
    const messages = [makeMsg("user", "Hello", 1)];
    const result = buildContextWindow(messages, "Summary", DEFAULT_BUDGET, { context_mode: "inject" as any });
    const fakeAck = result.messages.find(m => m.content === "Understood, I have the context from our previous conversation.");
    expect(fakeAck).toBeUndefined();
  });

  test("budget starvation: small context window still provides usable budget", () => {
    // Simulate a small model where system prompt + reserve exceeds half the context
    const tinyBudget: ContextBudget = {
      contextWindow: 8000,
      budgetRatio: 0.5,
      systemPromptTokens: 3000,
      responseReserve: 4096,
      // Old formula: 8000 * 0.5 - 3000 - 4096 = -3096 → clamped to 1000
      // New formula: max(0, 8000 - 3000 - 4096) * 0.5 = 452 → clamped to 500
      historyBudget: Math.max(500, Math.floor(Math.max(0, 8000 - 3000 - 4096) * 0.5)),
    };
    expect(tinyBudget.historyBudget).toBe(500);
    expect(tinyBudget.historyBudget).toBeGreaterThan(0);

    const messages = [makeMsg("user", "Hello", 1), makeMsg("assistant", "Hi", 2)];
    const result = buildContextWindow(messages, null, tinyBudget);
    // Should still include messages even with tight budget
    expect(result.messages.length).toBeGreaterThan(0);
  });

  test("budget starvation: zero available space floors at 500", () => {
    // System prompt + reserve exceed context window entirely
    const impossibleBudget: ContextBudget = {
      contextWindow: 4000,
      budgetRatio: 0.5,
      systemPromptTokens: 3000,
      responseReserve: 4096,
      historyBudget: Math.max(500, Math.floor(Math.max(0, 4000 - 3000 - 4096) * 0.5)),
    };
    expect(impossibleBudget.historyBudget).toBe(500);
  });

  test("strategy override budget uses new formula", () => {
    const messages = [makeMsg("user", "Hello", 1)];
    const budget: ContextBudget = {
      contextWindow: 8000,
      budgetRatio: 0.5,
      systemPromptTokens: 2000,
      responseReserve: 4096,
      historyBudget: 500,
    };
    const result = buildContextWindow(messages, null, budget, { history_budget_ratio: 0.8 });
    // New formula: max(500, max(0, 8000 - 2000 - 4096) * 0.8) = max(500, 1523) = 1523
    // Should produce a usable budget, not negative
    expect(result.metrics.budgetTokens).toBeGreaterThan(0);
  });

  test("quarantines oversized machine output with a retrieval handle", () => {
    const noisyOutput = Array.from({ length: 260 }, (_, index) => `src/file-${index}.ts: ${"x".repeat(80)}`).join("\n");
    const messages = [
      makeMsg("user", "Run rg for websocket references", 1),
      makeMsg("assistant", `Command output:\n${noisyOutput}`, 2),
      makeMsg("user", "What matters from that?", 3),
    ];

    const result = buildContextWindow(messages, null, DEFAULT_BUDGET);
    const assistantMsg = result.messages.find((entry) => entry.role === "assistant");

    expect(assistantMsg?.content).toContain("[large machine output quarantined]");
    expect(assistantMsg?.content).toContain("handle: conversation=test message=2");
    expect(assistantMsg?.content).toContain("sha256:");
    expect(assistantMsg?.content).toContain("lines: 261");
    expect(assistantMsg?.content.length).toBeLessThan(2_000);
    expect(result.metrics.quarantinedOutputs).toBe(1);
    expect(result.metrics.truncated).toBe(true);
  });
});

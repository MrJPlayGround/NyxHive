import { describe, it, expect, setDefaultTimeout } from "bun:test";
import { buildContextWindow } from "../context/budget.js";
import type { ContextBudget } from "../context/types.js";
import type { StoredMessage } from "../memory/store.js";
import type { SoulContextStrategy } from "../soul/types.js";

setDefaultTimeout(20000);

function msg(role: "user" | "assistant", content: string): StoredMessage {
  return { role, content, created_at: new Date().toISOString() } as any;
}

const defaultBudget: ContextBudget = {
  contextWindow: 100000,
  budgetRatio: 0.4,
  systemPromptTokens: 2000,
  responseReserve: 4000,
  historyBudget: 10000,
};

describe("buildContextWindow", () => {
  it("returns empty array and zero metrics for empty messages", () => {
    const result = buildContextWindow([], null, defaultBudget);
    expect(result.messages).toEqual([]);
    expect(result.metrics.messageCount).toBe(0);
    expect(result.metrics.tokenCount).toBe(0);
    expect(result.metrics.truncated).toBe(false);
  });

  it("fresh_context strategy skips all messages", () => {
    const messages = [msg("user", "hello"), msg("assistant", "hi there")];
    const strategy: SoulContextStrategy = { fresh_context: true };
    const result = buildContextWindow(messages, "some summary", defaultBudget, strategy);
    expect(result.messages).toEqual([]);
    expect(result.metrics.messageCount).toBe(0);
    expect(result.metrics.tokenCount).toBe(0);
    expect(result.metrics.budgetTokens).toBe(defaultBudget.historyBudget);
  });

  it("inject mode returns only last N messages (default 3)", () => {
    const messages = [
      msg("user", "msg1"),
      msg("assistant", "msg2"),
      msg("user", "msg3"),
      msg("assistant", "msg4"),
      msg("user", "msg5"),
    ];
    const strategy: SoulContextStrategy = { context_mode: "inject" };
    const result = buildContextWindow(messages, null, defaultBudget, strategy);
    // Default recency is 3, no summary
    expect(result.messages.length).toBe(3);
    expect(result.messages[0].content).toBe("msg3");
    expect(result.messages[1].content).toBe("msg4");
    expect(result.messages[2].content).toBe("msg5");
    expect(result.metrics.messageCount).toBe(3);
    expect(result.metrics.truncated).toBe(true);
  });

  it("inject mode prepends summary as context block", () => {
    const messages = [msg("user", "hello"), msg("assistant", "hi")];
    const strategy: SoulContextStrategy = { context_mode: "inject" };
    const result = buildContextWindow(messages, "previous context here", defaultBudget, strategy);
    expect(result.messages.length).toBe(3); // summary + 2 messages
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toContain("[CONVERSATION SUMMARY");
    expect(result.messages[0].content).toContain("not dialogue");
    expect(result.messages[0].content).toContain("previous context here");
    expect(result.messages[1].content).toBe("hello");
    expect(result.messages[2].content).toBe("hi");
  });

  it("inject mode with custom recency returns only last message", () => {
    const messages = [
      msg("user", "first"),
      msg("assistant", "second"),
      msg("user", "third"),
    ];
    const strategy: SoulContextStrategy = { context_mode: "inject", inject_recency: 1 };
    const result = buildContextWindow(messages, null, defaultBudget, strategy);
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].content).toBe("third");
    expect(result.metrics.truncated).toBe(true);
  });

  it("inject mode strips code blocks when strategy says so", () => {
    const content = "Here is code:\n```typescript\nconst x = 1;\n```\nDone.";
    const messages = [msg("assistant", content)];
    const strategy: SoulContextStrategy = { context_mode: "inject", strip_code_blocks: true };
    const result = buildContextWindow(messages, null, defaultBudget, strategy);
    expect(result.messages[0].content).toContain("[code block removed]");
    expect(result.messages[0].content).not.toContain("const x = 1");
  });

  it("token-bounded walk selects messages newest-to-oldest until budget", () => {
    // Each short message is a few tokens; create enough to test ordering
    const messages = [
      msg("user", "one"),
      msg("assistant", "two"),
      msg("user", "three"),
      msg("assistant", "four"),
      msg("user", "five"),
    ];
    const result = buildContextWindow(messages, null, defaultBudget);
    // With a 10000 token budget and short messages, all should fit
    expect(result.messages.length).toBe(5);
    expect(result.messages[0].content).toBe("one");
    expect(result.messages[4].content).toBe("five");
    expect(result.metrics.truncated).toBe(false);
  });

  it("always preserves the most recent message even if it exceeds budget", () => {
    // Create a message that's bigger than the budget
    const bigContent = "x".repeat(5000); // Over the tiny budget
    const tinyBudget: ContextBudget = {
      ...defaultBudget,
      historyBudget: 100, // Very small budget
    };
    const messages = [msg("user", "old"), msg("user", bigContent)];
    const result = buildContextWindow(messages, null, tinyBudget);
    // The most recent message must always be included
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.messages[result.messages.length - 1].content).toContain("x");
  });

  it("strategy budget ratio override changes effective budget", () => {
    const ratio = 0.1;
    const expected = Math.max(
      500,
      Math.floor(
        Math.max(0, defaultBudget.contextWindow - defaultBudget.systemPromptTokens - defaultBudget.responseReserve) * ratio,
      ),
    );
    const messages = [msg("user", "hello")];
    const strategy: SoulContextStrategy = { history_budget_ratio: ratio };
    const result = buildContextWindow(messages, null, defaultBudget, strategy);
    expect(result.metrics.budgetTokens).toBe(expected);
  });

  it("max_messages caps messages before budget walk", () => {
    const messages = Array.from({ length: 20 }, (_, i) => msg(i % 2 === 0 ? "user" : "assistant", `msg ${i}`));
    const strategy: SoulContextStrategy = { max_messages: 5 };
    const result = buildContextWindow(messages, null, defaultBudget, strategy);
    // Should have at most 5 messages
    expect(result.messages.length).toBeLessThanOrEqual(5);
    // Last message should be the newest
    expect(result.messages[result.messages.length - 1].content).toBe("msg 19");
    // Should be marked truncated since we capped
    expect(result.metrics.truncated).toBe(true);
  });

  it("include_summary=false omits summary even when provided", () => {
    const messages = [msg("user", "hello")];
    const strategy: SoulContextStrategy = { include_summary: false };
    const result = buildContextWindow(messages, "some summary text", defaultBudget, strategy);
    // No summary message should appear
    const summaryMsg = result.messages.find((m) => m.content.includes("CONVERSATION SUMMARY"));
    expect(summaryMsg).toBeUndefined();
  });

  it("truncates large assistant response middle when >80% of budget", () => {
    // Create a very large assistant message that exceeds 80% of budget
    const largeBudget: ContextBudget = {
      ...defaultBudget,
      historyBudget: 500, // Small budget to trigger truncation
    };
    // Need content that's > 80% of 500 tokens ~ 400+ tokens ~ 1400+ chars
    const bigAssistantContent = "Start of response.\n\n" + "Middle content. ".repeat(500) + "\n\nEnd of response.";
    const messages = [msg("user", "question"), msg("assistant", bigAssistantContent)];
    const result = buildContextWindow(messages, null, largeBudget);
    const assistantMsg = result.messages.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg!.content).toContain("[...history message trimmed for token budget...]");
    expect(assistantMsg!.content).toContain("Start of response");
    expect(assistantMsg!.content).toContain("End of response");
  });

  it("summary injection uses correct prefix format", () => {
    const messages = [msg("user", "hi")];
    const result = buildContextWindow(messages, "The user discussed weather", defaultBudget);
    const summaryMsg = result.messages[0];
    expect(summaryMsg.role).toBe("user");
    expect(summaryMsg.content).toBe(
      "[CONVERSATION SUMMARY \u2014 neutral compressed state, not dialogue, not a prior user or assistant turn]\nThe user discussed weather",
    );
  });

  it("metrics accuracy: truncated flag and utilizationPct", () => {
    // All messages fit => not truncated
    const smallMessages = [msg("user", "hi"), msg("assistant", "hello")];
    const result1 = buildContextWindow(smallMessages, null, defaultBudget);
    expect(result1.metrics.truncated).toBe(false);
    expect(result1.metrics.utilizationPct).toBeGreaterThanOrEqual(0);
    expect(result1.metrics.utilizationPct).toBeLessThanOrEqual(100);
    expect(result1.metrics.systemPromptTokens).toBe(defaultBudget.systemPromptTokens);
    expect(result1.metrics.totalTokens).toBe(defaultBudget.systemPromptTokens + result1.metrics.tokenCount);

    // With tiny budget and many long messages => truncated
    // remainingBudget floor is 500 tokens (~1750 chars), so we need messages exceeding that
    const tinyBudget: ContextBudget = { ...defaultBudget, historyBudget: 500 };
    const manyMessages = Array.from({ length: 50 }, (_, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", `message number ${i} ${"padding ".repeat(100)}`),
    );
    const result2 = buildContextWindow(manyMessages, null, tinyBudget);
    expect(result2.metrics.truncated).toBe(true);
  });
});

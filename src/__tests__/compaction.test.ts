import { describe, test, expect, setDefaultTimeout } from "bun:test";
import { CompactionManager } from "../context/compaction.js";
import { scoreMessage, scoreMessages, selectEvictions } from "../context/scoring.js";
import { compactSummary } from "../context/summarize.js";
import { MemoryStore, type StoredMessage } from "../memory/store.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

setDefaultTimeout(20000);

function createTestMemory(): MemoryStore {
  const dir = mkdtempSync(join(tmpdir(), "compaction-test-"));
  return new MemoryStore(dir, "test");
}

function makeMessage(id: number, role: string, content: string): StoredMessage {
  return { id, conversation_id: "test", role, content, model: null, provider: null, tokens_in: 0, tokens_out: 0, cost_usd: 0, created_at: Date.now() };
}

describe("CompactionManager", () => {
  test("does not compact when below threshold", async () => {
    const manager = new CompactionManager();
    const memory = createTestMemory();
    const router = { route: () => ({ provider: "test", model: "test" }), complete: async () => ({ content: "summary" }) } as any;

    memory.ensureConversation("test:user", "test", "user");
    for (let i = 0; i < 5; i++) {
      memory.saveMessage("test:user", "user", `Message ${i}`, null, null, 0, 0, 0);
      memory.saveMessage("test:user", "assistant", `Reply ${i}`, null, null, 0, 0, 0);
    }

    const result = await manager.checkAndCompact("test:user", "claude-opus-4-6", memory, router);
    expect(result.band).toBe("green");
    expect(manager.getEvents()).toHaveLength(0);
  });

  test("does not compact when too few messages", async () => {
    const manager = new CompactionManager();
    const memory = createTestMemory();
    const router = {} as any;

    memory.ensureConversation("test:user", "test", "user");
    memory.saveMessage("test:user", "user", "Hello", null, null, 0, 0, 0);
    memory.saveMessage("test:user", "assistant", "Hi", null, null, 0, 0, 0);

    const result = await manager.checkAndCompact("test:user", "claude-opus-4-6", memory, router);
    expect(result.band).toBe("green");
  });

  test("respects cooldown", async () => {
    const manager = new CompactionManager();
    const memory = createTestMemory();
    const router = {} as any;

    memory.ensureConversation("test:user", "test", "user");
    for (let i = 0; i < 10; i++) {
      memory.saveMessage("test:user", "user", `Message ${i}`, null, null, 0, 0, 0);
    }

    await manager.checkAndCompact("test:user", "claude-opus-4-6", memory, router);
    const events1 = manager.getEvents().length;
    await manager.checkAndCompact("test:user", "claude-opus-4-6", memory, router);
    const events2 = manager.getEvents().length;
    expect(events2).toBe(events1);
  });

  test("getConversationStats returns correct data", () => {
    const manager = new CompactionManager();
    const stats = manager.getConversationStats("test:user");
    expect(stats.lastCompaction).toBeNull();
    expect(stats.eventCount).toBe(0);
  });

  test("getEvents returns empty initially", () => {
    const manager = new CompactionManager();
    expect(manager.getEvents()).toHaveLength(0);
    expect(manager.getEvents(5)).toHaveLength(0);
  });

  test("assessPressure returns green for empty conversation", () => {
    const manager = new CompactionManager();
    const memory = createTestMemory();
    memory.ensureConversation("test:user", "test", "user");

    const pressure = manager.assessPressure("test:user", "claude-opus-4-6", memory);
    expect(pressure.band).toBe("green");
    expect(pressure.utilizationPct).toBe(0);
  });

  test("formatPressureSignal returns null for green", () => {
    const manager = new CompactionManager();
    const signal = manager.formatPressureSignal({ band: "green", utilizationPct: 30, estimatedTurnsRemaining: 100 });
    expect(signal).toBeNull();
  });

  test("formatPressureSignal returns signal for yellow", () => {
    const manager = new CompactionManager();
    const signal = manager.formatPressureSignal({ band: "yellow", utilizationPct: 65, estimatedTurnsRemaining: 15 });
    expect(signal).toContain("yellow");
    expect(signal).toContain("65%");
    expect(signal).toContain("15 turns");
  });

  test("formatPressureSignal includes concise hint for red", () => {
    const manager = new CompactionManager();
    const signal = manager.formatPressureSignal({ band: "red", utilizationPct: 92, estimatedTurnsRemaining: 3 });
    expect(signal).toContain("red");
    expect(signal).toContain("concise");
  });

  test("custom thresholds are respected", () => {
    const manager = new CompactionManager({ yellow: 0.50, orange: 0.70, red: 0.85 });
    const memory = createTestMemory();
    memory.ensureConversation("test:user", "test", "user");

    const pressure = manager.assessPressure("test:user", "claude-opus-4-6", memory);
    expect(pressure.band).toBe("green");
  });

  test("summary injection counts toward pressure", () => {
    const manager = new CompactionManager();
    const memory = createTestMemory();
    memory.ensureConversation("test:user", "test", "user");
    memory.saveConversationSummary("test:user", "Decision log. ".repeat(40000));

    const pressure = manager.assessPressure("test:user", "claude-opus-4-6", memory);
    expect(pressure.band).not.toBe("green");
    expect(pressure.utilizationPct).toBeGreaterThan(60);
  });

  test("fifth summary cycle forces full re-summarization and resets the counter", () => {
    const manager = new CompactionManager();
    for (let i = 0; i < 4; i++) {
      const cycle = manager.prepareSummaryCycle("test:user");
      expect(cycle.forceFullResummarization).toBe(false);
      manager.finalizeSummaryCycle("test:user", cycle, `**Key Decisions:** ${i}`);
    }

    const fifthCycle = manager.prepareSummaryCycle("test:user");
    expect(fifthCycle.forceFullResummarization).toBe(true);
    manager.finalizeSummaryCycle("test:user", fifthCycle, "**Key Decisions:** rebuilt");

    const nextCycle = manager.prepareSummaryCycle("test:user");
    expect(nextCycle.generationCount).toBe(1);
    expect(nextCycle.forceFullResummarization).toBe(false);
  });

  test("red-band emergency recovery trims to four messages and flags manual review when still over 85%", async () => {
    const manager = new CompactionManager();
    (manager as any).getAvailableBudget = () => 850;
    const memory = createTestMemory();
    const router = {
      route: () => ({ provider: "test", model: "test" }),
      complete: async () => ({ content: "**Key Decisions:** Emergency summary\n**Open Items:** Review remaining payload size" }),
    } as any;

    memory.ensureConversation("test:user", "test", "user");
    for (let i = 0; i < 4; i++) {
      memory.saveMessage("test:user", "user", `Older message ${i}`, null, null, 0, 0, 0);
    }
    for (let i = 0; i < 4; i++) {
      memory.saveMessage(
        "test:user",
        "assistant",
        `Before ${"x".repeat(1500)}\n\`\`\`ts\nconst value = ${i};\n\`\`\`\nAfter ${i}`,
        null,
        null,
        0,
        0,
        0,
      );
    }

    const before = manager.assessPressure("test:user", "claude-opus-4-6", memory);
    expect(before.band).toBe("red");

    await manager.checkAndCompact("test:user", "claude-opus-4-6", memory, router);

    const remaining = memory.getMessages("test:user", 10);
    expect(remaining).toHaveLength(4);
    expect(remaining.every((msg) => !msg.content.includes("```"))).toBe(true);

    const pressure = manager.assessPressure("test:user", "claude-opus-4-6", memory);
    expect(pressure.summaryOnlyMode).toBe(true);
    expect(pressure.manualReviewRequired).toBe(true);

    const override = manager.getContextStrategyOverride("test:user", "claude-opus-4-6", memory);
    expect(override?.context_mode).toBe("inject");
    expect(override?.inject_recency).toBe(4);
    expect(override?.strip_code_blocks).toBe(true);
  });
});

describe("Message Scoring", () => {
  test("user constraint gets high score", () => {
    const msg = makeMessage(1, "user", "You must never use mocks in integration tests");
    const score = scoreMessage(msg, 0, 10);
    expect(score.score).toBeGreaterThanOrEqual(40);
    expect(score.signals).toContain("user_constraint");
  });

  test("delegation reference gets high score", () => {
    const msg = makeMessage(2, "assistant", "[@agent: Tester] run the full test suite");
    const score = scoreMessage(msg, 0, 10);
    expect(score.score).toBeGreaterThanOrEqual(35);
    expect(score.signals).toContain("delegation_ref");
  });

  test("short acknowledgment gets penalized", () => {
    const msg = makeMessage(3, "assistant", "Got it, working on it.");
    const score = scoreMessage(msg, 0, 10);
    expect(score.signals).toContain("ack_only");
  });

  test("recent messages get boost", () => {
    const msg = makeMessage(4, "user", "Hello");
    const scoreRecent = scoreMessage(msg, 9, 10);
    const scoreOld = scoreMessage(msg, 0, 10);
    expect(scoreRecent.score).toBeGreaterThan(scoreOld.score);
  });

  test("decision with rationale gets scored", () => {
    const msg = makeMessage(5, "assistant", "We chose SQLite because it simplifies deployment and avoids external dependencies");
    const score = scoreMessage(msg, 0, 10);
    expect(score.signals).toContain("decision");
  });

  test("tool outcome with file path gets scored", () => {
    const msg = makeMessage(6, "assistant", "Created src/context/scoring.ts with the importance scoring logic");
    const score = scoreMessage(msg, 0, 10);
    expect(score.signals).toContain("tool_outcome");
  });

  test("repeated information gets penalized", () => {
    const messages: StoredMessage[] = [
      makeMessage(1, "assistant", "Updated src/context/compaction.ts to switch eviction to message scoring with score-based trimming"),
      makeMessage(2, "assistant", "Updated src/context/compaction.ts to switch eviction to message scoring with score-based trimming"),
    ];
    const scores = scoreMessages(messages);
    const first = scores.find((score) => score.messageId === 1);
    const second = scores.find((score) => score.messageId === 2);

    expect(first?.signals).not.toContain("repeated_info");
    expect(second?.signals).toContain("repeated_info");
  });

  test("scoreMessages sorts ascending", () => {
    const messages: StoredMessage[] = [
      makeMessage(1, "user", "You must always validate input"),
      makeMessage(2, "assistant", "Ok"),
      makeMessage(3, "assistant", "Created src/foo.ts because it was the right approach"),
    ];
    const scores = scoreMessages(messages);
    expect(scores[0].score).toBeLessThanOrEqual(scores[scores.length - 1].score);
  });

  test("selectEvictions preserves recent messages", () => {
    const messages: StoredMessage[] = Array.from({ length: 10 }, (_, i) =>
      makeMessage(i + 1, i % 2 === 0 ? "user" : "assistant", `Message ${i + 1} with some content to fill tokens`),
    );
    const scores = scoreMessages(messages);
    const evicted = selectEvictions(messages, scores, 99999, (c) => c.length / 3.5, 4);

    // Last 4 messages should never be evicted
    for (let i = 7; i <= 10; i++) {
      expect(evicted.has(i)).toBe(false);
    }
  });

  test("selectEvictions keeps an old constraint over low-value acknowledgments", () => {
    const messages: StoredMessage[] = [
      makeMessage(1, "user", "Always preserve the user's stated risk limits in the final answer"),
      makeMessage(2, "assistant", "Got it."),
      makeMessage(3, "assistant", "Working on it."),
      makeMessage(4, "assistant", "Ok."),
      makeMessage(5, "assistant", "Status noted."),
      makeMessage(6, "user", "Recent context one"),
      makeMessage(7, "assistant", "Recent context two"),
      makeMessage(8, "user", "Recent context three"),
      makeMessage(9, "assistant", "Recent context four"),
    ];

    const evicted = selectEvictions(
      messages,
      scoreMessages(messages),
      40,
      () => 10,
      4,
      6,
    );

    expect(evicted.has(1)).toBe(false);
    expect(evicted.has(2) || evicted.has(3) || evicted.has(4) || evicted.has(5)).toBe(true);
  });
});

describe("Summary Hygiene", () => {
  test("compactSummary preserves Key Decisions", () => {
    const summary = [
      "**Key Decisions:** Used SQLite for persistence because it simplifies deployment.",
      "**Work Done:**",
      "- Built the scoring module",
      "- Updated compaction manager",
      "- Added tests",
      "- Refactored summarize.ts",
      "- Fixed type exports",
      "- Updated processor integration",
      "- Added pressure signal to system prompt",
      "**Context:** Working on long-context compaction for NyxHive gateway.",
      "**Open Items:** Need to verify red-band emergency recovery in production.",
    ].join("\n");

    const result = compactSummary(summary, 50); // very tight budget forces compression
    expect(result).toContain("Key Decisions");
    expect(result).toContain("SQLite");
  });

  test("compactSummary returns original if within budget", () => {
    const summary = "**Key Decisions:** Short summary.";
    const result = compactSummary(summary, 5000);
    expect(result).toBe(summary);
  });

  test("compactSummary keeps only recent work items and current context state", () => {
    const summary = [
      "**Work Done:**",
      "- Old item 1 with verbose historical detail that should be compacted away",
      "- Old item 2 with verbose historical detail that should be compacted away",
      "- Old item 3 with verbose historical detail that should be compacted away",
      "- Old item 4 with verbose historical detail that should be compacted away",
      "- Recent item 5 with meaningful recent progress",
      "- Recent item 6 with meaningful recent progress",
      "- Recent item 7 with meaningful recent progress",
      "**Context:**",
      "Current state: emergency compaction is wired.",
      "- Historical detail that should drop",
      "**Open Items:**",
      "- Verify manual review alerting",
    ].join("\n");

    const result = compactSummary(summary, 120);
    expect(result).not.toContain("Old item 1");
    expect(result).toContain("Recent item 7");
    expect(result).toContain("Current state: emergency compaction is wired.");
    expect(result).not.toContain("Historical detail");
  });
});

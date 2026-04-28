import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemoryStore } from "../memory/store.js";
import { TraceStore } from "../memory/traces.js";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("MemoryStore", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-memory-test-"));
    store = new MemoryStore(tmpDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("constructor", () => {
    test("creates database file with default name", () => {
      expect(existsSync(join(tmpDir, "memory.db"))).toBe(true);
    });

    test("creates database file with custom project name", () => {
      const customStore = new MemoryStore(tmpDir, "TestProject");
      expect(existsSync(join(tmpDir, "testproject.db"))).toBe(true);
      customStore.close();
    });
  });

  describe("conversations", () => {
    test("ensureConversation creates a new conversation", () => {
      store.ensureConversation("conv-1", "telegram", "123");
      store.saveMessage("conv-1", "user", "hello", null, null, 0, 0, 0);
      expect(store.getMessageCount("conv-1")).toBe(1);
    });

    test("ensureConversation upserts on duplicate id", () => {
      store.ensureConversation("conv-1", "telegram", "123");
      store.ensureConversation("conv-1", "telegram", "123");
      expect(store.getMessageCount("conv-1")).toBe(0);
    });
  });

  describe("messages", () => {
    test("saveMessage and getMessages roundtrip", () => {
      store.ensureConversation("conv-1", "telegram", "123");
      store.saveMessage("conv-1", "user", "hello", "gpt-4", "openai", 10, 20, 0.001);
      const messages = store.getMessages("conv-1");
      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("hello");
      expect(messages[0].model).toBe("gpt-4");
      expect(messages[0].provider).toBe("openai");
      expect(messages[0].tokens_in).toBe(10);
      expect(messages[0].tokens_out).toBe(20);
      expect(messages[0].cost_usd).toBe(0.001);
    });

    test("getMessages returns in chronological order", () => {
      store.ensureConversation("conv-1", "telegram", "123");
      store.saveMessage("conv-1", "user", "first", null, null, 0, 0, 0);
      store.saveMessage("conv-1", "assistant", "second", null, null, 0, 0, 0);
      store.saveMessage("conv-1", "user", "third", null, null, 0, 0, 0);
      const messages = store.getMessages("conv-1");
      expect(messages[0].content).toBe("first");
      expect(messages[1].content).toBe("second");
      expect(messages[2].content).toBe("third");
    });

    test("getMessages respects limit", () => {
      store.ensureConversation("conv-1", "telegram", "123");
      for (let i = 0; i < 10; i++) {
        store.saveMessage("conv-1", "user", `msg-${i}`, null, null, 0, 0, 0);
      }
      const messages = store.getMessages("conv-1", 3);
      expect(messages.length).toBe(3);
      expect(messages[0].content).toBe("msg-7");
      expect(messages[1].content).toBe("msg-8");
      expect(messages[2].content).toBe("msg-9");
    });

    test("getMessageCount is accurate", () => {
      store.ensureConversation("conv-1", "telegram", "123");
      expect(store.getMessageCount("conv-1")).toBe(0);
      store.saveMessage("conv-1", "user", "one", null, null, 0, 0, 0);
      expect(store.getMessageCount("conv-1")).toBe(1);
      store.saveMessage("conv-1", "user", "two", null, null, 0, 0, 0);
      expect(store.getMessageCount("conv-1")).toBe(2);
    });
  });

  describe("clearConversation", () => {
    test("removes messages and summaries", () => {
      store.ensureConversation("conv-1", "telegram", "123");
      store.saveMessage("conv-1", "user", "hello", null, null, 0, 0, 0);
      store.saveMessage("conv-1", "assistant", "hi", null, null, 0, 0, 0);
      store.saveConversationSummary("conv-1", "User said hello");
      store.clearConversation("conv-1");
      expect(store.getMessageCount("conv-1")).toBe(0);
      expect(store.getMessages("conv-1")).toEqual([]);
      expect(store.getConversationSummary("conv-1")).toBeNull();
    });
  });

  describe("trimOldMessages", () => {
    test("keeps only recent N messages", () => {
      store.ensureConversation("conv-1", "telegram", "123");
      for (let i = 0; i < 10; i++) {
        store.saveMessage("conv-1", "user", `msg-${i}`, null, null, 0, 0, 0);
      }
      store.trimOldMessages("conv-1", 3);
      const messages = store.getMessages("conv-1");
      expect(messages.length).toBe(3);
      expect(messages[0].content).toBe("msg-7");
      expect(messages[1].content).toBe("msg-8");
      expect(messages[2].content).toBe("msg-9");
    });
  });

  describe("memories", () => {
    test("saveMemory and listMemories roundtrip", () => {
      const id = store.saveMemory("Test memory", "fact", "user");
      expect(id).toBeGreaterThan(0);
      const memories = store.listMemories();
      expect(memories.length).toBe(1);
      expect(memories[0].content).toBe("Test memory");
      expect(memories[0].category).toBe("fact");
      expect(memories[0].source).toBe("user");
    });

    test("saveMemory with no category or source stores nulls", () => {
      store.saveMemory("bare memory");
      const memories = store.listMemories();
      expect(memories[0].category).toBeNull();
      expect(memories[0].source).toBeNull();
    });

    test("listMemories respects limit", () => {
      for (let i = 0; i < 10; i++) store.saveMemory(`memory-${i}`);
      expect(store.listMemories(3).length).toBe(3);
    });

    test("searchMemories finds by keyword", () => {
      store.saveMemory("The NyxHive platform uses SQLite for storage");
      store.saveMemory("Telegram bot handles user messages");
      const results = store.searchMemories("NyxHive SQLite");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("NyxHive");
    });

    test("searchMemories returns empty for no match", () => {
      store.saveMemory("Something about cats");
      expect(store.searchMemories("quantum physics")).toEqual([]);
    });

    test("searchMemories returns empty for very short query words", () => {
      store.saveMemory("A B C D E");
      expect(store.searchMemories("A B")).toEqual([]);
    });

    test("deleteMemory removes entry", () => {
      const id = store.saveMemory("To be deleted");
      store.deleteMemory(id);
      expect(store.listMemories().length).toBe(0);
    });
  });

  describe("summaries", () => {
    test("saveConversationSummary and getConversationSummary roundtrip", () => {
      store.ensureConversation("conv-1", "telegram", "123");
      store.saveConversationSummary("conv-1", "User discussed NyxHive features");
      expect(store.getConversationSummary("conv-1")).toBe("User discussed NyxHive features");
    });

    test("getConversationSummary returns null for no summary", () => {
      expect(store.getConversationSummary("nonexistent")).toBeNull();
    });

    test("saveConversationSummary upserts on same conversation", () => {
      store.ensureConversation("conv-1", "telegram", "123");
      store.saveConversationSummary("conv-1", "First summary");
      store.saveConversationSummary("conv-1", "Updated summary");
      expect(store.getConversationSummary("conv-1")).toBe("Updated summary");
    });
  });

  describe("usage tracking (via trace_events)", () => {
    let traces: TraceStore;

    beforeEach(() => {
      traces = new TraceStore(store.getDb());
    });

    function seedTrace(agent: string, model: string, tokensIn: number, tokensOut: number, cost: number): void {
      const traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      traces.startTrace({ id: traceId, channel: "test", sender: "tester", inputMessage: "test" });
      const eventId = traces.startEvent(traceId, agent, "test task");
      traces.completeEvent(eventId, { tokensIn, tokensOut, cost, model, taskType: "analysis" });
      traces.completeTrace(traceId, "done");
    }

    test("getUsageSummary aggregates from trace_events", () => {
      seedTrace("forge", "claude-sonnet", 100, 200, 0.01);
      seedTrace("forge", "claude-sonnet", 150, 300, 0.02);
      seedTrace("nyx", "qwen3", 50, 100, 0.005);
      const summary = store.getUsageSummary(24);
      expect(summary.length).toBe(2);
      const forgeRow = summary.find((s) => s.agent === "forge");
      expect(forgeRow).toBeDefined();
      expect(forgeRow!.total_tokens_in).toBe(250);
      expect(forgeRow!.total_tokens_out).toBe(500);
      expect(forgeRow!.total_cost).toBeCloseTo(0.03);
      expect(forgeRow!.count).toBe(2);
    });

    test("getTotalCost sums correctly", () => {
      seedTrace("forge", "claude", 100, 200, 0.01);
      seedTrace("nyx", "qwen", 50, 100, 0.005);
      expect(store.getTotalCost(24)).toBeCloseTo(0.015);
    });

    test("getTotalCost returns 0 when no usage exists", () => {
      expect(store.getTotalCost(24)).toBe(0);
    });
  });

  describe("work log", () => {
    test("saveWorkLog and getWorkLog roundtrip", () => {
      store.saveWorkLog("forge", "Fix bug in tools.ts", "Done. Replaced execSync with spawn.", "discord", 5000);
      const logs = store.getWorkLog("forge");
      expect(logs.length).toBe(1);
      expect(logs[0].agent_key).toBe("forge");
      expect(logs[0].task).toBe("Fix bug in tools.ts");
      expect(logs[0].result).toBe("Done. Replaced execSync with spawn.");
      expect(logs[0].channel).toBe("discord");
      expect(logs[0].duration_ms).toBe(5000);
      expect(logs[0].created_at).toBeGreaterThan(0);
    });

    test("getWorkLog returns chronological order (oldest first)", () => {
      store.saveWorkLog("forge", "task-1", "result-1", "discord");
      store.saveWorkLog("forge", "task-2", "result-2", "discord");
      store.saveWorkLog("forge", "task-3", "result-3", "discord");
      const logs = store.getWorkLog("forge");
      expect(logs[0].task).toBe("task-1");
      expect(logs[1].task).toBe("task-2");
      expect(logs[2].task).toBe("task-3");
    });

    test("getWorkLog respects limit", () => {
      for (let i = 0; i < 10; i++) {
        store.saveWorkLog("forge", `task-${i}`, `result-${i}`, "discord");
      }
      const logs = store.getWorkLog("forge", 3);
      expect(logs.length).toBe(3);
      // Should return the 3 most recent, in chronological order
      expect(logs[0].task).toBe("task-7");
      expect(logs[1].task).toBe("task-8");
      expect(logs[2].task).toBe("task-9");
    });

    test("getWorkLog isolates by agent_key", () => {
      store.saveWorkLog("forge", "forge-task", "forge-result", "discord");
      store.saveWorkLog("analyst", "analyst-task", "analyst-result", "discord");
      const forgeLogs = store.getWorkLog("forge");
      const analystLogs = store.getWorkLog("analyst");
      expect(forgeLogs.length).toBe(1);
      expect(forgeLogs[0].task).toBe("forge-task");
      expect(analystLogs.length).toBe(1);
      expect(analystLogs[0].task).toBe("analyst-task");
    });

    test("saveWorkLog prunes entries beyond maxEntries", () => {
      for (let i = 0; i < 25; i++) {
        store.saveWorkLog("forge", `task-${i}`, `result-${i}`, "discord");
      }
      // Default max is 20, so only 20 should remain
      const allLogs = store.getWorkLog("forge", 100);
      expect(allLogs.length).toBe(20);
      // Oldest surviving should be task-5 (0-4 pruned)
      expect(allLogs[0].task).toBe("task-5");
    });

    test("saveWorkLog truncates result to 4000 chars", () => {
      const longResult = "x".repeat(5000);
      store.saveWorkLog("forge", "task", longResult, "discord");
      const logs = store.getWorkLog("forge");
      expect(logs[0].result.length).toBe(4000);
    });

    test("clearWorkLog removes all entries for agent", () => {
      store.saveWorkLog("forge", "task-1", "result-1", "discord");
      store.saveWorkLog("forge", "task-2", "result-2", "discord");
      store.saveWorkLog("analyst", "task-3", "result-3", "discord");
      store.clearWorkLog("forge");
      expect(store.getWorkLog("forge").length).toBe(0);
      expect(store.getWorkLog("analyst").length).toBe(1);
    });

    test("clearWorkLog with no agent clears all entries", () => {
      store.saveWorkLog("forge", "task-1", "result-1", "discord");
      store.saveWorkLog("analyst", "task-2", "result-2", "discord");
      store.clearWorkLog();
      expect(store.getWorkLog("forge").length).toBe(0);
      expect(store.getWorkLog("analyst").length).toBe(0);
    });

    test("getWorkLog returns empty array when no entries exist", () => {
      expect(store.getWorkLog("forge")).toEqual([]);
    });

    test("saveWorkLog works without optional channel and duration", () => {
      store.saveWorkLog("forge", "task", "result");
      const logs = store.getWorkLog("forge");
      expect(logs.length).toBe(1);
      expect(logs[0].channel).toBeNull();
      expect(logs[0].duration_ms).toBeNull();
    });
  });

  describe("message ordering", () => {
    test("same-timestamp messages maintain insertion order via id tie-breaker", () => {
      store.ensureConversation("conv-order", "test", "user1");

      // Save multiple messages — they'll get the same Date.now() in a fast loop
      // but different auto-increment IDs
      for (let i = 0; i < 5; i++) {
        store.saveMessage("conv-order", i % 2 === 0 ? "user" : "assistant", `msg-${i}`, null, null, 0, 0, 0);
      }

      const messages = store.getMessages("conv-order", 10);
      // Messages should be in chronological (insertion) order
      expect(messages.length).toBe(5);
      for (let i = 0; i < 5; i++) {
        expect(messages[i].content).toBe(`msg-${i}`);
      }
    });

    test("getLastMessages also maintains order with id tie-breaker", () => {
      store.ensureConversation("conv-last", "test", "user1");
      for (let i = 0; i < 5; i++) {
        store.saveMessage("conv-last", "user", `msg-${i}`, null, null, 0, 0, 0);
      }
      const last3 = store.getLastMessages("conv-last", 3);
      expect(last3.length).toBe(3);
      expect(last3[0].content).toBe("msg-2");
      expect(last3[1].content).toBe("msg-3");
      expect(last3[2].content).toBe("msg-4");
    });
  });
});

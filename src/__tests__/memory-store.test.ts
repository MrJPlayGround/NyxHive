import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryStore } from "../memory/store.js";
import { buildThreadArtifactSourceUri } from "../memory/retrieval-trace.js";

describe("MemoryStore", () => {
  let tmpDir: string;
  let store: MemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-memstore-"));
    store = new MemoryStore(tmpDir);
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- Constructor ---

  describe("constructor", () => {
    it("creates database file in data dir", () => {
      const { existsSync } = require("fs");
      expect(existsSync(join(tmpDir, "memory.db"))).toBe(true);
    });

    it("uses project name for db file", () => {
      const { existsSync } = require("fs");
      const s2 = new MemoryStore(tmpDir, "MyProject");
      expect(existsSync(join(tmpDir, "myproject.db"))).toBe(true);
      s2.close();
    });

    it("exposes underlying database via getDb", () => {
      const db = store.getDb();
      expect(db).toBeDefined();
      // Verify we can query it
      const row = db.query("SELECT 1 as val").get() as { val: number };
      expect(row.val).toBe(1);
    });
  });

  describe("context traces and artifacts", () => {
    it("persists context traces", () => {
      store.saveContextTrace("conv-1", "nyx", {
        agentKey: "nyx",
        mode: "sdk",
        totalTokens: 42,
        parts: [{ label: "soul", charCount: 12, tokenEstimate: 3, injected: true }],
      });

      const traces = store.getContextTraces("conv-1");
      expect(traces).toHaveLength(1);
      expect(traces[0].agent_key).toBe("nyx");
      expect(JSON.parse(traces[0].trace_json).totalTokens).toBe(42);
    });

    it("tracks thread artifacts and enqueues refresh on summary save", () => {
      const enqueued: Array<{ sourceUri: string; priority: number }> = [];
      store.setArtifactQueue({
        enqueue(job) {
          enqueued.push({ sourceUri: job.sourceUri, priority: job.priority });
        },
      });

      store.ensureConversation("conv-1", "discord", "channel-1");
      store.saveConversationSummary("conv-1", "Fresh summary");

      const artifact = store.getContextArtifact(buildThreadArtifactSourceUri("conv-1"));
      expect(artifact?.is_stale).toBe(1);
      expect(artifact?.source_kind).toBe("summary_artifact");
      expect(artifact?.source_label).toBe("conv-1");
      expect(enqueued).toContainEqual({
        sourceUri: buildThreadArtifactSourceUri("conv-1"),
        priority: 1,
      });
    });

    it("persists artifact provenance metadata", () => {
      store.saveContextArtifact({
        sourceUri: "knowledge:chunk:42",
        sourceType: "knowledge_chunk",
        sourceKind: "imported_docs",
        sourceLabel: "Ops Guide#Install",
        importBatchId: "batch-1",
        sourceHash: "hash-1",
        l0Abstract: "Install notes",
        l1Overview: "- Use the documented install path",
        generationModel: "test/model",
      });

      const artifact = store.getContextArtifact("knowledge:chunk:42");
      expect(artifact?.source_kind).toBe("imported_docs");
      expect(artifact?.source_label).toBe("Ops Guide#Install");
      expect(artifact?.import_batch_id).toBe("batch-1");

      const stats = store.getContextArtifactStats();
      expect(stats.by_kind.imported_docs).toBe(1);
    });
  });

  // --- Conversations ---

  describe("conversations", () => {
    it("creates a conversation with ensureConversation", () => {
      store.ensureConversation("conv-1", "discord", "ch-123");
      const db = store.getDb();
      const row = db.query("SELECT * FROM conversations WHERE id = ?").get("conv-1") as any;
      expect(row).toBeDefined();
      expect(row.channel).toBe("discord");
      expect(row.channel_id).toBe("ch-123");
      expect(row.created_at).toBeGreaterThan(0);
    });

    it("updates timestamp on duplicate ensureConversation", () => {
      store.ensureConversation("conv-1", "discord", "ch-123");
      const db = store.getDb();
      const first = db.query("SELECT updated_at FROM conversations WHERE id = ?").get("conv-1") as any;

      // Small delay to ensure different timestamp
      const before = Date.now();
      store.ensureConversation("conv-1", "discord", "ch-123");
      const second = db.query("SELECT updated_at FROM conversations WHERE id = ?").get("conv-1") as any;
      expect(second.updated_at).toBeGreaterThanOrEqual(before);
    });

    it("clearConversation removes conversation, messages, and summaries", () => {
      store.ensureConversation("conv-1", "discord", "ch-123");
      store.saveMessage("conv-1", "user", "hello", null, null, 0, 0, 0);
      store.saveConversationSummary("conv-1", "a summary");

      store.clearConversation("conv-1");

      const db = store.getDb();
      expect(db.query("SELECT * FROM conversations WHERE id = ?").get("conv-1")).toBeNull();
      expect(store.getMessageCount("conv-1")).toBe(0);
      expect(store.getConversationSummary("conv-1")).toBeNull();
    });

    it("clearConversation is safe on nonexistent conversation", () => {
      // Should not throw
      store.clearConversation("nonexistent");
    });
  });

  // --- Messages ---

  describe("messages", () => {
    beforeEach(() => {
      store.ensureConversation("conv-1", "discord", "ch-123");
    });

    it("saveMessage and getMessageCount", () => {
      expect(store.getMessageCount("conv-1")).toBe(0);

      store.saveMessage("conv-1", "user", "hello", "gpt-4", "openai", 10, 20, 0.01);
      expect(store.getMessageCount("conv-1")).toBe(1);

      store.saveMessage("conv-1", "assistant", "hi back", "gpt-4", "openai", 5, 15, 0.005);
      expect(store.getMessageCount("conv-1")).toBe(2);
    });

    it("getMessages returns chronological order", () => {
      store.saveMessage("conv-1", "user", "first", null, null, 0, 0, 0);
      store.saveMessage("conv-1", "assistant", "second", null, null, 0, 0, 0);
      store.saveMessage("conv-1", "user", "third", null, null, 0, 0, 0);

      const msgs = store.getMessages("conv-1");
      expect(msgs).toHaveLength(3);
      expect(msgs[0].content).toBe("first");
      expect(msgs[1].content).toBe("second");
      expect(msgs[2].content).toBe("third");
    });

    it("getMessages respects limit", () => {
      for (let i = 0; i < 10; i++) {
        store.saveMessage("conv-1", "user", `msg-${i}`, null, null, 0, 0, 0);
      }

      const msgs = store.getMessages("conv-1", 3);
      expect(msgs).toHaveLength(3);
      // Should be the 3 most recent in chronological order
      expect(msgs[0].content).toBe("msg-7");
      expect(msgs[1].content).toBe("msg-8");
      expect(msgs[2].content).toBe("msg-9");
    });

    it("getMessages returns empty array for unknown conversation", () => {
      expect(store.getMessages("nonexistent")).toEqual([]);
    });

    it("getMessages includes all fields", () => {
      store.saveMessage("conv-1", "user", "hello", "claude-3", "anthropic", 100, 200, 0.05);
      const msgs = store.getMessages("conv-1");
      expect(msgs).toHaveLength(1);
      const m = msgs[0];
      expect(m.id).toBeGreaterThan(0);
      expect(m.conversation_id).toBe("conv-1");
      expect(m.role).toBe("user");
      expect(m.content).toBe("hello");
      expect(m.model).toBe("claude-3");
      expect(m.provider).toBe("anthropic");
      expect(m.tokens_in).toBe(100);
      expect(m.tokens_out).toBe(200);
      expect(m.cost_usd).toBeCloseTo(0.05);
      expect(m.importance_score).toBeNull();
      expect(m.created_at).toBeGreaterThan(0);
    });

    it("updates and clears cached importance scores", () => {
      store.saveMessage("conv-1", "user", "keep this requirement", null, null, 0, 0, 0);
      const [message] = store.getMessages("conv-1");

      store.updateMessageImportanceScore("conv-1", message.id, 72);
      expect(store.getMessages("conv-1")[0].importance_score).toBe(72);

      store.clearImportanceScores("conv-1");
      expect(store.getMessages("conv-1")[0].importance_score).toBeNull();
    });

    it("getLastMessages works like getMessages", () => {
      store.saveMessage("conv-1", "user", "a", null, null, 0, 0, 0);
      store.saveMessage("conv-1", "assistant", "b", null, null, 0, 0, 0);
      store.saveMessage("conv-1", "user", "c", null, null, 0, 0, 0);

      const msgs = store.getLastMessages("conv-1", 2);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].content).toBe("b");
      expect(msgs[1].content).toBe("c");
    });

    it("deleteLastMessages removes N most recent", () => {
      store.saveMessage("conv-1", "user", "a", null, null, 0, 0, 0);
      store.saveMessage("conv-1", "assistant", "b", null, null, 0, 0, 0);
      store.saveMessage("conv-1", "user", "c", null, null, 0, 0, 0);

      const deleted = store.deleteLastMessages("conv-1", 2);
      expect(deleted).toBe(2);
      expect(store.getMessageCount("conv-1")).toBe(1);

      const remaining = store.getMessages("conv-1");
      expect(remaining[0].content).toBe("a");
    });

    it("deleteLastMessages returns 0 for empty conversation", () => {
      expect(store.deleteLastMessages("conv-1", 5)).toBe(0);
    });

    it("deleteMessage removes a specific message by id", () => {
      store.saveMessage("conv-1", "user", "keep", null, null, 0, 0, 0);
      store.saveMessage("conv-1", "user", "delete me", null, null, 0, 0, 0);

      const msgs = store.getMessages("conv-1");
      const toDelete = msgs.find((m) => m.content === "delete me")!;

      store.deleteMessage("conv-1", toDelete.id);
      expect(store.getMessageCount("conv-1")).toBe(1);
      expect(store.getMessages("conv-1")[0].content).toBe("keep");
    });

    it("deleteMessage is safe with nonexistent id", () => {
      store.deleteMessage("conv-1", 99999);
    });

    it("trimToRecent keeps only N most recent messages", () => {
      for (let i = 0; i < 10; i++) {
        store.saveMessage("conv-1", "user", `msg-${i}`, null, null, 0, 0, 0);
      }

      const removed = store.trimToRecent("conv-1", 3);
      expect(removed).toBe(7);
      expect(store.getMessageCount("conv-1")).toBe(3);

      const msgs = store.getMessages("conv-1");
      expect(msgs[0].content).toBe("msg-7");
      expect(msgs[2].content).toBe("msg-9");
    });

    it("trimToRecent returns 0 when no trimming needed", () => {
      store.saveMessage("conv-1", "user", "only one", null, null, 0, 0, 0);
      expect(store.trimToRecent("conv-1", 10)).toBe(0);
    });

    it("trimOldMessages keeps N most recent", () => {
      for (let i = 0; i < 5; i++) {
        store.saveMessage("conv-1", "user", `msg-${i}`, null, null, 0, 0, 0);
      }

      store.trimOldMessages("conv-1", 2);
      expect(store.getMessageCount("conv-1")).toBe(2);

      const msgs = store.getMessages("conv-1");
      expect(msgs[0].content).toBe("msg-3");
      expect(msgs[1].content).toBe("msg-4");
    });

    it("getMessageCount returns 0 for unknown conversation", () => {
      expect(store.getMessageCount("nonexistent")).toBe(0);
    });
  });

  // --- Message FTS5 Search ---

  describe("searchMessages", () => {
    beforeEach(() => {
      store.ensureConversation("conv-1", "discord", "general");
      store.ensureConversation("conv-2", "slack", "random");
    });

    it("finds messages matching keyword", () => {
      store.saveMessage("conv-1", "user", "deploy the application to production", null, null, 0, 0, 0);
      store.saveMessage("conv-1", "assistant", "sure, deploying now", null, null, 0, 0, 0);
      store.saveMessage("conv-2", "user", "what is for lunch", null, null, 0, 0, 0);

      const results = store.searchMessages("deploy");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.content.includes("deploy"))).toBe(true);
    });

    it("includes conversation channel info in results", () => {
      store.saveMessage("conv-1", "user", "important deployment update", null, null, 0, 0, 0);

      const results = store.searchMessages("deployment");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].channel).toBe("discord");
      expect(results[0].channel_id).toBe("general");
      expect(results[0].conversation_id).toBe("conv-1");
    });

    it("respects limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        store.saveMessage("conv-1", "user", `testing message number ${i}`, null, null, 0, 0, 0);
      }

      const results = store.searchMessages("testing", 3);
      expect(results).toHaveLength(3);
    });

    it("returns empty array for no matches", () => {
      store.saveMessage("conv-1", "user", "hello world", null, null, 0, 0, 0);
      expect(store.searchMessages("zzzyyyxxx")).toEqual([]);
    });

    it("returns empty for single-char query words (filtered out)", () => {
      // searchMessages filters words <= 1 char
      expect(store.searchMessages("a")).toEqual([]);
    });

    it("returns empty for empty query", () => {
      expect(store.searchMessages("")).toEqual([]);
    });
  });

  // --- Memories ---

  describe("memories", () => {
    it("saveMemory returns row id", () => {
      const id = store.saveMemory("User prefers TypeScript", "preference", "conversation");
      expect(id).toBeGreaterThan(0);
    });

    it("saveMemory with optional params", () => {
      const id = store.saveMemory("some fact");
      expect(id).toBeGreaterThan(0);

      const memories = store.listMemories();
      expect(memories[0].category).toBeNull();
      expect(memories[0].source).toBeNull();
      expect(memories[0].memory_type).toBe("user_stated_fact");
      expect(memories[0].currentness).toBe("current");
    });

    it("stores typed trust metadata and supersedes stale facts", () => {
      const oldId = store.saveMemory("User prefers JavaScript", {
        category: "preference",
        source: "conversation",
        memoryType: "inferred_preference",
        confidence: 0.5,
        sourceReliability: "assistant_inferred",
      });
      const newId = store.saveMemory("User prefers TypeScript", {
        category: "preference",
        source: "correction",
        memoryType: "user_stated_fact",
        confidence: 0.9,
        userConfirmed: true,
        supersedesId: oldId,
      });

      const memories = store.listMemories(10);
      const oldMemory = memories.find((m) => m.id === oldId)!;
      const newMemory = memories.find((m) => m.id === newId)!;
      expect(oldMemory.currentness).toBe("superseded");
      expect(oldMemory.superseded_by_id).toBe(newId);
      expect(newMemory.source_reliability).toBe("user_confirmed");
      expect(newMemory.confidence).toBe(0.9);
    });

    it("listMemories returns in reverse chronological order", () => {
      store.saveMemory("first");
      store.saveMemory("second");
      store.saveMemory("third");

      const memories = store.listMemories();
      expect(memories).toHaveLength(3);
      expect(memories[0].content).toBe("third");
      expect(memories[1].content).toBe("second");
      expect(memories[2].content).toBe("first");
    });

    it("listMemories respects limit", () => {
      for (let i = 0; i < 10; i++) {
        store.saveMemory(`memory-${i}`);
      }
      const memories = store.listMemories(3);
      expect(memories).toHaveLength(3);
    });

    it("deleteMemory removes a memory", () => {
      const id = store.saveMemory("to delete");
      store.deleteMemory(id);
      const memories = store.listMemories();
      expect(memories).toHaveLength(0);
    });

    it("deleteMemory is safe with nonexistent id", () => {
      store.deleteMemory(99999); // should not throw
    });

    it("listMemories includes all fields", () => {
      store.saveMemory("fact content", "category-x", "source-y");
      const m = store.listMemories()[0];
      expect(m.id).toBeGreaterThan(0);
      expect(m.content).toBe("fact content");
      expect(m.category).toBe("category-x");
      expect(m.source).toBe("source-y");
      expect(m.confidence).toBeGreaterThan(0);
      expect(m.status).toBe("current");
      expect(m.created_at).toBeGreaterThan(0);
    });

    it("exposes trust inspection metadata", () => {
      store.saveMemory("Assistant guessed this", { memoryType: "assistant_observation", confidence: 0.4 });
      const trust = store.listMemoryTrust()[0].trust;
      expect(trust.currentness).toBe("current");
      expect(trust.trusted).toBe(false);
      expect(trust.reasons).toContain("assistant_inferred");
    });
  });

  // --- Memory FTS5 Search ---

  describe("searchMemories", () => {
    it("finds memories by keyword", () => {
      store.saveMemory("TypeScript is preferred over JavaScript", "preference");
      store.saveMemory("SQLite for databases", "architecture");
      store.saveMemory("Bun runtime is fast", "preference");

      const results = store.searchMemories("TypeScript");
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].content).toContain("TypeScript");
    });

    it("filters words with 2 or fewer chars", () => {
      store.saveMemory("important data here");
      // "ab" is 2 chars, filtered by searchMemories (filter > 2)
      expect(store.searchMemories("ab")).toEqual([]);
    });

    it("returns empty for empty query", () => {
      expect(store.searchMemories("")).toEqual([]);
    });

    it("returns empty for no matches", () => {
      store.saveMemory("hello world");
      expect(store.searchMemories("zzzyyyxxx")).toEqual([]);
    });

    it("respects limit", () => {
      for (let i = 0; i < 10; i++) {
        store.saveMemory(`important fact number ${i}`);
      }
      const results = store.searchMemories("important", 3);
      expect(results).toHaveLength(3);
    });
  });

  // --- Summaries ---

  describe("summaries", () => {
    beforeEach(() => {
      store.ensureConversation("conv-1", "discord", "ch-1");
    });

    it("returns null for nonexistent summary", () => {
      expect(store.getConversationSummary("conv-1")).toBeNull();
    });

    it("returns null for unknown conversation", () => {
      expect(store.getConversationSummary("nonexistent")).toBeNull();
    });

    it("saves and retrieves a summary", () => {
      store.saveConversationSummary("conv-1", "We discussed deployment.");
      expect(store.getConversationSummary("conv-1")).toBe("We discussed deployment.");
    });

    it("upserts summary on save", () => {
      store.saveConversationSummary("conv-1", "original");
      store.saveConversationSummary("conv-1", "updated");
      expect(store.getConversationSummary("conv-1")).toBe("updated");
    });
  });

  // --- Work Log ---

  describe("work log", () => {
    it("saves and retrieves work log entries", () => {
      store.saveWorkLog("nyx", "fix bug", "fixed the off-by-one error", "discord", 1500);

      const entries = store.getWorkLog("nyx");
      expect(entries).toHaveLength(1);
      expect(entries[0].agent_key).toBe("nyx");
      expect(entries[0].task).toBe("fix bug");
      expect(entries[0].result).toBe("fixed the off-by-one error");
      expect(entries[0].channel).toBe("discord");
      expect(entries[0].duration_ms).toBe(1500);
      expect(entries[0].created_at).toBeGreaterThan(0);
    });

    it("returns entries in chronological order", () => {
      store.saveWorkLog("nyx", "task-1", "result-1");
      store.saveWorkLog("nyx", "task-2", "result-2");
      store.saveWorkLog("nyx", "task-3", "result-3");

      const entries = store.getWorkLog("nyx");
      expect(entries[0].task).toBe("task-1");
      expect(entries[2].task).toBe("task-3");
    });

    it("respects limit on getWorkLog", () => {
      for (let i = 0; i < 10; i++) {
        store.saveWorkLog("nyx", `task-${i}`, `result-${i}`);
      }
      const entries = store.getWorkLog("nyx", 3);
      expect(entries).toHaveLength(3);
    });

    it("auto-prunes old entries beyond maxEntries", () => {
      // maxEntries = 3
      for (let i = 0; i < 5; i++) {
        store.saveWorkLog("nyx", `task-${i}`, `result-${i}`, undefined, undefined, 3);
      }

      const db = store.getDb();
      const count = db.query("SELECT COUNT(*) as c FROM agent_work_log WHERE agent_key = 'nyx'").get() as { c: number };
      expect(count.c).toBe(3);
    });

    it("truncates result to 4000 chars", () => {
      const longResult = "x".repeat(5000);
      store.saveWorkLog("nyx", "task", longResult);

      const entries = store.getWorkLog("nyx");
      expect(entries[0].result.length).toBe(4000);
    });

    it("clearWorkLog clears entries for a specific agent", () => {
      store.saveWorkLog("nyx", "task-1", "r1");
      store.saveWorkLog("analyst", "task-2", "r2");

      store.clearWorkLog("nyx");
      expect(store.getWorkLog("nyx")).toHaveLength(0);
      expect(store.getWorkLog("analyst")).toHaveLength(1);
    });

    it("clearWorkLog clears all entries when no agent specified", () => {
      store.saveWorkLog("nyx", "task-1", "r1");
      store.saveWorkLog("analyst", "task-2", "r2");

      store.clearWorkLog();
      expect(store.getWorkLog("nyx")).toHaveLength(0);
      expect(store.getWorkLog("analyst")).toHaveLength(0);
    });

    it("handles null channel and duration", () => {
      store.saveWorkLog("nyx", "task", "result");
      const entries = store.getWorkLog("nyx");
      expect(entries[0].channel).toBeNull();
      expect(entries[0].duration_ms).toBeNull();
    });
  });

  // --- Usage (trace_events) ---

  describe("usage aggregation", () => {
    function insertTraceEvent(
      agent: string,
      model: string,
      tokensIn: number,
      tokensOut: number,
      cost: number,
      startedAt?: number,
    ): void {
      const db = store.getDb();
      // Need a trace first
      const traceId = `trace-${Date.now()}-${Math.random()}`;
      db.prepare(
        `INSERT INTO execution_traces (id, channel, sender, input_message, status, created_at)
         VALUES (?, 'test', 'tester', 'test input', 'completed', ?)`,
      ).run(traceId, Date.now());

      db.prepare(
        `INSERT INTO trace_events (trace_id, agent, task, tokens_in, tokens_out, cost, model, started_at, status)
         VALUES (?, ?, 'test-task', ?, ?, ?, ?, ?, 'completed')`,
      ).run(traceId, agent, tokensIn, tokensOut, cost, model, startedAt ?? Date.now());
    }

    it("getUsageSummary aggregates by model and agent", () => {
      insertTraceEvent("nyx", "claude-3", 100, 200, 0.01);
      insertTraceEvent("nyx", "claude-3", 50, 100, 0.005);
      insertTraceEvent("analyst", "gemini", 30, 60, 0.001);

      const usage = store.getUsageSummary(1);
      expect(usage.length).toBeGreaterThanOrEqual(2);

      const nyxUsage = usage.find((u) => u.agent === "nyx" && u.model === "claude-3");
      expect(nyxUsage).toBeDefined();
      expect(nyxUsage!.total_tokens_in).toBe(150);
      expect(nyxUsage!.total_tokens_out).toBe(300);
      expect(nyxUsage!.total_cost).toBeCloseTo(0.015);
      expect(nyxUsage!.count).toBe(2);
    });

    it("getUsageSummary filters by time window", () => {
      const oldTime = Date.now() - 48 * 60 * 60 * 1000; // 48h ago
      insertTraceEvent("nyx", "claude-3", 100, 200, 0.01, oldTime);
      insertTraceEvent("nyx", "claude-3", 50, 100, 0.005); // now

      const usage = store.getUsageSummary(1); // last 1 hour
      const nyxUsage = usage.find((u) => u.agent === "nyx");
      expect(nyxUsage).toBeDefined();
      expect(nyxUsage!.count).toBe(1);
      expect(nyxUsage!.total_tokens_in).toBe(50);
    });

    it("getUsageSummary returns empty array when no events", () => {
      expect(store.getUsageSummary(1)).toEqual([]);
    });

    it("getTotalCost sums cost from trace_events", () => {
      insertTraceEvent("nyx", "claude-3", 100, 200, 0.01);
      insertTraceEvent("analyst", "gemini", 30, 60, 0.005);

      const total = store.getTotalCost(1);
      expect(total).toBeCloseTo(0.015);
    });

    it("getTotalCost returns 0 when no events", () => {
      expect(store.getTotalCost(1)).toBe(0);
    });

    it("getTotalCost filters by time window", () => {
      const oldTime = Date.now() - 48 * 60 * 60 * 1000;
      insertTraceEvent("nyx", "claude-3", 100, 200, 1.0, oldTime);
      insertTraceEvent("nyx", "claude-3", 50, 100, 0.5); // now

      expect(store.getTotalCost(1)).toBeCloseTo(0.5);
    });
  });

  // --- Close ---

  describe("close", () => {
    it("closes the database", () => {
      store.close();
      // After close, operations should throw
      expect(() => store.getMessageCount("any")).toThrow();
    });
  });
});

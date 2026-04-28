import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ClassificationLog } from "../providers/classification-log.js";

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "msg-1",
    inputText: "hello world",
    taskType: "simple_qa",
    complexityTier: 1,
    confidence: 0.9,
    modelSelected: "deepseek/deepseek-v3.2",
    classifierModel: "local",
    classifierLatencyMs: 5,
    ...overrides,
  };
}

describe("ClassificationLog", () => {
  let log: ClassificationLog;

  beforeEach(() => {
    log = new ClassificationLog(":memory:");
  });

  afterEach(() => {
    log.close();
  });

  // --- log ---

  describe("log", () => {
    it("inserts a classification entry and returns row id", () => {
      const id = log.log(makeEntry());
      expect(id).toBe(1);
    });

    it("stores all fields correctly", () => {
      log.log(makeEntry({
        messageId: "msg-42",
        inputText: "implement a new feature",
        conversationId: "conv-1",
        taskType: "coding",
        complexityTier: 3,
        confidence: 0.85,
        modelSelected: "claude-sonnet-4-6",
        classifierModel: "deepseek/deepseek-v3.2",
        classifierLatencyMs: 120,
      }));

      const entry = log.getByMessageId("msg-42");
      expect(entry).not.toBeNull();
      expect(entry!.message_id).toBe("msg-42");
      expect(entry!.input_text).toBe("implement a new feature");
      expect(entry!.input_length).toBe("implement a new feature".length);
      expect(entry!.conversation_id).toBe("conv-1");
      expect(entry!.task_type).toBe("coding");
      expect(entry!.complexity_tier).toBe(3);
      expect(entry!.confidence).toBe(0.85);
      expect(entry!.model_selected).toBe("claude-sonnet-4-6");
      expect(entry!.classifier_model).toBe("deepseek/deepseek-v3.2");
      expect(entry!.classifier_latency_ms).toBe(120);
      expect(entry!.outcome).toBeNull();
      expect(entry!.corrected_task_type).toBeNull();
    });

    it("truncates input text to 500 chars", () => {
      const longText = "x".repeat(1000);
      log.log(makeEntry({ messageId: "msg-long", inputText: longText }));
      const entry = log.getByMessageId("msg-long");
      expect(entry!.input_text.length).toBe(500);
      expect(entry!.input_length).toBe(1000);
    });

    it("handles missing conversationId", () => {
      log.log(makeEntry({ messageId: "msg-no-conv" }));
      const entry = log.getByMessageId("msg-no-conv");
      expect(entry!.conversation_id).toBeNull();
    });
  });

  // --- updateOutcome ---

  describe("updateOutcome", () => {
    it("backfills outcome for matching message", () => {
      log.log(makeEntry({ messageId: "msg-out" }));
      log.updateOutcome("msg-out", "success");

      const entry = log.getByMessageId("msg-out");
      expect(entry!.outcome).toBe("success");
    });

    it("does not overwrite existing outcome", () => {
      log.log(makeEntry({ messageId: "msg-locked" }));
      log.updateOutcome("msg-locked", "success");
      log.updateOutcome("msg-locked", "retry");

      const entry = log.getByMessageId("msg-locked");
      expect(entry!.outcome).toBe("success");
    });

    it("no-ops for non-existent message", () => {
      log.updateOutcome("nonexistent", "success");
    });
  });

  // --- recordCorrection ---

  describe("recordCorrection", () => {
    it("records corrected task type and tier", () => {
      log.log(makeEntry({ messageId: "msg-corr" }));
      log.recordCorrection("msg-corr", "coding", 3);

      const entry = log.getByMessageId("msg-corr");
      expect(entry!.corrected_task_type).toBe("coding");
      expect(entry!.corrected_tier).toBe(3);
    });

    it("does not overwrite existing correction", () => {
      log.log(makeEntry({ messageId: "msg-corr2" }));
      log.recordCorrection("msg-corr2", "coding", 3);
      log.recordCorrection("msg-corr2", "analysis", 4);

      const entry = log.getByMessageId("msg-corr2");
      expect(entry!.corrected_task_type).toBe("coding");
      expect(entry!.corrected_tier).toBe(3);
    });
  });

  // --- getByMessageId ---

  describe("getByMessageId", () => {
    it("returns the most recent entry for a message", () => {
      log.log(makeEntry({ messageId: "msg-dup", taskType: "simple_qa" }));
      log.log(makeEntry({ messageId: "msg-dup", taskType: "coding" }));

      const entry = log.getByMessageId("msg-dup");
      expect(entry!.task_type).toBe("coding");
    });

    it("returns null for unknown message", () => {
      expect(log.getByMessageId("nope")).toBeNull();
    });
  });

  // --- getRecent ---

  describe("getRecent", () => {
    it("returns entries in reverse chronological order", () => {
      log.log(makeEntry({ messageId: "msg-a" }));
      log.log(makeEntry({ messageId: "msg-b" }));
      log.log(makeEntry({ messageId: "msg-c" }));

      const recent = log.getRecent(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].message_id).toBe("msg-c");
      expect(recent[1].message_id).toBe("msg-b");
    });

    it("defaults to 50 limit", () => {
      for (let i = 0; i < 60; i++) {
        log.log(makeEntry({ messageId: `msg-${i}` }));
      }
      expect(log.getRecent()).toHaveLength(50);
    });
  });

  // --- getCorrections ---

  describe("getCorrections", () => {
    it("returns only corrected entries", () => {
      log.log(makeEntry({ messageId: "msg-ok" }));
      log.log(makeEntry({ messageId: "msg-fixed" }));
      log.recordCorrection("msg-fixed", "analysis", 2);

      const corrections = log.getCorrections();
      expect(corrections).toHaveLength(1);
      expect(corrections[0].message_id).toBe("msg-fixed");
    });

    it("filters by date when since provided", () => {
      log.log(makeEntry({ messageId: "msg-old" }));
      log.recordCorrection("msg-old", "coding", 3);

      const future = new Date(Date.now() + 86400_000).toISOString();
      const corrections = log.getCorrections(future);
      expect(corrections).toHaveLength(0);
    });
  });

  // --- getAccuracyStats ---

  describe("getAccuracyStats", () => {
    it("computes accuracy stats over the time window", () => {
      log.log(makeEntry({ messageId: "s1" }));
      log.log(makeEntry({ messageId: "s2" }));
      log.log(makeEntry({ messageId: "s3" }));
      log.updateOutcome("s1", "success");
      log.updateOutcome("s2", "success");
      log.updateOutcome("s3", "retry");
      log.recordCorrection("s3", "coding", 3);

      const stats = log.getAccuracyStats(24);
      expect(stats.total).toBe(3);
      expect(stats.withOutcome).toBe(3);
      expect(stats.successful).toBe(2);
      expect(stats.corrected).toBe(1);
      expect(stats.accuracyRate).toBeCloseTo(2 / 3);
    });

    it("returns zero accuracy when no outcomes", () => {
      log.log(makeEntry({ messageId: "no-outcome" }));
      const stats = log.getAccuracyStats();
      expect(stats.total).toBe(1);
      expect(stats.withOutcome).toBe(0);
      expect(stats.accuracyRate).toBe(0);
    });
  });

  // --- getDb ---

  describe("getDb", () => {
    it("returns the underlying database", () => {
      const db = log.getDb();
      expect(db).toBeDefined();
      const row = db.prepare("SELECT 1 as val").get() as { val: number };
      expect(row.val).toBe(1);
    });
  });
});

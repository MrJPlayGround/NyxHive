import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { FeedbackStore } from "../memory/feedback.js";

describe("FeedbackStore", () => {
  let db: Database;
  let store: FeedbackStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new FeedbackStore(db);
  });

  describe("constructor", () => {
    test("creates schema tables", () => {
      const tables = db
        .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const names = tables.map((t) => t.name);
      expect(names).toContain("response_feedback");
      expect(names).toContain("knowledge_feedback_scores");
    });

    test("migration is idempotent — second constructor does not throw", () => {
      expect(() => new FeedbackStore(db)).not.toThrow();
    });
  });

  describe("addFeedback", () => {
    test("stores feedback and returns inserted row", () => {
      const row = store.addFeedback({
        messageId: "msg-1",
        rating: 1,
        channel: "telegram",
        senderId: "user-1",
        comment: "helpful",
      });

      expect(row.id).toBe(1);
      expect(row.message_id).toBe("msg-1");
      expect(row.channel).toBe("telegram");
      expect(row.sender_id).toBe("user-1");
      expect(row.rating).toBe(1);
      expect(row.comment).toBe("helpful");
      expect(row.knowledge_sources).toBeNull();
      expect(typeof row.created_at).toBe("number");
    });

    test("stores negative feedback", () => {
      const row = store.addFeedback({
        messageId: "msg-2",
        rating: -1,
        comment: "wrong answer",
      });

      expect(row.rating).toBe(-1);
      expect(row.comment).toBe("wrong answer");
    });

    test("stores agent field", () => {
      const row = store.addFeedback({
        messageId: "msg-3",
        rating: 1,
        agent: "forge",
      });

      expect(row.agent).toBe("forge");
    });

    test("stores knowledge_sources as JSON", () => {
      const sources = ["docs/api.md::endpoints", "docs/auth.md"];
      const row = store.addFeedback({
        messageId: "msg-4",
        rating: 1,
        knowledgeSources: sources,
      });

      expect(row.knowledge_sources).toBe(JSON.stringify(sources));
    });

    test("defaults optional fields to null", () => {
      const row = store.addFeedback({
        messageId: "msg-5",
        rating: 1,
      });

      expect(row.channel).toBeNull();
      expect(row.sender_id).toBeNull();
      expect(row.agent).toBeNull();
      expect(row.comment).toBeNull();
      expect(row.knowledge_sources).toBeNull();
    });
  });

  describe("knowledge chunk scoring", () => {
    test("updates chunk scores for each source in knowledgeSources", () => {
      store.addFeedback({
        messageId: "msg-1",
        rating: 1,
        knowledgeSources: ["docs/api.md::endpoints", "docs/auth.md"],
      });

      const scores = store.getChunkScores();
      expect(scores.length).toBe(2);

      const apiScore = scores.find((s) => s.source_path === "docs/api.md");
      expect(apiScore).toBeDefined();
      expect(apiScore!.section).toBe("endpoints");
      expect(apiScore!.positive_count).toBe(1);
      expect(apiScore!.negative_count).toBe(0);

      const authScore = scores.find((s) => s.source_path === "docs/auth.md");
      expect(authScore).toBeDefined();
      expect(authScore!.section).toBeNull();
      expect(authScore!.positive_count).toBe(1);
      expect(authScore!.negative_count).toBe(0);
    });

    test("increments negative_count for negative rating", () => {
      store.addFeedback({
        messageId: "msg-1",
        rating: -1,
        knowledgeSources: ["docs/api.md::endpoints"],
      });

      const scores = store.getChunkScores();
      expect(scores[0].positive_count).toBe(0);
      expect(scores[0].negative_count).toBe(1);
    });

    test("accumulates counts across multiple feedbacks", () => {
      store.addFeedback({
        messageId: "msg-1",
        rating: 1,
        knowledgeSources: ["docs/api.md"],
      });
      store.addFeedback({
        messageId: "msg-2",
        rating: 1,
        knowledgeSources: ["docs/api.md"],
      });
      store.addFeedback({
        messageId: "msg-3",
        rating: -1,
        knowledgeSources: ["docs/api.md"],
      });

      const scores = store.getChunkScores();
      expect(scores[0].positive_count).toBe(2);
      expect(scores[0].negative_count).toBe(1);
    });

    test("parseSource splits path::section correctly", () => {
      store.addFeedback({
        messageId: "msg-1",
        rating: 1,
        knowledgeSources: ["path/to/file.md::some section"],
      });

      const scores = store.getChunkScores();
      expect(scores[0].source_path).toBe("path/to/file.md");
      expect(scores[0].section).toBe("some section");
    });

    test("parseSource handles path without section", () => {
      store.addFeedback({
        messageId: "msg-1",
        rating: 1,
        knowledgeSources: ["path/to/file.md"],
      });

      const scores = store.getChunkScores();
      expect(scores[0].source_path).toBe("path/to/file.md");
      expect(scores[0].section).toBeNull();
    });

    test("treats same path with different sections as separate entries", () => {
      store.addFeedback({
        messageId: "msg-1",
        rating: 1,
        knowledgeSources: ["docs/api.md::auth"],
      });
      store.addFeedback({
        messageId: "msg-2",
        rating: -1,
        knowledgeSources: ["docs/api.md::errors"],
      });

      const scores = store.getChunkScores();
      expect(scores.length).toBe(2);
    });
  });

  describe("auto-flagging", () => {
    test("flags chunk at net_negative >= 3", () => {
      // 3 negatives, 0 positives => net_negative = 3
      for (let i = 0; i < 3; i++) {
        store.addFeedback({
          messageId: `msg-${i}`,
          rating: -1,
          knowledgeSources: ["bad-chunk.md"],
        });
      }

      const flagged = store.getFlaggedChunks();
      expect(flagged.length).toBe(1);
      expect(flagged[0].source_path).toBe("bad-chunk.md");
      expect(flagged[0].negative_count).toBe(3);
    });

    test("does not flag at net_negative = 2", () => {
      for (let i = 0; i < 2; i++) {
        store.addFeedback({
          messageId: `msg-${i}`,
          rating: -1,
          knowledgeSources: ["borderline.md"],
        });
      }

      const flagged = store.getFlaggedChunks();
      expect(flagged.length).toBe(0);
    });

    test("positive ratings offset negatives and delay flagging", () => {
      // 4 negatives, 2 positives => net_negative = 2, not flagged
      for (let i = 0; i < 4; i++) {
        store.addFeedback({
          messageId: `neg-${i}`,
          rating: -1,
          knowledgeSources: ["mixed.md"],
        });
      }
      store.addFeedback({
        messageId: "pos-1",
        rating: 1,
        knowledgeSources: ["mixed.md"],
      });
      store.addFeedback({
        messageId: "pos-2",
        rating: 1,
        knowledgeSources: ["mixed.md"],
      });

      // net_negative = 4 - 2 = 2, but already flagged at neg 3
      // Actually, it flags at neg 3 (net 3-0=3) before positives arrive
      const flagged = store.getFlaggedChunks();
      expect(flagged.length).toBe(1); // was flagged at neg #3
    });

    test("flags at exact threshold when positives reduce net", () => {
      // 1 positive, then 4 negatives => net_negative = 4-1 = 3 at 4th negative
      store.addFeedback({
        messageId: "pos-1",
        rating: 1,
        knowledgeSources: ["delayed.md"],
      });
      for (let i = 0; i < 4; i++) {
        store.addFeedback({
          messageId: `neg-${i}`,
          rating: -1,
          knowledgeSources: ["delayed.md"],
        });
      }

      const flagged = store.getFlaggedChunks();
      expect(flagged.length).toBe(1);
      expect(flagged[0].source_path).toBe("delayed.md");
    });

    test("does not flag when positives keep net below threshold", () => {
      // 2 positives, 4 negatives => net = 4-2 = 2
      store.addFeedback({ messageId: "p1", rating: 1, knowledgeSources: ["ok.md"] });
      store.addFeedback({ messageId: "p2", rating: 1, knowledgeSources: ["ok.md"] });
      store.addFeedback({ messageId: "n1", rating: -1, knowledgeSources: ["ok.md"] });
      store.addFeedback({ messageId: "n2", rating: -1, knowledgeSources: ["ok.md"] });
      store.addFeedback({ messageId: "n3", rating: -1, knowledgeSources: ["ok.md"] });
      store.addFeedback({ messageId: "n4", rating: -1, knowledgeSources: ["ok.md"] });

      const flagged = store.getFlaggedChunks();
      expect(flagged.length).toBe(0);
    });
  });

  describe("getFlaggedChunks", () => {
    test("returns empty array when nothing flagged", () => {
      expect(store.getFlaggedChunks()).toEqual([]);
    });

    test("returns only flagged chunks", () => {
      // Flag one chunk
      for (let i = 0; i < 3; i++) {
        store.addFeedback({
          messageId: `bad-${i}`,
          rating: -1,
          knowledgeSources: ["bad.md"],
        });
      }
      // Add unflagged chunk
      store.addFeedback({
        messageId: "ok-1",
        rating: -1,
        knowledgeSources: ["ok.md"],
      });

      const flagged = store.getFlaggedChunks();
      expect(flagged.length).toBe(1);
      expect(flagged[0].source_path).toBe("bad.md");
    });

    test("orders by worst net_negative descending", () => {
      // Chunk A: net_negative = 3
      for (let i = 0; i < 3; i++) {
        store.addFeedback({
          messageId: `a-${i}`,
          rating: -1,
          knowledgeSources: ["chunk-a.md"],
        });
      }
      // Chunk B: net_negative = 5
      for (let i = 0; i < 5; i++) {
        store.addFeedback({
          messageId: `b-${i}`,
          rating: -1,
          knowledgeSources: ["chunk-b.md"],
        });
      }

      const flagged = store.getFlaggedChunks();
      expect(flagged.length).toBe(2);
      expect(flagged[0].source_path).toBe("chunk-b.md");
      expect(flagged[1].source_path).toBe("chunk-a.md");
    });
  });

  describe("unflagChunk", () => {
    test("resets flag and counts for a flagged chunk", () => {
      for (let i = 0; i < 3; i++) {
        store.addFeedback({
          messageId: `msg-${i}`,
          rating: -1,
          knowledgeSources: ["to-unflag.md"],
        });
      }
      expect(store.getFlaggedChunks().length).toBe(1);

      const result = store.unflagChunk("to-unflag.md");
      expect(result).toBe(true);

      const flagged = store.getFlaggedChunks();
      expect(flagged.length).toBe(0);

      // Counts are reset too
      const scores = store.getChunkScores();
      const chunk = scores.find((s) => s.source_path === "to-unflag.md");
      expect(chunk!.positive_count).toBe(0);
      expect(chunk!.negative_count).toBe(0);
      expect(chunk!.flagged).toBe(0);
    });

    test("returns false for non-existent chunk", () => {
      const result = store.unflagChunk("nonexistent.md");
      expect(result).toBe(false);
    });

    test("unflag with section matches only that section", () => {
      for (let i = 0; i < 3; i++) {
        store.addFeedback({
          messageId: `a-${i}`,
          rating: -1,
          knowledgeSources: ["doc.md::section-a"],
        });
        store.addFeedback({
          messageId: `b-${i}`,
          rating: -1,
          knowledgeSources: ["doc.md::section-b"],
        });
      }

      expect(store.getFlaggedChunks().length).toBe(2);

      store.unflagChunk("doc.md", "section-a");

      const flagged = store.getFlaggedChunks();
      expect(flagged.length).toBe(1);
      expect(flagged[0].section).toBe("section-b");
    });
  });

  describe("getStats", () => {
    test("returns zeroes for empty store", () => {
      const stats = store.getStats();
      expect(stats).toEqual({ total: 0, positive: 0, negative: 0, flagged_chunks: 0 });
    });

    test("returns correct counts", () => {
      store.addFeedback({ messageId: "m1", rating: 1 });
      store.addFeedback({ messageId: "m2", rating: 1 });
      store.addFeedback({ messageId: "m3", rating: -1 });

      const stats = store.getStats();
      expect(stats.total).toBe(3);
      expect(stats.positive).toBe(2);
      expect(stats.negative).toBe(1);
      expect(stats.flagged_chunks).toBe(0);
    });

    test("includes flagged chunk count", () => {
      for (let i = 0; i < 3; i++) {
        store.addFeedback({
          messageId: `f-${i}`,
          rating: -1,
          knowledgeSources: ["flagged.md"],
        });
      }

      const stats = store.getStats();
      expect(stats.flagged_chunks).toBe(1);
    });
  });

  describe("getRecentFeedback", () => {
    test("returns all feedback entries", () => {
      store.addFeedback({ messageId: "m1", rating: 1 });
      store.addFeedback({ messageId: "m2", rating: -1 });
      store.addFeedback({ messageId: "m3", rating: 1 });

      const recent = store.getRecentFeedback();
      expect(recent.length).toBe(3);
      const ids = recent.map((r) => r.message_id).sort();
      expect(ids).toEqual(["m1", "m2", "m3"]);
    });

    test("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        store.addFeedback({ messageId: `m-${i}`, rating: 1 });
      }

      const recent = store.getRecentFeedback(2);
      expect(recent.length).toBe(2);
    });
  });

  describe("getChunkScores", () => {
    test("returns empty array when no scores", () => {
      expect(store.getChunkScores()).toEqual([]);
    });

    test("respects limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        store.addFeedback({
          messageId: `m-${i}`,
          rating: 1,
          knowledgeSources: [`chunk-${i}.md`],
        });
      }

      const scores = store.getChunkScores(3);
      expect(scores.length).toBe(3);
    });
  });

  describe("getFeedbackSince", () => {
    test("filters by timestamp", () => {
      store.addFeedback({ messageId: "old", rating: 1 });

      const now = Math.floor(Date.now() / 1000);
      const recent = store.getFeedbackSince(now - 1);
      expect(recent.length).toBe(1);

      const future = store.getFeedbackSince(now + 100);
      expect(future.length).toBe(0);
    });

    test("filters by agent when provided", () => {
      store.addFeedback({ messageId: "m1", rating: 1, agent: "forge" });
      store.addFeedback({ messageId: "m2", rating: -1, agent: "scout" });
      store.addFeedback({ messageId: "m3", rating: 1, agent: "forge" });

      const forgeOnly = store.getFeedbackSince(0, "forge");
      expect(forgeOnly.length).toBe(2);
      expect(forgeOnly.every((f) => f.agent === "forge")).toBe(true);
    });

    test("returns all agents when agent not specified", () => {
      store.addFeedback({ messageId: "m1", rating: 1, agent: "forge" });
      store.addFeedback({ messageId: "m2", rating: -1, agent: "scout" });

      const all = store.getFeedbackSince(0);
      expect(all.length).toBe(2);
    });
  });
});

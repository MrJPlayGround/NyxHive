import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS response_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  channel TEXT,
  sender_id TEXT,
  agent TEXT,
  rating INTEGER NOT NULL,  -- 1 = positive, -1 = negative
  comment TEXT,
  knowledge_sources TEXT,   -- JSON array of source_paths used
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_feedback_message ON response_feedback(message_id);
CREATE INDEX IF NOT EXISTS idx_feedback_rating ON response_feedback(rating);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON response_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_agent_created ON response_feedback(agent, created_at);

CREATE TABLE IF NOT EXISTS knowledge_feedback_scores (
  source_path TEXT NOT NULL,
  section TEXT,
  positive_count INTEGER NOT NULL DEFAULT 0,
  negative_count INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  last_feedback_at INTEGER,
  PRIMARY KEY (source_path, section)
);
CREATE INDEX IF NOT EXISTS idx_kf_flagged ON knowledge_feedback_scores(flagged);
`;

/** A stored user feedback entry (thumbs up/down) on an agent response. */
export interface Feedback {
  id: number;
  message_id: string;
  channel: string | null;
  sender_id: string | null;
  agent: string | null;
  rating: number;
  comment: string | null;
  knowledge_sources: string | null;
  created_at: number;
}

/** Aggregated positive/negative feedback scores for a knowledge chunk. */
export interface KnowledgeFeedbackScore {
  source_path: string;
  section: string | null;
  positive_count: number;
  negative_count: number;
  flagged: number;
  last_feedback_at: number | null;
}

const FLAG_THRESHOLD = 3; // flag after 3+ net negative ratings

/** SQLite-backed store for response feedback with automatic knowledge chunk scoring and flagging. */
export class FeedbackStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(SCHEMA);
    try {
      this.db.exec("ALTER TABLE response_feedback ADD COLUMN agent TEXT");
    } catch (err) {
      const msg = String(err);
      if (!msg.includes("already exists") && !msg.includes("duplicate column")) throw err;
    }
  }

  /** Record feedback on a response. Updates per-chunk scores and auto-flags low-quality knowledge. */
  addFeedback(opts: {
    messageId: string;
    channel?: string;
    senderId?: string;
    agent?: string;
    rating: 1 | -1;
    comment?: string;
    knowledgeSources?: string[];
  }): Feedback {
    const sourcesJson = opts.knowledgeSources ? JSON.stringify(opts.knowledgeSources) : null;

    const insertResult = this.db.run(
      `INSERT INTO response_feedback (message_id, channel, sender_id, agent, rating, comment, knowledge_sources)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [opts.messageId, opts.channel ?? null, opts.senderId ?? null, opts.agent ?? null, opts.rating, opts.comment ?? null, sourcesJson],
    );

    // Update per-chunk scores
    if (opts.knowledgeSources) {
      for (const source of opts.knowledgeSources) {
        const [sourcePath, section] = this.parseSource(source);
        this.updateChunkScore(sourcePath, section, opts.rating);
      }
    }

    const row = this.db.query("SELECT * FROM response_feedback WHERE id = ?").get(insertResult.lastInsertRowid) as Feedback;
    logger.info(`[feedback] ${opts.rating > 0 ? "+" : "-"} on ${opts.messageId}${opts.knowledgeSources ? ` (${opts.knowledgeSources.length} sources)` : ""}`);
    return row;
  }

  private parseSource(source: string): [string, string | null] {
    // Sources may be "path::section" or just "path"
    const parts = source.split("::");
    return [parts[0], parts[1] ?? null];
  }

  private updateChunkScore(sourcePath: string, section: string | null, rating: number): void {
    const col = rating > 0 ? "positive_count" : "negative_count";
    // ON CONFLICT doesn't fire for NULL sections (SQLite treats NULLs as distinct
    // in primary key comparisons), so use explicit check-then-insert/update.
    const existing = this.db.query(
      "SELECT 1 FROM knowledge_feedback_scores WHERE source_path = ? AND section IS ?",
    ).get(sourcePath, section);

    if (existing) {
      this.db.run(
        `UPDATE knowledge_feedback_scores SET ${col} = ${col} + 1, last_feedback_at = unixepoch() WHERE source_path = ? AND section IS ?`,
        [sourcePath, section],
      );
    } else {
      this.db.run(
        `INSERT INTO knowledge_feedback_scores (source_path, section, ${col}, last_feedback_at) VALUES (?, ?, 1, unixepoch())`,
        [sourcePath, section],
      );
    }

    // Auto-flag if net negative exceeds threshold
    const row = this.db.query(
      "SELECT negative_count - positive_count as net_negative FROM knowledge_feedback_scores WHERE source_path = ? AND section IS ?",
    ).get(sourcePath, section) as { net_negative: number } | null;

    if (row && row.net_negative >= FLAG_THRESHOLD) {
      this.db.run(
        "UPDATE knowledge_feedback_scores SET flagged = 1 WHERE source_path = ? AND section IS ?",
        [sourcePath, section],
      );
      logger.warn(`[feedback] Flagged knowledge chunk: ${sourcePath}${section ? ` > ${section}` : ""} (net negative: ${row.net_negative})`);
    }
  }

  /** Get all knowledge chunks flagged as low-quality (net negative >= threshold). */
  getFlaggedChunks(): KnowledgeFeedbackScore[] {
    return this.db.query(
      "SELECT * FROM knowledge_feedback_scores WHERE flagged = 1 ORDER BY (negative_count - positive_count) DESC",
    ).all() as KnowledgeFeedbackScore[];
  }

  /** Get recent per-chunk feedback scores, ordered by last feedback time. */
  getChunkScores(limit = 50): KnowledgeFeedbackScore[] {
    return this.db.query(
      "SELECT * FROM knowledge_feedback_scores ORDER BY last_feedback_at DESC LIMIT ?",
    ).all(limit) as KnowledgeFeedbackScore[];
  }

  /** Get the most recent feedback entries. */
  getRecentFeedback(limit = 50): Feedback[] {
    return this.db.query(
      "SELECT * FROM response_feedback ORDER BY created_at DESC LIMIT ?",
    ).all(limit) as Feedback[];
  }

  /** Get feedback entries since a unix timestamp, optionally filtered by agent. */
  getFeedbackSince(since: number, agent?: string): Feedback[] {
    if (agent) {
      return this.db.query(
        "SELECT * FROM response_feedback WHERE created_at >= ? AND agent = ? ORDER BY created_at DESC",
      ).all(since, agent) as Feedback[];
    }
    return this.db.query(
      "SELECT * FROM response_feedback WHERE created_at >= ? ORDER BY created_at DESC",
    ).all(since) as Feedback[];
  }

  /** Get aggregate feedback stats: total, positive, negative counts and flagged chunk count. */
  getStats(): { total: number; positive: number; negative: number; flagged_chunks: number } {
    const total = (this.db.query("SELECT COUNT(*) as c FROM response_feedback").get() as { c: number }).c;
    const positive = (this.db.query("SELECT COUNT(*) as c FROM response_feedback WHERE rating > 0").get() as { c: number }).c;
    const negative = (this.db.query("SELECT COUNT(*) as c FROM response_feedback WHERE rating < 0").get() as { c: number }).c;
    const flagged = (this.db.query("SELECT COUNT(*) as c FROM knowledge_feedback_scores WHERE flagged = 1").get() as { c: number }).c;
    return { total, positive, negative, flagged_chunks: flagged };
  }

  /** Clear the flag and reset scores for a knowledge chunk. Returns true if a row was updated. */
  unflagChunk(sourcePath: string, section?: string): boolean {
    const result = this.db.run(
      "UPDATE knowledge_feedback_scores SET flagged = 0, positive_count = 0, negative_count = 0 WHERE source_path = ? AND section IS ?",
      [sourcePath, section ?? null],
    );
    return result.changes > 0;
  }
}

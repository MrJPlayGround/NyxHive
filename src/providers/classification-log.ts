/**
 * classification-log.ts — Persistent logging of classification decisions.
 *
 * Every LLM or local classification writes a row. Outcomes are backfilled
 * after the agent completes (success, retry, review_fail, escalated).
 * Corrections are recorded when a retry triggers reclassification.
 *
 * Used by Phase 4 (auto-feedback loop) to export corrections into the
 * routing dataset and re-sample few-shot examples.
 */

import { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

export interface ClassificationLogEntry {
  id: number;
  message_id: string;
  input_text: string;
  input_length: number;
  conversation_id: string | null;
  task_type: string;
  complexity_tier: number;
  confidence: number;
  model_selected: string;
  classifier_model: string;
  classifier_latency_ms: number;
  outcome: string | null;
  corrected_task_type: string | null;
  corrected_tier: number | null;
  created_at: string;
}

export type ClassificationOutcome = "success" | "retry" | "review_fail" | "escalated";

export class ClassificationLog {
  private db: Database;

  constructor(dbPath = ":memory:") {
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS classification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        input_text TEXT NOT NULL,
        input_length INTEGER NOT NULL,
        conversation_id TEXT,
        task_type TEXT NOT NULL,
        complexity_tier INTEGER NOT NULL,
        confidence REAL NOT NULL,
        model_selected TEXT NOT NULL,
        classifier_model TEXT NOT NULL,
        classifier_latency_ms INTEGER NOT NULL,
        outcome TEXT,
        corrected_task_type TEXT,
        corrected_tier INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_classification_log_outcome ON classification_log(outcome)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_classification_log_created ON classification_log(created_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_classification_log_message ON classification_log(message_id)");
  }

  /** Log a classification decision. Returns the row ID. */
  log(entry: {
    messageId: string;
    inputText: string;
    conversationId?: string;
    taskType: string;
    complexityTier: number;
    confidence: number;
    modelSelected: string;
    classifierModel: string;
    classifierLatencyMs: number;
  }): number {
    const stmt = this.db.prepare(`
      INSERT INTO classification_log
        (message_id, input_text, input_length, conversation_id, task_type,
         complexity_tier, confidence, model_selected, classifier_model, classifier_latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      entry.messageId,
      entry.inputText.slice(0, 500), // Truncate for storage
      entry.inputText.length,
      entry.conversationId ?? null,
      entry.taskType,
      entry.complexityTier,
      entry.confidence,
      entry.modelSelected,
      entry.classifierModel,
      entry.classifierLatencyMs,
    );
    logger.debug(`[classification-log] Logged classification: ${entry.taskType} T${entry.complexityTier} → ${entry.modelSelected} (id=${result.lastInsertRowid})`);
    return Number(result.lastInsertRowid);
  }

  /** Backfill the outcome after agent completes. */
  updateOutcome(messageId: string, outcome: ClassificationOutcome): void {
    const stmt = this.db.prepare(
      "UPDATE classification_log SET outcome = ? WHERE message_id = ? AND outcome IS NULL"
    );
    const result = stmt.run(outcome, messageId);
    if (result.changes > 0) {
      logger.debug(`[classification-log] Updated outcome: ${messageId} → ${outcome}`);
    }
  }

  /** Record a correction when reclassification occurs on retry. */
  recordCorrection(messageId: string, correctedTaskType: string, correctedTier: number): void {
    const stmt = this.db.prepare(
      "UPDATE classification_log SET corrected_task_type = ?, corrected_tier = ? WHERE message_id = ? AND corrected_task_type IS NULL"
    );
    stmt.run(correctedTaskType, correctedTier, messageId);
    logger.debug(`[classification-log] Recorded correction: ${messageId} → ${correctedTaskType} T${correctedTier}`);
  }

  /** Get a classification entry by message ID. */
  getByMessageId(messageId: string): ClassificationLogEntry | null {
    return this.db.prepare(
      "SELECT * FROM classification_log WHERE message_id = ? ORDER BY id DESC LIMIT 1"
    ).get(messageId) as ClassificationLogEntry | null;
  }

  /** Get recent entries for dashboard/analysis. */
  getRecent(limit = 50): ClassificationLogEntry[] {
    return this.db.prepare(
      "SELECT * FROM classification_log ORDER BY id DESC LIMIT ?"
    ).all(limit) as ClassificationLogEntry[];
  }

  /** Get entries with corrections (for feedback loop dataset export). */
  getCorrections(since?: string): ClassificationLogEntry[] {
    if (since) {
      return this.db.prepare(
        "SELECT * FROM classification_log WHERE corrected_task_type IS NOT NULL AND created_at > ? ORDER BY id"
      ).all(since) as ClassificationLogEntry[];
    }
    return this.db.prepare(
      "SELECT * FROM classification_log WHERE corrected_task_type IS NOT NULL ORDER BY id"
    ).all() as ClassificationLogEntry[];
  }

  /** Get accuracy stats within a time window. */
  getAccuracyStats(hoursBack = 168): {
    total: number;
    withOutcome: number;
    successful: number;
    corrected: number;
    accuracyRate: number;
  } {
    const cutoff = new Date(Date.now() - hoursBack * 3600_000).toISOString();
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(outcome) as with_outcome,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successful,
        SUM(CASE WHEN corrected_task_type IS NOT NULL THEN 1 ELSE 0 END) as corrected
      FROM classification_log
      WHERE created_at > ?
    `).get(cutoff) as { total: number; with_outcome: number; successful: number; corrected: number };

    return {
      total: row.total,
      withOutcome: row.with_outcome,
      successful: row.successful,
      corrected: row.corrected,
      accuracyRate: row.with_outcome > 0 ? row.successful / row.with_outcome : 0,
    };
  }

  /** Get the underlying database (for sharing with other modules). */
  getDb(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

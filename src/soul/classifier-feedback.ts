/**
 * Classifier feedback store — records delegation outcomes and provides
 * tier bias based on historical success rates for similar keywords.
 *
 * The feedback loop: delegation completes → record(keywords, tier, cost, success)
 * On next classification: getTierBias(keywords) returns the historically best tier.
 */

import type { Database } from "bun:sqlite";
import type { RelativeTier } from "./types.js";
import { logger } from "../utils/logger.js";

export class ClassifierFeedbackStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS classifier_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        keywords TEXT NOT NULL,
        selected_tier TEXT NOT NULL,
        actual_cost REAL NOT NULL,
        success INTEGER NOT NULL,
        agent TEXT NOT NULL,
        task_type TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    try {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_clf_tier ON classifier_feedback(selected_tier)");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_clf_created ON classifier_feedback(created_at)");
    } catch { /* index may already exist */ }
  }

  record(opts: {
    keywords: string[];
    selectedTier: RelativeTier;
    actualCost: number;
    success: boolean;
    agent: string;
    taskType?: string;
  }): void {
    this.db
      .prepare(
        "INSERT INTO classifier_feedback (keywords, selected_tier, actual_cost, success, agent, task_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        JSON.stringify(opts.keywords),
        opts.selectedTier,
        opts.actualCost,
        opts.success ? 1 : 0,
        opts.agent,
        opts.taskType ?? null,
        Date.now(),
      );
  }

  /**
   * For a set of keywords, which tier has the best success rate?
   * Returns the tier with highest success rate (minimum 5 samples), or null.
   */
  getTierBias(keywords: string[]): RelativeTier | null {
    if (keywords.length === 0) return null;

    // Match any feedback entry that contains at least one of the given keywords
    const conditions = keywords.map(() => "keywords LIKE ?").join(" OR ");
    const params = keywords.map((kw) => `%"${kw}"%`);

    // Only look at last 90 days
    const since = Date.now() - 90 * 86_400_000;
    params.push(String(since));

    type Row = { selected_tier: string; success_rate: number; total: number };
    const rows = this.db
      .prepare(
        `SELECT selected_tier,
                ROUND(CAST(SUM(success) AS REAL) / COUNT(*), 3) as success_rate,
                COUNT(*) as total
         FROM classifier_feedback
         WHERE (${conditions}) AND created_at > ?
         GROUP BY selected_tier
         HAVING COUNT(*) >= 5
         ORDER BY success_rate DESC, total DESC
         LIMIT 1`,
      )
      .all(...params) as Row[];

    if (rows.length === 0) return null;

    const best = rows[0];
    // Only bias if success rate is meaningfully good
    if (best.success_rate < 0.6) return null;

    return best.selected_tier as RelativeTier;
  }

  prune(maxAgeDays: number): number {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const result = this.db.prepare("DELETE FROM classifier_feedback WHERE created_at < ?").run(cutoff);
    if (result.changes > 0) {
      logger.info(`[classifier-feedback] Pruned ${result.changes} entries older than ${maxAgeDays}d`);
    }
    return result.changes;
  }
}

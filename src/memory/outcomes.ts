/**
 * OutcomeStore — Systematic tracking of agent task outcomes.
 *
 * Records the result of every proposal execution with metrics like
 * review verdict, PR status, cost, and duration. Enables pattern
 * extraction and performance analysis.
 */
import type { Database } from "bun:sqlite";

/** Possible result states for a completed task. */
export type OutcomeResult = "success" | "partial" | "failed" | "abandoned";

/** A recorded task outcome with metrics (cost, duration, PR status, etc.). */
export interface TaskOutcome {
  id: number;
  proposal_id: string | null;
  trace_id: string;
  agent: string;
  task_type: string;
  review_verdict: string | null;
  retry_count: number;
  pr_url: string | null;
  pr_merged: number;
  time_to_merge_hours: number | null;
  review_comments_count: number;
  files_changed: number;
  lines_added: number;
  lines_removed: number;
  cost_cents: number | null;
  duration_ms: number | null;
  outcome: OutcomeResult;
  failure_reason: string | null;
  verification_passed: number | null;
  created_at: string;
}

/** SQLite-backed store for tracking agent task execution outcomes and metrics. */
export class OutcomeStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        proposal_id TEXT,
        trace_id TEXT NOT NULL,
        agent TEXT NOT NULL,
        task_type TEXT NOT NULL,
        review_verdict TEXT,
        retry_count INTEGER DEFAULT 0,
        pr_url TEXT,
        pr_merged INTEGER DEFAULT 0,
        time_to_merge_hours REAL,
        review_comments_count INTEGER DEFAULT 0,
        files_changed INTEGER DEFAULT 0,
        lines_added INTEGER DEFAULT 0,
        lines_removed INTEGER DEFAULT 0,
        cost_cents REAL,
        duration_ms INTEGER,
        outcome TEXT NOT NULL,
        failure_reason TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    // Migration: add verification_passed column
    try {
      this.db.exec("ALTER TABLE task_outcomes ADD COLUMN verification_passed INTEGER");
    } catch (err) {
      const msg = String(err);
      if (!msg.includes("already exists") && !msg.includes("duplicate column")) throw err;
    }

    this.db.exec("CREATE INDEX IF NOT EXISTS idx_outcomes_agent ON task_outcomes(agent)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_outcomes_outcome ON task_outcomes(outcome)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_outcomes_created ON task_outcomes(created_at)");
  }

  /** Record a new task outcome. Returns the inserted row. */
  record(opts: {
    proposal_id?: string | null;
    trace_id: string;
    agent: string;
    task_type: string;
    review_verdict?: string | null;
    retry_count?: number;
    pr_url?: string | null;
    files_changed?: number;
    lines_added?: number;
    lines_removed?: number;
    cost_cents?: number | null;
    duration_ms?: number | null;
    outcome: OutcomeResult;
    failure_reason?: string | null;
    verification_passed?: boolean | null;
  }): TaskOutcome {
    this.db.prepare(`
      INSERT INTO task_outcomes (
        proposal_id, trace_id, agent, task_type, review_verdict,
        retry_count, pr_url, files_changed, lines_added, lines_removed,
        cost_cents, duration_ms, outcome, failure_reason, verification_passed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      opts.proposal_id ?? null,
      opts.trace_id,
      opts.agent,
      opts.task_type,
      opts.review_verdict ?? null,
      opts.retry_count ?? 0,
      opts.pr_url ?? null,
      opts.files_changed ?? 0,
      opts.lines_added ?? 0,
      opts.lines_removed ?? 0,
      opts.cost_cents ?? null,
      opts.duration_ms ?? null,
      opts.outcome,
      opts.failure_reason ?? null,
      opts.verification_passed != null ? (opts.verification_passed ? 1 : 0) : null,
    );

    const id = Number((this.db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id);
    return this.getById(id)!;
  }

  /** Get an outcome by its database ID. */
  getById(id: number): TaskOutcome | null {
    return this.db.prepare("SELECT * FROM task_outcomes WHERE id = ?").get(id) as TaskOutcome | null;
  }

  /** Update PR merge status for a given outcome. */
  markMerged(id: number, timeToMergeHours: number): void {
    this.db.prepare(
      "UPDATE task_outcomes SET pr_merged = 1, time_to_merge_hours = ? WHERE id = ?",
    ).run(timeToMergeHours, id);
  }

  /** Update review comments count (from GitHub PR). */
  setReviewComments(id: number, count: number): void {
    this.db.prepare(
      "UPDATE task_outcomes SET review_comments_count = ? WHERE id = ?",
    ).run(count, id);
  }

  /** Query outcomes with filters. */
  query(opts?: {
    agent?: string;
    outcome?: OutcomeResult;
    since?: string;
    until?: string;
    limit?: number;
  }): TaskOutcome[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts?.agent) { conditions.push("agent = ?"); params.push(opts.agent); }
    if (opts?.outcome) { conditions.push("outcome = ?"); params.push(opts.outcome); }
    if (opts?.since) { conditions.push("created_at >= ?"); params.push(opts.since); }
    if (opts?.until) { conditions.push("created_at <= ?"); params.push(opts.until); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts?.limit ?? 100;

    return this.db.prepare(
      `SELECT * FROM task_outcomes ${where} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params, limit) as TaskOutcome[];
  }

  /** Get aggregate stats by agent. */
  getAgentStats(sinceDate?: string): Array<{
    agent: string;
    total: number;
    success: number;
    failed: number;
    success_rate: number;
    avg_cost_cents: number;
    avg_duration_ms: number;
    total_retries: number;
  }> {
    const since = sinceDate ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    return this.db.prepare(`
      SELECT
        agent,
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) as failed,
        ROUND(CAST(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 1) as success_rate,
        ROUND(AVG(cost_cents), 2) as avg_cost_cents,
        ROUND(AVG(duration_ms)) as avg_duration_ms,
        SUM(retry_count) as total_retries
      FROM task_outcomes
      WHERE created_at >= ?
      GROUP BY agent
      ORDER BY total DESC
    `).all(since) as Array<{
      agent: string;
      total: number;
      success: number;
      failed: number;
      success_rate: number;
      avg_cost_cents: number;
      avg_duration_ms: number;
      total_retries: number;
    }>;
  }

  /** Get outcomes for a specific proposal. */
  getByProposal(proposalId: string): TaskOutcome[] {
    return this.db.prepare(
      "SELECT * FROM task_outcomes WHERE proposal_id = ? ORDER BY created_at DESC",
    ).all(proposalId) as TaskOutcome[];
  }

  /** Find outcomes with unmerged PRs (candidates for merge-status check). */
  listUnmergedPRs(): TaskOutcome[] {
    return this.db.prepare(
      "SELECT * FROM task_outcomes WHERE pr_url IS NOT NULL AND pr_merged = 0 ORDER BY created_at ASC",
    ).all() as TaskOutcome[];
  }
}

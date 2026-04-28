/**
 * RoutingStore — Delegation decision log + agent skill matrix.
 *
 * Records every delegation routing decision and links it to outcomes.
 * Enables learned routing: the system can answer "which agent is best for task type X?"
 * based on actual performance data, not just static config.
 *
 * Key concepts:
 * - Routing decision: who delegated to whom, for what type of task, at what time
 * - Outcome link: when a delegation completes, link the result back to the routing decision
 * - Skill matrix: aggregate (agent, task_type) → (success_rate, avg_cost, avg_duration, count)
 * - Routing suggestion: inject skill matrix insights into system prompt for smarter delegation
 */
import type { Database } from "bun:sqlite"
import { logger } from "../utils/logger.js"

export interface RoutingDecisionRecord {
  id: number
  trace_id: string
  from_agent: string
  to_agent: string
  task_type: string
  task_excerpt: string
  model_used: string | null
  outcome: string | null // null = pending, "success" | "partial" | "failed" | "abandoned"
  cost_cents: number | null
  duration_ms: number | null
  created_at: string
  resolved_at: string | null
}

export interface SkillMatrixEntry {
  agent: string
  task_type: string
  total: number
  success: number
  failed: number
  success_rate: number
  avg_cost_cents: number
  avg_duration_ms: number
  review_pass_rate: number | null
}

export interface RoutingSuggestion {
  agent: string
  task_type: string
  success_rate: number
  total_tasks: number
  avg_cost_cents: number
  avg_duration_ms: number
  composite_score: number
}

export class RoutingStore {
  private db: Database

  constructor(db: Database) {
    this.db = db
    this.ensureTable()
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS routing_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        task_type TEXT NOT NULL DEFAULT 'unknown',
        task_excerpt TEXT NOT NULL DEFAULT '',
        model_used TEXT,
        outcome TEXT,
        cost_cents REAL,
        duration_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT
      )
    `)
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_routing_to_agent ON routing_decisions(to_agent)")
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_routing_task_type ON routing_decisions(task_type)")
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_routing_created ON routing_decisions(created_at)")
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_routing_trace ON routing_decisions(trace_id)")
    try { this.db.exec("ALTER TABLE routing_decisions ADD COLUMN review_outcome TEXT"); } catch {}
  }

  /**
   * Log a delegation routing decision.
   * Called when an agent delegates a task to another agent.
   * Returns the decision ID for later outcome linking.
   */
  logDecision(opts: {
    traceId: string
    fromAgent: string
    toAgent: string
    taskType: string
    taskExcerpt: string
    modelUsed?: string
  }): number {
    this.db.prepare(`
      INSERT INTO routing_decisions (trace_id, from_agent, to_agent, task_type, task_excerpt, model_used)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      opts.traceId,
      opts.fromAgent,
      opts.toAgent,
      opts.taskType,
      opts.taskExcerpt.slice(0, 500),
      opts.modelUsed ?? null,
    )

    const id = Number((this.db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id)
    logger.info(`[routing] Logged decision #${id}: ${opts.fromAgent} → ${opts.toAgent} (${opts.taskType})`)
    return id
  }

  /**
   * Link an outcome to a routing decision.
   * Called when a delegation completes (successfully or not).
   */
  resolveDecision(id: number, outcome: string, costCents?: number, durationMs?: number): void {
    this.db.prepare(`
      UPDATE routing_decisions
      SET outcome = ?, cost_cents = ?, duration_ms = ?, resolved_at = datetime('now')
      WHERE id = ?
    `).run(outcome, costCents ?? null, durationMs ?? null, id)
  }

  /**
   * Resolve a routing decision by trace ID and agent (when we don't have the decision ID).
   */
  resolveByTrace(traceId: string, toAgent: string, outcome: string, costCents?: number, durationMs?: number): void {
    this.db.prepare(`
      UPDATE routing_decisions
      SET outcome = ?, cost_cents = ?, duration_ms = ?, resolved_at = datetime('now')
      WHERE trace_id = ? AND to_agent = ? AND outcome IS NULL
    `).run(outcome, costCents ?? null, durationMs ?? null, traceId, toAgent)
  }

  /**
   * Log the review gate outcome for a routing decision (by trace ID).
   * Called after the review gate runs on a completed delegation.
   */
  logReviewOutcome(traceId: string, outcome: "pass" | "warn" | "fail"): void {
    this.db.run(
      "UPDATE routing_decisions SET review_outcome = ? WHERE trace_id = ?",
      [outcome, traceId],
    )
  }

  /**
   * Get a routing decision by ID.
   */
  getById(id: number): RoutingDecisionRecord | null {
    return this.db.prepare("SELECT * FROM routing_decisions WHERE id = ?").get(id) as RoutingDecisionRecord | null
  }

  /**
   * Get recent routing decisions (for debugging/inspection).
   */
  getRecent(limit = 20): RoutingDecisionRecord[] {
    return this.db.prepare(
      "SELECT * FROM routing_decisions ORDER BY created_at DESC LIMIT ?"
    ).all(limit) as RoutingDecisionRecord[]
  }

  /**
   * Build the agent skill matrix — the core of learned routing.
   * Returns (agent, task_type) aggregates for decisions within the time window.
   *
   * @param sinceDays How many days back to include (default: 30)
   * @param minTrials Minimum number of resolved decisions to include (default: 2)
   */
  getSkillMatrix(sinceDays = 30, minTrials = 2): SkillMatrixEntry[] {
    return this.db.prepare(`
      SELECT
        to_agent as agent,
        task_type,
        COUNT(*) as total,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) as failed,
        ROUND(CAST(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 1) as success_rate,
        ROUND(AVG(cost_cents), 2) as avg_cost_cents,
        ROUND(AVG(duration_ms)) as avg_duration_ms,
        ROUND(
          CAST(SUM(CASE WHEN review_outcome = 'pass' THEN 1 ELSE 0 END) AS REAL) /
          NULLIF(SUM(CASE WHEN review_outcome IS NOT NULL THEN 1 ELSE 0 END), 0) * 100, 1
        ) as review_pass_rate
      FROM routing_decisions
      WHERE outcome IS NOT NULL
        AND created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY to_agent, task_type
      HAVING COUNT(*) >= ?
      ORDER BY success_rate DESC, total DESC
    `).all(sinceDays, minTrials) as SkillMatrixEntry[]
  }

  /**
   * Get the best agent for a given task type based on historical performance.
   * Returns null if no data exists for the task type.
   */
  getBestAgentForTaskType(taskType: string, sinceDays = 30, minTrials = 3): RoutingSuggestion | null {
    const result = this.db.prepare(`
      SELECT
        to_agent as agent,
        task_type,
        ROUND(CAST(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 1) as success_rate,
        COUNT(*) as total_tasks,
        ROUND(AVG(cost_cents), 2) as avg_cost_cents
      FROM routing_decisions
      WHERE outcome IS NOT NULL
        AND task_type = ?
        AND created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY to_agent
      HAVING COUNT(*) >= ?
      ORDER BY success_rate DESC, total_tasks DESC
      LIMIT 1
    `).get(taskType, sinceDays, minTrials) as RoutingSuggestion | null

    return result
  }

  /**
   * Get routing suggestions for multiple task types at once.
   * Returns the best-performing agent for each task type.
   */
  getSuggestions(sinceDays = 30, minTrials = 3): RoutingSuggestion[] {
    const matrix = this.getSkillMatrix(sinceDays, minTrials)
    if (matrix.length === 0) return []

    // Group by task_type
    const byType = new Map<string, SkillMatrixEntry[]>()
    for (const entry of matrix) {
      const group = byType.get(entry.task_type) ?? []
      group.push(entry)
      byType.set(entry.task_type, group)
    }

    const scored: RoutingSuggestion[] = []
    for (const [taskType, entries] of byType) {
      const costs = entries.map(e => e.avg_cost_cents).sort((a, b) => a - b)
      const durations = entries.map(e => e.avg_duration_ms).sort((a, b) => a - b)

      let best: { entry: SkillMatrixEntry; score: number } | null = null
      for (const e of entries) {
        const costRank = costs.length > 1
          ? costs.indexOf(e.avg_cost_cents) / (costs.length - 1)
          : 0
        const speedRank = durations.length > 1
          ? durations.indexOf(e.avg_duration_ms) / (durations.length - 1)
          : 0
        const costEfficiency = (1 - costRank) * 100
        const speedFactor = (1 - speedRank) * 100
        const score = e.success_rate * 0.6 + costEfficiency * 0.25 + speedFactor * 0.15

        if (!best || score > best.score) {
          best = { entry: e, score }
        }
      }

      if (best) {
        scored.push({
          agent: best.entry.agent,
          task_type: taskType,
          success_rate: best.entry.success_rate,
          total_tasks: best.entry.total,
          avg_cost_cents: best.entry.avg_cost_cents,
          avg_duration_ms: best.entry.avg_duration_ms ?? 0,
          composite_score: Math.round(best.score * 10) / 10,
        })
      }
    }

    return scored
  }

  /**
   * Format routing suggestions for system prompt injection.
   * Provides the orchestrator with data-driven routing guidance.
   */
  formatForInjection(sinceDays = 30, minTrials = 3): string | null {
    const suggestions = this.getSuggestions(sinceDays, minTrials)
    if (suggestions.length === 0) return null

    const matrix = this.getSkillMatrix(sinceDays, minTrials)

    const lines: string[] = ["## Agent Routing Intelligence"]
    lines.push("Based on recent delegation outcomes:")
    lines.push("")

    for (const s of suggestions) {
      const costNote = s.avg_cost_cents > 0 ? `, ~${s.avg_cost_cents.toFixed(1)}c/task` : ""
      const durationNote = s.avg_duration_ms > 0 ? `, ~${Math.round(s.avg_duration_ms / 1000)}s avg` : ""
      const matrixEntry = matrix.find(e => e.agent === s.agent && e.task_type === s.task_type)
      const reviewNote = matrixEntry?.review_pass_rate != null ? `, ${matrixEntry.review_pass_rate}% clean reviews` : ""
      lines.push(`- **${s.task_type}** tasks: @${s.agent} has ${s.success_rate}% success (${s.total_tasks} tasks${costNote}${durationNote}${reviewNote})`)
    }

    // Flag underperforming pairs
    const lowPerformers = matrix.filter(e => e.success_rate < 50 && e.total >= 3)
    const lowReviewers = matrix.filter(e => e.review_pass_rate != null && e.review_pass_rate < 50 && e.total >= 3)
    if (lowPerformers.length > 0 || lowReviewers.length > 0) {
      lines.push("")
      lines.push("**Watch out:**")
      for (const lp of lowPerformers) {
        lines.push(`- @${lp.agent} struggles with ${lp.task_type} tasks (${lp.success_rate}% success, ${lp.total} trials)`)
      }
      for (const lr of lowReviewers) {
        // Skip if already flagged as low performer for the same pair
        if (!lowPerformers.some(lp => lp.agent === lr.agent && lp.task_type === lr.task_type)) {
          lines.push(`- @${lr.agent} has low review quality on ${lr.task_type} tasks (${lr.review_pass_rate}% clean reviews)`)
        }
      }
    }

    return lines.join("\n")
  }

  /**
   * Get an agent's success rate for a specific task type.
   * Returns the percentage (0-100) or null if insufficient data.
   */
  getAgentSuccessRate(agent: string, taskType: string, sinceDays = 30): number | null {
    const row = this.db.prepare(`
      SELECT
        ROUND(CAST(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 1) as rate
      FROM routing_decisions
      WHERE to_agent = ? AND task_type = ? AND outcome IS NOT NULL
        AND created_at >= datetime('now', '-' || ? || ' days')
      HAVING COUNT(*) >= 2
    `).get(agent, taskType, sinceDays) as { rate: number } | null
    return row?.rate ?? null
  }

  /**
   * Get unresolved decisions older than a threshold (stale delegations).
   */
  getStale(olderThanMinutes = 60): RoutingDecisionRecord[] {
    return this.db.prepare(
      `SELECT * FROM routing_decisions WHERE outcome IS NULL AND created_at < datetime('now', '-' || ? || ' minutes') ORDER BY created_at ASC`
    ).all(olderThanMinutes) as RoutingDecisionRecord[]
  }

  /**
   * Prune old resolved decisions beyond retention period.
   */
  prune(retentionDays = 90): number {
    const result = this.db.run(
      `DELETE FROM routing_decisions WHERE outcome IS NOT NULL AND created_at < datetime('now', '-' || ? || ' days')`,
      [retentionDays],
    )
    return result.changes
  }
}

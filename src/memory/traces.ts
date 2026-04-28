import type { Database } from "bun:sqlite";
import type { ExecutionTrace, TraceEvent } from "../types.js";
import { logger } from "../utils/logger.js";
import { inferModelTrust, type ModelTrustTier } from "../runtime/model-trust.js";

export interface ModelQualityLedgerRow {
  model: string;
  taskType: string | null;
  runs: number;
  completed: number;
  failed: number;
  emptyRuns: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
  avgDurationMs: number;
}

export class TraceStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.initScheduledRunArtifactSchema();
  }

  private initScheduledRunArtifactSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_run_artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        task_name TEXT NOT NULL,
        trace_id TEXT,
        question TEXT NOT NULL,
        decision TEXT NOT NULL,
        outcome TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        artifacts_json TEXT NOT NULL,
        notified INTEGER NOT NULL DEFAULT 0,
        suppression_reason TEXT,
        notification_signature TEXT,
        model_trust_tier TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_run_artifacts_completed ON scheduled_run_artifacts(completed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scheduled_run_artifacts_task ON scheduled_run_artifacts(task_name, completed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scheduled_run_artifacts_trace ON scheduled_run_artifacts(trace_id);
    `);
  }

  startTrace(opts: {
    id: string;
    originMessageId?: string;
    channel: string;
    sender: string;
    senderId?: string;
    inputMessage: string;
  }): string {
    this.db
      .prepare(
        `INSERT INTO execution_traces (id, origin_message_id, channel, sender, sender_id, input_message, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(opts.id, opts.originMessageId ?? null, opts.channel, opts.sender, opts.senderId ?? null, opts.inputMessage, Date.now());
    logger.debug(`[traces] Started trace ${opts.id}`);
    return opts.id;
  }

  startEvent(traceId: string, agent: string, task: string, parentEventId?: number): number {
    const normalizedAgent = agent.toLowerCase();
    const result = this.db
      .prepare(
        `INSERT INTO trace_events (trace_id, parent_event_id, agent, task, status, started_at)
         VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(traceId, parentEventId ?? null, normalizedAgent, task, Date.now());
    const eventId = Number(result.lastInsertRowid);
    logger.debug(`[traces] Started event ${eventId} (${normalizedAgent}) in trace ${traceId}`);
    return eventId;
  }

  completeEvent(eventId: number, data: {
    responseExcerpt?: string;
    tokensIn?: number;
    tokensOut?: number;
    cost?: number;
    durationMs?: number;
    model?: string;
    taskType?: string;
    modelHint?: string;
    billingType?: "subscription" | "api" | "free";
    metadata?: Record<string, unknown>;
  }): void {
    const metadata = data.metadata
      ? { modelTrust: inferModelTrust(data.model), ...data.metadata }
      : { modelTrust: inferModelTrust(data.model) };
    this.db
      .prepare(
        `UPDATE trace_events SET
          status = 'completed',
          response_excerpt = ?,
          tokens_in = ?,
          tokens_out = ?,
          cost = ?,
          duration_ms = ?,
          model = ?,
          task_type = ?,
          model_hint = ?,
          billing_type = ?,
          metadata_json = ?,
          completed_at = ?
         WHERE id = ?`,
      )
      .run(
        data.responseExcerpt ?? null,
        data.tokensIn ?? 0,
        data.tokensOut ?? 0,
        data.cost ?? 0,
        data.durationMs ?? 0,
        data.model ?? null,
        data.taskType ?? null,
        data.modelHint ?? null,
        data.billingType ?? null,
        JSON.stringify(metadata),
        Date.now(),
        eventId,
      );
  }

  failEvent(eventId: number, error: string): void {
    this.db
      .prepare(
        `UPDATE trace_events SET status = 'failed', error = ?, completed_at = ? WHERE id = ?`,
      )
      .run(error, Date.now(), eventId);
  }

  completeTrace(traceId: string, finalResponse: string): void {
    // Aggregate totals from events
    const agg = this.db
      .prepare(
        `SELECT
          COALESCE(SUM(tokens_in), 0) as total_tokens_in,
          COALESCE(SUM(tokens_out), 0) as total_tokens_out,
          COALESCE(SUM(cost), 0) as total_cost,
          COALESCE(SUM(duration_ms), 0) as total_duration_ms,
          COUNT(*) as agent_count
         FROM trace_events WHERE trace_id = ?`,
      )
      .get(traceId) as {
        total_tokens_in: number;
        total_tokens_out: number;
        total_cost: number;
        total_duration_ms: number;
        agent_count: number;
      };

    this.db
      .prepare(
        `UPDATE execution_traces SET
          status = 'completed',
          final_response = ?,
          total_tokens_in = ?,
          total_tokens_out = ?,
          total_cost = ?,
          total_duration_ms = ?,
          agent_count = ?,
          completed_at = ?
         WHERE id = ?`,
      )
      .run(
        finalResponse,
        agg.total_tokens_in,
        agg.total_tokens_out,
        agg.total_cost,
        agg.total_duration_ms,
        agg.agent_count,
        Date.now(),
        traceId,
      );
    logger.debug(`[traces] Completed trace ${traceId} (${agg.agent_count} events, $${agg.total_cost.toFixed(4)})`);
  }

  failTrace(traceId: string, error: string): void {
    this.db
      .prepare(
        `UPDATE execution_traces SET status = 'failed', final_response = ?, completed_at = ? WHERE id = ?`,
      )
      .run(error, Date.now(), traceId);
  }

  getTrace(traceId: string): ExecutionTrace | null {
    return (this.db
      .prepare("SELECT * FROM execution_traces WHERE id = ?")
      .get(traceId) as ExecutionTrace) ?? null;
  }

  getTraceCost(traceId: string): number {
    const result = this.db
      .prepare("SELECT COALESCE(SUM(cost), 0) as total FROM trace_events WHERE trace_id = ?")
      .get(traceId) as { total: number } | undefined;
    return result?.total ?? 0;
  }

  getTraceEvents(traceId: string): TraceEvent[] {
    return this.db
      .prepare("SELECT * FROM trace_events WHERE trace_id = ? ORDER BY started_at ASC")
      .all(traceId) as TraceEvent[];
  }

  getRecentTraces(limit = 20, status?: string): ExecutionTrace[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM execution_traces WHERE status = ? ORDER BY created_at DESC LIMIT ?")
        .all(status, limit) as ExecutionTrace[];
    }
    return this.db
      .prepare("SELECT * FROM execution_traces ORDER BY created_at DESC LIMIT ?")
      .all(limit) as ExecutionTrace[];
  }

  recordScheduledRunArtifact(opts: {
    taskId: string;
    taskName: string;
    traceId?: string | null;
    question: string;
    decision: string;
    outcome: "completed" | "failed" | "deferred";
    evidence: Record<string, unknown>;
    artifacts: Array<Record<string, unknown>>;
    notified: boolean;
    suppressionReason?: string | null;
    notificationSignature?: string | null;
    modelTrustTier?: ModelTrustTier | null;
    startedAt: number;
    completedAt: number;
  }): string {
    const id = `scheduled-${opts.taskId}-${opts.completedAt}`;
    this.db
      .prepare(
        `INSERT INTO scheduled_run_artifacts
          (id, task_id, task_name, trace_id, question, decision, outcome, evidence_json, artifacts_json,
           notified, suppression_reason, notification_signature, model_trust_tier, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        opts.taskId,
        opts.taskName,
        opts.traceId ?? null,
        opts.question,
        opts.decision,
        opts.outcome,
        JSON.stringify(opts.evidence),
        JSON.stringify(opts.artifacts),
        opts.notified ? 1 : 0,
        opts.suppressionReason ?? null,
        opts.notificationSignature ?? null,
        opts.modelTrustTier ?? null,
        opts.startedAt,
        opts.completedAt,
      );
    return id;
  }

  getRecentScheduledRunArtifacts(limit = 20): Array<{
    id: string;
    task_id: string;
    task_name: string;
    trace_id: string | null;
    question: string;
    decision: string;
    outcome: string;
    evidence_json: string;
    artifacts_json: string;
    notified: number;
    suppression_reason: string | null;
    notification_signature: string | null;
    model_trust_tier: string | null;
    started_at: number;
    completed_at: number;
  }> {
    return this.db
      .prepare("SELECT * FROM scheduled_run_artifacts ORDER BY completed_at DESC LIMIT ?")
      .all(Math.max(1, Math.min(limit, 200))) as Array<{
        id: string;
        task_id: string;
        task_name: string;
        trace_id: string | null;
        question: string;
        decision: string;
        outcome: string;
        evidence_json: string;
        artifacts_json: string;
        notified: number;
        suppression_reason: string | null;
        notification_signature: string | null;
        model_trust_tier: string | null;
        started_at: number;
        completed_at: number;
      }>;
  }

  getMetrics(sinceHours = 24): {
    total: number;
    completed: number;
    failed: number;
    error_rate: number;
    latency_p50_ms: number;
    latency_p95_ms: number;
    latency_avg_ms: number;
    by_agent: Array<{ agent: string; count: number; avg_ms: number; cost: number; errors: number }>;
  } {
    const since = Date.now() - sinceHours * 60 * 60 * 1000;

    const counts = this.db
      .prepare("SELECT status, COUNT(*) as count FROM execution_traces WHERE created_at > ? GROUP BY status")
      .all(since) as Array<{ status: string; count: number }>;

    const total = counts.reduce((s, r) => s + r.count, 0);
    const completed = counts.find(r => r.status === "completed")?.count ?? 0;
    const failed = counts.find(r => r.status === "failed")?.count ?? 0;

    // Latency percentiles from completed traces
    const durations = this.db
      .prepare("SELECT total_duration_ms FROM execution_traces WHERE created_at > ? AND status = 'completed' AND total_duration_ms > 0 ORDER BY total_duration_ms ASC")
      .all(since) as Array<{ total_duration_ms: number }>;

    const p50 = durations.length > 0 ? durations[Math.floor(durations.length * 0.5)]?.total_duration_ms ?? 0 : 0;
    const p95 = durations.length > 0 ? durations[Math.floor(durations.length * 0.95)]?.total_duration_ms ?? 0 : 0;
    const avg = durations.length > 0 ? Math.round(durations.reduce((s, d) => s + d.total_duration_ms, 0) / durations.length) : 0;

    // Per-agent breakdown
    const byAgent = this.db
      .prepare(`SELECT agent, COUNT(*) as count,
                AVG(duration_ms) as avg_ms,
                COALESCE(SUM(cost), 0) as cost,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as errors
                FROM trace_events WHERE started_at > ?
                GROUP BY agent ORDER BY cost DESC`)
      .all(since) as Array<{ agent: string; count: number; avg_ms: number; cost: number; errors: number }>;

    return {
      total,
      completed,
      failed,
      error_rate: total > 0 ? Math.round((failed / total) * 1000) / 10 : 0,
      latency_p50_ms: p50,
      latency_p95_ms: p95,
      latency_avg_ms: avg,
      by_agent: byAgent.map(a => ({ ...a, avg_ms: Math.round(a.avg_ms), cost: Math.round(a.cost * 10000) / 10000 })),
    };
  }

  /**
   * Get success rates grouped by model and task type.
   * Used for the cost feedback loop — identifies which models succeed
   * at which task types, enabling data-driven routing decisions.
   */
  getSuccessRates(sinceHours = 168): Array<{
    model: string;
    task_type: string;
    total: number;
    completed: number;
    failed: number;
    success_rate: number;
    avg_cost: number;
    avg_duration_ms: number;
  }> {
    const since = Date.now() - sinceHours * 60 * 60 * 1000;

    return this.db
      .prepare(`
        SELECT
          model,
          task_type,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          ROUND(CAST(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) * 100, 1) as success_rate,
          ROUND(AVG(cost), 4) as avg_cost,
          ROUND(AVG(duration_ms)) as avg_duration_ms
        FROM trace_events
        WHERE started_at > ?
          AND model IS NOT NULL
          AND task_type IS NOT NULL
        GROUP BY model, task_type
        HAVING COUNT(*) >= 3
        ORDER BY task_type, success_rate DESC
      `)
      .all(since) as Array<{
        model: string;
        task_type: string;
        total: number;
        completed: number;
        failed: number;
        success_rate: number;
        avg_cost: number;
        avg_duration_ms: number;
      }>;
  }

  getAgentEvents(agentKey: string, limit = 20): TraceEvent[] {
    return this.db
      .prepare("SELECT * FROM trace_events WHERE agent = ? ORDER BY started_at DESC LIMIT ?")
      .all(agentKey, limit) as TraceEvent[];
  }

  getCostByAgent(sinceMs: number): Array<{
    agent: string;
    count: number;
    total_cost: number;
    actual_cost: number;
    tokens_in: number;
    tokens_out: number;
    avg_duration: number;
    models: string[];
    task_types: Array<{ type: string; count: number; cost: number }>;
  }> {
    type AgentRow = { agent: string; count: number; total_cost: number; actual_cost: number; tokens_in: number; tokens_out: number; avg_duration: number };
    type ModelRow = { agent: string; model: string };
    type TaskRow = { agent: string; type: string; count: number; cost: number };

    const rows = this.db
      .prepare(
        `SELECT LOWER(agent) as agent,
          COUNT(*) as count,
          COALESCE(SUM(cost), 0) as total_cost,
          COALESCE(SUM(CASE WHEN billing_type = 'api' THEN cost ELSE 0 END), 0) as actual_cost,
          COALESCE(SUM(tokens_in), 0) as tokens_in,
          COALESCE(SUM(tokens_out), 0) as tokens_out,
          ROUND(AVG(duration_ms)) as avg_duration
         FROM trace_events WHERE started_at > ? AND agent NOT LIKE '%.%'
         GROUP BY LOWER(agent) ORDER BY total_cost DESC`,
      )
      .all(sinceMs) as AgentRow[];

    const modelRows = this.db
      .prepare("SELECT LOWER(agent) as agent, model FROM trace_events WHERE started_at > ? AND model IS NOT NULL AND agent NOT LIKE '%.%' GROUP BY LOWER(agent), model")
      .all(sinceMs) as ModelRow[];

    const taskRows = this.db
      .prepare(
        `SELECT LOWER(agent) as agent, task_type as type, COUNT(*) as count,
         SUM(CASE WHEN billing_type = 'api' THEN cost ELSE 0 END) as cost
         FROM trace_events WHERE started_at > ? AND task_type IS NOT NULL AND agent NOT LIKE '%.%'
         GROUP BY LOWER(agent), task_type ORDER BY count DESC`,
      )
      .all(sinceMs) as TaskRow[];

    return rows.map((row) => ({
      ...row,
      models: modelRows.filter((m) => m.agent === row.agent).map((m) => m.model),
      task_types: taskRows.filter((t) => t.agent === row.agent).slice(0, 5),
    }));
  }

  getCostByUser(sinceMs: number): Array<{
    sender_id: string;
    sender: string;
    channel: string;
    conversations: number;
    invocations: number;
    total_cost: number;
    actual_cost: number;
    tokens_in: number;
    tokens_out: number;
    first_seen: number;
    last_seen: number;
  }> {
    type UserRow = {
      sender_id: string;
      sender: string;
      channel: string;
      conversations: number;
      invocations: number;
      total_cost: number;
      actual_cost: number;
      tokens_in: number;
      tokens_out: number;
      first_seen: number;
      last_seen: number;
    };

    return this.db
      .prepare(
        `SELECT
          et.sender_id,
          et.sender,
          et.channel,
          COUNT(DISTINCT et.id) as conversations,
          COUNT(te.id) as invocations,
          COALESCE(SUM(te.cost), 0) as total_cost,
          COALESCE(SUM(CASE WHEN te.billing_type = 'api' THEN te.cost ELSE 0 END), 0) as actual_cost,
          COALESCE(SUM(te.tokens_in), 0) as tokens_in,
          COALESCE(SUM(te.tokens_out), 0) as tokens_out,
          MIN(et.created_at) as first_seen,
          MAX(et.created_at) as last_seen
        FROM execution_traces et
        JOIN trace_events te ON te.trace_id = et.id
        WHERE et.created_at > ?
          AND et.sender_id IS NOT NULL
          AND et.channel = 'slack'
          AND et.sender_id NOT LIKE 'thread:%'
          AND et.sender_id NOT LIKE 'scheduler:%'
        GROUP BY et.sender_id
        ORDER BY total_cost DESC`,
      )
      .all(sinceMs) as UserRow[];
  }

  getModelQualityLedger(opts: { sinceMs: number; limit?: number }): ModelQualityLedgerRow[] {
    const rows = this.db
      .prepare(`
        SELECT
          COALESCE(model, 'unknown') AS model,
          task_type AS taskType,
          COUNT(*) AS runs,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN error LIKE '%completed without an assistant response%' THEN 1 ELSE 0 END) AS emptyRuns,
          COALESCE(SUM(tokens_in), 0) AS tokensIn,
          COALESCE(SUM(tokens_out), 0) AS tokensOut,
          COALESCE(SUM(cost), 0) AS cost,
          COALESCE(AVG(duration_ms), 0) AS avgDurationMs
        FROM trace_events
        WHERE started_at >= ? AND model IS NOT NULL
        GROUP BY model, task_type
        ORDER BY runs DESC, cost DESC
        LIMIT ?
      `)
      .all(opts.sinceMs, opts.limit ?? 50) as ModelQualityLedgerRow[];
    return rows.map((row) => ({
      ...row,
      runs: Number(row.runs),
      completed: Number(row.completed),
      failed: Number(row.failed),
      emptyRuns: Number(row.emptyRuns),
      tokensIn: Number(row.tokensIn),
      tokensOut: Number(row.tokensOut),
      cost: Number(row.cost),
      avgDurationMs: Number(row.avgDurationMs),
    }));
  }

  /**
   * Get model hint usage stats — how often orchestrators use hints
   * and whether hinted tasks succeed.
   */
  /**
   * Get daily cost history for trend analysis (briefing digest).
   */
  getDailyCostHistory(days: number): Array<{ date: string; cost: number }> {
    const since = Date.now() - days * 86_400_000;
    return this.db
      .prepare(`
        SELECT date(started_at / 1000, 'unixepoch', 'localtime') as date,
               COALESCE(SUM(CASE WHEN billing_type = 'api' THEN cost ELSE 0 END), 0) as cost
        FROM trace_events
        WHERE started_at > ?
        GROUP BY date
        ORDER BY date ASC
      `)
      .all(since) as Array<{ date: string; cost: number }>;
  }

  /**
   * Prune old traces and their events. Returns counts of deleted rows.
   */
  pruneOldTraces(maxAgeDays: number): { traces: number; events: number } {
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    const eventResult = this.db
      .prepare(
        "DELETE FROM trace_events WHERE trace_id IN (SELECT id FROM execution_traces WHERE created_at < ?)",
      )
      .run(cutoff);
    const traceResult = this.db
      .prepare("DELETE FROM execution_traces WHERE created_at < ?")
      .run(cutoff);
    const events = eventResult.changes;
    const traces = traceResult.changes;
    if (traces > 0 || events > 0) {
      logger.info(`[traces] Pruned ${traces} traces + ${events} events older than ${maxAgeDays}d`);
    }
    return { traces, events };
  }

  getHintStats(sinceHours = 168): Array<{
    model_hint: string;
    resolved_model: string | null;
    total: number;
    completed: number;
    failed: number;
    avg_cost: number;
  }> {
    const since = Date.now() - sinceHours * 60 * 60 * 1000;

    return this.db
      .prepare(`
        SELECT
          model_hint,
          model as resolved_model,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          ROUND(AVG(cost), 4) as avg_cost
        FROM trace_events
        WHERE started_at > ?
          AND model_hint IS NOT NULL
        GROUP BY model_hint, model
        ORDER BY total DESC
      `)
      .all(since) as Array<{
        model_hint: string;
        resolved_model: string | null;
        total: number;
        completed: number;
        failed: number;
        avg_cost: number;
      }>;
  }
}

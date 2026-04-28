/**
 * PatternStore — Extract and store agent performance patterns from outcomes.
 *
 * Weekly distillation gathers recent outcomes and produces structured
 * patterns stored as knowledge chunks. Patterns track agent behaviour,
 * common failure modes, and successful approaches.
 */
import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

/** A stored agent performance pattern with confidence score and expiry. */
export interface AgentPattern {
  id: number;
  agent: string;
  pattern: string;
  confidence: number;
  evidence_count: number;
  recommendation: string;
  category: string;
  created_at: string;
  expires_at: string;
}

/** Input for recording a new agent pattern (without auto-generated fields). */
export interface PatternInput {
  agent: string;
  pattern: string;
  confidence: number;
  evidence_count: number;
  recommendation: string;
  category: string;
}

/** SQLite-backed store for agent performance patterns extracted from outcome distillation. */
export class PatternStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_patterns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        pattern TEXT NOT NULL,
        confidence REAL NOT NULL,
        evidence_count INTEGER NOT NULL DEFAULT 1,
        recommendation TEXT NOT NULL,
        category TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL DEFAULT (datetime('now', '+56 days'))
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_patterns_agent ON agent_patterns(agent)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_patterns_category ON agent_patterns(category)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_patterns_expires ON agent_patterns(expires_at)");
  }

  /** Store a new pattern from distillation. */
  record(input: PatternInput): AgentPattern {
    this.db.prepare(`
      INSERT INTO agent_patterns (agent, pattern, confidence, evidence_count, recommendation, category)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.agent,
      input.pattern,
      input.confidence,
      input.evidence_count,
      input.recommendation,
      input.category,
    );

    const id = Number((this.db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id);
    return this.getById(id)!;
  }

  /** Get a pattern by its database ID. */
  getById(id: number): AgentPattern | null {
    return this.db.prepare("SELECT * FROM agent_patterns WHERE id = ?").get(id) as AgentPattern | null;
  }

  /** Get patterns for a specific agent, filtered by confidence and expiry. */
  getForAgent(agent: string, opts?: { minConfidence?: number; limit?: number }): AgentPattern[] {
    const minConf = opts?.minConfidence ?? 0.5;
    const limit = opts?.limit ?? 10;

    return this.db.prepare(`
      SELECT * FROM agent_patterns
      WHERE agent = ? AND confidence >= ? AND expires_at > datetime('now')
      ORDER BY confidence DESC, evidence_count DESC
      LIMIT ?
    `).all(agent, minConf, limit) as AgentPattern[];
  }

  /**
   * Search patterns relevant to a task. Matches on agent name,
   * pattern category, and keyword overlap with the task description.
   */
  searchRelevant(opts: {
    agent?: string;
    taskType?: string;
    filePaths?: string[];
    limit?: number;
  }): AgentPattern[] {
    const conditions: string[] = ["confidence >= 0.5", "expires_at > datetime('now')"];
    const params: (string | number)[] = [];

    if (opts.agent) {
      conditions.push("agent = ?");
      params.push(opts.agent);
    }

    if (opts.taskType) {
      conditions.push("category = ?");
      params.push(opts.taskType);
    }

    const limit = opts.limit ?? 3;
    const where = conditions.join(" AND ");

    const results = this.db.prepare(`
      SELECT * FROM agent_patterns
      WHERE ${where}
      ORDER BY confidence DESC, evidence_count DESC
      LIMIT ?
    `).all(...params, limit) as AgentPattern[];

    // If file paths provided, boost patterns that mention any of them
    if (opts.filePaths && opts.filePaths.length > 0) {
      results.sort((a, b) => {
        const aMatch = opts.filePaths!.some(p => a.pattern.toLowerCase().includes(p.toLowerCase())) ? 1 : 0;
        const bMatch = opts.filePaths!.some(p => b.pattern.toLowerCase().includes(p.toLowerCase())) ? 1 : 0;
        if (bMatch !== aMatch) return bMatch - aMatch;
        return b.confidence - a.confidence;
      });
    }

    return results.slice(0, limit);
  }

  /** Format patterns as injection context (max ~500 tokens). */
  formatForInjection(patterns: AgentPattern[]): string | null {
    if (patterns.length === 0) return null;

    const lines: string[] = ["## Lessons Learned"];
    let tokenEstimate = 5; // Header

    for (const p of patterns) {
      const line = `- ${p.pattern} → ${p.recommendation} (confidence: ${Math.round(p.confidence * 100)}%, evidence: ${p.evidence_count})`;
      const lineTokens = Math.ceil(line.length / 4);
      if (tokenEstimate + lineTokens > 500) break;
      lines.push(line);
      tokenEstimate += lineTokens;
    }

    return lines.length > 1 ? lines.join("\n") : null;
  }

  /** Prune patterns per agent, keeping last N weekly distillations. */
  pruneOld(agent: string, keepCount = 8): number {
    // Count distinct distillation batches (grouped by created_at date)
    const batches = this.db.prepare(`
      SELECT DISTINCT date(created_at) as batch_date
      FROM agent_patterns
      WHERE agent = ?
      ORDER BY batch_date DESC
    `).all(agent) as Array<{ batch_date: string }>;

    if (batches.length <= keepCount) return 0;

    const cutoffDate = batches[keepCount - 1].batch_date;
    const result = this.db.run(
      "DELETE FROM agent_patterns WHERE agent = ? AND date(created_at) < ?",
      [agent, cutoffDate],
    );
    return result.changes;
  }

  /** Remove expired patterns. */
  pruneExpired(): number {
    const result = this.db.run(
      "DELETE FROM agent_patterns WHERE expires_at <= datetime('now')",
    );
    return result.changes;
  }

  /** Get all patterns (for testing / debugging). */
  getAll(): AgentPattern[] {
    return this.db.prepare("SELECT * FROM agent_patterns ORDER BY created_at DESC").all() as AgentPattern[];
  }

  /** Get distinct agents with patterns. */
  getAgents(): string[] {
    return (this.db.prepare("SELECT DISTINCT agent FROM agent_patterns").all() as Array<{ agent: string }>)
      .map(r => r.agent);
  }
}

/**
 * Parse structured patterns from an analyst's response.
 * Expected format: JSON array of { pattern, agent, confidence, evidence_count, recommendation, category }
 */
export function parsePatternResponse(raw: string): PatternInput[] {
  const trimmed = raw.trim();

  // Try to extract JSON array from response (handle markdown fences)
  let jsonStr = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    const items = Array.isArray(parsed) ? parsed : [parsed];

    return items
      .filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null &&
        typeof item.pattern === "string" &&
        typeof item.agent === "string" &&
        typeof item.recommendation === "string"
      )
      .map(item => ({
        agent: String(item.agent),
        pattern: String(item.pattern),
        confidence: typeof item.confidence === "number" ? Math.min(1, Math.max(0, item.confidence)) : 0.5,
        evidence_count: typeof item.evidence_count === "number" ? item.evidence_count : 1,
        recommendation: String(item.recommendation),
        category: typeof item.category === "string" ? item.category : "general",
      }));
  } catch {
    logger.warn(`[patterns] Failed to parse pattern response: ${trimmed.slice(0, 200)}`);
    return [];
  }
}

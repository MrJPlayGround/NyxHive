/**
 * Wisdom Propagation — extract and inject learnings across delegation runs.
 *
 * After each run completes, extract task-level learnings (conventions, gotchas,
 * successes, failures). On dispatch, inject relevant learnings into the agent's
 * system prompt.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { ensureTableSchema } from "../utils/schema.js";

export interface Wisdom {
  id: number;
  run_id: string;
  project: string;
  agent: string;
  category: "convention" | "gotcha" | "success" | "failure";
  content: string;
  confidence: number;  // 0-1
  created_at: number;
}

interface WisdomRow {
  id: number;
  run_id: string;
  project: string;
  agent: string;
  category: string;
  content: string;
  confidence: number;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wisdom (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  project TEXT NOT NULL,
  agent TEXT NOT NULL,
  category TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wisdom_project_agent ON wisdom(project, agent, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wisdom_run ON wisdom(run_id);
`;

const VALID_CATEGORIES = new Set(["convention", "gotcha", "success", "failure"]);

export class WisdomStore {
  private db: Database;

  constructor(dataDir: string, instanceName?: string) {
    const dbPath = join(dataDir, `${instanceName ?? "nyxhive"}.db`);
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    ensureTableSchema(this.db, {
      table: "wisdom",
      required: ["id", "run_id", "project", "agent", "category", "content", "confidence", "created_at"],
      ephemeral: false,
      columnDefs: {
        confidence: "REAL NOT NULL DEFAULT 0.5",
      },
    }, "wisdom");
    this.db.exec(SCHEMA);
  }

  /** Store extracted wisdom entries from a completed run. */
  store(entries: Array<Omit<Wisdom, "id" | "created_at">>): number {
    const stmt = this.db.prepare(
      "INSERT INTO wisdom (run_id, project, agent, category, content, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const now = Date.now();
    let count = 0;
    for (const entry of entries) {
      if (!VALID_CATEGORIES.has(entry.category)) continue;
      if (!entry.content.trim()) continue;
      stmt.run(entry.run_id, entry.project, entry.agent, entry.category, entry.content.trim(), entry.confidence, now);
      count++;
    }
    if (count > 0) {
      logger.info(`[wisdom] Stored ${count} entries for run ${entries[0]?.run_id}`);
    }
    return count;
  }

  /** Query relevant wisdom for a project+agent combo. */
  query(project: string, agent?: string, limit = 5): Wisdom[] {
    const rows = agent
      ? this.db.prepare(
          "SELECT * FROM wisdom WHERE project = ? AND (agent = ? OR agent = '*') ORDER BY confidence DESC, created_at DESC LIMIT ?",
        ).all(project, agent, limit) as WisdomRow[]
      : this.db.prepare(
          "SELECT * FROM wisdom WHERE project = ? ORDER BY confidence DESC, created_at DESC LIMIT ?",
        ).all(project, limit) as WisdomRow[];

    return rows.map((row) => ({
      ...row,
      category: row.category as Wisdom["category"],
    }));
  }

  /** Format wisdom entries for injection into a system prompt. */
  formatForInjection(entries: Wisdom[]): string | null {
    if (entries.length === 0) return null;

    const lines = entries.map((w) => {
      const icon = w.category === "convention" ? "Convention"
        : w.category === "gotcha" ? "Gotcha"
        : w.category === "success" ? "Success"
        : "Failure";
      return `- [${icon}] ${w.content}`;
    });

    return [
      "## Learnings from Previous Runs",
      ...lines,
    ].join("\n");
  }

  /** Parse extraction response into structured entries. */
  static parseExtractionResponse(
    response: string,
    runId: string,
    project: string,
    agent: string,
  ): Array<Omit<Wisdom, "id" | "created_at">> {
    try {
      // Try to extract JSON array from the response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];
      const parsed = JSON.parse(jsonMatch[0]) as Array<{
        category?: string;
        content?: string;
        confidence?: number;
      }>;
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((item) => item.category && item.content && VALID_CATEGORIES.has(item.category))
        .map((item) => ({
          run_id: runId,
          project,
          agent,
          category: item.category as Wisdom["category"],
          content: String(item.content).slice(0, 500),
          confidence: Math.min(1, Math.max(0, Number(item.confidence) || 0.5)),
        }));
    } catch {
      logger.debug(`[wisdom] Failed to parse extraction response for run ${runId}`);
      return [];
    }
  }

  /** Build the extraction prompt for post-run wisdom extraction. */
  static buildExtractionPrompt(taskDescription: string, response: string): string {
    const excerpt = response.length > 3000 ? response.slice(-3000) : response;
    return [
      "Extract learnings from this completed task. Return a JSON array of objects with:",
      '  { "category": "convention"|"gotcha"|"success"|"failure", "content": "...", "confidence": 0.0-1.0 }',
      "",
      "Only include genuinely useful learnings. Skip trivial observations.",
      "",
      `Task: ${taskDescription.slice(0, 500)}`,
      "",
      "Response excerpt:",
      excerpt,
    ].join("\n");
  }

  /** Prune old entries (keep last 500 per project). */
  prune(maxPerProject = 500): number {
    const projects = this.db.prepare("SELECT DISTINCT project FROM wisdom").all() as Array<{ project: string }>;
    let pruned = 0;
    for (const { project } of projects) {
      const count = (this.db.prepare("SELECT COUNT(*) as c FROM wisdom WHERE project = ?").get(project) as { c: number }).c;
      if (count > maxPerProject) {
        const toDelete = count - maxPerProject;
        this.db.prepare(
          "DELETE FROM wisdom WHERE project = ? AND id IN (SELECT id FROM wisdom WHERE project = ? ORDER BY created_at ASC LIMIT ?)",
        ).run(project, project, toDelete);
        pruned += toDelete;
      }
    }
    return pruned;
  }

  close(): void {
    this.db.close();
  }
}

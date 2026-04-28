import { Database } from "bun:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { ensureTableSchema } from "../utils/schema.js";
import { emitActivity } from "../activity/ring-buffer.js";

function safeJsonParse<T>(val: string | null | undefined, fallback: T): T {
  if (!val) return fallback;
  try {
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}

// --- Similarity helpers ---

/** Normalize a string to lowercase word tokens, stripping punctuation */
export function normalizeWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 1)
  );
}

/** Jaccard similarity between two word sets: |intersection| / |union| */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// --- Types ---

export type ProposalCategory = "maintenance" | "feature" | "bugfix" | "improvement" | "new_instance";
export type ProposalAutonomy = "auto" | "requires_approval";
export type ProposalStatus = "proposed" | "reviewing" | "reviewed" | "approved" | "rejected" | "executing" | "completed" | "merged" | "failed" | "expired";
export type ProposalPriority = "low" | "medium" | "high";
export type ProposalEffort = "small" | "medium" | "large";
export type ExecutionTrigger = "auto" | "approval" | "manual";

export interface Proposal {
  id: number;
  proposal_id: string;
  title: string;
  description: string;
  category: ProposalCategory;
  autonomy: ProposalAutonomy;
  status: ProposalStatus;
  priority: ProposalPriority;
  effort: ProposalEffort;
  files_affected: string[];
  thread_id: string | null;
  proposed_by: string;
  scout_source: string | null;
  approved_by: string | null;
  approved_at: number | null;
  rejection_reason: string | null;
  execution_ref: string | null;
  execution_result: string | null;
  executed_by: string | null;
  execution_trigger: ExecutionTrigger | null;
  review_result: string | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  verdict: string | null;
  review_count: number;
  pr_url: string | null;
  pr_mergeable: string | null;
  merged_at: number | null;
  merged_by: string | null;
  nudged_at: number | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

// --- Constants ---

/** Default proposal expiry: 7 days */
export const PROPOSAL_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
/** Nudge after 48 hours of inaction */
export const PROPOSAL_NUDGE_MS = 48 * 60 * 60 * 1000;

// --- Schema ---

const SCHEMA = `
CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'improvement',
    autonomy TEXT NOT NULL DEFAULT 'requires_approval',
    status TEXT NOT NULL DEFAULT 'proposed',
    priority TEXT NOT NULL DEFAULT 'medium',
    effort TEXT NOT NULL DEFAULT 'medium',
    files_affected TEXT DEFAULT '[]',
    thread_id TEXT,
    proposed_by TEXT NOT NULL,
    scout_source TEXT,
    approved_by TEXT,
    approved_at INTEGER,
    rejection_reason TEXT,
    execution_ref TEXT,
    execution_result TEXT,
    executed_by TEXT,
    pr_url TEXT,
    merged_at INTEGER,
    merged_by TEXT,
    nudged_at INTEGER,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_proposals_autonomy ON proposals(autonomy, status);
`;

// --- Row → Proposal mapping ---

interface ProposalRow {
  id: number;
  proposal_id: string;
  title: string;
  description: string;
  category: string;
  autonomy: string;
  status: string;
  priority: string;
  effort: string;
  files_affected: string;
  thread_id: string | null;
  proposed_by: string;
  scout_source: string | null;
  approved_by: string | null;
  approved_at: number | null;
  rejection_reason: string | null;
  execution_ref: string | null;
  execution_result: string | null;
  executed_by: string | null;
  execution_trigger: string | null;
  verdict: string | null;
  pr_url: string | null;
  pr_mergeable: string | null;
  merged_at: number | null;
  merged_by: string | null;
  review_result: string | null;
  reviewed_by: string | null;
  reviewed_at: number | null;
  review_count: number;
  nudged_at: number | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToProposal(row: ProposalRow): Proposal {
  return {
    ...row,
    category: row.category as ProposalCategory,
    autonomy: row.autonomy as ProposalAutonomy,
    status: row.status as ProposalStatus,
    priority: row.priority as ProposalPriority,
    effort: row.effort as ProposalEffort,
    execution_trigger: (row.execution_trigger as ExecutionTrigger) ?? null,
    review_count: row.review_count ?? 0,
    files_affected: safeJsonParse<string[]>(row.files_affected, []),
  };
}

// --- Store ---

export class ProposalStore {
  private db: Database;

  constructor(dataDir: string, instanceName?: string) {
    const dbPath = join(dataDir, `${instanceName ?? "nyxhive"}.db`);
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    const walCheck = this.db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
    if (walCheck?.journal_mode !== "wal") {
      logger.warn(`[proposals] WAL mode not active (journal_mode=${walCheck?.journal_mode}), performance may be degraded`);
    }
    this.db.exec("PRAGMA busy_timeout = 5000");

    ensureTableSchema(this.db, {
      table: "proposals",
      required: [
        "id", "proposal_id", "title", "description", "category", "autonomy",
        "status", "priority", "effort", "files_affected", "proposed_by",
        "thread_id",
        "scout_source", "approved_by", "approved_at", "rejection_reason",
        "execution_ref", "execution_result", "executed_by",
        "review_result", "reviewed_by", "reviewed_at", "verdict", "review_count",
        "nudged_at", "expires_at", "created_at", "updated_at",
      ],
      ephemeral: true,
    }, "proposals");

    this.db.exec(SCHEMA);

    // Migration: add review columns
    const cols = this.db.query("PRAGMA table_info(proposals)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map(c => c.name));
    if (!colNames.has("review_result")) {
      this.db.run("ALTER TABLE proposals ADD COLUMN review_result TEXT");
    }
    if (!colNames.has("reviewed_by")) {
      this.db.run("ALTER TABLE proposals ADD COLUMN reviewed_by TEXT");
    }
    if (!colNames.has("reviewed_at")) {
      this.db.run("ALTER TABLE proposals ADD COLUMN reviewed_at INTEGER");
    }
    if (!colNames.has("thread_id")) {
      this.db.run("ALTER TABLE proposals ADD COLUMN thread_id TEXT");
    }
    if (!colNames.has("pr_url")) {
      this.db.run("ALTER TABLE proposals ADD COLUMN pr_url TEXT");
    }
    if (!colNames.has("merged_at")) {
      this.db.run("ALTER TABLE proposals ADD COLUMN merged_at INTEGER");
    }
    if (!colNames.has("merged_by")) {
      this.db.run("ALTER TABLE proposals ADD COLUMN merged_by TEXT");
    }
    if (!colNames.has("verdict")) {
      this.db.run("ALTER TABLE proposals ADD COLUMN verdict TEXT");
    }
    if (!colNames.has("execution_trigger")) {
      this.db.run("ALTER TABLE proposals ADD COLUMN execution_trigger TEXT");
    }
    if (!colNames.has("review_count")) {
      this.db.run("ALTER TABLE proposals ADD COLUMN review_count INTEGER DEFAULT 0");
    }
    if (!colNames.has("pr_mergeable")) {
      this.db.run("ALTER TABLE proposals ADD COLUMN pr_mergeable TEXT");
    }

    // Recover orphaned proposals from interrupted processes (e.g. server restart)
    const resetExecuting = this.db.run(
      "UPDATE proposals SET status = 'approved', execution_ref = NULL, updated_at = ? WHERE status = 'executing'",
      [Date.now()],
    );
    if (resetExecuting.changes > 0) {
      logger.info(`[proposals] Recovered ${resetExecuting.changes} orphaned executing → approved`);
    }
    const resetReviewing = this.db.run(
      "UPDATE proposals SET status = 'proposed', updated_at = ? WHERE status = 'reviewing'",
      [Date.now()],
    );
    if (resetReviewing.changes > 0) {
      logger.info(`[proposals] Recovered ${resetReviewing.changes} orphaned reviewing → proposed`);
    }

    logger.info("[proposals] Proposal store ready");
  }

  create(opts: {
    title: string;
    description: string;
    category: ProposalCategory;
    priority?: ProposalPriority;
    effort?: ProposalEffort;
    files_affected?: string[];
    thread_id?: string | null;
    proposed_by: string;
    scout_source?: string;
    autonomy?: ProposalAutonomy;
  }): Proposal {
    const proposalId = `proposal-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    // Sanitize files_affected: reject absolute paths, traversal, and null bytes
    const safeFiles = (opts.files_affected ?? []).filter(
      f => f && !f.includes("\0") && !f.startsWith("/") && !f.startsWith("\\") && !f.includes("..")
    );

    this.db.run(
      `INSERT INTO proposals (
        proposal_id, title, description, category, autonomy, status, priority, effort,
        files_affected, thread_id, proposed_by, scout_source, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        proposalId,
        opts.title,
        opts.description,
        opts.category,
        opts.autonomy ?? "requires_approval",
        opts.priority ?? "medium",
        opts.effort ?? "medium",
        JSON.stringify(safeFiles),
        opts.thread_id ?? null,
        opts.proposed_by,
        opts.scout_source ?? null,
        now + PROPOSAL_EXPIRY_MS,
        now,
        now,
      ],
    );

    return this.get(proposalId)!;
  }

  get(proposalId: string): Proposal | null {
    const row = this.db.query("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId) as ProposalRow | null;
    return row ? rowToProposal(row) : null;
  }

  list(opts?: { status?: ProposalStatus; category?: ProposalCategory; autonomy?: ProposalAutonomy }): Proposal[] {
    const conditions: string[] = [];
    const params: string[] = [];

    if (opts?.status) { conditions.push("status = ?"); params.push(opts.status); }
    if (opts?.category) { conditions.push("category = ?"); params.push(opts.category); }
    if (opts?.autonomy) { conditions.push("autonomy = ?"); params.push(opts.autonomy); }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db.query(`SELECT * FROM proposals ${where} ORDER BY created_at DESC`).all(...params) as ProposalRow[];
    return rows.map(rowToProposal);
  }

  listPending(): Proposal[] {
    return this.list({ status: "proposed", autonomy: "requires_approval" });
  }

  approve(proposalId: string, approvedBy: string): Proposal | null {
    const now = Date.now();
    this.db.run(
      "UPDATE proposals SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE proposal_id = ? AND status IN ('proposed', 'reviewing', 'reviewed')",
      [approvedBy, now, now, proposalId],
    );
    const updated = this.get(proposalId);
    if (updated) emitActivity({ type: "proposal", agent: approvedBy, action: "approved", subject: updated.title });
    return updated;
  }

  reject(proposalId: string, reason: string): Proposal | null {
    const now = Date.now();
    this.db.run(
      "UPDATE proposals SET status = 'rejected', rejection_reason = ?, updated_at = ? WHERE proposal_id = ? AND status IN ('proposed', 'reviewing', 'reviewed')",
      [reason, now, proposalId],
    );
    const updated = this.get(proposalId);
    if (updated) emitActivity({ type: "proposal", agent: "system", action: "rejected", subject: updated.title });
    return updated;
  }

  markReviewing(proposalId: string): boolean {
    const result = this.db.run(
      "UPDATE proposals SET status = 'reviewing', updated_at = ? WHERE proposal_id = ? AND status IN ('proposed', 'reviewed')",
      [Date.now(), proposalId],
    );
    return result.changes > 0;
  }

  saveReview(proposalId: string, review: string, reviewedBy: string): void {
    const now = Date.now();
    this.db.run(
      "UPDATE proposals SET review_result = ?, reviewed_by = ?, reviewed_at = ?, review_count = COALESCE(review_count, 0) + 1, status = 'reviewed', updated_at = ? WHERE proposal_id = ?",
      [review, reviewedBy, now, now, proposalId],
    );

    // Extract structured verdict from review text
    // Matches both formats: "VERDICT: APPROVE" and "**Verdict: APPROVE**"
    const verdictMatch = review.match(/\*?\*?[Vv]erdict:\*?\*?\s*(APPROVE|REJECT|NEEDS.MODIFICATION|DO|SKIP|MERGE)/i);
    if (verdictMatch) {
      const raw = verdictMatch[1].toUpperCase().replace(/\s+/g, "_");
      // Normalize to consistent values — NEEDS_MODIFICATION treated as APPROVE (reviewer should fix and approve)
      const verdict = raw === "DO" ? "APPROVE" : raw === "SKIP" ? "REJECT" : raw === "NEEDS_MODIFICATION" ? "APPROVE" : raw;
      this.db.run(
        "UPDATE proposals SET verdict = ?, updated_at = ? WHERE proposal_id = ?",
        [verdict, now, proposalId],
      );
    } else {
      // Review completed but no extractable verdict — flag for visibility
      logger.warn(`[proposals] Review for ${proposalId} completed without extractable verdict`);
      this.db.run(
        "UPDATE proposals SET verdict = 'UNCLEAR', updated_at = ? WHERE proposal_id = ?",
        [now, proposalId],
      );
    }

    // Apply corrected fields from review (reviewer auto-fixes minor issues)
    const corrected = this.applyReviewCorrections(proposalId, review);

    // Corrections applied — log for visibility
    if (corrected) {
      logger.info(`[proposals] Applied reviewer corrections to ${proposalId}`);
    }
  }

  /** Parse and apply corrected fields from a review verdict block. Returns true if corrections were applied. */
  private applyReviewCorrections(proposalId: string, review: string): boolean {
    const corrections: string[] = [];
    const params: unknown[] = [];

    const titleMatch = review.match(/\*?\*?Corrected Title:\*?\*?\s*(.+)/i);
    if (titleMatch) {
      corrections.push("title = ?");
      params.push(titleMatch[1].trim());
    }

    const descMatch = review.match(/\*?\*?Corrected Description:\*?\*?\s*(.+)/i);
    if (descMatch) {
      corrections.push("description = ?");
      params.push(descMatch[1].trim());
    }

    const catMatch = review.match(/\*?\*?Corrected Category:\*?\*?\s*(maintenance|feature|bugfix|improvement)/i);
    if (catMatch) {
      corrections.push("category = ?");
      params.push(catMatch[1].toLowerCase());
    }

    const effortMatch = review.match(/\*?\*?Effort:\*?\*?\s*(trivial|small|medium|large)/i);
    if (effortMatch) {
      corrections.push("effort = ?");
      params.push(effortMatch[1].toLowerCase());
    }

    const filesMatch = review.match(/\*?\*?Corrected Files:\*?\*?\s*(.+)/i);
    if (filesMatch) {
      const files = filesMatch[1].split(",").map(f => f.trim()).filter(Boolean);
      corrections.push("files_affected = ?");
      params.push(JSON.stringify(files));
    }

    if (corrections.length > 0) {
      const now = Date.now();
      corrections.push("updated_at = ?");
      params.push(now, proposalId);
      this.db.run(
        `UPDATE proposals SET ${corrections.join(", ")} WHERE proposal_id = ?`,
        params as import("bun:sqlite").SQLQueryBindings[],
      );
      logger.info(`[proposals] Applied ${corrections.length - 1} review correction(s) to ${proposalId}`);
      return true;
    }
    return false;
  }

  listApproved(): Proposal[] {
    const rows = this.db.query(
      "SELECT * FROM proposals WHERE status = 'approved' ORDER BY approved_at ASC"
    ).all() as ProposalRow[];
    return rows.map(rowToProposal);
  }

  /** Atomically mark a proposal as executing, only if still approved. Returns true if successful. */
  markExecuting(proposalId: string, executionRef: string): boolean {
    const now = Date.now();
    const result = this.db.run(
      "UPDATE proposals SET status = 'executing', execution_ref = ?, updated_at = ? WHERE proposal_id = ? AND status = 'approved'",
      [executionRef, now, proposalId],
    );
    return result.changes > 0;
  }

  markCompleted(proposalId: string, result?: string, executedBy?: string, prUrl?: string | null): void {
    // Detect soft failures: agent responded but couldn't do the work.
    // Check regardless of PR URL — agent can create a PR then fail tests.
    if (result && this.looksLikeFailure(result)) {
      logger.warn(`[proposals] Execution of ${proposalId} produced a failure response — marking as failed`);
      return this.markFailed(proposalId, result, executedBy);
    }

    // Flag completed proposals that have a result but no PR URL (potential silent data loss)
    const needsAttention = result && !prUrl;
    if (needsAttention) {
      logger.warn(`[proposals] Proposal ${proposalId} completed without a PR URL — may need attention`);
    }

    const now = Date.now();
    this.db.run(
      "UPDATE proposals SET status = 'completed', execution_result = ?, executed_by = ?, pr_url = ?, verdict = COALESCE(verdict, ?), updated_at = ? WHERE proposal_id = ?",
      [result ?? null, executedBy ?? null, prUrl ?? null, needsAttention ? "NO_PR" : null, now, proposalId],
    );
    const updated = this.get(proposalId);
    if (updated) emitActivity({ type: "proposal", agent: executedBy ?? "system", action: "completed", subject: updated.title, detail: prUrl ?? undefined });
  }

  private looksLikeFailure(result: string): boolean {
    const upper = result.toUpperCase();
    // Exact markers — unambiguous failure signals
    const exactMarkers = [
      "REFUSED", "BLOCKED", "WRONG WORKING DIRECTORY", "CANNOT EXECUTE",
      "INVALID ROUTING", "NO APPLICABLE CODE", "CANNOT PROCEED",
      "TESTS FAILED", "TYPE CHECK FAILED", "BUILD FAILED",
    ];
    if (exactMarkers.some(m => upper.includes(m))) return true;

    // Pattern markers — require NO pr_url (checked by caller) and short response
    // Long responses with these phrases are likely describing what they fixed, not failing
    if (result.length < 500) {
      const softMarkers = [
        "COULD NOT", "UNABLE TO", "I WAS UNABLE", "I COULDN'T",
        "FAILED TO", "DID NOT SUCCEED", "NOT ABLE TO",
      ];
      if (softMarkers.some(m => upper.includes(m))) return true;
    }

    return false;
  }

  markMerged(proposalId: string, mergedBy: string): Proposal | null {
    const now = Date.now();
    this.db.run(
      "UPDATE proposals SET status = 'merged', merged_by = ?, merged_at = ?, updated_at = ? WHERE proposal_id = ? AND status IN ('completed', 'merged')",
      [mergedBy, now, now, proposalId],
    );
    return this.get(proposalId);
  }

  /** Set the execution trigger for audit trail. */
  setExecutionTrigger(proposalId: string, trigger: ExecutionTrigger): void {
    this.db.run(
      "UPDATE proposals SET execution_trigger = ?, updated_at = ? WHERE proposal_id = ?",
      [trigger, Date.now(), proposalId],
    );
  }

  /** Update pr_url on a completed proposal (used by auto-create-PR fallback) */
  setPrUrl(proposalId: string, prUrl: string): void {
    this.db.run(
      "UPDATE proposals SET pr_url = ?, verdict = NULL, updated_at = ? WHERE proposal_id = ? AND status = 'completed'",
      [prUrl, Date.now(), proposalId],
    );
  }

  /** Update PR mergeability status (MERGEABLE, CONFLICTING, UNKNOWN) */
  setPrMergeable(proposalId: string, mergeable: string | null): void {
    this.db.run(
      "UPDATE proposals SET pr_mergeable = ?, updated_at = ? WHERE proposal_id = ?",
      [mergeable, Date.now(), proposalId],
    );
  }

  markFailed(proposalId: string, result?: string, executedBy?: string): void {
    this.db.run(
      "UPDATE proposals SET status = 'failed', execution_result = ?, executed_by = ?, updated_at = ? WHERE proposal_id = ?",
      [result ?? null, executedBy ?? null, Date.now(), proposalId],
    );
  }

  resetToApproved(proposalId: string): void {
    this.db.run(
      "UPDATE proposals SET status = 'approved', execution_ref = NULL, execution_result = NULL, executed_by = NULL, pr_url = NULL, pr_mergeable = NULL, updated_at = ? WHERE proposal_id = ? AND status IN ('completed', 'failed')",
      [Date.now(), proposalId],
    );
  }

  resetToProposed(proposalId: string): void {
    this.db.run(
      "UPDATE proposals SET status = 'proposed', execution_ref = NULL, execution_result = NULL, executed_by = NULL, pr_url = NULL, pr_mergeable = NULL, approved_by = NULL, approved_at = NULL, review_result = NULL, reviewed_by = NULL, reviewed_at = NULL, verdict = NULL, updated_at = ? WHERE proposal_id = ? AND status IN ('completed', 'failed')",
      [Date.now(), proposalId],
    );
  }

  markNudged(proposalId: string): void {
    this.db.run("UPDATE proposals SET nudged_at = ?, updated_at = ? WHERE proposal_id = ?", [Date.now(), Date.now(), proposalId]);
  }

  expireStale(): number {
    const now = Date.now();
    const result = this.db.run(
      "UPDATE proposals SET status = 'expired', updated_at = ? WHERE status = 'proposed' AND expires_at IS NOT NULL AND expires_at <= ?",
      [now, now],
    );
    return result.changes;
  }

  /** Reset proposals stuck in 'reviewing' for longer than the given timeout. Returns count reset. */
  resetStaleReviewing(timeoutMs = 60 * 60 * 1000): number {
    const cutoff = Date.now() - timeoutMs;
    const result = this.db.run(
      "UPDATE proposals SET status = 'proposed', updated_at = ? WHERE status = 'reviewing' AND updated_at <= ?",
      [Date.now(), cutoff],
    );
    if (result.changes > 0) {
      logger.info(`[proposals] Reset ${result.changes} stale reviewing → proposed (timeout: ${timeoutMs / 60000}min)`);
    }
    return result.changes;
  }

  /** Get proposals ready for nudge: proposed, not yet nudged, older than PROPOSAL_NUDGE_MS */
  listNudgeable(): Proposal[] {
    const threshold = Date.now() - PROPOSAL_NUDGE_MS;
    const rows = this.db.query(
      "SELECT * FROM proposals WHERE status = 'proposed' AND autonomy = 'requires_approval' AND nudged_at IS NULL AND created_at <= ? ORDER BY created_at ASC",
    ).all(threshold) as ProposalRow[];
    return rows.map(rowToProposal);
  }

  getStats(): {
    total: number; pending: number; approved: number; rejected: number;
    executing: number; completed: number; merged: number; failed: number; expired: number; autoExecuted: number;
  } {
    const counts = this.db.query(
      "SELECT status, COUNT(*) as count FROM proposals GROUP BY status"
    ).all() as Array<{ status: string; count: number }>;

    const autoCount = this.db.query(
      "SELECT COUNT(*) as count FROM proposals WHERE autonomy = 'auto' AND status IN ('completed', 'executing')"
    ).get() as { count: number };

    const map = Object.fromEntries(counts.map(r => [r.status, r.count]));
    return {
      total: counts.reduce((sum, r) => sum + r.count, 0),
      pending: (map.proposed ?? 0),
      approved: (map.approved ?? 0),
      rejected: (map.rejected ?? 0),
      executing: (map.executing ?? 0),
      completed: (map.completed ?? 0),
      merged: (map.merged ?? 0),
      failed: (map.failed ?? 0),
      expired: (map.expired ?? 0),
      autoExecuted: autoCount.count,
    };
  }

  /** Count proposals created by a specific scout source since a given timestamp */
  countBySource(scoutSource: string, since: number): number {
    const row = this.db.query(
      "SELECT COUNT(*) as count FROM proposals WHERE scout_source = ? AND created_at >= ?"
    ).get(scoutSource, since) as { count: number } | null;
    return row?.count ?? 0;
  }

  /** Find an active proposal by title (for dedup — scouts check before re-proposing) */
  findByTitle(title: string): Proposal | null {
    const row = this.db.query(
      "SELECT * FROM proposals WHERE title = ? AND status IN ('proposed', 'reviewing', 'reviewed', 'approved', 'executing', 'completed') ORDER BY created_at DESC LIMIT 1"
    ).get(title) as ProposalRow | null;
    return row ? rowToProposal(row) : null;
  }

  /** Fuzzy dedup: find the most similar active proposal above threshold */
  findSimilar(title: string, description: string, threshold = 0.4): { proposal: Proposal; similarity: number } | null {
    const active = this.db.query(
      "SELECT * FROM proposals WHERE status IN ('proposed', 'reviewing', 'reviewed', 'approved', 'executing') ORDER BY created_at DESC"
    ).all() as ProposalRow[];

    if (active.length === 0) return null;

    const inputWords = normalizeWords(title);
    const inputDescWords = normalizeWords(description);

    let bestMatch: { proposal: Proposal; similarity: number } | null = null;

    for (const row of active) {
      const titleSim = jaccardSimilarity(inputWords, normalizeWords(row.title));
      const descSim = jaccardSimilarity(inputDescWords, normalizeWords(row.description));
      // Weight title similarity more heavily (70/30)
      const combined = titleSim * 0.7 + descSim * 0.3;

      if (combined >= threshold && (!bestMatch || combined > bestMatch.similarity)) {
        bestMatch = { proposal: rowToProposal(row), similarity: combined };
      }
    }

    return bestMatch;
  }

  /** List completed proposals that have a PR URL (candidates for merge-sync). */
  listCompletedWithPR(): Proposal[] {
    const rows = this.db.query(
      "SELECT * FROM proposals WHERE status = 'completed' AND pr_url IS NOT NULL ORDER BY updated_at ASC",
    ).all() as ProposalRow[];
    return rows.map(rowToProposal);
  }

  /** Archive proposals in completed/failed for >N days by moving them to expired. */
  archiveStale(days = 30): number {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = this.db.run(
      "UPDATE proposals SET status = 'expired', updated_at = ? WHERE status IN ('completed', 'failed') AND updated_at <= ?",
      [Date.now(), cutoff],
    );
    return result.changes;
  }

  /** Bulk-delete terminal proposals (merged, rejected, failed, expired). Returns count deleted. */
  deleteTerminal(): number {
    const result = this.db.run(
      "DELETE FROM proposals WHERE status IN ('merged', 'rejected', 'failed', 'expired')",
    );
    return result.changes;
  }

  /** Batch-approve proposals matching filters. Returns count approved. */
  batchApprove(opts: {
    category?: ProposalCategory;
    maxAutonomy?: ProposalAutonomy;
    approvedBy: string;
  }): { count: number; ids: string[] } {
    const conditions: string[] = ["status = 'proposed'"];
    const params: (string | number)[] = [];

    if (opts.category) {
      conditions.push("category = ?");
      params.push(opts.category);
    }
    if (opts.maxAutonomy) {
      const autonomyOrder: Record<string, number> = { auto: 0, requires_approval: 1 };
      const maxLevel = autonomyOrder[opts.maxAutonomy] ?? 1;
      const allowed = Object.entries(autonomyOrder)
        .filter(([, v]) => v <= maxLevel)
        .map(([k]) => k);
      conditions.push(`autonomy IN (${allowed.map(() => "?").join(",")})`);
      params.push(...allowed);
    }

    const where = conditions.join(" AND ");
    const rows = this.db.query(
      `SELECT proposal_id FROM proposals WHERE ${where} ORDER BY created_at ASC`
    ).all(...params) as Array<{ proposal_id: string }>;

    const ids: string[] = [];
    const now = Date.now();
    for (const row of rows) {
      this.db.run(
        "UPDATE proposals SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE proposal_id = ? AND status = 'proposed'",
        [opts.approvedBy, now, now, row.proposal_id],
      );
      ids.push(row.proposal_id);
    }

    return { count: ids.length, ids };
  }

  /** Batch-reject proposals matching filters. Returns count rejected. */
  batchReject(opts: {
    category?: ProposalCategory;
    olderThanMs?: number;
    reason: string;
  }): { count: number; ids: string[] } {
    const conditions: string[] = ["status = 'proposed'"];
    const params: (string | number)[] = [];

    if (opts.category) {
      conditions.push("category = ?");
      params.push(opts.category);
    }
    if (opts.olderThanMs) {
      conditions.push("created_at <= ?");
      params.push(Date.now() - opts.olderThanMs);
    }

    const where = conditions.join(" AND ");
    const rows = this.db.query(
      `SELECT proposal_id FROM proposals WHERE ${where} ORDER BY created_at ASC`
    ).all(...params) as Array<{ proposal_id: string }>;

    const ids: string[] = [];
    const now = Date.now();
    for (const row of rows) {
      this.db.run(
        "UPDATE proposals SET status = 'rejected', rejection_reason = ?, updated_at = ? WHERE proposal_id = ? AND status = 'proposed'",
        [opts.reason, now, row.proposal_id],
      );
      ids.push(row.proposal_id);
    }

    return { count: ids.length, ids };
  }

  delete(proposalId: string): boolean {
    const result = this.db.run("DELETE FROM proposals WHERE proposal_id = ?", [proposalId]);
    return result.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}

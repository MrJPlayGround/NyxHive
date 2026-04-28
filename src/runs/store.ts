import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AGENT_TIMEOUT_MS } from "../defaults.js";
import type {
  ArtifactHandlerStatus,
  BlockedPathReport,
  DelegationRun,
  DelegationRunBrain,
  DelegationRunEnvironment,
  DelegationRunResult,
  DelegationRunScratchpadFile,
  DelegationRunScratchpadManifest,
  DelegationRunStatus,
  DelegationRunUsage,
  InboundArtifactRecord,
} from "../types.js";
import type { FileAttachment } from "../providers/types.js";
import { logger } from "../utils/logger.js";
import { ensureTableSchema } from "../utils/schema.js";
import { normalizeBlockedPathReport, type BlockedPathInput } from "./blockers.js";

interface DelegationRunRow {
  run_id: string;
  parent_run_id: string | null;
  task_id: string | null;
  message_id: string | null;
  trace_id: string | null;
  task_description: string;
  agent: string;
  brain: DelegationRunBrain;
  status: DelegationRunStatus;
  mode: string;
  delegation_depth: number;
  result_json: string | null;
  usage_json: string | null;
  environment_json: string | null;
  scratchpad_dir: string;
  created_at: number;
  completed_at: number | null;
  updated_at: number;
}

interface BlockedPathReportRow {
  id: string;
  run_id: string | null;
  message_id: string | null;
  trace_id: string | null;
  channel: string | null;
  area: BlockedPathReport["area"];
  failed_path: string;
  trigger: string;
  inspected_json: string;
  available_artifacts_json: string;
  missing_primitive: string;
  impact: string;
  next_action: BlockedPathReport["next_action"];
  requires_approval: number;
  created_at: number;
}

interface InboundArtifactRow {
  artifact_id: string;
  run_id: string | null;
  message_id: string | null;
  trace_id: string | null;
  channel: string | null;
  source: string;
  name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
  storage_path: string | null;
  acquisition_status: InboundArtifactRecord["acquisition_status"];
  acquisition_error: string | null;
  handler_status: ArtifactHandlerStatus;
  handler: string | null;
  created_at: number;
  updated_at: number;
}

export interface DelegationRunEvent {
  type: "run_started" | "run_progress" | "run_completed" | "run_failed" | "run_blocked" | "run_superseded";
  run: DelegationRun;
}

export interface DelegationRunOrphanResetResult {
  failed: number;
  superseded: number;
  total: number;
}

const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const DELETE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const ORPHAN_REASONS = new Set(["orphaned_on_startup", "orphaned_sweep"]);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS delegation_runs (
  run_id TEXT PRIMARY KEY,
  parent_run_id TEXT,
  task_id TEXT,
  message_id TEXT,
  trace_id TEXT,
  task_description TEXT NOT NULL,
  agent TEXT NOT NULL,
  brain TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'default',
  delegation_depth INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  usage_json TEXT,
  environment_json TEXT,
  scratchpad_dir TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delegation_runs_status_created ON delegation_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delegation_runs_task ON delegation_runs(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_delegation_runs_message ON delegation_runs(message_id, created_at DESC);

CREATE TABLE IF NOT EXISTS blocked_path_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  message_id TEXT,
  trace_id TEXT,
  channel TEXT,
  area TEXT NOT NULL,
  failed_path TEXT NOT NULL,
  trigger TEXT NOT NULL,
  inspected_json TEXT NOT NULL,
  available_artifacts_json TEXT NOT NULL,
  missing_primitive TEXT NOT NULL,
  impact TEXT NOT NULL,
  next_action TEXT NOT NULL,
  requires_approval INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocked_path_reports_run ON blocked_path_reports(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blocked_path_reports_message ON blocked_path_reports(message_id, created_at DESC);

CREATE TABLE IF NOT EXISTS inbound_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT,
  message_id TEXT,
  trace_id TEXT,
  channel TEXT,
  source TEXT NOT NULL,
  name TEXT,
  mime_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  storage_path TEXT,
  acquisition_status TEXT NOT NULL,
  acquisition_error TEXT,
  handler_status TEXT NOT NULL,
  handler TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbound_artifacts_run ON inbound_artifacts(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_artifacts_message ON inbound_artifacts(message_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inbound_artifacts_channel ON inbound_artifacts(channel, created_at DESC);
`;

function safeParseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export class DelegationRunStore {
  private db: Database;
  private listeners = new Set<(event: DelegationRunEvent) => void>();
  private readonly scratchpadRoot: string;
  private readonly archiveRoot: string;
  private readonly artifactRoot: string;

  constructor(dataDir: string, instanceName?: string) {
    const dbPath = join(dataDir, `${instanceName ?? "nyxhive"}.db`);
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    ensureTableSchema(this.db, {
      table: "delegation_runs",
      required: [
        "run_id", "parent_run_id", "task_id", "message_id", "trace_id", "task_description",
        "agent", "brain", "status", "mode", "delegation_depth", "result_json", "usage_json", "scratchpad_dir",
        "environment_json", "created_at", "completed_at", "updated_at",
      ],
      ephemeral: false,
      columnDefs: {
        task_id: "TEXT",
        message_id: "TEXT",
        trace_id: "TEXT",
        mode: "TEXT NOT NULL DEFAULT 'default'",
        delegation_depth: "INTEGER NOT NULL DEFAULT 0",
        result_json: "TEXT",
        usage_json: "TEXT",
        environment_json: "TEXT",
        completed_at: "INTEGER",
        updated_at: "INTEGER NOT NULL DEFAULT 0",
      },
    }, "runs");
    this.db.exec(SCHEMA);

    this.scratchpadRoot = join(dataDir, "scratchpads");
    this.archiveRoot = join(this.scratchpadRoot, "archive");
    this.artifactRoot = join(dataDir, "artifacts");
    mkdirSync(this.scratchpadRoot, { recursive: true });
    mkdirSync(this.archiveRoot, { recursive: true });
    mkdirSync(this.artifactRoot, { recursive: true });
    this.pruneScratchpads();

    // Reset orphaned 'running' runs from prior crash
    const orphans = this.resetOrphans(AGENT_TIMEOUT_MS, "orphaned_on_startup");
    if (orphans.total > 0) {
      const parts = [
        orphans.failed > 0 ? `${orphans.failed} failed` : null,
        orphans.superseded > 0 ? `${orphans.superseded} superseded` : null,
      ].filter(Boolean).join(", ");
      logger.info(`[runs] Classified ${orphans.total} orphaned running delegation run(s) on startup: ${parts}`);
    }
  }

  onEvent(listener: (event: DelegationRunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createRun(opts: {
    run_id?: string;
    parent_run_id?: string | null;
    task_id?: string | null;
    message_id?: string | null;
    trace_id?: string | null;
    task_description: string;
    agent: string;
    brain: DelegationRunBrain;
    status?: DelegationRunStatus;
    mode?: import("../types.js").DelegationMode;
    delegation_depth?: number;
    environment?: DelegationRunEnvironment | null;
  }): DelegationRun {
    const runId = opts.run_id ?? randomUUID();
    const now = Date.now();
    const scratchpadDir = this.ensureScratchpadDir(runId, {
      run_id: runId,
      parent_run_id: opts.parent_run_id ?? null,
      task_id: opts.task_id ?? null,
      agent: opts.agent,
      task_description: opts.task_description,
      created_at: now,
      archived_at: null,
      files: [],
    });
    this.db.prepare(
      `INSERT INTO delegation_runs (
        run_id, parent_run_id, task_id, message_id, trace_id, task_description,
        agent, brain, status, mode, delegation_depth, result_json, usage_json, environment_json, scratchpad_dir, created_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?)`,
    ).run(
      runId,
      opts.parent_run_id ?? null,
      opts.task_id ?? null,
      opts.message_id ?? null,
      opts.trace_id ?? null,
      opts.task_description,
      opts.agent,
      opts.brain,
      opts.status ?? "running",
      opts.mode ?? "default",
      opts.delegation_depth ?? 0,
      opts.environment ? JSON.stringify(opts.environment) : null,
      scratchpadDir,
      now,
      now,
    );

    const run = this.getRun(runId);
    if (!run) throw new Error(`Failed to create delegation run ${runId}`);
    this.emit({ type: "run_started", run });
    return run;
  }

  updateProgress(runId: string, patch: {
    status?: DelegationRunStatus;
    result?: Partial<DelegationRunResult>;
    usage?: Partial<DelegationRunUsage>;
  }): DelegationRun | null {
    const current = this.getRun(runId);
    if (!current) return null;
    const nextResult = patch.result ? { ...(current.result ?? {}), ...patch.result } : current.result;
    const nextUsage = patch.usage ? { ...(current.usage ?? {}), ...patch.usage } : current.usage;
    const status = patch.status ?? current.status;
    const now = Date.now();

    this.db.prepare(
      `UPDATE delegation_runs
       SET status = ?, result_json = ?, usage_json = ?, updated_at = ?
       WHERE run_id = ?`,
    ).run(
      status,
      nextResult ? JSON.stringify(nextResult) : null,
      nextUsage ? JSON.stringify(nextUsage) : null,
      now,
      runId,
    );

    const updated = this.getRun(runId);
    if (updated) this.emit({ type: "run_progress", run: updated });
    return updated;
  }

  completeRun(runId: string, data: {
    status: DelegationRunStatus;
    result: DelegationRunResult;
    usage: DelegationRunUsage;
    trace_id?: string | null;
  }): DelegationRun | null {
    const now = Date.now();
    this.db.prepare(
      `UPDATE delegation_runs
       SET status = ?, result_json = ?, usage_json = ?, trace_id = COALESCE(?, trace_id),
           completed_at = ?, updated_at = ?
       WHERE run_id = ?`,
    ).run(
      data.status,
      JSON.stringify(data.result),
      JSON.stringify(data.usage),
      data.trace_id ?? null,
      now,
      now,
      runId,
    );

    const run = this.getRun(runId);
    if (!run) return null;
    if (run.status === "completed") {
      const superseded = this.supersedePriorOrphanedRuns(run);
      if (superseded > 0 && run.message_id) {
        logger.info(`[runs] Superseded ${superseded} older orphaned delegation run(s) for completed message ${run.message_id}`);
      }
    }
    if (run.status === "failed") this.emit({ type: "run_failed", run });
    else if (run.result?.outcome === "blocked" || run.status === "killed") this.emit({ type: "run_blocked", run });
    else if (run.status === "superseded" || run.result?.outcome === "superseded") this.emit({ type: "run_superseded", run });
    else this.emit({ type: "run_completed", run });
    return run;
  }

  recordScratchpadFile(runId: string, pathname: string, author: string, description: string): void {
    const run = this.getRun(runId);
    if (!run) return;
    const normalizedPath = normalize(pathname);
    if (!normalizedPath.startsWith(normalize(run.scratchpad_dir))) return;

    const relPath = relative(run.scratchpad_dir, normalizedPath).replaceAll("\\", "/");
    if (!relPath || relPath.startsWith("..")) return;

    const manifest = this.readManifest(run) ?? {
      run_id: run.run_id,
      parent_run_id: run.parent_run_id,
      task_id: run.task_id,
      agent: run.agent,
      created_at: run.created_at,
      archived_at: null,
      files: [],
    };
    const timestamp = Date.now();
    const existing = manifest.files.find((file) => file.path === relPath);
    if (existing) {
      existing.author = author;
      existing.timestamp = timestamp;
      existing.description = description;
    } else {
      manifest.files.push({
        path: relPath,
        author,
        timestamp,
        description,
      });
    }
    this.writeManifest(run.scratchpad_dir, manifest);
  }

  listRuns(filters: {
    status?: DelegationRunStatus;
    task_id?: string;
    message_id?: string;
    limit?: number;
  } = {}): DelegationRun[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filters.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    if (filters.task_id) {
      clauses.push("task_id = ?");
      params.push(filters.task_id);
    }
    if (filters.message_id) {
      clauses.push("message_id = ?");
      params.push(filters.message_id);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters.limit ?? 100;
    const rows = this.db.prepare(
      `SELECT * FROM delegation_runs ${where} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params, limit) as DelegationRunRow[];
    return rows.map((row) => this.deserialize(row));
  }

  getRunByMessageId(messageId: string): DelegationRun | null {
    const row = this.db.prepare("SELECT * FROM delegation_runs WHERE message_id = ? ORDER BY created_at DESC LIMIT 1").get(messageId) as DelegationRunRow | null;
    return row ? this.deserialize(row) : null;
  }

  getRun(runId: string): DelegationRun | null {
    const row = this.db.prepare("SELECT * FROM delegation_runs WHERE run_id = ?").get(runId) as DelegationRunRow | null;
    return row ? this.deserialize(row) : null;
  }

  recordBlockedPath(input: BlockedPathInput): BlockedPathReport {
    const report = normalizeBlockedPathReport(input);
    this.db.prepare(
      `INSERT INTO blocked_path_reports (
        id, run_id, message_id, trace_id, channel, area, failed_path, trigger,
        inspected_json, available_artifacts_json, missing_primitive, impact,
        next_action, requires_approval, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      report.id,
      report.run_id,
      report.message_id,
      report.trace_id,
      report.channel,
      report.area,
      report.failed_path,
      report.trigger,
      JSON.stringify(report.inspected),
      JSON.stringify(report.available_artifacts),
      report.missing_primitive,
      report.impact,
      report.next_action,
      report.requires_approval ? 1 : 0,
      report.created_at,
    );
    return report;
  }

  listBlockedPaths(filters: {
    run_id?: string | null;
    message_id?: string | null;
    limit?: number;
  } = {}): BlockedPathReport[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filters.run_id && filters.message_id) {
      clauses.push("(run_id = ? OR message_id = ?)");
      params.push(filters.run_id, filters.message_id);
    } else if (filters.run_id) {
      clauses.push("run_id = ?");
      params.push(filters.run_id);
    } else if (filters.message_id) {
      clauses.push("message_id = ?");
      params.push(filters.message_id);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters.limit ?? 100;
    const rows = this.db.prepare(
      `SELECT * FROM blocked_path_reports ${where} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params, limit) as BlockedPathReportRow[];
    return rows.map((row) => this.deserializeBlockedPath(row));
  }

  recordInboundArtifact(input: {
    run_id?: string | null;
    message_id?: string | null;
    trace_id?: string | null;
    channel?: string | null;
    source: string;
    file: FileAttachment;
    handler_status?: ArtifactHandlerStatus;
    handler?: string | null;
  }): InboundArtifactRecord {
    const artifactId = randomUUID();
    const now = Date.now();
    const data = Buffer.from(input.file.base64, "base64");
    const sha256 = createHash("sha256").update(data).digest("hex");
    const storagePath = join(this.artifactRoot, `${artifactId}.bin`);
    mkdirSync(this.artifactRoot, { recursive: true });
    writeFileSync(storagePath, data);

    const artifact: InboundArtifactRecord = {
      artifact_id: artifactId,
      run_id: input.run_id ?? null,
      message_id: input.message_id ?? null,
      trace_id: input.trace_id ?? null,
      channel: input.channel ?? null,
      source: input.source,
      name: input.file.name,
      mime_type: input.file.mimeType,
      size_bytes: input.file.size,
      sha256,
      storage_path: storagePath,
      acquisition_status: "acquired",
      acquisition_error: null,
      handler_status: input.handler_status ?? "unprocessed",
      handler: input.handler ?? null,
      created_at: now,
      updated_at: now,
    };
    this.insertArtifact(artifact);
    return artifact;
  }

  recordInboundArtifactFailure(input: {
    run_id?: string | null;
    message_id?: string | null;
    trace_id?: string | null;
    channel?: string | null;
    source: string;
    name?: string | null;
    mime_type?: string | null;
    size_bytes?: number | null;
    acquisition_error: string;
    handler_status?: ArtifactHandlerStatus;
    handler?: string | null;
  }): InboundArtifactRecord {
    const now = Date.now();
    const artifact: InboundArtifactRecord = {
      artifact_id: randomUUID(),
      run_id: input.run_id ?? null,
      message_id: input.message_id ?? null,
      trace_id: input.trace_id ?? null,
      channel: input.channel ?? null,
      source: input.source,
      name: input.name ?? null,
      mime_type: input.mime_type ?? null,
      size_bytes: input.size_bytes ?? null,
      sha256: null,
      storage_path: null,
      acquisition_status: "failed",
      acquisition_error: input.acquisition_error,
      handler_status: input.handler_status ?? "unsupported",
      handler: input.handler ?? null,
      created_at: now,
      updated_at: now,
    };
    this.insertArtifact(artifact);
    return artifact;
  }

  listArtifacts(filters: {
    run_id?: string | null;
    message_id?: string | null;
    channel?: string | null;
    limit?: number;
  } = {}): InboundArtifactRecord[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (filters.run_id && filters.message_id) {
      clauses.push("(run_id = ? OR message_id = ?)");
      params.push(filters.run_id, filters.message_id);
    } else if (filters.run_id) {
      clauses.push("run_id = ?");
      params.push(filters.run_id);
    } else if (filters.message_id) {
      clauses.push("message_id = ?");
      params.push(filters.message_id);
    }
    if (filters.channel) {
      clauses.push("channel = ?");
      params.push(filters.channel);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filters.limit ?? 100;
    const rows = this.db.prepare(
      `SELECT * FROM inbound_artifacts ${where} ORDER BY created_at DESC LIMIT ?`,
    ).all(...params, limit) as InboundArtifactRow[];
    return rows.map((row) => this.deserializeArtifact(row));
  }

  getScratchpadFiles(runId: string): DelegationRunScratchpadFile[] {
    const run = this.getRun(runId);
    const manifest = run ? this.readManifest(run) : null;
    return manifest?.files ?? [];
  }

  getScratchpadManifest(runId: string): DelegationRunScratchpadManifest | null {
    const run = this.getRun(runId);
    return run ? this.readManifest(run) : null;
  }

  /**
   * Mark delegation runs stuck in 'running' longer than maxAgeMs as terminal.
   * Top-level runs with a later completed replacement for the same message are
   * marked superseded instead of failed so user-visible metrics don't report a
   * failure for work that already completed successfully.
   */
  resetOrphans(
    maxAgeMs: number,
    reason: "orphaned_on_startup" | "orphaned_sweep" = "orphaned_on_startup",
  ): DelegationRunOrphanResetResult {
    const now = Date.now();
    const cutoff = now - maxAgeMs;

    const stuckRows = this.db.prepare(
      `SELECT run_id, parent_run_id, message_id, scratchpad_dir, created_at
       FROM delegation_runs
       WHERE status = 'running' AND updated_at < ?`,
    ).all(cutoff) as Array<Pick<DelegationRunRow, "run_id" | "parent_run_id" | "message_id" | "scratchpad_dir" | "created_at">>;

    if (stuckRows.length === 0) return { failed: 0, superseded: 0, total: 0 };

    let failed = 0;
    let superseded = 0;

    const failStmt = this.db.prepare(
      `UPDATE delegation_runs
       SET status = 'failed', result_json = ?, completed_at = ?, updated_at = ?
       WHERE run_id = ? AND status = 'running'`,
    );
    const supersedeStmt = this.db.prepare(
      `UPDATE delegation_runs
       SET status = 'superseded', result_json = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
       WHERE run_id = ? AND status = 'running'`,
    );

    for (const row of stuckRows) {
      if (this.hasCompletedReplacement(row)) {
        supersedeStmt.run(this.buildSupersededResultJson(reason, this.findCompletedReplacementRunId(row)), now, now, row.run_id);
        superseded++;
      } else {
        failStmt.run(this.buildOrphanFailureResultJson(reason), now, now, row.run_id);
        failed++;
      }
    }

    // Archive scratchpads for affected runs (best effort)
    for (const row of stuckRows) {
      this.archiveScratchpad(row, now);
    }

    return { failed, superseded, total: failed + superseded };
  }

  /** Count runs currently in 'running' state older than staleMs. Used for health reporting. */
  getStaleRunningCount(staleMs = 30 * 60 * 1000): number {
    const cutoff = Date.now() - staleMs;
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM delegation_runs WHERE status = 'running' AND updated_at < ?`,
    ).get(cutoff) as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }

  private buildOrphanFailureResultJson(reason: "orphaned_on_startup" | "orphaned_sweep"): string {
    return JSON.stringify({
      summary: reason,
      outcome: "failure",
      artifacts: [],
      files_touched: [],
      verification: [],
      blockers: [],
      next_action: null,
    } satisfies DelegationRunResult);
  }

  private buildSupersededResultJson(
    reason: "orphaned_on_startup" | "orphaned_sweep" | "replacement_completed",
    replacementRunId: string | null,
  ): string {
    const replacement = replacementRunId ? ` ${replacementRunId}` : "";
    return JSON.stringify({
      summary: `${reason}: superseded by completed replacement run${replacement}`,
      outcome: "superseded",
      artifacts: [],
      files_touched: [],
      verification: replacementRunId ? [`Replacement run ${replacementRunId} completed for the same message.`] : [],
      blockers: [],
      next_action: null,
    } satisfies DelegationRunResult);
  }

  private findCompletedReplacementRunId(row: Pick<DelegationRunRow, "run_id" | "parent_run_id" | "message_id" | "created_at">): string | null {
    if (!row.message_id || row.parent_run_id) return null;
    const replacement = this.db.prepare(
      `SELECT run_id
       FROM delegation_runs
       WHERE message_id = ?
         AND parent_run_id IS NULL
         AND status = 'completed'
         AND created_at >= ?
         AND run_id != ?
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get(row.message_id, row.created_at, row.run_id) as { run_id: string } | null;
    return replacement?.run_id ?? null;
  }

  private hasCompletedReplacement(row: Pick<DelegationRunRow, "run_id" | "parent_run_id" | "message_id" | "created_at">): boolean {
    return this.findCompletedReplacementRunId(row) !== null;
  }

  private isOrphanFailure(row: Pick<DelegationRunRow, "status" | "result_json">): boolean {
    if (row.status !== "failed") return false;
    const result = safeParseJson<DelegationRunResult>(row.result_json);
    return !!result?.summary && ORPHAN_REASONS.has(result.summary);
  }

  private supersedePriorOrphanedRuns(replacement: DelegationRun): number {
    if (!replacement.message_id || replacement.parent_run_id || replacement.status !== "completed") return 0;
    const now = Date.now();
    const candidates = this.db.prepare(
      `SELECT run_id, parent_run_id, message_id, status, result_json, scratchpad_dir, created_at
       FROM delegation_runs
       WHERE message_id = ?
         AND parent_run_id IS NULL
         AND run_id != ?
         AND created_at <= ?
         AND status IN ('running', 'failed')`,
    ).all(replacement.message_id, replacement.run_id, replacement.created_at) as Array<
      Pick<DelegationRunRow, "run_id" | "parent_run_id" | "message_id" | "status" | "result_json" | "scratchpad_dir" | "created_at">
    >;

    let superseded = 0;
    for (const candidate of candidates) {
      if (candidate.status === "failed" && !this.isOrphanFailure(candidate)) continue;
      const result = this.db.prepare(
        `UPDATE delegation_runs
         SET status = 'superseded', result_json = ?, completed_at = COALESCE(completed_at, ?), updated_at = ?
         WHERE run_id = ? AND status IN ('running', 'failed')`,
      ).run(this.buildSupersededResultJson("replacement_completed", replacement.run_id), now, now, candidate.run_id);
      if (result.changes === 0) continue;
      superseded++;
      this.archiveScratchpad(candidate, now);
      const run = this.getRun(candidate.run_id);
      if (run) this.emit({ type: "run_superseded", run });
    }
    return superseded;
  }

  private archiveScratchpad(row: Pick<DelegationRunRow, "run_id" | "scratchpad_dir">, now: number): void {
    if (!existsSync(row.scratchpad_dir)) return;
    const archived = normalize(row.scratchpad_dir).startsWith(normalize(this.archiveRoot));
    if (archived) return;
    try {
      const archiveDir = join(this.archiveRoot, row.run_id);
      renameSync(row.scratchpad_dir, archiveDir);
      this.db.prepare("UPDATE delegation_runs SET scratchpad_dir = ?, updated_at = ? WHERE run_id = ?")
        .run(archiveDir, now, row.run_id);
    } catch {
      // best effort — don't let scratchpad failures block the orphan reset
    }
  }

  private deserialize(row: DelegationRunRow): DelegationRun {
    return {
      run_id: row.run_id,
      parent_run_id: row.parent_run_id,
      task_id: row.task_id,
      message_id: row.message_id,
      trace_id: row.trace_id,
      task_description: row.task_description,
      agent: row.agent,
      brain: row.brain,
      status: row.status,
      mode: (row.mode as import("../types.js").DelegationMode) || "default",
      delegation_depth: row.delegation_depth ?? 0,
      result: safeParseJson<DelegationRunResult>(row.result_json),
      usage: safeParseJson<DelegationRunUsage>(row.usage_json),
      environment: safeParseJson<DelegationRunEnvironment>(row.environment_json),
      scratchpad_dir: row.scratchpad_dir,
      created_at: row.created_at,
      completed_at: row.completed_at,
      updated_at: row.updated_at,
    };
  }

  private deserializeBlockedPath(row: BlockedPathReportRow): BlockedPathReport {
    return {
      id: row.id,
      run_id: row.run_id,
      message_id: row.message_id,
      trace_id: row.trace_id,
      channel: row.channel,
      area: row.area,
      failed_path: row.failed_path,
      trigger: row.trigger,
      inspected: safeParseJson<string[]>(row.inspected_json) ?? [],
      available_artifacts: safeParseJson<string[]>(row.available_artifacts_json) ?? [],
      missing_primitive: row.missing_primitive,
      impact: row.impact,
      next_action: row.next_action,
      requires_approval: row.requires_approval === 1,
      created_at: row.created_at,
    };
  }

  private insertArtifact(artifact: InboundArtifactRecord): void {
    this.db.prepare(
      `INSERT INTO inbound_artifacts (
        artifact_id, run_id, message_id, trace_id, channel, source, name, mime_type,
        size_bytes, sha256, storage_path, acquisition_status, acquisition_error,
        handler_status, handler, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      artifact.artifact_id,
      artifact.run_id,
      artifact.message_id,
      artifact.trace_id,
      artifact.channel,
      artifact.source,
      artifact.name,
      artifact.mime_type,
      artifact.size_bytes,
      artifact.sha256,
      artifact.storage_path,
      artifact.acquisition_status,
      artifact.acquisition_error,
      artifact.handler_status,
      artifact.handler,
      artifact.created_at,
      artifact.updated_at,
    );
  }

  private deserializeArtifact(row: InboundArtifactRow): InboundArtifactRecord {
    return {
      artifact_id: row.artifact_id,
      run_id: row.run_id,
      message_id: row.message_id,
      trace_id: row.trace_id,
      channel: row.channel,
      source: row.source,
      name: row.name,
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      sha256: row.sha256,
      storage_path: row.storage_path,
      acquisition_status: row.acquisition_status,
      acquisition_error: row.acquisition_error,
      handler_status: row.handler_status,
      handler: row.handler,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private ensureScratchpadDir(runId: string, manifest: DelegationRunScratchpadManifest): string {
    const dir = join(this.scratchpadRoot, runId);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "manifest.json"))) {
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
    }
    return dir;
  }

  private readManifest(run: DelegationRun): DelegationRunScratchpadManifest | null {
    const path = join(run.scratchpad_dir, "manifest.json");
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as DelegationRunScratchpadManifest;
    } catch {
      return null;
    }
  }

  private writeManifest(dir: string, manifest: DelegationRunScratchpadManifest): void {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  }

  private emit(event: DelegationRunEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        logger.debug(`[runs] Listener error for ${event.type}: ${err}`);
      }
    }
  }

  private pruneScratchpads(now = Date.now()): void {
    const rows = this.db.prepare("SELECT * FROM delegation_runs WHERE completed_at IS NOT NULL").all() as DelegationRunRow[];
    for (const row of rows) {
      const run = this.deserialize(row);
      if (!existsSync(run.scratchpad_dir)) continue;
      const ageMs = now - (run.completed_at ?? run.created_at);
      const archived = normalize(run.scratchpad_dir).startsWith(normalize(this.archiveRoot));
      if (ageMs > DELETE_AFTER_MS && archived) {
        rmSync(run.scratchpad_dir, { recursive: true, force: true });
        continue;
      }
      if (ageMs > ARCHIVE_AFTER_MS && !archived) {
        const archiveDir = join(this.archiveRoot, run.run_id);
        mkdirSync(this.archiveRoot, { recursive: true });
        renameSync(run.scratchpad_dir, archiveDir);
        const manifest = this.readManifest({ ...run, scratchpad_dir: archiveDir });
        if (manifest) {
          manifest.archived_at = now;
          this.writeManifest(archiveDir, manifest);
        }
        this.db.prepare("UPDATE delegation_runs SET scratchpad_dir = ?, updated_at = ? WHERE run_id = ?")
          .run(archiveDir, now, run.run_id);
      }
    }
  }
}

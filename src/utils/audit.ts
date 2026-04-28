import type { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  event TEXT NOT NULL,
  channel TEXT,
  sender_id TEXT,
  agent TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event);
CREATE INDEX IF NOT EXISTS idx_audit_channel ON audit_log(channel);
`;

export type AuditEvent =
  | "message.received"
  | "message.completed"
  | "message.edited"
  | "message.deleted"
  | "message.failed"
  | "message.deleted"
  | "message.edited"
  | "pairing.approved"
  | "pairing.revoked"
  | "model.override"
  | "scheduler.executed"
  | "scheduler.failed"
  // Security events
  | "security.command_exec"
  | "security.command_blocked"
  | "security.credential_access"
  | "security.delegation_blocked"
  | "security.delegation_approved"
  | "security.auto_execute"
  | "security.network_blocked"
  | "security.sensitive_task_detected"
  | "security.slack_access_denied"
  | "security.slack_auto_approved"
  | "security.slack_role_synced"
  | "security.slack_command_denied"
  | "security.slack_proposal_denied"
  // Runtime events
  | "runtime.restart_requested"
  // Input sanitization events
  | "security.input_blocked"
  | "security.input_warned";

interface AuditEntry {
  event: AuditEvent;
  channel?: string;
  sender_id?: string;
  agent?: string;
  detail?: string;
}

export interface AuditRow {
  id: number;
  timestamp: number;
  event: string;
  channel: string | null;
  sender_id: string | null;
  agent: string | null;
  detail: string | null;
  created_at: number;
}

export class AuditLog {
  private db: Database;
  private insertStmt: ReturnType<Database["prepare"]>;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(SCHEMA);
    this.insertStmt = this.db.prepare(
      "INSERT INTO audit_log (timestamp, event, channel, sender_id, agent, detail) VALUES (?, ?, ?, ?, ?, ?)"
    );
  }

  log(entry: AuditEntry): void {
    try {
      this.insertStmt.run(
        Date.now(),
        entry.event,
        entry.channel ?? null,
        entry.sender_id ?? null,
        entry.agent ?? null,
        entry.detail ?? null
      );
    } catch {
      // Never let audit logging crash the main pipeline
    }
  }

  query(opts: {
    limit?: number;
    channel?: string;
    event?: string;
    since?: number;
    agent?: string;
  } = {}): AuditRow[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.channel) {
      conditions.push("channel = ?");
      params.push(opts.channel);
    }
    if (opts.event) {
      conditions.push("event = ?");
      params.push(opts.event);
    }
    if (opts.since) {
      conditions.push("timestamp > ?");
      params.push(opts.since);
    }
    if (opts.agent) {
      conditions.push("agent = ?");
      params.push(opts.agent);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;

    return this.db.prepare(
      `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ?`
    ).all(...params, limit) as AuditRow[];
  }
}

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { ensureTableSchema } from "../utils/schema.js";

const failedAttempts = new Map<string, { count: number; blockedUntil: number }>();

/**
 * Pairing roles — enforced at the engine level, not just in the soul prompt.
 * - operator: full access, can approve/revoke users, trigger writes
 * - engineer: can ask questions, get explanations, request analysis — no write ops
 * - support: high-level info only, no code/config/path details
 * - viewer: read-only, minimal interaction
 */
export type PairingRole = "operator" | "engineer" | "support" | "viewer";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pairing_pending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_pending ON pairing_pending(channel, sender_id);

CREATE TABLE IF NOT EXISTS pairing_approved (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    approved_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pairing_approved ON pairing_approved(channel, sender_id);
`;

const PAIRING_CODE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class PairingStore {
  private db: Database;

  constructor(dataDir: string, instanceName?: string) {
    const dbPath = join(dataDir, `${instanceName ?? "nyxhive"}.db`);
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    const walCheck = this.db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
    if (walCheck?.journal_mode !== "wal") {
      logger.warn(`[pairing] WAL mode not active (journal_mode=${walCheck?.journal_mode}), performance may be degraded`);
    }
    this.db.exec("PRAGMA busy_timeout = 5000");

    // Detect stale schemas before CREATE TABLE IF NOT EXISTS
    ensureTableSchema(this.db, {
      table: "pairing_pending",
      required: ["channel", "sender_id", "sender", "code", "created_at"],
      ephemeral: true,
    }, "pairing");
    ensureTableSchema(this.db, {
      table: "pairing_approved",
      required: ["channel", "sender_id", "sender", "role", "approved_at"],
      ephemeral: false,
      columnDefs: {
        sender: "TEXT NOT NULL DEFAULT ''",
        role: "TEXT NOT NULL DEFAULT 'viewer'",
        approved_at: "INTEGER NOT NULL DEFAULT 0",
      },
    }, "pairing");

    this.db.exec(SCHEMA);
  }

  isApproved(channel: string, senderId: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM pairing_approved WHERE channel = ? AND sender_id = ?")
      .get(channel, senderId);
    return !!row;
  }

  generateCode(channel: string, senderId: string, senderName: string): string {
    const code = randomBytes(4).toString("hex").toUpperCase();
    const now = Date.now();

    // Upsert pending
    this.db.run(
      `INSERT INTO pairing_pending (channel, sender_id, sender, code, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel, sender_id) DO UPDATE SET code = ?, created_at = ?`,
      [channel, senderId, senderName, code, now, code, now],
    );

    logger.info(`[pairing] Generated code ${code} for ${channel}:${senderId}`);
    return code;
  }

  approve(code: string, senderKey?: string, role: PairingRole = "viewer"): { channel: string; sender_id: string; sender: string } | null {
    const now = Date.now();

    // Brute-force check
    if (senderKey) {
      const record = failedAttempts.get(senderKey);
      if (record && record.count >= 5 && now < record.blockedUntil) {
        logger.warn(`[pairing] Blocked attempt from ${senderKey} (${record.count} failures)`);
        return null;
      }
    }

    const row = this.db
      .query("SELECT channel, sender_id, sender, created_at FROM pairing_pending WHERE code = ?")
      .get(code) as { channel: string; sender_id: string; sender: string; created_at: number } | null;

    if (!row) {
      if (senderKey) {
        const record = failedAttempts.get(senderKey) ?? { count: 0, blockedUntil: 0 };
        record.count += 1;
        record.blockedUntil = now + 60 * 60 * 1000; // 1 hour window
        failedAttempts.set(senderKey, record);
        logger.warn(`[pairing] Failed attempt from ${senderKey} (code not found, total: ${record.count})`);
      }
      return null;
    }

    // Check expiry
    if (now - row.created_at > PAIRING_CODE_TTL_MS) {
      this.db.run("DELETE FROM pairing_pending WHERE code = ?", [code]);
      // Clean up all expired pending codes
      this.db.run("DELETE FROM pairing_pending WHERE created_at < ?", [now - PAIRING_CODE_TTL_MS]);
      if (senderKey) {
        const record = failedAttempts.get(senderKey) ?? { count: 0, blockedUntil: 0 };
        record.count += 1;
        record.blockedUntil = now + 60 * 60 * 1000;
        failedAttempts.set(senderKey, record);
        logger.warn(`[pairing] Failed attempt from ${senderKey} (code expired, total: ${record.count})`);
      } else {
        logger.info(`[pairing] Code ${code} expired`);
      }
      return null;
    }

    this.db.run(
      `INSERT INTO pairing_approved (channel, sender_id, sender, role, approved_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(channel, sender_id) DO UPDATE SET role = ?, approved_at = ?`,
      [row.channel, row.sender_id, row.sender, role, now, role, now],
    );

    this.db.run("DELETE FROM pairing_pending WHERE code = ?", [code]);

    if (senderKey) {
      failedAttempts.delete(senderKey);
      logger.info(`[pairing] Approved ${row.channel}:${row.sender_id} (${row.sender}) as ${role} via ${senderKey}`);
    } else {
      logger.info(`[pairing] Approved ${row.channel}:${row.sender_id} (${row.sender}) as ${role}`);
    }
    return row;
  }

  /**
   * Get the role of an approved user. Returns null if not approved.
   */
  getRole(channel: string, senderId: string): PairingRole | null {
    const row = this.db
      .query("SELECT role FROM pairing_approved WHERE channel = ? AND sender_id = ?")
      .get(channel, senderId) as { role: string } | null;
    return (row?.role as PairingRole) ?? null;
  }

  /**
   * Update an approved user's role. Only operators should call this.
   */
  setRole(channel: string, senderId: string, role: PairingRole): boolean {
    const result = this.db.run(
      "UPDATE pairing_approved SET role = ? WHERE channel = ? AND sender_id = ?",
      [role, channel, senderId],
    );
    if (result.changes > 0) {
      logger.info(`[pairing] Updated role for ${channel}:${senderId} to ${role}`);
    }
    return result.changes > 0;
  }

  revoke(channel: string, senderId: string): boolean {
    const result = this.db.run(
      "DELETE FROM pairing_approved WHERE channel = ? AND sender_id = ?",
      [channel, senderId],
    );
    return result.changes > 0;
  }

  hasAnyApproved(channel: string): boolean {
    const row = this.db
      .query("SELECT 1 FROM pairing_approved WHERE channel = ? LIMIT 1")
      .get(channel);
    return !!row;
  }

  listApproved(): Array<{ channel: string; sender_id: string; sender: string; role: PairingRole; approved_at: number }> {
    return this.db
      .query("SELECT channel, sender_id, sender, role, approved_at FROM pairing_approved ORDER BY approved_at DESC")
      .all() as Array<{ channel: string; sender_id: string; sender: string; role: PairingRole; approved_at: number }>;
  }

  listPending(): Array<{ channel: string; sender_id: string; sender: string; code: string; created_at: number }> {
    return this.db
      .query("SELECT channel, sender_id, sender, code, created_at FROM pairing_pending ORDER BY created_at DESC")
      .all() as Array<{ channel: string; sender_id: string; sender: string; code: string; created_at: number }>;
  }
}

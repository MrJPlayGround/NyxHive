/**
 * Authority Leases — resource-level locking with TTL for parallel delegation.
 *
 * Before an agent modifies a shared resource, it acquires a lease.
 * Leases expire if not renewed. Prevents conflicts when multiple
 * instances or agents work in parallel.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { ensureTableSchema } from "../utils/schema.js";

export interface Lease {
  resource: string;
  holder: string;       // instance name or agent key
  run_id: string;
  acquired_at: number;
  expires_at: number;
  ttl_ms: number;
}

interface LeaseRow {
  resource: string;
  holder: string;
  run_id: string;
  acquired_at: number;
  expires_at: number;
  ttl_ms: number;
}

const DEFAULT_TTL_MS = 300_000; // 5 minutes

const SCHEMA = `
CREATE TABLE IF NOT EXISTS authority_leases (
  resource TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  run_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ttl_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leases_holder ON authority_leases(holder);
CREATE INDEX IF NOT EXISTS idx_leases_expires ON authority_leases(expires_at);
`;

export type AcquireResult =
  | { ok: true; lease: Lease }
  | { ok: false; conflict: Lease };

export class LeaseStore {
  private db: Database;

  constructor(dataDir: string, instanceName?: string) {
    const dbPath = join(dataDir, `${instanceName ?? "nyxhive"}.db`);
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    ensureTableSchema(this.db, {
      table: "authority_leases",
      required: ["resource", "holder", "run_id", "acquired_at", "expires_at", "ttl_ms"],
      ephemeral: false,
      columnDefs: {},
    }, "leases");
    this.db.exec(SCHEMA);
  }

  /** Acquire a lease on a resource. Returns conflict info if already held. */
  acquire(resource: string, holder: string, runId: string, ttlMs = DEFAULT_TTL_MS): AcquireResult {
    const now = Date.now();

    // Clean expired leases first
    this.db.prepare("DELETE FROM authority_leases WHERE expires_at <= ?").run(now);

    // Check existing lease
    const existing = this.db.prepare("SELECT * FROM authority_leases WHERE resource = ?").get(resource) as LeaseRow | null;
    if (existing) {
      // Same holder can re-acquire (idempotent)
      if (existing.holder === holder) {
        return this.renew(resource, holder, ttlMs)
          ? { ok: true, lease: { ...existing, expires_at: now + ttlMs, ttl_ms: ttlMs } }
          : { ok: false, conflict: existing };
      }
      logger.warn(`[leases] Conflict: ${holder} tried to acquire "${resource}" held by ${existing.holder} (run: ${existing.run_id})`);
      return { ok: false, conflict: existing };
    }

    const expiresAt = now + ttlMs;
    this.db.prepare(
      "INSERT INTO authority_leases (resource, holder, run_id, acquired_at, expires_at, ttl_ms) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(resource, holder, runId, now, expiresAt, ttlMs);

    const lease: Lease = { resource, holder, run_id: runId, acquired_at: now, expires_at: expiresAt, ttl_ms: ttlMs };
    logger.info(`[leases] Acquired: "${resource}" by ${holder} (TTL: ${ttlMs}ms)`);
    return { ok: true, lease };
  }

  /** Renew an existing lease. Only the current holder can renew. */
  renew(resource: string, holder: string, ttlMs?: number): boolean {
    const now = Date.now();
    this.db.prepare("DELETE FROM authority_leases WHERE expires_at <= ?").run(now);

    const existing = this.db.prepare("SELECT * FROM authority_leases WHERE resource = ? AND holder = ?").get(resource, holder) as LeaseRow | null;
    if (!existing) return false;

    const effectiveTtl = ttlMs ?? existing.ttl_ms;
    const newExpiry = now + effectiveTtl;
    this.db.prepare("UPDATE authority_leases SET expires_at = ?, ttl_ms = ? WHERE resource = ?").run(newExpiry, effectiveTtl, resource);
    logger.debug(`[leases] Renewed: "${resource}" by ${holder} (new expiry: +${effectiveTtl}ms)`);
    return true;
  }

  /** Release a lease. Only the current holder can release. */
  release(resource: string, holder: string): boolean {
    const result = this.db.prepare("DELETE FROM authority_leases WHERE resource = ? AND holder = ?").run(resource, holder);
    if (result.changes > 0) {
      logger.info(`[leases] Released: "${resource}" by ${holder}`);
      return true;
    }
    return false;
  }

  /** Check who holds a lease. Returns null if not held or expired. */
  check(resource: string): Lease | null {
    const now = Date.now();
    // Auto-release stale leases
    this.db.prepare("DELETE FROM authority_leases WHERE expires_at <= ?").run(now);

    const row = this.db.prepare("SELECT * FROM authority_leases WHERE resource = ?").get(resource) as LeaseRow | null;
    return row ?? null;
  }

  /** List all active leases. */
  listActive(): Lease[] {
    const now = Date.now();
    this.db.prepare("DELETE FROM authority_leases WHERE expires_at <= ?").run(now);
    return this.db.prepare("SELECT * FROM authority_leases ORDER BY acquired_at DESC").all() as LeaseRow[];
  }

  /** Release all leases held by a specific holder (e.g., on instance shutdown). */
  releaseAll(holder: string): number {
    const result = this.db.prepare("DELETE FROM authority_leases WHERE holder = ?").run(holder);
    if (result.changes > 0) {
      logger.info(`[leases] Released all ${result.changes} leases for ${holder}`);
    }
    return result.changes;
  }

  /** Release all leases for a specific run (e.g., on run completion). */
  releaseByRun(runId: string): number {
    const result = this.db.prepare("DELETE FROM authority_leases WHERE run_id = ?").run(runId);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

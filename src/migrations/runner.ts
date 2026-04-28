import type { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";

export interface Migration {
  version: number;
  description: string;
  up(db: Database): void;
}

export interface MigrationStatus {
  current_version: number;
  pending: Migration[];
  applied: number[];
}

export interface MigrationResult {
  success: boolean;
  applied: number[];
  error?: string;
}

/**
 * Initialize the schema_version table if it doesn't exist.
 */
function ensureVersionTable(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
}

/**
 * Get the current (highest applied) schema version.
 */
export function getCurrentVersion(db: Database): number {
  ensureVersionTable(db);
  const row = db.query("SELECT MAX(version) as v FROM schema_version").get() as { v: number | null };
  return row?.v ?? 0;
}

/**
 * Get all applied migration versions.
 */
export function getAppliedVersions(db: Database): number[] {
  ensureVersionTable(db);
  const rows = db.query("SELECT version FROM schema_version ORDER BY version").all() as Array<{ version: number }>;
  return rows.map(r => r.version);
}

/**
 * Get migration status: current version, pending migrations.
 */
export function getMigrationStatus(db: Database, migrations: Migration[]): MigrationStatus {
  const applied = getAppliedVersions(db);
  const current = applied.length > 0 ? Math.max(...applied) : 0;
  const pending = migrations
    .filter(m => !applied.includes(m.version))
    .sort((a, b) => a.version - b.version);

  return { current_version: current, pending, applied };
}

/**
 * Run all pending migrations in order, each in a transaction.
 * Uses BEGIN IMMEDIATE to prevent concurrent migration attempts.
 */
export function runMigrations(db: Database, migrations: Migration[]): MigrationResult {
  ensureVersionTable(db);

  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const applied = getAppliedVersions(db);
  const pending = sorted.filter(m => !applied.includes(m.version));

  if (pending.length === 0) {
    return { success: true, applied: [] };
  }

  const appliedVersions: number[] = [];

  for (const migration of pending) {
    try {
      db.run("BEGIN IMMEDIATE");

      try {
        migration.up(db);

        db.run(
          "INSERT INTO schema_version (version, description, applied_at) VALUES (?, ?, ?)",
          [migration.version, migration.description, Date.now()],
        );

        db.run("COMMIT");
        appliedVersions.push(migration.version);
        logger.info(`[migrations] Applied v${migration.version}: ${migration.description}`);
      } catch (err) {
        db.run("ROLLBACK");
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[migrations] Failed v${migration.version}: ${msg}`);
        return {
          success: false,
          applied: appliedVersions,
          error: `Migration v${migration.version} failed: ${msg}`,
        };
      }
    } catch (err) {
      // BEGIN IMMEDIATE failed — another process is migrating
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        applied: appliedVersions,
        error: `Could not acquire migration lock: ${msg}`,
      };
    }
  }

  return { success: true, applied: appliedVersions };
}

/**
 * Dry run: report what migrations would be applied without running them.
 */
export function dryRunMigrations(db: Database, migrations: Migration[]): {
  would_apply: Array<{ version: number; description: string }>;
  current_version: number;
} {
  const status = getMigrationStatus(db, migrations);
  return {
    current_version: status.current_version,
    would_apply: status.pending.map(m => ({ version: m.version, description: m.description })),
  };
}

/**
 * Validate migration list for common issues.
 */
export function validateMigrations(migrations: Migration[]): string[] {
  const errors: string[] = [];
  const versions = new Set<number>();

  for (const m of migrations) {
    if (versions.has(m.version)) {
      errors.push(`Duplicate version: ${m.version}`);
    }
    versions.add(m.version);

    if (m.version < 1) {
      errors.push(`Invalid version ${m.version}: must be >= 1`);
    }

    if (!m.description || m.description.trim().length === 0) {
      errors.push(`Migration v${m.version} has no description`);
    }
  }

  return errors;
}

/**
 * Schema migration safety for SQLite tables.
 *
 * CREATE TABLE IF NOT EXISTS silently does nothing when a table exists
 * with a different schema. This utility detects stale schemas and either
 * drops+recreates (ephemeral data) or ALTER TABLE ADD COLUMNs (persistent data).
 *
 * Call before CREATE TABLE IF NOT EXISTS statements.
 */

import type { Database } from "bun:sqlite";
import { logger } from "./logger.js";

export interface TableSchemaCheck {
  table: string;
  /** All non-PK columns that must exist */
  required: string[];
  /** true = DROP+recreate, false = ALTER TABLE ADD COLUMN */
  ephemeral: boolean;
  /** Column definitions for ALTER TABLE (persistent tables only). Maps column name to SQL type+default. */
  columnDefs?: Record<string, string>;
}

export function ensureTableSchema(db: Database, check: TableSchemaCheck, logPrefix: string): void {
  try {
    const cols = db.query(`PRAGMA table_info(${check.table})`).all() as Array<{ name: string }>;
    if (cols.length === 0) return; // Table doesn't exist yet, CREATE TABLE will handle it

    const existing = new Set(cols.map(c => c.name));
    const missing = check.required.filter(c => !existing.has(c));
    if (missing.length === 0) return; // Schema is current

    if (check.ephemeral) {
      logger.warn(`[${logPrefix}] Stale ${check.table} table (missing: ${missing.join(", ")}), recreating`);
      db.exec(`DROP TABLE IF EXISTS ${check.table}`);
    } else {
      for (const col of missing) {
        const def = check.columnDefs?.[col];
        if (!def) {
          logger.warn(`[${logPrefix}] Missing column ${col} in ${check.table}, no ALTER definition`);
          continue;
        }
        logger.warn(`[${logPrefix}] Adding column ${col} to ${check.table}`);
        db.exec(`ALTER TABLE ${check.table} ADD COLUMN ${col} ${def}`);
      }
    }
  } catch { /* table doesn't exist yet */ }
}

import { logger } from "./logger.js";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";

export interface BackupOptions {
  dataDir: string;
  backupDir?: string;
  maxBackups?: number;
  now?: Date;
}

export interface BackupResult {
  success: boolean;
  files: string[];
  backupDir: string;
  timestamp: string;
  error?: string;
}

/**
 * Creates a point-in-time backup of all SQLite databases.
 * Uses VACUUM INTO for atomic, consistent snapshots (safe while server is running).
 * Falls back to file copy if VACUUM INTO fails.
 */
export function createBackup(options: BackupOptions): BackupResult {
  const { dataDir, maxBackups = 10 } = options;
  const backupDir = options.backupDir ?? join(dataDir, "backups");
  const timestamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const snapshotDir = join(backupDir, timestamp);

  if (!existsSync(dataDir)) {
    return { success: false, files: [], backupDir: snapshotDir, timestamp, error: "Data directory does not exist" };
  }

  const dbFiles = readdirSync(dataDir).filter(f => f.endsWith(".db"));
  if (dbFiles.length === 0) {
    return { success: false, files: [], backupDir: snapshotDir, timestamp, error: "No database files found" };
  }

  mkdirSync(snapshotDir, { recursive: true });

  const backedUp: string[] = [];

  for (const dbFile of dbFiles) {
    const sourcePath = join(dataDir, dbFile);
    const destPath = join(snapshotDir, dbFile);

    try {
      // Checkpoint WAL then use VACUUM INTO for an atomic, consistent copy
      const db = new Database(sourcePath);
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      db.run(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
      db.close();

      backedUp.push(destPath);
      logger.info(`[backup] Backed up ${dbFile} -> ${destPath}`);
    } catch (err) {
      // Fallback: file copy (less safe but better than nothing)
      try {
        copyFileSync(sourcePath, destPath);
        backedUp.push(destPath);
        logger.warn(`[backup] Used file copy fallback for ${dbFile} (VACUUM INTO failed: ${err})`);
      } catch (copyErr) {
        logger.error(`[backup] Failed to backup ${dbFile}: ${copyErr}`);
      }
    }
  }

  rotateBackups(backupDir, maxBackups);

  return { success: backedUp.length > 0, files: backedUp, backupDir: snapshotDir, timestamp };
}

/** Keeps only the most recent N backup directories. */
function rotateBackups(backupDir: string, maxBackups: number): void {
  if (!existsSync(backupDir)) return;

  const entries = readdirSync(backupDir)
    .map(name => {
      const path = join(backupDir, name);
      const stat = statSync(path);
      return { name, path, isDir: stat.isDirectory(), mtimeMs: stat.mtimeMs };
    })
    .filter(e => e.isDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first

  if (entries.length <= maxBackups) return;

  for (const entry of entries.slice(maxBackups)) {
    try {
      const files = readdirSync(entry.path);
      for (const file of files) {
        unlinkSync(join(entry.path, file));
      }
      rmdirSync(entry.path);
      logger.info(`[backup] Rotated old backup: ${entry.name}`);
    } catch {
      // Best effort rotation
    }
  }
}

/** Lists existing backups with metadata, newest first. */
export function listBackups(dataDir: string, backupDir?: string): Array<{ timestamp: string; path: string; files: string[]; sizeBytes: number }> {
  const dir = backupDir ?? join(dataDir, "backups");
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .map(name => {
      const path = join(dir, name);
      try {
        const stat = statSync(path);
        if (!stat.isDirectory()) return null;

        const files = readdirSync(path);
        const sizeBytes = files.reduce((sum, f) => sum + statSync(join(path, f)).size, 0);

        return { timestamp: name, path, files, sizeBytes };
      } catch {
        return null;
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

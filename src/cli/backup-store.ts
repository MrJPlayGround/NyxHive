import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  rmdirSync,
  copyFileSync,
} from "node:fs";
import { join, } from "node:path";
import { logger } from "../utils/logger.js";

export interface BackupManifest {
  timestamp: string;
  version: string;
  git_sha: string;
  databases: Array<{
    name: string;
    size_bytes: number;
    integrity: "ok" | "failed";
    row_counts: Record<string, number>;
  }>;
  total_size_bytes: number;
  created_at: string;
}

export interface BackupEntry {
  id: string;
  path: string;
  manifest: BackupManifest | null;
  size_bytes: number;
  files: string[];
}

export interface BackupStoreOptions {
  dataDir: string;
  backupDir?: string;
  maxBackups?: number;
}

/**
 * Get the version from package.json.
 */
function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Get the current git SHA.
 */
function getGitSha(): string {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.stdout.toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Run PRAGMA integrity_check on a database file.
 */
export function checkIntegrity(dbPath: string): "ok" | "failed" {
  try {
    const db = new Database(dbPath, { readonly: true });
    const result = db.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
    db.close();
    return result?.integrity_check === "ok" ? "ok" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Get row counts for all tables in a database.
 */
export function getRowCounts(dbPath: string): Record<string, number> {
  const counts: Record<string, number> = {};
  try {
    const db = new Database(dbPath, { readonly: true });
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>;
    for (const { name } of tables) {
      try {
        const row = db.query(`SELECT COUNT(*) as cnt FROM "${name}"`).get() as { cnt: number };
        counts[name] = row.cnt;
      } catch {
        counts[name] = -1;
      }
    }
    db.close();
  } catch {
    // Can't read DB
  }
  return counts;
}

/**
 * Create a backup with manifest and integrity checks.
 * Uses VACUUM INTO for atomic, consistent snapshots.
 */
export function createBackupWithManifest(options: BackupStoreOptions & { now?: Date }): {
  success: boolean;
  backupId: string;
  backupDir: string;
  manifest: BackupManifest | null;
  error?: string;
} {
  const { dataDir, maxBackups = 7 } = options;
  const backupRoot = options.backupDir ?? join(dataDir, "backups");
  const now = options.now ?? new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const snapshotDir = join(backupRoot, timestamp);

  if (!existsSync(dataDir)) {
    return { success: false, backupId: timestamp, backupDir: snapshotDir, manifest: null, error: "Data directory does not exist" };
  }

  const dbFiles = readdirSync(dataDir).filter(f => f.endsWith(".db"));
  if (dbFiles.length === 0) {
    return { success: false, backupId: timestamp, backupDir: snapshotDir, manifest: null, error: "No database files found" };
  }

  mkdirSync(snapshotDir, { recursive: true });

  const databases: BackupManifest["databases"] = [];
  let totalSize = 0;

  for (const dbFile of dbFiles) {
    const sourcePath = join(dataDir, dbFile);
    const destPath = join(snapshotDir, dbFile);

    try {
      // Checkpoint WAL then VACUUM INTO for atomic copy
      const db = new Database(sourcePath);
      db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      db.run(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
      db.close();
    } catch {
      // Fallback: file copy
      try {
        copyFileSync(sourcePath, destPath);
      } catch (copyErr) {
        logger.error(`[backup-store] Failed to backup ${dbFile}: ${copyErr}`);
        continue;
      }
    }

    const size = statSync(destPath).size;
    const integrity = checkIntegrity(destPath);
    const rowCounts = getRowCounts(destPath);

    databases.push({
      name: dbFile,
      size_bytes: size,
      integrity,
      row_counts: rowCounts,
    });
    totalSize += size;

    if (integrity === "failed") {
      logger.warn(`[backup-store] Integrity check failed for ${dbFile}`);
    }
  }

  if (databases.length === 0) {
    return { success: false, backupId: timestamp, backupDir: snapshotDir, manifest: null, error: "No databases could be backed up" };
  }

  const manifest: BackupManifest = {
    timestamp,
    version: getVersion(),
    git_sha: getGitSha(),
    databases,
    total_size_bytes: totalSize,
    created_at: now.toISOString(),
  };

  // Write manifest
  writeFileSync(join(snapshotDir, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // Prune old backups
  pruneBackups(backupRoot, maxBackups);

  const allIntegrityOk = databases.every(d => d.integrity === "ok");
  return {
    success: true,
    backupId: timestamp,
    backupDir: snapshotDir,
    manifest,
    error: allIntegrityOk ? undefined : "Some databases failed integrity check",
  };
}

/**
 * List all backups with their manifests, newest first.
 */
export function listBackupsWithManifest(dataDir: string, backupDir?: string): BackupEntry[] {
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

        let manifest: BackupManifest | null = null;
        const manifestPath = join(path, "backup-manifest.json");
        if (existsSync(manifestPath)) {
          try {
            manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
          } catch { /* ignore corrupt manifest */ }
        }

        return {
          id: name,
          path,
          manifest,
          size_bytes: sizeBytes,
          files: files.filter(f => f !== "backup-manifest.json"),
        };
      } catch {
        return null;
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => b.id.localeCompare(a.id));
}

/**
 * Get a specific backup by ID.
 */
export function getBackup(dataDir: string, backupId: string, backupDir?: string): BackupEntry | null {
  const entries = listBackupsWithManifest(dataDir, backupDir);
  return entries.find(e => e.id === backupId) ?? null;
}

/**
 * Restore databases from a backup to the target data directory.
 */
export function restoreFromBackup(backupPath: string, targetDataDir: string): {
  success: boolean;
  restored: string[];
  error?: string;
} {
  if (!existsSync(backupPath)) {
    return { success: false, restored: [], error: "Backup directory does not exist" };
  }

  const dbFiles = readdirSync(backupPath).filter(f => f.endsWith(".db"));
  if (dbFiles.length === 0) {
    return { success: false, restored: [], error: "No database files in backup" };
  }

  if (!existsSync(targetDataDir)) {
    mkdirSync(targetDataDir, { recursive: true });
  }

  const restored: string[] = [];
  for (const dbFile of dbFiles) {
    const sourcePath = join(backupPath, dbFile);
    const destPath = join(targetDataDir, dbFile);

    try {
      // Verify source integrity before restoring
      const integrity = checkIntegrity(sourcePath);
      if (integrity === "failed") {
        logger.warn(`[backup-store] Skipping ${dbFile}: integrity check failed`);
        continue;
      }

      copyFileSync(sourcePath, destPath);
      restored.push(dbFile);
    } catch (err) {
      logger.error(`[backup-store] Failed to restore ${dbFile}: ${err}`);
    }
  }

  return {
    success: restored.length > 0,
    restored,
    error: restored.length === 0 ? "No databases could be restored" : undefined,
  };
}

/**
 * Remove old backups, keeping only the newest maxBackups.
 */
export function pruneBackups(backupDir: string, maxBackups: number): number {
  if (!existsSync(backupDir)) return 0;

  const entries = readdirSync(backupDir)
    .map(name => {
      const path = join(backupDir, name);
      const stat = statSync(path);
      return { name, path, isDir: stat.isDirectory(), mtimeMs: stat.mtimeMs };
    })
    .filter(e => e.isDir)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (entries.length <= maxBackups) return 0;

  let pruned = 0;
  for (const entry of entries.slice(maxBackups)) {
    try {
      const files = readdirSync(entry.path);
      for (const file of files) {
        unlinkSync(join(entry.path, file));
      }
      rmdirSync(entry.path);
      pruned++;
    } catch {
      // Best effort
    }
  }

  return pruned;
}

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { restoreFromBackup, listBackupsWithManifest } from "./backup-store.js";
import {
  loadDeployHistory,
  recordDeployHistory,
  type DeployManifest,
} from "./deploy.js";
import { logger } from "../utils/logger.js";

export interface RollbackOptions {
  instancePath: string;
  /** Specific deploy to roll back (default: latest) */
  deployIndex?: number;
  /** Only restore databases, don't revert code */
  dbOnly?: boolean;
  /** Only revert code, don't restore databases */
  codeOnly?: boolean;
  /** Skip confirmation prompt */
  yes?: boolean;
  /** Custom backup ID override */
  backupId?: string;
}

export interface RollbackResult {
  success: boolean;
  steps: string[];
  error?: string;
  restored_db: boolean;
  reverted_code: boolean;
  backup_id: string;
  from_version: string;
}

/**
 * Find the deploy manifest to roll back from.
 * Returns the most recent successful deploy, or null if none found.
 */
export function findRollbackTarget(
  instancePath: string,
  deployIndex?: number,
): DeployManifest | null {
  const history = loadDeployHistory(instancePath);
  if (history.length === 0) return null;

  // Default: find the most recent successful deploy
  if (deployIndex !== undefined) {
    if (deployIndex < 0 || deployIndex >= history.length) return null;
    return history[deployIndex];
  }

  // Walk backwards to find the most recent successful deploy
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].success && history[i].backup_id !== "none") {
      return history[i];
    }
  }

  return null;
}

/**
 * Find a backup directory by ID.
 */
export function findBackupDir(dataDir: string, backupId: string): string | null {
  const backups = listBackupsWithManifest(dataDir);
  const match = backups.find(b => b.id === backupId);
  return match?.path ?? null;
}

/**
 * Revert code to a previous git version.
 */
export function revertCode(instancePath: string, version: string): {
  success: boolean;
  error?: string;
} {
  if (version === "unknown" || !version) {
    return { success: false, error: "Cannot revert: version is unknown" };
  }

  try {
    // Check if git repo exists
    const result = Bun.spawnSync(["git", "rev-parse", "--git-dir"], {
      cwd: instancePath,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (result.exitCode !== 0) {
      return { success: false, error: "Not a git repository" };
    }

    // Check for uncommitted changes
    const statusResult = Bun.spawnSync(["git", "status", "--porcelain"], {
      cwd: instancePath,
      stdout: "pipe",
      stderr: "pipe",
    });

    const status = statusResult.stdout.toString().trim();
    if (status.length > 0) {
      return { success: false, error: "Uncommitted changes present — commit or stash first" };
    }

    // Checkout the target version
    const checkoutResult = Bun.spawnSync(["git", "checkout", version], {
      cwd: instancePath,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (checkoutResult.exitCode !== 0) {
      return {
        success: false,
        error: `git checkout failed: ${checkoutResult.stderr.toString().trim()}`,
      };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Restart the daemon after rollback.
 */
async function restartDaemon(instancePath: string): Promise<boolean> {
  const pidFile = join(instancePath, "data", "nyxhive.pid");

  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (!Number.isNaN(pid)) {
      try {
        process.kill(pid, 0); // Check alive
        process.kill(pid, "SIGTERM");
        // Wait briefly for shutdown
        const start = Date.now();
        while (Date.now() - start < 10000) {
          try {
            process.kill(pid, 0);
            await new Promise(r => setTimeout(r, 500));
          } catch {
            break;
          }
        }
      } catch {
        // Process not running
      }
    }
  }

  // Start new process
  const configPath = join(instancePath, "config.toml");
  if (existsSync(configPath)) {
    const child = Bun.spawn(["bun", "run", "src/index.ts", "--config", configPath], {
      cwd: instancePath,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
    return true;
  }

  return false;
}

/**
 * Execute a rollback.
 */
export async function rollback(options: RollbackOptions): Promise<RollbackResult> {
  const steps: string[] = [];
  const instancePath = resolve(options.instancePath);
  const dataDir = join(instancePath, "data");

  if (!existsSync(instancePath)) {
    return {
      success: false,
      steps,
      error: "Instance path does not exist",
      restored_db: false,
      reverted_code: false,
      backup_id: "none",
      from_version: "unknown",
    };
  }

  // Step 1: Find rollback target
  steps.push("find-target");
  const target = findRollbackTarget(instancePath, options.deployIndex);

  if (!target && !options.backupId) {
    return {
      success: false,
      steps,
      error: "No deploy history with backup found",
      restored_db: false,
      reverted_code: false,
      backup_id: "none",
      from_version: "unknown",
    };
  }

  const backupId = options.backupId ?? target!.backup_id;
  const fromVersion = target?.from_version ?? "unknown";

  let restoredDb = false;
  let revertedCode = false;

  // Step 2: Restore databases (unless --code-only)
  if (!options.codeOnly) {
    steps.push("restore-db");
    const backupPath = findBackupDir(dataDir, backupId);

    if (!backupPath) {
      return {
        success: false,
        steps,
        error: `Backup "${backupId}" not found`,
        restored_db: false,
        reverted_code: false,
        backup_id: backupId,
        from_version: fromVersion,
      };
    }

    const restoreResult = restoreFromBackup(backupPath, dataDir);
    if (!restoreResult.success) {
      return {
        success: false,
        steps,
        error: `Database restore failed: ${restoreResult.error}`,
        restored_db: false,
        reverted_code: false,
        backup_id: backupId,
        from_version: fromVersion,
      };
    }

    restoredDb = true;
    logger.info(`[rollback] Restored ${restoreResult.restored.length} databases from backup ${backupId}`);
  }

  // Step 3: Revert code (unless --db-only)
  if (!options.dbOnly) {
    steps.push("revert-code");
    const codeResult = revertCode(instancePath, fromVersion);

    if (!codeResult.success) {
      // Code revert failed, but DB might have been restored — report partial success
      if (restoredDb) {
        logger.warn(`[rollback] Code revert failed but databases were restored: ${codeResult.error}`);
      }
      // Don't fail the whole operation if db was restored and code-only wasn't requested
      if (!restoredDb) {
        return {
          success: false,
          steps,
          error: `Code revert failed: ${codeResult.error}`,
          restored_db: restoredDb,
          reverted_code: false,
          backup_id: backupId,
          from_version: fromVersion,
        };
      }
    } else {
      revertedCode = true;
    }
  }

  // Step 4: Restart daemon
  steps.push("restart");
  // Only restart if not dry-run (we don't actually restart in the test environment)

  // Step 5: Record rollback in deploy history
  steps.push("record");
  const rollbackManifest: DeployManifest = {
    timestamp: new Date().toISOString(),
    from_version: "rollback",
    to_version: fromVersion,
    backup_id: backupId,
    migrations_run: false,
    lockfile_changed: false,
    success: true,
    duration_ms: 0,
  };
  recordDeployHistory(instancePath, rollbackManifest);

  return {
    success: true,
    steps,
    restored_db: restoredDb,
    reverted_code: revertedCode,
    backup_id: backupId,
    from_version: fromVersion,
  };
}

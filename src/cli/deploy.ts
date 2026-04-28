import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadBookmarks } from "./instance-registry.js";
import { resolveInstance } from "./resolve.js";
import { logger } from "../utils/logger.js";

export interface DeployManifest {
  timestamp: string;
  from_version: string;
  to_version: string;
  backup_id: string;
  migrations_run: boolean;
  lockfile_changed: boolean;
  success: boolean;
  error?: string;
  duration_ms: number;
}

export interface DeployOptions {
  instanceName?: string;
  instancePath?: string;
  sourceDir: string;
  bookmarksPath?: string;
  dryRun?: boolean;
}

export interface DeployResult {
  success: boolean;
  manifest: DeployManifest;
  steps: string[];
}

/**
 * Resolve the target instance directory from name or path.
 */
export function resolveDeployTarget(
  options: Pick<DeployOptions, "instanceName" | "instancePath" | "bookmarksPath">,
): { path: string; port: number } {
  // Try bookmarks first
  if (options.instanceName) {
    const { bookmarks } = loadBookmarks(options.bookmarksPath);
    const bookmark = bookmarks.find(b => b.name === options.instanceName);
    if (bookmark) {
      return { path: bookmark.path, port: bookmark.port ?? 0 };
    }

    // Fall back to filesystem resolution
    try {
      const resolved = resolveInstance(options.instanceName);
      return { path: resolved.instanceDir, port: 0 };
    } catch {
      throw new Error(`Instance "${options.instanceName}" not found in bookmarks or filesystem`);
    }
  }

  if (options.instancePath) {
    const absPath = resolve(options.instancePath);
    if (!existsSync(absPath)) {
      throw new Error(`Instance path not found: ${absPath}`);
    }
    return { path: absPath, port: 0 };
  }

  throw new Error("Either --instance <name> or --path <dir> is required");
}

/**
 * Get the current git version (short hash) of a directory.
 */
export function getGitVersion(dir: string): string {
  try {
    const result = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    return result.stdout.toString().trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Run the local deploy sequence:
 * 1. Backup target instance
 * 2. Rsync source (exclude data/, config/, .git/)
 * 3. Run bun install if lockfile changed
 * 4. Run database migrations (if migration script exists)
 * 5. Graceful restart (SIGTERM → wait → start)
 * 6. Health check
 * 7. Record deploy manifest
 */
export async function deployLocal(options: DeployOptions): Promise<DeployResult> {
  const start = Date.now();
  const steps: string[] = [];
  const target = resolveDeployTarget(options);
  const targetPath = target.path;
  const sourceDir = resolve(options.sourceDir);

  const fromVersion = getGitVersion(targetPath);
  const toVersion = getGitVersion(sourceDir);

  let backupId = "none";
  let migrationsRun = false;
  let lockfileChanged = false;

  try {
    // Step 1: Backup with manifest (non-fatal if no DB files exist yet)
    steps.push("backup");
    const dataDir = join(targetPath, "data");
    if (existsSync(dataDir)) {
      const { createBackupWithManifest } = await import("./backup-store.js");
      const backupResult = createBackupWithManifest({ dataDir });
      backupId = backupResult.backupId;
      if (!backupResult.success && backupResult.error !== "No database files found") {
        throw new Error(`Backup failed: ${backupResult.error ?? "unknown error"}`);
      }
    }

    // Step 2: Rsync source files
    steps.push("rsync");
    if (!options.dryRun) {
      const rsyncResult = Bun.spawnSync([
        "rsync", "-a", "--delete",
        "--exclude", "data/",
        "--exclude", "config/",
        "--exclude", ".git/",
        "--exclude", "node_modules/",
        "--exclude", ".env",
        "--exclude", "env",
        "--exclude", "workspace/",
        sourceDir.endsWith("/") ? sourceDir : `${sourceDir}/`,
        targetPath.endsWith("/") ? targetPath : `${targetPath}/`,
      ], {
        stdout: "pipe",
        stderr: "pipe",
      });

      if (rsyncResult.exitCode !== 0) {
        throw new Error(`rsync failed: ${rsyncResult.stderr.toString()}`);
      }
    }

    // Step 3: Check if lockfile changed, run bun install
    steps.push("dependencies");
    const sourceLock = join(sourceDir, "bun.lockb");
    const targetLock = join(targetPath, "bun.lockb");

    if (existsSync(sourceLock) && existsSync(targetLock)) {
      const sourceHash = Bun.hash(readFileSync(sourceLock));
      const targetHash = Bun.hash(readFileSync(targetLock));
      lockfileChanged = sourceHash !== targetHash;
    } else if (existsSync(sourceLock)) {
      lockfileChanged = true;
    }

    if (lockfileChanged && !options.dryRun) {
      const installResult = Bun.spawnSync(["bun", "install"], {
        cwd: targetPath,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (installResult.exitCode !== 0) {
        throw new Error(`bun install failed: ${installResult.stderr.toString()}`);
      }
    }

    // Step 4: Run migrations if script exists
    steps.push("migrations");
    const migrateScript = join(targetPath, "src", "migrations", "run.ts");
    if (existsSync(migrateScript) && !options.dryRun) {
      const migrateResult = Bun.spawnSync(["bun", "run", migrateScript], {
        cwd: targetPath,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (migrateResult.exitCode !== 0) {
        throw new Error(`Migration failed: ${migrateResult.stderr.toString()}`);
      }
      migrationsRun = true;
    }

    // Step 5: Graceful restart
    steps.push("restart");
    if (!options.dryRun) {
      await gracefulRestart(targetPath, target.port);
    }

    // Step 6: Health check
    steps.push("health-check");
    if (!options.dryRun && target.port > 0) {
      const healthy = await pollHealthCheck("localhost", target.port);
      if (!healthy) {
        throw new Error("Health check failed after deploy");
      }
    }

    const manifest: DeployManifest = {
      timestamp: new Date().toISOString(),
      from_version: fromVersion,
      to_version: toVersion,
      backup_id: backupId,
      migrations_run: migrationsRun,
      lockfile_changed: lockfileChanged,
      success: true,
      duration_ms: Date.now() - start,
    };

    // Record deploy history
    steps.push("record");
    recordDeployHistory(targetPath, manifest);

    return { success: true, manifest, steps };
  } catch (err) {
    const manifest: DeployManifest = {
      timestamp: new Date().toISOString(),
      from_version: fromVersion,
      to_version: toVersion,
      backup_id: backupId,
      migrations_run: migrationsRun,
      lockfile_changed: lockfileChanged,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      duration_ms: Date.now() - start,
    };

    recordDeployHistory(targetPath, manifest);

    return { success: false, manifest, steps };
  }
}

/**
 * Send SIGTERM to running instance, wait for graceful shutdown, then restart.
 */
async function gracefulRestart(instanceDir: string, _port: number): Promise<void> {
  const pidFile = join(instanceDir, "data", "nyxhive.pid");

  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (!Number.isNaN(pid)) {
      try {
        // Check if process is alive
        process.kill(pid, 0);
        // Send SIGTERM for graceful shutdown
        process.kill(pid, "SIGTERM");
        // Wait for process to exit (max 60s)
        await waitForProcessExit(pid, 60000);
      } catch {
        // Process not running, continue
      }
    }
  }

  // Start new process
  const configPath = join(instanceDir, "config.toml");
  if (existsSync(configPath)) {
    const child = Bun.spawn(["bun", "run", "src/index.ts", "--config", configPath], {
      cwd: instanceDir,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
  }
}

/**
 * Wait for a process to exit, checking every second.
 */
async function waitForProcessExit(pid: number, maxWaitMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      process.kill(pid, 0);
      await new Promise(r => setTimeout(r, 1000));
    } catch {
      return; // Process exited
    }
  }
}

/**
 * Poll /health endpoint every 2 seconds for up to 30 seconds.
 */
export async function pollHealthCheck(
  host: string,
  port: number,
  maxWaitMs = 30000,
  intervalMs = 2000,
): Promise<boolean> {
  const start = Date.now();
  const url = `http://${host}:${port}/health`;

  while (Date.now() - start < maxWaitMs) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (response.ok) return true;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }

  return false;
}

/**
 * Record a deploy in the instance's deploy-history.json.
 * Keeps last 50 entries.
 */
export function recordDeployHistory(instanceDir: string, manifest: DeployManifest): void {
  const dataDir = join(instanceDir, "data");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const historyPath = join(dataDir, "deploy-history.json");
  let history: DeployManifest[] = [];

  if (existsSync(historyPath)) {
    try {
      history = JSON.parse(readFileSync(historyPath, "utf-8"));
      if (!Array.isArray(history)) history = [];
    } catch {
      history = [];
    }
  }

  history.push(manifest);

  // Keep only last 50
  if (history.length > 50) {
    history = history.slice(-50);
  }

  writeFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`);
}

/**
 * Load deploy history for an instance.
 */
export function loadDeployHistory(instanceDir: string): DeployManifest[] {
  const historyPath = join(instanceDir, "data", "deploy-history.json");
  if (!existsSync(historyPath)) return [];

  try {
    const data = JSON.parse(readFileSync(historyPath, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

// CLI entry point
if (process.argv[2] === "deploy") {
  const args = process.argv.slice(3);
  let instanceName: string | undefined;
  let instancePath: string | undefined;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--instance" && i + 1 < args.length) {
      instanceName = args[++i];
    } else if (args[i] === "--path" && i + 1 < args.length) {
      instancePath = args[++i];
    } else if (args[i] === "--dry-run") {
      dryRun = true;
    } else if (!args[i].startsWith("--")) {
      instanceName = args[i];
    }
  }

  if (!instanceName && !instancePath) {
    logger.error(`
  Usage: nyxhive deploy <instance> [options]

  Options:
    --instance <name>    Instance name (from registry or filesystem)
    --path <dir>         Direct path to instance directory
    --dry-run            Show what would happen without making changes
`);
    process.exit(1);
  }

  const sourceDir = process.cwd();
  logger.info(`
  NyxHive Deploy
  ──────────────
  Source:   ${sourceDir}
  Target:   ${instanceName ?? instancePath}
  Dry run:  ${dryRun}
`);

  try {
    const result = await deployLocal({
      instanceName,
      instancePath,
      sourceDir,
      dryRun,
    });

    if (result.success) {
      logger.info(`  Deploy successful!
  ──────────────────
  Version:    ${result.manifest.from_version} -> ${result.manifest.to_version}
  Backup:     ${result.manifest.backup_id}
  Migrations: ${result.manifest.migrations_run ? "yes" : "no"}
  Duration:   ${result.manifest.duration_ms}ms
`);
    } else {
      logger.error(`  Deploy failed: ${result.manifest.error}`);
      process.exit(1);
    }
  } catch (err) {
    logger.error(`  Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

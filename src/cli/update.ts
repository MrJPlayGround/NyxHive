import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "../utils/logger.js";

const ENGINE_ROOT = resolve(import.meta.dir, "../..");
const DEPENDENCY_FILES = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "src/gateway/package.json",
] as const;

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface EngineUpdateOptions {
  repoDir?: string;
  check?: boolean;
  dryRun?: boolean;
  stash?: boolean;
}

export interface EngineUpdateResult {
  repoDir: string;
  branch: string;
  trackingRef: string;
  startingVersion: string;
  targetVersion: string;
  finalVersion: string;
  ahead: number;
  behind: number;
  status: "up-to-date" | "update-available" | "updated";
  dependenciesInstalled: boolean;
  dependencyFiles: string[];
  usedStash: boolean;
}

export function getEngineRoot(): string {
  return ENGINE_ROOT;
}

function runCommand(command: string[], cwd: string): CommandResult {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
    exitCode: result.exitCode,
  };
}

function requireSuccess(command: string[], cwd: string, failure: string): string {
  const result = runCommand(command, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`${failure}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
  }
  return result.stdout;
}

function ensureGitRepo(repoDir: string): void {
  requireSuccess(["git", "rev-parse", "--is-inside-work-tree"], repoDir, "Engine checkout is not a git repository");
}

export function hasUncommittedChanges(repoDir: string): boolean {
  const status = requireSuccess(["git", "status", "--porcelain"], repoDir, "Failed to inspect git status");
  return status.length > 0;
}

function getStashRef(repoDir: string): string | null {
  const stash = runCommand(["git", "rev-parse", "--verify", "refs/stash"], repoDir);
  if (stash.exitCode !== 0 || !stash.stdout) return null;
  return stash.stdout;
}

function stashLocalChanges(repoDir: string): boolean {
  const before = getStashRef(repoDir);
  requireSuccess(
    ["git", "stash", "push", "--include-untracked", "--message", "nyxhive update auto-stash"],
    repoDir,
    "Failed to stash local engine changes",
  );
  const after = getStashRef(repoDir);
  return after !== before;
}

function restoreStashedChanges(repoDir: string, checkoutChanged: boolean): void {
  const result = runCommand(["git", "stash", "pop"], repoDir);
  if (result.exitCode === 0) return;

  const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
  const prefix = checkoutChanged
    ? "Engine updated, but failed to reapply stashed local changes"
    : "Failed to reapply stashed local changes";
  throw new Error(`${prefix}: ${detail}. Your stash entry was kept; resolve it manually with \`git stash list\`.`);
}

export function getCurrentBranch(repoDir: string): string {
  const branch = requireSuccess(["git", "rev-parse", "--abbrev-ref", "HEAD"], repoDir, "Failed to resolve current branch");
  if (branch === "HEAD") {
    throw new Error("Engine checkout is in detached HEAD state. Check out a branch before running nyxhive update.");
  }
  return branch;
}

export function getCurrentVersion(repoDir: string, ref = "HEAD"): string {
  return requireSuccess(["git", "rev-parse", "--short", ref], repoDir, `Failed to resolve git version for ${ref}`);
}

export function resolveTrackingRef(repoDir: string): string {
  const upstream = runCommand(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repoDir);
  if (upstream.exitCode === 0 && upstream.stdout) {
    return upstream.stdout;
  }

  const remoteHead = runCommand(["git", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoDir);
  if (remoteHead.exitCode === 0 && remoteHead.stdout) {
    return remoteHead.stdout;
  }

  throw new Error("Engine checkout has no upstream tracking branch. Set one or pass --repo to a standard NyxHive clone.");
}

export function getCommitDistance(repoDir: string, trackingRef: string): { ahead: number; behind: number } {
  const counts = requireSuccess(
    ["git", "rev-list", "--left-right", "--count", `HEAD...${trackingRef}`],
    repoDir,
    `Failed to compare HEAD with ${trackingRef}`,
  ).split(/\s+/);

  return {
    ahead: Number.parseInt(counts[0] ?? "0", 10) || 0,
    behind: Number.parseInt(counts[1] ?? "0", 10) || 0,
  };
}

export function getChangedDependencyFiles(repoDir: string, fromRef: string, toRef: string): string[] {
  if (fromRef === toRef) return [];

  const diff = requireSuccess(
    ["git", "diff", "--name-only", fromRef, toRef, "--", ...DEPENDENCY_FILES],
    repoDir,
    "Failed to inspect dependency changes",
  );

  return diff ? diff.split("\n").map(line => line.trim()).filter(Boolean) : [];
}

export async function updateEngine(options: EngineUpdateOptions = {}): Promise<EngineUpdateResult> {
  const repoDir = resolve(options.repoDir ?? ENGINE_ROOT);
  ensureGitRepo(repoDir);
  const branch = getCurrentBranch(repoDir);
  const startingVersion = getCurrentVersion(repoDir);
  const dirty = hasUncommittedChanges(repoDir);

  requireSuccess(["git", "fetch", "--all", "--tags", "--prune"], repoDir, "Failed to fetch engine updates");

  const trackingRef = resolveTrackingRef(repoDir);
  const targetVersion = getCurrentVersion(repoDir, trackingRef);
  const { ahead, behind } = getCommitDistance(repoDir, trackingRef);

  if (ahead > 0 && behind > 0) {
    throw new Error(`Engine checkout has diverged from ${trackingRef}. Reconcile it manually before updating.`);
  }

  if (behind === 0) {
    return {
      repoDir,
      branch,
      trackingRef,
      startingVersion,
      targetVersion,
      finalVersion: startingVersion,
      ahead,
      behind,
      status: "up-to-date",
      dependenciesInstalled: false,
      dependencyFiles: [],
      usedStash: false,
    };
  }

  if (options.check || options.dryRun) {
    return {
      repoDir,
      branch,
      trackingRef,
      startingVersion,
      targetVersion,
      finalVersion: startingVersion,
      ahead,
      behind,
      status: "update-available",
      dependenciesInstalled: false,
      dependencyFiles: [],
      usedStash: false,
    };
  }

  if (dirty && !options.stash) {
    throw new Error("Engine checkout has local changes. Commit, stash, or rerun with --stash before applying updates.");
  }

  const usedStash = dirty ? stashLocalChanges(repoDir) : false;
  let checkoutChanged = false;

  try {
    if (usedStash && hasUncommittedChanges(repoDir)) {
      throw new Error("Failed to clean engine checkout after stashing local changes.");
    }

    requireSuccess(["git", "merge", "--ff-only", trackingRef], repoDir, `Failed to fast-forward engine checkout to ${trackingRef}`);
    checkoutChanged = true;

    const dependencyFiles = getChangedDependencyFiles(repoDir, startingVersion, targetVersion);
    let dependenciesInstalled = false;

    if (dependencyFiles.length > 0 && existsSync(resolve(repoDir, "package.json"))) {
      requireSuccess(["bun", "install", "--frozen-lockfile"], repoDir, "bun install failed after engine update");
      dependenciesInstalled = true;
    }

    return {
      repoDir,
      branch,
      trackingRef,
      startingVersion,
      targetVersion,
      finalVersion: getCurrentVersion(repoDir),
      ahead,
      behind,
      status: "updated",
      dependenciesInstalled,
      dependencyFiles,
      usedStash,
    };
  } finally {
    if (usedStash) {
      restoreStashedChanges(repoDir, checkoutChanged);
    }
  }
}

function printUsage(): void {
  logger.info(`
  Usage: nyxhive update [options]

  Options:
    --check             Check if engine updates are available
    --dry-run           Show what would update without changing the repo
    --stash             Auto-stash local changes before applying updates
    --repo <dir>        Update a specific NyxHive engine checkout
`);
}

export async function handleUpdate(args = process.argv.slice(3)): Promise<void> {
  let repoDir: string | undefined;
  let check = false;
  let dryRun = false;
  let stash = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--stash") {
      stash = true;
    } else if (arg === "--repo" && i + 1 < args.length) {
      repoDir = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      return;
    } else {
      logger.error(`Unknown option: ${arg}`);
      printUsage();
      process.exit(1);
    }
  }

  const result = await updateEngine({ repoDir, check, dryRun, stash });

  logger.info(`
  NyxHive Engine Update
  ────────────────────
  Repo:     ${result.repoDir}
  Branch:   ${result.branch}
  Tracking: ${result.trackingRef}
  Local:    ${result.startingVersion}
  Remote:   ${result.targetVersion}
`);

  if (result.status === "up-to-date") {
    logger.info("  Engine already up to date.");
    return;
  }

  if (result.status === "update-available") {
    logger.info(`  Update available (${result.behind} commit${result.behind === 1 ? "" : "s"} behind).`);
    logger.info(`  ${check ? "Run `nyxhive update` to apply it." : "Dry run only — no changes applied."}`);
    return;
  }

  logger.info(`  Updated:  ${result.startingVersion} -> ${result.finalVersion}`);
  if (result.usedStash) {
    logger.info("  Local changes were auto-stashed and restored.");
  }
  if (result.dependenciesInstalled) {
    logger.info(`  Deps:     bun install (${result.dependencyFiles.join(", ")})`);
  } else {
    logger.info("  Deps:     unchanged");
  }
}

if (import.meta.main) {
  await handleUpdate(process.argv.slice(2));
}

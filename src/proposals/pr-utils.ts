import { cleanupWorktree } from "../agents/worktree.js";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const GH_FALLBACK_PATHS = [
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/usr/bin/gh",
];

function pathHasExecutable(command: string, pathValue: string): boolean {
  return pathValue
    .split(delimiter)
    .filter(Boolean)
    .some(dir => isExecutable(join(dir, command)));
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveGhCommand(
  pathValue = process.env.PATH ?? "",
  fallbackPaths = GH_FALLBACK_PATHS,
): string {
  if (pathHasExecutable("gh", pathValue)) return "gh";
  return fallbackPaths.find(path => isExecutable(path)) ?? "gh";
}

/** Build env with GH_TOKEN forwarded for gh CLI auth */
function ghEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  const ghToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (ghToken) env.GH_TOKEN = ghToken;
  return env;
}

/** Build env using GH_MERGE_TOKEN (repo owner's token) for merge operations, falls back to ghEnv */
function ghMergeEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  const mergeToken = process.env.GH_MERGE_TOKEN;
  if (mergeToken) {
    env.GH_TOKEN = mergeToken;
    return env;
  }
  return ghEnv();
}

/** Extract GitHub PR URL from agent response text */
export function extractPrUrl(text: string): string | null {
  const match = text.match(/https:\/\/github\.com\/[^\/\s]+\/[^\/\s]+\/pull\/\d+/);
  return match ? match[0] : null;
}

/** Build branch name from proposal ID: proposal-a1b2c3d4 → proposal/a1b2c3d4 */
export function proposalBranchName(proposalId: string): string {
  const shortId = proposalId.replace("proposal-", "");
  return `proposal/${shortId}`;
}

/** Batch execution refs look like `batch-mnufcv98-proposal-a1b2c3d4`. */
export function proposalBatchIdFromExecutionRef(executionRef?: string | null): string | null {
  return executionRef?.match(/^(batch-[a-z0-9]+)-proposal-/i)?.[1] ?? null;
}

export function proposalPrBranchName(proposalId: string, executionRef?: string | null): string {
  const batchId = proposalBatchIdFromExecutionRef(executionRef);
  return batchId ? `proposal/${batchId}` : proposalBranchName(proposalId);
}

/** Check if a GitHub PR is already merged. Returns true/false, or null on error. */
export function checkPrMerged(prNumber: string, repoPath: string): boolean | null {
  const state = checkPrState(prNumber, repoPath);
  if (state === null) return null;
  return state === "MERGED";
}

/** PR state as reported by GitHub: OPEN, MERGED, or CLOSED */
export type PrState = "OPEN" | "MERGED" | "CLOSED";

/** Create a GitHub PR for a proposal branch. Returns the PR URL or null on failure. */
export function createPrForBranch(
  branch: string,
  title: string,
  proposalId: string,
  repoPath: string,
): string | null {
  const gh = resolveGhCommand();
  const lsRemote = Bun.spawnSync(
    ["git", "ls-remote", "--heads", "origin", branch],
    { cwd: repoPath },
  );
  if (lsRemote.exitCode !== 0 || !lsRemote.stdout.toString().trim()) {
    return null;
  }

  const result = Bun.spawnSync(
    [gh, "pr", "create", "--title", title, "--body", `Implements proposal ${proposalId}`, "--head", branch],
    { cwd: repoPath, env: ghEnv() },
  );
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    if (stderr.includes("already exists")) {
      const view = Bun.spawnSync(
        [gh, "pr", "view", branch, "--json", "url"],
        { cwd: repoPath, env: ghEnv() },
      );
      if (view.exitCode === 0) {
        try {
          return JSON.parse(view.stdout.toString()).url ?? null;
        } catch { return null; }
      }
    }
    return null;
  }

  return extractPrUrl(result.stdout.toString());
}

/** Get the full PR state from GitHub. Returns null on error. */
export function checkPrState(prNumber: string, repoPath: string): PrState | null {
  try {
    const result = Bun.spawnSync(
      [resolveGhCommand(), "pr", "view", prNumber, "--json", "state"],
      { cwd: repoPath, env: ghEnv() },
    );
    if (result.exitCode !== 0) return null;
    const data = JSON.parse(result.stdout.toString());
    return data.state as PrState ?? null;
  } catch {
    return null;
  }
}

/** PR mergeability as reported by GitHub */
export type PrMergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** Check if a PR is mergeable (no conflicts). Returns null on error. */
export function checkPrMergeable(prNumber: string, repoPath: string): PrMergeable | null {
  try {
    const result = Bun.spawnSync(
      [resolveGhCommand(), "pr", "view", prNumber, "--json", "mergeable"],
      { cwd: repoPath, env: ghEnv() },
    );
    if (result.exitCode !== 0) return null;
    const data = JSON.parse(result.stdout.toString());
    return (data.mergeable as PrMergeable) ?? null;
  } catch {
    return null;
  }
}

/** Close a GitHub PR without merging. Returns true on success. */
export function closePr(prNumber: string, repoPath: string): boolean {
  const result = Bun.spawnSync(
    [resolveGhCommand(), "pr", "close", prNumber, "--delete-branch"],
    { cwd: repoPath, env: ghEnv() },
  );
  return result.exitCode === 0;
}

export function cleanupProposalBranchWorktree(branch: string, repoPath: string): string | null {
  const ref = `refs/heads/${branch}`;
  try {
    const listResult = Bun.spawnSync(
      ["git", "worktree", "list", "--porcelain"],
      { cwd: repoPath },
    );
    if (listResult.exitCode === 0) {
      let currentPath: string | null = null;
      let currentBranch: string | null = null;
      for (const line of listResult.stdout.toString().split("\n")) {
        if (!line.trim()) {
          if (currentPath && currentBranch === ref) {
            const result = cleanupWorktree(repoPath, currentPath, branch);
            if (!result.ok) return result.error ?? `Failed to remove worktree for ${branch}`;
            return null;
          }
          currentPath = null;
          currentBranch = null;
          continue;
        }
        if (line.startsWith("worktree ")) {
          currentPath = line.slice("worktree ".length);
          continue;
        }
        if (line.startsWith("branch ")) {
          currentBranch = line.slice("branch ".length);
        }
      }
      if (currentPath && currentBranch === ref) {
        const result = cleanupWorktree(repoPath, currentPath, branch);
        if (!result.ok) return result.error ?? `Failed to remove worktree for ${branch}`;
        return null;
      }
    }
  } catch {
    // Fall back to branch deletion below.
  }

  // No worktree found, just delete the branch
  const result = cleanupWorktree(repoPath, "", branch);
  if (!result.ok) return result.error ?? `Failed to delete branch ${branch}`;
  return null;
}

export function mergePrAndCleanup(
  prNumber: string,
  branch: string,
  repoPath: string,
): { ok: true; alreadyMerged: boolean } | { ok: false; error: string } {
  if (checkPrMerged(prNumber, repoPath)) {
    const cleanupError = cleanupProposalBranchWorktree(branch, repoPath);
    if (cleanupError) return { ok: false, error: `PR already merged but cleanup failed: ${cleanupError}` };
    return { ok: true, alreadyMerged: true };
  }

  const result = Bun.spawnSync(
    [resolveGhCommand(), "pr", "merge", prNumber, "--merge", "--delete-branch"],
    { cwd: repoPath, env: ghMergeEnv() },
  );

  if (result.exitCode === 0) {
    return { ok: true, alreadyMerged: false };
  }

  const stderr = result.stderr.toString().trim();
  if (stderr.includes("already been merged") || checkPrMerged(prNumber, repoPath)) {
    const cleanupError = cleanupProposalBranchWorktree(branch, repoPath);
    if (cleanupError) return { ok: false, error: `PR merged but cleanup failed: ${cleanupError}` };
    return { ok: true, alreadyMerged: true };
  }

  if (/401 Unauthorized|Bad credentials/i.test(stderr)) {
    return { ok: false, error: "GitHub merge auth failed. Check GH_MERGE_TOKEN." };
  }

  return { ok: false, error: `Merge failed: ${stderr}` };
}

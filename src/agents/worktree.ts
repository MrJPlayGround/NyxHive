import { existsSync } from "node:fs";
import { logger } from "../utils/logger.js";

export type WorktreeEntry = {
  path: string;
  branch: string | null;
};

export interface WorktreeResult {
  path: string;
  branch: string;
}

/** Create a git worktree with a new branch. Returns null on failure. */
export function createWorktree(repoPath: string, branchName: string): WorktreeResult | null {
  const shortId = branchName.replace(/\//g, "-");
  const worktreePath = `/tmp/nyxhive-wt-${shortId}-${Date.now()}`;

  const result = Bun.spawnSync(
    ["git", "worktree", "add", "-b", branchName, worktreePath, "HEAD"],
    { cwd: repoPath },
  );

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    logger.error(`[worktree] Failed to create worktree ${branchName}: ${stderr}`);
    return null;
  }

  logger.info(`[worktree] Created worktree at ${worktreePath} on branch ${branchName}`);
  return { path: worktreePath, branch: branchName };
}

/** Remove a worktree and delete its branch. */
export function cleanupWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): { ok: boolean; error?: string } {
  if (worktreePath) {
    const removeResult = Bun.spawnSync(
      ["git", "worktree", "remove", "--force", worktreePath],
      { cwd: repoPath },
    );
    if (removeResult.exitCode !== 0) {
      const err = removeResult.stderr.toString().trim();
      return { ok: false, error: `Failed to remove worktree: ${err}` };
    }
  }

  if (branch) {
    const deleteBranch = Bun.spawnSync(
      ["git", "branch", "-D", branch],
      { cwd: repoPath },
    );
    if (deleteBranch.exitCode !== 0) {
      const stderr = deleteBranch.stderr.toString().trim();
      if (!stderr.includes("not found")) {
        return { ok: false, error: `Failed to delete branch: ${stderr}` };
      }
    }
  }

  logger.info(`[worktree] Cleaned up worktree ${worktreePath} and branch ${branch}`);
  return { ok: true };
}

/** List all worktrees for a repo. */
export function listWorktrees(repoPath: string): WorktreeEntry[] {
  if (!existsSync(repoPath)) {
    logger.warn(`[worktree] Skipping worktree scan; repo path does not exist: ${repoPath}`);
    return [];
  }

  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(
      ["git", "worktree", "list", "--porcelain"],
      { cwd: repoPath },
    );
  } catch (err) {
    logger.warn(`[worktree] Failed to list worktrees for ${repoPath}: ${err}`);
    return [];
  }

  if (result.exitCode !== 0) return [];

  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;
  const output = result.stdout?.toString() ?? "";

  for (const line of output.split("\n")) {
    if (!line.trim()) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
      continue;
    }
    if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** Clean up stale worktrees from /tmp. Run at startup. */
export function cleanupStaleWorktrees(repoPath: string, activeProposalIds?: Set<string>): void {
  const worktrees = listWorktrees(repoPath);
  for (const wt of worktrees) {
    if (!wt.path.startsWith("/tmp/nyxhive-wt-")) continue;

    if (activeProposalIds && wt.branch) {
      const branchShort = wt.branch.replace("refs/heads/", "");
      const proposalId = `proposal-${branchShort.replace("proposal/", "")}`;
      if (activeProposalIds.has(proposalId)) continue;
    }

    logger.info(`[worktree] Cleaning up stale worktree: ${wt.path}`);
    const branch = wt.branch?.replace("refs/heads/", "");
    cleanupWorktree(repoPath, wt.path, branch ?? "");
  }
}

import { describe, it, expect, afterAll } from "bun:test";
import { createWorktree, cleanupWorktree, listWorktrees } from "../agents/worktree.js";
import { mkdirSync, existsSync } from "fs";

const testRepoDir = `/tmp/nyxhive-wt-test-${Date.now()}`;

function initTestRepo(): void {
  mkdirSync(testRepoDir, { recursive: true });
  Bun.spawnSync(["git", "init"], { cwd: testRepoDir });
  Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: testRepoDir });
}

afterAll(() => {
  const worktrees = listWorktrees(testRepoDir);
  for (const wt of worktrees) {
    if (wt.path !== testRepoDir) {
      Bun.spawnSync(["git", "worktree", "remove", "--force", wt.path], { cwd: testRepoDir });
    }
  }
  try { Bun.spawnSync(["rm", "-rf", testRepoDir]); } catch {}
});

describe("worktree", () => {
  initTestRepo();

  it("createWorktree creates a worktree at /tmp path with branch", () => {
    const result = createWorktree(testRepoDir, "proposal/test-123");
    expect(result).not.toBeNull();
    expect(result!.path).toStartWith("/tmp/nyxhive-wt-");
    expect(result!.branch).toBe("proposal/test-123");
    expect(existsSync(result!.path)).toBe(true);
    cleanupWorktree(testRepoDir, result!.path, result!.branch);
  });

  it("listWorktrees includes the new worktree", () => {
    const result = createWorktree(testRepoDir, "proposal/list-test");
    const worktrees = listWorktrees(testRepoDir);
    const found = worktrees.find(w => w.branch === "refs/heads/proposal/list-test");
    expect(found).toBeDefined();
    cleanupWorktree(testRepoDir, result!.path, result!.branch);
  });

  it("cleanupWorktree removes worktree and branch", () => {
    const result = createWorktree(testRepoDir, "proposal/cleanup-test");
    expect(existsSync(result!.path)).toBe(true);
    const cleanup = cleanupWorktree(testRepoDir, result!.path, result!.branch);
    expect(cleanup.ok).toBe(true);
    expect(existsSync(result!.path)).toBe(false);
  });

  it("createWorktree returns null if branch already exists", () => {
    const first = createWorktree(testRepoDir, "proposal/dup-test");
    const second = createWorktree(testRepoDir, "proposal/dup-test");
    expect(second).toBeNull();
    cleanupWorktree(testRepoDir, first!.path, first!.branch);
  });

  it("listWorktrees returns empty for a missing repo path", () => {
    expect(listWorktrees("/tmp/nyxhive-missing-repo-path")).toEqual([]);
  });
});

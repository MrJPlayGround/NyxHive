import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { cleanupProposalBranchWorktree, extractPrUrl, mergePrAndCleanup, proposalBatchIdFromExecutionRef, proposalBranchName, proposalPrBranchName, resolveGhCommand } from "./pr-utils.js";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

function spawnResult(exitCode: number, stdout = "", stderr = ""): ReturnType<typeof Bun.spawnSync> {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode,
    success: exitCode === 0,
  } as ReturnType<typeof Bun.spawnSync>;
}

let spawnSyncSpy: ReturnType<typeof spyOn<typeof Bun, "spawnSync">>;

afterEach(() => {
  spawnSyncSpy?.mockRestore();
});

describe("extractPrUrl", () => {
  test("extracts PR URL from surrounding text", () => {
    const text = "Done! See https://github.com/owner/repo/pull/42 for the PR.";
    expect(extractPrUrl(text)).toBe("https://github.com/owner/repo/pull/42");
  });

  test("returns the URL when text is only the URL", () => {
    expect(extractPrUrl("https://github.com/org/project/pull/1")).toBe(
      "https://github.com/org/project/pull/1"
    );
  });

  test("returns null when text contains no PR URL", () => {
    expect(extractPrUrl("No PR here, just some agent output.")).toBeNull();
  });

  test("returns null for non-PR GitHub URLs", () => {
    expect(extractPrUrl("Visit https://github.com/owner/repo")).toBeNull();
  });
});

describe("proposalBranchName", () => {
  test("converts proposal-<id> to proposal/<id>", () => {
    expect(proposalBranchName("proposal-a1b2c3d4")).toBe("proposal/a1b2c3d4");
  });

  test("handles input with no 'proposal-' prefix", () => {
    expect(proposalBranchName("a1b2c3d4")).toBe("proposal/a1b2c3d4");
  });
});

describe("proposalPrBranchName", () => {
  test("extracts batch ids from batch execution refs", () => {
    expect(proposalBatchIdFromExecutionRef("batch-mnufcv98-proposal-a1b2c3d4")).toBe("batch-mnufcv98");
    expect(proposalBatchIdFromExecutionRef("exec-proposal-a1b2c3d4")).toBeNull();
  });

  test("uses individual proposal branches by default", () => {
    expect(proposalPrBranchName("proposal-a1b2c3d4", null)).toBe("proposal/a1b2c3d4");
  });

  test("uses the shared batch branch for batch execution refs", () => {
    expect(proposalPrBranchName("proposal-a1b2c3d4", "batch-mnufcv98-proposal-a1b2c3d4")).toBe("proposal/batch-mnufcv98");
  });
});

describe("resolveGhCommand", () => {
  test("uses gh when it is already visible on PATH", () => {
    const binDir = mkdtempSync(join(tmpdir(), "gh-path-test-"));
    try {
      const ghPath = join(binDir, "gh");
      writeFileSync(ghPath, "");
      chmodSync(ghPath, 0o755);

      expect(resolveGhCommand(`${binDir}${delimiter}/bin`, ["/missing/gh"])).toBe("gh");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  test("falls back to a known absolute gh path when PATH is sparse", () => {
    const binDir = mkdtempSync(join(tmpdir(), "gh-fallback-test-"));
    const ghPath = join(binDir, "gh");
    try {
      writeFileSync(ghPath, "");
      chmodSync(ghPath, 0o755);

      expect(resolveGhCommand("/usr/bin:/bin", [ghPath])).toBe(ghPath);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});

describe("cleanupProposalBranchWorktree", () => {
  test("removes matching worktree before deleting the branch", () => {
    spawnSyncSpy = spyOn(Bun, "spawnSync");
    spawnSyncSpy
      .mockReturnValueOnce(spawnResult(0, [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/master",
        "",
        "worktree /repo-proposal",
        "HEAD def456",
        "branch refs/heads/proposal/abc12345",
        "",
      ].join("\n")))
      .mockReturnValueOnce(spawnResult(0))
      .mockReturnValueOnce(spawnResult(0));

    const error = cleanupProposalBranchWorktree("proposal/abc12345", "/repo");

    expect(error).toBeNull();
    expect(spawnSyncSpy).toHaveBeenNthCalledWith(2, ["git", "worktree", "remove", "--force", "/repo-proposal"], { cwd: "/repo" });
    expect(spawnSyncSpy).toHaveBeenNthCalledWith(3, ["git", "branch", "-D", "proposal/abc12345"], { cwd: "/repo" });
  });
});

describe("mergePrAndCleanup", () => {
  test("treats branch deletion failures after a successful merge as cleanup work", () => {
    spawnSyncSpy = spyOn(Bun, "spawnSync");
    spawnSyncSpy
      .mockReturnValueOnce(spawnResult(0, JSON.stringify({ state: "OPEN" })))
      .mockReturnValueOnce(spawnResult(1, "", "failed to delete local branch proposal/abc12345: cannot delete branch 'proposal/abc12345' used by worktree at '/repo-proposal'"))
      .mockReturnValueOnce(spawnResult(0, JSON.stringify({ state: "MERGED" })))
      .mockReturnValueOnce(spawnResult(0, [
        "worktree /repo",
        "HEAD abc123",
        "branch refs/heads/master",
        "",
        "worktree /repo-proposal",
        "HEAD def456",
        "branch refs/heads/proposal/abc12345",
        "",
      ].join("\n")))
      .mockReturnValueOnce(spawnResult(0))
      .mockReturnValueOnce(spawnResult(0));

    const result = mergePrAndCleanup("42", "proposal/abc12345", "/repo");

    expect(result).toEqual({ ok: true, alreadyMerged: true });
    expect(spawnSyncSpy).toHaveBeenNthCalledWith(2, [resolveGhCommand(), "pr", "merge", "42", "--merge", "--delete-branch"], expect.objectContaining({ cwd: "/repo" }));
    expect(spawnSyncSpy).toHaveBeenNthCalledWith(5, ["git", "worktree", "remove", "--force", "/repo-proposal"], { cwd: "/repo" });
  });

  test("returns a concise auth error when the merge token is bad", () => {
    spawnSyncSpy = spyOn(Bun, "spawnSync");
    spawnSyncSpy
      .mockReturnValueOnce(spawnResult(0, JSON.stringify({ state: "OPEN" })))
      .mockReturnValueOnce(spawnResult(1, "", "non-200 OK status code: 401 Unauthorized body: {\"message\":\"Bad credentials\"}"));

    const result = mergePrAndCleanup("42", "proposal/abc12345", "/repo");

    expect(result).toEqual({
      ok: false,
      error: "GitHub merge auth failed. Check GH_MERGE_TOKEN.",
    });
  });
});

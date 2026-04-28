import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { ProposalStore } from "../proposals/store.js";
import { ProposalExecutor, type ExecutorContext } from "../proposals/executor.js";
import { resolveGhCommand } from "../proposals/pr-utils.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeStore() {
  const tmpDir = mkdtempSync(join(tmpdir(), "exec-test-"));
  const store = new ProposalStore(tmpDir, "test");
  return { store, tmpDir };
}

function makeContext(overrides?: Partial<ExecutorContext>): ExecutorContext {
  return {
    processImmediate: async () => ({ response: "Done. PR: https://github.com/test/repo/pull/1", agent: "nyx" }),
    resolveProposalAgent: () => "nyx",
    resolveProposalRepoPath: () => "/tmp/repo",
    emit: () => {},
    ...overrides,
  };
}

function spawnResult(exitCode: number, stdout = "", stderr = ""): ReturnType<typeof Bun.spawnSync> {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode,
    success: exitCode === 0,
  } as ReturnType<typeof Bun.spawnSync>;
}

describe("ProposalExecutor", () => {
  let store: ProposalStore;
  let tmpDir: string;
  let spawnSyncSpy: ReturnType<typeof spyOn<typeof Bun, "spawnSync">> | undefined;

  beforeEach(() => {
    const s = makeStore();
    store = s.store;
    tmpDir = s.tmpDir;
  });

  afterEach(() => {
    spawnSyncSpy?.mockRestore();
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("executes proposal on approval when capacity available", async () => {
    const ctx = makeContext();
    const executor = new ProposalExecutor(store, ctx);

    const p = store.create({ title: "Fix bug", description: "Fix it", category: "bugfix", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");

    await executor.onApproved(p.proposal_id, "approval");

    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("completed");
    expect(updated!.pr_url).toBe("https://github.com/test/repo/pull/1");
  });

  test("sets execution_trigger on approval", async () => {
    const ctx = makeContext();
    const executor = new ProposalExecutor(store, ctx);

    const p = store.create({ title: "Add test", description: "Add it", category: "maintenance", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");

    await executor.onApproved(p.proposal_id, "auto");

    const updated = store.get(p.proposal_id);
    expect(updated!.execution_trigger).toBe("auto");
  });

  test("instructs proposal agents to use the repo typecheck script", async () => {
    let taskMessage = "";
    const ctx = makeContext({
      processImmediate: async (opts) => {
        taskMessage = opts.message;
        return { response: "Done. PR: https://github.com/test/repo/pull/1", agent: "nyx" };
      },
    });
    const executor = new ProposalExecutor(store, ctx);

    const p = store.create({ title: "Fix bug", description: "Fix it", category: "bugfix", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");

    await executor.executeProposal(p.proposal_id);

    expect(taskMessage).toContain("`bun run typecheck`");
    expect(taskMessage).not.toContain("bun x tsc --noEmit");
  });

  test("instructs proposal agents to use project-specific verification commands", async () => {
    let taskMessage = "";
    const ctx = makeContext({
      resolveProposalRepoPath: () => tmpDir,
      projects: [{
        name: "Swift app",
        repo_path: tmpDir,
        verify: { build_command: "echo swift build", test_command: "echo swift test" },
      }],
      processImmediate: async (opts) => {
        taskMessage = opts.message;
        return { response: "Done. PR: https://github.com/test/repo/pull/1", agent: "nyx" };
      },
    });
    const executor = new ProposalExecutor(store, ctx);

    const p = store.create({ title: "Fix bug", description: "Fix it", category: "bugfix", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");

    await executor.executeProposal(p.proposal_id);

    expect(taskMessage).toContain("`echo swift build`");
    expect(taskMessage).toContain("`echo swift test`");
    expect(taskMessage).not.toContain("`bun run typecheck`");
    expect(taskMessage).not.toContain("`bun test`");
  });

  test("auto-creates a PR when execution succeeds without returning the URL", async () => {
    spawnSyncSpy = spyOn(Bun, "spawnSync");
    spawnSyncSpy
      .mockReturnValueOnce(spawnResult(1, "", "not a git repository"))  // createWorktree fails → fallback
      .mockReturnValueOnce(spawnResult(0, "abc123\trefs/heads/proposal/1234abcd\n"))  // createPrForBranch: ls-remote
      .mockReturnValueOnce(spawnResult(0, "https://github.com/test/repo/pull/9\n"))   // createPrForBranch: gh pr create
      .mockReturnValueOnce(spawnResult(0, "abc123"))                    // branchHasNewCommits: rev-parse --verify
      .mockReturnValueOnce(spawnResult(0, "000000"))                    // branchHasNewCommits: merge-base
      .mockReturnValueOnce(spawnResult(0, "abc123"));                   // branchHasNewCommits: rev-parse branch

    const ctx = makeContext({
      processImmediate: async () => ({ response: "Done. Changes pushed.", agent: "nyx" }),
    });
    const executor = new ProposalExecutor(store, ctx);

    const p = store.create({ title: "Fix bug", description: "Fix it", category: "bugfix", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");

    await executor.onApproved(p.proposal_id, "approval");

    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("completed");
    expect(updated!.pr_url).toBe("https://github.com/test/repo/pull/9");
    expect(spawnSyncSpy).toHaveBeenNthCalledWith(
      2,
      ["git", "ls-remote", "--heads", "origin", `proposal/${p.proposal_id.replace("proposal-", "")}`],
      { cwd: "/tmp/repo" },
    );
    expect(spawnSyncSpy).toHaveBeenNthCalledWith(
      3,
      [
        resolveGhCommand(),
        "pr",
        "create",
        "--title",
        p.title,
        "--body",
        `Implements proposal ${p.proposal_id}`,
        "--head",
        `proposal/${p.proposal_id.replace("proposal-", "")}`,
      ],
      expect.objectContaining({ cwd: "/tmp/repo" }),
    );
  });

  test("queues proposal when at capacity", async () => {
    let resolveFirst!: () => void;
    const blockingPromise = new Promise<void>(r => { resolveFirst = r; });

    const ctx = makeContext({
      processImmediate: async () => {
        await blockingPromise;
        return { response: "Done. PR: https://github.com/test/repo/pull/1", agent: "nyx" };
      },
    });
    const executor = new ProposalExecutor(store, ctx, { maxConcurrent: 1 });

    const p1 = store.create({ title: "Task 1", description: "First", category: "bugfix", proposed_by: "nyx" });
    store.approve(p1.proposal_id, "jay");

    const p2 = store.create({ title: "Task 2", description: "Second", category: "bugfix", proposed_by: "nyx" });
    store.approve(p2.proposal_id, "jay");

    // Start first execution (blocks)
    const exec1 = executor.onApproved(p1.proposal_id, "approval");

    // Second should be queued (not executed)
    await executor.onApproved(p2.proposal_id, "approval");

    expect(executor.executing).toBe(1);
    const p2Status = store.get(p2.proposal_id);
    expect(p2Status!.status).toBe("approved"); // Still waiting

    // Unblock first
    resolveFirst();
    await exec1;

    // Wait for pickup to complete
    await new Promise(r => setTimeout(r, 50));

    const p2After = store.get(p2.proposal_id);
    expect(p2After!.status).toBe("completed"); // Picked up after first completed
  });

  test("marks proposal failed on execution error", async () => {
    const ctx = makeContext({
      processImmediate: async () => { throw new Error("Agent crashed"); },
    });
    const executor = new ProposalExecutor(store, ctx);

    const p = store.create({ title: "Bad task", description: "Will fail", category: "feature", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");

    await executor.onApproved(p.proposal_id, "manual");

    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("failed");
    expect(updated!.execution_result).toContain("Agent crashed");
  });

  test("hasCapacity reflects current state", () => {
    const ctx = makeContext();
    const executor = new ProposalExecutor(store, ctx, { maxConcurrent: 2 });
    expect(executor.hasCapacity).toBe(true);
    expect(executor.executing).toBe(0);
  });

  test("pickupNext does nothing when no approved proposals", async () => {
    const ctx = makeContext();
    const executor = new ProposalExecutor(store, ctx);
    await executor.pickupNext(); // Should not throw
  });

  test("pickupNext picks oldest approved proposal (FIFO)", async () => {
    const executionOrder: string[] = [];
    const ctx = makeContext({
      processImmediate: async (opts) => {
        const match = opts.message.match(/proposal-([\da-f]+)/);
        if (match) executionOrder.push(match[0]);
        return { response: "Done. PR: https://github.com/test/repo/pull/1", agent: "nyx" };
      },
    });
    const executor = new ProposalExecutor(store, ctx, { maxConcurrent: 1 });

    const p1 = store.create({ title: "First", description: "First", category: "bugfix", proposed_by: "nyx" });
    store.approve(p1.proposal_id, "jay");
    const p2 = store.create({ title: "Second", description: "Second", category: "bugfix", proposed_by: "nyx" });
    store.approve(p2.proposal_id, "jay");

    // Execute first directly
    await executor.executeProposal(p1.proposal_id);

    // Pickup should have grabbed p2
    await new Promise(r => setTimeout(r, 50));

    expect(executionOrder[0]).toBe(p1.proposal_id);
    expect(executionOrder[1]).toBe(p2.proposal_id);
  });

  test("emits proposal:completed event on success", async () => {
    const events: Array<{ type: string; data: any }> = [];
    const ctx = makeContext({
      emit: (type, data) => events.push({ type, data }),
    });
    const executor = new ProposalExecutor(store, ctx);

    const p = store.create({ title: "Emit test", description: "Test emission", category: "bugfix", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");

    await executor.onApproved(p.proposal_id, "approval");

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("proposal:completed");
    expect(events[0].data.proposal_id).toBe(p.proposal_id);
    expect(events[0].data.pr_url).toBe("https://github.com/test/repo/pull/1");
  });

  test("atomic markExecuting prevents double execution", async () => {
    const ctx = makeContext();
    const executor = new ProposalExecutor(store, ctx);

    const p = store.create({ title: "Race", description: "Race condition", category: "bugfix", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");

    // Manually mark as executing before executor tries
    store.markExecuting(p.proposal_id, "other-ref");

    // Executor should fail to claim
    await executor.executeProposal(p.proposal_id);

    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("executing"); // Still executing (from manual claim)
    expect(updated!.execution_ref).toBe("other-ref");
  });
});

describe("ProposalStore.execution_trigger", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    const s = makeStore();
    store = s.store;
    tmpDir = s.tmpDir;
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("execution_trigger defaults to null", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "bugfix", proposed_by: "nyx" });
    expect(p.execution_trigger).toBeNull();
  });

  test("setExecutionTrigger updates the field", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "bugfix", proposed_by: "nyx" });
    store.setExecutionTrigger(p.proposal_id, "auto");
    const updated = store.get(p.proposal_id);
    expect(updated!.execution_trigger).toBe("auto");
  });

  test("setExecutionTrigger supports all trigger types", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "bugfix", proposed_by: "nyx" });

    store.setExecutionTrigger(p.proposal_id, "approval");
    expect(store.get(p.proposal_id)!.execution_trigger).toBe("approval");

    store.setExecutionTrigger(p.proposal_id, "manual");
    expect(store.get(p.proposal_id)!.execution_trigger).toBe("manual");

    store.setExecutionTrigger(p.proposal_id, "auto");
    expect(store.get(p.proposal_id)!.execution_trigger).toBe("auto");
  });
});

describe("ProposalExecutor — review gate retry", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    const s = makeStore();
    store = s.store;
    tmpDir = s.tmpDir;
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("passes through when review gate returns PASS", async () => {
    const ctx = makeContext({
      runReview: async () => ({ verdict: "pass", summary: "All good", issues: [], raw: "", attempts: 1 }),
    });
    const executor = new ProposalExecutor(store, ctx);

    const p = store.create({ title: "Review pass", description: "Should pass", category: "bugfix", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    await executor.onApproved(p.proposal_id, "approval");

    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("completed");
  });

  test("retries on FAIL and succeeds on second attempt", async () => {
    let callCount = 0;
    const ctx = makeContext({
      processImmediate: async () => {
        callCount++;
        return { response: `Attempt ${callCount}. PR: https://github.com/test/repo/pull/1`, agent: "nyx" };
      },
      runReview: async () => {
        // FAIL on first, PASS on retry
        if (callCount <= 1) {
          return { verdict: "fail", summary: "Tests missing", issues: ["No tests"], raw: "", attempts: 1 };
        }
        return { verdict: "pass", summary: "Fixed", issues: [], raw: "", attempts: 2 };
      },
    });
    const executor = new ProposalExecutor(store, ctx, { maxRetries: 1 });

    const p = store.create({ title: "Retry test", description: "Needs retry", category: "bugfix", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    await executor.onApproved(p.proposal_id, "approval");

    expect(callCount).toBe(2);
    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("completed");
  });

  test("marks failed after retry still FAILs", async () => {
    const ctx = makeContext({
      runReview: async () => ({ verdict: "fail", summary: "Still broken", issues: ["Tests fail"], raw: "", attempts: 1 }),
    });
    const executor = new ProposalExecutor(store, ctx, { maxRetries: 1 });

    const p = store.create({ title: "Double fail", description: "Will fail twice", category: "bugfix", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    await executor.onApproved(p.proposal_id, "approval");

    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("failed");
    expect(updated!.execution_result).toContain("Review gate failed after retry");
  });

  test("skips retry when maxRetries is 0", async () => {
    let reviewCalls = 0;
    const ctx = makeContext({
      runReview: async () => {
        reviewCalls++;
        return { verdict: "fail", summary: "Broken", issues: [], raw: "", attempts: 1 };
      },
    });
    const executor = new ProposalExecutor(store, ctx, { maxRetries: 0 });

    const p = store.create({ title: "No retry", description: "No retries", category: "bugfix", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    await executor.onApproved(p.proposal_id, "approval");

    expect(reviewCalls).toBe(1);
    // FAIL with maxRetries=0 still completes (no retry loop entered)
    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("completed");
  });

  test("WARN verdict does not trigger retry", async () => {
    let callCount = 0;
    const ctx = makeContext({
      processImmediate: async () => {
        callCount++;
        return { response: "Done. PR: https://github.com/test/repo/pull/1", agent: "nyx" };
      },
      runReview: async () => ({ verdict: "warn", summary: "Minor concern", issues: ["Style nit"], raw: "", attempts: 1 }),
    });
    const executor = new ProposalExecutor(store, ctx, { maxRetries: 1 });

    const p = store.create({ title: "Warn test", description: "Minor issues", category: "bugfix", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    await executor.onApproved(p.proposal_id, "approval");

    expect(callCount).toBe(1); // Only one call, no retry
    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("completed");
  });

  test("works normally without runReview in context", async () => {
    const ctx = makeContext(); // No runReview
    const executor = new ProposalExecutor(store, ctx);

    const p = store.create({ title: "No review", description: "No gate", category: "bugfix", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    await executor.onApproved(p.proposal_id, "approval");

    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("completed");
  });
});

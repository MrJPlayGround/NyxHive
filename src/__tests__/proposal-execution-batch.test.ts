import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ProposalExecutor, type ExecutorContext } from "../proposals/executor.js";
import { ProposalStore } from "../proposals/store.js";

function makeStore() {
  const tmpDir = mkdtempSync(join(tmpdir(), "exec-batch-test-"));
  const store = new ProposalStore(tmpDir, "test");
  return { store, tmpDir };
}

function makeContext(overrides?: Partial<ExecutorContext>): ExecutorContext {
  return {
    processImmediate: async () => ({ response: "Done. Changes committed.", agent: "nyx" }),
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

describe("ProposalExecutor batch execution", () => {
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

  test("emits the shared PR URL for bundled proposal execution", async () => {
    spawnSyncSpy = spyOn(Bun, "spawnSync");
    spawnSyncSpy
      .mockReturnValueOnce(spawnResult(0)) // createWorktree
      .mockReturnValueOnce(spawnResult(0)) // git push
      .mockReturnValueOnce(spawnResult(0, "abc123\trefs/heads/proposal/batch-1\n")) // ls-remote
      .mockReturnValueOnce(spawnResult(0, "https://github.com/test/repo/pull/99\n")); // gh pr create

    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const taskMessages: string[] = [];
    const ctx = makeContext({
      emit: (type, data) => events.push({ type, data }),
      processImmediate: async (opts) => {
        taskMessages.push(opts.message);
        return { response: "Done. Changes committed.", agent: "nyx" };
      },
    });
    const executor = new ProposalExecutor(store, ctx);

    const p1 = store.create({ title: "Fix A", description: "Fix A", category: "bugfix", proposed_by: "nyx" });
    const p2 = store.create({ title: "Fix B", description: "Fix B", category: "bugfix", proposed_by: "nyx" });
    store.approve(p1.proposal_id, "jay");
    store.approve(p2.proposal_id, "jay");

    await executor.executeAll(true);

    expect(events).toHaveLength(2);
    expect(events).toEqual([
      expect.objectContaining({
        type: "proposal:completed",
        data: expect.objectContaining({
          proposal_id: p1.proposal_id,
          pr_url: "https://github.com/test/repo/pull/99",
        }),
      }),
      expect.objectContaining({
        type: "proposal:completed",
        data: expect.objectContaining({
          proposal_id: p2.proposal_id,
          pr_url: "https://github.com/test/repo/pull/99",
        }),
      }),
    ]);

    expect(store.get(p1.proposal_id)?.pr_url).toBe("https://github.com/test/repo/pull/99");
    expect(store.get(p2.proposal_id)?.pr_url).toBe("https://github.com/test/repo/pull/99");
    expect(taskMessages).toHaveLength(2);
    expect(taskMessages.every(message => message.includes("`bun run typecheck`"))).toBe(true);
    expect(taskMessages.every(message => !message.includes("bun x tsc --noEmit"))).toBe(true);
  });
});

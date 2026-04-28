import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ProposalStore } from "./store.js";

describe("ProposalStore — markCompleted PR execution path", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(`${tmpdir()}/nyxhive-test-`);
    store = new ProposalStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true });
  });

  function makeProposal() {
    return store.create({
      title: "Test proposal",
      description: "Test description",
      category: "improvement",
      proposed_by: "test-agent",
    });
  }

  test("success path — stores pr_url and sets status to completed", () => {
    const proposal = makeProposal();
    const prUrl = "https://github.com/owner/repo/pull/99";

    store.markCompleted(proposal.proposal_id, "Agent finished the work", "agent", prUrl);

    const updated = store.get(proposal.proposal_id)!;
    expect(updated.status).toBe("completed");
    expect(updated.pr_url).toBe(prUrl);
  });

  test("success path — execution_result and executed_by are stored", () => {
    const proposal = makeProposal();
    const prUrl = "https://github.com/owner/repo/pull/100";

    store.markCompleted(proposal.proposal_id, "All tests pass", "agent-x", prUrl);

    const updated = store.get(proposal.proposal_id)!;
    expect(updated.execution_result).toBe("All tests pass");
    expect(updated.executed_by).toBe("agent-x");
  });

  test("failure path — marks as failed when result contains REFUSED and no PR", () => {
    const proposal = makeProposal();

    store.markCompleted(
      proposal.proposal_id,
      "REFUSED to execute: wrong working directory",
      "agent"
    );

    const updated = store.get(proposal.proposal_id)!;
    expect(updated.status).toBe("failed");
    expect(updated.pr_url).toBeNull();
  });

  test("failure path — marks as failed for each soft-failure marker", () => {
    const markers = [
      "REFUSED",
      "BLOCKED",
      "WRONG WORKING DIRECTORY",
      "CANNOT EXECUTE",
      "INVALID ROUTING",
      "NO APPLICABLE CODE",
    ];

    for (const marker of markers) {
      const proposal = makeProposal();
      store.markCompleted(proposal.proposal_id, `Agent said: ${marker}`, "agent");
      const updated = store.get(proposal.proposal_id)!;
      expect(updated.status).toBe("failed");
    }
  });

  test("failure path — failure markers are caught even when prUrl is present", () => {
    const proposal = makeProposal();
    const prUrl = "https://github.com/owner/repo/pull/101";

    // If a failure marker is present, mark as failed regardless of PR URL
    store.markCompleted(proposal.proposal_id, "REFUSED initially but recovered", "agent", prUrl);

    const updated = store.get(proposal.proposal_id)!;
    expect(updated.status).toBe("failed");
  });

  test("setPrUrl updates pr_url on a completed proposal", () => {
    const proposal = makeProposal();
    store.approve(proposal.proposal_id, "tester");
    store.markExecuting(proposal.proposal_id, "exec-1");
    store.markCompleted(proposal.proposal_id, "done", "agent");

    const prUrl = "https://github.com/owner/repo/pull/42";
    store.setPrUrl(proposal.proposal_id, prUrl);

    const updated = store.get(proposal.proposal_id)!;
    expect(updated.pr_url).toBe(prUrl);
    expect(updated.verdict).toBeNull();
  });
});

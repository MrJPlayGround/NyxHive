import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ProposalStore } from "../proposals/store.js";
import { parseAgentActions } from "../agents/actor.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeStore() {
  const tmpDir = mkdtempSync(join(tmpdir(), "batch-test-"));
  const store = new ProposalStore(tmpDir, "test");
  return { store, tmpDir };
}

describe("ProposalStore batch operations", () => {
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

  // --- batchApprove ---

  test("batchApprove — approve all proposed proposals", () => {
    store.create({ title: "Fix A", description: "Fix A desc", category: "bugfix", proposed_by: "scout" });
    store.create({ title: "Fix B", description: "Fix B desc", category: "maintenance", proposed_by: "scout" });
    store.create({ title: "Fix C", description: "Fix C desc", category: "feature", proposed_by: "scout" });

    const result = store.batchApprove({ approvedBy: "jay" });

    expect(result.count).toBe(3);
    expect(result.ids).toHaveLength(3);

    for (const id of result.ids) {
      const p = store.get(id);
      expect(p!.status).toBe("approved");
      expect(p!.approved_by).toBe("jay");
    }
  });

  test("batchApprove — filter by category", () => {
    store.create({ title: "Fix A", description: "Fix A desc", category: "bugfix", proposed_by: "scout" });
    store.create({ title: "Improve B", description: "Improve desc", category: "maintenance", proposed_by: "scout" });
    store.create({ title: "Feature C", description: "Feature desc", category: "feature", proposed_by: "scout" });

    const result = store.batchApprove({ category: "bugfix", approvedBy: "jay" });

    expect(result.count).toBe(1);

    // Others remain proposed
    const all = store.list();
    const proposed = all.filter(p => p.status === "proposed");
    expect(proposed).toHaveLength(2);
  });

  test("batchApprove — filter by autonomy", () => {
    store.create({ title: "Auto fix", description: "Auto desc", category: "maintenance", proposed_by: "scout", autonomy: "auto" });
    store.create({ title: "Manual fix", description: "Manual desc", category: "feature", proposed_by: "scout", autonomy: "requires_approval" });

    const result = store.batchApprove({ maxAutonomy: "auto", approvedBy: "jay" });

    expect(result.count).toBe(1);
    const p = store.get(result.ids[0]);
    expect(p!.title).toBe("Auto fix");
  });

  test("batchApprove — skips non-proposed proposals", () => {
    const p = store.create({ title: "Fix A", description: "Fix desc", category: "bugfix", proposed_by: "scout" });
    store.approve(p.proposal_id, "jay");

    const result = store.batchApprove({ approvedBy: "jay" });
    expect(result.count).toBe(0);
  });

  test("batchApprove — returns empty when no matches", () => {
    const result = store.batchApprove({ category: "bugfix", approvedBy: "jay" });
    expect(result.count).toBe(0);
    expect(result.ids).toHaveLength(0);
  });

  // --- batchReject ---

  test("batchReject — reject all proposed proposals", () => {
    store.create({ title: "Fix A", description: "Fix A desc", category: "bugfix", proposed_by: "scout" });
    store.create({ title: "Fix B", description: "Fix B desc", category: "maintenance", proposed_by: "scout" });

    const result = store.batchReject({ reason: "Cleaning up stale proposals" });

    expect(result.count).toBe(2);
    for (const id of result.ids) {
      const p = store.get(id);
      expect(p!.status).toBe("rejected");
      expect(p!.rejection_reason).toBe("Cleaning up stale proposals");
    }
  });

  test("batchReject — filter by category", () => {
    store.create({ title: "Fix A", description: "Fix A desc", category: "bugfix", proposed_by: "scout" });
    store.create({ title: "Improve B", description: "Improve B desc", category: "maintenance", proposed_by: "scout" });

    const result = store.batchReject({ category: "maintenance", reason: "Not needed" });

    expect(result.count).toBe(1);
    const remaining = store.list({ status: "proposed" });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].category).toBe("bugfix");
  });

  test("batchReject — filter by older_than_days", () => {
    // Create a proposal and backdate it
    const old = store.create({ title: "Old fix", description: "Old desc", category: "bugfix", proposed_by: "scout" });
    // Manually set created_at to 10 days ago
    const tenDaysAgoMs = Date.now() - 10 * 24 * 60 * 60 * 1000;
    store["db"].run("UPDATE proposals SET created_at = ? WHERE proposal_id = ?", [tenDaysAgoMs, old.proposal_id]);

    store.create({ title: "New fix", description: "New desc", category: "bugfix", proposed_by: "scout" });

    const result = store.batchReject({ olderThanMs: 7 * 24 * 60 * 60 * 1000, reason: "Stale" });

    expect(result.count).toBe(1);
    expect(result.ids[0]).toBe(old.proposal_id);

    const remaining = store.list({ status: "proposed" });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe("New fix");
  });

  test("batchReject — returns empty when no matches", () => {
    const result = store.batchReject({ category: "bugfix", reason: "test" });
    expect(result.count).toBe(0);
    expect(result.ids).toHaveLength(0);
  });

  // --- batch API response format ---

  test("batch operations return both count and ids", () => {
    const p1 = store.create({ title: "A", description: "A", category: "bugfix", proposed_by: "scout" });
    const p2 = store.create({ title: "B", description: "B", category: "bugfix", proposed_by: "scout" });

    const result = store.batchApprove({ approvedBy: "jay" });

    expect(result.count).toBe(2);
    expect(result.ids).toContain(p1.proposal_id);
    expect(result.ids).toContain(p2.proposal_id);
  });
});

describe("batch management tag parsing", () => {
  test("parses [@batch-approve:] action", () => {
    const text = '[@batch-approve: category=maintenance max_autonomy=auto]';
    const { actions } = parseAgentActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("batch-approve");
    expect(actions[0].params.category).toBe("maintenance");
    expect(actions[0].params.max_autonomy).toBe("auto");
  });

  test("parses [@batch-reject:] action with reason", () => {
    const text = '[@batch-reject: category=maintenance reason="No longer needed" older_than_days=7]';
    const { actions } = parseAgentActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("batch-reject");
    expect(actions[0].params.reason).toBe("No longer needed");
    expect(actions[0].params.older_than_days).toBe("7");
    expect(actions[0].params.category).toBe("maintenance");
  });

  test("strips batch tags from cleaned response", () => {
    const text = 'Cleaning up.\n[@batch-reject: category=maintenance reason="Stale"]\nDone.';
    const { cleanedResponse } = parseAgentActions(text);
    expect(cleanedResponse).not.toContain("[@batch-reject:");
    expect(cleanedResponse).toContain("Cleaning up.");
    expect(cleanedResponse).toContain("Done.");
  });
});

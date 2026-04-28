import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ProposalStore, normalizeWords, jaccardSimilarity } from "../proposals/store.js";
import { classifyAutonomy } from "../proposals/autonomy.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ProposalStore", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-test-"));
    store = new ProposalStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("create returns a proposal with defaults", () => {
    const p = store.create({
      title: "Fix flaky test",
      description: "Replace setTimeout with deterministic mock",
      category: "maintenance",
      proposed_by: "nyx",
    });
    expect(p.proposal_id).toMatch(/^proposal-[a-f0-9]{8}$/);
    expect(p.title).toBe("Fix flaky test");
    expect(p.status).toBe("proposed");
    expect(p.autonomy).toBe("requires_approval");
    expect(p.priority).toBe("medium");
    expect(p.effort).toBe("medium");
    expect(p.files_affected).toEqual([]);
    expect(p.expires_at).toBeGreaterThan(p.created_at);
  });

  test("get returns proposal by proposal_id", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "bugfix", proposed_by: "forge" });
    const fetched = store.get(p.proposal_id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("Test");
  });

  test("get returns null for unknown id", () => {
    expect(store.get("proposal-00000000")).toBeNull();
  });

  test("list returns all proposals", () => {
    store.create({ title: "A", description: "D", category: "maintenance", proposed_by: "nyx" });
    store.create({ title: "B", description: "D", category: "feature", proposed_by: "nyx" });
    expect(store.list()).toHaveLength(2);
  });

  test("list filters by status", () => {
    const p = store.create({ title: "A", description: "D", category: "maintenance", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    expect(store.list({ status: "proposed" })).toHaveLength(0);
    expect(store.list({ status: "approved" })).toHaveLength(1);
  });

  test("list filters by category", () => {
    store.create({ title: "A", description: "D", category: "maintenance", proposed_by: "nyx" });
    store.create({ title: "B", description: "D", category: "feature", proposed_by: "nyx" });
    expect(store.list({ category: "maintenance" })).toHaveLength(1);
  });

  test("listPending returns only requires_approval + proposed", () => {
    store.create({ title: "A", description: "D", category: "maintenance", proposed_by: "nyx", autonomy: "auto" });
    store.create({ title: "B", description: "D", category: "feature", proposed_by: "nyx", autonomy: "requires_approval" });
    expect(store.listPending()).toHaveLength(1);
    expect(store.listPending()[0].title).toBe("B");
  });

  test("approve transitions status and sets approved_by", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "feature", proposed_by: "nyx" });
    const approved = store.approve(p.proposal_id, "jay");
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe("approved");
    expect(approved!.approved_by).toBe("jay");
    expect(approved!.approved_at).toBeGreaterThan(0);
  });

  test("reject transitions status and stores reason", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "feature", proposed_by: "nyx" });
    const rejected = store.reject(p.proposal_id, "Too low priority");
    expect(rejected).not.toBeNull();
    expect(rejected!.status).toBe("rejected");
    expect(rejected!.rejection_reason).toBe("Too low priority");
  });

  test("reject works from reviewing status", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "feature", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    expect(store.get(p.proposal_id)!.status).toBe("reviewing");
    const rejected = store.reject(p.proposal_id, "Changed mind during review");
    expect(rejected).not.toBeNull();
    expect(rejected!.status).toBe("rejected");
    expect(rejected!.rejection_reason).toBe("Changed mind during review");
  });

  test("reject works from reviewed status", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "feature", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    store.saveReview(p.proposal_id, "Looks OK", "analyst");
    expect(store.get(p.proposal_id)!.status).toBe("reviewed");
    const rejected = store.reject(p.proposal_id, "Decided against it after review");
    expect(rejected).not.toBeNull();
    expect(rejected!.status).toBe("rejected");
    expect(rejected!.rejection_reason).toBe("Decided against it after review");
  });

  test("reject does not work from approved status", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "feature", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    const result = store.reject(p.proposal_id, "Too late");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("approved");
  });

  test("reject does not work from executing status", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "feature", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    store.markExecuting(p.proposal_id, "devplan-123");
    const result = store.reject(p.proposal_id, "Too late");
    expect(result).not.toBeNull();
    expect(result!.status).toBe("executing");
  });

  test("markExecuting sets execution_ref", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "maintenance", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    store.markExecuting(p.proposal_id, "devplan-abc123");
    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("executing");
    expect(updated!.execution_ref).toBe("devplan-abc123");
  });

  test("markCompleted transitions status", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "maintenance", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    store.markExecuting(p.proposal_id, "direct");
    store.markCompleted(p.proposal_id);
    expect(store.get(p.proposal_id)!.status).toBe("completed");
  });

  test("markFailed transitions status", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "maintenance", proposed_by: "nyx" });
    store.markExecuting(p.proposal_id, "direct");
    store.markFailed(p.proposal_id);
    expect(store.get(p.proposal_id)!.status).toBe("failed");
  });

  test("expireStale expires old proposed proposals", () => {
    const p = store.create({ title: "Old", description: "D", category: "feature", proposed_by: "nyx" });
    // Manually set expires_at to the past
    store["db"].run("UPDATE proposals SET expires_at = ? WHERE proposal_id = ?", [Date.now() - 1000, p.proposal_id]);
    const count = store.expireStale();
    expect(count).toBe(1);
    expect(store.get(p.proposal_id)!.status).toBe("expired");
  });

  test("expireStale does not expire approved proposals", () => {
    const p = store.create({ title: "Approved", description: "D", category: "feature", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    store["db"].run("UPDATE proposals SET expires_at = ? WHERE proposal_id = ?", [Date.now() - 1000, p.proposal_id]);
    const count = store.expireStale();
    expect(count).toBe(0);
  });

  test("markNudged sets nudged_at", () => {
    const p = store.create({ title: "Test", description: "D", category: "feature", proposed_by: "nyx" });
    store.markNudged(p.proposal_id);
    const updated = store.get(p.proposal_id);
    expect(updated!.nudged_at).toBeGreaterThan(0);
  });

  test("getStats returns correct counts", () => {
    store.create({ title: "A", description: "D", category: "maintenance", proposed_by: "nyx", autonomy: "auto" });
    store.create({ title: "B", description: "D", category: "feature", proposed_by: "nyx" });
    const p3 = store.create({ title: "C", description: "D", category: "bugfix", proposed_by: "nyx" });
    store.reject(p3.proposal_id, "nah");
    const stats = store.getStats();
    expect(stats.total).toBe(3);
    expect(stats.pending).toBe(2);
    expect(stats.rejected).toBe(1);
  });

  test("delete removes proposal", () => {
    const p = store.create({ title: "Test", description: "D", category: "maintenance", proposed_by: "nyx" });
    expect(store.delete(p.proposal_id)).toBe(true);
    expect(store.get(p.proposal_id)).toBeNull();
  });

  test("delete returns false for unknown id", () => {
    expect(store.delete("proposal-00000000")).toBe(false);
  });

  test("files_affected stored and retrieved as array", () => {
    const p = store.create({
      title: "Test",
      description: "D",
      category: "maintenance",
      proposed_by: "nyx",
      files_affected: ["src/foo.ts", "src/bar.ts"],
    });
    const fetched = store.get(p.proposal_id);
    expect(fetched!.files_affected).toEqual(["src/foo.ts", "src/bar.ts"]);
  });
});

describe("classifyAutonomy", () => {
  test("maintenance + small + no protected files = auto", () => {
    expect(classifyAutonomy("maintenance", "small", ["src/foo.ts"])).toBe("auto");
  });

  test("bugfix + small + no protected files = auto", () => {
    expect(classifyAutonomy("bugfix", "small", ["src/__tests__/bar.test.ts"])).toBe("auto");
  });

  test("feature always requires approval", () => {
    expect(classifyAutonomy("feature", "small", [])).toBe("requires_approval");
  });

  test("medium effort always requires approval", () => {
    expect(classifyAutonomy("maintenance", "medium", [])).toBe("requires_approval");
  });

  test("large effort always requires approval", () => {
    expect(classifyAutonomy("bugfix", "large", [])).toBe("requires_approval");
  });

  test("auth files always require approval", () => {
    expect(classifyAutonomy("maintenance", "small", ["src/auth/store.ts"])).toBe("requires_approval");
  });

  test("security files always require approval", () => {
    expect(classifyAutonomy("maintenance", "small", ["src/server/middleware/rbac.ts"])).toBe("requires_approval");
  });

  test("config files always require approval", () => {
    expect(classifyAutonomy("maintenance", "small", ["config.toml"])).toBe("requires_approval");
  });

  test("schema files always require approval", () => {
    expect(classifyAutonomy("maintenance", "small", ["src/queue/schema.sql"])).toBe("requires_approval");
  });

  test("env files always require approval", () => {
    expect(classifyAutonomy("maintenance", "small", [".env"])).toBe("requires_approval");
  });

  test("improvement + small + safe files = requires_approval", () => {
    expect(classifyAutonomy("improvement", "small", ["src/foo.ts"])).toBe("requires_approval");
  });

  test("empty files with maintenance + small = auto", () => {
    expect(classifyAutonomy("maintenance", "small", [])).toBe("auto");
  });

  test("mixed files — one protected = requires_approval", () => {
    expect(classifyAutonomy("maintenance", "small", ["src/foo.ts", "src/auth/store.ts"])).toBe("requires_approval");
  });
});

describe("findByTitle", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-dedup-test-"));
    store = new ProposalStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds active proposal by title", () => {
    const p = store.create({
      title: "Remove dead exports",
      description: "Found unused exports",
      category: "maintenance",
      proposed_by: "scout",
    });
    const found = store.findByTitle("Remove dead exports");
    expect(found).not.toBeNull();
    expect(found!.proposal_id).toBe(p.proposal_id);
  });

  test("returns null for rejected proposals", () => {
    const p = store.create({
      title: "Already rejected idea",
      description: "This was rejected",
      category: "improvement",
      proposed_by: "scout",
    });
    store.reject(p.proposal_id, "Not needed");
    const found = store.findByTitle("Already rejected idea");
    expect(found).toBeNull();
  });

  test("returns null when no match", () => {
    const found = store.findByTitle("Nonexistent proposal");
    expect(found).toBeNull();
  });

  test("returns null for expired proposals", () => {
    const p = store.create({
      title: "Expired idea",
      description: "This expired",
      category: "maintenance",
      proposed_by: "scout",
    });
    store["db"].run("UPDATE proposals SET expires_at = ? WHERE proposal_id = ?", [Date.now() - 1000, p.proposal_id]);
    store.expireStale();
    const found = store.findByTitle("Expired idea");
    expect(found).toBeNull();
  });
});

describe("normalizeWords", () => {
  test("lowercases and splits", () => {
    expect(normalizeWords("Hello World")).toEqual(new Set(["hello", "world"]));
  });

  test("strips punctuation", () => {
    expect(normalizeWords("NyxPersonal — Personal Productivity")).toEqual(
      new Set(["nyxpersonal", "personal", "productivity"])
    );
  });

  test("filters single-char words", () => {
    expect(normalizeWords("a b cd ef")).toEqual(new Set(["cd", "ef"]));
  });

  test("handles empty string", () => {
    expect(normalizeWords("")).toEqual(new Set());
  });
});

describe("jaccardSimilarity", () => {
  test("identical sets = 1", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
  });

  test("disjoint sets = 0", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0);
  });

  test("partial overlap", () => {
    // {a,b,c} ∩ {b,c,d} = {b,c} → 2/4 = 0.5
    expect(jaccardSimilarity(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBe(0.5);
  });

  test("both empty = 1", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  test("one empty = 0", () => {
    expect(jaccardSimilarity(new Set(["a"]), new Set())).toBe(0);
  });
});

describe("findSimilar", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-similar-test-"));
    store = new ProposalStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds similar proposal with overlapping title", () => {
    store.create({
      title: "NyxPersonal Instance Setup",
      description: "Set up a personal productivity NyxHive instance",
      category: "new_instance",
      proposed_by: "researcher",
    });
    const result = store.findSimilar(
      "NyxPersonal — Personal Productivity Instance",
      "Create a personal NyxHive instance for productivity",
    );
    expect(result).not.toBeNull();
    expect(result!.similarity).toBeGreaterThanOrEqual(0.4);
  });

  test("returns null for completely different proposals", () => {
    store.create({
      title: "Fix authentication bug",
      description: "Login fails when token expires",
      category: "bugfix",
      proposed_by: "scout",
    });
    const result = store.findSimilar(
      "Add dark mode support",
      "Implement dark mode toggle in settings",
    );
    expect(result).toBeNull();
  });

  test("does not match rejected proposals", () => {
    const p = store.create({
      title: "Improve logging system",
      description: "Add structured logging throughout",
      category: "improvement",
      proposed_by: "scout",
    });
    store.reject(p.proposal_id, "Not needed");
    const result = store.findSimilar(
      "Improve logging system",
      "Add structured logging throughout",
    );
    expect(result).toBeNull();
  });

  test("does not match expired proposals", () => {
    const p = store.create({
      title: "Improve logging system",
      description: "Add structured logging throughout",
      category: "improvement",
      proposed_by: "scout",
    });
    store["db"].run("UPDATE proposals SET expires_at = ? WHERE proposal_id = ?", [Date.now() - 1000, p.proposal_id]);
    store.expireStale();
    const result = store.findSimilar(
      "Improve logging system",
      "Add structured logging throughout",
    );
    expect(result).toBeNull();
  });

  test("returns most similar match when multiple exist", () => {
    store.create({
      title: "Add webhook notifications",
      description: "Support webhook notifications for system events",
      category: "feature",
      proposed_by: "scout",
    });
    store.create({
      title: "Add webhook notifications for proposals",
      description: "Send webhook notifications when proposals are created or updated",
      category: "feature",
      proposed_by: "scout",
    });
    const result = store.findSimilar(
      "Add webhook notifications for proposal events",
      "Send webhook notifications when proposals change status",
    );
    expect(result).not.toBeNull();
    expect(result!.proposal.title).toContain("webhook");
  });

  test("respects custom threshold", () => {
    store.create({
      title: "Add webhook support",
      description: "Support webhook notifications for events",
      category: "feature",
      proposed_by: "researcher",
    });
    // With high threshold, marginal matches should be rejected
    const result = store.findSimilar(
      "Webhook integration",
      "Integrate webhooks for notification delivery",
      0.9,
    );
    expect(result).toBeNull();
  });

  test("returns null when store is empty", () => {
    const result = store.findSimilar("Any title", "Any description");
    expect(result).toBeNull();
  });
});

describe("verdict extraction in saveReview", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-verdict-test-"));
    store = new ProposalStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("extracts DO verdict (normalized to APPROVE)", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "feature", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    store.saveReview(p.proposal_id, "VERDICT: DO\nREASON: Good improvement\nEFFORT: small\nOVERLAPS: none", "auto-review");
    const updated = store.get(p.proposal_id);
    expect(updated!.verdict).toBe("APPROVE");
    expect(updated!.status).toBe("reviewed");
  });

  test("extracts SKIP verdict (normalized to REJECT)", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "feature", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    store.saveReview(p.proposal_id, "VERDICT: SKIP\nREASON: Low value\nEFFORT: medium\nOVERLAPS: none", "auto-review");
    const updated = store.get(p.proposal_id);
    expect(updated!.verdict).toBe("REJECT");
  });

  test("extracts MERGE verdict", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "feature", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    store.saveReview(p.proposal_id, "VERDICT: MERGE\nREASON: Overlaps with existing\nEFFORT: small\nOVERLAPS: proposal-abc12345", "auto-review");
    const updated = store.get(p.proposal_id);
    expect(updated!.verdict).toBe("MERGE");
  });

  test("handles case-insensitive verdict", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "feature", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    store.saveReview(p.proposal_id, "verdict: do\nreason: good", "auto-review");
    const updated = store.get(p.proposal_id);
    expect(updated!.verdict).toBe("APPROVE");
  });

  test("verdict is UNCLEAR when review has no verdict format", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "feature", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    store.saveReview(p.proposal_id, "This looks fine, approved.", "analyst");
    const updated = store.get(p.proposal_id);
    expect(updated!.verdict).toBe("UNCLEAR");
    expect(updated!.status).toBe("reviewed");
  });

  test("verdict is UNCLEAR when review fails", () => {
    const p = store.create({ title: "Test", description: "Desc", category: "feature", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    store.saveReview(p.proposal_id, "Auto-review failed: timeout", "system");
    const updated = store.get(p.proposal_id);
    expect(updated!.verdict).toBe("UNCLEAR");
  });
});

describe("deleteTerminal", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-terminal-test-"));
    store = new ProposalStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("deletes merged, rejected, failed, expired proposals", () => {
    const p1 = store.create({ title: "Merged", description: "D", category: "feature", proposed_by: "nyx" });
    store.approve(p1.proposal_id, "jay");
    store.markExecuting(p1.proposal_id, "ref");
    store.markCompleted(p1.proposal_id, "done", "forge", "https://github.com/x/y/pull/1");
    store.markMerged(p1.proposal_id, "jay");

    const p2 = store.create({ title: "Rejected", description: "D", category: "feature", proposed_by: "nyx" });
    store.reject(p2.proposal_id, "nah");

    const p3 = store.create({ title: "Failed", description: "D", category: "feature", proposed_by: "nyx" });
    store.markExecuting(p3.proposal_id, "ref");
    store.markFailed(p3.proposal_id, "error");

    const p4 = store.create({ title: "Expired", description: "D", category: "feature", proposed_by: "nyx" });
    store["db"].run("UPDATE proposals SET expires_at = ? WHERE proposal_id = ?", [Date.now() - 1000, p4.proposal_id]);
    store.expireStale();

    const deleted = store.deleteTerminal();
    expect(deleted).toBe(4);
    expect(store.list()).toHaveLength(0);
  });

  test("preserves completed proposals (may have unmerged PRs)", () => {
    const p1 = store.create({ title: "Completed", description: "D", category: "feature", proposed_by: "nyx" });
    store.approve(p1.proposal_id, "jay");
    store.markExecuting(p1.proposal_id, "ref");
    store.markCompleted(p1.proposal_id, "done", "forge", "https://github.com/x/y/pull/1");

    const p2 = store.create({ title: "Proposed", description: "D", category: "feature", proposed_by: "nyx" });

    const deleted = store.deleteTerminal();
    expect(deleted).toBe(0);
    expect(store.list()).toHaveLength(2);
  });
});

describe("listCompletedWithPR", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-pr-test-"));
    store = new ProposalStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns completed proposals with pr_url", () => {
    const p1 = store.create({ title: "With PR", description: "D", category: "feature", proposed_by: "nyx" });
    store.markExecuting(p1.proposal_id, "ref");
    store.markCompleted(p1.proposal_id, "done", "forge", "https://github.com/x/y/pull/1");

    const p2 = store.create({ title: "No PR", description: "D", category: "feature", proposed_by: "nyx" });
    store.markExecuting(p2.proposal_id, "ref");
    store.markCompleted(p2.proposal_id, "done", "forge");

    const p3 = store.create({ title: "Proposed", description: "D", category: "feature", proposed_by: "nyx" });

    const result = store.listCompletedWithPR();
    expect(result).toHaveLength(1);
    expect(result[0].proposal_id).toBe(p1.proposal_id);
  });
});

describe("markMerged idempotency", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-merge-test-"));
    store = new ProposalStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("calling markMerged twice does not fail", () => {
    const p = store.create({ title: "Test", description: "D", category: "feature", proposed_by: "nyx" });
    store.markExecuting(p.proposal_id, "ref");
    store.markCompleted(p.proposal_id, "done", "forge", "https://github.com/x/y/pull/1");

    const first = store.markMerged(p.proposal_id, "jay");
    expect(first!.status).toBe("merged");

    const second = store.markMerged(p.proposal_id, "auto-sync");
    expect(second!.status).toBe("merged");
  });
});

describe("markCompleted NO_PR flag (Item 1)", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-nopr-test-"));
    store = new ProposalStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("sets verdict to NO_PR when completed with result but no PR URL", () => {
    const p = store.create({ title: "Test", description: "D", category: "maintenance", proposed_by: "nyx" });
    store.markExecuting(p.proposal_id, "ref");
    store.markCompleted(p.proposal_id, "I made the changes locally but couldn't push", "forge");
    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("completed");
    expect(updated!.verdict).toBe("NO_PR");
    expect(updated!.pr_url).toBeNull();
  });

  test("does not set NO_PR when PR URL is provided", () => {
    const p = store.create({ title: "Test", description: "D", category: "maintenance", proposed_by: "nyx" });
    store.markExecuting(p.proposal_id, "ref");
    store.markCompleted(p.proposal_id, "Done, PR created", "forge", "https://github.com/x/y/pull/1");
    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("completed");
    expect(updated!.verdict).toBeNull();
    expect(updated!.pr_url).toBe("https://github.com/x/y/pull/1");
  });

  test("does not set NO_PR when no result provided", () => {
    const p = store.create({ title: "Test", description: "D", category: "maintenance", proposed_by: "nyx" });
    store.markExecuting(p.proposal_id, "ref");
    store.markCompleted(p.proposal_id);
    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("completed");
    expect(updated!.verdict).toBeNull();
  });

  test("does not override existing verdict with NO_PR", () => {
    const p = store.create({ title: "Test", description: "D", category: "maintenance", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    store.saveReview(p.proposal_id, "**Verdict: APPROVE**\n**Why:** Good idea", "nyx");
    store.approve(p.proposal_id, "jay");
    store.markExecuting(p.proposal_id, "ref");
    store.markCompleted(p.proposal_id, "Done locally", "forge");
    const updated = store.get(p.proposal_id);
    expect(updated!.verdict).toBe("APPROVE"); // Existing verdict preserved
  });

  test("failure result still routes to markFailed", () => {
    const p = store.create({ title: "Test", description: "D", category: "maintenance", proposed_by: "nyx" });
    store.markExecuting(p.proposal_id, "ref");
    store.markCompleted(p.proposal_id, "REFUSED: not allowed", "forge");
    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("failed");
  });
});

describe("UNCLEAR verdict on missing verdict (Item 4)", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-unclear-test-"));
    store = new ProposalStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("sets verdict to UNCLEAR when review has no extractable verdict", () => {
    const p = store.create({ title: "Test", description: "D", category: "feature", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    store.saveReview(p.proposal_id, "This looks fine, approved.", "analyst");
    const updated = store.get(p.proposal_id);
    expect(updated!.verdict).toBe("UNCLEAR");
    expect(updated!.status).toBe("reviewed");
  });

  test("sets verdict to UNCLEAR when review fails", () => {
    const p = store.create({ title: "Test", description: "D", category: "feature", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    store.saveReview(p.proposal_id, "Auto-review failed: timeout", "system");
    const updated = store.get(p.proposal_id);
    expect(updated!.verdict).toBe("UNCLEAR");
  });

  test("does NOT set UNCLEAR when verdict is extractable", () => {
    const p = store.create({ title: "Test", description: "D", category: "feature", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    store.saveReview(p.proposal_id, "**Verdict: APPROVE**\n**Why:** Solid improvement.", "nyx");
    const updated = store.get(p.proposal_id);
    expect(updated!.verdict).toBe("APPROVE");
  });
});

describe("archiveStale (Item 8)", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-archive-test-"));
    store = new ProposalStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("archives completed proposals older than N days", () => {
    const p = store.create({ title: "Old completed", description: "D", category: "feature", proposed_by: "nyx" });
    store.markExecuting(p.proposal_id, "ref");
    store.markCompleted(p.proposal_id, "done", "forge", "https://github.com/x/y/pull/1");
    // Backdate updated_at to 31 days ago
    store["db"].run("UPDATE proposals SET updated_at = ? WHERE proposal_id = ?", [Date.now() - 31 * 86400000, p.proposal_id]);
    const archived = store.archiveStale(30);
    expect(archived).toBe(1);
    expect(store.get(p.proposal_id)!.status).toBe("expired");
  });

  test("archives failed proposals older than N days", () => {
    const p = store.create({ title: "Old failed", description: "D", category: "feature", proposed_by: "nyx" });
    store.markFailed(p.proposal_id, "error");
    store["db"].run("UPDATE proposals SET updated_at = ? WHERE proposal_id = ?", [Date.now() - 31 * 86400000, p.proposal_id]);
    const archived = store.archiveStale(30);
    expect(archived).toBe(1);
    expect(store.get(p.proposal_id)!.status).toBe("expired");
  });

  test("does not archive recent completed proposals", () => {
    const p = store.create({ title: "Recent", description: "D", category: "feature", proposed_by: "nyx" });
    store.markExecuting(p.proposal_id, "ref");
    store.markCompleted(p.proposal_id, "done", "forge");
    const archived = store.archiveStale(30);
    expect(archived).toBe(0);
    expect(store.get(p.proposal_id)!.status).toBe("completed");
  });

  test("does not archive proposed or approved proposals", () => {
    const p1 = store.create({ title: "Proposed", description: "D", category: "feature", proposed_by: "nyx" });
    const p2 = store.create({ title: "Approved", description: "D", category: "feature", proposed_by: "nyx" });
    store.approve(p2.proposal_id, "jay");
    // Backdate both
    store["db"].run("UPDATE proposals SET updated_at = ? WHERE proposal_id IN (?, ?)", [Date.now() - 31 * 86400000, p1.proposal_id, p2.proposal_id]);
    const archived = store.archiveStale(30);
    expect(archived).toBe(0);
  });
});

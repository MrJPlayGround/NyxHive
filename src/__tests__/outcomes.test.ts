import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { OutcomeStore } from "../memory/outcomes.js";

describe("OutcomeStore", () => {
  let db: Database;
  let store: OutcomeStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new OutcomeStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("record creates an outcome", () => {
    const outcome = store.record({
      trace_id: "trace-1",
      agent: "forge",
      task_type: "coding",
      outcome: "success",
    });
    expect(outcome.id).toBeGreaterThan(0);
    expect(outcome.agent).toBe("forge");
    expect(outcome.outcome).toBe("success");
    expect(outcome.retry_count).toBe(0);
    expect(outcome.pr_merged).toBe(0);
  });

  test("record with all fields", () => {
    const outcome = store.record({
      proposal_id: "proposal-abc12345",
      trace_id: "trace-2",
      agent: "forge",
      task_type: "coding",
      review_verdict: "pass",
      retry_count: 1,
      pr_url: "https://github.com/test/repo/pull/1",
      files_changed: 3,
      lines_added: 50,
      lines_removed: 10,
      cost_cents: 5.5,
      duration_ms: 120000,
      outcome: "success",
    });
    expect(outcome.proposal_id).toBe("proposal-abc12345");
    expect(outcome.review_verdict).toBe("pass");
    expect(outcome.retry_count).toBe(1);
    expect(outcome.pr_url).toBe("https://github.com/test/repo/pull/1");
    expect(outcome.files_changed).toBe(3);
    expect(outcome.lines_added).toBe(50);
    expect(outcome.lines_removed).toBe(10);
    expect(outcome.cost_cents).toBe(5.5);
    expect(outcome.duration_ms).toBe(120000);
  });

  test("record failed outcome with reason", () => {
    const outcome = store.record({
      trace_id: "trace-3",
      agent: "forge",
      task_type: "coding",
      outcome: "failed",
      failure_reason: "Tests did not pass",
    });
    expect(outcome.outcome).toBe("failed");
    expect(outcome.failure_reason).toBe("Tests did not pass");
  });

  test("getById returns outcome", () => {
    const created = store.record({
      trace_id: "trace-4",
      agent: "forge",
      task_type: "coding",
      outcome: "success",
    });
    const fetched = store.getById(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.trace_id).toBe("trace-4");
  });

  test("getById returns null for unknown id", () => {
    expect(store.getById(999)).toBeNull();
  });

  test("markMerged updates PR status", () => {
    const outcome = store.record({
      trace_id: "trace-5",
      agent: "forge",
      task_type: "coding",
      pr_url: "https://github.com/test/repo/pull/2",
      outcome: "success",
    });
    store.markMerged(outcome.id, 4.5);
    const updated = store.getById(outcome.id);
    expect(updated!.pr_merged).toBe(1);
    expect(updated!.time_to_merge_hours).toBe(4.5);
  });

  test("setReviewComments updates count", () => {
    const outcome = store.record({
      trace_id: "trace-6",
      agent: "forge",
      task_type: "coding",
      outcome: "success",
    });
    store.setReviewComments(outcome.id, 3);
    const updated = store.getById(outcome.id);
    expect(updated!.review_comments_count).toBe(3);
  });

  test("query returns all outcomes by default", () => {
    store.record({ trace_id: "t1", agent: "forge", task_type: "coding", outcome: "success" });
    store.record({ trace_id: "t2", agent: "forge", task_type: "coding", outcome: "failed" });
    store.record({ trace_id: "t3", agent: "analyst", task_type: "analysis", outcome: "success" });

    const all = store.query();
    expect(all).toHaveLength(3);
  });

  test("query filters by agent", () => {
    store.record({ trace_id: "t1", agent: "forge", task_type: "coding", outcome: "success" });
    store.record({ trace_id: "t2", agent: "analyst", task_type: "analysis", outcome: "success" });

    const forgeOnly = store.query({ agent: "forge" });
    expect(forgeOnly).toHaveLength(1);
    expect(forgeOnly[0].agent).toBe("forge");
  });

  test("query filters by outcome", () => {
    store.record({ trace_id: "t1", agent: "forge", task_type: "coding", outcome: "success" });
    store.record({ trace_id: "t2", agent: "forge", task_type: "coding", outcome: "failed" });

    const failed = store.query({ outcome: "failed" });
    expect(failed).toHaveLength(1);
    expect(failed[0].outcome).toBe("failed");
  });

  test("query respects limit", () => {
    for (let i = 0; i < 10; i++) {
      store.record({ trace_id: `t${i}`, agent: "forge", task_type: "coding", outcome: "success" });
    }
    const limited = store.query({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  test("getAgentStats returns per-agent aggregates", () => {
    store.record({ trace_id: "t1", agent: "forge", task_type: "coding", outcome: "success", cost_cents: 10, duration_ms: 5000 });
    store.record({ trace_id: "t2", agent: "forge", task_type: "coding", outcome: "failed", cost_cents: 5, duration_ms: 3000, failure_reason: "err" });
    store.record({ trace_id: "t3", agent: "analyst", task_type: "analysis", outcome: "success", cost_cents: 2, duration_ms: 1000 });

    const stats = store.getAgentStats();
    expect(stats).toHaveLength(2);

    const forgeStats = stats.find(s => s.agent === "forge");
    expect(forgeStats).toBeDefined();
    expect(forgeStats!.total).toBe(2);
    expect(forgeStats!.success).toBe(1);
    expect(forgeStats!.failed).toBe(1);
    expect(forgeStats!.success_rate).toBe(50);
  });

  test("getByProposal returns outcomes for a proposal", () => {
    store.record({ proposal_id: "proposal-abc", trace_id: "t1", agent: "forge", task_type: "coding", outcome: "failed" });
    store.record({ proposal_id: "proposal-abc", trace_id: "t2", agent: "forge", task_type: "coding", outcome: "success" });
    store.record({ proposal_id: "proposal-xyz", trace_id: "t3", agent: "forge", task_type: "coding", outcome: "success" });

    const results = store.getByProposal("proposal-abc");
    expect(results).toHaveLength(2);
    expect(results.every(r => r.proposal_id === "proposal-abc")).toBe(true);
  });

  test("listUnmergedPRs returns outcomes with PRs not yet merged", () => {
    const o1 = store.record({
      trace_id: "t1", agent: "forge", task_type: "coding",
      pr_url: "https://github.com/test/repo/pull/1", outcome: "success",
    });
    store.record({
      trace_id: "t2", agent: "forge", task_type: "coding",
      pr_url: "https://github.com/test/repo/pull/2", outcome: "success",
    });
    store.record({
      trace_id: "t3", agent: "forge", task_type: "coding",
      outcome: "success", // no PR
    });

    // Mark one as merged
    store.markMerged(o1.id, 2);

    const unmerged = store.listUnmergedPRs();
    expect(unmerged).toHaveLength(1);
    expect(unmerged[0].pr_url).toBe("https://github.com/test/repo/pull/2");
  });
});

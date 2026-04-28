import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { DevPlanStore, type DevPlan, type DevStory } from "../development/plan.js";

describe("DevPlanStore", () => {
  let db: Database;
  let store: DevPlanStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new DevPlanStore(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("createPlan", () => {
    test("creates a plan with correct defaults", () => {
      const plan = store.createPlan({
        feature: "Add auth",
        branch: "feat/auth",
        agent: "forge",
        createdBy: "jay",
      });

      expect(plan.id).toMatch(/^plan-/);
      expect(plan.feature).toBe("Add auth");
      expect(plan.branch).toBe("feat/auth");
      expect(plan.agent).toBe("forge");
      expect(plan.status).toBe("planning");
      expect(plan.checks).toEqual(["bun run typecheck", "bun test"]);
      expect(plan.created_by).toBe("jay");
      expect(plan.created_at).toBeGreaterThan(0);
      expect(plan.updated_at).toBe(plan.created_at);
    });

    test("accepts custom checks", () => {
      const plan = store.createPlan({
        feature: "Migrate DB",
        branch: "feat/db",
        agent: "forge",
        createdBy: "nyx",
        checks: ["bun test --filter db"],
      });

      expect(plan.checks).toEqual(["bun test --filter db"]);
    });

    test("persists to database", () => {
      const plan = store.createPlan({
        feature: "Test feature",
        branch: "feat/test",
        agent: "forge",
        createdBy: "jay",
      });

      const fetched = store.getPlan(plan.id);
      expect(fetched).toBeDefined();
      expect(fetched!.feature).toBe("Test feature");
      expect(fetched!.checks).toEqual(["bun run typecheck", "bun test"]);
    });
  });

  describe("getPlan", () => {
    test("returns undefined for non-existent plan", () => {
      expect(store.getPlan("plan-nonexistent")).toBeUndefined();
    });

    test("deserializes checks JSON", () => {
      const plan = store.createPlan({
        feature: "X",
        branch: "b",
        agent: "a",
        createdBy: "c",
        checks: ["check1", "check2"],
      });

      const fetched = store.getPlan(plan.id);
      expect(fetched!.checks).toEqual(["check1", "check2"]);
    });
  });

  describe("listPlans", () => {
    test("returns all plans", () => {
      store.createPlan({ feature: "A", branch: "a", agent: "forge", createdBy: "jay" });
      store.createPlan({ feature: "B", branch: "b", agent: "forge", createdBy: "jay" });

      const plans = store.listPlans();
      expect(plans).toHaveLength(2);
      const features = plans.map(p => p.feature).sort();
      expect(features).toEqual(["A", "B"]);
    });

    test("filters by status", () => {
      const p1 = store.createPlan({ feature: "A", branch: "a", agent: "forge", createdBy: "jay" });
      store.createPlan({ feature: "B", branch: "b", agent: "forge", createdBy: "jay" });

      store.updatePlanStatus(p1.id, "running");

      expect(store.listPlans("running")).toHaveLength(1);
      expect(store.listPlans("planning")).toHaveLength(1);
      expect(store.listPlans("completed")).toHaveLength(0);
    });

    test("returns empty array when none exist", () => {
      expect(store.listPlans()).toEqual([]);
    });
  });

  describe("updatePlanStatus", () => {
    test("transitions plan status", () => {
      const plan = store.createPlan({ feature: "X", branch: "b", agent: "a", createdBy: "c" });

      store.updatePlanStatus(plan.id, "running");
      expect(store.getPlan(plan.id)!.status).toBe("running");

      store.updatePlanStatus(plan.id, "paused");
      expect(store.getPlan(plan.id)!.status).toBe("paused");

      store.updatePlanStatus(plan.id, "completed");
      expect(store.getPlan(plan.id)!.status).toBe("completed");
    });

    test("updates the updated_at timestamp", () => {
      const plan = store.createPlan({ feature: "X", branch: "b", agent: "a", createdBy: "c" });
      const origUpdated = plan.updated_at;

      store.updatePlanStatus(plan.id, "running");
      const updated = store.getPlan(plan.id)!;
      expect(updated.updated_at).toBeGreaterThanOrEqual(origUpdated);
    });
  });

  describe("deletePlan", () => {
    test("removes plan and its stories", () => {
      const plan = store.createPlan({ feature: "X", branch: "b", agent: "a", createdBy: "c" });
      store.addStory(plan.id, "Story 1");
      store.addStory(plan.id, "Story 2");

      store.deletePlan(plan.id);

      expect(store.getPlan(plan.id)).toBeUndefined();
      expect(store.getStories(plan.id)).toEqual([]);
    });
  });

  describe("addStory", () => {
    let plan: DevPlan;

    beforeEach(() => {
      plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
    });

    test("creates story with correct defaults", () => {
      const story = store.addStory(plan.id, "Setup database");

      expect(story.id).toMatch(/^story-/);
      expect(story.plan_id).toBe(plan.id);
      expect(story.sequence).toBe(1);
      expect(story.title).toBe("Setup database");
      expect(story.acceptance_criteria).toEqual([]);
      expect(story.status).toBe("pending");
      expect(story.attempts).toBe(0);
      expect(story.max_retries).toBe(3);
      expect(story.last_error).toBeNull();
      expect(story.learnings).toBeNull();
      expect(story.commit_hash).toBeNull();
      expect(story.tokens_used).toBe(0);
      expect(story.duration_ms).toBe(0);
    });

    test("auto-increments sequence", () => {
      const s1 = store.addStory(plan.id, "First");
      const s2 = store.addStory(plan.id, "Second");
      const s3 = store.addStory(plan.id, "Third");

      expect(s1.sequence).toBe(1);
      expect(s2.sequence).toBe(2);
      expect(s3.sequence).toBe(3);
    });

    test("accepts acceptance criteria", () => {
      const story = store.addStory(plan.id, "Auth", ["Login works", "Logout works"]);
      expect(story.acceptance_criteria).toEqual(["Login works", "Logout works"]);
    });

    test("throws at max stories per plan (20)", () => {
      for (let i = 0; i < 20; i++) {
        store.addStory(plan.id, `Story ${i + 1}`);
      }
      expect(() => store.addStory(plan.id, "Story 21")).toThrow("Max 20 stories per plan");
    });
  });

  describe("addStories (batch)", () => {
    test("adds multiple stories at once", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      const stories = store.addStories(plan.id, [
        { title: "Step 1", acceptance_criteria: ["AC1"] },
        { title: "Step 2" },
        { title: "Step 3", acceptance_criteria: ["AC3a", "AC3b"] },
      ]);

      expect(stories).toHaveLength(3);
      expect(stories[0].sequence).toBe(1);
      expect(stories[1].sequence).toBe(2);
      expect(stories[2].sequence).toBe(3);
      expect(stories[0].acceptance_criteria).toEqual(["AC1"]);
      expect(stories[1].acceptance_criteria).toEqual([]);
      expect(stories[2].acceptance_criteria).toEqual(["AC3a", "AC3b"]);
    });
  });

  describe("getStories", () => {
    test("returns stories ordered by sequence", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      store.addStory(plan.id, "Third"); // will get seq 1
      store.addStory(plan.id, "Fourth"); // will get seq 2

      const stories = store.getStories(plan.id);
      expect(stories).toHaveLength(2);
      expect(stories[0].sequence).toBeLessThan(stories[1].sequence);
    });

    test("deserializes acceptance criteria", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      store.addStory(plan.id, "S", ["crit1", "crit2"]);

      const stories = store.getStories(plan.id);
      expect(stories[0].acceptance_criteria).toEqual(["crit1", "crit2"]);
    });

    test("returns empty array for plan with no stories", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      expect(store.getStories(plan.id)).toEqual([]);
    });
  });

  describe("getNextPendingStory", () => {
    test("returns first pending story by sequence", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      const s1 = store.addStory(plan.id, "First");
      store.addStory(plan.id, "Second");

      const next = store.getNextPendingStory(plan.id);
      expect(next).toBeDefined();
      expect(next!.id).toBe(s1.id);
    });

    test("skips non-pending stories", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      const s1 = store.addStory(plan.id, "First");
      const s2 = store.addStory(plan.id, "Second");

      store.updateStory(s1.id, { status: "passed" });

      const next = store.getNextPendingStory(plan.id);
      expect(next!.id).toBe(s2.id);
    });

    test("returns undefined when all stories are done", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      const s1 = store.addStory(plan.id, "First");
      store.updateStory(s1.id, { status: "passed" });

      expect(store.getNextPendingStory(plan.id)).toBeUndefined();
    });

    test("returns undefined for plan with no stories", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      expect(store.getNextPendingStory(plan.id)).toBeUndefined();
    });
  });

  describe("updateStory", () => {
    test("updates status", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      const story = store.addStory(plan.id, "S");

      store.updateStory(story.id, { status: "running" });
      const stories = store.getStories(plan.id);
      expect(stories[0].status).toBe("running");
    });

    test("updates multiple fields at once", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      const story = store.addStory(plan.id, "S");

      store.updateStory(story.id, {
        status: "passed",
        duration_ms: 5000,
        learnings: "Found a pattern",
        commit_hash: "abc1234",
        tokens_used: 1500,
      });

      const updated = store.getStories(plan.id)[0];
      expect(updated.status).toBe("passed");
      expect(updated.duration_ms).toBe(5000);
      expect(updated.learnings).toBe("Found a pattern");
      expect(updated.commit_hash).toBe("abc1234");
      expect(updated.tokens_used).toBe(1500);
    });

    test("updates last_error", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      const story = store.addStory(plan.id, "S");

      store.updateStory(story.id, { last_error: "Something broke" });
      const updated = store.getStories(plan.id)[0];
      expect(updated.last_error).toBe("Something broke");
    });
  });

  describe("skipStory", () => {
    test("sets story status to skipped", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      const story = store.addStory(plan.id, "Optional step");

      store.skipStory(story.id);
      const stories = store.getStories(plan.id);
      expect(stories[0].status).toBe("skipped");
    });
  });

  describe("getPlanProgress", () => {
    test("counts all story statuses correctly", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      const stories = store.addStories(plan.id, [
        { title: "S1" },
        { title: "S2" },
        { title: "S3" },
        { title: "S4" },
        { title: "S5" },
      ]);

      store.updateStory(stories[0].id, { status: "passed" });
      store.updateStory(stories[1].id, { status: "failed" });
      store.updateStory(stories[2].id, { status: "skipped" });
      store.updateStory(stories[3].id, { status: "running" });
      // stories[4] stays pending

      const progress = store.getPlanProgress(plan.id);
      expect(progress).toEqual({
        total: 5,
        passed: 1,
        failed: 1,
        skipped: 1,
        running: 1,
        pending: 1,
      });
    });

    test("returns all zeros for plan with no stories", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      expect(store.getPlanProgress(plan.id)).toEqual({
        total: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        running: 0,
        pending: 0,
      });
    });

    test("tracks all-passed scenario", () => {
      const plan = store.createPlan({ feature: "F", branch: "b", agent: "a", createdBy: "c" });
      const stories = store.addStories(plan.id, [{ title: "S1" }, { title: "S2" }]);
      stories.forEach(s => store.updateStory(s.id, { status: "passed" }));

      const progress = store.getPlanProgress(plan.id);
      expect(progress.total).toBe(2);
      expect(progress.passed).toBe(2);
      expect(progress.failed).toBe(0);
      expect(progress.pending).toBe(0);
    });
  });
});

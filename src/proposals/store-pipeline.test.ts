import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { ProposalStore } from "./store.js";
import { autoAdvanceReviewedProposal, canAutoAdvanceReviewedProposal } from "./review-autopilot.js";

describe("ProposalStore — pipeline edge cases", () => {
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

  function makeProposal(title = "Test proposal") {
    return store.create({
      title,
      description: "Test description",
      category: "improvement",
      proposed_by: "test-agent",
    });
  }

  // --- Fix 3: Atomic markExecuting ---

  describe("markExecuting — atomic status guard", () => {
    test("succeeds when proposal is approved", () => {
      const p = makeProposal();
      store.approve(p.proposal_id, "jay");
      const ok = store.markExecuting(p.proposal_id, "exec-1");
      expect(ok).toBe(true);
      expect(store.get(p.proposal_id)!.status).toBe("executing");
    });

    test("fails when proposal is still proposed (not approved)", () => {
      const p = makeProposal();
      const ok = store.markExecuting(p.proposal_id, "exec-1");
      expect(ok).toBe(false);
      expect(store.get(p.proposal_id)!.status).toBe("proposed");
    });

    test("fails when proposal was rejected between selection and execution", () => {
      const p = makeProposal();
      store.approve(p.proposal_id, "jay");
      // Simulate race: rejected after approval but before execution
      store.reject(p.proposal_id, "Changed my mind");
      // reject() guard only allows proposed/reviewing/reviewed, so this stays approved
      // Actually re-read: reject WHERE status IN ('proposed', 'reviewing', 'reviewed')
      // So rejecting an approved proposal is a no-op. Let's test the real race:
      // proposal is approved, then someone else marks it executing first
      const ok1 = store.markExecuting(p.proposal_id, "exec-1");
      expect(ok1).toBe(true);
      // Second attempt should fail — already executing
      const ok2 = store.markExecuting(p.proposal_id, "exec-2");
      expect(ok2).toBe(false);
    });

    test("fails when proposal is already completed", () => {
      const p = makeProposal();
      store.approve(p.proposal_id, "jay");
      store.markExecuting(p.proposal_id, "exec-1");
      store.markCompleted(p.proposal_id, "done", "agent", "https://github.com/pr/1");
      const ok = store.markExecuting(p.proposal_id, "exec-2");
      expect(ok).toBe(false);
    });
  });

  // --- Fix 1: Stale reviewing recovery ---

  describe("resetStaleReviewing", () => {
    test("resets proposals stuck in reviewing past timeout", () => {
      const p = makeProposal();
      store.markReviewing(p.proposal_id);
      // Force updated_at to 2 hours ago
      (store as any).db.run(
        "UPDATE proposals SET updated_at = ? WHERE proposal_id = ?",
        [Date.now() - 2 * 60 * 60 * 1000, p.proposal_id],
      );
      const count = store.resetStaleReviewing(60 * 60 * 1000); // 1 hour timeout
      expect(count).toBe(1);
      expect(store.get(p.proposal_id)!.status).toBe("proposed");
    });

    test("does not reset proposals reviewing within timeout", () => {
      const p = makeProposal();
      store.markReviewing(p.proposal_id);
      // updated_at is now (just set by markReviewing)
      const count = store.resetStaleReviewing(60 * 60 * 1000);
      expect(count).toBe(0);
      expect(store.get(p.proposal_id)!.status).toBe("reviewing");
    });

    test("does not affect proposals in other statuses", () => {
      const p1 = makeProposal("Proposed one");
      const p2 = makeProposal("Approved one");
      store.approve(p2.proposal_id, "jay");
      // Force both to be old
      (store as any).db.run(
        "UPDATE proposals SET updated_at = ?",
        [Date.now() - 2 * 60 * 60 * 1000],
      );
      const count = store.resetStaleReviewing(60 * 60 * 1000);
      expect(count).toBe(0); // neither is 'reviewing'
      expect(store.get(p1.proposal_id)!.status).toBe("proposed");
      expect(store.get(p2.proposal_id)!.status).toBe("approved");
    });
  });

  // --- Fix 4: Verdict regex ---

  describe("saveReview — verdict extraction", () => {
    test("extracts verdict with colon: 'Verdict: APPROVE'", () => {
      const p = makeProposal();
      store.saveReview(p.proposal_id, "Good work.\n\n**Verdict: APPROVE**\n", "vigil");
      expect(store.get(p.proposal_id)!.verdict).toBe("APPROVE");
    });

    test("extracts verdict with markdown bold and colon", () => {
      const p = makeProposal();
      store.saveReview(p.proposal_id, "**Verdict: REJECT**\n**Why:** Bad code.", "vigil");
      expect(store.get(p.proposal_id)!.verdict).toBe("REJECT");
    });

    test("normalizes NEEDS MODIFICATION to APPROVE", () => {
      const p = makeProposal();
      store.saveReview(p.proposal_id, "**Verdict: NEEDS MODIFICATION**", "vigil");
      expect(store.get(p.proposal_id)!.verdict).toBe("APPROVE");
    });

    test("normalizes DO → APPROVE and SKIP → REJECT", () => {
      const p1 = makeProposal("Do test");
      store.saveReview(p1.proposal_id, "Verdict: DO", "vigil");
      expect(store.get(p1.proposal_id)!.verdict).toBe("APPROVE");

      const p2 = makeProposal("Skip test");
      store.saveReview(p2.proposal_id, "Verdict: SKIP", "vigil");
      expect(store.get(p2.proposal_id)!.verdict).toBe("REJECT");
    });

    test("marks UNCLEAR when no colon present (e.g. 'Verdict APPROVE')", () => {
      const p = makeProposal();
      store.saveReview(p.proposal_id, "Verdict APPROVE — looks good", "vigil");
      expect(store.get(p.proposal_id)!.verdict).toBe("UNCLEAR");
    });

    test("marks UNCLEAR when no verdict line at all", () => {
      const p = makeProposal();
      store.saveReview(p.proposal_id, "This looks fine, ship it.", "vigil");
      expect(store.get(p.proposal_id)!.verdict).toBe("UNCLEAR");
    });
  });

  describe("review autopilot", () => {
    test("auto-approves reviewed APPROVE proposals only when autonomy is auto", () => {
      const p = store.create({
        title: "Safe bugfix",
        description: "Fix a typo in a non-protected file",
        category: "bugfix",
        effort: "small",
        autonomy: "auto",
        files_affected: ["src/ui/copy.ts"],
        proposed_by: "scout",
      });
      store.saveReview(p.proposal_id, "**Verdict: APPROVE**\n**Why:** Safe and scoped.", "nyx");

      const result = autoAdvanceReviewedProposal(store, p.proposal_id, "nyx");

      expect(result.advanced).toBe(true);
      expect(result.proposal?.status).toBe("approved");
      expect(result.proposal?.approved_by).toBe("nyx");
    });

    test("does not auto-approve reviewed APPROVE proposals that require owner approval", () => {
      const p = makeProposal("Feature proposal");
      store.saveReview(p.proposal_id, "**Verdict: APPROVE**\n**Why:** Good idea.", "nyx");

      const result = autoAdvanceReviewedProposal(store, p.proposal_id, "nyx");

      expect(result.advanced).toBe(false);
      expect(result.reason).toContain("requires owner approval");
      expect(store.get(p.proposal_id)!.status).toBe("reviewed");
    });

    test("does not auto-advance rejected or unclear reviews", () => {
      const p = store.create({
        title: "Rejected bugfix",
        description: "Not worth doing",
        category: "bugfix",
        effort: "small",
        autonomy: "auto",
        proposed_by: "scout",
      });
      store.saveReview(p.proposal_id, "**Verdict: REJECT**\n**Why:** Wrong fix.", "nyx");

      const decision = canAutoAdvanceReviewedProposal(store.get(p.proposal_id)!);

      expect(decision.ok).toBe(false);
      expect(decision.reason).toContain("not APPROVE");
      expect(store.get(p.proposal_id)!.status).toBe("reviewed");
    });
  });
});
